import { createHash, createHmac } from "node:crypto";

// AWS Signature V4 query-string signing ("presigned URLs") for Cloudflare R2's S3 API.
// R2 uses region "auto" and service "s3". Written against Node's crypto so no SDK is needed.

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
// RFC 3986 encoding, as SigV4 requires.
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key) => key.split("/").map(encode).join("/");

const amzDate = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Presigned URL for `method` on `/<bucket>/<key>`, valid for `expiresIn` seconds from `signedAt`.
 * `headers` (lower-case names) are signed too, and the client must send exactly those values,
 * e.g. content-type and content-length on uploads so nobody can swap the file for a bigger one.
 */
export function presign({ method, endpoint, bucket, key, accessKeyId, secretAccessKey, expiresIn, signedAt = new Date(), headers = {}, region = "auto" }) {
  const url = new URL(endpoint);
  const datetime = amzDate(signedAt);
  const date = datetime.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;

  const signedHeaders = { host: url.host, ...headers };
  const headerNames = Object.keys(signedHeaders).sort();
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": datetime,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": headerNames.join(";"),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(query[k])}`)
    .join("&");
  const path = `/${encode(bucket)}/${encodeKey(key)}`;
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    headerNames.map((h) => `${h}:${String(signedHeaders[h]).trim()}\n`).join(""),
    headerNames.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
