// Request validation for the public storefront API.

const str = (max, extra = {}) => ({ type: "string", maxLength: max, ...extra });
const money = { type: "number", minimum: 0, maximum: 10_000_000 };

export const publicProductsSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: str(100),
      category: str(300),
      categoryId: str(500),
      brandId: str(500),
      gender: str(100),
      size: str(300),
      minPrice: money,
      maxPrice: money,
      tag: { type: "string", enum: ["Bestseller", "New"] },
      inStock: { type: "boolean" },
      sort: { type: "string", enum: ["newest", "price-asc", "price-desc", "popular"] },
      page: { type: "integer", minimum: 1, maximum: 10_000 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
};

export const publicSlugSchema = {
  params: { type: "object", required: ["slug"], properties: { slug: str(120, { pattern: "^[a-z0-9-]+$" }) } },
};

export const publicImageSchema = {
  params: { type: "object", required: ["file"], properties: { file: str(100, { pattern: "^[A-Za-z0-9_-]{8,80}\\.(jpg|png|webp)$" }) } },
};
