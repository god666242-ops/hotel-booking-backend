import mongoose from "mongoose";
import Razorpay from "razorpay";
import {
  isValidGstin,
  INVOICE_PREFIX_PATTERN,
} from "../../utils/invoiceMath.js";
import Hotel from "../../models/Hotel.js";
import User from "../../models/User.js";
import { encryptSecret, decryptSecret } from "../../services/crypto.service.js";

const MASK = "••••••••••••••••";

/**
 * Mask sensitive credentials before returning to client
 */
function maskHotelSecrets(hotelDoc) {
  const data = hotelDoc.toObject ? hotelDoc.toObject() : { ...hotelDoc };
  if (data.paymentConfig?.hotelRazorpay?.keySecretEncrypted) {
    data.paymentConfig.hotelRazorpay.keySecretEncrypted = MASK;
  }
  if (data.paymentConfig?.hotelRazorpay?.webhookSecretEncrypted) {
    data.paymentConfig.hotelRazorpay.webhookSecretEncrypted = MASK;
  }

  const bank = data.paymentConfig?.bankAccount;
  if (bank) {
    // Only the last 4 digits of the account number leave the server.
    if (bank.accountNumber) {
      bank.accountNumber = `••••${String(bank.accountNumber).slice(-4)}`;
    }
    delete bank.contactId;
    delete bank.fundAccountId;
  }
  return data;
}

const isMasked = (value) => typeof value === "string" && value.includes("•");

const TIME_PATTERN = /^\d{1,2}:\d{2}(\s?(AM|PM))?$/i;
const ADDRESS_KEYS = [
  "street",
  "city",
  "state",
  "country",
  "pincode",
  "mapEmbedUrl",
  "landmark",
];

const ALLOWED_CHARGE_TYPES = [
  "PER_STAY",
  "PER_NIGHT",
  "PER_GUEST",
  "PER_GUEST_PER_NIGHT",
  "PER_PERSON",
];

function sanitizeAddOnsList(addOns) {
  if (!Array.isArray(addOns)) return [];
  return addOns.map((addon) => ({
    ...(addon._id ? { _id: addon._id } : {}),
    name: String(addon.name || "").trim(),
    code: addon.code ? String(addon.code).trim() : undefined,
    description: addon.description ? String(addon.description).trim() : "",
    price: Math.max(0, Number(addon.price) || 0),
    chargeType: ALLOWED_CHARGE_TYPES.includes(addon.chargeType)
      ? addon.chargeType
      : "PER_STAY",
    isActive: addon.isActive !== false,
  }));
}

function sanitizePromoCodesList(promos, existingPromos = []) {
  if (!Array.isArray(promos)) return [];

  // Create a map to preserve live state (usedCount) from the DB
  const existingMap = new Map();
  existingPromos.forEach((ep) => {
    if (ep._id) {
      existingMap.set(String(ep._id), ep);
    }
  });

  return promos
    .filter((p) => p && typeof p.code === "string" && p.code.trim())
    .map((p) => {
      let preservedUsedCount = 0;
      if (p._id && existingMap.has(String(p._id))) {
        preservedUsedCount = existingMap.get(String(p._id)).usedCount || 0;
      }

      return {
        ...(p._id ? { _id: p._id } : {}),
        code: String(p.code).trim().toUpperCase(),
        description: String(p.description || "").trim(),
        discountType: ["PERCENT", "FLAT"].includes(p.discountType)
          ? p.discountType
          : "PERCENT",
        discountValue: Math.max(0, Number(p.discountValue) || 0),
        maxDiscountAmount:
          p.maxDiscountAmount != null && Number(p.maxDiscountAmount) >= 0
            ? Number(p.maxDiscountAmount)
            : null,
        minNights: Math.max(1, parseInt(p.minNights, 10) || 1),
        minOrderAmount: Math.max(0, Number(p.minOrderAmount) || 0),
        usageLimit:
          p.usageLimit != null && parseInt(p.usageLimit, 10) > 0
            ? parseInt(p.usageLimit, 10)
            : null,
        usedCount: preservedUsedCount, // Prevents stale admin saves from overwriting live counters
        validFrom: p.validFrom ? new Date(p.validFrom) : null,
        validTill: p.validTill ? new Date(p.validTill) : null,
        applicableRoomTypeIds: Array.isArray(p.applicableRoomTypeIds)
          ? p.applicableRoomTypeIds.filter((id) => mongoose.isValidObjectId(id))
          : [],
        isActive: p.isActive !== false,
      };
    });
}

