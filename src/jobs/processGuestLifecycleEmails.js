import Booking from "../models/Booking.js";
import Hotel from "../models/Hotel.js";
import RoomType from "../models/RoomType.js";
import {
  sendPreArrivalGuideEmail,
  sendPostStayReviewEmail,
} from "../services/notification.service.js";

/**
 * Sweeps confirmed bookings arriving in 24 to 48 hours and sends pre-arrival guides.
 * Sweeps completed bookings checked out 24 to 48 hours ago and sends review / promo emails.
 * Uses atomic CAS locks to prevent duplicate emails across multiple workers.
 */
export async function processGuestLifecycleEmails() {
  const now = new Date();

  // ── 1. Pre-Arrival Guide (Check-in between 24 and 48 hours from now) ──
  try {
    const minCheckIn = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const maxCheckIn = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const upcomingBookings = await Booking.find({
      status: "CONFIRMED",
      "dates.checkIn": { $gte: minCheckIn, $lte: maxCheckIn },
      "lifecycle.preArrivalSentAt": null,
      "guest.email": { $exists: true, $ne: "" },
    })
      .select("_id bookingCode hotelId roomTypeId guest dates")
      .lean();

    for (const booking of upcomingBookings) {
      // Atomic CAS Claim: only the worker that flips null -> Date proceeds
      const claimed = await Booking.findOneAndUpdate(
        { _id: booking._id, "lifecycle.preArrivalSentAt": null },
        { $set: { "lifecycle.preArrivalSentAt": new Date() } },
        { new: true },
      );

      if (!claimed) continue; // Another process already claimed this booking

      try {
        const [hotel, roomType] = await Promise.all([
          Hotel.findById(booking.hotelId).lean(),
          RoomType.findById(booking.roomTypeId).lean(),
        ]);

        if (hotel) {
          await sendPreArrivalGuideEmail({ booking: claimed, hotel, roomType });
          console.log(
            `[Lifecycle Job] Pre-arrival guide sent for ${booking.bookingCode} -> ${booking.guest.email}`,
          );
        }
      } catch (err) {
        console.error(
          `[Lifecycle Job] Failed sending pre-arrival email for ${booking.bookingCode}:`,
          err.message,
        );
        // Revert lock so a future tick can retry delivery
        await Booking.updateOne(
          { _id: booking._id },
          { $set: { "lifecycle.preArrivalSentAt": null } },
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[Lifecycle Job Error - PreArrival]:", err.message);
  }

  // ── 2. Post-Checkout Review & Loyalty Promo (Checked out 24 to 48 hours ago) ──
  try {
    const minCheckOut = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const maxCheckOut = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const completedBookings = await Booking.find({
      status: "COMPLETED",
      "dates.checkOut": { $gte: minCheckOut, $lte: maxCheckOut },
      "lifecycle.postStayReviewSentAt": null,
      "guest.email": { $exists: true, $ne: "" },
    })
      .select("_id bookingCode hotelId roomTypeId guest dates")
      .lean();

    for (const booking of completedBookings) {
      // Atomic CAS Claim: only the worker that flips null -> Date proceeds
      const claimed = await Booking.findOneAndUpdate(
        { _id: booking._id, "lifecycle.postStayReviewSentAt": null },
        { $set: { "lifecycle.postStayReviewSentAt": new Date() } },
        { new: true },
      );

      if (!claimed) continue; // Another process already claimed this booking

      try {
        const hotel = await Hotel.findById(booking.hotelId).lean();
        if (hotel) {
          const firstPromo =
            hotel.promoCodes?.find((p) => p.isActive !== false)?.code || null;
          await sendPostStayReviewEmail({
            booking: claimed,
            hotel,
            promoCode: firstPromo,
          });
          console.log(
            `[Lifecycle Job] Post-stay review email sent for ${booking.bookingCode} -> ${booking.guest.email}`,
          );
        }
      } catch (err) {
        console.error(
          `[Lifecycle Job] Failed sending post-stay review email for ${booking.bookingCode}:`,
          err.message,
        );
        // Revert lock so a future tick can retry delivery
        await Booking.updateOne(
          { _id: booking._id },
          { $set: { "lifecycle.postStayReviewSentAt": null } },
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[Lifecycle Job Error - PostStay]:", err.message);
  }
}

let isRunning = false;

async function runLifecycle() {
  if (isRunning) return;
  isRunning = true;
  try {
    await processGuestLifecycleEmails();
  } finally {
    isRunning = false;
  }
}

/**
 * Runs every 2 hours (7,200,000 ms).
 */
export function startGuestLifecycleScheduler(intervalMs = 7200000) {
  console.log(
    "[Scheduler] Guest lifecycle email scheduler (Pre-Arrival & Reviews) initialized.",
  );
  const timer = setInterval(runLifecycle, intervalMs);
  timer.unref?.();
  return timer;
}
