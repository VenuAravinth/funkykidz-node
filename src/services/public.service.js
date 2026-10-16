import { env } from "../config/env.js";
import * as Product from "../models/product.model.js";
import { Category } from "../models/category.model.js";
import { Brand } from "../models/brand.model.js";
import { NAME_COLLATION } from "../models/taxonomy.model.js";
import { objectKeyFromUrl, signatureExpiry, signImageUrl } from "./cloudflare.service.js";
import { tokenize } from "../utils/text.js";
import { notFound } from "../utils/errors.js";

// Public, read-only catalogue for the FunkyKidz website (and any other storefront client).
// Only published products that still have something to sell, only shop-facing fields. Cost price,
// barcodes and variant ids never leave through here; `stock` ({ color: { size: units|null } })
// tells the shop which Color + Size combinations exist and how many are left.
//
// The whole published catalogue is small, so it is held in memory and every request is answered
// from there (filters included). It is dropped whenever this server changes a product, category
// or brand, and otherwise refreshed every CACHE_TTL_MS (stock also changes through website orders).

const CACHE_TTL_MS = 10_000;

// Exactly the website's Product type (funkykidzwebsite/src/lib/products.ts), plus brand/category ids.
const PUBLIC_PROJECTION = {
  _id: 0, slug: 1, name: 1, price: 1, oldPrice: 1, tag: 1, gender: 1, category: 1, categoryId: 1, brand: 1, brandId: 1,
  variant: 1, sizes: 1, stock: 1, colorways: 1, images: 1, shortDescription: 1, description: 1, fabric: 1, fit: 1, care: 1,
  popularity: 1, dateAdded: 1, searchTokens: 1,
};

const imagePath = (file) => `/api/v1/public/product-images/${file}`;

/** R2 originals → this server's stable image URL; anything else (legacy website paths) unchanged. */
function publicImageUrl(url) {
  const key = objectKeyFromUrl(url);
  return key ? `${env.publicBaseUrl}${imagePath(key.slice(key.lastIndexOf("/") + 1))}` : url;
}

function toPublic(doc) {
  // eslint-disable-next-line no-unused-vars
  const { searchTokens, ...p } = doc;
  return {
    ...p,
    categoryId: p.categoryId?.toHexString(),
    brandId: p.brandId?.toHexString(),
    images: (p.images ?? []).map(publicImageUrl),
    colorways: (p.colorways ?? []).map((c) => (c.images ? { ...c, images: c.images.map(publicImageUrl) } : c)),
  };
}

let cache = null; // { until, products, bySlug, imageFiles: Map<file, original>, tokens }
let loading = null;

export function invalidatePublicCache() {
  cache = null;
}

async function catalogue() {
  if (cache && cache.until > Date.now()) return cache;
  // One query for every concurrent request that finds the cache empty.
  loading ??= (async () => {
    try {
      const docs = await Product.find(
        // Published only (`active` mirrors `published`; both are checked so neither alone can leak a draft).
        { published: true, active: true, $expr: Product.IN_STOCK },
        { projection: PUBLIC_PROJECTION, sort: { dateAdded: -1, _id: -1 } },
      );
      const imageFiles = new Map();
      for (const d of docs) {
        for (const url of [...(d.images ?? []), ...(d.colorways ?? []).flatMap((c) => c.images ?? [])]) {
          const key = objectKeyFromUrl(url);
          if (key) imageFiles.set(key.slice(key.lastIndexOf("/") + 1), url);
        }
      }
      const products = docs.map(toPublic);
      cache = {
        until: Date.now() + CACHE_TTL_MS,
        products,
        bySlug: new Map(products.map((p) => [p.slug, p])),
        tokens: docs.map((d) => d.searchTokens ?? []),
        imageFiles,
      };
      return cache;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const inStock = (p) => Object.values(p.stock ?? {}).some((sizes) => Object.values(sizes).some((n) => n === null || n > 0));

const SORTS = {
  newest: (a, b) => b.dateAdded.localeCompare(a.dateAdded),
  "price-asc": (a, b) => a.price - b.price,
  "price-desc": (a, b) => b.price - a.price,
  popular: (a, b) => b.popularity - a.popularity,
};

/**
 * Published products. No parameters → the whole catalogue (what the website loads).
 * Filters: q, category (names), categoryId, brandId, gender, size, minPrice, maxPrice, tag, inStock;
 * sort: newest | price-asc | price-desc | popular; page + limit for paging.
 */
export async function listProducts(q) {
  const { products, tokens } = await catalogue();
  const categories = list(q.category);
  const categoryIds = list(q.categoryId);
  const brandIds = list(q.brandId);
  const genders = list(q.gender);
  const sizes = list(q.size);
  const words = q.q ? tokenize(q.q).slice(0, 8) : [];

  let items = products.filter((p, i) => {
    if (words.length && !words.every((w) => tokens[i].some((t) => t.startsWith(w)))) return false;
    if (categories.length && !categories.includes(p.category)) return false;
    if (categoryIds.length && !categoryIds.includes(p.categoryId)) return false;
    if (brandIds.length && !brandIds.includes(p.brandId)) return false;
    if (genders.length && !(genders.includes(p.gender) || p.gender === "Unisex")) return false;
    if (sizes.length && !p.sizes?.some((s) => sizes.includes(s))) return false;
    if (q.minPrice !== undefined && p.price < q.minPrice) return false;
    if (q.maxPrice !== undefined && p.price > q.maxPrice) return false;
    if (q.tag && p.tag !== q.tag) return false;
    if (q.inStock && !inStock(p)) return false;
    return true;
  });
  if (SORTS[q.sort]) items = [...items].sort(SORTS[q.sort]);

  if (q.page === undefined && q.limit === undefined) return { products: items, total: items.length };
  const page = q.page ?? 1;
  const limit = q.limit ?? 24;
  return { products: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit, totalPages: Math.ceil(items.length / limit) };
}

export async function getProduct(slug) {
  const product = (await catalogue()).bySlug.get(slug);
  if (!product) throw notFound("Product not found.");
  return product;
}

/** Active categories or brands, each with how many published products it has. */
async function activeTaxonomy(model, idField) {
  const [{ products }, docs] = await Promise.all([
    catalogue(),
    model.find({ status: "active" }, { projection: { name: 1, slug: 1, description: 1 }, sort: { sortOrder: 1, name: 1 }, collation: NAME_COLLATION }),
  ]);
  const counts = new Map();
  for (const p of products) if (p[idField]) counts.set(p[idField], (counts.get(p[idField]) ?? 0) + 1);
  return docs.map((d) => {
    const id = d._id.toHexString();
    return { id, name: d.name, slug: d.slug, description: d.description ?? "", productCount: counts.get(id) ?? 0 };
  });
}

export const listCategories = () => activeTaxonomy(Category, "categoryId");
export const listBrands = () => activeTaxonomy(Brand, "brandId");

/** Freshly signed (≤ 20 min) R2 URL for a published product's image, or null. */
export async function signedImageFor(file) {
  const original = (await catalogue()).imageFiles.get(file);
  return original ? signImageUrl(original, signatureExpiry()) : null;
}
