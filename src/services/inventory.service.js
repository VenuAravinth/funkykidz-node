import * as Product from "../models/product.model.js";
import * as StockMovement from "../models/stockMovement.model.js";
import { mutateProduct } from "./product.service.js";
import { notifyWebsite } from "./website.service.js";
import { conflict, notFound, unprocessable } from "../utils/errors.js";

// Pricing (product level only) and stock (per Color + Size).

export function updatePricing(idOrSlug, { price, oldPrice, costPrice }, log) {
  return mutateProduct(idOrSlug, () => ({ price, oldPrice, costPrice }), log);
}

const STOCK_PROJECTION = { name: 1, variants: 1, stock: 1, reorderLevel: 1, active: 1, published: 1 };

function stockSummary(doc) {
  const p = Product.toApi(doc);
  return {
    id: p.id,
    name: p.name,
    published: p.published,
    reorderLevel: p.reorderLevel ?? 0,
    totalStock: p.totalStock,
    lowStock: p.lowStock,
    rows: p.variants.map((v) => ({ variantId: v.id, color: v.color, size: v.size, barcode: v.barcode, stock: v.stock })),
  };
}

export async function getStock(idOrSlug) {
  const doc = await Product.findOne(Product.idFilter(idOrSlug), { projection: STOCK_PROJECTION });
  if (!doc) throw notFound("Product not found.");
  return stockSummary(doc);
}

/**
 * Applies several stock changes in ONE atomic update: `delta` adds/removes units, `set` sets an
 * exact count (e.g. after a physical count). A removal only succeeds if enough units are there,
 * so stock can never go negative — even while the website is taking orders. A product left with
 * nothing to sell is unpublished straight after.
 */
export async function adjustStock(idOrSlug, { adjustments, reason, note }, actor, log) {
  const current = await Product.findOne(Product.idFilter(idOrSlug), { projection: STOCK_PROJECTION });
  if (!current) throw notFound("Product not found.");

  const variants = current.variants ?? [];
  const filter = { _id: current._id };
  const $inc = {};
  const $set = { updatedAt: new Date() };
  const seen = new Set();
  const lines = adjustments.map((adj) => {
    const v = variants.find((x) => (adj.variantId ? x.id === adj.variantId : x.barcode === adj.barcode));
    if (!v) throw notFound(`Variant ${adj.variantId ?? adj.barcode} not found on this product.`);
    if (seen.has(v.id)) throw unprocessable(`${v.color} / ${v.size} appears twice in one adjustment.`);
    seen.add(v.id);
    const path = `stock.${v.color}.${v.size}`;
    const before = current.stock?.[v.color]?.[v.size] ?? null;
    if (adj.set !== undefined) {
      $set[path] = adj.set;
    } else if (before === null) {
      throw unprocessable(`${v.color} / ${v.size} isn't stock-tracked yet. Set an exact count first.`);
    } else {
      $inc[path] = adj.delta;
      if (adj.delta < 0) filter[path] = { $gte: -adj.delta };
    }
    return { variant: v, before, delta: adj.delta, set: adj.set };
  });

  const updated = await Product.findOneAndUpdate(filter, { $set, $inc: { ...$inc, rev: 1 } }, { projection: STOCK_PROJECTION });
  if (!updated) {
    const short = lines.find((l) => l.delta < 0 && (l.before ?? 0) < -l.delta) ?? lines.find((l) => l.delta < 0);
    const label = short ? `${short.variant.color} / ${short.variant.size}` : "this variant";
    throw conflict(`Not enough stock for ${label}. Reload to see the current count.`, { variantId: short?.variant.id });
  }

  const at = new Date();
  await StockMovement.insertMany(
    lines.map(({ variant: v, before, delta, set }) => ({
      productId: current._id,
      variantId: v.id,
      color: v.color,
      size: v.size,
      type: set !== undefined ? "set" : "adjust",
      delta: set !== undefined ? set - (before ?? 0) : delta,
      before,
      after: updated.stock?.[v.color]?.[v.size] ?? null,
      reason: reason ?? "manual",
      note,
      by: actor,
      at,
    })),
  );
  const soldOut = await Product.unpublishIfSoldOut({ _id: current._id });
  if (updated.active) notifyWebsite(log);
  return stockSummary(soldOut ? await Product.findOne({ _id: current._id }, { projection: STOCK_PROJECTION }) : updated);
}

export async function stockHistory(idOrSlug, limit = 50) {
  const doc = await Product.findOne(Product.idFilter(idOrSlug), { projection: { _id: 1 } });
  if (!doc) throw notFound("Product not found.");
  return StockMovement.findForProduct(doc._id, limit);
}
