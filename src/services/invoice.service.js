import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import Booking from "../models/Booking.js";
import Hotel from "../models/Hotel.js";
import RoomType from "../models/RoomType.js";
import { nextSequence } from "../models/Counter.js";
import {
  computeInvoiceFigures,
  financialYearOf,
  formatInvoiceNumber,
  formatInr,
  INVOICE_PREFIX_PATTERN,
  pickDocumentType,
  round2,
  stateCodeFromGstin,
} from "../utils/invoiceMath.js";
import { renderInvoicePdf, renderCreditNotePdf } from "../utils/invoicePdf.js";

const INVOICEABLE_STATUSES = ["CONFIRMED", "CHECKED_IN", "COMPLETED"];

export const offlinePaidTotal = (booking) =>
  round2(
    (booking.payment?.offlinePayments || []).reduce(
      (sum, p) => sum + (Number(p.amount) || 0),
      0,
    ),
  );

function paymentFigures(booking) {
  const grand = round2(booking.billing?.grandTotal);
  if (booking.payment?.mode === "OFFLINE") {
    const paid = Math.min(grand, offlinePaidTotal(booking));
    return { amountPaid: paid, amountDue: round2(grand - paid) };
  }
  if (booking.payment?.mode === "PAY_AT_HOTEL") {
    const paidNow = Math.min(grand, round2(booking.payment?.amountPayableNow));
    return { amountPaid: paidNow, amountDue: round2(grand - paidNow) };
  }
  // Online bookings: If modified and delta is pending, reflect in amountDue
  const totalPaid = Number(booking.payment?.amountPaidOnline || grand);
  return {
    amountPaid: totalPaid,
    amountDue: Math.max(0, round2(grand - totalPaid)),
  };
}

function paymentSummary(booking) {
  if (booking.payment?.mode === "OFFLINE") {
    const items = booking.payment.offlinePayments || [];
    if (items.length === 0) return "Payment to be collected at the hotel.";
    return `Received at hotel: ${items
      .map(
        (p) => `${String(p.method).replace("_", " ")} ${formatInr(p.amount)}`,
      )
      .join(", ")}`;
  }
  if (booking.payment?.mode === "PAY_AT_HOTEL") {
    const ref = booking.payment?.razorpayPaymentId
      ? ` (${booking.payment.razorpayPaymentId})`
      : "";
    return `Booking fee ${formatInr(booking.payment?.amountPayableNow)} paid online${ref}; balance ${formatInr(booking.payment?.amountDueAtHotel)} payable at the hotel.`;
  }
  const id = booking.payment?.razorpayPaymentId;
  return `Paid online via Razorpay${id ? ` (${id})` : ""}`;
}

