import mongoose from "mongoose";
import Razorpay from "razorpay";
import Hotel from "../../models/Hotel.js";
import RoomType from "../../models/RoomType.js";
import DailyInventory from "../../models/DailyInventory.js";
import Booking from "../../models/Booking.js";
import {
  holdRoomInventory,
  releaseRoomInventory,
  setRedisHoldLock,
  removeRedisHoldLock,
} from "../../services/inventory.service.js";
import { generateUniqueBookingCode } from "../../utils/bookingCode.js";
import { calculatePricingBreakdown } from "../../services/pricing.service.js";
import { decryptSecret } from "../../services/crypto.service.js";
import { verifyTurnstileToken } from "../../utils/turnstile.js";
import {
  MODE_GATEWAY,
  MODE_PAY_AT_HOTEL,
  getCommissionPercent,
  calculatePayAtHotelSplit,
} from "../../services/commission.service.js";

// Standard 15-character GSTIN format: 2 digits (State) + 10 chars (PAN) + 1 digit (entity) + 'Z' + 1 checksum char
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Extracts client IP securely using Express's trust-proxy resolution
 */
function extractClientIp(req) {
  return req.ip || req.socket?.remoteAddress || "127.0.0.1";
}

/**
 * POST /api/v1/public/:hotelSlug/hold
 * Atomically locks dates, creates Booking in 'HELD' status, and returns Razorpay Order ID.
 */
