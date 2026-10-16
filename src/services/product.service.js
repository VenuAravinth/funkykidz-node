import { ObjectId } from "mongodb";
import { getDb } from "../config/database.js";
import * as Product from "../models/product.model.js";
import { allocateBarcodes } from "./barcode.service.js";
import { deleteImages, isOwnImageUrl, signatureExpiry, signImageUrl } from "./cloudflare.service.js";
import { notifyWebsite } from "./website.service.js";
import { CategoryService } from "./category.service.js";
import { BrandService } from "./brand.service.js";
import { buildSearchTokens, escapeRegex, slugify, tokenize } from "../utils/text.js";
import { conflict, fromDuplicateKey, notFound, unprocessable } from "../utils/errors.js";

// Product CRUD, listing/search and publishing. Variants, stock, barcodes and images have their own
// services but all writes that touch the document's shape go through mutateProduct() below, so the
// derived fields the website relies on (sizes, active, colorways, …) can never drift.
// Prices live on the product only; a variant is just Color + Size + stock + barcode.

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

/** API shape + short-lived signed image URLs (originals stay in `images`). */
export function present(doc, expiresAt = signatureExpiry()) {
  const p = Product.toApi(doc);
  if (!p) return p;
  return { ...p, imageUrls: p.images.map((u) => signImageUrl(u, expiresAt)), imageUrlsExpireAt: expiresAt };
}

export function presentMany(docs) {
  const expiresAt = signatureExpiry(); // one expiry for the whole page: identical URLs, one clock read
  return docs.map((d) => present(d, expiresAt));
}

// ---------------------------------------------------------------------------------------------
// Derived fields
// ---------------------------------------------------------------------------------------------

const COLOR_HEX = {
  pink: "#F4A7B9", rose: "#E8838F", red: "#D9534F", maroon: "#7B2D3B", peach: "#FFC3A0", orange: "#F5A25D",
  yellow: "#F7D774", cream: "#F6EBD9", beige: "#E8D8C3", white: "#FAFAFA", ivory: "#FFFFF0", grey: "#A7A9AC",
  gray: "#A7A9AC", black: "#2B2B2B", navy: "#1F3A5F", blue: "#6FA8DC", sky: "#A7D3F2", teal: "#3E9C9C",
  mint: "#B8E2C8", green: "#6AA36F", olive: "#7D8B4E", lavender: "#C9B6E4", purple: "#8E6BB8", lilac: "#C8A2C8",
  brown: "#8B5E3C", gold: "#D4AF37", silver: "#C0C0C0",
};
const DEFAULT_HEX = "#F4A7B9";
const DEFAULT_BG = "#FFF4F1";

function colorHexFor(name) {
  for (const word of tokenize(name)) if (COLOR_HEX[word]) return COLOR_HEX[word];
  return undefined;
}

/** Distinct variant colours in the order they were added. */
export const colorsOf = (variants) => [...new Set(variants.map((v) => v.color))];

/**
 * One website colourway per variant colour. Hand-tuned values already stored for a colour are
 * kept; a swatch picked in the ERP (`swatches`) wins; anything else comes from the colour's name.
 */
function deriveColorways(doc, swatches = []) {
  const prevByName = new Map((doc.colorways ?? []).map((c) => [c.name.toLowerCase(), c]));
  const picked = new Map(swatches.map((c) => [c.name.toLowerCase(), c.hex]));
  return colorsOf(doc.variants ?? []).map((name) => {
    const prev = prevByName.get(name.toLowerCase()) ?? {};
    const pickedHex = picked.get(name.toLowerCase());
    const hex = pickedHex || prev.swatchHex || colorHexFor(name) || DEFAULT_HEX;
    return { ...prev, name, swatchHex: hex, outfit: pickedHex ? hex : prev.outfit ?? hex, bg: prev.bg ?? DEFAULT_BG };
  });
}

