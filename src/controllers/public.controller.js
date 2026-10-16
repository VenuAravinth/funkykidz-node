import * as PublicService from "../services/public.service.js";

// Storefront responses may be cached briefly by browsers/CDNs; the server cache is dropped on every change.
const SHORT_CACHE = "public, max-age=15, stale-while-revalidate=30";
// The redirect may be reused for 5 minutes; the signed URL it points to stays valid for 15–20.
const REDIRECT_CACHE = "public, max-age=300";

export async function listProducts(req, reply) {
  reply.header("Cache-Control", SHORT_CACHE);
  return PublicService.listProducts(req.query);
}

export async function getProduct(req, reply) {
  reply.header("Cache-Control", SHORT_CACHE);
  return { product: await PublicService.getProduct(req.params.slug) };
}

export async function listCategories(_req, reply) {
  reply.header("Cache-Control", SHORT_CACHE);
  return { categories: await PublicService.listCategories() };
}

export async function listBrands(_req, reply) {
  reply.header("Cache-Control", SHORT_CACHE);
  return { brands: await PublicService.listBrands() };
}

/** Redirects to a freshly signed R2 URL — pages only ever hold this stable address. */
export async function productImage(req, reply) {
  const url = await PublicService.signedImageFor(req.params.file);
  if (!url) return reply.code(404).header("Cache-Control", "no-store").send({ error: { code: "NOT_FOUND", message: "Image not found." } });
  return reply.code(302).header("Location", url).header("Cache-Control", REDIRECT_CACHE).header("Referrer-Policy", "no-referrer").send();
}
