import { MAX_VARIANTS } from "../models/product.model.js";
import { getProduct, mutateProduct } from "./product.service.js";
import { notFound, unprocessable } from "../utils/errors.js";

// Color + Size variants of a product. Each one is a row in the product's `variants` list; edits go
// through mutateProduct so colourways, sizes, stock keys, barcodes and search stay consistent.

// Unchanged rows are passed by id only, which keeps all their stored values.
const keepAll = (cur) => (cur.variants ?? []).map((v) => ({ id: v.id }));

function requireVariant(cur, variantId) {
  if (!cur.variants?.some((v) => v.id === variantId)) throw notFound("Variant not found on this product.");
}

export async function listVariants(idOrSlug) {
  return (await getProduct(idOrSlug)).variants;
}

export async function addVariant(idOrSlug, row, log) {
  const product = await mutateProduct(
    idOrSlug,
    (cur) => {
      if ((cur.variants?.length ?? 0) >= MAX_VARIANTS) throw unprocessable(`A product can have up to ${MAX_VARIANTS} variants.`);
      return { variants: [...keepAll(cur), row] };
    },
    log,
  );
  return { product, variant: product.variants.at(-1) };
}

export async function updateVariant(idOrSlug, variantId, changes, log) {
  const product = await mutateProduct(
    idOrSlug,
    (cur) => {
      requireVariant(cur, variantId);
      return { variants: cur.variants.map((v) => (v.id === variantId ? { ...changes, id: v.id } : { id: v.id })) };
    },
    log,
  );
  return { product, variant: product.variants.find((v) => v.id === variantId) };
}

export async function deleteVariant(idOrSlug, variantId, log) {
  const product = await mutateProduct(
    idOrSlug,
    (cur) => {
      requireVariant(cur, variantId);
      return { variants: cur.variants.filter((v) => v.id !== variantId).map((v) => ({ id: v.id })) };
    },
    log,
  );
  return { product };
}
