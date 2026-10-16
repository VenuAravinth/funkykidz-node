import * as InventoryService from "../services/inventory.service.js";

export async function updatePricing(req) {
  return { product: await InventoryService.updatePricing(req.params.id, req.body, req.log) };
}

export async function getStock(req) {
  return { stock: await InventoryService.getStock(req.params.id) };
}

export async function adjustStock(req) {
  return { stock: await InventoryService.adjustStock(req.params.id, req.body, req.actor, req.log) };
}

export async function history(req) {
  return { movements: await InventoryService.stockHistory(req.params.id, req.query.limit) };
}
