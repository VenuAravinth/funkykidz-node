// Errors services throw on purpose. The global error handler turns them into
// { error: { code, message, details? } } with the right status; anything else becomes a 500.

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, "BAD_REQUEST", message, details);
export const notFound = (message = "Not found.") => new AppError(404, "NOT_FOUND", message);
export const conflict = (message, details) => new AppError(409, "CONFLICT", message, details);
export const unprocessable = (message, details) => new AppError(422, "UNPROCESSABLE", message, details);
export const badGateway = (message) => new AppError(502, "UPSTREAM_ERROR", message);
export const unavailable = (message) => new AppError(503, "NOT_CONFIGURED", message);

const DUPLICATE_FIELD_LABELS = { slug: "slug", sku: "SKU", barcode: "barcode", "variants.sku": "variant SKU", "variants.barcode": "variant barcode" };

/** Turns a MongoDB duplicate-key error into a readable 409, or returns null. */
export function fromDuplicateKey(err) {
  if (err?.code !== 11000) return null;
  const field = Object.keys(err.keyPattern ?? {})[0] ?? "field";
  const value = err.keyValue?.[field];
  const label = DUPLICATE_FIELD_LABELS[field] ?? field;
  return conflict(`Another product already uses this ${label}${value !== undefined ? ` (${value})` : ""}.`, { field });
}
