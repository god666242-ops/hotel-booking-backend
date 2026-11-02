import mongoose from "mongoose";
import Booking from "../models/Booking.js";
import Hotel from "../models/Hotel.js";
import {
  evaluateCancellationRefund,
  evaluatePayAtHotelCancellation,
  getGuestCancellationCutoff,
} from "./cancellation.service.js";
import {
  releaseRoomInventory,
  removeRedisHoldLock,
} from "./inventory.service.js";
import {
  getRazorpayClient,
  refundPaymentIdempotent,
} from "./payment.service.js";
import { markInvoiceCancelled, offlinePaidTotal } from "./invoice.service.js";

/**
 * Single implementation of "cancel a CONFIRMED booking", used by the guest
 * self-service route, the hotelier route and the crash-recovery sweeper.
 *
 * Order of operations:
 *   1. CAS lock       CONFIRMED -> CANCELLATION_IN_PROGRESS (blocks double cancels)
 *   2. Refund         idempotent: only refunds what Razorpay has not already refunded
 *   3. Finalize       ONE transaction: status CANCELLED + inventory release + payout ledger
 */
export async function cancelConfirmedBooking({
  filter,
  hotel,
  reason,
  cancelledBy,
  enforceCutoff = false,
  now = new Date(),
}) {
  const locked = await Booking.findOneAndUpdate(
    { ...filter, status: "CONFIRMED" },
    { $set: { status: "CANCELLATION_IN_PROGRESS" } },
    { new: true },
  );

  if (!locked) {
    return {
      ok: false,
      status: 409,
      code: "NOT_CANCELLABLE",
      message:
        "Reservation cannot be cancelled (not found, details do not match, or already cancelled).",
    };
  }

  const revertLock = () =>
    Booking.updateOne(
      { _id: locked._id, status: "CANCELLATION_IN_PROGRESS" },
      { $set: { status: "CONFIRMED" } },
    );

  let refundIssued = false;

  try {
    if (
      enforceCutoff &&
      now.getTime() >= getGuestCancellationCutoff(locked, hotel).getTime()
    ) {
      await revertLock();
      const cutoffHours = hotel?.cancellationPolicy?.cutoffHours ?? 12;
      return {
        ok: false,
        status: 400,
        code: "WINDOW_CLOSED",
        message: `Online cancellation closes ${cutoffHours} hours before check-in. Please contact the hotel.`,
      };
    }

    const evaluation =
      locked.payment?.mode === "PAY_AT_HOTEL"
        ? evaluatePayAtHotelCancellation(locked, { cancelledBy })
        : evaluateCancellationRefund(locked, hotel, now);

    // Issue #2: Non-refundable rate plan protection
    if (evaluation.isNonRefundable && cancelledBy === "GUEST") {
      await revertLock();
      return {
        ok: false,
        status: 400,
        code: "NON_REFUNDABLE",
        message:
          "This reservation was booked under a non-refundable rate plan and cannot be refunded.",
      };
    }

    let refundId = null;
    const isOffline = locked.payment?.mode === "OFFLINE";

    if (isOffline) {
      const received = offlinePaidTotal(locked);
      evaluation.refundAmount = Math.min(evaluation.refundAmount, received);
      evaluation.retainedAmount = Math.max(
        0,
        Math.round((received - evaluation.refundAmount) * 100) / 100,
      );
    }

    if (evaluation.refundAmount > 0 && !isOffline) {
      const paymentId = locked.payment?.razorpayPaymentId;

      if (!paymentId) {
        await revertLock();
        return {
          ok: false,
          status: 409,
          code: "PAYMENT_REFERENCE_MISSING",
          message:
            "This booking has no payment reference to refund against. Please contact the hotel.",
        };
      }

      try {
        const rzp = getRazorpayClient(hotel, locked.payment.mode);
        const result = await refundPaymentIdempotent(
          rzp,
          paymentId,
          Math.round(evaluation.refundAmount * 100),
          {
            bookingCode: locked.bookingCode,
            cancelledBy,
            reason: reason || "Booking cancelled",
          },
        );
        refundId = result.refundId;
        refundIssued = true;
      } catch (refundErr) {
        console.error(
          `[Cancellation] Razorpay refund failed for ${locked.bookingCode}:`,
          refundErr?.message || refundErr,
        );
        await revertLock();
        return {
          ok: false,
          status: 502,
          code: "REFUND_FAILED",
          message:
            "Payment gateway refund failed. The booking has not been cancelled; please try again or contact the hotel.",
        };
      }
    }

    const finalized = await finalizeCancellation({
      booking: locked,
      hotel,
      evaluation,
      refundId,
      reason,
      cancelledBy,
      now,
    });

    if (!finalized) {
      return {
        ok: false,
        status: 409,
        code: "ALREADY_FINALIZED",
        message: "Reservation was already cancelled.",
      };
    }

    return { ok: true, booking: finalized, evaluation, refundId };
  } catch (err) {
    if (!refundIssued) {
      await revertLock().catch(() => {});
    } else {
      console.error(
        `[Cancellation] Refund issued but finalize failed for ${locked.bookingCode}; sweeper will complete it.`,
        err,
      );
    }
    throw err;
  }
}

