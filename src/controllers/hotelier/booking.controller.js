import mongoose from "mongoose";
import Booking from "../../models/Booking.js";
import Hotel from "../../models/Hotel.js";
import RoomType from "../../models/RoomType.js";
import DailyInventory from "../../models/DailyInventory.js";
import { cancelConfirmedBooking } from "../../services/bookingCancellation.service.js";
import { sendCancellationNotice } from "../../services/notification.service.js";
import { evaluateBookingModification } from "../../services/cancellation.service.js";
import {
  releaseRoomInventory,
  holdRoomInventory,
} from "../../services/inventory.service.js";
import { calculatePricingBreakdown } from "../../services/pricing.service.js";
import {
  syncInvoiceAfterModification,
  offlinePaidTotal,
} from "../../services/invoice.service.js";
import {
  getRazorpayClient,
  refundPaymentIdempotent,
} from "../../services/payment.service.js";
import { sendSystemAlert } from "../../utils/systemAlerts.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SORTS = {
  newest: { createdAt: -1 },
  checkInAsc: { "dates.checkIn": 1 },
  checkInDesc: { "dates.checkIn": -1 },
  amountDesc: { "billing.grandTotal": -1 },
};

const BOOKING_STATUSES = [
  "HELD",
  "CONFIRMED",
  "CANCELLATION_IN_PROGRESS",
  "REHOLD_IN_PROGRESS",
  "CANCELLED",
  "CHECKED_IN",
  "COMPLETED",
  "EXPIRED",
  "EXPIRED_REFUNDED",
];

const asString = (v) => (typeof v === "string" ? v : "");

const DATE_FIELDS = {
  checkIn: "dates.checkIn",
  checkOut: "dates.checkOut",
  createdAt: "createdAt",
};

/**
 * Neutralizes Excel / CSV formula injection (CWE-1236)
 */
