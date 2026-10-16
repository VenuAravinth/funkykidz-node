# FunkyKidz ERP Backend

Product Management API for the FunkyKidz ERP Admin Portal. Built with Node.js, Fastify and MongoDB, structured as Controller → Service → Model.

It is the **only** place product, category and brand APIs live. The FunkyKidz website gets its catalogue from this server's public API (`/api/v1/public`). Publishing a product here makes it appear on the shop. Unpublishing removes it.

## Run

```bash
cp .env.example .env      # then fill in real values
npm install
npm run dev               # node --watch, reloads on save
npm start                 # production
```

Requires Node ≥ 20.6 and the website's MongoDB connection string in `MONGODB_URI`.

**At startup the server makes four changes to the database:**
- It creates its indexes.
- It moves the barcode counter past every existing barcode.
- It backfills products created before the ERP: SKU, barcodes, variants built from their sizes, `status`, and `published` (set to whatever is live now).
- Backfill only adds missing fields. Nothing the website shows changes.

## How the website stays in sync

| ERP field | Website effect |
|---|---|
| `published && status === "active"` → stored as `active` | The website lists only `active: true` products |
| `variants[].size` (active ones) → `sizes` | Sizes shown on the product page |
| `stock` (`{ size: units }`) | The single stock record; website checkout decrements it atomically |
| `color` / `colorHex` → `colorways[0]` | Swatch and fallback illustration |

