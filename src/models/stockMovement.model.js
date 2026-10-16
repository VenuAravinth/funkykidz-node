import { getDb } from "../config/database.js";

// Audit trail of every manual stock change made from the ERP (who, what, why, before → after).

const movements = () => getDb().collection("stock_movements");

export async function ensureStockMovementIndexes() {
  await movements().createIndexes([{ key: { productId: 1, at: -1 } }, { key: { at: -1 } }]);
}

export const insertMany = (docs) => (docs.length ? movements().insertMany(docs, { ordered: false }) : null);

export const findForProduct = (productId, limit) =>
  movements().find({ productId }, { projection: { _id: 0, productId: 0 }, sort: { at: -1 }, limit }).toArray();
