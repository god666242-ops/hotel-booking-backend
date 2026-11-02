import mongoose from "mongoose";
import Hotel from "../../models/Hotel.js";
import RoomType from "../../models/RoomType.js";
import DailyInventory from "../../models/DailyInventory.js";
import Booking from "../../models/Booking.js";
import { holdRoomInventory } from "../../services/inventory.service.js";
import { calculatePricingBreakdown } from "../../services/pricing.service.js";
import {
  sendBookingConfirmation,
  sendWelcomeCheckInEmail,
  sendPostStayReviewEmail,
} from "../../services/notification.service.js";
import {
  buildInvoicePdf,
  offlinePaidTotal,
  refreshInvoicePayment,
  tryIssueInvoiceForEmail,
} from "../../services/invoice.service.js";
import { round2 } from "../../utils/invoiceMath.js";
import { generateUniqueBookingCode } from "../../utils/bookingCode.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFLINE_SOURCES = ["PHONE", "WALK_IN"];
const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];
const MAX_NIGHTS = 60;

const str = (v, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Today's calendar date in India, as YYYY-MM-DD. */
export function todayIst(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

/**
 * POST /api/v1/admin/bookings/offline
 * Creates a CONFIRMED booking for a phone call or walk-in guest.
 */
export async function createOfflineBooking(req, res, next) {
  const dbSession = await mongoose.startSession();
  try {
    const b = req.body || {};
    const source = OFFLINE_SOURCES.includes(b.source) ? b.source : null;
    if (!source) return fail(res, 400, "Source must be PHONE or WALK_IN.");

    const roomCount = parseInt(b.roomCount ?? 1, 10);
    const adults = parseInt(b.adults ?? 1, 10);
    const children = parseInt(b.children ?? 0, 10);
    if (!(roomCount >= 1 && roomCount <= 50))
      return fail(res, 400, "Room count must be between 1 and 50.");
    if (!(adults >= 1)) return fail(res, 400, "At least 1 adult is required.");
    if (!(children >= 0)) return fail(res, 400, "Invalid children count.");

    const guestName = str(b.guest?.name, 100);
    const guestPhone = str(b.guest?.phone, 20);
    const guestEmail = str(b.guest?.email, 120).toLowerCase();
    if (!guestName || !guestPhone)
      return fail(res, 400, "Guest name and phone are required.");
    if (guestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail))
      return fail(res, 400, "Guest email is not valid.");

    if (!mongoose.isValidObjectId(b.roomTypeId))
      return fail(res, 400, "A valid room type is required.");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(String(b.checkIn)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(b.checkOut))
    ) {
      return fail(
        res,
        400,
        "Check-in and check-out dates (YYYY-MM-DD) are required.",
      );
    }
    const checkInDate = new Date(`${b.checkIn}T00:00:00.000Z`);
    const checkOutDate = new Date(`${b.checkOut}T00:00:00.000Z`);
    if (isNaN(checkInDate) || isNaN(checkOutDate))
      return fail(res, 400, "Invalid date.");
    const nights = Math.round((checkOutDate - checkInDate) / DAY_MS);
    if (nights < 1) return fail(res, 400, "Check-out must be after check-in.");
    if (nights > MAX_NIGHTS)
      return fail(res, 400, `Stays are limited to ${MAX_NIGHTS} nights.`);
    if (b.checkIn < todayIst())
      return fail(res, 400, "Check-in cannot be in the past.");

    let ratePerNight = null;
    if (
      b.ratePerNight !== undefined &&
      b.ratePerNight !== null &&
      b.ratePerNight !== ""
    ) {
      ratePerNight = Number(b.ratePerNight);
      if (!(ratePerNight >= 0))
        return fail(res, 400, "Rate per night is not valid.");
    }

    const hotel = await Hotel.findById(req.user.hotelId);
    if (!hotel) return fail(res, 404, "Hotel not found.");

    const room = await RoomType.findOne({
      _id: b.roomTypeId,
      hotelId: hotel._id,
      isActive: true,
    });
    if (!room) return fail(res, 404, "Room type not found or inactive.");

    if (adults + children > (room.maxOccupancy || 2) * roomCount) {
      return fail(
        res,
        400,
        "Guest count exceeds the capacity of the selected rooms.",
      );
    }

    // Add-ons come from the hotel / room catalog
    const catalog = [...(hotel.addOns || []), ...(room.addOns || [])];
    const addOns = [];
    for (const item of Array.isArray(b.selectedAddOns)
      ? b.selectedAddOns
      : []) {
      const found = catalog.find(
        (a) => a._id && String(a._id) === String(item.addOnId || item._id),
      );
      if (found && found.isActive !== false) {
        addOns.push({
          addOnId: found._id,
          name: found.name,
          price: Number(found.price),
          chargeType: found.chargeType || "PER_STAY",
          quantity: Math.max(1, Math.min(20, parseInt(item.quantity, 10) || 1)),
        });
      }
    }

    // Optional first payment
    let firstPayment = null;
    if (b.payment && Number(b.payment.amount) > 0) {
      if (!PAYMENT_METHODS.includes(b.payment.method))
        return fail(res, 400, "Payment method is not valid.");
      firstPayment = {
        method: b.payment.method,
        amount: round2(b.payment.amount),
        reference: str(b.payment.reference, 80),
        receivedAt: new Date(),
        receivedBy: req.user._id,
      };
    }

    let created = null;
    let failure = null;

    await dbSession
      .withTransaction(async () => {
        created = null;
        failure = null;

        const overrides = await DailyInventory.find({
          hotelId: hotel._id,
          roomTypeId: room._id,
          date: { $gte: checkInDate, $lt: checkOutDate },
        }).session(dbSession);
        const overrideMap = new Map(overrides.map((d) => [ymd(d.date), d]));

        const dailyInventories = [];
        for (let i = 0; i < nights; i++) {
          const day = new Date(checkInDate.getTime() + i * DAY_MS);
          const custom = overrideMap.get(ymd(day));
          dailyInventories.push({
            date: day,
            price:
              ratePerNight !== null
                ? ratePerNight
                : (custom?.price ?? Number(room.basePrice ?? 0)),
          });
        }

        const hold = await holdRoomInventory({
          hotelId: hotel._id,
          roomTypeId: room._id,
          checkInDate,
          checkOutDate,
          roomCount,
          session: dbSession,
        });
        if (!hold.success) {
          failure = {
            status: 409,
            message:
              hold.message ||
              "Those rooms are not available for the selected dates.",
          };
          return;
        }

        const pricing = calculatePricingBreakdown({
          dailyInventories,
          roomCount,
          totalGuests: adults + children,
          addOns,
          hotel: {
            taxConfig: hotel.taxConfig,
            paymentConfig: { platformFeeFlat: 0 },
          },
          roomType: room,
        });

        if (firstPayment && firstPayment.amount > pricing.grandTotal + 0.001) {
          failure = {
            status: 400,
            message: `Payment exceeds the booking total of INR ${pricing.grandTotal}.`,
          };
          throw Object.assign(new Error("abort"), { handled: true });
        }

        const percent = Number(
          hotel.paymentConfig?.offlineCommissionPercent ?? 0,
        );
        const commissionBase = pricing.roomBaseTariff + pricing.addOnsTotal;
        const paid = firstPayment ? firstPayment.amount : 0;

        const doc = new Booking({
          bookingCode: await generateUniqueBookingCode(dbSession),
          hotelId: hotel._id,
          roomTypeId: room._id,
          roomCount,
          source,
          createdBy: req.user._id,
          notes: str(b.notes, 1000),
          guest: { name: guestName, email: guestEmail, phone: guestPhone },
          dates: { checkIn: checkInDate, checkOut: checkOutDate, nights },
          occupancy: { adults, children },
          billing: {
            roomBaseTariff: pricing.roomBaseTariff,
            discountTotal: 0,
            addOnsTotal: pricing.addOnsTotal,
            hotelGst: pricing.hotelGst,
            platformConvenienceFee: 0,
            grandTotal: pricing.grandTotal,
          },
          selectedAddOns: pricing.calculatedAddOns,
          payment: {
            mode: "OFFLINE",
            status:
              paid <= 0
                ? "PENDING"
                : paid >= pricing.grandTotal - 0.001
                  ? "PAID"
                  : "PARTIAL",
            offlinePayments: firstPayment ? [firstPayment] : [],
          },
          offlineCommission: {
            percent,
            amount: round2((commissionBase * percent) / 100),
            status: percent > 0 ? "DUE" : "NONE",
          },
          status: "CONFIRMED",
        });
        await doc.save({ session: dbSession });
        created = doc;
      })
      .catch((err) => {
        if (!err?.handled) throw err;
      });

    if (failure) return fail(res, failure.status, failure.message);
    if (!created) return fail(res, 500, "The booking could not be created.");

    const sendMail =
      b.sendConfirmation !== false && Boolean(created.guest.email);
    tryIssueInvoiceForEmail(created, { hotel, roomType: room })
      .then((invoice) =>
        sendMail
          ? sendBookingConfirmation({
              booking: created,
              hotel,
              roomType: room,
              invoice,
            })
          : null,
      )
      .catch((err) =>
        console.error("[Offline Booking Notification Error]", err),
      );

    return res
      .status(201)
      .json({ success: true, message: "Booking created.", data: created });
  } catch (error) {
    next(error);
  } finally {
    await dbSession.endSession();
  }
}

