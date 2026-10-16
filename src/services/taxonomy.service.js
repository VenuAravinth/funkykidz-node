import { ObjectId } from "mongodb";
import * as Product from "../models/product.model.js";
import { NAME_COLLATION, toApi } from "../models/taxonomy.model.js";
import { notifyWebsite } from "./website.service.js";
import { buildSearchTokens, escapeRegex, slugify } from "../utils/text.js";
import { conflict, notFound, unprocessable } from "../utils/errors.js";

// Categories and brands behave the same way, so one service is built for each from this factory.
//
// Integration with products:
//  - products store `<idField>` (ObjectId) plus a copy of the name in `<nameField>`, which the
//    website reads; renaming here updates that copy (and product search) everywhere
//  - creating one links existing products that already carry the same name (e.g. the website's
//    original catalogue), so nothing has to be re-entered
//  - only active entries are offered in the product form and accepted for new assignments
//  - one that products still use can't be deleted (deactivate it instead)

const SORTS = {
  name_asc: { name: 1, _id: 1 },
  name_desc: { name: -1, _id: -1 },
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  sort_order: { sortOrder: 1, name: 1, _id: 1 },
};
const OPTIONS_TTL_MS = 30_000;

export function makeTaxonomyService({ model, label, idField, nameField }) {
  const lower = label.toLowerCase();

  // The product form asks for the active list often; it changes rarely. Cached briefly and
  // dropped on every write made through this server.
  let optionsCache = null;
  const invalidate = () => {
    optionsCache = null;
  };

  async function productCounts(ids) {
    if (!ids.length) return new Map();
    const rows = await Product.aggregate([{ $match: { [idField]: { $in: ids } } }, { $group: { _id: `$${idField}`, n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [r._id.toHexString(), r.n]));
  }

  async function uniqueSlug(base, exceptId) {
    const root = base || lower;
    const taken = await model.find(
      { slug: new RegExp(`^${escapeRegex(root)}(-\\d+)?$`), ...(exceptId ? { _id: { $ne: exceptId } } : {}) },
      { projection: { _id: 0, slug: 1 } },
    );
    const used = new Set(taken.map((d) => d.slug));
    if (!used.has(root)) return root;
    let n = 2;
    while (used.has(`${root}-${n}`)) n++;
    return `${root}-${n}`;
  }

  function duplicate(err, name) {
    if (err?.code !== 11000) return null;
    return err.keyPattern?.slug ? conflict(`Another ${lower} already uses this slug.`, { field: "slug" }) : conflict(`A ${lower} named "${name}" already exists.`, { field: "name" });
  }

  async function requireDoc(id) {
    const doc = await model.findById(id);
    if (!doc) throw notFound(`${label} not found.`);
    return doc;
  }

  /** Copies a new name onto every product that uses this entry, keeping product search in step. */
  async function propagateName(id, name, log) {
    const docs = await Product.find(
      { [idField]: id },
      { projection: { name: 1, category: 1, subcategory: 1, brand: 1, gender: 1, tag: 1, variants: 1, active: 1 } },
    );
    if (!docs.length) return;
    await Product.products().bulkWrite(
      docs.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { [nameField]: name, searchTokens: buildSearchTokens({ ...d, [nameField]: name }), updatedAt: new Date() }, $inc: { rev: 1 } },
        },
      })),
      { ordered: false },
    );
    if (docs.some((d) => d.active)) notifyWebsite(log);
  }

  /** Products that carry this name but no link yet (created before categories/brands existed). */
  async function linkExistingProducts(doc) {
    const res = await Product.products().updateMany(
      { [idField]: { $exists: false }, [nameField]: new RegExp(`^${escapeRegex(doc.name)}$`, "i") },
      { $set: { [idField]: doc._id, [nameField]: doc.name } },
    );
    return res.modifiedCount;
  }

  return {
    async list(q) {
      const page = q.page ?? 1;
      const limit = q.limit ?? 50;
      const filter = {};
      if (q.status) filter.status = q.status;
      if (q.q) filter.$or = [{ name: new RegExp(escapeRegex(q.q.trim()), "i") }, { slug: new RegExp(escapeRegex(slugify(q.q))) }];
      const [docs, total] = await Promise.all([
        model.find(filter, { sort: SORTS[q.sort] ?? SORTS.sort_order, skip: (page - 1) * limit, limit, collation: NAME_COLLATION }),
        model.count(filter),
      ]);
      const counts = await productCounts(docs.map((d) => d._id));
      return { items: docs.map((d) => toApi(d, counts.get(d._id.toHexString()) ?? 0)), page, limit, total, totalPages: Math.ceil(total / limit) };
    },

    /** Active entries only, smallest payload — what the product form's dropdown needs. */
    async options() {
      if (optionsCache && optionsCache.until > Date.now()) return optionsCache.items;
      const docs = await model.find(
        { status: "active" },
        { projection: { name: 1, slug: 1 }, sort: { sortOrder: 1, name: 1 }, collation: NAME_COLLATION },
      );
      const items = docs.map((d) => ({ id: d._id.toHexString(), name: d.name, slug: d.slug }));
      optionsCache = { items, until: Date.now() + OPTIONS_TTL_MS };
      return items;
    },

    async get(id) {
      const doc = await requireDoc(id);
      const counts = await productCounts([doc._id]);
      return toApi(doc, counts.get(doc._id.toHexString()) ?? 0);
    },

    async create(input) {
      const name = input.name.trim();
      const now = new Date();
      const doc = {
        name,
        slug: input.slug ? slugify(input.slug) : await uniqueSlug(slugify(name)),
        description: input.description?.trim() ?? "",
        status: input.status ?? "active",
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const { insertedId } = await model.insertOne(doc);
        doc._id = insertedId;
      } catch (err) {
        throw duplicate(err, name) ?? err;
      }
      invalidate();
      const linked = await linkExistingProducts(doc);
      if (linked) notifyWebsite();
      return toApi(doc, linked);
    },

    async update(id, patch, log) {
      const current = await requireDoc(id);
      const $set = { updatedAt: new Date() };
      if (patch.name !== undefined) $set.name = patch.name.trim();
      if (patch.slug !== undefined) $set.slug = slugify(patch.slug);
      if (patch.description !== undefined) $set.description = patch.description.trim();
      if (patch.status !== undefined) $set.status = patch.status;
      if (patch.sortOrder !== undefined) $set.sortOrder = patch.sortOrder;
      let updated;
      try {
        updated = await model.findOneAndUpdate({ _id: current._id }, { $set });
      } catch (err) {
        throw duplicate(err, $set.name) ?? err;
      }
      if (!updated) throw notFound(`${label} not found.`);
      invalidate();
      if ($set.name && $set.name !== current.name) await propagateName(current._id, $set.name, log);
      const counts = await productCounts([updated._id]);
      return toApi(updated, counts.get(updated._id.toHexString()) ?? 0);
    },

    async remove(id) {
      const doc = await requireDoc(id);
      const inUse = await Product.count({ [idField]: doc._id });
      if (inUse) {
        throw conflict(`${inUse} product${inUse === 1 ? " uses" : "s use"} this ${lower}. Move them to another ${lower} first, or set it to inactive.`, { productCount: inUse });
      }
      await model.findOneAndDelete({ _id: doc._id });
      invalidate();
      return { id: doc._id.toHexString(), deleted: true };
    },

    /**
     * For product create/update: the entry to assign, or 422 if it's unknown or inactive.
     * Returns { id: ObjectId, name }.
     */
    async resolveForProduct(id) {
      const doc = ObjectId.isValid(id) ? await model.findById(id, { projection: { name: 1, status: 1 } }) : null;
      if (!doc) throw unprocessable(`${label} not found. Pick one from the list.`, { field: idField });
      if (doc.status !== "active") throw unprocessable(`"${doc.name}" is inactive. Pick an active ${lower}.`, { field: idField });
      return { id: doc._id, name: doc.name };
    },
  };
}
