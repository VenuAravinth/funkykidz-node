import { ObjectId } from "mongodb";
import { getDb } from "../config/database.js";

// Shared shape of the `categories` and `brands` collections:
//   { _id, name, slug, description, status: "active" | "inactive", sortOrder, createdAt, updatedAt }
// Products point at them with `categoryId` / `brandId` and also keep a copy of the name
// (`category` / `brand`), which is what the website reads and filters on.

// Case-insensitive comparison, so "Dresses" and "dresses" count as the same name.
export const NAME_COLLATION = { locale: "en", strength: 2 };

export function makeTaxonomyModel(collectionName) {
  const collection = () => getDb().collection(collectionName);

  return {
    collectionName,
    collection,

    async ensureIndexes() {
      await collection().createIndexes([
        { key: { slug: 1 }, name: "slug_unique", unique: true },
        { key: { name: 1 }, name: "name_unique_ci", unique: true, collation: NAME_COLLATION },
        { key: { status: 1, sortOrder: 1, name: 1 }, name: "status_sort_name" },
      ]);
    },

    findById: (id, options) => (ObjectId.isValid(id) && String(id).length === 24 ? collection().findOne({ _id: new ObjectId(id) }, options) : null),
    findOne: (filter, options) => collection().findOne(filter, options),
    find: (filter, { projection, sort, skip = 0, limit = 0, collation } = {}) =>
      collection().find(filter, { projection, sort, skip, limit, collation }).toArray(),
    count: (filter) => collection().countDocuments(filter),
    insertOne: (doc) => collection().insertOne(doc),
    findOneAndUpdate: (filter, update) => collection().findOneAndUpdate(filter, update, { returnDocument: "after" }),
    findOneAndDelete: (filter) => collection().findOneAndDelete(filter),
  };
}

/** API shape: `id` instead of `_id`. */
export function toApi(doc, productCount) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toHexString(), ...rest, ...(productCount !== undefined ? { productCount } : {}) };
}
