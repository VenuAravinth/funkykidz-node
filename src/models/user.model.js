import { ObjectId } from "mongodb";
import { getDb } from "../config/database.js";
import { NAME_COLLATION } from "./taxonomy.model.js";

// ERP Admin Portal login accounts (`erp_users` collection — the website's `users` are shop customers).
//   { _id, username, email, passwordHash, roleId, staffId, status: "active" | "inactive",
//     sessionVersion,                       // bumped to sign the user out everywhere
//     loginFailures: { count, lockedUntil }, // wrong-password lockout
//     mfa: { secret, pendingSecret, lastStep, failures: { count, resetAt } },
//     emailOtp: { purpose, hash, expiresAt, sentAt, attempts } | null,
//     lastLoginAt, lastPasswordResetAt, createdAt, updatedAt }
// passwordHash, loginFailures, mfa and emailOtp never leave this server through the user API;
// only the sign-in endpoints (/users/:id/auth) return mfa and emailOtp to the portal's server.

export const USER_STATUSES = ["active", "inactive"];
export const ADMIN_ROLE_ID = "role_administrator";

const users = () => getDb().collection("erp_users");

export async function ensureUserIndexes() {
  await users().createIndexes([
    { key: { email: 1 }, name: "email_unique", unique: true },
    { key: { username: 1 }, name: "username_unique_ci", unique: true, collation: NAME_COLLATION },
    { key: { status: 1, roleId: 1 }, name: "status_role" },
  ]);
}

export const collection = users;
export const findById = (id, options) => (ObjectId.isValid(id) && String(id).length === 24 ? users().findOne({ _id: new ObjectId(id) }, options) : null);
export const findOne = (filter, options) => users().findOne(filter, options);
export const find = (filter, { projection, sort, skip = 0, limit = 0 } = {}) =>
  users().find(filter, { projection, sort, skip, limit, collation: NAME_COLLATION }).toArray();
export const count = (filter) => users().countDocuments(filter);
export const insertOne = (doc) => users().insertOne(doc);
export const updateById = (id, update) => users().findOneAndUpdate({ _id: id }, update, { returnDocument: "after" });

/** API shape: `id` instead of `_id`, secrets removed. */
export function toApi(doc) {
  if (!doc) return null;
  const { _id, passwordHash: _p, loginFailures: _l, mfa, emailOtp: _e, sessionVersion: _s, ...rest } = doc;
  return { id: _id.toHexString(), ...rest, mfaEnabled: Boolean(mfa?.secret) };
}
