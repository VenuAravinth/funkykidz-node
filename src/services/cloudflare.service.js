import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { presign } from "../utils/sigv4.js";
import { badGateway, unavailable } from "../utils/errors.js";

// Product images on Cloudflare R2 (private bucket, S3 API). MongoDB stores each image's permanent
// object URL — https://<account>.r2.cloudflarestorage.com/<bucket>/<CLOUDFLARE_R2_IMAGE_FOLDER>/<id>.<ext> — which is
// useless on its own: viewers always get a presigned URL generated from it that expires in ≤ 20 min.

const r2 = env.r2;
const KEY_PREFIX = `${env.r2.imageFolder}/`;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const configured = () => Boolean(r2.endpoint && r2.bucket && r2.accessKeyId && r2.secretAccessKey);
export const isConfigured = configured;

function requireConfig() {
  if (!configured()) throw unavailable("Image storage isn't configured. Set the CLOUDFLARE_R2_* variables on the server.");
}

const credentials = () => ({ endpoint: r2.endpoint, bucket: r2.bucket, accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey });
const objectUrl = (key) => `${r2.endpoint.replace(/\/+$/, "")}/${r2.bucket}/${key}`;

/** Object key of a stored URL in OUR bucket's image folder, else null. */
export function objectKeyFromUrl(url) {
  if (!configured() || typeof url !== "string") return null;
  const prefix = `${objectUrl(KEY_PREFIX)}`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length - KEY_PREFIX.length);
  return /^[A-Za-z0-9_-]{8,80}\.(jpg|png|webp)$/.test(key.slice(KEY_PREFIX.length)) ? key : null;
}

export const isOwnImageUrl = (url) => objectKeyFromUrl(url) !== null;

async function r2Request(method, key, { body, headers = {}, what }) {
  const url = presign({ ...credentials(), method, key, expiresIn: 300, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
  let res;
  try {
    res = await fetch(url, { method, body, headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-length")), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw badGateway(`Couldn't reach Cloudflare R2 to ${what}.`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).match(/<Message>([^<]*)<\/Message>/)?.[1];
    throw badGateway(`Cloudflare R2 rejected the request to ${what}${detail ? `: ${detail}` : ""}.`);
  }
  return res;
}

const newKey = (contentType) => `${KEY_PREFIX}${randomUUID().replace(/-/g, "")}.${EXTENSIONS[contentType]}`;
// Header values must be ASCII; keep metadata short and encoded.
const metaHeaders = (metadata) =>
  Object.fromEntries(Object.entries(metadata).filter(([, v]) => v).map(([k, v]) => [`x-amz-meta-${k.toLowerCase()}`, encodeURIComponent(String(v)).slice(0, 200)]));

/** Uploads one image from memory and returns its permanent (unsigned) object URL. */
export async function uploadImage(buffer, { contentType, metadata = {} }) {
  requireConfig();
  const key = newKey(contentType);
  await r2Request("PUT", key, {
    body: buffer,
    headers: { "content-type": contentType, "content-length": buffer.length, "cache-control": "public, max-age=31536000, immutable", ...metaHeaders(metadata) },
    what: "upload the image",
  });
  return objectUrl(key);
}

/**
 * Presigned PUT the browser can upload one file to directly (it never passes through this server).
 * Type and exact size are part of the signature, so the URL can't be reused for another file.
 * The bucket needs a CORS rule allowing PUT from the ERP's origin for this to work in a browser.
 */
export function createDirectUpload({ contentType, size }) {
  requireConfig();
  const key = newKey(contentType);
  const expiresIn = 10 * 60;
  const uploadURL = presign({ ...credentials(), method: "PUT", key, expiresIn, headers: { "content-type": contentType, "content-length": size } });
  return { uploadURL, method: "PUT", headers: { "Content-Type": contentType }, imageUrl: objectUrl(key), expiresAt: Math.floor(Date.now() / 1000) + expiresIn };
}

/** Best effort: a failed delete only leaves an orphaned file in the bucket. */
export async function deleteImages(urls, log) {
  if (!configured()) return;
  const keys = urls.map(objectKeyFromUrl).filter(Boolean);
  await Promise.all(keys.map((key) => r2Request("DELETE", key, { what: "delete the image" }).catch((err) => log?.warn({ err: err.message, key }, "R2 image delete failed"))));
}

/**
 * Expiry for signatures made now. The signing time is rounded down to 5-minute steps so every
 * request in the same window gets the identical URL (browser and CDN caches keep working); the URL
 * then stays valid for between TTL − 5 min and TTL — never more than 20 minutes.
 */
export function signatureExpiry(now = Date.now()) {
  const ttl = r2.signedUrlTtl;
  const step = Math.min(300, Math.floor(ttl / 4));
  return Math.floor(now / 1000 / step) * step + ttl;
}

/** Presigned GET for one of our images; anything else (e.g. legacy /api/media/<id>) is returned unchanged. */
export function signImageUrl(url, expiresAt = signatureExpiry()) {
  const key = objectKeyFromUrl(url);
  if (!key) return url;
  const ttl = r2.signedUrlTtl;
  return presign({ ...credentials(), method: "GET", key, expiresIn: ttl, signedAt: new Date((expiresAt - ttl) * 1000) });
}

export function signImageUrls(urls) {
  const expiresAt = signatureExpiry();
  return { urls: urls.map((u) => signImageUrl(u, expiresAt)), expiresAt };
}
