import { ObjectId } from "mongodb";
import * as Product from "../models/product.model.js";
import { allocateBarcodes } from "./barcode.service.js";
import { present } from "./product.service.js";
import { notifyWebsite } from "./website.service.js";
import { buildSearchTokens } from "../utils/text.js";
import { conflict, notFound } from "../utils/errors.js";

// Barcode lookup, regeneration, label data, and bringing older products up to the
// Color + Size variant shape.

/** What a scanner reads: a variant's barcode (indexed). */
export async function lookupByCode(code) {
  const value = code.trim();
  const doc = await Product.findOne({ "variants.barcode": value });
  if (!doc) throw notFound("No product matches this barcode.");
  const product = present(doc);
  return { product, variant: product.variants.find((v) => v.barcode === value) ?? null };
}

/** One row per Color + Size — what label printing needs. Prices come from the product. */
export async function barcodeLabels(idOrSlug) {
  const doc = await Product.findOne(Product.idFilter(idOrSlug), {
    projection: { name: 1, price: 1, oldPrice: 1, variants: 1, stock: 1 },
  });
  if (!doc) throw notFound("Product not found.");
  const p = Product.toApi(doc);
  return p.variants.map((v) => ({
    key: v.id,
    productName: p.name,
    label: `${v.color} · ${v.size}`,
    color: v.color,
    size: v.size,
    barcode: v.barcode,
    price: p.price,
    mrp: p.oldPrice ?? p.price,
    stock: v.stock,
  }));
}

/**
 * Issues new codes for every variant (`scope: "all"`) or one (`scope: "variant"` + variantId).
 * Old codes are retired for good; the counter never goes back.
 */
export async function regenerateBarcodes(idOrSlug, { scope = "all", variantId }, log) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await Product.findOne(Product.idFilter(idOrSlug));
    if (!current) throw notFound("Product not found.");
    const variants = current.variants ?? [];
    if (scope === "variant" && !variants.some((v) => v.id === variantId)) throw notFound("Variant not found on this product.");

    const codes = await allocateBarcodes(scope === "variant" ? 1 : variants.length);
    let i = 0;
    const next = { ...current, variants: variants.map((v) => (scope === "all" || v.id === variantId ? { ...v, barcode: codes[i++] } : v)) };

    const revFilter = current.rev == null ? { rev: { $exists: false } } : { rev: current.rev };
    const updated = await Product.findOneAndUpdate(
      { _id: current._id, ...revFilter },
      { $set: { variants: next.variants, searchTokens: buildSearchTokens(next), updatedAt: new Date() }, $inc: { rev: 1 } },
    );
    if (updated) {
      if (updated.active) notifyWebsite(log);
      return present(updated);
    }
  }
  throw conflict("This product was changed by someone else at the same time. Please try again.");
}

const NEEDS_MIGRATION = {
  $or: [
    { barcode: { $exists: true } },
    { status: { $exists: true } },
    { color: { $exists: true } },
    { variants: { $exists: false } },
    { variants: { $elemMatch: { color: { $exists: false } } } },
    { "variants.sku": { $exists: true } },
    { published: { $exists: false } },
    { searchTokens: { $exists: false } },
  ],
};

/**
 * Brings products to the Color + Size shape: one variant per colourway × size (the first colour
 * keeps each size's existing id and barcode), stock re-keyed to stock.<color>.<size>, and the
 * old product barcode / status / per-variant SKU and price fields removed (the product-level `sku`
 * is kept: it's the admin-entered SKU code). A legacy per-size count
 * moves to the first colour; other colours start untracked, so nothing the shop sells disappears.
 * Idempotent; runs at startup and from POST /api/v1/products/maintenance/backfill.
 */
export async function backfillLegacyProducts(log) {
  const docs = await Product.find(NEEDS_MIGRATION);
  if (!docs.length) return { updated: 0 };

  const plans = docs.map((d) => {
    const old = d.variants ?? [];
    if (old.length && old.every((v) => v.color && !v.sku && !("status" in v) && !("price" in v))) {
      return { d, rows: old.map((v) => ({ ...v, key: v.id })), stock: d.stock ?? {} };
    }
    const colors = d.colorways?.length ? d.colorways.map((c) => c.name) : [d.color || "Default"];
    const sizes = old.length ? [...new Set(old.map((v) => v.size))] : d.sizes ?? [];
    const legacyStock = d.stock ?? {};
    const rows = [];
    const stock = {};
    colors.forEach((color, ci) => {
      stock[color] = {};
      for (const size of sizes) {
        const prev = ci === 0 ? old.find((v) => v.size === size) : undefined;
        rows.push({ id: prev?.id ?? new ObjectId().toHexString(), color, size, barcode: prev?.barcode });
        const units = legacyStock[size];
        stock[color][size] = ci === 0 && typeof units === "number" ? units : null;
      }
    });
    return { d, rows, stock };
  });

  const codes = await allocateBarcodes(plans.reduce((n, p) => n + p.rows.filter((r) => !r.barcode).length, 0));
  let i = 0;

  const ops = plans.map(({ d, rows, stock }) => {
    const variants = rows.map(({ id, color, size, barcode }) => ({ id, color, size, barcode: barcode ?? codes[i++] }));
    const published = d.published ?? Boolean(d.active);
    const $set = {
      variants,
      stock,
      sizes: [...new Set(variants.map((v) => v.size))],
      published,
      active: published,
      costPrice: d.costPrice ?? 0,
      reorderLevel: d.reorderLevel ?? 0,
      createdAt: d.createdAt ?? new Date(d.dateAdded ?? Date.now()),
      searchTokens: buildSearchTokens({ ...d, variants }),
    };
    return {
      updateOne: {
        filter: { _id: d._id, rev: d.rev ?? { $exists: false } },
        update: { $set, $unset: { barcode: "", status: "", color: "", colorHex: "" }, $inc: { rev: 1 } },
      },
    };
  });

  const res = await Product.products().bulkWrite(ops, { ordered: false });
  log?.info({ updated: res.modifiedCount }, "Migrated products to Color + Size variants");
  return { updated: res.modifiedCount };
}
