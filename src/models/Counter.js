import mongoose from "mongoose";

/** Atomic named counters (used for gap-free invoice numbers). */
const CounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model("Counter", CounterSchema);

/**
 * Pass `session` to allocate inside the caller's transaction: if that transaction
 * aborts, the increment rolls back too, so no number is ever burned (gap-free).
 */
export async function nextSequence(key, session = null) {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) },
  );
  return doc.seq;
}

export default Counter;
