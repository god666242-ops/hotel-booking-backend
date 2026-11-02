import Razorpay from "razorpay";
import { decryptSecret } from "./crypto.service.js";

/**
 * Builds a Razorpay client for a booking's payment mode.
 *
 * `paymentMode` should be the mode stored on the booking (booking.payment.mode),
 * because a hotel may switch gateway mode after a booking was paid. A booking
 * paid through the hotel's own gateway can only be refunded with the hotel's keys,
 * so we never silently fall back to the master keys for it.
 */
export function getRazorpayClient(hotel, paymentMode) {
  const mode = paymentMode || hotel?.paymentConfig?.mode;

  if (mode === "HOTEL_GATEWAY") {
    const cfg = hotel?.paymentConfig?.hotelRazorpay;
    if (!cfg?.keyId || !cfg?.keySecretEncrypted) {
      throw new Error("Hotel Razorpay credentials are not configured.");
    }
    return new Razorpay({
      key_id: cfg.keyId,
      key_secret: decryptSecret(cfg.keySecretEncrypted),
    });
  }

  const keyId = process.env.MASTER_RAZORPAY_KEY_ID;
  const keySecret = process.env.MASTER_RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Master Razorpay credentials are not configured.");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

/**
 * Refunds a payment up to `targetPaise` in total, safe to call more than once.
 *
 * It reads `amount_refunded` from Razorpay first and only refunds the remaining
 * difference, so a retry after a crash (or a retried webhook) can never refund
 * the same money twice.
 *
 * @returns {{ refundId: string|null, alreadyRefunded: boolean, refundedPaise: number }}
 */
export async function refundPaymentIdempotent(
  rzp,
  paymentId,
  targetPaise,
  notes = {},
) {
  const payment = await rzp.payments.fetch(paymentId);
  const paid = Number(payment.amount || 0);
  const alreadyRefunded = Number(payment.amount_refunded || 0);
  const target = Math.min(Math.max(0, Math.round(targetPaise)), paid);
  const remaining = target - alreadyRefunded;

  if (remaining <= 0) {
    return {
      refundId: null,
      alreadyRefunded: true,
      refundedPaise: alreadyRefunded,
    };
  }

  const refund = await rzp.payments.refund(paymentId, {
    amount: remaining,
    notes,
  });

  return {
    refundId: refund?.id || null,
    alreadyRefunded: false,
    refundedPaise: alreadyRefunded + remaining,
  };
}
