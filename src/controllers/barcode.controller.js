import * as BarcodeService from "../services/productBarcode.service.js";

export async function lookup(req) {
  return BarcodeService.lookupByCode(req.params.code);
}

export async function labels(req) {
  return { labels: await BarcodeService.barcodeLabels(req.params.id) };
}

export async function regenerate(req) {
  return { product: await BarcodeService.regenerateBarcodes(req.params.id, req.body ?? {}, req.log) };
}
