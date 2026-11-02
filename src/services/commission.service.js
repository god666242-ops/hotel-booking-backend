// backend/src/services/commission.service.js
// Pure commission maths. No DB access, safe to unit test.

export const MODE_GATEWAY = "HOTEL_GATEWAY";
export const MODE_PAY_AT_HOTEL = "PAY_AT_HOTEL";

const DEFAULT_PERCENT = {
  [MODE_GATEWAY]: 5,
  [MODE_PAY_AT_HOTEL]: 8,
};

export function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

/**
 * Commission % for a hotel and payment mode.
 * Reads hotel.paymentConfig.gatewayCommissionPercent / payAtHotelCommissionPercent,
 * falling back to 5 (own gateway) and 8 (pay at hotel).
 */
export function getCommissionPercent(hotel, mode) {
  const cfg = hotel?.paymentConfig || {};
  const raw =
    mode === MODE_PAY_AT_HOTEL
      ? cfg.payAtHotelCommissionPercent
      : cfg.gatewayCommissionPercent;

  if (raw !== null && raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return DEFAULT_PERCENT[mode] ?? DEFAULT_PERCENT[MODE_GATEWAY];
}

/**
 * GST charged on top of the commission on weekly invoices.
 * 0 until you are GST registered. Then set COMMISSION_GST_PERCENT=18 in .env.
 */
export function getGstOnCommissionPercent() {
  const n = Number(process.env.COMMISSION_GST_PERCENT || 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Commission base = room tariff (already net of discounts) + add-ons.
 * The hotel's own GST is deliberately NOT part of the base.
 */
export function getCommissionBase(billing) {
  return round2(
    (Number(billing?.roomBaseTariff) || 0) + (Number(billing?.addOnsTotal) || 0),
  );
}

/**
 * Option 2 (pay at hotel): the guest pays the commission online now and the
 * rest at the hotel. now + atHotel always equals grandTotal.
 * Any GST on commission (later) is treated as INCLUDED in this amount, so the
 * guest's figures never change when you register for GST.
 */
export function calculatePayAtHotelSplit({ billing, percent }) {
  const grandTotal = round2(billing?.grandTotal);
  const commissionBase = getCommissionBase(billing);

  let amountPayableNow = round2((commissionBase * Number(percent)) / 100);
  // Razorpay minimum order is Rs 1, and never charge more than the total.
  amountPayableNow = Math.min(Math.max(amountPayableNow, 1), grandTotal);

  return {
    commissionBase,
    percent: Number(percent),
    amountPayableNow,
    amountDueAtHotel: round2(grandTotal - amountPayableNow),
  };
}

/**
 * Option 1 (own gateway): commission owed on one booking for the weekly invoice.
 * Refunds reduce the base proportionally, so a fully refunded booking owes 0
 * and a cancellation that kept 100% of the money still owes full commission.
 */
export function calculateBookingCommission(booking, percent) {
  const billing = booking?.billing || {};
  const base = getCommissionBase(billing);
  const refundablePool = base + round2(billing.hotelGst);
  const refunded = round2(booking?.cancellation?.amountRefunded);

  const retainedFraction =
    refundablePool > 0
      ? Math.min(1, Math.max(0, 1 - refunded / refundablePool))
      : 1;

  const eligibleBase = round2(base * retainedFraction);
  const commission = round2((eligibleBase * Number(percent)) / 100);

  return { base: eligibleBase, percent: Number(percent), commission };
}