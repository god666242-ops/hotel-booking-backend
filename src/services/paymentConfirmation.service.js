import mongoose from "mongoose";
import Booking from "../models/Booking.js";
import Hotel from "../models/Hotel.js";
import RoomType from "../models/RoomType.js";
import { holdRoomInventory, removeRedisHoldLock } from "./inventory.service.js";
import { sendBookingConfirmation } from "./notification.service.js";
import { tryIssueInvoiceForEmail } from "./invoice.service.js";
import {
  getRazorpayClient,
  refundPaymentIdempotent,
} from "./payment.service.js";

/**
 * Shared "a payment arrived" logic. Used by the Razorpay webhook AND the
 * reconciliation job, so both go through exactly the same idempotent,
 * atomic state transitions.
 */

/**
 * Confirms a paid booking. Safe to call repeatedly and concurrently.
 * Returns the CONFIRMED booking when this call confirmed it, else null.
 */
export async function confirmPaidBooking({ booking, paymentId, signature }) {
  if (booking.status === "CONFIRMED") return null;

  const hotel = await Hotel.findById(booking.hotelId);

  // Path A: normal HELD -> CONFIRMED
  let confirmed = await Booking.findOneAndUpdate(
    { _id: booking._id, status: "HELD" },
    {
      $set: {
        status: "CONFIRMED",
        "payment.status": "PAID",
        "payment.razorpayPaymentId":
          paymentId || booking.payment.razorpayPaymentId,
        "payment.razorpaySignature": signature,
      },
    },
    { new: true },
  );

  // Path B: the hold expired while the guest was paying
  if (!confirmed) {
    confirmed = await reclaimExpiredBooking({
      booking,
      hotel,
      paymentId,
      signature,
    });
  }

  if (!confirmed) return null;

  await removeRedisHoldLock(confirmed._id.toString()).catch(() => {});

  // Pay-at-hotel: the online payment IS your commission, so mark it collected.
  if (confirmed.payment.mode === "PAY_AT_HOTEL") {
    await Booking.updateOne(
      { _id: confirmed._id },
      {
        $set: {
          "commission.status": "PAID",
          "commission.billedAt": new Date(),
        },
      },
    );
  }

  const roomType = await RoomType.findById(confirmed.roomTypeId);
  if (hotel && roomType) {
    // Issue the numbered invoice first so the confirmation email can attach the PDF
    // (also guarantees every confirmed booking has an invoice, even if email fails).
    tryIssueInvoiceForEmail(confirmed, { hotel, roomType })
      .then((invoice) =>
        sendBookingConfirmation({
          booking: confirmed,
          hotel,
          roomType,
          invoice,
        }),
      )
      .catch((err) => console.error("[Notification Error]", err));
  }

  return confirmed;
}

/**
 * Late payment on an EXPIRED hold:
 *   - if the rooms can still be re-held  -> CONFIRMED
 *   - if they were resold                -> refund in full, EXPIRED_REFUNDED
 * Returns the confirmed booking, or null when nothing was confirmed.
 *
 * REHOLD_IN_PROGRESS is an atomic lock so concurrent deliveries can't both act.
 * Any unexpected failure unlocks back to EXPIRED and rethrows, so the webhook
 * returns 5xx and Razorpay retries. (The sweeper also unlocks stale locks.)
 */
async function reclaimExpiredBooking({ booking, hotel, paymentId, signature }) {
  const locked = await Booking.findOneAndUpdate(
    { _id: booking._id, status: "EXPIRED" },
    { $set: { status: "REHOLD_IN_PROGRESS" } },
    { new: true },
  );
  if (!locked) return null; // handled by a concurrent delivery or already terminal

  const unlock = () =>
    Booking.updateOne(
      { _id: locked._id, status: "REHOLD_IN_PROGRESS" },
      { $set: { status: "EXPIRED" } },
    );

  try {
    // Pay-at-hotel guests only paid the booking fee online, not the full total.
    const paidPaise = Math.round(
      (locked.payment.mode === "PAY_AT_HOTEL"
        ? Number(locked.payment.amountPayableNow) || 0
        : locked.billing.grandTotal) * 100,
    );
    let rzp = null;

    if (paymentId) {
      rzp = getRazorpayClient(hotel, locked.payment.mode);

      // A previous attempt may have refunded this payment and then crashed.
      const payment = await rzp.payments.fetch(paymentId);
      if (
        Number(payment.amount_refunded || 0) >=
        Number(payment.amount || paidPaise)
      ) {
        await markExpiredRefunded(locked, paymentId, null);
        return null;
      }
    }

    // Try to take the rooms back inside a transaction
    const session = await mongoose.startSession();
    let reclaimed = null;
    try {
      await session.withTransaction(async () => {
        reclaimed = null;
        const hold = await holdRoomInventory({
          hotelId: locked.hotelId,
          roomTypeId: locked.roomTypeId,
          checkInDate: locked.dates.checkIn,
          checkOutDate: locked.dates.checkOut,
          roomCount: locked.roomCount,
          session,
        });

        if (!hold.success) {
          await session.abortTransaction();
          return;
        }

        reclaimed = await Booking.findOneAndUpdate(
          { _id: locked._id, status: "REHOLD_IN_PROGRESS" },
          {
            $set: {
              status: "CONFIRMED",
              "payment.status": "PAID",
              "payment.razorpayPaymentId":
                paymentId || locked.payment.razorpayPaymentId,
              "payment.razorpaySignature": signature,
            },
          },
          { new: true, session },
        );
      });
    } finally {
      await session.endSession();
    }

    if (reclaimed) return reclaimed;

    // Rooms were resold: refund the guest in full
    if (!paymentId || !rzp) {
      console.error(
        `[CRITICAL] Booking ${locked.bookingCode} paid after expiry with no payment id and no inventory; manual refund required.`,
      );
      await unlock();
      return null;
    }

    const refund = await refundPaymentIdempotent(rzp, paymentId, paidPaise, {
      reason: "Hold expired and inventory sold out before payment received",
      bookingCode: locked.bookingCode,
    });

    await markExpiredRefunded(locked, paymentId, refund.refundId);
    return null;
  } catch (err) {
    console.error(
      `[Webhook] Reclaim failed for ${locked.bookingCode}; unlocking for retry:`,
      err?.message || err,
    );
    await unlock().catch(() => {});
    throw err; // 5xx -> Razorpay retries the delivery
  }
}

async function markExpiredRefunded(lockedBooking, paymentId, refundId) {
  await Booking.updateOne(
    { _id: lockedBooking._id, status: "REHOLD_IN_PROGRESS" },
    {
      $set: {
        status: "EXPIRED_REFUNDED",
        "payment.status": "REFUNDED",
        "payment.razorpayPaymentId":
          paymentId || lockedBooking.payment.razorpayPaymentId,
        cancellation: {
          isCancelled: true,
          cancelledAt: new Date(),
          refundPercentApplied: 100,
          amountRefunded:
            lockedBooking.payment.mode === "PAY_AT_HOTEL"
              ? Number(lockedBooking.payment.amountPayableNow) || 0
              : lockedBooking.billing.grandTotal,
          amountRetained: 0,
          razorpayRefundId: refundId,
          reason: "Hold expired and inventory sold out before payment",
        },
      },
    },
  );
  await removeRedisHoldLock(lockedBooking._id.toString()).catch(() => {});
}
