import mongoose from "mongoose";

const SelectedAddOnSchema = new mongoose.Schema(
  {
    addOnId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    chargeType: {
      type: String,
      enum: [
        "PER_STAY",
        "PER_NIGHT",
        "PER_GUEST",
        "PER_GUEST_PER_NIGHT",
        "PER_PERSON",
      ],
      default: "PER_STAY",
    },
    subtotal: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false },
);

const BookingSchema = new mongoose.Schema(
  {
    bookingCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    hotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hotel",
      required: true,
      index: true,
    },
    roomTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: true,
    },
    roomCount: {
      type: Number,
      required: true,
      default: 1,
    },

    source: {
      type: String,
      enum: ["ONLINE", "PHONE", "WALK_IN"],
      default: "ONLINE",
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: { type: String, default: "", maxlength: 1000 },

    guest: {
      name: { type: String, required: true },
      email: {
        type: String,
        default: "",
        required: function () {
          return !this.source || this.source === "ONLINE";
        },
      },
      phone: { type: String, required: true },
    },

    dates: {
      checkIn: { type: Date, required: true },
      checkOut: { type: Date, required: true },
      nights: { type: Number, required: true },
    },

    occupancy: {
      adults: { type: Number, default: 2 },
      children: { type: Number, default: 0 },
    },

    // Promo Code & Rate Plan Audit Breakdown
    promotions: {
      promoCode: { type: String, default: null, uppercase: true },
      promoDiscountAmount: { type: Number, default: 0 },
      ratePlanId: { type: mongoose.Schema.Types.ObjectId, default: null },
      ratePlanName: { type: String, default: null },
      ratePlanDiscountAmount: { type: Number, default: 0 },
      totalDiscountAmount: { type: Number, default: 0 },
    },

    // Lifecycle Email Dispatch Tracking (Guarantees zero repeat emails)
    lifecycle: {
      preArrivalSentAt: { type: Date, default: null },
      welcomeCheckInSentAt: { type: Date, default: null },
      postStayReviewSentAt: { type: Date, default: null },
      abandonedHoldSentAt: { type: Date, default: null },
    },

    // Strict itemized billing
    billing: {
      roomBaseTariff: { type: Number, required: true },
      discountTotal: { type: Number, default: 0 },
      addOnsTotal: { type: Number, default: 0 },
      hotelGst: { type: Number, default: 0 },
      platformConvenienceFee: { type: Number, default: 0 },
      grandTotal: { type: Number, required: true },
    },

    selectedAddOns: [SelectedAddOnSchema],

    payment: {
      mode: {
        type: String,
        enum: ["HOTEL_GATEWAY", "PAY_AT_HOTEL", "PLATFORM_MANAGED", "OFFLINE"],
        required: true,
      },
      razorpayOrderId: {
        type: String,
        index: true,
        required: function () {
          return this.payment?.mode !== "OFFLINE";
        },
      },
      razorpayPaymentId: { type: String, default: null },
      razorpaySignature: { type: String, default: null },
      modificationPaymentIds: [{ type: String }],
      amountPaidOnline: { type: Number, default: 0 },
      // Pay-at-hotel split: the commission paid online now, and the rest due at the hotel
      amountPayableNow: { type: Number, default: 0 },
      amountDueAtHotel: { type: Number, default: 0 },
      status: {
        type: String,
        enum: ["PENDING", "PARTIAL", "PAID", "FAILED", "REFUNDED", "EXPIRED"],
        default: "PENDING",
      },
      offlinePayments: [
        {
          method: {
            type: String,
            enum: ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"],
            required: true,
          },
          amount: { type: Number, required: true, min: 0 },
          reference: { type: String, default: "" },
          receivedAt: { type: Date, default: Date.now },
          receivedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
          },
        },
      ],
    },

    offlineCommission: {
      percent: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
      status: {
        type: String,
        enum: ["NONE", "DUE", "WAIVED", "COLLECTED"],
        default: "NONE",
      },
    },
        // Commission tracking (weekly invoice for own-gateway hotels,
    // upfront commission for pay-at-hotel bookings)
    commission: {
      percent: { type: Number, default: 0 },
      base: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
      status: {
        type: String,
        enum: ["NONE", "INVOICED", "PAID", "WAIVED"],
        default: "NONE",
      },
      invoiceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CommissionInvoice",
        default: null,
      },
      billedAt: { type: Date, default: null },
    },

    consent: {
      acceptedAt: { type: Date, default: null },
      termsVersion: { type: String, default: null },
      privacyVersion: { type: String, default: null },
      termsUrl: { type: String, default: null },
      privacyUrl: { type: String, default: null },
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
    },

    checkedInAt: { type: Date, default: null },
    checkedOutAt: { type: Date, default: null },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    checkedOutBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    invoiceNumber: { type: String, default: null },

    reconciliation: {
      lastCheckedAt: { type: Date, default: null },
      checkCount: { type: Number, default: 0 },
      lastError: { type: String, default: null },
      needsManualReview: { type: Boolean, default: false },
    },

    cancellation: {
      isCancelled: { type: Boolean, default: false },
      cancelledAt: { type: Date, default: null },
      refundPercentApplied: { type: Number, default: null },
      amountRefunded: { type: Number, default: 0 },
      amountRetained: { type: Number, default: 0 },
      razorpayRefundId: { type: String, default: null },
      reason: { type: String, default: null },
    },

    status: {
      type: String,
      enum: [
        "HELD",
        "CONFIRMED",
        "CANCELLATION_IN_PROGRESS",
        "REHOLD_IN_PROGRESS",
        "CANCELLED",
        "CHECKED_IN",
        "COMPLETED",
        "EXPIRED",
        "EXPIRED_REFUNDED",
      ],
      default: "HELD",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

BookingSchema.index({ status: 1, updatedAt: 1 });
BookingSchema.index({
  status: 1,
  createdAt: 1,
  "reconciliation.lastCheckedAt": 1,
});
BookingSchema.index({
  status: 1,
  "dates.checkIn": 1,
  "lifecycle.preArrivalSentAt": 1,
});
BookingSchema.index({
  status: 1,
  "dates.checkOut": 1,
  "lifecycle.postStayReviewSentAt": 1,
});

BookingSchema.index({
  hotelId: 1,
  "payment.mode": 1,
  "commission.billedAt": 1,
  "dates.checkOut": 1,
});

export default mongoose.model("Booking", BookingSchema);
