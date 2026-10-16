import { getDb } from "../config/database.js";

// Monotonic sequences (e.g. barcode numbers). A single atomic $inc per allocation means two
// admins saving at the same moment can never receive the same number.

const counters = () => getDb().collection("counters");

/** Reserves `count` consecutive numbers and returns the first one. */
export async function allocate(name, count = 1) {
  const doc = await counters().findOneAndUpdate(
    { _id: name },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: "after" },
  );
  return doc.seq - count + 1;
}

/** Moves the counter forward to at least `value` (never backwards). */
export async function ensureAtLeast(name, value) {
  await counters().updateOne({ _id: name }, { $max: { seq: value } }, { upsert: true });
}
