import Booking from "../models/Booking.js";
import Hotel from "../models/Hotel.js";
import { getRazorpayClient } from "../services/payment.service.js";
import { confirmPaidBooking } from "../services/paymentConfirmation.service.js";

/**
 * Payment reconciliation: the safety net for the money path.
 *
 * The Razorpay webhook is the normal way a booking becomes CONFIRMED. If a hotel
 * misconfigured its webhook, the webhook secret is wrong, or Razorpay / our server
 * was down when it fired, a guest can pay while the booking sits in HELD or
 * EXPIRED. This job asks Razorpay directly: "did this order receive a payment?"
 *
 *   captured payment found -> confirmPaidBooking(), the same code the webhook runs:
 *                              HELD     -> CONFIRMED
 *                              EXPIRED  -> CONFIRMED (rooms re-held) or full refund
 *                                          (rooms resold) -> EXPIRED_REFUNDED
 *   nothing captured       -> leave as is, re-check later (backed off)
 *
 * Safe to run repeatedly and alongside the webhook: every transition is an atomic
 * compare-and-set and refunds are idempotent.
 */

const MIN_HELD_AGE_MS = 3 * 60 * 1000; // let the normal webhook win the race first
const FAST_WINDOW_MS = 2 * 60 * 60 * 1000; // first 2h: re-check every FAST_RECHECK
const FAST_RECHECK_MS = 10 * 60 * 1000;
const SLOW_RECHECK_MS = 60 * 60 * 1000; // after that: hourly
const LOOKBACK_MS = Number(process.env.RECONCILE_LOOKBACK_HOURS || 72) * 60 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * Finds the payment on an order that actually collected money.
 * Razorpay payment statuses: created, authorized, captured, refunded, failed.
 * `refunded` here means the money came in and was returned, so we skip it.
 */
export function pickCapturedPayment(payments = []) {
  const captured = payments.filter((p) => p.status === "captured");
  if (captured.length === 0) return null;
  // If a guest somehow paid twice, the earliest capture is the one we keep.
  return captured.sort((a, b) => (a.created_at || 0) - (b.created_at || 0))[0];
}

async function markChecked(bookingId, { error = null, needsManualReview } = {}) {
  const set = {
    "reconciliation.lastCheckedAt": new Date(),
    "reconciliation.lastError": error,
  };
  if (typeof needsManualReview === "boolean") {
    set["reconciliation.needsManualReview"] = needsManualReview;
  }
  await Booking.updateOne(
    { _id: bookingId },
    { $set: set, $inc: { "reconciliation.checkCount": 1 } },
  );
}

/**
 * Checks one booking against Razorpay. Returns one of:
 * "confirmed" | "refunded" | "no_payment" | "settled_elsewhere" | "error"
 */
export async function reconcileBooking(booking, { hotelCache = new Map() } = {}) {
  try {
    let hotel = hotelCache.get(String(booking.hotelId));
    if (hotel === undefined) {
      hotel = await Hotel.findById(booking.hotelId);
      hotelCache.set(String(booking.hotelId), hotel);
    }
    if (!hotel) throw new Error("Hotel not found for booking.");

    // Use the mode stored on the booking, never the hotel's current mode.
    const rzp = getRazorpayClient(hotel, booking.payment.mode);
    const result = await rzp.orders.fetchPayments(booking.payment.razorpayOrderId);
    const payment = pickCapturedPayment(result?.items);

    if (!payment) {
      await markChecked(booking._id);
      return "no_payment";
    }

    console.warn(
      `[Reconcile] ${booking.bookingCode} is ${booking.status} but Razorpay has captured ${payment.id}; settling.`,
    );

    const confirmed = await confirmPaidBooking({
      booking,
      paymentId: payment.id,
      signature: null,
    });

    // Re-read to learn what happened (confirmPaidBooking returns null for both
    // "refunded because rooms were resold" and "someone else already settled it").
    const fresh = await Booking.findById(booking._id).select("status").lean();

    if (confirmed || fresh?.status === "CONFIRMED") {
      await markChecked(booking._id, { needsManualReview: false });
      return "confirmed";
    }
    if (fresh?.status === "EXPIRED_REFUNDED") {
      await markChecked(booking._id, { needsManualReview: false });
      return "refunded";
    }
    if (["CANCELLED", "CHECKED_IN", "COMPLETED"].includes(fresh?.status)) {
      return "settled_elsewhere";
    }

    // Money received but still not settled (e.g. no inventory AND refund not possible).
    await markChecked(booking._id, {
      error: `Payment ${payment.id} captured but booking is still ${fresh?.status}.`,
      needsManualReview: true,
    });
    console.error(
      `[CRITICAL][Reconcile] ${booking.bookingCode}: payment ${payment.id} captured but booking is ${fresh?.status}. Manual review required.`,
    );
    return "error";
  } catch (err) {
    console.error(`[Reconcile] ${booking.bookingCode} failed:`, err?.message || err);
    await markChecked(booking._id, { error: String(err?.message || err).slice(0, 300) }).catch(
      () => {},
    );
    return "error";
  }
}

