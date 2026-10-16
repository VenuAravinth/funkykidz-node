import * as Public from "../controllers/public.controller.js";
import * as S from "../schemas/public.schema.js";

// /api/v1/public — read-only storefront API used by the FunkyKidz website. No API key: it only
// exposes published products and active categories/brands.
export default async function publicRoutes(app) {
  // Images and JSON are loaded by the website on another origin.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
  });

  app.get("/products", { schema: S.publicProductsSchema }, Public.listProducts);
  app.get("/products/:slug", { schema: S.publicSlugSchema }, Public.getProduct);
  app.get("/categories", Public.listCategories);
  app.get("/brands", Public.listBrands);
  app.get("/product-images/:file", { schema: S.publicImageSchema }, Public.productImage);
}
