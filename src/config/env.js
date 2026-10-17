// All configuration comes from environment variables (.env in development, the host's secret
// manager in production). Nothing sensitive lives in code.

const read = (name, fallback) => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
};
const list = (name) => (read(name, "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const int = (name, fallback) => {
  const n = Number.parseInt(read(name, ""), 10);
  return Number.isFinite(n) ? n : fallback;
};

const MAX_SIGNED_URL_TTL = 20 * 60;

export const env = {
  port: int("PORT", 4000),
  host: read("HOST", "0.0.0.0"),
  isProduction: read("NODE_ENV", "development") === "production",
  logLevel: read("LOG_LEVEL", "info"),
  corsOrigins: list("CORS_ORIGINS"),
  // Address the website/browsers use to reach this server; product image links are built on it.
  publicBaseUrl: (read("PUBLIC_BASE_URL") ?? `http://localhost:${int("PORT", 4000)}`).replace(/\/+$/, ""),
  apiKeys: list("ERP_API_KEYS"),

  mongo: {
    uri: read("MONGODB_URI"),
    dbName: read("MONGODB_DB"),
    maxPoolSize: int("MONGODB_MAX_POOL_SIZE", 50),
  },

  r2: {
    accountId: read("CLOUDFLARE_ACCOUNT_ID"),
    accessKeyId: read("CLOUDFLARE_R2_ACCESS_KEY_ID"),
    secretAccessKey: read("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    bucket: read("CLOUDFLARE_R2_BUCKET_NAME"),
    // Folder inside the bucket that product images go into (no leading/trailing slash).
    imageFolder: (read("CLOUDFLARE_R2_IMAGE_FOLDER", "products") ?? "products").replace(/^\/+|\/+$/g, ""),
    endpoint: read("CLOUDFLARE_R2_ENDPOINT") ?? (read("CLOUDFLARE_ACCOUNT_ID") && `https://${read("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`),
    // Never longer than 20 minutes, whatever the environment says.
    signedUrlTtl: Math.min(Math.max(int("CLOUDFLARE_SIGNED_URL_TTL", MAX_SIGNED_URL_TTL), 60), MAX_SIGNED_URL_TTL),
  },

  // Google Gemini (AI product details from a photo). The key never leaves this server.
  gemini: {
    apiKey: read("GEMINI_API_KEY"),
    baseUrl: read("GEMINI_API_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, ""),
    // Vision models for product analysis, tried in order (the next one is used when one is overloaded).
    analysisModels: list("GEMINI_ANALYSIS_MODELS").length ? list("GEMINI_ANALYSIS_MODELS") : ["gemini-3.8-flash", "gemini-3.5-flash"],
    timeoutMs: int("GEMINI_TIMEOUT_MS", 120_000),
  },

  // First ERP Admin Portal administrator, created only while no ERP users exist.
  erpAdmin: {
    email: read("ERP_ADMIN_EMAIL"),
    password: read("ERP_ADMIN_PASSWORD"),
  },

  website: {
    revalidateUrl: read("WEBSITE_REVALIDATE_URL"),
    revalidateSecret: read("WEBSITE_REVALIDATE_SECRET"),
  },
};

/** Fails fast at boot instead of half-working at request time. */
export function assertConfig() {
  const problems = [];
  if (!env.mongo.uri) problems.push("MONGODB_URI is required");
  if (env.apiKeys.length === 0) problems.push("ERP_API_KEYS needs at least one key");
  if (env.isProduction && env.apiKeys.some((k) => k.length < 32)) problems.push("ERP_API_KEYS must be at least 32 characters each in production");
  if (env.erpAdmin.password && env.erpAdmin.password.length < 8) problems.push("ERP_ADMIN_PASSWORD must be at least 8 characters");
  if (problems.length) throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
}
