import * as Product from "../models/product.model.js";
import * as Cloudflare from "./cloudflare.service.js";
import { mutateProduct, present } from "./product.service.js";
import { notifyWebsite } from "./website.service.js";
import { notFound, unprocessable } from "../utils/errors.js";

// Product images on Cloudflare R2. MongoDB stores only the permanent object URLs; every
// response carries freshly signed URLs (≤ 20 min) generated from them.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // per image

// Trust the file's bytes, not the client's Content-Type.
export function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Uploads files to R2 in parallel and returns their original URLs. All-or-nothing: if one
 * fails, the ones already uploaded are removed again.
 */
export async function uploadImages(files, metadata, log) {
  if (!files.length) throw unprocessable("Attach at least one image (field name: file).");
  const typed = files.map((f) => {
    const contentType = sniffImageType(f.buffer);
    if (!contentType) throw unprocessable(`${f.filename}: only JPG, PNG or WebP images are allowed.`);
    return { ...f, contentType };
  });
  const results = await Promise.allSettled(typed.map((f) => Cloudflare.uploadImage(f.buffer, { filename: f.filename, contentType: f.contentType, metadata })));
  const uploaded = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    await Cloudflare.deleteImages(uploaded, log);
    throw failed.reason;
  }
  return uploaded;
}

/** Upload without a product yet (e.g. while filling the "new product" form). */
export async function uploadStandalone(files, actor, log) {
  const images = await uploadImages(files, { uploadedBy: actor }, log);
  const { urls, expiresAt } = Cloudflare.signImageUrls(images);
  return { images, imageUrls: urls, imageUrlsExpireAt: expiresAt };
}

export async function addProductImages(idOrSlug, files, actor, log) {
  const current = await Product.findOne(Product.idFilter(idOrSlug), { projection: { slug: 1, images: 1 } });
  if (!current) throw notFound("Product not found.");
  const room = Product.MAX_IMAGES - (current.images?.length ?? 0);
  if (files.length > room) throw unprocessable(`A product can have up to ${Product.MAX_IMAGES} images (${Math.max(room, 0)} more allowed).`);

  const urls = await uploadImages(files, { productSlug: current.slug, uploadedBy: actor }, log);
  // The size check sits in the update itself, so two uploads racing can't exceed the limit.
  const updated = await Product.findOneAndUpdate(
    { _id: current._id, $expr: { $lte: [{ $size: { $ifNull: ["$images", []] } }, Product.MAX_IMAGES - urls.length] } },
    { $push: { images: { $each: urls } }, $set: { updatedAt: new Date() }, $inc: { rev: 1 } },
  );
  if (!updated) {
    await Cloudflare.deleteImages(urls, log);
    throw unprocessable(`A product can have up to ${Product.MAX_IMAGES} images.`);
  }
  if (updated.active) notifyWebsite(log);
  return present(updated);
}

export function removeProductImage(idOrSlug, url, log) {
  return mutateProduct(
    idOrSlug,
    (cur) => {
      if (!cur.images?.includes(url)) throw notFound("That image isn't on this product.");
      return { images: cur.images.filter((u) => u !== url) };
    },
    log,
  );
}

/** New order for the existing images; the first one is the main photo on the website. */
export function reorderProductImages(idOrSlug, images, log) {
  return mutateProduct(
    idOrSlug,
    (cur) => {
      const now = cur.images ?? [];
      if (images.length !== now.length || images.some((u) => !now.includes(u))) {
        throw unprocessable("Send every current image exactly once, in the new order. To remove one, use DELETE.");
      }
      return { images };
    },
    log,
  );
}

/** Presigned PUT so a browser can upload one file straight to R2 (type and size are signed). */
export function createDirectUpload({ contentType, size }) {
  return Cloudflare.createDirectUpload({ contentType, size });
}

/** { signedUrls: { original → signed }, expiresAt } — only for images on our account. */
export function signUrls(urls) {
  const expiresAt = Cloudflare.signatureExpiry();
  const signedUrls = {};
  for (const url of urls) if (Cloudflare.isOwnImageUrl(url)) signedUrls[url] = Cloudflare.signImageUrl(url, expiresAt);
  return { signedUrls, expiresAt };
}