function sanitizeRatePlansList(plans) {
  if (!Array.isArray(plans)) return [];
  return plans
    .filter((rp) => rp && typeof rp.name === "string" && rp.name.trim())
    .map((rp) => {
      const dType = ["PERCENT", "FLAT"].includes(rp.discountType)
        ? rp.discountType
        : "PERCENT";
      const dVal = Math.max(
        0,
        Number(
          rp.discountValue !== undefined
            ? rp.discountValue
            : rp.discountPercent || rp.discountAmount || 0,
        ),
      );

      return {
        ...(rp._id ? { _id: rp._id } : {}),
        name: String(rp.name).trim(),
        code: rp.code ? String(rp.code).trim().toUpperCase() : undefined,
        description: String(rp.description || "").trim(),
        isNonRefundable: Boolean(rp.isNonRefundable),
        discountType: dType,
        discountValue: dVal,
        discountPercent: dType === "PERCENT" ? dVal : 0,
        discountAmount: dType === "FLAT" ? dVal : 0,
        minStayNights: Math.max(
          1,
          parseInt(rp.minStayNights || rp.minNights, 10) || 1,
        ),
        minNights: Math.max(
          1,
          parseInt(rp.minStayNights || rp.minNights, 10) || 1,
        ),
        closedToArrival: false, // deprecated: closed-to-arrival is managed per date in Inventory
        mealsIncluded: Boolean(rp.mealsIncluded),
        earlyBirdDays: Math.max(0, parseInt(rp.earlyBirdDays, 10) || 0),
        isActive: rp.isActive !== false,
      };
    });
}

/**
 * GET /api/v1/admin/hotel
 */
