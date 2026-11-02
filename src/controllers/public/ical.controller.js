import mongoose from "mongoose";
import Hotel from "../../models/Hotel.js";
import RoomType from "../../models/RoomType.js";
import { buildRoomTypeFeed, tokensMatch } from "../../services/ical.service.js";

/**
 * GET /api/v1/public/ical/:hotelSlug/:roomTypeId/:token.ics
 * Availability feed an OTA polls. The token is the only credential, so every
 * failure looks the same (404) and reveals nothing about what exists.
 */
export async function serveIcalFeed(req, res, next) {
  try {
    const { hotelSlug, roomTypeId, file } = req.params;
    const token = String(file || "").endsWith(".ics") ? String(file).slice(0, -4) : "";
    const notFound = () => res.status(404).type("text/plain").send("Not found");

    if (!token || !mongoose.isValidObjectId(roomTypeId)) return notFound();

    const hotel = await Hotel.findOne({ slug: String(hotelSlug), isActive: true }).select("+ical.exportToken name");
    if (!hotel || !tokensMatch(hotel.ical?.exportToken, token)) return notFound();

    const room = await RoomType.findOne({ _id: roomTypeId, hotelId: hotel._id, isActive: true }).select("name");
    if (!room) return notFound();

    const ics = await buildRoomTypeFeed({ hotel, room });
    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="availability.ics"',
      "Cache-Control": "public, max-age=300",
    });
    return res.status(200).send(ics);
  } catch (error) {
    next(error);
  }
}
