import * as VariantService from "../services/variant.service.js";

export async function list(req) {
  return { variants: await VariantService.listVariants(req.params.id) };
}

export async function add(req, reply) {
  return reply.code(201).send(await VariantService.addVariant(req.params.id, req.body, req.log));
}

export async function update(req) {
  return VariantService.updateVariant(req.params.id, req.params.variantId, req.body, req.log);
}

export async function remove(req) {
  return VariantService.deleteVariant(req.params.id, req.params.variantId, req.log);
}
