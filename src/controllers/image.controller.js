import { MAX_IMAGES } from "../models/product.model.js";
import * as ImageService from "../services/image.service.js";

// Reads every file part of a multipart request into memory (each capped at 10 MB by the parser).
async function readFiles(req) {
  const files = [];
  for await (const part of req.files({ limits: { fileSize: ImageService.MAX_IMAGE_BYTES, files: MAX_IMAGES } })) {
    files.push({ filename: part.filename || "image", buffer: await part.toBuffer() });
  }
  return files;
}

export async function upload(req, reply) {
  return reply.code(201).send(await ImageService.uploadStandalone(await readFiles(req), req.actor, req.log));
}

export async function addToProduct(req, reply) {
  const product = await ImageService.addProductImages(req.params.id, await readFiles(req), req.actor, req.log);
  return reply.code(201).send({ product });
}

export async function remove(req) {
  return { product: await ImageService.removeProductImage(req.params.id, req.body.url, req.log) };
}

export async function reorder(req) {
  return { product: await ImageService.reorderProductImages(req.params.id, req.body.images, req.log) };
}

export async function directUpload(req) {
  return ImageService.createDirectUpload(req.body);
}

export async function sign(req) {
  return ImageService.signUrls(req.body.urls);
}
