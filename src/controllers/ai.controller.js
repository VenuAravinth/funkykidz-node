import * as ProductAi from "../services/productAi.service.js";

export async function status() {
  return ProductAi.status();
}

export async function analyze(req) {
  return ProductAi.analyzeProductImage(req.body, req.log);
}
