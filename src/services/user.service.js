import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as User from "../models/user.model.js";
import { ADMIN_ROLE_ID } from "../models/user.model.js";
import { env } from "../config/env.js";
import { escapeRegex } from "../utils/text.js";
import { AppError, conflict, notFound } from "../utils/errors.js";

// ERP Admin Portal accounts. This server owns the records and password hashing; the portal's
// server runs the sign-in steps (session cookie, email codes, authenticator) and keeps their
// state here through getAuth/updateAuth, so sign-in works across restarts and server instances.

const scrypt = promisify(scryptCb);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const SORTS = {
  username_asc: { username: 1, _id: 1 },
  newest: { createdAt: -1, _id: -1 },
  last_login: { lastLoginAt: -1, _id: -1 },
};

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// Used when the email is unknown, so a wrong email takes as long as a wrong password.
let dummyHash;

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, SCRYPT_PARAMS);
  return timingSafeEqual(actual, expected);
}

function duplicate(err) {
  if (err?.code !== 11000) return null;
  return err.keyPattern?.email
    ? conflict("Another user already has this email address.", { field: "email" })
    : conflict("This username is already taken.", { field: "username" });
}

async function requireDoc(id) {
  const doc = await User.findById(id);
  if (!doc) throw notFound("User not found.");
  return doc;
}

/** Refuses a change that would leave nobody able to manage users. */
async function assertKeepsAnAdmin(doc, next) {
  const isActiveAdmin = (u) => u.status === "active" && u.roleId === ADMIN_ROLE_ID;
  if (!isActiveAdmin(doc) || isActiveAdmin({ ...doc, ...next })) return;
  const others = await User.count({ _id: { $ne: doc._id }, status: "active", roleId: ADMIN_ROLE_ID });
  if (!others) throw conflict("This is the last active administrator. Make another user an administrator first.");
}

const authState = (doc) => ({ sessionVersion: doc.sessionVersion ?? 0, mfa: doc.mfa ?? {}, emailOtp: doc.emailOtp ?? null });

