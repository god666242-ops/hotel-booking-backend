import crypto from "crypto";
import Booking from "../models/Booking.js";

/**
 * BK-YYYYMM-XXXXXXXXXX (40 random bits). The old 24-bit suffix collided often
 * enough to surface as a 409 to real guests. We also check for an existing code
 * and retry, so a collision never reaches the guest.
 */
export function randomBookingCode(now = new Date()) {
  const hex = crypto.randomBytes(5).toString("hex").toUpperCase();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `BK-${ym}-${hex}`;
}

export async function generateUniqueBookingCode(session = null, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const code = randomBookingCode();
    const q = Booking.exists({ bookingCode: code });
    if (session) q.session(session);
    if (!(await q)) return code;
  }
  throw new Error("Could not allocate a unique booking code. Please try again.");
}