/** True when something can be sold: any untracked variant, or any units left. */
export function hasStock(variants, stock) {
  return variants.some((v) => {
    const units = stock?.[v.color]?.[v.size];
    return units === null || units === undefined || units > 0;
  });
}

/** Recomputes everything the website reads that the admin doesn't edit directly. */
function withDerived(doc, swatches) {
  const variants = doc.variants ?? [];
  return {
    ...doc,
    sizes: [...new Set(variants.map((v) => v.size))],
    active: Boolean(doc.published),
    variant: doc.gender === "Boys" ? "boy" : doc.gender === "Girls" ? "girl" : doc.variant ?? "girl",
    colorways: deriveColorways(doc, swatches),
    shortDescription: doc.shortDescription || (doc.description ? doc.description.slice(0, 140) : doc.name),
    searchTokens: buildSearchTokens(doc),
  };
}

function assertPublishable(doc, stock = doc.stock) {
  const problems = [];
  if (!doc.name) problems.push("a name");
  if (!(doc.price > 0)) problems.push("a selling price above 0");
  if (!doc.category) problems.push("a category");
  if (!doc.variants?.length) problems.push("at least one colour and size");
  else if (!hasStock(doc.variants, stock)) problems.push("stock in at least one colour and size");
  if (problems.length) throw unprocessable(`To publish, the product needs ${problems.join(", ")}.`);
}

