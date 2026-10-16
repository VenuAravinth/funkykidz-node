import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import { env } from "./config/env.js";
import { getHealth, getLiveness } from "./services/health.service.js";
import apiV1 from "./routes/index.js";
import { AppError } from "./utils/errors.js";
import { MAX_IMAGE_BYTES } from "./services/image.service.js";
import { MAX_IMAGES } from "./models/product.model.js";

export function buildApp() {
  const app = Fastify({
    logger: {
      level: env.logLevel,
      redact: ["req.headers.authorization", 'req.headers["x-api-key"]'],
    },
    bodyLimit: 1024 * 1024, // JSON bodies; image uploads have their own limit below
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: true, coerceTypes: "array", useDefaults: true, allErrors: true } },
  });

  // Many HTTP clients send "Content-Type: application/json" with no body on POST/DELETE
  // (e.g. /publish). Treat that as "no body" instead of rejecting it.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || !body.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch {
      done(new AppError(400, "INVALID_JSON", "The request body isn't valid JSON."));
    }
  });

  app.register(helmet, { global: true });
  app.register(cors, {
    origin: env.corsOrigins.length ? env.corsOrigins : false,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-erp-user"],
    maxAge: 600,
  });
  app.register(compress, { threshold: 1024 }); // gzip/brotli list responses
  app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES, fields: 10 } });

  // Health checks (no API key): /health = full report incl. database (503 when it's down);
  // /health/live = the process is up (for liveness probes that must not depend on the database).
  app.get("/health", async (_req, reply) => {
    const { httpStatus, body } = await getHealth();
    return reply.code(httpStatus).header("Cache-Control", "no-store").send(body);
  });
  app.get("/health/live", async (_req, reply) => reply.header("Cache-Control", "no-store").send(getLiveness()));

  app.register(apiV1, { prefix: "/api/v1" });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.url}` } }));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Some fields are missing or invalid.",
          details: err.validation.map((v) => ({ field: v.instancePath || v.params?.missingProperty || "", message: v.message })),
        },
      });
    }
    // Errors from Fastify plugins (bad JSON, file too large, not multipart…) carry their status.
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
    }
    req.log.error({ err }, "Unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
  });

  return app;
}
