import { makeTaxonomyController } from "../controllers/taxonomy.controller.js";
import { CategoryService } from "../services/category.service.js";
import { BrandService } from "../services/brand.service.js";
import * as S from "../schemas/product.schema.js";

// /api/v1/categories and /api/v1/brands — part of Product Management.
function taxonomyRoutes(controller) {
  return async (app) => {
    app.get("/", { schema: S.taxonomyListSchema }, controller.list);
    app.get("/options", controller.options); // active only — for the product form
    app.post("/", { schema: S.taxonomyCreateSchema }, controller.create);
    app.get("/:id", { schema: S.taxonomyIdSchema }, controller.get);
    app.patch("/:id", { schema: S.taxonomyUpdateSchema }, controller.update);
    app.delete("/:id", { schema: S.taxonomyIdSchema }, controller.remove);
  };
}

export const categoryRoutes = taxonomyRoutes(makeTaxonomyController(CategoryService, "category"));
export const brandRoutes = taxonomyRoutes(makeTaxonomyController(BrandService, "brand"));
