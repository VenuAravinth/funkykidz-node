import { MongoClient } from "mongodb";
import { env } from "./env.js";

// One MongoClient (and one connection pool) per process. Every model asks for the Db through
// getDb(), so connection handling lives in exactly one place.

let client;
let db;

export async function connectDatabase(logger) {
  if (db) return db;
  client = new MongoClient(env.mongo.uri, {
    maxPoolSize: env.mongo.maxPoolSize,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    retryWrites: true,
    ignoreUndefined: true, // optional fields left undefined are simply not stored
    appName: "funkykidz-erp-backend",
  });
  await client.connect();
  // Same database as the website: name from MONGODB_DB, else from the connection string.
  db = client.db(env.mongo.dbName || undefined);
  logger?.info({ db: db.databaseName }, "MongoDB connected");
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not connected. Call connectDatabase() first.");
  return db;
}

export async function closeDatabase() {
  await client?.close();
  client = undefined;
  db = undefined;
}
