import mongoose from "mongoose";
import Razorpay from "razorpay";
import crypto from "crypto";
import Booking from "../../models/Booking.js";
import Hotel from "../../models/Hotel.js";
import RoomType from "../../models/RoomType.js";
import DailyInventory from "../../models/DailyInventory.js";
import {
  evaluateCancellationRefund,
  evaluatePayAtHotelCancellation,
  getCheckInDeadline,
  getGuestCancellationCutoff,
  evaluateBookingModification,
} from "../../services/cancellation.service.js";
import { cancelConfirmedBooking } from "../../services/bookingCancellation.service.js";
import { sendCancellationNotice } from "../../services/notification.service.js";
import {
  buildInvoicePdf,
  buildCreditNotePdf,
  syncInvoiceAfterModification,
} from "../../services/invoice.service.js";
import {
  releaseRoomInventory,
  holdRoomInventory,
} from "../../services/inventory.service.js";
import { calculatePricingBreakdown } from "../../services/pricing.service.js";
import {
  getRazorpayClient,
  refundPaymentIdempotent,
} from "../../services/payment.service.js";
import { decryptSecret } from "../../services/crypto.service.js";
import { sendSystemAlert } from "../../utils/systemAlerts.js";

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function verifyRazorpaySignature({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = Buffer.from(
    crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex"),
  );
  const received = Buffer.from(String(signature));
  // timingSafeEqual throws on different lengths; a malformed signature must be
  // a clean "invalid" result, not a 500.
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

/**
 * GET /api/v1/public/:hotelSlug/bookings/:bookingCode?email=...
 */
export async function getGuestBookingDetails(req, res, next) {
  try {
    const { hotelSlug, bookingCode } = req.params;
    const email = normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email verification is required to view reservation details.",
      });
    }

    const hotel = await Hotel.findOne({
      slug: String(hotelSlug),
    })
      .select(
        "name slug contact address checkInTime checkOutTime cancellationPolicy ratePlans promoCodes",
      )
      .lean();

    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const booking = await Booking.findOne({
      bookingCode: String(bookingCode).trim().toUpperCase(),
      hotelId: hotel._id,
      "guest.email": email,
    }).lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message:
          "Reservation not found. Please verify your booking reference and email.",
      });
    }

    const roomType = await RoomType.findById(booking.roomTypeId)
      .select("name description photos amenities")
      .lean();

    const now = new Date();
    const isCheckInPassed =
      now.getTime() >= getCheckInDeadline(booking, hotel).getTime();
    const paymentStatus = String(booking.payment?.status || "").toUpperCase();
    const isPaymentSettled = ["PAID", "CAPTURED", "COMPLETED"].includes(
      paymentStatus,
    );

    const isOfflineBooking = booking.payment?.mode === "OFFLINE";
    const isPayAtHotel = booking.payment?.mode === "PAY_AT_HOTEL";
    const isCancelWindowClosed =
      now.getTime() >= getGuestCancellationCutoff(booking, hotel).getTime();
    const canCancel =
      booking.status === "CONFIRMED" &&
      !isCancelWindowClosed &&
      isPaymentSettled &&
      !isOfflineBooking;
    const canModify =
      booking.status === "CONFIRMED" &&
      !isCheckInPassed &&
      !isOfflineBooking &&
      !isPayAtHotel;

    const refundEvaluation = isPayAtHotel
      ? evaluatePayAtHotelCancellation(booking, {
          cancelledBy: "GUEST_SELF_SERVICE",
        })
      : evaluateCancellationRefund(booking, hotel, now);

    const cancellation = booking.cancellation?.isCancelled
      ? {
          isCancelled: true,
          cancelledAt: booking.cancellation.cancelledAt,
          refundPercentApplied: booking.cancellation.refundPercentApplied,
          amountRefunded: booking.cancellation.amountRefunded,
          amountRetained: booking.cancellation.amountRetained,
        }
      : undefined;

    return res.status(200).json({
      success: true,
      data: {
        booking: {
          bookingCode: booking.bookingCode,
          status: booking.status,
          guest: booking.guest,
          dates: booking.dates,
          occupancy: booking.occupancy,
          roomCount: booking.roomCount,
          billing: booking.billing,
          promotions: booking.promotions,
          selectedAddOns: booking.selectedAddOns || [],
          payment: {
            status: booking.payment?.status,
            mode: booking.payment?.mode,
            amountPaidOnline: isPayAtHotel
              ? booking.payment?.amountPayableNow || 0
              : booking.billing?.grandTotal,
            amountDueAtHotel: booking.payment?.amountDueAtHotel || 0,
          },
          cancellation,
          createdAt: booking.createdAt,
        },
        hotel: {
          name: hotel.name,
          slug: hotel.slug,
          contact: hotel.contact,
          address: hotel.address,
          checkInTime: hotel.checkInTime || "12:00",
          checkOutTime: hotel.checkOutTime || "11:00",
          cancellationPolicy: hotel.cancellationPolicy,
        },
        roomType: roomType || { name: "Standard Accommodation" },
        cancellation: {
          canCancel,
          canModify,
          isCheckInPassed,
          isCancelWindowClosed,
          cutoffHours: hotel.cancellationPolicy?.cutoffHours ?? 12,
          refundPreview: refundEvaluation,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/public/:hotelSlug/bookings/:bookingCode/modify-preview
 */
export async function previewGuestBookingModification(req, res, next) {
  try {
    const { hotelSlug, bookingCode } = req.params;
    const email = normalizeEmail(req.body?.email);
    const { checkIn, checkOut, roomTypeId, roomCount, adults, children } =
      req.body;

    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email verification is required." });

    const hotel = await Hotel.findOne({
      slug: String(hotelSlug),
      isActive: true,
    });
    if (!hotel)
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });

    const booking = await Booking.findOne({
      bookingCode: String(bookingCode).trim().toUpperCase(),
      hotelId: hotel._id,
      "guest.email": email,
      status: "CONFIRMED",
    });
    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Active booking not found." });

    const targetRoomTypeId = roomTypeId || booking.roomTypeId;
    const room = await RoomType.findOne({
      _id: targetRoomTypeId,
      hotelId: hotel._id,
      isActive: true,
    });
    if (!room)
      return res
        .status(404)
        .json({ success: false, message: "Room type not found." });

    const newCheckIn = checkIn
      ? new Date(`${checkIn}T00:00:00.000Z`)
      : booking.dates.checkIn;
    const newCheckOut = checkOut
      ? new Date(`${checkOut}T00:00:00.000Z`)
      : booking.dates.checkOut;
    const nights = Math.round(
      (newCheckOut - newCheckIn) / (1000 * 60 * 60 * 24),
    );

    if (nights <= 0)
      return res
        .status(400)
        .json({ success: false, message: "Check-out must be after check-in." });

    const targetRoomCount = roomCount
      ? Math.max(1, parseInt(roomCount, 10))
      : booking.roomCount;
    const targetAdults = adults
      ? Math.max(1, parseInt(adults, 10))
      : booking.occupancy.adults;
    const targetChildren =
      children !== undefined
        ? Math.max(0, parseInt(children, 10))
        : booking.occupancy.children;

    let originalRatePlan = null;
    if (booking.promotions?.ratePlanId) {
      originalRatePlan = hotel.ratePlans?.find(
        (rp) => String(rp._id) === String(booking.promotions.ratePlanId),
      );
      if (originalRatePlan) {
        const minNights =
          originalRatePlan.minStayNights || originalRatePlan.minNights || 1;
        if (minNights > 1 && nights < minNights) {
          return res.status(400).json({
            success: false,
            message: `The ${originalRatePlan.name} requires a minimum stay of ${minNights} nights.`,
          });
        }
      }
    }

    const overrides = await DailyInventory.find({
      hotelId: hotel._id,
      roomTypeId: room._id,
      date: { $gte: newCheckIn, $lt: newCheckOut },
    }).lean();

    const overrideMap = new Map();
    overrides.forEach((doc) =>
      overrideMap.set(new Date(doc.date).toISOString().split("T")[0], doc),
    );

    const dailyInventories = [];
    const defaultPrice = Number(room.basePrice ?? 0);
    const defaultUnits = Number(
      room.totalInventory ?? room.totalRooms ?? room.totalUnits ?? 1,
    );

    const checkInChanged =
      newCheckIn.toISOString().split("T")[0] !==
      new Date(booking.dates.checkIn).toISOString().split("T")[0];

    for (let i = 0; i < nights; i++) {
      const dayDate = new Date(newCheckIn.getTime() + i * 24 * 60 * 60 * 1000);
      const dateKey = dayDate.toISOString().split("T")[0];
      const customDay = overrideMap.get(dateKey);

      // Date-specific CTA & Min Stay enforcement ONLY if check-in date changed
      if (i === 0 && checkInChanged) {
        if (customDay?.closedToArrival) {
          return res.status(409).json({
            success: false,
            message: "Check-in is closed on the selected start date.",
          });
        }
        if (customDay?.minStay > 0 && nights < customDay.minStay) {
          return res.status(409).json({
            success: false,
            message: `A minimum stay of ${customDay.minStay} nights is required for check-ins on this date.`,
          });
        }
      }

      const isOriginalNight =
        booking.roomTypeId.toString() === room._id.toString() &&
        dayDate >= booking.dates.checkIn &&
        dayDate < booking.dates.checkOut;

      const available =
        (customDay?.availableRooms !== undefined
          ? customDay.availableRooms
          : defaultUnits) + (isOriginalNight ? booking.roomCount : 0);

      if (customDay?.isBlocked || available < targetRoomCount) {
        return res.status(409).json({
          success: false,
          message: `The selected dates are no longer available for ${room.name}.`,
        });
      }

      dailyInventories.push({
        date: dayDate,
        price: customDay?.price !== undefined ? customDay.price : defaultPrice,
      });
    }

    const newPricing = calculatePricingBreakdown({
      dailyInventories,
      roomCount: targetRoomCount,
      totalGuests: targetAdults + targetChildren,
      addOns: booking.selectedAddOns || [],
      hotel,
      roomType: room,
      promoCode: booking.promotions?.promoCode || null,
      ratePlan: originalRatePlan,
    });

    const delta = evaluateBookingModification({
      originalBooking: booking,
      newPricingBreakdown: newPricing,
    });

    return res.status(200).json({
      success: true,
      data: {
        originalGrandTotal: delta.originalGrandTotal,
        newGrandTotal: delta.newGrandTotal,
        delta: delta.delta,
        action: delta.action,
        newPricing,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/public/:hotelSlug/bookings/:bookingCode/modify
 */
export async function modifyGuestBooking(req, res, next) {
  let session = null;
  let requiresEmergencyRefund = false;
  let emRef = null;

  try {
    const { hotelSlug, bookingCode } = req.params;
    const email = normalizeEmail(req.body?.email);
    const {
      checkIn,
      checkOut,
      roomTypeId,
      roomCount,
      adults,
      children,
      razorpayPaymentId,
      razorpayOrderId,
      razorpaySignature,
    } = req.body;

    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email is required." });

    const hotel = await Hotel.findOne({
      slug: String(hotelSlug),
      isActive: true,
    });
    if (!hotel)
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });

    const booking = await Booking.findOne({
      bookingCode: String(bookingCode).trim().toUpperCase(),
      hotelId: hotel._id,
      "guest.email": email,
      status: "CONFIRMED",
    });

    if (!booking)
      return res
        .status(404)
        .json({ success: false, message: "Active booking not found." });
    if (["OFFLINE", "PAY_AT_HOTEL"].includes(booking.payment?.mode))
      return res.status(400).json({
        success: false,
        message:
          "This booking must be modified through the hotel. Please contact the hotel directly.",
      });

    // Same rule the details endpoint uses for canModify: no self-service changes
    // once check-in time has passed (checked before any payment order is created).
    if (new Date().getTime() >= getCheckInDeadline(booking, hotel).getTime())
      return res.status(400).json({
        success: false,
        message:
          "Check-in time has passed, so this booking can no longer be modified online. Please contact the hotel.",
      });

    const targetRoomTypeId = roomTypeId || booking.roomTypeId;
    const targetRoom = await RoomType.findOne({
      _id: targetRoomTypeId,
      hotelId: hotel._id,
      isActive: true,
    });
    if (!targetRoom)
      return res
        .status(404)
        .json({ success: false, message: "Selected room type not found." });

    const newCheckIn = checkIn
      ? new Date(`${checkIn}T00:00:00.000Z`)
      : booking.dates.checkIn;
    const newCheckOut = checkOut
      ? new Date(`${checkOut}T00:00:00.000Z`)
      : booking.dates.checkOut;
    const nights = Math.round(
      (newCheckOut - newCheckIn) / (1000 * 60 * 60 * 24),
    );

    if (nights <= 0)
      return res
        .status(400)
        .json({ success: false, message: "Check-out must be after check-in." });

    const targetRoomCount = roomCount
      ? Math.max(1, parseInt(roomCount, 10))
      : booking.roomCount;
    const targetAdults = adults
      ? Math.max(1, parseInt(adults, 10))
      : booking.occupancy.adults;
    const targetChildren =
      children !== undefined
        ? Math.max(0, parseInt(children, 10))
        : booking.occupancy.children;

    let originalRatePlan = null;
    if (booking.promotions?.ratePlanId) {
      originalRatePlan = hotel.ratePlans?.find(
        (rp) => String(rp._id) === String(booking.promotions.ratePlanId),
      );
      if (originalRatePlan) {
        const minNights =
          originalRatePlan.minStayNights || originalRatePlan.minNights || 1;
        if (minNights > 1 && nights < minNights) {
          return res.status(400).json({
            success: false,
            message: `The ${originalRatePlan.name} requires a minimum stay of ${minNights} nights.`,
          });
        }
      }
    }

    const overrides = await DailyInventory.find({
      hotelId: hotel._id,
      roomTypeId: targetRoom._id,
      date: { $gte: newCheckIn, $lt: newCheckOut },
    }).lean();

    const overrideMap = new Map();
    overrides.forEach((doc) =>
      overrideMap.set(new Date(doc.date).toISOString().split("T")[0], doc),
    );

    const dailyInventories = [];
    const defaultPrice = Number(targetRoom.basePrice ?? 0);
    const checkInChanged =
      newCheckIn.toISOString().split("T")[0] !==
      new Date(booking.dates.checkIn).toISOString().split("T")[0];

    for (let i = 0; i < nights; i++) {
      const dayDate = new Date(newCheckIn.getTime() + i * 24 * 60 * 60 * 1000);
      const dateKey = dayDate.toISOString().split("T")[0];
      const customDay = overrideMap.get(dateKey);

      if (i === 0 && checkInChanged) {
        if (customDay?.closedToArrival)
          return res.status(409).json({
            success: false,
            message: "Check-in is closed on the selected start date.",
          });
        if (customDay?.minStay > 0 && nights < customDay.minStay) {
          return res.status(409).json({
            success: false,
            message: `A minimum stay of ${customDay.minStay} nights is required for check-ins on this date.`,
          });
        }
      }

      dailyInventories.push({
        date: dayDate,
        price: customDay?.price !== undefined ? customDay.price : defaultPrice,
      });
    }

    const newPricing = calculatePricingBreakdown({
      dailyInventories,
      roomCount: targetRoomCount,
      totalGuests: targetAdults + targetChildren,
      addOns: booking.selectedAddOns || [],
      hotel,
      roomType: targetRoom,
      promoCode: booking.promotions?.promoCode || null,
      ratePlan: originalRatePlan,
    });

    const delta = evaluateBookingModification({
      originalBooking: booking,
      newPricingBreakdown: newPricing,
    });

    const isHotelGateway =
      hotel.paymentConfig?.mode === "HOTEL_GATEWAY" &&
      Boolean(hotel.paymentConfig?.hotelRazorpay?.keyId);
    const rzpKeyId = isHotelGateway
      ? hotel.paymentConfig.hotelRazorpay.keyId
      : process.env.MASTER_RAZORPAY_KEY_ID;
    const rzpSecret = isHotelGateway
      ? decryptSecret(hotel.paymentConfig.hotelRazorpay.keySecretEncrypted)
      : process.env.MASTER_RAZORPAY_KEY_SECRET;

    if (delta.action === "PAYMENT_DUE") {
      const rzp = new Razorpay({ key_id: rzpKeyId, key_secret: rzpSecret });

      if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
        const deltaOrder = await rzp.orders.create({
          amount: Math.round(delta.delta * 100),
          currency: "INR",
          receipt: `mod_${booking.bookingCode}`,
          notes: {
            bookingCode: booking.bookingCode,
            type: "MODIFICATION_DELTA",
          },
        });

        return res.status(200).json({
          success: true,
          requiresPayment: true,
          data: {
            deltaAmount: delta.delta,
            razorpayOrderId: deltaOrder.id,
            razorpayKeyId: rzpKeyId,
            currency: "INR",
            message: `Additional payment of INR ${delta.delta} is required to confirm this modification.`,
          },
        });
      }

      const isValid = verifyRazorpaySignature({
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature,
        secret: rzpSecret,
      });

      if (!isValid)
        return res.status(400).json({
          success: false,
          message: "Payment signature verification failed.",
        });

      const rzpOrder = await rzp.orders.fetch(razorpayOrderId);
      const rzpPayment = await rzp.payments.fetch(razorpayPaymentId);

      if (rzpPayment.order_id !== razorpayOrderId)
        return res
          .status(400)
          .json({ success: false, message: "Payment and order ID mismatch." });
      if (rzpPayment.status !== "captured")
        return res.status(400).json({
          success: false,
          message: "Payment has not been captured successfully.",
        });

      if (
        rzpOrder.notes?.type !== "MODIFICATION_DELTA" ||
        rzpOrder.notes?.bookingCode !== booking.bookingCode
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid payment context. This payment does not belong to this booking modification.",
        });
      }

      const expectedPaise = Math.round(delta.delta * 100);
      if (
        Number(rzpOrder.amount) < expectedPaise ||
        Number(rzpPayment.amount) < expectedPaise
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Payment amount does not cover the required modification delta.",
        });
      }

      emRef = {
        paymentId: razorpayPaymentId,
        amount: delta.delta,
        keyId: rzpKeyId,
        keySecret: rzpSecret,
        bookingId: booking._id,
        bookingCode: booking.bookingCode,
      };
      requiresEmergencyRefund = true;
    }

    session = await mongoose.startSession();
    session.startTransaction();

    let lockedBooking = booking;
    if (delta.action === "PAYMENT_DUE") {
      lockedBooking = await Booking.findOneAndUpdate(
        {
          _id: booking._id,
          "payment.modificationPaymentIds": { $ne: razorpayPaymentId },
        },
        { $push: { "payment.modificationPaymentIds": razorpayPaymentId } },
        { session, new: true },
      );
      if (!lockedBooking) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "This payment has already been used for a modification.",
        });
      }
    }

    await releaseRoomInventory({
      hotelId: lockedBooking.hotelId,
      roomTypeId: lockedBooking.roomTypeId,
      checkInDate: lockedBooking.dates.checkIn,
      checkOutDate: lockedBooking.dates.checkOut,
      roomCount: lockedBooking.roomCount,
      session,
    });

    const holdRes = await holdRoomInventory({
      hotelId: hotel._id,
      roomTypeId: targetRoom._id,
      checkInDate: newCheckIn,
      checkOutDate: newCheckOut,
      roomCount: targetRoomCount,
      session,
    });

    if (!holdRes.success) {
      await session.abortTransaction();
      session.endSession();

      if (requiresEmergencyRefund && emRef) {
        try {
          const rzp = new Razorpay({
            key_id: emRef.keyId,
            key_secret: emRef.keySecret,
          });
          await refundPaymentIdempotent(
            rzp,
            emRef.paymentId,
            Math.round(emRef.amount * 100),
            { reason: "Modification inventory hold failed" },
          );
        } catch (rfErr) {
          console.error("Hold failed, and auto-refund failed:", rfErr);
          await Booking.updateOne(
            { _id: emRef.bookingId },
            {
              $set: {
                "reconciliation.needsManualReview": true,
                "reconciliation.lastError": `Hold failed, and auto-refund of ₹${emRef.amount} failed: ${rfErr.message}`,
              },
            },
          ).catch(() => {});
          await sendSystemAlert({
            type: "WEBHOOK_FAILURE",
            title: "Hold Failed - Refund Error",
            message: `Hold failed during modification for booking ${emRef.bookingCode}, but auto-refund of ₹${emRef.amount} failed: ${rfErr.message}`,
            metadata: { bookingCode: emRef.bookingCode, error: rfErr.message },
            severity: "error",
          }).catch(() => {});
        }
        requiresEmergencyRefund = false;
      }

      return res.status(409).json({
        success: false,
        message:
          holdRes.message || "Rooms not available for the new stay schedule.",
      });
    }

    lockedBooking.dates = {
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      nights,
    };
    lockedBooking.roomTypeId = targetRoom._id;
    lockedBooking.roomCount = targetRoomCount;
    lockedBooking.occupancy = {
      adults: targetAdults,
      children: targetChildren,
    };

    // What the guest had paid online BEFORE this change. Must be read before
    // billing is overwritten: amountPaidOnline is not set when an online booking
    // is first confirmed, so the fallback is the ORIGINAL grand total.
    const paidBeforeModification =
      Number(lockedBooking.payment.amountPaidOnline) ||
      Number(delta.originalGrandTotal);

    lockedBooking.billing = {
      roomBaseTariff: newPricing.roomBaseTariff,
      discountTotal: newPricing.discountTotal || 0,
      addOnsTotal: newPricing.addOnsTotal,
      hotelGst: newPricing.hotelGst,
      platformConvenienceFee: lockedBooking.billing.platformConvenienceFee,
      grandTotal: newPricing.grandTotal,
    };

    if (delta.action === "PAYMENT_DUE") {
      lockedBooking.payment.amountPaidOnline =
        Math.round((paidBeforeModification + delta.delta) * 100) / 100;
    } else if (
      delta.action === "REFUND_DUE" &&
      lockedBooking.payment?.razorpayPaymentId
    ) {
      // Keep the recorded online payment in step with the refund issued below.
      // (If the gateway refund fails, the booking is flagged for manual review.)
      lockedBooking.payment.amountPaidOnline = Math.max(
        0,
        Math.round((paidBeforeModification - delta.delta) * 100) / 100,
      );
    }

    await lockedBooking.save({ session });
    await syncInvoiceAfterModification(lockedBooking, {
      roomType: targetRoom,
      session,
    });

    await session.commitTransaction();
    session.endSession();
    session = null;
    requiresEmergencyRefund = false;

    let refundIssued = false;
    let refundError = null;

    if (
      delta.action === "REFUND_DUE" &&
      lockedBooking.payment?.razorpayPaymentId
    ) {
      try {
        const rzp = getRazorpayClient(hotel, lockedBooking.payment.mode);
        await refundPaymentIdempotent(
          rzp,
          lockedBooking.payment.razorpayPaymentId,
          Math.round(delta.delta * 100),
          {
            bookingCode: lockedBooking.bookingCode,
            reason: "Stay modification partial refund",
          },
        );
        refundIssued = true;
      } catch (rfErr) {
        refundError = rfErr.message;
        console.error("[Post-Commit Refund Error]:", rfErr);
        await Booking.updateOne(
          { _id: lockedBooking._id },
          {
            $set: {
              "reconciliation.needsManualReview": true,
              "reconciliation.lastError": `Modification refund of ₹${delta.delta} failed: ${rfErr.message}`,
            },
          },
        ).catch(() => {});
        await sendSystemAlert({
          type: "WEBHOOK_FAILURE",
          title: "Modification Refund Failed",
          message: `Booking ${lockedBooking.bookingCode} was modified, but gateway refund of ₹${delta.delta} failed: ${rfErr.message}`,
          metadata: {
            bookingCode: lockedBooking.bookingCode,
            delta: delta.delta,
            error: rfErr.message,
          },
          severity: "error",
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Your reservation has been modified successfully.",
      data: {
        bookingCode: lockedBooking.bookingCode,
        dates: lockedBooking.dates,
        roomType: targetRoom.name,
        delta,
        refundIssued,
        refundError: refundError
          ? "Refund failed to initiate automatically. Staff has been notified to process it manually."
          : null,
      },
    });
  } catch (err) {
    if (session && session.inTransaction()) await session.abortTransaction();
    if (session) session.endSession();

    if (requiresEmergencyRefund && emRef) {
      try {
        const rzp = new Razorpay({
          key_id: emRef.keyId,
          key_secret: emRef.keySecret,
        });
        await refundPaymentIdempotent(
          rzp,
          emRef.paymentId,
          Math.round(emRef.amount * 100),
          { reason: "System error during booking modification" },
        );
      } catch (rfErr) {
        console.error("Emergency refund failed:", rfErr);
        await Booking.updateOne(
          { _id: emRef.bookingId },
          {
            $set: {
              "reconciliation.needsManualReview": true,
              "reconciliation.lastError": `System error during modification. Emergency refund of ₹${emRef.amount} failed: ${rfErr.message}`,
            },
          },
        ).catch(() => {});
        await sendSystemAlert({
          type: "WEBHOOK_FAILURE",
          title: "Emergency Refund Failed",
          message: `Booking ${emRef.bookingCode} hit a system error during modification. Emergency refund of ₹${emRef.amount} failed: ${rfErr.message}`,
          metadata: { bookingCode: emRef.bookingCode, error: rfErr.message },
          severity: "error",
        }).catch(() => {});
      }
    }
    next(err);
  }
}

