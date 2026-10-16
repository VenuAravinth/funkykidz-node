import * as Ai from "../controllers/ai.controller.js";
import * as S from "../schemas/ai.schema.js";

// /api/v1/ai — Gemini-powered helpers for the product form (admin API key required).
export default async function aiRoutes(app) {
  app.get("/status", Ai.status);
  app.post("/product-details", { schema: S.analyzeSchema }, Ai.analyze);
}
