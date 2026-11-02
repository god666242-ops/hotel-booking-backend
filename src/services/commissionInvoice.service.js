// backend/src/services/commissionInvoice.service.js
import mongoose from "mongoose";
import Hotel from "../models/Hotel.js";
import Booking from "../models/Booking.js";
import CommissionInvoice from "../models/CommissionInvoice.js";
import { masterRazorpay } from "../config/razorpay.js";
import { sendSystemAlert } from "../utils/systemAlerts.js";
import {
  MODE_GATEWAY,
  round2,
  getCommissionPercent,
  getGstOnCommissionPercent,
  calculateBookingCommission,
} from "./commission.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

const num = (envName, fallback) => {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const DUE_DAYS = () => num("COMMISSION_DUE_DAYS", 7);
const SUSPEND_AFTER_DAYS = () => num("COMMISSION_SUSPEND_AFTER_DAYS", 10);
const MIN_INVOICE_AMOUNT = () => num("COMMISSION_MIN_INVOICE_AMOUNT", 100);

const BILLABLE_STATUSES = ["CONFIRMED", "CHECKED_IN", "COMPLETED", "CANCELLED"];
const BILLABLE_PAYMENT_STATUSES = ["PAID", "PARTIAL", "REFUNDED"];

const dateStr = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Last fully completed Monday-to-Sunday week in IST.
 * periodEnd is exclusive (the Monday after), stored as UTC midnight of that
 * calendar day, matching how dates.checkIn / dates.checkOut are stored.
 */
export function getLastCompletedWeek(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const todayUtcMidnight = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
  );
  const sinceMonday = (ist.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  const periodEnd = new Date(todayUtcMidnight - sinceMonday * DAY_MS);
  const periodStart = new Date(periodEnd.getTime() - 7 * DAY_MS);
  return { periodStart, periodEnd };
}

/**
 * Creates (or recreates) the Razorpay payment link for an invoice.
 * The link is created on YOUR master Razorpay account.
 */
export async function ensurePaymentLink(invoice, hotel, { force = false } = {}) {
  if (!force && invoice.razorpayPaymentLinkId && invoice.paymentLinkUrl) {
    return invoice;
  }
  if (!["PENDING", "OVERDUE"].includes(invoice.status)) return invoice;

  try {
    const expireBy = Math.floor(
      (Math.max(new Date(invoice.dueDate).getTime(), Date.now()) +
        14 * DAY_MS) /
        1000,
    );
    const periodLastDay = dateStr(new Date(invoice.periodEnd).getTime() - DAY_MS);

    const link = await masterRazorpay.paymentLink.create({
      amount: Math.round(invoice.totalDue * 100),
      currency: "INR",
      accept_partial: false,
      reference_id: invoice.invoiceNumber,
      description: `Platform commission ${dateStr(invoice.periodStart)} to ${periodLastDay}`,
      customer: {
        name: hotel?.legal?.legalName || hotel?.name || "Hotel",
        email: hotel?.contact?.email,
      },
      notify: { email: true, sms: false },
      reminder_enable: false,
      expire_by: expireBy,
      notes: {
        commissionInvoiceId: String(invoice._id),
        hotelId: String(invoice.hotelId),
      },
    });

    invoice.razorpayPaymentLinkId = link.id;
    invoice.paymentLinkUrl = link.short_url;
    invoice.linkError = null;
    await invoice.save();
  } catch (err) {
    invoice.linkError = String(err?.error?.description || err?.message || err).slice(0, 300);
    await invoice.save().catch(() => {});
    await sendSystemAlert({
      type: "COMMISSION_LINK_FAILURE",
      title: "Commission payment link creation failed",
      message: `Invoice ${invoice.invoiceNumber}: ${invoice.linkError}`,
      metadata: { invoiceId: invoice._id, hotelId: invoice.hotelId },
      severity: "error",
    });
  }
  return invoice;
}

/**
 * Builds the weekly invoice for ONE hotel. Idempotent:
 *  - EXISTS          an invoice for this hotel + week already exists
 *  - NOTHING_TO_BILL no billable bookings
 *  - BELOW_MINIMUM   total under the minimum; bookings stay unbilled and
 *                    roll into the next week automatically
 *  - CREATED         invoice created
 */
export async function generateWeeklyInvoiceForHotel(
  hotel,
  { periodStart, periodEnd, now = new Date() },
) {
  const already = await CommissionInvoice.exists({
    hotelId: hotel._id,
    periodStart,
  });
  if (already) return { outcome: "EXISTS" };

  const percent = getCommissionPercent(hotel, MODE_GATEWAY);
  const gstPercent = getGstOnCommissionPercent();

  const bookings = await Booking.find({
    hotelId: hotel._id,
    "payment.mode": MODE_GATEWAY,
    "commission.billedAt": null,
    status: { $in: BILLABLE_STATUSES },
    "payment.status": { $in: BILLABLE_PAYMENT_STATUSES },
    "dates.checkOut": { $lt: periodEnd },
  })
    .select("bookingCode dates billing cancellation")
    .lean();

  if (bookings.length === 0) return { outcome: "NOTHING_TO_BILL" };

  const lines = [];
  const zeroIds = [];
  for (const b of bookings) {
    const calc = calculateBookingCommission(b, percent);
    if (calc.commission > 0) {
      lines.push({
        bookingId: b._id,
        bookingCode: b.bookingCode,
        checkIn: b.dates?.checkIn,
        checkOut: b.dates?.checkOut,
        commissionBase: calc.base,
        percent: calc.percent,
        commission: calc.commission,
      });
    } else {
      zeroIds.push(b._id);
    }
  }

  const commissionBase = round2(lines.reduce((s, l) => s + l.commissionBase, 0));
  const commissionAmount = round2(lines.reduce((s, l) => s + l.commission, 0));
  const gstAmount = round2((commissionAmount * gstPercent) / 100);
  const totalDue = round2(commissionAmount + gstAmount);

  if (lines.length === 0) return { outcome: "NOTHING_TO_BILL" };
  if (totalDue < MIN_INVOICE_AMOUNT()) return { outcome: "BELOW_MINIMUM", totalDue };

  const invoiceNumber = `CI-${dateStr(new Date(periodEnd.getTime() - DAY_MS)).replace(/-/g, "")}-${String(hotel._id).slice(-6).toUpperCase()}`;
  const dueDate = new Date(now.getTime() + DUE_DAYS() * DAY_MS);

  const session = await mongoose.startSession();
  let invoice = null;
  try {
    await session.withTransaction(async () => {
      invoice = null;
      const [doc] = await CommissionInvoice.create(
        [
          {
            hotelId: hotel._id,
            invoiceNumber,
            periodStart,
            periodEnd,
            lines,
            bookingCount: lines.length,
            commissionBase,
            commissionAmount,
            gstPercent,
            gstAmount,
            totalDue,
            status: "PENDING",
            dueDate,
          },
        ],
        { session },
      );

      const ops = lines.map((l) => ({
        updateOne: {
          filter: { _id: l.bookingId, "commission.billedAt": null },
          update: {
            $set: {
              "commission.percent": l.percent,
              "commission.base": l.commissionBase,
              "commission.amount": l.commission,
              "commission.status": "INVOICED",
              "commission.invoiceId": doc._id,
              "commission.billedAt": now,
            },
          },
        },
      }));
      if (zeroIds.length > 0) {
        ops.push({
          updateMany: {
            filter: { _id: { $in: zeroIds }, "commission.billedAt": null },
            update: {
              $set: { "commission.status": "NONE", "commission.billedAt": now },
            },
          },
        });
      }

      const res = await Booking.bulkWrite(ops, { session });
      if (res.modifiedCount < lines.length) {
        // Another process billed some of these bookings first. Roll back.
        throw new Error("CONCURRENT_BILLING");
      }
      invoice = doc;
    });
  } catch (err) {
    if (err?.code === 11000) return { outcome: "EXISTS" };
    if (err?.message === "CONCURRENT_BILLING") return { outcome: "CONFLICT" };
    throw err;
  } finally {
    await session.endSession();
  }

  await ensurePaymentLink(invoice, hotel);
  return { outcome: "CREATED", invoice };
}

/**
 * Called from the Razorpay webhook on `payment_link.paid`.
 * Idempotent: a repeated delivery changes nothing.
 */
export async function markInvoicePaidFromLink({
  paymentLinkId,
  paymentId = null,
  amountPaise = null,
}) {
  if (!paymentLinkId) return null;

  const invoice = await CommissionInvoice.findOne({
    razorpayPaymentLinkId: paymentLinkId,
  });
  if (!invoice) return null;
  if (invoice.status === "PAID") return invoice;

  if (
    amountPaise != null &&
    Number(amountPaise) < Math.round(invoice.totalDue * 100)
  ) {
    await sendSystemAlert({
      type: "COMMISSION_PAYMENT_MISMATCH",
      title: "Commission payment is less than the invoice total",
      message: `Invoice ${invoice.invoiceNumber} expects ${invoice.totalDue} but received ${Number(amountPaise) / 100}.`,
      metadata: { invoiceId: invoice._id, paymentId },
      severity: "error",
    });
    return invoice;
  }

  const updated = await CommissionInvoice.findOneAndUpdate(
    { _id: invoice._id, status: { $in: ["PENDING", "OVERDUE"] } },
    { $set: { status: "PAID", paidAt: new Date(), paidPaymentId: paymentId } },
    { new: true },
  );
  if (!updated) return invoice;

  await Booking.updateMany(
    { "commission.invoiceId": updated._id },
    { $set: { "commission.status": "PAID" } },
  );

  // Switch the hotel back on if THIS invoice was what suspended it and no
  // other overdue invoice is still holding it off.
  if (updated.suspendedHotel) {
    const stillBlocked = await CommissionInvoice.exists({
      hotelId: updated.hotelId,
      status: { $in: ["PENDING", "OVERDUE"] },
      suspendedHotel: true,
    });
    if (!stillBlocked) {
      await Hotel.updateOne({ _id: updated.hotelId }, { $set: { isActive: true } });
    }
  }
  return updated;
}

/**
 * Reminders and suspension for unpaid invoices. Safe to run every hour.
 *  day 3 after issue: first reminder (email from Razorpay)
 *  day 7:             second reminder, invoice marked OVERDUE
 *  day 10:            hotel switched off until the invoice is paid
 */
export async function processOverdueInvoices(now = new Date()) {
  const open = await CommissionInvoice.find({
    status: { $in: ["PENDING", "OVERDUE"] },
  });

  for (const inv of open) {
    try {
      const days = (now.getTime() - inv.createdAt.getTime()) / DAY_MS;

      if (inv.status === "PENDING" && now > inv.dueDate) {
        inv.status = "OVERDUE";
      }

      const wantsReminder =
        (days >= 3 && inv.remindersSent < 1) ||
        (days >= 7 && inv.remindersSent < 2);

      if (wantsReminder && inv.razorpayPaymentLinkId) {
        try {
          await masterRazorpay.paymentLink.notifyBy(
            inv.razorpayPaymentLinkId,
            "email",
          );
          inv.remindersSent += 1;
          inv.lastReminderAt = now;
        } catch (err) {
          console.error(
            `[Commission] Reminder failed for ${inv.invoiceNumber}:`,
            err?.message || err,
          );
        }
      }

      if (days >= SUSPEND_AFTER_DAYS() && !inv.suspendedHotel) {
        await Hotel.updateOne({ _id: inv.hotelId }, { $set: { isActive: false } });
        inv.suspendedHotel = true;
        await sendSystemAlert({
          type: "COMMISSION_OVERDUE",
          title: "Hotel suspended for unpaid commission",
          message: `Hotel ${inv.hotelId} was switched off. Invoice ${inv.invoiceNumber} (Rs ${inv.totalDue}) is unpaid.`,
          metadata: { invoiceId: inv._id, hotelId: inv.hotelId },
          severity: "warning",
        });
      }

      await inv.save();
    } catch (err) {
      console.error(`[Commission] Overdue handling failed for ${inv._id}:`, err);
    }
  }
}

/**
 * Retries link creation for invoices where Razorpay was unavailable.
 */
export async function retryMissingPaymentLinks() {
  const missing = await CommissionInvoice.find({
    status: { $in: ["PENDING", "OVERDUE"] },
    razorpayPaymentLinkId: null,
  }).limit(50);

  for (const inv of missing) {
    const hotel = await Hotel.findById(inv.hotelId)
      .select("name legal contact")
      .lean();
    await ensurePaymentLink(inv, hotel);
  }
}

/**
 * Superadmin: settle an invoice outside Razorpay (bank transfer, cash) or
 * waive it. Also switches the hotel back on if this invoice had suspended it.
 */
export async function settleInvoiceManually(
  invoiceId,
  { status = "PAID", reference = "MANUAL" } = {},
) {
  if (!["PAID", "WAIVED"].includes(status)) {
    throw new Error("status must be PAID or WAIVED");
  }

  const update = { status };
  if (status === "PAID") {
    update.paidAt = new Date();
    update.paidPaymentId = String(reference || "MANUAL").slice(0, 80);
  }

  const invoice = await CommissionInvoice.findOneAndUpdate(
    { _id: invoiceId, status: { $in: ["PENDING", "OVERDUE"] } },
    { $set: update },
    { new: true },
  );
  if (!invoice) return null;

  await Booking.updateMany(
    { "commission.invoiceId": invoice._id },
    { $set: { "commission.status": status === "PAID" ? "PAID" : "WAIVED" } },
  );

  if (invoice.suspendedHotel) {
    const stillBlocked = await CommissionInvoice.exists({
      hotelId: invoice.hotelId,
      status: { $in: ["PENDING", "OVERDUE"] },
      suspendedHotel: true,
    });
    if (!stillBlocked) {
      await Hotel.updateOne({ _id: invoice.hotelId }, { $set: { isActive: true } });
    }
  }
  return invoice;
}