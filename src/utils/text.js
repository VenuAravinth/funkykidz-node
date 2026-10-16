// Slugs and search tokens.

export function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lower-cased words of `text`, the unit search matches on. */
export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Every word a product can be found by: name, variant barcodes, category, colours, sizes, tag.
 * Stored on the product as `searchTokens` (indexed), so "hanb ros" finds "Hanbok … Rose" with
 * index-backed prefix matches instead of scanning the collection.
 */
export function buildSearchTokens(p) {
  const parts = [p.name, p.sku, p.category, p.subcategory, p.brand, p.gender, p.tag];
  for (const key of ["productType", "pattern", "occasion"]) parts.push(p.attributes?.[key]);
  for (const v of p.variants ?? []) parts.push(v.barcode, v.size, v.color);
  const tokens = new Set();
  for (const part of parts) for (const t of tokenize(part)) tokens.add(t);
  return [...tokens];
}
