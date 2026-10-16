import * as Images from "../controllers/image.controller.js";
import * as S from "../schemas/product.schema.js";

// /api/v1/images — uploads not yet tied to a product, and URL signing.
export default async function imageRoutes(app) {
  app.post("/", Images.upload); // multipart → { images: [original URLs], imageUrls: [signed] }
  app.post("/direct-upload", { schema: S.directUploadSchema }, Images.directUpload); // presigned PUT: browser → R2 directly
  app.post("/sign", { schema: S.signUrlsSchema }, Images.sign);
}