async function loadBooking(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 400, "Invalid booking id.");
    return null;
  }
  const booking = await Booking.findOne({
    _id: req.params.id,
    hotelId: req.user.hotelId,
  });
  if (!booking) {
    fail(res, 404, "Booking not found.");
    return null;
  }
  return booking;
}

const balanceDue = (booking) =>
  booking.payment?.mode === "OFFLINE"
    ? Math.max(
        0,
        round2((booking.billing?.grandTotal || 0) - offlinePaidTotal(booking)),
      )
    : 0;

/** POST /bookings/:id/check-in */
export async function checkInBooking(req, res, next) {
  try {
    const booking = await loadBooking(req, res);
    if (!booking) return;

    if (booking.status === "CHECKED_IN")
      return fail(res, 409, "This guest is already checked in.");
    if (booking.status !== "CONFIRMED") {
      return fail(
        res,
        409,
        `A ${booking.status.toLowerCase().replace(/_/g, " ")} booking cannot be checked in.`,
      );
    }
    if (todayIst() < ymd(booking.dates.checkIn)) {
      return fail(res, 400, `Check-in opens on ${ymd(booking.dates.checkIn)}.`);
    }
    if (todayIst() >= ymd(booking.dates.checkOut)) {
      return fail(
        res,
        400,
        "The check-out date has already passed for this booking.",
      );
    }

    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: "CONFIRMED" },
      {
        $set: {
          status: "CHECKED_IN",
          checkedInAt: new Date(),
          checkedInBy: req.user._id,
        },
      },
      { new: true },
    );
    if (!updated)
      return fail(
        res,
        409,
        "This booking was changed by someone else. Please refresh.",
      );

    // Phase 3: #3 Guest Lifecycle - Welcome Check-In Email Dispatch
    if (updated.guest?.email) {
      Hotel.findById(req.user.hotelId)
        .lean()
        .then((hotel) => {
          if (hotel) {
            sendWelcomeCheckInEmail({ booking: updated, hotel }).catch((err) =>
              console.error(
                "[Lifecycle Email Error] Welcome check-in email failed:",
                err.message,
              ),
            );
          }
        })
        .catch((e) =>
          console.error(
            "[Lifecycle Email Error] Hotel lookup failed:",
            e.message,
          ),
        );
    }

    const due = balanceDue(updated);
    return res.status(200).json({
      success: true,
      message:
        due > 0
          ? `Checked in. Balance of INR ${due} is payable at the hotel.`
          : "Guest checked in.",
      data: updated,
      balanceDue: due,
    });
  } catch (error) {
    next(error);
  }
}