export const UserService = {
  async list(q) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const filter = {};
    if (q.status) filter.status = q.status;
    if (q.roleId) filter.roleId = q.roleId;
    if (q.q) {
      const re = new RegExp(escapeRegex(q.q.trim()), "i");
      filter.$or = [{ username: re }, { email: re }];
    }
    const [docs, total] = await Promise.all([
      User.find(filter, { sort: SORTS[q.sort] ?? SORTS.username_asc, skip: (page - 1) * limit, limit }),
      User.count(filter),
    ]);
    return { items: docs.map(User.toApi), page, limit, total, totalPages: Math.ceil(total / limit) };
  },

  async get(id) {
    return User.toApi(await requireDoc(id));
  },

  async create(input) {
    const now = new Date();
    const doc = {
      username: input.username,
      email: input.email.trim().toLowerCase(),
      passwordHash: await hashPassword(input.password),
      roleId: input.roleId,
      staffId: input.staffId || undefined,
      status: input.status ?? "active",
      sessionVersion: 0,
      mfa: {},
      emailOtp: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const { insertedId } = await User.insertOne(doc);
      return User.toApi({ ...doc, _id: insertedId });
    } catch (err) {
      throw duplicate(err) ?? err;
    }
  },

  async update(id, input) {
    const doc = await requireDoc(id);
    if (input.email) input = { ...input, email: input.email.trim().toLowerCase() };
    await assertKeepsAnAdmin(doc, input);
    const $set = { ...input, updatedAt: new Date() };
    const $unset = {};
    if ("staffId" in input && !input.staffId) {
      delete $set.staffId;
      $unset.staffId = "";
    }
    // A deactivated account, a new role or a new email takes effect at once: existing sessions end.
    const signOut = (input.status === "inactive" && doc.status !== "inactive") || (input.roleId && input.roleId !== doc.roleId) || (input.email && input.email !== doc.email);
    try {
      const updated = await User.updateById(doc._id, { $set, ...(Object.keys($unset).length && { $unset }), ...(signOut && { $inc: { sessionVersion: 1 } }) });
      return User.toApi(updated);
    } catch (err) {
      throw duplicate(err) ?? err;
    }
  },

  async setPassword(id, password) {
    const doc = await requireDoc(id);
    const now = new Date();
    const updated = await User.updateById(doc._id, {
      $set: { passwordHash: await hashPassword(password), lastPasswordResetAt: now, updatedAt: now, emailOtp: null },
      $unset: { loginFailures: "" },
      $inc: { sessionVersion: 1 },
    });
    return User.toApi(updated);
  },

  async signOutEverywhere(id) {
    const doc = await requireDoc(id);
    return User.toApi(await User.updateById(doc._id, { $inc: { sessionVersion: 1 } }));
  },

  /** Email + password check for the portal's sign-in. Locks the account briefly after repeated failures. */
  async authenticate({ email, password }) {
    const doc = await User.findOne({ email: email.trim().toLowerCase() });
    if (!doc) {
      dummyHash ??= await hashPassword(randomBytes(16).toString("hex"));
      await verifyPassword(password, dummyHash);
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }

    const lockedUntil = doc.loginFailures?.lockedUntil;
    if (lockedUntil && lockedUntil > new Date()) {
      const minutes = Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000);
      throw new AppError(429, "LOCKED", `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }

    if (!(await verifyPassword(password, doc.passwordHash))) {
      const failures = (lockedUntil ? 0 : doc.loginFailures?.count ?? 0) + 1;
      await User.updateById(doc._id, {
        $set: { loginFailures: { count: failures, lockedUntil: failures >= MAX_LOGIN_FAILURES ? new Date(Date.now() + LOGIN_LOCK_MS) : null } },
      });
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }

    if (doc.status !== "active") throw new AppError(403, "ACCOUNT_DISABLED", "This account has been deactivated. Contact your administrator.");
    if (doc.loginFailures) await User.updateById(doc._id, { $unset: { loginFailures: "" } });
    return { user: User.toApi(doc), auth: authState(doc) };
  },

  async getAuth(id) {
    const doc = await requireDoc(id);
    return { user: User.toApi(doc), auth: authState(doc) };
  },

  /** Saves sign-in progress: authenticator fields, the pending email code, and the login time. */
  async updateAuth(id, { mfa, emailOtp, recordLogin }) {
    const doc = await requireDoc(id);
    const $set = {};
    for (const [key, value] of Object.entries(mfa ?? {})) $set[`mfa.${key}`] = value;
    if (emailOtp !== undefined) $set.emailOtp = emailOtp;
    if (recordLogin) $set.lastLoginAt = new Date();
    if (!Object.keys($set).length) return { user: User.toApi(doc), auth: authState(doc) };
    const updated = await User.updateById(doc._id, { $set });
    return { user: User.toApi(updated), auth: authState(updated) };
  },

  /** First start: with no accounts yet, creates the administrator from ERP_ADMIN_EMAIL / ERP_ADMIN_PASSWORD. */
  async bootstrapAdmin(log) {
    if (await User.count({})) return;
    const { email, password } = env.erpAdmin;
    if (!email || !password) {
      log.warn("No ERP users exist yet. Set ERP_ADMIN_EMAIL and ERP_ADMIN_PASSWORD to create the first administrator.");
      return;
    }
    const username = email.split("@")[0].replace(/[^a-z0-9._]/gi, "").slice(0, 30).padEnd(3, "0");
    try {
      await this.create({ username, email, password, roleId: ADMIN_ROLE_ID, status: "active" });
      log.info({ email }, "Created the first ERP administrator");
    } catch (err) {
      // Another instance started at the same moment and created it first.
      if (err?.statusCode !== 409) throw err;
    }
  },
};