- The website loads published products from this server's public API (see below) and caches them for up to 60 s.
- After every change the backend calls `WEBSITE_REVALIDATE_URL` (the website's `POST /api/revalidate`), so changes show at once. If that call fails, the website refreshes on its own within 60 s.
- The website's checkout still reserves stock directly in MongoDB, as an atomic per-size decrement. That's part of placing an order, not a product API.

## Public storefront API (used by the website)

The website has **no product, category or brand APIs of its own**. They exist only here.

- `/api/v1/public/*` is read-only and needs **no API key**. It only exposes published, active products, plus active categories and brands.
- It never exposes cost price, SKUs, barcodes, variants or anything unpublished.
- Responses come from an in-memory copy of the published catalogue. Every product, category or brand change made through this server clears it at once; otherwise it refreshes every 10 s (website orders also change stock).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/public/products` | No params → whole published catalogue (what the website loads). Filters: `q`, `category` (names), `categoryId`, `brandId`, `gender`, `size`, `minPrice`, `maxPrice`, `tag`, `inStock`. Sort: `sort` = `newest`, `price-asc`, `price-desc`, `popular`. Paging: `page`, `limit` (≤ 100) |
| GET | `/api/v1/public/products/:slug` | One published product |
| GET | `/api/v1/public/categories` | Active categories with their published product count |
| GET | `/api/v1/public/brands` | Active brands with their published product count |
| GET | `/api/v1/public/product-images/:file` | 302 to a freshly signed R2 URL (≤ 20 min). Only for images of published products |

Product `images` in public responses are absolute links to that image route, built on `PUBLIC_BASE_URL`, which must be this server's address as browsers see it.

The website needs:
- `ERP_API_URL` pointing here;
- the same revalidation secret as this server.

It no longer holds any Cloudflare R2 credentials.

## Images (Cloudflare R2)

- Images go into the private R2 bucket (`CLOUDFLARE_R2_BUCKET_NAME`), in the folder `CLOUDFLARE_R2_IMAGE_FOLDER` (default `products`), as `<folder>/<random id>.<ext>`.
- MongoDB stores only the **permanent object URL**, `https://<account>.r2.cloudflarestorage.com/<bucket>/products/<file>`. Opening that URL directly is refused (the bucket is private).
- Every API response adds `imageUrls`: presigned URLs generated on the fly, valid ≤ 20 minutes, plus `imageUrlsExpireAt`.
- Website pages reference this server's `/api/v1/public/product-images/<file>`. That route presigns a fresh URL on every request and redirects to it, so cached pages never contain an expired link. It only does this for images of published products.
- Signing times are rounded to 5-minute steps. Requests in the same window get the same URL, so browser and CDN caching keeps working.
- Signing uses AWS Signature V4 (`src/utils/sigv4.js`, Node crypto only, no SDK).

**Browser direct upload** (`POST /api/v1/images/direct-upload`) returns a presigned PUT URL. The file's type and exact size are part of the signature. Browsers can only use it once the bucket has a CORS rule allowing `PUT` from the ERP's origin. Server-side upload (`POST /api/v1/images`, multipart) needs no CORS.

## Health checks

No API key needed; responses are never cached.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Full report: `status` (`ok` / `down`), version, uptime, and `checks` for the server, the database (ping latency), image storage, AI and website sync. **200** when the database answers, **503** when it doesn't |
| GET | `/health/live` | The process is up (no dependency checks) — for liveness probes |

The website has its own `GET /api/health`: its MongoDB connection plus this backend (`ok` 200, or 503 with `down` / `degraded`).

## Auth

Every `/api/v1` route needs an API key from `ERP_API_KEYS`:

- Send it as `Authorization: Bearer <key>` (or `x-api-key`).
- Call this API from the ERP portal's **server**. Never put the key in browser code.
- Optionally send `x-erp-user: <admin email>`. It is recorded on stock movement audit entries.

## Endpoints

`:id` accepts a MongoDB id or a product slug. Errors look like `{ "error": { "code", "message", "details?" } }`.

### Products
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/products` | List. Query params:<br>• search: `q`<br>• filters: `category`, `gender`, `size` (comma lists), `status`, `published`, `tag`, `brand`, `minPrice`, `maxPrice`, `inStock`, `lowStock`, `hasImages`<br>• sorting: `sort` = `newest`, `oldest`, `updated`, `price_asc`, `price_desc`, `name_asc`, `name_desc`, `popularity`<br>• paging: `page`, `limit` (≤ 100) |
| GET | `/api/v1/products/form-options` | Active categories and brands for the product form |
| GET | `/api/v1/products/search?q=` | Typeahead or POS scan (name words, SKU, barcode); small payload |
| POST | `/api/v1/products` | Create (see body below) |
| GET | `/api/v1/products/:id` | Details |
| PATCH | `/api/v1/products/:id` | Partial update. `variants`, if sent, is the full list (rows with `id` keep their barcode) |
| DELETE | `/api/v1/products/:id` | Also deletes its images from R2 |
| POST | `/api/v1/products/:id/publish` · `/unpublish` | Show on / hide from the website |
| POST | `/api/v1/products/bulk/publish` | `{ ids: [], published: true }` |
| POST | `/api/v1/products/maintenance/backfill` | Re-run the pre-ERP backfill |

### Categories & brands
`/api/v1/categories` and `/api/v1/brands` have the same endpoints:

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List with `productCount`. Query params: `q`, `status`, `sort` (`sort_order`, `name_asc`, `name_desc`, `newest`, `oldest`), `page`, `limit` (≤ 200) |
| GET | `/options` | Active entries only, `{ id, name, slug }`, for the product form's dropdown |
| POST | `/` | `{ name, slug?, description?, status?, sortOrder? }`. Names are unique, ignoring case |
| GET | `/:id` | Details with `productCount` |
| PATCH | `/:id` | Any field above. A rename is copied to every product using it |
| DELETE | `/:id` | Refused (409, with `productCount`) while products use it. Set it to `inactive` instead |

`GET /api/v1/products/form-options` returns `{ categories, brands }`: both active lists in one request.

How categories and brands work with products:
- Products are created with `categoryId` (required) and `brandId` (optional).
- Only **active** entries are accepted for a new assignment. A product keeps its category or brand if that entry is deactivated later.
- `brandId: null` removes the brand from a product.
- Products also store the name (`category` / `brand`), because the website reads that. Renames update every product that uses the entry.
- Creating a category or brand links existing products that already carry that name. For example, creating "Dresses" links the website's original dresses.
- The product list can be filtered by `categoryId` and `brandId` (comma-separated ids).

### Sizes / variants
| Method | Path |
|---|---|
| GET / POST | `/api/v1/products/:id/variants` |
| PATCH / DELETE | `/api/v1/products/:id/variants/:variantId` |

### Pricing & stock
| Method | Path | Body |
|---|---|---|
| PATCH | `/api/v1/products/:id/pricing` | `{ price?, oldPrice?, costPrice?, variants?: [{ id, price \| null }] }` |
| GET | `/api/v1/products/:id/stock` | |
| POST | `/api/v1/products/:id/stock/adjust` | `{ reason?, note?, adjustments: [{ size \| variantId, delta \| set }] }`. Atomic: either every line applies or none, and stock never goes negative |
| GET | `/api/v1/products/:id/stock/history` | Audit trail |

### Barcodes (internal EAN-13, prefix `20`; numbers are never reused)
| Method | Path |
|---|---|
| GET | `/api/v1/products/barcode/:code` (barcode or SKU → product + variant) |
| GET | `/api/v1/products/:id/barcodes` (label rows for printing) |
| POST | `/api/v1/products/:id/barcodes/regenerate` `{ scope: "all" \| "product" \| "variant", variantId? }` |

### Images
| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/images` | Multipart (`file`, repeatable). Uploads to R2; returns object URLs for a create/update body |
| POST | `/api/v1/images/direct-upload` | `{ contentType, size, fileName? }` → presigned PUT so the browser uploads straight to R2 |
| POST | `/api/v1/images/sign` | `{ urls }` → `{ signedUrls: { original: signed }, expiresAt }` |
| POST | `/api/v1/products/:id/images` | Multipart upload added to the product |
| PUT | `/api/v1/products/:id/images` | `{ images }`: new order (first image = main photo) |
| DELETE | `/api/v1/products/:id/images` | `{ url }` |

### AI (Google Gemini)

Drafts product details for the product form from an uploaded photo; nothing is saved to a product until the form is saved. Configure with `GEMINI_API_KEY`, `GEMINI_ANALYSIS_MODELS`, `GEMINI_TIMEOUT_MS` (see `.env.example`).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/ai/status` | Whether AI is configured and which models are used |
| POST | `/api/v1/ai/product-details` | `{ imageUrl, hints? }` (an uploaded R2 photo) → `{ model, suggestions, needsReview }`: name, descriptions, category, gender, colour, fabric/fit/care (blank when not visible) and `attributes` |

Errors: `402 AI_BILLING_REQUIRED`, `429 AI_RATE_LIMITED` (`details.retryAfterSeconds`), `503 AI_UNAVAILABLE`, `504 AI_TIMEOUT`, `422 AI_BLOCKED`, `409` while the same photo is already being processed.

Products also accept `attributes` (`productType`, `pattern`, `neckType`, `sleeveType`, `ageGroup`, `occasion`).

### Create body
```json
{
  "name": "Rose Party Frock",
  "categoryId": "<id from /api/v1/categories/options>",
  "brandId": "<id from /api/v1/brands/options>",
  "gender": "Girls",
  "color": "Rose",
  "price": 999,
  "oldPrice": 1299,
  "costPrice": 400,
  "reorderLevel": 5,
  "tag": "New",
  "description": "Soft tulle frock",
  "images": ["https://<account>.r2.cloudflarestorage.com/funkykidz/products/<file>.jpg"],
  "variants": [{ "size": "2-3Y", "stock": 4 }, { "size": "3-4Y", "stock": 2 }],
  "published": true
}
```

Field rules:
- `categoryId` (required) and `brandId` (optional): must be **active** entries.
- `gender`: one of `Girls`, `Boys`, `Unisex`.
- **Generated if omitted:** `sku`, `slug`, and each variant's `sku`.
- **Always generated:** barcodes.
- **Fixed after creation:** `slug`, because website carts and orders refer to it.
- **Sizes:** each size may appear once per product, because website stock is kept per size.

## Structure

```
src/
  server.js            boot: config check, DB, indexes, backfill, listen, graceful shutdown
  app.js               Fastify instance, plugins, error handling
  config/              env.js, database.js (one shared connection pool)
  routes/              URL → controller (+ JSON schema)
  controllers/         HTTP in/out only
  services/            business rules (product, variant, inventory, barcode, image, cloudflare R2, website sync)
  models/              MongoDB collections (products, categories, brands, counters, stock movements), indexes, data access
  schemas/             request validation
  middlewares/auth.js  API key check
  utils/               errors, EAN-13, slugs/search tokens, SigV4 presigning
```

## Performance notes

- **Indexes:** unique on slug, SKU, barcode, variant SKU and variant barcode; compound indexes for list filters.
- **Search:** uses an indexed `searchTokens` array, so prefix matches never scan the whole collection.
- **List queries:** each page and its total count run in parallel; long text fields are left out of list results.
- **Updates:** writes send only changed fields. A version check (`rev`) catches concurrent edits.
- **Atomic counters and stock:** barcode allocation and stock changes are single atomic MongoDB operations.
- **HTTP:** responses are gzip/brotli-compressed, requests are validated by precompiled JSON schemas, and all requests share one connection pool.