export async function getHotelSettings(req, res, next) {
  try {
    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    return res
      .status(200)
      .json({ success: true, data: maskHotelSecrets(hotel) });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT/PATCH /api/v1/admin/hotel and /api/v1/admin/hotel/settings
 * Saves general hotel profile, promoCodes, integrations, and ratePlans.
 */
export async function updateHotelSettings(req, res, next) {
  try {
    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const {
      name,
      email,
      phone,
      description,
      tagline,
      checkInTime,
      checkOutTime,
      address,
      images,
      photos,
      propertyPhotos,
      socialLinks,
      addOns,
      combos,
      promoCodes,
      integrations,
      ratePlans,
    } = req.body;

    if (name !== undefined) hotel.name = String(name).trim();
    if (email !== undefined) {
      hotel.set("contact.email", String(email).trim().toLowerCase());
    }
    if (phone !== undefined) {
      hotel.set("contact.phone", String(phone).trim());
    }
    if (description !== undefined) hotel.description = String(description);
    if (tagline !== undefined) hotel.tagline = String(tagline);

    for (const [field, value] of [
      ["checkInTime", checkInTime],
      ["checkOutTime", checkOutTime],
    ]) {
      if (value === undefined) continue;
      if (!TIME_PATTERN.test(String(value).trim())) {
        return res.status(400).json({
          success: false,
          message: `${field} must look like 14:00 or 02:00 PM.`,
        });
      }
      hotel[field] = String(value).trim();
    }

    if (address && typeof address === "object") {
      for (const key of ADDRESS_KEYS) {
        if (address[key] !== undefined && typeof address[key] === "string") {
          hotel.set(`address.${key}`, address[key].trim());
        }
      }
    }

    if (Array.isArray(images)) hotel.images = images;
    if (Array.isArray(photos)) hotel.photos = photos;
    if (Array.isArray(propertyPhotos)) hotel.propertyPhotos = propertyPhotos;

    if (socialLinks && typeof socialLinks === "object") {
      hotel.socialLinks = { ...hotel.socialLinks, ...socialLinks };
    }

    if (Array.isArray(addOns)) {
      hotel.addOns = sanitizeAddOnsList(addOns);
    }

    if (Array.isArray(combos)) {
      hotel.combos = combos;
    }

    // Persist promo codes, passing existing ones to prevent counter overwrite
    if (Array.isArray(promoCodes)) {
      hotel.promoCodes = sanitizePromoCodesList(promoCodes, hotel.promoCodes);
    }

    // Persist ad & analytics tracking integrations
    if (integrations && typeof integrations === "object") {
      hotel.integrations = {
        metaPixelId: String(
          integrations.metaPixelId || integrations.pixelId || "",
        ).trim(),
        ga4MeasurementId: String(
          integrations.ga4MeasurementId || integrations.ga4Id || "",
        ).trim(),
        googleTagManagerId: String(
          integrations.googleTagManagerId || integrations.gtmId || "",
        ).trim(),
      };
    }

    // Persist rate plans
    if (Array.isArray(ratePlans)) {
      hotel.ratePlans = sanitizeRatePlansList(ratePlans);
    }

    await hotel.save();

    return res.status(200).json({
      success: true,
      message: "Settings updated successfully.",
      data: maskHotelSecrets(hotel),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v1/admin/hotel/addons
 */
export async function updateHotelAddOns(req, res, next) {
  try {
    const { addOns } = req.body;
    if (!Array.isArray(addOns)) {
      return res
        .status(400)
        .json({ success: false, message: "addOns array is required." });
    }

    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    hotel.addOns = sanitizeAddOnsList(addOns);
    await hotel.save();

    return res.status(200).json({
      success: true,
      message: "Stay add-ons updated successfully.",
      data: hotel.addOns,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v1/admin/hotel/gateway
 */
export async function updatePaymentGateway(req, res, next) {
  try {
    const { mode, keyId, keySecret, webhookSecret, currentPassword } =
      req.body || {};

    if (!["HOTEL_GATEWAY", "PAY_AT_HOTEL"].includes(mode)) {
      return res.status(400).json({
        success: false,
        message: "mode must be HOTEL_GATEWAY or PAY_AT_HOTEL.",
      });
    }

    if (typeof currentPassword !== "string" || !currentPassword) {
      return res.status(400).json({
        success: false,
        message: "Please confirm your password to change payment settings.",
      });
    }

    const account = await User.findById(req.user._id).select("+password");
    if (!account || !(await account.comparePassword(currentPassword))) {
      return res
        .status(403)
        .json({ success: false, message: "Password confirmation failed." });
    }

    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    if (!hotel.paymentConfig) hotel.paymentConfig = {};
    if (!hotel.paymentConfig.hotelRazorpay)
      hotel.paymentConfig.hotelRazorpay = {};

    if (mode === "HOTEL_GATEWAY") {
      const cfg = hotel.paymentConfig.hotelRazorpay;
      const clean = (v) =>
        typeof v === "string" && v.trim() && !isMasked(v) ? v.trim() : null;

      const newKeyId = clean(keyId);
      const newSecret = clean(keySecret);
      const newWebhook = clean(webhookSecret);

      if (newKeyId) cfg.keyId = newKeyId;
      if (newSecret) cfg.keySecretEncrypted = encryptSecret(newSecret);
      if (newWebhook) cfg.webhookSecretEncrypted = encryptSecret(newWebhook);

      if (!cfg.keyId || !cfg.keySecretEncrypted) {
        return res.status(400).json({
          success: false,
          message:
            "Razorpay Key ID and Key Secret are required for your own gateway.",
        });
      }
      if (!cfg.webhookSecretEncrypted) {
        return res.status(400).json({
          success: false,
          message:
            "Webhook secret is required. Add the webhook in your Razorpay dashboard first, then paste its secret here.",
        });
      }
      if (
        process.env.NODE_ENV === "production" &&
        String(cfg.keyId).startsWith("rzp_test_")
      ) {
        return res.status(400).json({
          success: false,
          message: "Please use your live Razorpay keys (rzp_live_...).",
        });
      }

      // Prove the keys work before saving them.
      if (newKeyId || newSecret) {
        try {
          const secretPlain =
            newSecret || decryptSecret(cfg.keySecretEncrypted);
          const rzp = new Razorpay({
            key_id: cfg.keyId,
            key_secret: secretPlain,
          });
          await rzp.payments.all({ count: 1 });
        } catch (err) {
          const authFailed = err?.statusCode === 401 || err?.statusCode === 400;
          return res.status(authFailed ? 400 : 502).json({
            success: false,
            message: authFailed
              ? "Razorpay rejected these keys. Please re-check the Key ID and Key Secret."
              : "Could not reach Razorpay to verify the keys. Please try again.",
          });
        }
      }

      hotel.paymentConfig.mode = "HOTEL_GATEWAY";
    } else {
      hotel.paymentConfig.mode = "PAY_AT_HOTEL";
    }

    await hotel.save();
    return res.status(200).json({
      success: true,
      message: "Payment configuration updated.",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v1/admin/hotel/policies
 * Update day-wise cancellation policy slabs AND custom Rate Plans
 */
export async function updateCancellationPolicy(req, res, next) {
  try {
    const { enabled, tiers, ratePlans } = req.body;
    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    if (typeof enabled === "boolean") {
      hotel.cancellationPolicy.enabled = enabled;
    }

    if (req.body.cutoffHours !== undefined) {
      const hours = Number(req.body.cutoffHours);
      if (!Number.isFinite(hours) || hours < 0 || hours > 72) {
        return res.status(400).json({
          success: false,
          message: "cutoffHours must be between 0 and 72.",
        });
      }
      hotel.cancellationPolicy.cutoffHours = Math.floor(hours);
    }

    if (Array.isArray(tiers)) {
      hotel.cancellationPolicy.tiers = tiers.map((tier) => ({
        daysBeforeCheckIn: Math.max(0, Number(tier.daysBeforeCheckIn) || 0),
        refundPercent: Math.min(
          100,
          Math.max(0, Number(tier.refundPercent) || 0),
        ),
      }));
    }

    // Persist custom rate plans from policies screen
    if (Array.isArray(ratePlans)) {
      hotel.ratePlans = sanitizeRatePlansList(ratePlans);
    }

    await hotel.save();
    return res.status(200).json({
      success: true,
      message: "Policies and rate plans updated successfully.",
      data: {
        cancellationPolicy: hotel.cancellationPolicy,
        ratePlans: hotel.ratePlans,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v1/admin/hotel/taxes
 */
export async function updateTaxSettings(req, res, next) {
  try {
    const {
      gstEnabled,
      taxPercent,
      useSlab,
      tierThreshold,
      rateBelowThreshold,
      rateAboveThreshold,
    } = req.body;
    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    hotel.taxConfig = {
      ...hotel.taxConfig,
      gstEnabled:
        typeof gstEnabled === "boolean"
          ? gstEnabled
          : hotel.taxConfig.gstEnabled,
      taxPercent:
        taxPercent !== undefined
          ? Math.max(0, Number(taxPercent))
          : hotel.taxConfig.taxPercent,
      useSlab: typeof useSlab === "boolean" ? useSlab : hotel.taxConfig.useSlab,
      tierThreshold:
        tierThreshold !== undefined
          ? Math.max(0, Number(tierThreshold))
          : hotel.taxConfig.tierThreshold,
      rateBelowThreshold:
        rateBelowThreshold !== undefined
          ? Math.max(0, Number(rateBelowThreshold))
          : hotel.taxConfig.rateBelowThreshold,
      rateAboveThreshold:
        rateAboveThreshold !== undefined
          ? Math.max(0, Number(rateAboveThreshold))
          : hotel.taxConfig.rateAboveThreshold,
    };

    await hotel.save();
    return res.status(200).json({
      success: true,
      message: "Tax settings updated.",
      data: hotel.taxConfig,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v1/admin/hotel/trust-content
 */
export async function updateHotelTrustContent(req, res, next) {
  try {
    const {
      announcement,
      topReasonsToBook,
      topAmenities,
      helpfulFacts,
      languagesSpoken,
      propertyPolicies,
      faqs,
      address,
    } = req.body;

    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    if (announcement !== undefined) hotel.announcement = announcement;
    if (Array.isArray(topReasonsToBook)) {
      hotel.topReasonsToBook = topReasonsToBook.filter(Boolean);
    }
    if (Array.isArray(topAmenities)) {
      hotel.topAmenities = topAmenities.filter(Boolean);
    }
    if (helpfulFacts && typeof helpfulFacts === "object") {
      hotel.helpfulFacts = { ...hotel.helpfulFacts, ...helpfulFacts };
    }
    if (Array.isArray(languagesSpoken)) {
      hotel.languagesSpoken = languagesSpoken.filter(Boolean);
    }
    if (Array.isArray(propertyPolicies)) {
      hotel.propertyPolicies = propertyPolicies.filter(Boolean);
    }
    if (Array.isArray(faqs)) hotel.faqs = faqs;
    if (address && typeof address === "object") {
      hotel.address = { ...hotel.address, ...address };
    }

    await hotel.save();

    return res.status(200).json({
      success: true,
      message: "Property content and trust details updated successfully.",
      data: maskHotelSecrets(hotel),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/v1/admin/hotel/legal
 */
export async function updateLegalSettings(req, res, next) {
  try {
    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const b = req.body || {};
    const text = (v, max) =>
      typeof v === "string" ? v.trim().slice(0, max) : undefined;
    const legal = { ...(hotel.legal?.toObject?.() || hotel.legal || {}) };

    const legalName = text(b.legalName, 150);
    if (legalName !== undefined) legal.legalName = legalName;

    if (b.gstin !== undefined) {
      const gstin = String(b.gstin || "")
        .trim()
        .toUpperCase();
      if (gstin && !isValidGstin(gstin)) {
        return res.status(400).json({
          success: false,
          message:
            "That GSTIN does not look right. It must be 15 characters with a valid check digit.",
        });
      }
      legal.gstin = gstin;
    }

    if (b.invoicePrefix !== undefined) {
      const prefix = String(b.invoicePrefix || "")
        .trim()
        .toUpperCase();
      if (!INVOICE_PREFIX_PATTERN.test(prefix)) {
        return res.status(400).json({
          success: false,
          message:
            "Invoice prefix must be 1-4 letters or digits (GST invoice numbers are limited to 16 characters).",
        });
      }
      legal.invoicePrefix = prefix;
    }

    for (const key of ["termsUrl", "privacyUrl"]) {
      if (b[key] === undefined) continue;
      const url = text(b[key], 500);
      if (url && !/^https:\/\/[^\s]+$/i.test(url)) {
        return res.status(400).json({
          success: false,
          message: "Terms and privacy links must start with https://",
        });
      }
      legal[key] = url;
    }
    for (const key of ["termsVersion", "privacyVersion"]) {
      if (b[key] === undefined) continue;
      const v = text(b[key], 30);
      if (!v) {
        return res.status(400).json({
          success: false,
          message: "Version labels cannot be empty.",
        });
      }
      legal[key] = v;
    }

    hotel.legal = legal;
    await hotel.save();
    return res.status(200).json({
      success: true,
      message: "Legal details saved.",
      data: hotel.legal,
    });
  } catch (error) {
    next(error);
  }
}