/**
 * Atomically: CANCELLATION_IN_PROGRESS -> CANCELLED, release inventory, settle ledger.
 */
export async function finalizeCancellation({
  booking,
  hotel,
  evaluation,
  refundId = null,
  reason,
  cancelledBy,
  now = new Date(),
}) {
  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      result = null;

      const updated = await Booking.findOneAndUpdate(
        { _id: booking._id, status: "CANCELLATION_IN_PROGRESS" },
        {
          $set: {
            status: "CANCELLED",
            cancellation: {
              isCancelled: true,
              cancelledAt: now,
              refundPercentApplied: evaluation.refundPercent,
              amountRefunded: evaluation.refundAmount,
              amountRetained: evaluation.retainedAmount,
              razorpayRefundId: refundId,
              reason: reason || `Cancelled (${cancelledBy || "system"})`,
            },
          },
        },
        { new: true, session },
      );

      if (!updated) return;

      await releaseRoomInventory({
        hotelId: updated.hotelId,
        roomTypeId: updated.roomTypeId,
        checkInDate: updated.dates.checkIn,
        checkOutDate: updated.dates.checkOut,
        roomCount: updated.roomCount,
        session,
      });

      result = updated;
    });
  } finally {
    await session.endSession();
  }

  if (result) {
    await removeRedisHoldLock(result._id.toString()).catch(() => {});

    // Void the invoice
    await markInvoiceCancelled(result._id, {
      refundAmount: evaluation.refundAmount,
    }).catch((err) =>
      console.error("[Invoice] Could not mark invoice cancelled:", err.message),
    );

    if (result.offlineCommission?.status === "DUE") {
      await Booking.updateOne(
        { _id: result._id, "offlineCommission.status": "DUE" },
        { $set: { "offlineCommission.status": "WAIVED" } },
      ).catch(() => {});
    }
  }

  return result;
}

/**
 * Sweeper entry point for a booking stuck in CANCELLATION_IN_PROGRESS.
 */
export async function recoverStuckCancellation(bookingId, now = new Date()) {
  const booking = await Booking.findOne({
    _id: bookingId,
    status: "CANCELLATION_IN_PROGRESS",
  });
  if (!booking) return "skipped";

  const revert = async () => {
    await Booking.updateOne(
      { _id: booking._id, status: "CANCELLATION_IN_PROGRESS" },
      { $set: { status: "CONFIRMED" } },
    );
    return "reverted";
  };

  const paymentId = booking.payment?.razorpayPaymentId;
  const hotel = await Hotel.findById(booking.hotelId);
  if (!paymentId || !hotel) return revert();

  const rzp = getRazorpayClient(hotel, booking.payment.mode);
  const payment = await rzp.payments.fetch(paymentId);
  const refundedRupees = Number(payment.amount_refunded || 0) / 100;

  if (refundedRupees <= 0) return revert();

  const pool =
    (booking.billing.roomBaseTariff || 0) +
    (booking.billing.addOnsTotal || 0) +
    (booking.billing.hotelGst || 0);

  const evaluation = {
    refundAmount: refundedRupees,
    refundPercent:
      pool > 0 ? Math.min(100, Math.round((refundedRupees / pool) * 100)) : 0,
    retainedAmount: Math.max(0, Number(payment.amount || 0) / 100 - refundedRupees),
    nonRefundableFeeRetained: booking.billing.platformConvenienceFee || 0,
  };

  const finalized = await finalizeCancellation({
    booking,
    hotel,
    evaluation,
    refundId: null,
    reason: "Recovered after an interrupted cancellation",
    cancelledBy: "SYSTEM_RECOVERY",
    now,
  });

  return finalized ? "finalized" : "skipped";
}
