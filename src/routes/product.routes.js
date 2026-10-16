import * as Products from "../controllers/product.controller.js";
import * as Variants from "../controllers/variant.controller.js";
import * as Inventory from "../controllers/inventory.controller.js";
import * as Barcodes from "../controllers/barcode.controller.js";
import * as Images from "../controllers/image.controller.js";
import * as S from "../schemas/product.schema.js";

// /api/v1/products — Product Management for the ERP Admin Portal.
export default async function productRoutes(app) {
  // Catalogue
  app.get("/", { schema: S.listProductsSchema }, Products.list);
  app.post("/", { schema: S.createProductSchema }, Products.create);
  app.get("/search", { schema: S.searchProductsSchema }, Products.search);
  app.get("/form-options", Products.formOptions); // active categories + brands for the product form
  app.post("/bulk/publish", { schema: S.bulkPublishSchema }, Products.bulkPublish);
  app.post("/maintenance/backfill", Products.backfill);
  app.get("/barcode/:code", { schema: S.barcodeLookupSchema }, Barcodes.lookup);

  // One product (":id" = MongoDB id or slug)
  app.get("/:id", { schema: S.idSchema }, Products.get);
  app.patch("/:id", { schema: S.updateProductSchema }, Products.update);
  app.delete("/:id", { schema: S.idSchema }, Products.remove);

  // Publishing — controls visibility on the website
  app.post("/:id/publish", { schema: S.idSchema }, Products.publish);
  app.post("/:id/unpublish", { schema: S.idSchema }, Products.unpublish);

  // Sizes / variants
  app.get("/:id/variants", { schema: S.variantListSchema }, Variants.list);
  app.post("/:id/variants", { schema: S.addVariantSchema }, Variants.add);
  app.patch("/:id/variants/:variantId", { schema: S.updateVariantSchema }, Variants.update);
  app.delete("/:id/variants/:variantId", { schema: S.variantIdSchema }, Variants.remove);

  // Pricing & stock
  app.patch("/:id/pricing", { schema: S.pricingSchema }, Inventory.updatePricing);
  app.get("/:id/stock", { schema: S.idSchema }, Inventory.getStock);
  app.post("/:id/stock/adjust", { schema: S.stockAdjustSchema }, Inventory.adjustStock);
  app.get("/:id/stock/history", { schema: S.stockHistorySchema }, Inventory.history);

  // Barcodes
  app.get("/:id/barcodes", { schema: S.idSchema }, Barcodes.labels);
  app.post("/:id/barcodes/regenerate", { schema: S.regenerateBarcodeSchema }, Barcodes.regenerate);

  // Images (Cloudflare R2)
  app.post("/:id/images", { schema: S.productImagesSchema }, Images.addToProduct); // multipart, field "file" (repeatable)
  app.put("/:id/images", { schema: S.reorderImagesSchema }, Images.reorder);
  app.delete("/:id/images", { schema: S.removeImageSchema }, Images.remove);
}
