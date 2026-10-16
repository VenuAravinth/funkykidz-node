import { assertConfig, env } from "./config/env.js";
import { closeDatabase, connectDatabase } from "./config/database.js";
import { buildApp } from "./app.js";
import { ensureProductIndexes } from "./models/product.model.js";
import { ensureStockMovementIndexes } from "./models/stockMovement.model.js";
import { Category } from "./models/category.model.js";
import { Brand } from "./models/brand.model.js";
import { syncBarcodeCounter } from "./services/barcode.service.js";
import { backfillLegacyProducts } from "./services/productBarcode.service.js";

async function main() {
  assertConfig();
  const app = buildApp();

  await connectDatabase(app.log);
  await Promise.all([ensureProductIndexes(), ensureStockMovementIndexes(), Category.ensureIndexes(), Brand.ensureIndexes()]);
  await syncBarcodeCounter();
  await backfillLegacyProducts(app.log);

  await app.listen({ port: env.port, host: env.host });

  const shutdown = async (signal) => {
    app.log.info({ signal }, "Shutting down");
    try {
      await app.close(); // stop accepting requests, finish in-flight ones
      await closeDatabase();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
