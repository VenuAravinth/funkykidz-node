import { readFileSync } from "node:fs";
import { env } from "../config/env.js";
import { getDb } from "../config/database.js";
import * as Cloudflare from "./cloudflare.service.js";
import * as Gemini from "./gemini.service.js";

// Health report for uptime monitors, load balancers and people. The database is the only hard
// dependency: if it doesn't answer, the service is "down" (HTTP 503). Optional integrations are
// reported as configured or not, never with hosts, URLs or keys.

const SERVICE = "funkykidz-erp-backend";
const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const DB_TIMEOUT_MS = 3000;

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms).unref())]);

async function checkDatabase() {
  const started = performance.now();
  try {
    const db = getDb();
    await withTimeout(db.command({ ping: 1 }), DB_TIMEOUT_MS);
    return { status: "up", database: db.databaseName, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    // Driver messages can contain host names, so only a short, safe reason goes out.
    const reason = err?.name === "TimeoutError" ? `No answer within ${DB_TIMEOUT_MS / 1000}s` : /not connected/i.test(err?.message) ? "Not connected" : "Ping failed";
    return { status: "down", error: reason, latencyMs: Math.round(performance.now() - started) };
  }
}

const configured = (ok) => ({ status: ok ? "configured" : "not_configured" });

/** Full report: { status, checks, … } and the HTTP status code to send it with. */
export async function getHealth() {
  const database = await checkDatabase();
  const ok = database.status === "up";
  const mem = process.memoryUsage();
  return {
    httpStatus: ok ? 200 : 503,
    body: {
      status: ok ? "ok" : "down",
      service: SERVICE,
      version: VERSION,
      environment: env.isProduction ? "production" : "development",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        server: { status: "up", node: process.version, memoryMb: Math.round(mem.rss / 1048576) },
        database,
        imageStorage: configured(Cloudflare.isConfigured()),
        ai: configured(Gemini.isConfigured()),
        websiteSync: configured(Boolean(env.website.revalidateUrl && env.website.revalidateSecret)),
      },
    },
  };
}

/** Liveness only: the process is running and answering. No dependencies checked. */
export function getLiveness() {
  return { status: "ok", service: SERVICE, version: VERSION, timestamp: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()) };
}