/** Only non-empty, trimmed attribute values; null when none are left. */
function cleanAttributes(attributes) {
  if (!attributes) return null;
  const out = {};
  for (const key of Product.ATTRIBUTE_KEYS) {
    const v = typeof attributes[key] === "string" ? attributes[key].trim() : "";
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Trimmed, upper-case SKU, or null when blank. */
const normalizeSku = (sku) => (typeof sku === "string" && sku.trim() ? sku.trim().toUpperCase() : null);

function assertPrices({ price, oldPrice, costPrice }) {
  if (oldPrice != null && oldPrice < price) throw unprocessable("The original price (MRP) can't be lower than the selling price.");
  if (costPrice != null && costPrice < 0) throw unprocessable("Cost price can't be negative.");
}

// ---------------------------------------------------------------------------------------------
// Variants (shape only — stock lives in doc.stock)
// ---------------------------------------------------------------------------------------------

const variantKey = (color, size) => `${color.toLowerCase()}\u0000${size.toLowerCase()}`;

/**
 * Turns admin input rows into stored variants ({ id, color, size, barcode }). Rows with an `id`
 * update that variant (keeping its barcode); rows without one are new. Each Color + Size
 * combination can appear once, because stock is keyed by it.
 */
export function normalizeVariants(rows, existing = []) {
  const byId = new Map(existing.map((v) => [v.id, v]));
  const seen = new Set();
  return rows.map((row) => {
    const prev = row.id ? byId.get(row.id) : undefined;
    if (row.id && !prev) throw unprocessable(`Variant ${row.id} doesn't belong to this product.`);
    const color = (row.color ?? prev?.color ?? "").trim();
    const size = (row.size ?? prev?.size ?? "").trim();
    if (!color || !size) throw unprocessable("Every variant needs a colour and a size.");
    const key = variantKey(color, size);
    if (seen.has(key)) throw unprocessable(`${color} / ${size} is listed twice. Each colour and size can appear once.`);
    seen.add(key);
    return { id: prev?.id ?? new ObjectId().toHexString(), color, size, barcode: prev?.barcode };
  });
}

async function fillBarcodes(variants) {
  const codes = await allocateBarcodes(variants.filter((v) => !v.barcode).length);
  let i = 0;
  return variants.map((v) => (v.barcode ? v : { ...v, barcode: codes[i++] }));
}

function assertImages(images, current = []) {
  for (const url of images) {
    if (!current.includes(url) && !isOwnImageUrl(url)) {
      throw unprocessable(`Image ${url} isn't an image in this store's R2 bucket. Upload it through /api/v1/images first.`);
    }
  }
  if (new Set(images).size !== images.length) throw unprocessable("The same image is listed twice.");
  if (images.length > Product.MAX_IMAGES) throw unprocessable(`A product can have up to ${Product.MAX_IMAGES} images.`);
}

async function uniqueSlug(base) {
  const root = base || "product";
  const taken = await Product.find({ slug: new RegExp(`^${escapeRegex(root)}(-\\d+)?$`) }, { projection: { _id: 0, slug: 1 } });
  if (!taken.some((d) => d.slug === root)) return root;
  const used = new Set(taken.map((d) => d.slug));
  let n = 2;
  while (used.has(`${root}-${n}`)) n++;
  return `${root}-${n}`;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Category and brand picked in the product form. Only checked (exists + active) when the choice
 * changes, so a product can keep a category that was deactivated after it was assigned.
 * `brandId: null` removes the brand.
 */
async function resolveTaxonomy({ categoryId, brandId }, current = {}) {
  const changed = (value, existing) => value != null && value !== existing?.toHexString?.();
  const [category, brand] = await Promise.all([
    changed(categoryId, current.categoryId) ? CategoryService.resolveForProduct(categoryId) : null,
    changed(brandId, current.brandId) ? BrandService.resolveForProduct(brandId) : null,
  ]);
  const out = {};
  if (category) Object.assign(out, { categoryId: category.id, category: category.name });
  if (brand) Object.assign(out, { brandId: brand.id, brand: brand.name });
  if (brandId === null) Object.assign(out, { brandId: null, brand: null });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export async function createProduct(input, log) {
  assertPrices(input);
  const images = input.images ?? [];
  assertImages(images);

  const [slug, taxonomy, variants] = await Promise.all([
    input.slug ? Promise.resolve(slugify(input.slug)) : uniqueSlug(slugify(input.name)),
    resolveTaxonomy(input),
    fillBarcodes(normalizeVariants(input.variants)),
  ]);
  const stock = {};
  variants.forEach((v, i) => {
    stock[v.color] ??= {};
    stock[v.color][v.size] = input.variants[i].stock ?? 0;
  });

  const now = new Date();
  const published = Boolean(input.published);
  const doc = withDerived(
    {
      slug,
      sku: normalizeSku(input.sku) ?? undefined,
      name: input.name.trim(),
      categoryId: taxonomy.categoryId,
      category: taxonomy.category,
      brandId: taxonomy.brandId ?? undefined,
      brand: taxonomy.brand ?? undefined,
      subcategory: input.subcategory,
      gender: input.gender,
      tag: input.tag ?? undefined,
      price: input.price,
      oldPrice: input.oldPrice > input.price ? input.oldPrice : undefined,
      costPrice: input.costPrice ?? 0,
      reorderLevel: input.reorderLevel ?? 0,
      shortDescription: input.shortDescription ?? "",
      description: input.description ?? "",
      fabric: input.fabric ?? "",
      fit: input.fit ?? "",
      care: input.care ?? "",
      images,
      attributes: cleanAttributes(input.attributes) ?? undefined,
      variants,
      stock,
      popularity: 0,
      dateAdded: today(),
      published,
      publishedAt: published ? now : undefined,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    input.colors,
  );
  if (published) assertPublishable(doc);

  try {
    const { insertedId } = await Product.insertOne(doc);
    if (published) notifyWebsite(log);
    return present({ ...doc, _id: insertedId });
  } catch (err) {
    throw fromDuplicateKey(err) ?? err;
  }
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

export async function getProduct(idOrSlug) {
  const doc = await Product.findOne(Product.idFilter(idOrSlug));
  if (!doc) throw notFound("Product not found.");
  return present(doc);
}

const csv = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
const objectIds = (v) => csv(v).filter((id) => ObjectId.isValid(id) && id.length === 24).map((id) => new ObjectId(id));

const LOW_STOCK = { $and: [{ $not: [Product.HAS_UNTRACKED] }, { $lte: [Product.STOCK_TOTAL, { $ifNull: ["$reorderLevel", 0] }] }] };

/** Index-backed match on the words/codes a product can be found by. */
export function searchClause(q) {
  const raw = q.trim();
  const tokens = tokenize(raw).slice(0, 8);
  const byWords = tokens.length ? { searchTokens: { $all: tokens.map((t) => new RegExp(`^${escapeRegex(t)}`)) } } : null;
  // Scanner input: exact barcode hits first-class, word match as a fallback.
  if (/^\d{8,14}$/.test(raw)) return { $or: [{ "variants.barcode": raw }, ...(byWords ? [byWords] : [])] };
  return byWords ?? {};
}

function buildListFilter(q) {
  const f = {};
  const expr = [];
  if (q.q) Object.assign(f, searchClause(q.q));
  if (q.categoryId) f.categoryId = { $in: objectIds(q.categoryId) };
  if (q.brandId) f.brandId = { $in: objectIds(q.brandId) };
  if (q.category) f.category = { $in: csv(q.category) };
  if (q.gender) f.gender = { $in: csv(q.gender) };
  if (q.published !== undefined) f.published = q.published;
  if (q.brand) f.brand = q.brand;
  if (q.size) f.sizes = { $in: csv(q.size) };
  if (q.minPrice !== undefined || q.maxPrice !== undefined) {
    f.price = {};
    if (q.minPrice !== undefined) f.price.$gte = q.minPrice;
    if (q.maxPrice !== undefined) f.price.$lte = q.maxPrice;
  }
  if (q.hasImages !== undefined) f["images.0"] = { $exists: q.hasImages };
  if (q.inStock !== undefined) expr.push(q.inStock ? Product.IN_STOCK : { $not: [Product.IN_STOCK] });
  if (q.lowStock) expr.push(LOW_STOCK);
  if (expr.length) f.$expr = expr.length === 1 ? expr[0] : { $and: expr };
  return f;
}

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  updated: { updatedAt: -1, _id: -1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: -1 },
  name_asc: { name: 1, _id: 1 },
  name_desc: { name: -1, _id: -1 },
  popularity: { popularity: -1, _id: -1 },
};

/** Paged, filtered list. The page and the total count run in parallel. */
export async function listProducts(q) {
  const page = q.page ?? 1;
  const limit = q.limit ?? 20;
  const filter = buildListFilter(q);
  const [docs, total] = await Promise.all([
    Product.find(filter, { projection: Product.LIST_PROJECTION, sort: SORTS[q.sort] ?? SORTS.newest, skip: (page - 1) * limit, limit }),
    Product.count(filter),
  ]);
  return { items: presentMany(docs), page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** Typeahead / POS scan: small payload, best matches first. */
export async function searchProducts(q, limit = 10) {
  const raw = q.trim();
  const docs = await Product.find(searchClause(raw), {
    projection: { name: 1, slug: 1, price: 1, oldPrice: 1, costPrice: 1, images: { $slice: 1 }, variants: 1, stock: 1, published: 1, category: 1, brand: 1 },
    sort: { popularity: -1, _id: -1 },
    limit,
  });
  const expiresAt = signatureExpiry();
  return docs.map((d) => {
    const p = Product.toApi(d);
    const matchedVariant = p.variants.find((v) => v.barcode === raw);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      price: p.price,
      oldPrice: p.oldPrice,
      costPrice: p.costPrice,
      category: p.category,
      brand: p.brand,
      published: p.published,
      variants: p.variants,
      totalStock: p.totalStock,
      imageUrl: p.images[0] ? signImageUrl(p.images[0], expiresAt) : null,
      matchedVariant: matchedVariant ?? null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

const EDITABLE = [
  "name", "subcategory", "gender", "tag", "price", "oldPrice", "costPrice",
  "reorderLevel", "shortDescription", "description", "fabric", "fit", "care", "published",
];
const UNTOUCHED = new Set(["_id", "stock", "popularity", "rev", "updatedAt", "createdAt"]);

/**
 * Read → change → write with an optimistic `rev` check, retried on a race. `makePatch(current)`
 * returns the changes (same shape as the PATCH body), so callers can base edits on the latest
 * document. Stock is only ever written per size path, never as a whole map, so it can't clobber
 * a checkout decrementing stock at the same moment.
 */
export async function mutateProduct(idOrSlug, makePatch, log) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await Product.findOne(Product.idFilter(idOrSlug));
    if (!current) throw notFound("Product not found.");
    const patch = await makePatch(current);

    const next = { ...current };
    for (const key of EDITABLE) if (patch[key] !== undefined) next[key] = patch[key];
    if (patch.sku !== undefined) next.sku = normalizeSku(patch.sku);
    if (patch.attributes !== undefined) next.attributes = cleanAttributes(patch.attributes);
    Object.assign(next, await resolveTaxonomy(patch, current));
    assertPrices(next);
    if (next.oldPrice != null && next.oldPrice <= next.price) next.oldPrice = null; // equal MRP = no discount

    const $set = {};
    const $unset = {};

    // Images: kept ones plus new uploads from this account; dropped R2 files are deleted after the write.
    let removedImages = [];
    if (patch.images) {
      assertImages(patch.images, current.images ?? []);
      next.images = patch.images;
      removedImages = (current.images ?? []).filter((u) => !patch.images.includes(u));
    }

    // Variants: full list in, stock paths kept in step. Only rows that carry `stock` set a count,
    // so a save never overwrites units the website sold since the form was opened.
    const nextStock = structuredClone(current.stock ?? {});
    if (patch.variants) {
      next.variants = await fillBarcodes(normalizeVariants(patch.variants, current.variants ?? []));
      const prevById = new Map((current.variants ?? []).map((v) => [v.id, v]));
      const units = (v) => current.stock?.[v.color]?.[v.size];
      const writes = new Map();
      patch.variants.forEach((row, i) => {
        const v = next.variants[i];
        const prev = prevById.get(v.id);
        const moved = prev && (prev.color !== v.color || prev.size !== v.size);
        if (row.stock !== undefined) writes.set(v, row.stock);
        else if (!prev) writes.set(v, 0);
        else if (moved) writes.set(v, units(prev) ?? null); // renamed: carry the units over
      });
      const keep = new Set(next.variants.map((v) => variantKey(v.color, v.size)));
      for (const [color, sizes] of Object.entries(current.stock ?? {})) {
        const left = Object.keys(sizes ?? {}).filter((size) => keep.has(variantKey(color, size)));
        if (!left.length && ![...writes.keys()].some((v) => v.color === color)) {
          $unset[`stock.${color}`] = "";
          delete nextStock[color];
        } else {
          for (const size of Object.keys(sizes ?? {})) {
            if (!keep.has(variantKey(color, size))) {
              $unset[`stock.${color}.${size}`] = "";
              delete nextStock[color][size];
            }
          }
        }
      }
      for (const [v, value] of writes) {
        $set[`stock.${v.color}.${v.size}`] = value;
        (nextStock[v.color] ??= {})[v.size] = value;
      }
    } else {
      next.variants = current.variants ?? [];
    }

    if (patch.published === true && !current.published) next.publishedAt = new Date();
    const derived = withDerived(next, patch.colors);
    if (patch.published === true) assertPublishable(derived, nextStock);

    // Write only what changed. Fields the website updates on its own (stock, popularity) are never
    // copied back from this read.
    for (const [key, value] of Object.entries(derived)) {
      if (UNTOUCHED.has(key)) continue;
      if (value === null || value === undefined) {
        if (current[key] !== undefined) $unset[key] = "";
      } else if (JSON.stringify(value) !== JSON.stringify(current[key])) {
        $set[key] = value;
      }
    }
    $set.updatedAt = new Date();

    const revFilter = current.rev == null ? { rev: { $exists: false } } : { rev: current.rev };
    let updated;
    try {
      updated = await Product.findOneAndUpdate(
        { _id: current._id, ...revFilter },
        { $set, $inc: { rev: 1 }, ...(Object.keys($unset).length ? { $unset } : {}) },
      );
    } catch (err) {
      throw fromDuplicateKey(err) ?? err;
    }
    if (!updated) continue; // someone else saved in between — re-read and re-apply

    if (removedImages.length) deleteImages(removedImages, log);
    const soldOut = await Product.unpublishIfSoldOut({ _id: updated._id });
    if (current.active || updated.active) notifyWebsite(log);
    return present(soldOut ? await Product.findOne({ _id: updated._id }) : updated);
  }
  throw conflict("This product was changed by someone else at the same time. Please reload and try again.");
}

export const updateProduct = (idOrSlug, patch, log) => mutateProduct(idOrSlug, () => patch, log);

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

export async function deleteProduct(idOrSlug, log) {
  const doc = await Product.findOneAndDelete(Product.idFilter(idOrSlug));
  if (!doc) throw notFound("Product not found.");
  // Clean-up the caller doesn't need to wait for.
  Promise.allSettled([
    deleteImages(doc.images ?? [], log),
    getDb().collection("product_embeddings").deleteMany({ slug: doc.slug }), // website visual-search cache
  ]).catch(() => {});
  if (doc.active) notifyWebsite(log);
  return { id: doc._id.toHexString(), slug: doc.slug, deleted: true };
}

// ---------------------------------------------------------------------------------------------
// Publish / unpublish
// ---------------------------------------------------------------------------------------------

export async function setPublished(idOrSlug, published, log) {
  const filter = Product.idFilter(idOrSlug);
  if (published) {
    const current = await Product.findOne(filter, { projection: { name: 1, price: 1, category: 1, variants: 1, stock: 1 } });
    if (!current) throw notFound("Product not found.");
    assertPublishable(current);
  }
  // Pipeline update: `active` mirrors `published`.
  const updated = await Product.findOneAndUpdate(filter, [
    {
      $set: {
        published,
        active: published,
        publishedAt: published ? { $ifNull: ["$publishedAt", "$$NOW"] } : "$publishedAt",
        updatedAt: "$$NOW",
        rev: { $add: [{ $ifNull: ["$rev", 0] }, 1] },
      },
    },
  ]);
  if (!updated) throw notFound("Product not found.");
  notifyWebsite(log);
  return present(updated);
}

/** Publishes/unpublishes many at once. Products that can't be published are reported, not changed. */
export async function bulkSetPublished(ids, published, log) {
  const objectIds = ids.filter((id) => ObjectId.isValid(id) && id.length === 24).map((id) => new ObjectId(id));
  const base = { _id: { $in: objectIds } };
  const ready = published
    ? { ...base, name: { $type: "string", $ne: "" }, price: { $gt: 0 }, category: { $type: "string", $ne: "" }, "variants.0": { $exists: true }, $expr: Product.IN_STOCK }
    : base;
  const res = await Product.products().updateMany(ready, [
    {
      $set: {
        published,
        active: published,
        publishedAt: published ? { $ifNull: ["$publishedAt", "$$NOW"] } : "$publishedAt",
        updatedAt: "$$NOW",
        rev: { $add: [{ $ifNull: ["$rev", 0] }, 1] },
      },
    },
  ]);
  let skipped = [];
  if (published && res.matchedCount < objectIds.length) {
    const notReady = await Product.find({ ...base, published: { $ne: true } }, { projection: { _id: 1, name: 1 } });
    skipped = notReady.map((d) => ({ id: d._id.toHexString(), name: d.name, reason: "Missing price or category, or out of stock." }));
  }
  if (res.modifiedCount) notifyWebsite(log);
  return { matched: res.matchedCount, modified: res.modifiedCount, skipped };
}
