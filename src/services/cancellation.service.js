const IST_OFFSET_MINUTES = 330;

/**
 * Parses "HH:mm" or "hh:mm AM/PM" into 24h hours/minutes.
 * Falls back to 12:00 for anything unparseable (instead of producing NaN dates).
 */
export function parseClockTime(value, fallback = { hours: 12, minutes: 0 }) {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return fallback;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3] ? match[3].toUpperCase() : null;

  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return fallback;

  return { hours, minutes };
}

/**
 * Check-in deadline as an absolute instant.
 * Check-in dates are stored as UTC midnight of the calendar day; the hotel's
 * check-in time is interpreted in IST (UTC+05:30).
 */
export function getCheckInDeadline(booking, hotel) {
  const { hours, minutes } = parseClockTime(hotel?.checkInTime);
  const checkIn = new Date(booking.dates.checkIn);

  return new Date(
    Date.UTC(
      checkIn.getUTCFullYear(),
      checkIn.getUTCMonth(),
      checkIn.getUTCDate(),
      hours,
      minutes,
      0,
      0,
    ) -
      IST_OFFSET_MINUTES * 60 * 1000,
  );
}

/**
 * Evaluates cancellation eligibility and computes exact refund
 * Strictly enforces Non-Refundable Rate Plans (Issue #2)
 */
export function evaluateCancellationRefund(
  booking,
  hotel,
  requestTimestamp = new Date(),
) {
  // Check if booking was booked under a non-refundable rate plan
  let isNonRefundableRate = false;
  const ratePlanId = booking.promotions?.ratePlanId;

  if (ratePlanId && Array.isArray(hotel?.ratePlans)) {
    const matchedPlan = hotel.ratePlans.find(
      (rp) => String(rp._id || rp.id) === String(ratePlanId),
    );
    if (matchedPlan?.isNonRefundable) {
      isNonRefundableRate = true;
    }
  }

  // Also check if rate plan name indicates non-refundable
  if (
    booking.promotions?.ratePlanName &&
    /non-?refundable/i.test(booking.promotions.ratePlanName)
  ) {
    isNonRefundableRate = true;
  }

  // Non-refundable rate plan block: 0% refund guaranteed
  if (isNonRefundableRate) {
    return {
      refundPercent: 0,
      refundAmount: 0,
      retainedAmount: booking.billing.grandTotal,
      nonRefundableFeeRetained: booking.billing.platformConvenienceFee || 0,
      isEligible: false,
      isNonRefundable: true,
      reason:
        "Reservation was booked under a strictly non-refundable rate plan.",
    };
  }

  const checkInDeadline = getCheckInDeadline(booking, hotel);

  // Time remaining until check-in
  const diffMs = checkInDeadline.getTime() - requestTimestamp.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;

  // Past check-in time or same-day after cut-off
  if (diffHours <= 0) {
    return {
      refundPercent: 0,
      refundAmount: 0,
      retainedAmount: booking.billing.grandTotal,
      nonRefundableFeeRetained: booking.billing.platformConvenienceFee || 0,
      isEligible: false,
      isNonRefundable: false,
      reason: "Cancellation window has passed (past check-in time).",
    };
  }

  // Find matching policy tier (sorted descending by days)
  const tiers = hotel?.cancellationPolicy?.tiers?.length
    ? hotel.cancellationPolicy.tiers
    : [
        { daysBeforeCheckIn: 7, refundPercent: 100 },
        { daysBeforeCheckIn: 2, refundPercent: 50 },
        { daysBeforeCheckIn: 0, refundPercent: 0 },
      ];

  const sortedTiers = [...tiers].sort(
    (a, b) => b.daysBeforeCheckIn - a.daysBeforeCheckIn,
  );

  let appliedPercent = 0;
  for (const tier of sortedTiers) {
    if (diffDays >= tier.daysBeforeCheckIn) {
      appliedPercent = tier.refundPercent;
      break;
    }
  }

  // Pool eligible for refund: Room Tariff + Add-ons + GST
  const refundablePool =
    (booking.billing.roomBaseTariff || 0) +
    (booking.billing.addOnsTotal || 0) +
    (booking.billing.hotelGst || 0);

  const refundAmount = Math.round((refundablePool * appliedPercent) / 100);
  const retainedAmount = Math.max(0, booking.billing.grandTotal - refundAmount);

  return {
    refundPercent: appliedPercent,
    refundAmount,
    retainedAmount,
    nonRefundableFeeRetained: booking.billing.platformConvenienceFee || 0,
    isEligible: refundAmount > 0,
    isNonRefundable: false,
  };
}

/**
 * Evaluates payment delta when modifying stay dates, room categories, or guest counts (#1)
 */
export function evaluateBookingModification({
  originalBooking,
  newPricingBreakdown,
}) {
  const originalGrandTotal = Number(originalBooking.billing?.grandTotal || 0);
  const newGrandTotal = Number(newPricingBreakdown.grandTotal || 0);

  const delta = Number((newGrandTotal - originalGrandTotal).toFixed(2));

  let action = "NO_CHANGE";
  if (delta > 0) {
    action = "PAYMENT_DUE"; // Guest or front desk owes an additional balance
  } else if (delta < 0) {
    action = "REFUND_DUE"; // Booking costs less; guest is owed a partial refund
  }

  const settlesAtHotel = ["OFFLINE", "PAY_AT_HOTEL"].includes(
    originalBooking.payment?.mode,
  );

  return {
    originalGrandTotal,
    newGrandTotal,
    delta: Math.abs(delta),
    action, // 'PAYMENT_DUE' | 'REFUND_DUE' | 'NO_CHANGE'
    requiresOnlinePayment: action === "PAYMENT_DUE" && !settlesAtHotel,
    requiresOnlineRefund: action === "REFUND_DUE" && !settlesAtHotel,
  };
}

/**
 * Guests may cancel online only until `cutoffHours` before check-in.
 * (Hotel-initiated cancellations are not subject to this.)
 */
export function getGuestCancellationCutoff(booking, hotel) {
  const raw = Number(hotel?.cancellationPolicy?.cutoffHours ?? 12);
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 12;
  return new Date(
    getCheckInDeadline(booking, hotel).getTime() - hours * 60 * 60 * 1000,
  );
}

/**
 * Pay-at-hotel cancellations use a fixed rule, not the hotel's tier policy:
 *  - guest cancels  -> the online commission is NOT refunded
 *  - hotel cancels  -> the online commission is refunded in full
 */
export function evaluatePayAtHotelCancellation(booking, { cancelledBy } = {}) {
  const paidOnline = Math.max(
    0,
    Number(booking?.payment?.amountPayableNow) || 0,
  );
  const hotelCancelled = cancelledBy === "HOTELIER";
  const refundAmount = hotelCancelled ? paidOnline : 0;

  return {
    refundPercent: hotelCancelled ? 100 : 0,
    refundAmount,
    retainedAmount: Math.max(0, paidOnline - refundAmount),
    nonRefundableFeeRetained: 0,
    isEligible: refundAmount > 0,
    isNonRefundable: false,
    reason: hotelCancelled
      ? "Cancelled by the hotel: booking fee refunded in full."
      : "The online booking fee is non-refundable when the guest cancels.",
  };
}
