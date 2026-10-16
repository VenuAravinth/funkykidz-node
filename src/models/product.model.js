import { ObjectId } from "mongodb";
import { getDb } from "../config/database.js";

// Products live in the `products` collection the FunkyKidz website already reads. A document is a
// superset of the website's Product type (funkykidzwebsite/src/lib/products.ts):
//
//   product level   name, slug, sku (optional, unique, upper-case), price (selling), oldPrice (MRP),
//                   costPrice, category, brand, gender,
//                   tag, images, details (shortDescription, description, fabric, fit, care), published
//   details         attributes { productType, pattern, neckType, sleeveType, ageGroup, occasion }
//   variants        [{ id, color, size, barcode }] — one per Color + Size, nothing else
//   stock           { [color]: { [size]: units | null } } — the single source of truth for
//                   quantities (null = not tracked, sold as available). The website's checkout
//                   decrements stock.<color>.<size> atomically.
//   derived         active, sizes, colorways, variant, searchTokens
//
// `active` is what the website filters on: it equals `published`. A product whose every variant
// reaches 0 units is unpublished automatically (unpublishIfSoldOut); the admin re-publishes it.

export const COLLECTION = "products";

// Kept in step with funkykidzwebsite/src/lib/categories.ts and products.ts.
export const GENDERS = ["Girls", "Boys", "Unisex"];
export const TAGS = ["Bestseller", "New"];
export const STATUSES = ["active", "inactive"];
export const MAX_IMAGES = 12;
// Optional descriptive details on `attributes` (product type, design, neck/sleeve, age, occasion).
export const ATTRIBUTE_KEYS = ["productType", "pattern", "neckType", "sleeveType", "ageGroup", "occasion"];
export const MAX_VARIANTS = 120;

// Every stock value across colours and sizes, computed inside MongoDB.
export const STOCK_VALUES = {
  $reduce: {
    input: { $objectToArray: { $ifNull: ["$stock", {}] } },
    initialValue: [],
    in: { $concatArrays: ["$$value", { $map: { input: { $objectToArray: "$$this.v" }, as: "s", in: "$$s.v" } }] },
  },
};
export const STOCK_TOTAL = { $sum: STOCK_VALUES };
export const HAS_UNTRACKED = { $in: [null, STOCK_VALUES] };
export const IN_STOCK = { $or: [HAS_UNTRACKED, { $gt: [STOCK_TOTAL, 0] }] };

/** Unpublishes the product if it has sold out. Returns true when it was switched off. */
export async function unpublishIfSoldOut(filter) {
  const res = await products().updateOne({ ...filter, published: true, $expr: { $not: [IN_STOCK] } }, [
    { $set: { published: false, active: false, updatedAt: "$$NOW", rev: { $add: [{ $ifNull: ["$rev", 0] }, 1] } } },
  ]);
  return res.modifiedCount > 0;
}

export const products = () => getDb().collection(COLLECTION);

export async function ensureProductIndexes() {
  // Legacy indexes. Product barcodes and variant SKUs are gone (variant barcodes identify stock);
  // the product-level SKU came back as an optional admin-entered code (product_sku_unique below).
  for (const name of ["sku_unique", "barcode_unique", "variant_sku_unique", "status_published_updated"]) {
    await products().dropIndex(name).catch(() => {});
  }
  const whereString = (field) => ({ partialFilterExpression: { [field]: { $type: "string" } } });
  await products().createIndexes([
    { key: { slug: 1 }, unique: true }, // same spec the website creates, so this is a no-op there
    { key: { active: 1 } },
    { key: { sku: 1 }, name: "product_sku_unique", unique: true, ...whereString("sku") },
    { key: { "variants.barcode": 1 }, name: "variant_barcode_unique", unique: true, ...whereString("variants.barcode") },
    { key: { "variants.id": 1 }, name: "variant_id" },
    { key: { categoryId: 1 }, name: "categoryId" }, // product counts per category, filters, rename propagation
    { key: { brandId: 1 }, name: "brandId" },
    { key: { searchTokens: 1 }, name: "search_tokens" },
    // Listing / filtering shapes used by the ERP grid and the website.
    { key: { active: 1, dateAdded: -1 }, name: "active_dateAdded" },
    { key: { category: 1, gender: 1, price: 1 }, name: "category_gender_price" },
    { key: { published: 1, updatedAt: -1 }, name: "published_updated" },
    { key: { createdAt: -1 }, name: "createdAt_desc" },
  ]);
}

/** Matches by ObjectId hex or by slug, so ERP screens and website URLs both work. */
export function idFilter(idOrSlug) {
  return ObjectId.isValid(idOrSlug) && String(idOrSlug).length === 24 ? { _id: new ObjectId(idOrSlug) } : { slug: String(idOrSlug) };
}

// Fields the ERP list view needs — skips long text so list pages stay small.
export const LIST_PROJECTION = {
  description: 0,
  fabric: 0,
  fit: 0,
  care: 0,
  searchTokens: 0,
};

export const findOne = (filter, options) => products().findOne(filter, options);
export const find = (filter, { projection, sort, skip = 0, limit = 0 } = {}) =>
  products().find(filter, { projection, sort, skip, limit }).toArray();
export const count = (filter) => products().countDocuments(filter);
export const exists = async (filter) => Boolean(await products().findOne(filter, { projection: { _id: 1 } }));
export const insertOne = (doc) => products().insertOne(doc);
export const findOneAndUpdate = (filter, update, options = {}) =>
  products().findOneAndUpdate(filter, update, { returnDocument: "after", ...options });
export const updateOne = (filter, update, options) => products().updateOne(filter, update, options);
export const findOneAndDelete = (filter) => products().findOneAndDelete(filter);
export const aggregate = (pipeline) => products().aggregate(pipeline).toArray();

/** Product as the API returns it: `id` instead of `_id`, variants carrying their live stock. */
export function toApi(doc) {
  if (!doc) return null;
  // eslint-disable-next-line no-unused-vars
  const { _id, searchTokens, ...rest } = doc;
  // stock: null = not tracked (the website sells it as available with no count shown).
  const variants = (doc.variants ?? []).map((v) => ({ ...v, stock: doc.stock?.[v.color]?.[v.size] ?? null }));
  const totalStock = variants.reduce((sum, v) => sum + (v.stock ?? 0), 0);
  const untracked = variants.some((v) => v.stock === null);
  return {
    id: _id.toHexString(),
    ...rest,
    images: doc.images ?? [],
    variants,
    totalStock,
    inStock: untracked || totalStock > 0,
    // Untracked variants are never "low" (same rule as the list filter).
    lowStock: variants.length > 0 && !untracked && totalStock <= (doc.reorderLevel ?? 0),
  };
}
