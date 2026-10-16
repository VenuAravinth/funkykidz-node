import { ATTRIBUTE_KEYS, GENDERS, MAX_IMAGES, MAX_VARIANTS, STATUSES, TAGS } from "../models/product.model.js";

// Request validation (Fastify/Ajv, compiled once at boot). `additionalProperties: false` makes
// Fastify drop unknown fields, so nothing unexpected ever reaches MongoDB.

const str = (max, extra = {}) => ({ type: "string", maxLength: max, ...extra });
const nullable = (schema) => ({ ...schema, type: [schema.type, "null"] });
const money = { type: "number", minimum: 0, maximum: 10_000_000 };
const count = { type: "integer", minimum: 0, maximum: 1_000_000 };
// Colours and sizes become MongoDB field names (stock.<color>.<size>), so no "." or "$".
const size = str(40, { minLength: 1, pattern: "^[^.$]+$" });
const color = str(40, { minLength: 1, pattern: "^[^.$]+$" });
const objectIdOrSlug = str(120, { minLength: 1 });
const imageUrl = str(500, { format: "uri" });
const hex = str(7, { pattern: "^#[0-9A-Fa-f]{6}$" });
const objectId = str(24, { pattern: "^[0-9a-f]{24}$" });
// Product-level stock-keeping code typed by the admin, e.g. "FK-DRS-0012". Stored upper-case.
const sku = str(40, { minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9/_-]*$" });

// One Color + Size combination. Pricing always comes from the product; the barcode is issued here.
// stock: units on hand, or null when the variant isn't stock-tracked.
const variantRow = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str(24, { pattern: "^[0-9a-f]{24}$" }),
    color,
    size,
    stock: nullable(count),
  },
};

const colorSwatch = {
  type: "object",
  additionalProperties: false,
  required: ["name", "hex"],
  properties: { name: color, hex },
};

const productFields = {
  name: str(120, { minLength: 2 }),
  slug: str(80, { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
  sku: nullable(sku), // optional, unique; null clears it
  // Pick from GET /api/v1/categories/options and /api/v1/brands/options (active ones only).
  categoryId: objectId,
  brandId: { ...objectId, type: ["string", "null"] }, // null removes the brand
  subcategory: str(60),
  gender: { type: "string", enum: GENDERS },
  colors: { type: "array", maxItems: MAX_VARIANTS, items: colorSwatch }, // optional swatch per colour
  tag: { type: ["string", "null"], enum: [...TAGS, null] }, // null removes the tag
  price: { ...money, exclusiveMinimum: 0 },
  oldPrice: nullable(money),
  costPrice: money,
  reorderLevel: count,
  shortDescription: str(200),
  description: str(5000),
  fabric: str(300),
  fit: str(300),
  care: str(300),
  images: { type: "array", maxItems: MAX_IMAGES, items: imageUrl },
  // Descriptive details (filled by AI or by hand); each optional.
  attributes: {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, str(100)])),
  },
  variants: { type: "array", maxItems: MAX_VARIANTS, items: variantRow },
  published: { type: "boolean" },
};

const idParams = { type: "object", required: ["id"], properties: { id: objectIdOrSlug } };
const variantParams = {
  type: "object",
  required: ["id", "variantId"],
  properties: { id: objectIdOrSlug, variantId: str(24, { pattern: "^[0-9a-f]{24}$" }) },
};

export const createProductSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["name", "categoryId", "gender", "price", "variants"],
    properties: {
      ...productFields,
      variants: { ...productFields.variants, minItems: 1, items: { ...variantRow, required: ["color", "size"] } },
    },
  },
};

export const updateProductSchema = {
  params: idParams,
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    // slug is fixed after creation: carts, wishlists and orders on the website refer to it.
    properties: (({ slug, ...rest }) => rest)(productFields), // eslint-disable-line no-unused-vars
  },
};

export const idSchema = { params: idParams };

const bool = { type: "boolean" };
const csvList = str(300);

export const listProductsSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: str(100),
      categoryId: csvList,
      brandId: csvList,
      category: csvList,
      gender: csvList,
      published: bool,
      brand: str(60),
      size: csvList,
      minPrice: money,
      maxPrice: money,
      inStock: bool,
      lowStock: bool,
      hasImages: bool,
      sort: { type: "string", enum: ["newest", "oldest", "updated", "price_asc", "price_desc", "name_asc", "name_desc", "popularity"] },
      page: { type: "integer", minimum: 1, maximum: 10_000, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    },
  },
};