function sellerAddress(hotel) {
  const a = hotel.address || {};
  return [a.street, a.city, [a.state, a.pincode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

/**
 * Issues the invoice for a booking exactly once and returns it.
 */
export async function ensureInvoice(
  booking,
  { hotel = null, roomType = null } = {},
) {
  const existing = await Invoice.findOne({ bookingId: booking._id });
  if (existing) return existing;
  if (!INVOICEABLE_STATUSES.includes(booking.status)) return null;

  hotel = hotel || (await Hotel.findById(booking.hotelId));
  if (!hotel) return null;
  roomType = roomType || (await RoomType.findById(booking.roomTypeId));

  const figures = computeInvoiceFigures({
    billing: booking.billing,
    selectedAddOns: booking.selectedAddOns,
  });
  const gstin = (hotel.legal?.gstin || "").toUpperCase();
  const docType = pickDocumentType({ gstin, gstAmount: figures.gstTotal });

  const issuedAt = new Date();
  const financialYear = financialYearOf(issuedAt);
  const prefix = INVOICE_PREFIX_PATTERN.test(hotel.legal?.invoicePrefix || "")
    ? hotel.legal.invoicePrefix
    : "INV";
  const pay = paymentFigures(booking);

  const buildDoc = (invoiceNumber) => ({
    hotelId: hotel._id,
    bookingId: booking._id,
    bookingCode: booking.bookingCode,
    invoiceNumber,
    financialYear,
    docType,
    issuedAt,
    seller: {
      legalName: hotel.legal?.legalName || hotel.name,
      tradeName: hotel.name,
      gstin,
      stateCode: stateCodeFromGstin(gstin),
      address: sellerAddress(hotel),
      phone: hotel.contact?.phone || "",
      email: hotel.contact?.email || "",
    },
    buyer: {
      name: booking.guest.name,
      email: booking.guest.email || "",
      phone: booking.guest.phone,
    },
    placeOfSupply: {
      state: hotel.address?.state || "",
      code: stateCodeFromGstin(gstin),
    },
    stay: {
      roomName: roomType?.name || "Room",
      roomCount: booking.roomCount || 1,
      checkIn: booking.dates.checkIn,
      checkOut: booking.dates.checkOut,
      nights: booking.dates.nights,
      adults: booking.occupancy?.adults ?? 1,
      children: booking.occupancy?.children ?? 0,
    },
    lines: figures.lines,
    taxableValue: figures.taxableValue,
    gstRate: figures.gstRate,
    cgst: figures.cgst,
    sgst: figures.sgst,
    invoiceValue: figures.invoiceValue,
    platformFee: figures.platformFee,
    platform: {
      name: process.env.PLATFORM_LEGAL_NAME || "the booking platform",
      gstin: process.env.PLATFORM_GSTIN || "",
    },
    ...pay,
    paymentSummary: paymentSummary(booking),
  });

  const dbSession = await mongoose.startSession();
  try {
    let invoice = null;
    await dbSession.withTransaction(async () => {
      const already = await Invoice.findOne({ bookingId: booking._id }).session(
        dbSession,
      );
      if (already) {
        invoice = already;
        return;
      }
      const seq = await nextSequence(
        `invoice:${hotel._id}:${financialYear}`,
        dbSession,
      );
      const invoiceNumber = formatInvoiceNumber(prefix, financialYear, seq);
      const [created] = await Invoice.create([buildDoc(invoiceNumber)], {
        session: dbSession,
      });
      await Booking.updateOne(
        { _id: booking._id },
        { $set: { invoiceNumber } },
        { session: dbSession },
      );
      invoice = created;
    });
    return invoice;
  } catch (err) {
    if (err?.code === 11000) {
      const winner = await Invoice.findOne({ bookingId: booking._id });
      if (winner) return winner;
    }
    throw err;
  } finally {
    await dbSession.endSession();
  }
}

/**
 * Synchronizes invoice figures after a booking modification (#1)
 */
export async function syncInvoiceAfterModification(
  booking,
  { roomType = null, session = null } = {},
) {
  const invoice = await Invoice.findOne({
    bookingId: booking._id,
    status: "ACTIVE",
  }).session(session);
  if (!invoice) return null;

  const figures = computeInvoiceFigures({
    billing: booking.billing,
    selectedAddOns: booking.selectedAddOns,
  });

  const pay = paymentFigures(booking);

  const updateFields = {
    "stay.checkIn": booking.dates.checkIn,
    "stay.checkOut": booking.dates.checkOut,
    "stay.nights": booking.dates.nights,
    "stay.roomCount": booking.roomCount,
    "stay.adults": booking.occupancy?.adults ?? 1,
    "stay.children": booking.occupancy?.children ?? 0,
    lines: figures.lines,
    taxableValue: figures.taxableValue,
    gstRate: figures.gstRate,
    cgst: figures.cgst,
    sgst: figures.sgst,
    invoiceValue: figures.invoiceValue,
    platformFee: figures.platformFee,
    ...pay,
    paymentSummary: paymentSummary(booking),
  };

  if (roomType?.name) {
    updateFields["stay.roomName"] = roomType.name;
  }

  return Invoice.findByIdAndUpdate(
    invoice._id,
    { $set: updateFields },
    { session, new: true },
  );
}

/** Keeps the paid / balance figures current after the hotel records more money. */
export async function refreshInvoicePayment(booking) {
  const pay = paymentFigures(booking);
  await Invoice.updateOne(
    { bookingId: booking._id },
    { $set: { ...pay, paymentSummary: paymentSummary(booking) } },
  );
}

export async function markInvoiceCancelled(
  bookingId,
  { refundAmount = 0 } = {},
) {
  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      const invoice = await Invoice.findOne({
        bookingId,
        status: "ACTIVE",
      }).session(dbSession);
      if (!invoice) return;

      const cancelledAt = new Date();
      const set = {
        status: "CANCELLED",
        cancelledAt,
        refundAmount: round2(refundAmount),
      };

      if (invoice.docType === "TAX_INVOICE") {
        const seq = await nextSequence(
          `creditnote:${invoice.hotelId}:${invoice.financialYear}`,
          dbSession,
        );
        const [start, end] = invoice.financialYear.split("-");
        set.creditNoteNumber = `CN/${start.slice(2)}${end}/${String(seq).padStart(5, "0")}`;
        set.creditNoteIssuedAt = cancelledAt;
      }

      await Invoice.updateOne(
        { _id: invoice._id, status: "ACTIVE" },
        { $set: set },
        { session: dbSession },
      );
    });
  } finally {
    await dbSession.endSession();
  }
}

/** Issues the invoice if needed and renders it. Returns { invoice, pdf } or null. */
export async function buildInvoicePdf(booking) {
  const invoice = await ensureInvoice(booking);
  if (!invoice) return null;
  return { invoice, pdf: renderInvoicePdf(invoice.toObject()) };
}

/**
 * Builds a GST Credit Note PDF for a cancelled invoice record.
 */
export async function buildCreditNotePdf(booking) {
  const invoice = await Invoice.findOne({
    bookingId: booking._id,
    status: "CANCELLED",
  });
  if (!invoice || !invoice.creditNoteNumber) return null;
  return { invoice, pdf: renderCreditNotePdf(invoice.toObject()) };
}

/** Used by the confirmation email: never throws, so a PDF problem cannot block the email. */
export async function tryIssueInvoiceForEmail(booking, { hotel, roomType }) {
  try {
    const invoice = await ensureInvoice(booking, { hotel, roomType });
    if (!invoice) return null;
    return {
      invoiceNumber: invoice.invoiceNumber,
      pdf: renderInvoicePdf(invoice.toObject()),
    };
  } catch (err) {
    console.error(
      "[Invoice] Could not issue invoice for email:",
      err?.message || err,
    );
    return null;
  }
}
