// backend/src/models/CommissionInvoice.js
import mongoose from "mongoose";

const LineSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    bookingCode: { type: String, default: "" },
    checkIn: { type: Date },
    checkOut: { type: Date },
    commissionBase: { type: Number, default: 0 },
    percent: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
  },
  { _id: false },
);

const CommissionInvoiceSchema = new mongoose.Schema(
  {
    hotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hotel",
      required: true,
      index: true,
    },
    invoiceNumber: { type: String, required: true, unique: true },

    // periodEnd is exclusive (the following Monday, stored as UTC midnight)
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    lines: { type: [LineSchema], default: [] },
    bookingCount: { type: Number, default: 0 },

    commissionBase: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    totalDue: { type: Number, required: true },

    status: {
      type: String,
      enum: ["PENDING", "OVERDUE", "PAID", "WAIVED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    dueDate: { type: Date, required: true },
    paidAt: { type: Date, default: null },
    paidPaymentId: { type: String, default: null },

    razorpayPaymentLinkId: { type: String, default: null, index: true },
    paymentLinkUrl: { type: String, default: null },
    linkError: { type: String, default: null },

    remindersSent: { type: Number, default: 0 },
    lastReminderAt: { type: Date, default: null },

    // true when this invoice caused the hotel to be switched off for non-payment
    suspendedHotel: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// One invoice per hotel per week. Makes the weekly job safe to re-run.
CommissionInvoiceSchema.index({ hotelId: 1, periodStart: 1 }, { unique: true });
CommissionInvoiceSchema.index({ status: 1, dueDate: 1 });

export default mongoose.model("CommissionInvoice", CommissionInvoiceSchema);