/** POST /bookings/:id/check-out  { allowUnpaid?: boolean } */
export async function checkOutBooking(req, res, next) {
  try {
    const booking = await loadBooking(req, res);
    if (!booking) return;

    if (booking.status === "COMPLETED")
      return fail(res, 409, "This guest is already checked out.");
    if (booking.status !== "CHECKED_IN") {
      return fail(res, 409, "Only a checked-in guest can be checked out.");
    }

    const due = balanceDue(booking);
    if (due > 0 && req.body?.allowUnpaid !== true) {
      return fail(
        res,
        409,
        `INR ${due} is still unpaid. Record the payment, or confirm to check out anyway.`,
        {
          code: "BALANCE_DUE",
          balanceDue: due,
        },
      );
    }

    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: "CHECKED_IN" },
      {
        $set: {
          status: "COMPLETED",
          checkedOutAt: new Date(),
          checkedOutBy: req.user._id,
        },
      },
      { new: true },
    );
    if (!updated)
      return fail(
        res,
        409,
        "This booking was changed by someone else. Please refresh.",
      );

    // Phase 3: #3 Guest Lifecycle - Post-Departure Review Solicitation Email Dispatch
    if (updated.guest?.email) {
      Hotel.findById(req.user.hotelId)
        .lean()
        .then((hotel) => {
          if (hotel) {
            const firstActivePromo =
              hotel.promoCodes?.find((p) => p.isActive !== false)?.code || null;
            sendPostStayReviewEmail({
              booking: updated,
              hotel,
              promoCode: firstActivePromo,
            }).catch((err) =>
              console.error(
                "[Lifecycle Email Error] Post-stay review email failed:",
                err.message,
              ),
            );
          }
        })
        .catch((e) =>
          console.error(
            "[Lifecycle Email Error] Hotel lookup failed:",
            e.message,
          ),
        );
    }

    return res
      .status(200)
      .json({ success: true, message: "Guest checked out.", data: updated });
  } catch (error) {
    next(error);
  }
}

