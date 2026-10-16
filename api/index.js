import { createApp } from "../src/bootstrap.js";

// Vercel entry point. vercel.json rewrites every path here; Fastify then routes it as usual.
// The app (and its MongoDB pool) is built once per warm instance and reused across requests.

let ready;

export default async function handler(req, res) {
  ready ??= createApp().catch((err) => {
    ready = undefined; // let the next request retry instead of caching the failure
    throw err;
  });
  const app = await ready;
  app.server.emit("request", req, res);
}