function sanitizeCsvValue(val) {
  if (val === null || val === undefined) return '""';
  let s = String(val);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * GET /api/v1/admin/bookings
 */
export async function getBookings(req, res, next) {
  try {
    if (!req.user.hotelId) {
      return res.status(400).json({
        success: false,
        message: "This account is not linked to a hotel.",
      });
    }

    const status = asString(req.query.status);
    const q = asString(req.query.q);
    const roomTypeId = asString(req.query.roomTypeId);
    const dateField = asString(req.query.dateField) || "checkIn";
    const from = asString(req.query.from);
    const to = asString(req.query.to);
    const sort = asString(req.query.sort) || "newest";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit, 10) || 20),
    );

    const fromD = from ? new Date(`${from}T00:00:00.000+05:30`) : null;
    const toD = to ? new Date(`${to}T23:59:59.999+05:30`) : null;
    if ((fromD && isNaN(fromD)) || (toD && isNaN(toD))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date filter." });
    }

    const base = { hotelId: req.user.hotelId };

    if (roomTypeId && mongoose.isValidObjectId(roomTypeId)) {
      base.roomTypeId = roomTypeId;
    }

    if (q.trim()) {
      const rx = new RegExp(escapeRegex(q.trim().slice(0, 60)), "i");
      base.$or = [
        { bookingCode: rx },
        { "guest.name": rx },
        { "guest.email": rx },
        { "guest.phone": rx },
      ];
    }

    if (dateField === "stay") {
      if (toD) base["dates.checkIn"] = { $lte: toD };
      if (fromD) base["dates.checkOut"] = { $gt: fromD };
    } else if (Object.hasOwn(DATE_FIELDS, dateField) && (fromD || toD)) {
      const range = {};
      if (fromD) range.$gte = fromD;
      if (toD) range.$lte = toD;
      base[DATE_FIELDS[dateField]] = range;
    }

    const source = asString(req.query.source);
    if (["ONLINE", "PHONE", "WALK_IN"].includes(source)) base.source = source;

    const query = { ...base };
    if (BOOKING_STATUSES.includes(status)) query.status = status;

    const skip = (page - 1) * limit;

    const aggMatch = {
      ...base,
      hotelId: new mongoose.Types.ObjectId(req.user.hotelId),
    };
    if (base.roomTypeId) {
      aggMatch.roomTypeId = new mongoose.Types.ObjectId(base.roomTypeId);
    }

    const [bookings, total, byStatus] = await Promise.all([
      Booking.find(query)
        .populate("roomTypeId", "name")
        .sort(Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.newest)
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(query),
      Booking.aggregate([
        { $match: aggMatch },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            amount: { $sum: "$billing.grandTotal" },
          },
        },
      ]),
    ]);

    const summary = {
      total: 0,
      confirmed: 0,
      checkedIn: 0,
      completed: 0,
      cancelled: 0,
      revenue: 0,
    };
    for (const row of byStatus) {
      summary.total += row.count;
      if (row._id === "CONFIRMED") summary.confirmed = row.count;
      if (row._id === "CHECKED_IN") summary.checkedIn = row.count;
      if (row._id === "COMPLETED") summary.completed = row.count;
      if (["CONFIRMED", "CHECKED_IN", "COMPLETED"].includes(row._id)) {
        summary.revenue += row.amount;
      }
      if (row._id === "CANCELLED") summary.cancelled = row.count;
    }

    return res.status(200).json({
      success: true,
      data: bookings,
      summary,
      pagination: { total, page, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/admin/bookings/analytics/adr-revpar
 * Returns proration-accurate ADR, RevPAR, and Occupancy rates strictly within the chosen window.
 */
export async function getHotelAnalytics(req, res, next) {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return res
        .status(400)
        .json({ success: false, message: "Account not linked to a property." });
    }

    const { from, to } = req.query;
    const now = new Date();
    const fromDate = from
      ? new Date(`${from}T00:00:00.000+05:30`)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to
      ? new Date(`${to}T23:59:59.999+05:30`)
      : new Date(now.getTime() + 5.5 * 60 * 60 * 1000);

    const [hotel, roomTypes] = await Promise.all([
      Hotel.findById(hotelId).lean(),
      RoomType.find({ hotelId, isActive: true }).lean(),
    ]);

    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const totalRoomsCount =
      roomTypes.reduce((acc, r) => {
        return (
          acc + (Number(r.totalInventory ?? r.totalRooms ?? r.totalUnits) || 1)
        );
      }, 0) || Number(hotel.helpfulFacts?.totalRooms || 10);

    const daysCount = Math.max(
      1,
      Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24)),
    );
    const totalAvailableRoomNights = totalRoomsCount * daysCount;

    // Proration: Calculate strictly the nights that fall inside [fromDate, toDate]
    const matchingBookings = await Booking.find({
      hotelId: new mongoose.Types.ObjectId(hotelId),
      status: { $in: ["CONFIRMED", "CHECKED_IN", "COMPLETED"] },
      "dates.checkIn": { $lt: toDate },
      "dates.checkOut": { $gt: fromDate },
    }).lean();

    let totalProratedRoomRevenue = 0;
    let totalProratedGrossRevenue = 0;
    let totalProratedSoldRoomNights = 0;

    for (const b of matchingBookings) {
      const bIn = new Date(b.dates.checkIn);
      const bOut = new Date(b.dates.checkOut);
      const overlapStart = bIn > fromDate ? bIn : fromDate;
      const overlapEnd = bOut < toDate ? bOut : toDate;

      const overlapNights = Math.max(
        0,
        Math.round((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24)),
      );

      if (overlapNights > 0 && b.dates.nights > 0) {
        const fraction = overlapNights / b.dates.nights;
        const roomNights = overlapNights * (b.roomCount || 1);

        totalProratedSoldRoomNights += roomNights;
        totalProratedRoomRevenue += (b.billing?.roomBaseTariff || 0) * fraction;
        totalProratedGrossRevenue += (b.billing?.grandTotal || 0) * fraction;
      }
    }

    const adr =
      totalProratedSoldRoomNights > 0
        ? Number(
            (totalProratedRoomRevenue / totalProratedSoldRoomNights).toFixed(2),
          )
        : 0;
    const occupancyRate =
      totalAvailableRoomNights > 0
        ? Math.min(
            100,
            Number(
              (
                (totalProratedSoldRoomNights / totalAvailableRoomNights) *
                100
              ).toFixed(2),
            ),
          )
        : 0;
    const revpar =
      totalAvailableRoomNights > 0
        ? Number(
            (totalProratedRoomRevenue / totalAvailableRoomNights).toFixed(2),
          )
        : 0;

    return res.status(200).json({
      success: true,
      data: {
        window: {
          from: fromDate.toISOString().slice(0, 10),
          to: toDate.toISOString().slice(0, 10),
          days: daysCount,
        },
        inventory: {
          totalRooms: totalRoomsCount,
          totalAvailableRoomNights,
          soldRoomNights: totalProratedSoldRoomNights,
        },
        metrics: {
          adr,
          revpar,
          occupancyRate,
          totalRoomRevenue: Math.round(totalProratedRoomRevenue),
          totalGrossRevenue: Math.round(totalProratedGrossRevenue),
          totalBookingsCount: matchingBookings.length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/admin/bookings/export/csv
 * Exports CSV with formula injection defense
 */
export async function exportBookingsCsv(req, res, next) {
  try {
    const hotelId = req.user?.hotelId;
    if (!hotelId) {
      return res
        .status(400)
        .json({ success: false, message: "Account not linked to a property." });
    }

    const { from, to, status } = req.query;
    const query = { hotelId };

    if (from || to) {
      const range = {};
      if (from) range.$gte = new Date(`${from}T00:00:00.000+05:30`);
      if (to) range.$lte = new Date(`${to}T23:59:59.999+05:30`);
      query["dates.checkIn"] = range;
    }

    if (status && BOOKING_STATUSES.includes(status)) {
      query.status = status;
    }

    const bookings = await Booking.find(query)
      .populate("roomTypeId", "name")
      .sort({ "dates.checkIn": -1 })
      .lean();

    const headers = [
      "Booking Reference",
      "Guest Name",
      "Email",
      "Phone",
      "Check-In Date",
      "Check-Out Date",
      "Nights",
      "Room Category",
      "Room Units",
      "Source",
      "Status",
      "Promo Code",
      "Rate Plan",
      "Discount (INR)",
      "Room Base Tariff (INR)",
      "AddOns Total (INR)",
      "GST / Taxes (INR)",
      "Grand Total (INR)",
      "Payment Mode",
      "Payment Status",
      "Created At",
    ];

    const rows = bookings.map((b) => [
      sanitizeCsvValue(b.bookingCode),
      sanitizeCsvValue(b.guest?.name),
      sanitizeCsvValue(b.guest?.email),
      sanitizeCsvValue(b.guest?.phone),
      sanitizeCsvValue(
        b.dates?.checkIn
          ? new Date(b.dates.checkIn).toISOString().slice(0, 10)
          : "",
      ),
      sanitizeCsvValue(
        b.dates?.checkOut
          ? new Date(b.dates.checkOut).toISOString().slice(0, 10)
          : "",
      ),
      sanitizeCsvValue(b.dates?.nights || 1),
      sanitizeCsvValue(b.roomTypeId?.name || "Standard Room"),
      sanitizeCsvValue(b.roomCount || 1),
      sanitizeCsvValue(b.source || "ONLINE"),
      sanitizeCsvValue(b.status),
      sanitizeCsvValue(b.promotions?.promoCode || "NONE"),
      sanitizeCsvValue(b.promotions?.ratePlanName || "Standard"),
      sanitizeCsvValue(b.billing?.discountTotal || 0),
      sanitizeCsvValue(b.billing?.roomBaseTariff || 0),
      sanitizeCsvValue(b.billing?.addOnsTotal || 0),
      sanitizeCsvValue(b.billing?.hotelGst || 0),
      sanitizeCsvValue(b.billing?.grandTotal || 0),
      sanitizeCsvValue(b.payment?.mode || "ONLINE"),
      sanitizeCsvValue(b.payment?.status || "PENDING"),
      sanitizeCsvValue(b.createdAt ? new Date(b.createdAt).toISOString() : ""),
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r) => r.join(",")),
    ].join("\r\n");

    const filename = `Bookings-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/admin/bookings/:id/cancel
 */
export async function cancelBooking(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid booking id." });
    }
    if (!req.user.hotelId) {
      return res.status(400).json({
        success: false,
        message: "This account is not linked to a hotel.",
      });
    }

    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim().slice(0, 200)
        : "";

    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found." });
    }

    const result = await cancelConfirmedBooking({
      filter: { _id: id, hotelId: req.user.hotelId },
      hotel,
      reason: reason || "Cancelled by hotel front desk",
      cancelledBy: "HOTELIER",
      enforceCutoff: false,
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
      message:
        result.booking?.payment?.mode === "OFFLINE"
          ? result.evaluation.refundAmount > 0
            ? `Booking cancelled. Please return INR ${result.evaluation.refundAmount} to the guest directly; this booking was not paid online.`
            : "Booking cancelled. No refund is due under the cancellation policy."
          : result.evaluation.refundAmount > 0
            ? `Booking cancelled. Refund of INR ${result.evaluation.refundAmount} (${result.evaluation.refundPercent}%) has been initiated.`
            : "Booking cancelled. No refund is due under the cancellation policy.",
      cancellation: result.evaluation,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/admin/bookings/:id/modify
 */
export async function modifyBooking(req, res, next) {
  let session = null;
  let requiresEmergencyRefund = false;

  try {
    const { id } = req.params;
    const {
      checkIn,
      checkOut,
      roomTypeId,
      roomCount,
      adults,
      children,
      ratePlanId,
      extraPayment,
    } = req.body;

    if (!mongoose.isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid booking ID." });

    const booking = await Booking.findOne({
      _id: id,
      hotelId: req.user.hotelId,
      status: { $in: ["CONFIRMED", "CHECKED_IN"] },
    });
    if (!booking)
      return res.status(404).json({
        success: false,
        message: "Active booking not found or ineligible for modification.",
      });

    const hotel = await Hotel.findById(req.user.hotelId);
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
    const newRoomCount = roomCount
      ? Math.max(1, parseInt(roomCount, 10))
      : booking.roomCount;
    const newAdults = adults
      ? Math.max(1, parseInt(adults, 10))
      : booking.occupancy.adults;
    const newChildren =
      children !== undefined
        ? Math.max(0, parseInt(children, 10))
        : booking.occupancy.children;

    const nights = Math.round(
      (newCheckOut - newCheckIn) / (1000 * 60 * 60 * 24),
    );
    if (nights <= 0)
      return res
        .status(400)
        .json({ success: false, message: "Check-out must be after check-in." });

    const effectivePlanId = ratePlanId || booking.promotions?.ratePlanId;
    let selectedRatePlan = null;
    if (effectivePlanId) {
      selectedRatePlan = hotel.ratePlans?.find(
        (rp) =>
          String(rp._id) === String(effectivePlanId) && rp.isActive !== false,
      );
      if (selectedRatePlan) {
        const minNights =
          selectedRatePlan.minStayNights || selectedRatePlan.minNights || 1;
        if (minNights > 1 && nights < minNights) {
          return res.status(400).json({
            success: false,
            message: `The ${selectedRatePlan.name} requires a minimum stay of ${minNights} nights.`,
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
      roomCount: newRoomCount,
      totalGuests: newAdults + newChildren,
      addOns: booking.selectedAddOns || [],
      hotel,
      roomType: targetRoom,
      promoCode: booking.promotions?.promoCode || null,
      ratePlan: selectedRatePlan,
    });

    const deltaEvaluation = evaluateBookingModification({
      originalBooking: booking,
      newPricingBreakdown: newPricing,
    });

    // Online-paid bookings: a price increase can't be saved without collecting it.
    if (
      deltaEvaluation.action === "PAYMENT_DUE" &&
      !["OFFLINE", "PAY_AT_HOTEL"].includes(booking.payment?.mode)
    ) {
      return res.status(400).json({
        success: false,
        code: "BALANCE_DUE",
        message: `This change raises the total by ₹${deltaEvaluation.delta}, but the booking was paid online. Ask the guest to modify it from their booking link so the difference is charged online, or create a new booking for the extra nights.`,
      });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    await releaseRoomInventory({
      hotelId: booking.hotelId,
      roomTypeId: booking.roomTypeId,
      checkInDate: booking.dates.checkIn,
      checkOutDate: booking.dates.checkOut,
      roomCount: booking.roomCount,
      session,
    });

    const holdRes = await holdRoomInventory({
      hotelId: hotel._id,
      roomTypeId: targetRoom._id,
      checkInDate: newCheckIn,
      checkOutDate: newCheckOut,
      roomCount: newRoomCount,
      session,
    });

    if (!holdRes.success) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message:
          holdRes.message || "Rooms are not available for the new dates.",
      });
    }

    booking.dates = { checkIn: newCheckIn, checkOut: newCheckOut, nights };
    booking.roomTypeId = targetRoom._id;
    booking.roomCount = newRoomCount;
    booking.occupancy = { adults: newAdults, children: newChildren };
    booking.billing = {
      roomBaseTariff: newPricing.roomBaseTariff,
      discountTotal: newPricing.discountTotal || 0,
      addOnsTotal: newPricing.addOnsTotal,
      hotelGst: newPricing.hotelGst,
      platformConvenienceFee: booking.billing.platformConvenienceFee,
      grandTotal: newPricing.grandTotal,
    };

    if (selectedRatePlan) {
      booking.promotions.ratePlanId = selectedRatePlan._id;
      booking.promotions.ratePlanName = selectedRatePlan.name;
    }

    if (extraPayment && Number(extraPayment.amount) > 0) {
      booking.payment.offlinePayments.push({
        method: extraPayment.method || "CASH",
        amount: Number(extraPayment.amount),
        reference: String(extraPayment.reference || "").slice(0, 80),
        receivedAt: new Date(),
        receivedBy: req.user._id,
      });
    }

    if (booking.payment?.mode === "OFFLINE") {
      const received = offlinePaidTotal(booking);
      booking.payment.status =
        received >= booking.billing.grandTotal - 0.001
          ? "PAID"
          : received > 0
            ? "PARTIAL"
            : "PENDING";
    }

    // Pay-at-hotel: the commission paid online stays as it is.
    // Only the balance payable at the hotel changes.
    if (booking.payment?.mode === "PAY_AT_HOTEL") {
      booking.payment.amountDueAtHotel = Math.max(
        0,
        Math.round(
          (booking.billing.grandTotal -
            (booking.payment.amountPayableNow || 0)) *
            100,
        ) / 100,
      );
    }

    requiresEmergencyRefund =
      deltaEvaluation.action === "REFUND_DUE" &&
      !["OFFLINE", "PAY_AT_HOTEL"].includes(booking.payment?.mode) &&
      booking.payment?.razorpayPaymentId;

    await booking.save({ session });
    await syncInvoiceAfterModification(booking, {
      roomType: targetRoom,
      session,
    });

    await session.commitTransaction();
    session.endSession();
    session = null;

    let refundIssued = false;
    let refundError = null;

    if (requiresEmergencyRefund) {
      try {
        const rzp = getRazorpayClient(hotel, booking.payment.mode);
        await refundPaymentIdempotent(
          rzp,
          booking.payment.razorpayPaymentId,
          Math.round(deltaEvaluation.delta * 100),
          {
            bookingCode: booking.bookingCode,
            reason: "Hotel front desk stay modification",
          },
        );
        refundIssued = true;
      } catch (rfErr) {
        refundError = rfErr.message;
        console.error("[Manager Modification Refund Error]:", rfErr);
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: {
              "reconciliation.needsManualReview": true,
              "reconciliation.lastError": `Hotelier modification refund of ₹${deltaEvaluation.delta} failed: ${rfErr.message}`,
            },
          },
        ).catch(() => {});
        await sendSystemAlert({
          type: "WEBHOOK_FAILURE",
          title: "Manager Modification Refund Failed",
          message: `Booking ${booking.bookingCode} modified by hotelier but refund of ₹${deltaEvaluation.delta} failed: ${rfErr.message}`,
          metadata: {
            bookingCode: booking.bookingCode,
            delta: deltaEvaluation.delta,
            error: rfErr.message,
          },
          severity: "error",
        });
      }

      // Runs only after the gateway refund succeeded, so a DB error here
      // can no longer trigger the "refund failed" alert.
      if (refundIssued) {
        const prevPaid = Number(booking.payment?.amountPaidOnline) || 0;
        if (prevPaid > 0) {
          const newPaid = Math.max(
            0,
            Math.round((prevPaid - deltaEvaluation.delta) * 100) / 100,
          );
          await Booking.updateOne(
            { _id: booking._id },
            { $set: { "payment.amountPaidOnline": newPaid } },
          ).catch((e) => console.error("[amountPaidOnline sync failed]", e));
          // Keep the object returned in the API response in step with the DB.
          booking.payment.amountPaidOnline = newPaid;
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Booking modified successfully.",
      data: {
        booking,
        delta: deltaEvaluation,
        refundIssued,
        refundError: refundError
          ? "Adjustment refund failed to process automatically. Flagged for review."
          : null,
      },
    });
  } catch (err) {
    if (session && session.inTransaction()) await session.abortTransaction();
    if (session) session.endSession();
    next(err);
  }
}