export const searchProductsSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["q"],
    properties: { q: str(100, { minLength: 1 }), limit: { type: "integer", minimum: 1, maximum: 25, default: 10 } },
  },
};

export const bulkPublishSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["ids", "published"],
    properties: {
      ids: { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: str(24, { pattern: "^[0-9a-f]{24}$" }) },
      published: bool,
    },
  },
};

// --- Variants -------------------------------------------------------------------------------

export const variantListSchema = { params: idParams };
export const addVariantSchema = {
  params: idParams,
  body: { ...variantRow, required: ["color", "size"], properties: (({ id, ...rest }) => rest)(variantRow.properties) }, // eslint-disable-line no-unused-vars
};
export const updateVariantSchema = {
  params: variantParams,
  body: { ...variantRow, minProperties: 1, properties: (({ id, ...rest }) => rest)(variantRow.properties) }, // eslint-disable-line no-unused-vars
};
export const variantIdSchema = { params: variantParams };

// --- Pricing & stock ------------------------------------------------------------------------

export const pricingSchema = {
  params: idParams,
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      price: productFields.price,
      oldPrice: productFields.oldPrice,
      costPrice: money,
    },
  },
};

export const stockAdjustSchema = {
  params: idParams,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["adjustments"],
    properties: {
      reason: { type: "string", enum: ["manual", "count", "received", "damaged", "returned", "correction", "transfer"] },
      note: str(300),
      adjustments: {
        type: "array",
        minItems: 1,
        maxItems: MAX_VARIANTS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            variantId: variantRow.properties.id,
            barcode: str(40, { minLength: 3 }),
            delta: { type: "integer", minimum: -1_000_000, maximum: 1_000_000, not: { const: 0 } },
            set: count,
          },
          // Identify the size one way, and either add/remove (delta) or set an exact count.
          oneOf: [{ required: ["variantId"] }, { required: ["barcode"] }],
          anyOf: [
            { required: ["delta"], not: { required: ["set"] } },
            { required: ["set"], not: { required: ["delta"] } },
          ],
        },
      },
    },
  },
};

export const stockHistorySchema = {
  params: idParams,
  querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 50 } } },
};

// --- Barcodes -------------------------------------------------------------------------------

export const barcodeLookupSchema = { params: { type: "object", required: ["code"], properties: { code: str(40, { minLength: 3 }) } } };
export const regenerateBarcodeSchema = {
  params: idParams,
  body: {
    type: "object",
    additionalProperties: false,
    properties: { scope: { type: "string", enum: ["all", "variant"], default: "all" }, variantId: variantRow.properties.id },
    if: { properties: { scope: { const: "variant" } }, required: ["scope"] },
    then: { required: ["variantId"] },
  },
};

// --- Images ---------------------------------------------------------------------------------

export const productImagesSchema = { params: idParams };
export const removeImageSchema = {
  params: idParams,
  body: { type: "object", additionalProperties: false, required: ["url"], properties: { url: imageUrl } },
};
export const reorderImagesSchema = {
  params: idParams,
  body: { type: "object", additionalProperties: false, required: ["images"], properties: { images: { type: "array", maxItems: MAX_IMAGES, items: imageUrl } } },
};
export const directUploadSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["contentType", "size"],
    properties: {
      fileName: str(200),
      contentType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
      size: { type: "integer", minimum: 1, maximum: 10 * 1024 * 1024 },
    },
  },
};
export const signUrlsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["urls"],
    properties: { urls: { type: "array", minItems: 1, maxItems: 100, items: imageUrl } },
  },
};

// --- Categories & brands (same shape) -------------------------------------------------------

const taxonomyFields = {
  name: str(60, { minLength: 2 }),
  slug: str(80, { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
  description: str(300),
  status: { type: "string", enum: STATUSES },
  sortOrder: { type: "integer", minimum: 0, maximum: 100_000 },
};
const taxonomyIdParams = { type: "object", required: ["id"], properties: { id: objectId } };

export const taxonomyListSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: str(60),
      status: { type: "string", enum: STATUSES },
      sort: { type: "string", enum: ["sort_order", "name_asc", "name_desc", "newest", "oldest"] },
      page: { type: "integer", minimum: 1, maximum: 10_000, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
};
export const taxonomyCreateSchema = {
  body: { type: "object", additionalProperties: false, required: ["name"], properties: taxonomyFields },
};
export const taxonomyUpdateSchema = {
  params: taxonomyIdParams,
  body: { type: "object", additionalProperties: false, minProperties: 1, properties: taxonomyFields },
};
export const taxonomyIdSchema = { params: taxonomyIdParams };
