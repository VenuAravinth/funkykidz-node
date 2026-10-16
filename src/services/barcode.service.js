import * as Counter from "../models/counter.model.js";
import * as Product from "../models/product.model.js";
import { barcodeSequence, internalBarcode } from "../utils/barcode.js";

// Internal EAN-13 barcodes for products and their variants. Numbers come from an atomic counter
// that only moves forward, so a code is never reissued — not even after its product is deleted.

const COUNTER = "productBarcode";

/** Reserves `count` fresh barcodes in one round trip. */
export async function allocateBarcodes(count) {
  if (count <= 0) return [];
  const first = await Counter.allocate(COUNTER, count);
  return Array.from({ length: count }, (_, i) => internalBarcode(first + i));
}

/**
 * At startup: make sure the counter is past every internal code already in the database
 * (e.g. codes issued by the ERP frontend's mock data or imported products).
 */
export async function syncBarcodeCounter() {
  const docs = await Product.find(
    { $or: [{ barcode: /^20\d{11}$/ }, { "variants.barcode": /^20\d{11}$/ }] },
    { projection: { _id: 0, barcode: 1, "variants.barcode": 1 } },
  );
  let highest = 0;
  for (const d of docs) {
    highest = Math.max(highest, barcodeSequence(d.barcode));
    for (const v of d.variants ?? []) highest = Math.max(highest, barcodeSequence(v.barcode));
  }
  if (highest > 0) await Counter.ensureAtLeast(COUNTER, highest);
}
