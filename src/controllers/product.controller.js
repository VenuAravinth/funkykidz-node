import * as ProductService from "../services/product.service.js";
import { backfillLegacyProducts } from "../services/productBarcode.service.js";
import { CategoryService } from "../services/category.service.js";
import { BrandService } from "../services/brand.service.js";

// HTTP ⇄ service. Controllers only read the request, call one service, and shape the reply.

export async function create(req, reply) {
  const product = await ProductService.createProduct(req.body, req.log);
  return reply.code(201).send({ product });
}

export async function list(req) {
  return ProductService.listProducts(req.query);
}

export async function search(req) {
  return { items: await ProductService.searchProducts(req.query.q, req.query.limit) };
}

export async function get(req) {
  return { product: await ProductService.getProduct(req.params.id) };
}

export async function update(req) {
  return { product: await ProductService.updateProduct(req.params.id, req.body, req.log) };
}

export async function remove(req) {
  return ProductService.deleteProduct(req.params.id, req.log);
}

export async function publish(req) {
  return { product: await ProductService.setPublished(req.params.id, true, req.log) };
}

export async function unpublish(req) {
  return { product: await ProductService.setPublished(req.params.id, false, req.log) };
}

export async function bulkPublish(req) {
  return ProductService.bulkSetPublished(req.body.ids, req.body.published, req.log);
}

export async function backfill(req) {
  return backfillLegacyProducts(req.log);
}

/** Everything the product form's dropdowns need, in one request (active entries only). */
export async function formOptions() {
  const [categories, brands] = await Promise.all([CategoryService.options(), BrandService.options()]);
  return { categories, brands };
}