export async function initiateBookingHold(req, res, next) {
  const { turnstileToken } = req.body;
  const clientIp = extractClientIp(req);

  const turnstileCheck = await verifyTurnstileToken(turnstileToken, clientIp);
  if (!turnstileCheck.success) {
    return res.status(403).json({
      success: false,
      message: turnstileCheck.message || "Bot verification failed.",
      errorCodes: turnstileCheck.errorCodes || [],
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  let createdBooking = null;
  let lockedHotelId = null;
  let lockedRoomTypeId = null;
  let lockedCount = 1;
  let checkInDate = null;
  let checkOutDate = null;
  let appliedPromoDoc = null;

  try {
    const { hotelSlug } = req.params;
    const {
      roomTypeId,
      isCombo = false,
      comboId = null,
      checkIn,
      checkOut,
      roomCount = 1,
      adults = 2,
      children = 0,
      guest,
      selectedAddOns = [],
      consent = null,
      promoCode = null,
      ratePlanId = null,
      ratePlan = null,
    } = req.body;

    const count = parseInt(roomCount, 10);
    const parsedAdults = parseInt(adults, 10);
    const parsedChildren = parseInt(children, 10);

    if (consent?.accepted !== true) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Please accept the terms and privacy policy to continue.",
      });
    }

    if (isNaN(count) || count < 1 || count > 50) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Invalid room count. Must be between 1 and 50.",
      });
    }

    if (isNaN(parsedAdults) || parsedAdults < 1) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Invalid guest count: at least 1 adult required.",
      });
    }

    if (isNaN(parsedChildren) || parsedChildren < 0) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Invalid children count." });
    }

    if (
      !checkIn ||
      !checkOut ||
      !guest?.name ||
      !guest?.email ||
      !guest?.phone
    ) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Missing required guest or booking information.",
      });
    }

    checkInDate = new Date(`${checkIn}T00:00:00.000Z`);
    checkOutDate = new Date(`${checkOut}T00:00:00.000Z`);

    if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format." });
    }

    const nights = Math.round(
      (checkOutDate - checkInDate) / (1000 * 60 * 60 * 24),
    );
    if (nights <= 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Check-out date must be after check-in date.",
      });
    }

    const MAX_NIGHTS = 60;
    if (nights > MAX_NIGHTS) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Stays are limited to ${MAX_NIGHTS} nights.`,
      });
    }

    const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    if (checkInDate.toISOString().slice(0, 10) < todayIst) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Check-in date cannot be in the past.",
      });
    }

    const hotel = await Hotel.findOne({
      slug: hotelSlug,
      isActive: true,
    }).session(session);

    if (!hotel) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const hotelGstin = (hotel.legal?.gstin || "").trim().toUpperCase();
    if (!hotelGstin || !GSTIN_REGEX.test(hotelGstin)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message:
          "Online bookings for this property are temporarily unavailable pending GST tax profile verification.",
      });
    }

    // ── SECURE RATE PLAN LOOKUP (Zero trust of client-supplied discount payload) ──
    const targetPlanId =
      ratePlanId ||
      (typeof ratePlan === "object" && ratePlan !== null
        ? ratePlan.id || ratePlan._id
        : typeof ratePlan === "string"
          ? ratePlan
          : null);

    let verifiedRatePlan = null;
    if (targetPlanId) {
      const foundPlan = hotel.ratePlans?.find(
        (rp) =>
          String(rp._id || rp.id) === String(targetPlanId) &&
          rp.isActive !== false,
      );

      if (!foundPlan) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Selected rate plan is invalid or inactive.",
        });
      }

      // Enforce rate plan minimum stay
      const minNights = foundPlan.minStayNights || foundPlan.minNights || 1;
      if (minNights && nights < minNights) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `The ${foundPlan.name} requires a minimum stay of ${minNights} nights.`,
        });
      }

      // Enforce early-bird booking window if configured
      if (foundPlan.earlyBirdDays && foundPlan.earlyBirdDays > 0) {
        const leadDays = Math.floor(
          (checkInDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );
        if (leadDays < foundPlan.earlyBirdDays) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: `The ${foundPlan.name} requires booking at least ${foundPlan.earlyBirdDays} days in advance.`,
          });
        }
      }

      // Strictly build rate plan from database fields only — discard client payload
      verifiedRatePlan = {
        id: foundPlan._id,
        name: foundPlan.name,
        code: foundPlan.code,
        isNonRefundable: Boolean(foundPlan.isNonRefundable),
        discountType:
          foundPlan.discountType ||
          (foundPlan.discountPercent ? "PERCENT" : "FLAT"),
        discountValue: Number(
          foundPlan.discountValue !== undefined
            ? foundPlan.discountValue
            : foundPlan.discountPercent || foundPlan.discountAmount || 0,
        ),
        mealsIncluded: Boolean(foundPlan.mealsIncluded),
      };
    }

    // ── STRICT PROMO CODE USAGE LIMIT VALIDATION ──
    if (promoCode) {
      const codeClean = String(promoCode).trim().toUpperCase();
      const promoDoc = hotel.promoCodes?.find(
        (p) => p.code === codeClean && p.isActive !== false,
      );

      if (!promoDoc) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(400)
          .json({ success: false, message: "Invalid or inactive promo code." });
      }

      const now = new Date();
      if (promoDoc.validFrom && new Date(promoDoc.validFrom) > now) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(400)
          .json({ success: false, message: "Promo code is not yet active." });
      }
      if (promoDoc.validTill && new Date(promoDoc.validTill) < now) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(400)
          .json({ success: false, message: "Promo code has expired." });
      }
      if (
        promoDoc.usageLimit != null &&
        (promoDoc.usedCount || 0) >= promoDoc.usageLimit
      ) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Promo code usage limit has been reached.",
        });
      }

      appliedPromoDoc = promoDoc;
    }

    let targetRoomTypeId = roomTypeId;
    let appliedCombo = null;

    if (isCombo) {
      appliedCombo = hotel.combos?.find(
        (c) =>
          (comboId && c._id?.toString() === comboId.toString()) ||
          (!comboId && c.isActive),
      );

      if (!appliedCombo && !roomTypeId) {
        const fallbackRoom = await RoomType.findOne({
          hotelId: hotel._id,
          isComboPackage: true,
          isActive: true,
        }).session(session);

        if (fallbackRoom) {
          targetRoomTypeId = fallbackRoom._id;
        } else {
          const firstRoom = await RoomType.findOne({
            hotelId: hotel._id,
            isActive: true,
          })
            .sort({ sortOrder: 1 })
            .session(session);
          if (firstRoom) targetRoomTypeId = firstRoom._id;
        }
      } else if (appliedCombo && appliedCombo.roomTypeId) {
        targetRoomTypeId = appliedCombo.roomTypeId;
      }
    }

    if (!targetRoomTypeId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Target room type could not be resolved.",
      });
    }

    const room = await RoomType.findOne({
      _id: targetRoomTypeId,
      hotelId: hotel._id,
      isActive: true,
    }).session(session);

    if (!room) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "Room type not found or inactive." });
    }

    const totalGuests = parsedAdults + parsedChildren;
    const effectiveRoomCount =
      isCombo && appliedCombo?.totalRooms ? appliedCombo.totalRooms : count;

    const maxAllowedCapacity =
      isCombo && appliedCombo?.maxOccupancy
        ? appliedCombo.maxOccupancy
        : (room.maxOccupancy || 2) * effectiveRoomCount;

    if (totalGuests > maxAllowedCapacity) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Total guests (${totalGuests}) exceed maximum capacity (${maxAllowedCapacity}).`,
      });
    }

    const addOnCatalog = [
      ...(Array.isArray(hotel.addOns) ? hotel.addOns : []),
      ...(Array.isArray(room.addOns) ? room.addOns : []),
    ];

    const validatedAddOns = [];
    if (Array.isArray(selectedAddOns) && selectedAddOns.length > 0) {
      for (const item of selectedAddOns) {
        const itemCodeOrId = item.code || item.addOnId || item._id || item.name;
        const catalogAddon = addOnCatalog.find(
          (a) =>
            (a._id && a._id.toString() === String(itemCodeOrId)) ||
            (a.code && a.code === itemCodeOrId) ||
            (a.name &&
              a.name.toLowerCase() === String(item.name || "").toLowerCase()),
        );

        if (catalogAddon && catalogAddon.isActive !== false) {
          const qty = Math.max(
            1,
            Math.min(20, parseInt(item.quantity, 10) || 1),
          );
          validatedAddOns.push({
            addOnId: catalogAddon._id,
            name: catalogAddon.name,
            price: Number(catalogAddon.price),
            chargeType: catalogAddon.chargeType || "PER_STAY",
            quantity: qty,
          });
        }
      }
    }

    const overrides = await DailyInventory.find({
      hotelId: hotel._id,
      roomTypeId: room._id,
      date: { $gte: checkInDate, $lt: checkOutDate },
    }).session(session);

    const overrideMap = new Map();
    overrides.forEach((doc) => {
      const dateKey = new Date(doc.date).toISOString().split("T")[0];
      overrideMap.set(dateKey, doc);
    });

    const dailyInventories = [];
    const defaultPrice = Number(room.basePrice ?? 0);
    const defaultTotalRooms = Number(
      room.totalInventory ?? room.totalRooms ?? room.totalUnits ?? 1,
    );

    for (let i = 0; i < nights; i++) {
      const dayDate = new Date(checkInDate.getTime() + i * 24 * 60 * 60 * 1000);
      const dateKey = dayDate.toISOString().split("T")[0];
      const customDay = overrideMap.get(dateKey);

      if (customDay?.isBlocked) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `The room is unavailable on ${dateKey}.`,
        });
      }

      // Enforce daily closedToArrival
      if (i === 0 && customDay?.closedToArrival) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Check-in is closed on ${dateKey}.`,
        });
      }

      // Enforce daily minStay override
      if (customDay?.minStay && nights < customDay.minStay) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `A minimum stay of ${customDay.minStay} nights is required starting on ${dateKey}.`,
        });
      }

      dailyInventories.push({
        date: dayDate,
        price: customDay?.price !== undefined ? customDay.price : defaultPrice,
        availableRooms:
          customDay?.availableRooms !== undefined
            ? customDay.availableRooms
            : defaultTotalRooms,
      });
    }

    const holdResult = await holdRoomInventory({
      hotelId: hotel._id,
      roomTypeId: room._id,
      checkInDate,
      checkOutDate,
      roomCount: count,
      session,
    });

    if (!holdResult.success) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message:
          holdResult.message ||
          "Rooms are no longer available for the selected dates.",
      });
    }

    lockedHotelId = hotel._id;
    lockedRoomTypeId = room._id;
    lockedCount = count;

    // Pricing calculation strictly using verifiedRatePlan
    const pricing = calculatePricingBreakdown({
      dailyInventories,
      roomCount: count,
      totalGuests,
      addOns: validatedAddOns,
      hotel,
      roomType: room,
      isCombo: Boolean(isCombo),
      comboDetails: appliedCombo,
      promoCode: appliedPromoDoc ? appliedPromoDoc.code : null,
      ratePlan: verifiedRatePlan,
    });

    // Atomically increment promo usage counter within the active transaction
    if (appliedPromoDoc) {
      const incFilter = {
        _id: hotel._id,
        "promoCodes._id": appliedPromoDoc._id,
      };

      if (appliedPromoDoc.usageLimit != null) {
        incFilter["promoCodes.usedCount"] = { $lt: appliedPromoDoc.usageLimit };
      }

      const incResult = await Hotel.updateOne(
        incFilter,
        { $inc: { "promoCodes.$.usedCount": 1 } },
        { session },
      );

      if (incResult.matchedCount === 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message:
            "Promo code reached its maximum usage limit during checkout.",
        });
      }
    }

    const bookingCode = await generateUniqueBookingCode(session);

    const wantsHotelGateway = hotel.paymentConfig?.mode === "HOTEL_GATEWAY";
    const isHotelGateway =
      wantsHotelGateway &&
      Boolean(hotel.paymentConfig?.hotelRazorpay?.keyId) &&
      Boolean(hotel.paymentConfig?.hotelRazorpay?.keySecretEncrypted);

    // A gateway hotel with broken keys must never fall back to YOUR account.
    if (wantsHotelGateway && !isHotelGateway) {
      await session.abortTransaction();
      session.endSession();
      return res.status(503).json({
        success: false,
        message:
          "Online payments for this property are temporarily unavailable.",
      });
    }

    // Pay-at-hotel: the guest pays only the commission now and the rest at the hotel.
    const commissionPercent = getCommissionPercent(
      hotel,
      isHotelGateway ? MODE_GATEWAY : MODE_PAY_AT_HOTEL,
    );
    const payAtHotelSplit = isHotelGateway
      ? null
      : calculatePayAtHotelSplit({ billing: pricing, percent: commissionPercent });
    const amountPayableNow = isHotelGateway
      ? pricing.grandTotal
      : payAtHotelSplit.amountPayableNow;
    const amountDueAtHotel = isHotelGateway ? 0 : payAtHotelSplit.amountDueAtHotel;

    const rzpKeyId = isHotelGateway
      ? hotel.paymentConfig.hotelRazorpay.keyId
      : process.env.MASTER_RAZORPAY_KEY_ID;

    const rzpSecret = isHotelGateway
      ? decryptSecret(hotel.paymentConfig.hotelRazorpay.keySecretEncrypted)
      : process.env.MASTER_RAZORPAY_KEY_SECRET;

    if (!rzpKeyId || !rzpSecret) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json({
        success: false,
        message: "Payment gateway credentials are not configured properly.",
      });
    }

    const newBooking = new Booking({
      bookingCode,
      hotelId: hotel._id,
      roomTypeId: room._id,
      roomCount: count,
      guest: {
        name: guest.name.trim(),
        email: guest.email.trim().toLowerCase(),
        phone: guest.phone.trim(),
      },
      dates: {
        checkIn: checkInDate,
        checkOut: checkOutDate,
        nights,
      },
      occupancy: {
        adults: parsedAdults,
        children: parsedChildren,
      },
      promotions: {
        promoCode: pricing.appliedPromo?.code || null,
        promoDiscountAmount: pricing.appliedPromo?.discountAmount || 0,
        ratePlanId: verifiedRatePlan?.id || null,
        ratePlanName: verifiedRatePlan?.name || null,
        ratePlanDiscountAmount: pricing.appliedRatePlan?.discountAmount || 0,
        totalDiscountAmount: pricing.discountTotal || 0,
      },
      lifecycle: {
        preArrivalSentAt: null,
        welcomeCheckInSentAt: null,
        postStayReviewSentAt: null,
        abandonedHoldSentAt: null,
      },
      billing: {
        roomBaseTariff: pricing.roomBaseTariff,
        discountTotal: pricing.discountTotal || 0,
        addOnsTotal: pricing.addOnsTotal,
        hotelGst: pricing.hotelGst,
        platformConvenienceFee: pricing.platformConvenienceFee,
        grandTotal: pricing.grandTotal,
      },
      selectedAddOns: pricing.calculatedAddOns || validatedAddOns,
      payment: {
        mode: isHotelGateway ? MODE_GATEWAY : MODE_PAY_AT_HOTEL,
        razorpayOrderId: "PENDING_CREATION",
        amountPaidOnline: 0,
        amountPayableNow,
        amountDueAtHotel,
        status: "PENDING",
      },
      commission: isHotelGateway
        ? { percent: commissionPercent, status: "NONE" }
        : {
            percent: commissionPercent,
            base: payAtHotelSplit.commissionBase,
            amount: payAtHotelSplit.amountPayableNow,
            status: "NONE",
          },
      consent: {
        acceptedAt: new Date(),
        termsVersion: hotel.legal?.termsVersion || "1",
        privacyVersion: hotel.legal?.privacyVersion || "1",
        termsUrl:
          hotel.legal?.termsUrl || process.env.PLATFORM_TERMS_URL || null,
        privacyUrl:
          hotel.legal?.privacyUrl || process.env.PLATFORM_PRIVACY_URL || null,
        ip: clientIp,
        userAgent: String(req.get("user-agent") || "").slice(0, 300) || null,
      },
      status: "HELD",
    });

    await newBooking.save({ session });
    await session.commitTransaction();
    session.endSession();

    createdBooking = newBooking;

    let rzpOrder;
    try {
      const rzp = new Razorpay({
        key_id: rzpKeyId,
        key_secret: rzpSecret,
      });

      rzpOrder = await rzp.orders.create({
        amount: Math.round(amountPayableNow * 100),
        currency: "INR",
        receipt: bookingCode,
        notes: {
          bookingCode,
          hotelSlug,
          hotelId: hotel._id.toString(),
        },
      });

      createdBooking.payment.razorpayOrderId = rzpOrder.id;
      await createdBooking.save();

      await setRedisHoldLock(createdBooking._id.toString(), {
        bookingCode,
        hotelId: hotel._id,
        roomTypeId: room._id,
        checkInDate,
        checkOutDate,
        roomCount: count,
      });
    } catch (gatewayErr) {
      console.error("[Razorpay Order Creation Failed]:", gatewayErr);

      const compSession = await mongoose.startSession();
      try {
        await compSession.withTransaction(async () => {
          const expired = await Booking.findOneAndUpdate(
            { _id: createdBooking._id, status: "HELD" },
            { $set: { status: "EXPIRED", "payment.status": "EXPIRED" } },
            { session: compSession },
          );
          if (!expired) return;

          if (appliedPromoDoc) {
            await Hotel.updateOne(
              { _id: lockedHotelId, "promoCodes._id": appliedPromoDoc._id },
              { $inc: { "promoCodes.$.usedCount": -1 } },
              { session: compSession },
            );
          }

          await releaseRoomInventory({
            hotelId: lockedHotelId,
            roomTypeId: lockedRoomTypeId,
            checkInDate,
            checkOutDate,
            roomCount: lockedCount,
            session: compSession,
          });
        });
      } catch (relErr) {
        console.error("[Compensating Release Failed]:", relErr);
      } finally {
        await compSession.endSession();
      }

      await removeRedisHoldLock(createdBooking._id.toString()).catch(() => {});

      return res.status(502).json({
        success: false,
        message: "Payment gateway order generation failed. Please try again.",
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        bookingId: createdBooking._id,
        bookingCode,
        razorpayOrderId: rzpOrder.id,
        razorpayKeyId: rzpKeyId,
        amount: amountPayableNow,
        grandTotal: pricing.grandTotal,
        amountDueAtHotel,
        payAtHotel: !isHotelGateway,
        currency: "INR",
        billingBreakdown: pricing,
        guest: createdBooking.guest,
      },
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    next(error);
  }
}

/**
 * POST /api/v1/public/:hotelSlug/release-hold
 */
export async function releaseBookingHold(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { hotelSlug } = req.params;
    const { bookingId, bookingCode } = req.body;

    const hotel = await Hotel.findOne({
      slug: hotelSlug,
      isActive: true,
    }).session(session);

    if (!hotel) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const query = { status: "HELD", hotelId: hotel._id };

    if (
      bookingId &&
      typeof bookingId === "string" &&
      mongoose.Types.ObjectId.isValid(bookingId)
    ) {
      query._id = new mongoose.Types.ObjectId(bookingId);
    } else if (bookingCode && typeof bookingCode === "string") {
      query.bookingCode = String(bookingCode).trim().toUpperCase();
    } else {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Valid bookingId or bookingCode required.",
      });
    }

    const booking = await Booking.findOneAndUpdate(
      query,
      { $set: { status: "EXPIRED" } },
      { session, new: false },
    );

    if (!booking) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(200)
        .json({ success: true, message: "No active hold found to release." });
    }

    if (booking.promotions?.promoCode) {
      await Hotel.updateOne(
        { _id: hotel._id, "promoCodes.code": booking.promotions.promoCode },
        { $inc: { "promoCodes.$.usedCount": -1 } },
        { session },
      );
    }

    await releaseRoomInventory({
      hotelId: booking.hotelId,
      roomTypeId: booking.roomTypeId,
      checkInDate: booking.dates.checkIn,
      checkOutDate: booking.dates.checkOut,
      roomCount: booking.roomCount,
      session,
    });

    await session.commitTransaction();
    session.endSession();

    await removeRedisHoldLock(booking._id.toString()).catch(() => {});

    return res
      .status(200)
      .json({ success: true, message: "Hold successfully released." });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    next(error);
  }
}
