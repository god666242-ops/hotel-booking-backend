import mongoose from "mongoose";

const LineSchema = new mongoose.Schema(
  { description: String, sac: String, amount: Number },
  { _id: false },
);

/**
 * Immutable snapshot of what was billed, so a later change to the hotel's
 * GSTIN or address never rewrites an invoice that was already issued.
 */
const InvoiceSchema = new mongoose.Schema(
  {
    hotelId: { type: mongoose.Schema.Types.ObjectId, ref: "Hotel", required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
    bookingCode: { type: String, required: true },
    invoiceNumber: { type: String, required: true },
    financialYear: { type: String, required: true },
    docType: { type: String, enum: ["TAX_INVOICE", "BILL_OF_SUPPLY", "RECEIPT"], required: true },
    issuedAt: { type: Date, required: true },

    seller: {
      legalName: String,
      tradeName: String,
      gstin: String,
      stateCode: String,
      address: String,
      phone: String,
      email: String,
    },
    buyer: { name: String, email: String, phone: String },
    placeOfSupply: { state: String, code: String },
    stay: {
      roomName: String,
      roomCount: Number,
      checkIn: Date,
      checkOut: Date,
      nights: Number,
      adults: Number,
      children: Number,
    },

    lines: [LineSchema],
    taxableValue: Number,
    gstRate: Number,
    cgst: Number,
    sgst: Number,
    invoiceValue: Number,
    platformFee: { type: Number, default: 0 },
    platform: { name: String, gstin: String },
    amountPaid: Number,
    amountDue: { type: Number, default: 0 },
    paymentSummary: String,

    status: { type: String, enum: ["ACTIVE", "CANCELLED"], default: "ACTIVE" },
    cancelledAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0 },

    // Issued when a TAX_INVOICE is cancelled after issue (GST credit note).
    creditNoteNumber: { type: String, default: null },
    creditNoteIssuedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

InvoiceSchema.index({ hotelId: 1, invoiceNumber: 1 }, { unique: true });
InvoiceSchema.index(
  { hotelId: 1, creditNoteNumber: 1 },
  { unique: true, partialFilterExpression: { creditNoteNumber: { $type: "string" } } },
);

export default mongoose.model("Invoice", InvoiceSchema);
