import { requireApiKey } from "../middlewares/auth.js";
import productRoutes from "./product.routes.js";
import imageRoutes from "./image.routes.js";
import publicRoutes from "./public.routes.js";
import aiRoutes from "./ai.routes.js";
import { brandRoutes, categoryRoutes } from "./taxonomy.routes.js";

export default async function apiV1(app) {
  // Storefront (website): read-only, published data only, no API key.
  app.register(publicRoutes, { prefix: "/public" });

  // ERP Admin Portal: everything else needs an API key.
  app.register(async (admin) => {
    admin.addHook("onRequest", requireApiKey);
    admin.register(productRoutes, { prefix: "/products" });
    admin.register(imageRoutes, { prefix: "/images" });
    admin.register(categoryRoutes, { prefix: "/categories" });
    admin.register(brandRoutes, { prefix: "/brands" });
    admin.register(aiRoutes, { prefix: "/ai" });
  });
}