/**
 * One reconciliation pass. Returns a summary so callers and tests can see what happened.
 */
export async function reconcilePayments() {
  const summary = {
    checked: 0,
    confirmed: 0,
    refunded: 0,
    no_payment: 0,
    settled_elsewhere: 0,
    error: 0,
  };

  try {
    const now = Date.now();
    const heldBefore = new Date(now - MIN_HELD_AGE_MS);
    const lookbackFrom = new Date(now - LOOKBACK_MS);
    const fastCutoff = new Date(now - FAST_RECHECK_MS);
    const slowCutoff = new Date(now - SLOW_RECHECK_MS);
    const fastWindowStart = new Date(now - FAST_WINDOW_MS);

    // Recent bookings are re-checked often, older ones hourly, so a long Razorpay
    // outage is recovered quickly without hammering their API for stale holds.
    const recheckDue = {
      $or: [
        { "reconciliation.lastCheckedAt": null },
        { createdAt: { $gte: fastWindowStart }, "reconciliation.lastCheckedAt": { $lt: fastCutoff } },
        { createdAt: { $lt: fastWindowStart }, "reconciliation.lastCheckedAt": { $lt: slowCutoff } },
      ],
    };

    const candidates = await Booking.find({
      status: { $in: ["HELD", "EXPIRED"] },
      // PENDING_CREATION is the placeholder before the Razorpay order exists; nothing to look up yet.
      "payment.razorpayOrderId": { $exists: true, $nin: [null, "PENDING_CREATION"] },
      createdAt: { $gte: lookbackFrom },
      $and: [
        { $or: [{ status: "EXPIRED" }, { status: "HELD", createdAt: { $lt: heldBefore } }] },
        recheckDue,
      ],
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE);

    const hotelCache = new Map();
    for (const booking of candidates) {
      const outcome = await reconcileBooking(booking, { hotelCache });
      summary.checked += 1;
      summary[outcome] += 1;
    }

    if (summary.confirmed || summary.refunded || summary.error) {
      console.warn("[Reconcile] Pass summary:", JSON.stringify(summary));
    }
  } catch (err) {
    console.error("[Reconcile Job Error]:", err.message);
  }
  return summary;
}

let isRunning = false;

async function runReconciliation() {
  if (isRunning) return; // never overlap runs
  isRunning = true;
  try {
    await reconcilePayments();
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the periodic reconciliation (default every 5 minutes). Returns the timer
 * so it can be cleared on shutdown. Set RECONCILE_DISABLED=true to turn it off.
 */
export function startPaymentReconciliationScheduler(intervalMs = 5 * 60 * 1000) {
  if (process.env.RECONCILE_DISABLED === "true") {
    console.log("[Scheduler] Payment reconciliation disabled by RECONCILE_DISABLED.");
    return null;
  }
  console.log("[Scheduler] Payment reconciliation worker active.");
  const timer = setInterval(runReconciliation, intervalMs);
  timer.unref?.();
  return timer;
}
