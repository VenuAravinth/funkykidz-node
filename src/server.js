import { env } from "./config/env.js";
import { closeDatabase } from "./config/database.js";
import { createApp } from "./bootstrap.js";

async function main() {
  const app = await createApp();

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
