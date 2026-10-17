import { assertConfig } from "./config/env.js";
import { connectDatabase } from "./config/database.js";
import { buildApp } from "./app.js";
import { ensureProductIndexes } from "./models/product.model.js";
import { ensureStockMovementIndexes } from "./models/stockMovement.model.js";
import { Category } from "./models/category.model.js";
import { Brand } from "./models/brand.model.js";
import { syncBarcodeCounter } from "./services/barcode.service.js";
import { backfillLegacyProducts } from "./services/productBarcode.service.js";
import { ensureUserIndexes } from "./models/user.model.js";
import { UserService } from "./services/user.service.js";

// Builds the app and gets the database ready. Shared by the long-running server (src/server.js)
// and the Vercel function (api/index.js), so both start up exactly the same way.

export async function createApp() {
  assertConfig();
  const app = buildApp();

  await connectDatabase(app.log);
  await Promise.all([ensureProductIndexes(), ensureStockMovementIndexes(), Category.ensureIndexes(), Brand.ensureIndexes(), ensureUserIndexes()]);
  await syncBarcodeCounter();
  await backfillLegacyProducts(app.log);
  await UserService.bootstrapAdmin(app.log);

  await app.ready();
  return app;
}
