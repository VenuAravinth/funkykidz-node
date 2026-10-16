import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";

// Every /api/v1 route needs one of the ERP_API_KEYS, sent as "Authorization: Bearer <key>" or
// "x-api-key: <key>". The ERP Admin Portal's server calls this API with its key; the key never
// goes to a browser. `x-erp-user` (the signed-in admin's email/name) is recorded on audit entries.

const digest = (s) => createHash("sha256").update(s).digest();
const keyDigests = env.apiKeys.map(digest);

function presentedKey(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-api-key"];
  return typeof header === "string" ? header.trim() : "";
}

export async function requireApiKey(req) {
  const key = presentedKey(req);
  // Compare fixed-length digests in constant time, against every key, so timing reveals nothing.
  const d = digest(key);
  let ok = false;
  for (const k of keyDigests) ok = timingSafeEqual(d, k) || ok;
  if (!key || !ok) throw new AppError(401, "UNAUTHORIZED", "A valid API key is required.");
  const user = req.headers["x-erp-user"];
  req.actor = typeof user === "string" && user.trim() ? user.trim().slice(0, 120) : "api";
}
