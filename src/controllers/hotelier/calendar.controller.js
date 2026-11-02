import mongoose from "mongoose";
import Hotel from "../../models/Hotel.js";
import RoomType from "../../models/RoomType.js";
import ExternalCalendar from "../../models/ExternalCalendar.js";
import ExternalBlock from "../../models/ExternalBlock.js";
import { encryptSecret } from "../../services/crypto.service.js";
import {
  deleteCalendar,
  getOrCreateExportToken,
  readFeed,
  rotateExportToken,
  syncCalendar,
} from "../../services/ical.service.js";
import { assertAllowedUrlShape, UnsafeUrlError } from "../../utils/safeFetch.js";

const MAX_CALENDARS_PER_ROOM = 10;

function apiBase(req) {
  const configured = process.env.API_PUBLIC_URL;
  return (configured || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

const exportUrl = (req, hotel, roomTypeId, token) =>
  `${apiBase(req).replace(/\/api\/v1$/, "")}/api/v1/public/ical/${hotel.slug}/${roomTypeId}/${token}.ics`;

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/** GET /calendars - export links, connected feeds and unresolved conflicts */
export async function getCalendarSync(req, res, next) {
  try {
    const hotel = await Hotel.findById(req.user.hotelId).select("slug name");
    if (!hotel) return fail(res, 404, "Hotel not found.");

    const token = await getOrCreateExportToken(hotel._id);
    const rooms = await RoomType.find({ hotelId: hotel._id, isActive: true }).select("name").sort({ sortOrder: 1 }).lean();
    const roomName = new Map(rooms.map((r) => [String(r._id), r.name]));

    const calendars = await ExternalCalendar.find({ hotelId: hotel._id }).sort({ createdAt: 1 }).lean();
    const calendarName = new Map(calendars.map((c) => [String(c._id), c.name]));

    const conflicts = await ExternalBlock.find({ hotelId: hotel._id, status: "CONFLICT" }).sort({ start: 1 }).limit(100).lean();

    return res.status(200).json({
      success: true,
      data: {
        exportLinks: rooms.map((r) => ({
          roomTypeId: r._id,
          roomName: r.name,
          url: exportUrl(req, hotel, r._id, token),
        })),
        imports: calendars.map((c) => ({
          id: c._id,
          roomTypeId: c.roomTypeId,
          roomName: roomName.get(String(c.roomTypeId)) || "Removed room type",
          name: c.name,
          source: c.urlHint,
          isActive: c.isActive,
          lastSyncAt: c.lastSyncAt,
          lastSuccessAt: c.lastSuccessAt,
          lastError: c.lastError,
          eventCount: c.eventCount,
          conflictCount: c.conflictCount,
        })),
        conflicts: conflicts.map((b) => ({
          id: b._id,
          calendarName: calendarName.get(String(b.calendarId)) || "",
          roomName: roomName.get(String(b.roomTypeId)) || "",
          start: b.start,
          end: b.end,
          summary: b.summary,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
}

/** POST /calendars { roomTypeId, name, url } */
export async function addCalendar(req, res, next) {
  try {
    const { roomTypeId } = req.body || {};
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 60) : "";
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";

    if (!mongoose.isValidObjectId(roomTypeId)) return fail(res, 400, "Choose a room type.");
    if (!name) return fail(res, 400, "Give the calendar a name, e.g. Booking.com.");
    if (!url) return fail(res, 400, "Paste the calendar (iCal) link.");

    const room = await RoomType.findOne({ _id: roomTypeId, hotelId: req.user.hotelId }).select("name");
    if (!room) return fail(res, 404, "Room type not found.");

    let parsed;
    try {
      parsed = assertAllowedUrlShape(url, { allowHttp: process.env.ICAL_ALLOW_HTTP === "true" });
    } catch (err) {
      if (err instanceof UnsafeUrlError) return fail(res, 400, err.message);
      throw err;
    }
    if (parsed.pathname.includes("/public/ical/")) {
      return fail(res, 400, "That is this system's own export link. Paste the link from the other channel instead.");
    }

    if ((await ExternalCalendar.countDocuments({ hotelId: req.user.hotelId, roomTypeId })) >= MAX_CALENDARS_PER_ROOM) {
      return fail(res, 400, `A room type can have at most ${MAX_CALENDARS_PER_ROOM} connected calendars.`);
    }

    // Prove the link works before saving it
    try {
      await readFeed(url);
    } catch (err) {
      return fail(res, 400, `We could not read that calendar: ${err.message}`);
    }

    const calendar = await ExternalCalendar.create({
      hotelId: req.user.hotelId,
      roomTypeId,
      name,
      urlEncrypted: encryptSecret(url),
      urlHint: parsed.hostname,
    });

    const result = await syncCalendar(calendar._id);
    return res.status(201).json({
      success: true,
      message: result.ok
        ? `Connected. Imported ${result.applied} reservation${result.applied === 1 ? "" : "s"}${
            result.conflicts ? ` (${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"} need attention)` : ""
          }.`
        : `Connected, but the first sync failed: ${result.error}`,
      data: { id: calendar._id, ...result },
    });
  } catch (error) {
    next(error);
  }
}

async function loadCalendar(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 400, "Invalid calendar id.");
    return null;
  }
  const calendar = await ExternalCalendar.findOne({ _id: req.params.id, hotelId: req.user.hotelId });
  if (!calendar) {
    fail(res, 404, "Calendar not found.");
    return null;
  }
  return calendar;
}

/** POST /calendars/:id/sync */
export async function syncCalendarNow(req, res, next) {
  try {
    const calendar = await loadCalendar(req, res);
    if (!calendar) return;
    const result = await syncCalendar(calendar._id);
    if (result.skipped) return fail(res, 409, result.error);
    if (!result.ok) return fail(res, 502, `Sync failed: ${result.error}`);
    return res.status(200).json({ success: true, message: "Calendar synced.", data: result });
  } catch (error) {
    next(error);
  }
}

/** DELETE /calendars/:id - also gives back every room the feed was blocking */
export async function removeCalendar(req, res, next) {
  try {
    const calendar = await loadCalendar(req, res);
    if (!calendar) return;
    await deleteCalendar(calendar);
    return res.status(200).json({ success: true, message: "Calendar disconnected and its blocked dates were released." });
  } catch (error) {
    next(error);
  }
}

/** POST /calendars/regenerate-token - invalidates every export link already shared */
export async function regenerateExportToken(req, res, next) {
  try {
    await rotateExportToken(req.user.hotelId);
    return res.status(200).json({
      success: true,
      message: "New export links created. Update them in each channel; the old links no longer work.",
    });
  } catch (error) {
    next(error);
  }
}
