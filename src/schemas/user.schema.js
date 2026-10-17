import { USER_STATUSES } from "../models/user.model.js";

// Request validation for /api/v1/users (Fastify/Ajv). Unknown fields are dropped.

const str = (max, extra = {}) => ({ type: "string", maxLength: max, ...extra });
const objectId = str(24, { pattern: "^[0-9a-f]{24}$" });
const timestamp = { type: "integer", minimum: 0 };

const username = str(30, { minLength: 3, pattern: "^[A-Za-z0-9._]+$" });
const email = str(254, { minLength: 3, format: "email" });
const password = str(72, { minLength: 8 });
const roleId = str(60, { minLength: 1, pattern: "^[A-Za-z0-9_-]+$" });
const staffId = str(60, { pattern: "^[A-Za-z0-9_-]*$" });

const idParams = { type: "object", required: ["id"], properties: { id: objectId } };

export const userListSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: str(60),
      status: { type: "string", enum: USER_STATUSES },
      roleId,
      sort: { type: "string", enum: ["username_asc", "newest", "last_login"] },
      page: { type: "integer", minimum: 1, maximum: 10_000, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
};

export const userCreateSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["username", "email", "password", "roleId"],
    properties: { username, email, password, roleId, staffId, status: { type: "string", enum: USER_STATUSES } },
  },
};

export const userUpdateSchema = {
  params: idParams,
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: { username, email, roleId, staffId, status: { type: "string", enum: USER_STATUSES } },
  },
};

export const userIdSchema = { params: idParams };

export const userPasswordSchema = {
  params: idParams,
  body: { type: "object", additionalProperties: false, required: ["password"], properties: { password } },
};

export const authenticateSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["email", "password"],
    properties: { email, password: str(72, { minLength: 1 }) },
  },
};

const emailOtp = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["purpose", "hash", "expiresAt", "sentAt", "attempts"],
  properties: {
    purpose: str(40, { minLength: 1 }),
    hash: str(200, { minLength: 1 }),
    expiresAt: timestamp,
    sentAt: timestamp,
    attempts: { type: "integer", minimum: 0, maximum: 100 },
  },
};

export const authUpdateSchema = {
  params: idParams,
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      mfa: {
        type: "object",
        additionalProperties: false,
        properties: {
          secret: { type: ["string", "null"], maxLength: 200 },
          pendingSecret: { type: ["string", "null"], maxLength: 200 },
          lastStep: { type: "integer", minimum: 0 },
          failures: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["count", "resetAt"],
            properties: { count: { type: "integer", minimum: 0, maximum: 1000 }, resetAt: timestamp },
          },
        },
      },
      emailOtp,
      recordLogin: { type: "boolean" },
    },
  },
};