/** POST /bookings/:id/payments  { method, amount, reference? } */
export async function recordOfflinePayment(req, res, next) {
  try {
    const booking = await loadBooking(req, res);
    if (!booking) return;

    if (booking.payment?.mode !== "OFFLINE") {
      return fail(
        res,
        400,
        "This booking was paid online; payments are recorded automatically.",
      );
    }
    if (!["CONFIRMED", "CHECKED_IN", "COMPLETED"].includes(booking.status)) {
      return fail(
        res,
        409,
        "Payments can only be recorded on active bookings.",
      );
    }

    const method = req.body?.method;
    const amount = round2(req.body?.amount);
    if (!PAYMENT_METHODS.includes(method))
      return fail(res, 400, "Payment method is not valid.");
    if (!(amount > 0))
      return fail(res, 400, "Amount must be greater than zero.");

    const due = balanceDue(booking);
    if (amount > due + 0.001)
      return fail(res, 400, `Amount exceeds the balance due of INR ${due}.`);

    booking.payment.offlinePayments.push({
      method,
      amount,
      reference: str(req.body?.reference, 80),
      receivedAt: new Date(),
      receivedBy: req.user._id,
    });
    booking.payment.status = round2(due - amount) <= 0 ? "PAID" : "PARTIAL";
    await booking.save();

    await refreshInvoicePayment(booking).catch((e) =>
      console.error("[Invoice] refresh failed:", e.message),
    );

    return res.status(200).json({
      success: true,
      message:
        booking.payment.status === "PAID"
          ? "Payment recorded. Booking is fully paid."
          : "Payment recorded.",
      data: booking,
      balanceDue: balanceDue(booking),
    });
  } catch (error) {
    next(error);
  }
}

/** GET /bookings/:id/invoice - PDF for hotel staff */
export async function downloadBookingInvoice(req, res, next) {
  try {
    const booking = await loadBooking(req, res);
    if (!booking) return;

    const result = await buildInvoicePdf(booking);
    if (!result)
      return fail(
        res,
        409,
        "An invoice is available once the booking is confirmed.",
      );

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
