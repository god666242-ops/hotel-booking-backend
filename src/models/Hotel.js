import mongoose from "mongoose";

const CancellationTierSchema = new mongoose.Schema(
  {
    daysBeforeCheckIn: { type: Number, required: true },
    refundPercent: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

const FaqItemSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
  },
  { _id: false },
);

const AddOnSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    price: { type: Number, required: true, min: 0 },
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
    description: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
);

const ComboRoomAllocationSchema = new mongoose.Schema(
  {
    roomTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: true,
    },
    roomCount: { type: Number, default: 1, min: 1 },
  },
  { _id: false },
);

const ComboPackageSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    roomTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "RoomType" },
    rooms: [ComboRoomAllocationSchema],
    packagePrice: { type: Number, min: 0 },
    discountPercent: { type: Number, min: 0, max: 100 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
);

// Promo code & coupon schema
const PromoCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    description: { type: String, default: "" },
    discountType: {
      type: String,
      enum: ["PERCENT", "FLAT"],
      required: true,
      default: "PERCENT",
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },
    maxDiscountAmount: {
      type: Number,
      default: null,
      min: 0,
    },
    minNights: {
      type: Number,
      default: 1,
      min: 1,
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    validFrom: { type: Date, default: null },
    validTill: { type: Date, default: null },
    usageLimit: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },
    applicableRoomTypeIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "RoomType",
      },
    ],
    isActive: { type: Boolean, default: true },
  },
  { _id: true, timestamps: true },
);

// Rate plan schema (e.g. Non-Refundable, Length of Stay, Breakfast Included)
const RatePlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, uppercase: true, trim: true },
    description: { type: String, default: "" },
    discountType: {
      type: String,
      enum: ["PERCENT", "FLAT"],
      default: "PERCENT",
    },
    discountValue: { type: Number, default: 0, min: 0 },
    // Backwards-compatibility aliases
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    isNonRefundable: { type: Boolean, default: false },
    minStayNights: { type: Number, default: 1, min: 1 },
    minNights: { type: Number, default: 1, min: 1 },
    closedToArrival: { type: Boolean, default: false },
    mealsIncluded: { type: Boolean, default: false },
    earlyBirdDays: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
);

const HotelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Hotel name is required"],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, "Slug is required for widget identification"],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    contact: {
      email: { type: String, required: true },
      phone: { type: String, required: true },
      whatsapp: { type: String },
    },
    address: {
      street: { type: String, default: "Beach Road, Near Light House" },
      city: { type: String, default: "Visakhapatnam" },
      state: { type: String, default: "Andhra Pradesh" },
      country: { type: String, default: "India" },
      pincode: { type: String, default: "530002" },
      mapEmbedUrl: {
        type: String,
        default:
          "https://maps.google.com/maps?q=Visakhapatnam+Beach&t=&z=13&ie=UTF8&iwloc=&output=embed",
      },
      landmark: { type: String, default: "200m from Beach Promenade" },
    },
    checkInTime: {
      type: String,
      default: "12:00",
    },
    checkOutTime: {
      type: String,
      default: "11:00",
    },

    // ──────────────────────────────────────────────
    // Add-ons, Combo Packages & Promo Catalogs
    // ──────────────────────────────────────────────
    addOns: {
      type: [AddOnSchema],
      default: [],
    },
    combos: {
      type: [ComboPackageSchema],
      default: [],
    },
    promoCodes: {
      type: [PromoCodeSchema],
      default: [],
    },
    ratePlans: {
      type: [RatePlanSchema],
      default: [],
    },

    // ──────────────────────────────────────────────
    // Tracking & Marketing Integrations
    // ──────────────────────────────────────────────
    integrations: {
      metaPixelId: { type: String, default: "", trim: true },
      ga4MeasurementId: { type: String, default: "", trim: true },
      googleTagManagerId: { type: String, default: "", trim: true },
    },

    // ──────────────────────────────────────────────
    // Dynamic Trust & Guest Information Fields
    // ──────────────────────────────────────────────
    announcement: {
      enabled: { type: Boolean, default: true },
      text: {
        type: String,
        default:
          "✨ Special Offer: Complimentary welcome drink & 15% off on in-house dining for all direct bookings!",
      },
    },

    topReasonsToBook: {
      type: [String],
      default: [
        "Best Rate Guarantee with Zero Booking Fees",
        "Direct Special Requests Priority Handling",
        "Complimentary High-Speed Wi-Fi & Welcome Drinks",
        "Flexible & Direct Modification Support",
      ],
    },

    topAmenities: {
      type: [String],
      default: [
        "Swimming Pool",
        "Multi-Cuisine Restaurant",
        "Free High-Speed Wi-Fi",
        "24/7 Room Service",
        "Free Valet Parking",
        "Air Conditioned Rooms",
        "Power Backup",
      ],
    },

    helpfulFacts: {
      numberOfRestaurants: { type: Number, default: 2 },
      numberOfFloors: { type: Number, default: 4 },
      totalRooms: { type: Number, default: 24 },
      airportDistanceKm: { type: String, default: "14 km (approx 25 mins)" },
      railwayStationDistanceKm: {
        type: String,
        default: "4.5 km (approx 12 mins)",
      },
      petFriendly: { type: Boolean, default: false },
      coupleFriendly: { type: Boolean, default: true },
    },

    languagesSpoken: {
      type: [String],
      default: ["English", "Hindi", "Telugu"],
    },

    propertyPolicies: {
      type: [String],
      default: [
        "Government-issued photo ID is mandatory for all adult guests.",
        "Primary guest must be at least 18 years of age to check-in.",
        "Smoking is strictly prohibited in all indoor room categories.",
        "Visitors are permitted in the lobby area between 9:00 AM and 8:00 PM only.",
      ],
    },

    faqs: {
      type: [FaqItemSchema],
      default: [
        {
          question: "What are the standard check-in and check-out timings?",
          answer:
            "Standard check-in time starts at 12:00 PM and check-out time is by 11:00 AM. Early check-in or late check-out is subject to room availability.",
        },
        {
          question: "Is breakfast included with direct reservations?",
          answer:
            "Complimentary buffet breakfast is included in select room rates or can be added as a stay add-on during checkout.",
        },
        {
          question: "Are unmarried couples allowed to book?",
          answer:
            "Yes, adult couples (18+ years) presenting valid government-issued ID proofs are warmly welcome.",
        },
        {
          question: "Is parking available on the property?",
          answer:
            "Yes, we provide complimentary on-site valet and self-parking for all resident guests.",
        },
      ],
    },

    // ──────────────────────────────────────────────
    // Payment & Business Configurations
    // ──────────────────────────────────────────────
    paymentConfig: {
      mode: {
        type: String,
        enum: ["HOTEL_GATEWAY", "PAY_AT_HOTEL"],
        default: "PAY_AT_HOTEL",
      },
      hotelRazorpay: {
        keyId: { type: String, default: null },
        keySecretEncrypted: { type: String, default: null },
        webhookSecretEncrypted: { type: String, default: null },
      },
      bankAccount: {
        beneficiaryName: { type: String, default: "" },
        accountHolderName: { type: String, default: "" },
        accountNumber: { type: String, default: "" },
        ifsc: { type: String, default: "" },
        ifscCode: { type: String, default: "" },
        bankName: { type: String, default: "" },
        accountType: { type: String, default: "CURRENT" },
        contactId: { type: String, default: null },
        fundAccountId: { type: String, default: null },
      },
      gatewayCommissionPercent: { type: Number, default: 5, min: 0, max: 100 },
      payAtHotelCommissionPercent: { type: Number, default: 8, min: 0, max: 100 },
      // Front-desk (walk-in/phone) bookings have no online payment, so you can't
      // collect commission on them. Default 0.
      offlineCommissionPercent: { type: Number, default: 0, min: 0, max: 100 },
      platformFeeFlat: { type: Number, default: 0 },
    },

    cancellationPolicy: {
      enabled: { type: Boolean, default: true },
      // Guests can cancel online only until this many hours before check-in.
      cutoffHours: { type: Number, default: 12, min: 0, max: 72 },
      tiers: {
        type: [CancellationTierSchema],
        default: [
          { daysBeforeCheckIn: 7, refundPercent: 100 },
          { daysBeforeCheckIn: 2, refundPercent: 50 },
          { daysBeforeCheckIn: 0, refundPercent: 0 },
        ],
      },
    },

    taxConfig: {
      gstEnabled: { type: Boolean, default: true },
      taxPercent: { type: Number, default: 12 },
      tierThreshold: { type: Number, default: 7500 },
      rateBelowThreshold: { type: Number, default: 12 },
      rateAboveThreshold: { type: Number, default: 18 },
      useSlab: { type: Boolean, default: false },
    },

    legal: {
      legalName: { type: String, default: "", trim: true },
      gstin: { type: String, default: "", uppercase: true, trim: true },
      invoicePrefix: {
        type: String,
        default: "INV",
        uppercase: true,
        trim: true,
      },
      termsUrl: { type: String, default: "", trim: true },
      privacyUrl: { type: String, default: "", trim: true },
      termsVersion: { type: String, default: "1", trim: true },
      privacyVersion: { type: String, default: "1", trim: true },
    },

    ical: {
      exportToken: { type: String, default: null, select: false },
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export default mongoose.model("Hotel", HotelSchema);