/**
 * POST /api/v1/public/:hotelSlug/bookings/:bookingCode/cancel
 */
export async function cancelGuestBooking(req, res, next) {
  try {
    const { hotelSlug, bookingCode } = req.params;
    const email = normalizeEmail(req.body?.email);
    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim().slice(0, 200)
        : "";

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required to verify and cancel this reservation.",
      });
    }

    const hotel = await Hotel.findOne({
      slug: String(hotelSlug),
    });
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const target = await Booking.findOne({
      bookingCode: String(bookingCode).trim().toUpperCase(),
      hotelId: hotel._id,
      "guest.email": email,
    })
      .select("payment.mode")
      .lean();

    if (target?.payment?.mode === "OFFLINE") {
      return res.status(400).json({
        success: false,
        message:
          "This booking was made with the hotel directly. Please contact the hotel to cancel it.",
      });
    }

    const result = await cancelConfirmedBooking({
      filter: {
        bookingCode: String(bookingCode).trim().toUpperCase(),
        hotelId: hotel._id,
        "guest.email": email,
      },
      hotel,
      reason: reason || "Guest requested cancellation",
      cancelledBy: "GUEST_SELF_SERVICE",
      enforceCutoff: true,
    });

    if (!result.ok) {
      return res
        .status(result.status)
        .json({ success: false, message: result.message });
    }

    sendCancellationNotice({
      booking: result.booking,
      hotel,
      cancellationResult: result.evaluation,
    }).catch((err) => console.error("[Notification Error]", err));

    return res.status(200).json({
      success: true,
      message: "Reservation cancelled successfully.",
      data: {
        bookingCode: result.booking.bookingCode,
        status: "CANCELLED",
        refundAmount: result.evaluation.refundAmount,
        refundPercent: result.evaluation.refundPercent,
        retainedAmount: result.evaluation.retainedAmount,
        refundId: result.refundId,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/public/:hotelSlug/bookings/:bookingCode/invoice?email=...
 */
export async function downloadGuestInvoice(req, res, next) {
  try {
    const { hotelSlug, bookingCode } = req.params;
    const email = normalizeEmail(req.query.email);
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email verification is required." });
    }

    const hotel = await Hotel.findOne({
      slug: String(hotelSlug),
    })
      .select("_id")
      .lean();
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const booking = await Booking.findOne({
      bookingCode: String(bookingCode).trim().toUpperCase(),
      hotelId: hotel._id,
      "guest.email": email,
    });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Reservation not found. Please verify your details.",
      });
    }

    const result = await buildInvoicePdf(booking);
    if (!result) {
      return res.status(409).json({
        success: false,
        message: "Your invoice is available once the booking is confirmed.",
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Invoice-${result.invoice.invoiceNumber.replace(/[^A-Za-z0-9-]/g, "_")}.pdf"`,
    );
    return res.status(200).send(result.pdf);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/public/:hotelSlug/bookings/:bookingCode/credit-note?email=...
 */
export async function downloadGuestCreditNote(req, res, next) {
  try {
    const { hotelSlug, bookingCode } = req.params;
    const email = normalizeEmail(req.query.email);
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email verification is required." });
    }

    const hotel = await Hotel.findOne({
      slug: String(hotelSlug),
    })
      .select("_id")
      .lean();
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const booking = await Booking.findOne({
      bookingCode: String(bookingCode).trim().toUpperCase(),
      hotelId: hotel._id,
      "guest.email": email,
    });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Reservation not found. Please verify your details.",
      });
    }

    if (booking.status !== "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Credit notes are only available for cancelled reservations.",
      });
    }

    const result = await buildCreditNotePdf(booking);
    if (!result) {
      return res.status(404).json({
        success: false,
        message:
          "No credit note found. Credit notes are issued exclusively for cancelled GST tax invoices.",
      });
    }

    const safeNumber = (
      result.invoice.creditNoteNumber || "CreditNote"
    ).replace(/[^A-Za-z0-9-]/g, "_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="CreditNote-${safeNumber}.pdf"`,
    );
    return res.status(200).send(result.pdf);
  } catch (error) {
    next(error);
  }
}