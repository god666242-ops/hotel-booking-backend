import crypto from "crypto";
import mongoose from "mongoose";
import Hotel from "../models/Hotel.js";
import RoomType from "../models/RoomType.js";
import DailyInventory from "../models/DailyInventory.js";
import ExternalCalendar from "../models/ExternalCalendar.js";
import ExternalBlock from "../models/ExternalBlock.js";
import { holdRoomInventory, releaseRoomInventory } from "./inventory.service.js";
import { decryptSecret } from "./crypto.service.js";
import { sendHotelAlertEmail } from "./notification.service.js";
import { addDaysYmd, buildIcs, looksLikeIcs, parseIcsEvents, toYmd } from "../utils/ics.js";
import { fetchTextSafe } from "../utils/safeFetch.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_DAYS_AHEAD = 540;
const MAX_EVENTS = 2000;
const LOCK_MS = 5 * 60 * 1000;
const ALERT_AFTER_FAILURES = 6; // about 90 minutes of failed syncs at the default interval

export const icalUidDomain = () => process.env.ICAL_UID_DOMAIN || "purebook.in";
const utcToday = () => toYmd(new Date());
const toDate = (ymd) => new Date(`${ymd}T00:00:00.000Z`);

/* -------------------------------------------------------------------------- */
/*                                   Export                                   */
/* -------------------------------------------------------------------------- */

export async function getOrCreateExportToken(hotelId) {
  const hotel = await Hotel.findById(hotelId).select("+ical.exportToken");
  if (!hotel) return null;
  if (hotel.ical?.exportToken) return hotel.ical.exportToken;
  const token = crypto.randomBytes(24).toString("hex");
  await Hotel.updateOne({ _id: hotelId, "ical.exportToken": null }, { $set: { "ical.exportToken": token } });
  const fresh = await Hotel.findById(hotelId).select("+ical.exportToken");
  return fresh.ical.exportToken;
}

export async function rotateExportToken(hotelId) {
  const token = crypto.randomBytes(24).toString("hex");
  await Hotel.updateOne({ _id: hotelId }, { $set: { "ical.exportToken": token } });
  return token;
}

export function tokensMatch(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Merges consecutive unavailable dates into [start, end) ranges. */
export function mergeBlockedDays(days) {
  const sorted = [...new Set(days)].sort();
  const ranges = [];
  for (const d of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === d) last.end = addDaysYmd(d, 1);
    else ranges.push({ start: d, end: addDaysYmd(d, 1) });
  }
  return ranges;
}

/**
 * One calendar per room type. A date is "busy" when no room of that type is left to
 * sell (sold out, or stopped by the hotel). iCal can only say busy / free, so for
 * room types with several rooms this means "fully sold out" - which is the right
 * signal for an OTA listing.
 */
export async function buildRoomTypeFeed({ hotel, room }) {
  const from = toDate(utcToday());
  const to = new Date(from.getTime() + FEED_DAYS_AHEAD * DAY_MS);

  const rows = await DailyInventory.find({
    hotelId: hotel._id,
    roomTypeId: room._id,
    date: { $gte: from, $lt: to },
  })
    .select("date availableRooms isBlocked")
    .sort({ date: 1 })
    .lean();

  const busy = rows.filter((r) => r.isBlocked || Number(r.availableRooms) <= 0).map((r) => toYmd(r.date));

  const events = mergeBlockedDays(busy).map((r) => ({
    uid: `${room._id}-${r.start}@${icalUidDomain()}`,
    start: r.start,
    end: r.end,
    summary: "Not available",
  }));

  return buildIcs({
    calendarName: `${hotel.name} - ${room.name}`,
    prodId: "-//HBE//Availability//EN",
    events,
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Import                                   */
/* -------------------------------------------------------------------------- */

/** Fetches + parses a feed into events we care about. Throws a readable error on failure. */
export async function readFeed(url) {
  const text = await fetchTextSafe(url, { allowHttp: process.env.ICAL_ALLOW_HTTP === "true" });
  if (!looksLikeIcs(text)) throw new Error("That link did not return a calendar (.ics) file.");

  const today = utcToday();
  const horizon = addDaysYmd(today, 800);
  const own = `@${icalUidDomain()}`.toLowerCase();

  const byUid = new Map();
  for (const ev of parseIcsEvents(text)) {
    if (ev.cancelled) continue;
    if (ev.uid.toLowerCase().endsWith(own)) continue; // never re-import our own feed
    if (ev.end <= today || ev.start > horizon) continue;
    byUid.set(ev.uid, ev);
  }
  if (byUid.size > MAX_EVENTS) throw new Error("That calendar has too many events to import safely.");
  return [...byUid.values()];
}

/** Takes one room from inventory for the event and records the block, in one transaction. */
async function applyBlock({ calendar, ev, existing }) {
  const session = await mongoose.startSession();
  let status = "CONFLICT";
  try {
    await session.withTransaction(async () => {
      const today = utcToday();
      const appliedStart = ev.start < today ? today : ev.start;

      const hold = await holdRoomInventory({
        hotelId: calendar.hotelId,
        roomTypeId: calendar.roomTypeId,
        checkInDate: toDate(appliedStart),
        checkOutDate: toDate(ev.end),
        roomCount: 1,
        session,
      });
      status = hold.success ? "APPLIED" : "CONFLICT";

      await ExternalBlock.updateOne(
        { calendarId: calendar._id, uid: ev.uid },
        {
          $set: {
            hotelId: calendar.hotelId,
            roomTypeId: calendar.roomTypeId,
            start: toDate(ev.start),
            end: toDate(ev.end),
            appliedStart: hold.success ? toDate(appliedStart) : null,
            summary: ev.summary,
            status,
          },
        },
        { upsert: true, session },
      );
    });
  } finally {
    await session.endSession();
  }
  return status;
}

/** Gives the room back and deletes the block record, in one transaction. */
async function removeBlock({ calendar, block }) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (block.status === "APPLIED" && block.appliedStart && toYmd(block.end) > utcToday()) {
        await releaseRoomInventory({
          hotelId: calendar.hotelId,
          roomTypeId: calendar.roomTypeId,
          checkInDate: block.appliedStart,
          checkOutDate: block.end,
          roomCount: 1,
          session,
        });
      }
      await ExternalBlock.deleteOne({ _id: block._id }, { session });
    });
  } finally {
    await session.endSession();
  }
}

async function claimLock(calendarId) {
  const now = new Date();
  return ExternalCalendar.findOneAndUpdate(
    { _id: calendarId, $or: [{ syncLockUntil: null }, { syncLockUntil: { $lt: now } }] },
    { $set: { syncLockUntil: new Date(now.getTime() + LOCK_MS) } },
    { new: true },
  );
}

/**
 * Brings our inventory in line with one external calendar.
 * A failed download changes NOTHING, so an OTA outage can never reopen sold dates.
 * Returns { ok, applied, removed, conflicts, error }.
 */
export async function syncCalendar(calendarId) {
  const calendar = await claimLock(calendarId);
  if (!calendar) return { ok: false, skipped: true, error: "A sync is already running for this calendar." };

  const result = { ok: false, applied: 0, removed: 0, conflicts: 0, error: null };
  const newConflicts = [];

  try {
    const events = await readFeed(decryptSecret(calendar.urlEncrypted));
    const byUid = new Map(events.map((e) => [e.uid, e]));
    const existing = await ExternalBlock.find({ calendarId: calendar._id });
    const existingByUid = new Map(existing.map((b) => [b.uid, b]));
    const today = utcToday();

    // 1. Reservations that disappeared from the feed (cancelled on the OTA, or already past)
    for (const block of existing) {
      if (!byUid.has(block.uid)) {
        await removeBlock({ calendar, block });
        result.removed += 1;
      }
    }

    // 2. New or changed reservations; conflicts get another chance in case the date freed up
    for (const ev of events) {
      const block = existingByUid.get(ev.uid);
      const sameRange = block && toYmd(block.start) === ev.start && toYmd(block.end) === ev.end;

      if (block && sameRange && block.status === "APPLIED") continue;

      if (block && !sameRange) {
        await removeBlock({ calendar, block });
        result.removed += 1;
      }

      const status = await applyBlock({ calendar, ev });
      if (status === "APPLIED") result.applied += 1;
      if (status === "CONFLICT" && (!block || !sameRange)) {
        newConflicts.push({ start: ev.start < today ? today : ev.start, end: ev.end, summary: ev.summary });
      }
    }

    result.conflicts = await ExternalBlock.countDocuments({ calendarId: calendar._id, status: "CONFLICT" });
    result.ok = true;

    await ExternalCalendar.updateOne(
      { _id: calendar._id },
      {
        $set: {
          lastSyncAt: new Date(),
          lastSuccessAt: new Date(),
          lastError: null,
          consecutiveFailures: 0,
          eventCount: events.length,
          conflictCount: result.conflicts,
          syncLockUntil: null,
        },
      },
    );
  } catch (err) {
    result.error = String(err?.message || err).slice(0, 300);
    const updated = await ExternalCalendar.findOneAndUpdate(
      { _id: calendar._id },
      {
        $set: { lastSyncAt: new Date(), lastError: result.error, syncLockUntil: null },
        $inc: { consecutiveFailures: 1 },
      },
      { new: true },
    );
    if (updated?.consecutiveFailures === ALERT_AFTER_FAILURES) {
      await alertHotel(calendar, {
        subject: `Calendar sync is failing: ${calendar.name}`,
        heading: `We could not read your ${calendar.name} calendar`,
        lines: [
          result.error,
          "Until it works again, new bookings on that channel will not block rooms here. Check that the link is still valid.",
        ],
      });
    }
  }

  if (newConflicts.length > 0) {
    await alertHotel(calendar, {
      subject: `Possible double booking on ${calendar.name}`,
      heading: "A channel booking overlaps rooms you already sold",
      lines: newConflicts.map(
        (c) => `${calendar.name}: ${c.start} to ${c.end}${c.summary ? ` (${c.summary})` : ""} - no room was left to block.`,
      ),
    });
  }

  return result;
}

async function alertHotel(calendar, { subject, heading, lines }) {
  const hotel = await Hotel.findById(calendar.hotelId).select("name contact.email").lean();
  const room = await RoomType.findById(calendar.roomTypeId).select("name").lean();
  await sendHotelAlertEmail({
    to: hotel?.contact?.email,
    hotelName: hotel?.name || "Your hotel",
    subject,
    heading,
    lines: [...(room ? [`Room type: ${room.name}`] : []), ...lines],
  });
}

/** Removes a calendar and gives back every room it was holding. */
export async function deleteCalendar(calendar) {
  const blocks = await ExternalBlock.find({ calendarId: calendar._id });
  for (const block of blocks) await removeBlock({ calendar, block });
  await ExternalCalendar.deleteOne({ _id: calendar._id });
}

/* -------------------------------------------------------------------------- */
/*                                  Scheduler                                 */
/* -------------------------------------------------------------------------- */

let running = false;

export async function syncAllCalendars() {
  if (running) return;
  running = true;
  try {
    const dueBefore = new Date(Date.now() - 10 * 60 * 1000);
    const calendars = await ExternalCalendar.find({
      isActive: true,
      $or: [{ lastSyncAt: null }, { lastSyncAt: { $lt: dueBefore } }],
    })
      .select("_id")
      .limit(200)
      .lean();
    for (const c of calendars) {
      await syncCalendar(c._id).catch((err) => console.error("[iCal Sync Error]", err?.message || err));
    }
  } catch (err) {
    console.error("[iCal Scheduler Error]", err?.message || err);
  } finally {
    running = false;
  }
}

/** Starts the periodic import (default every 15 minutes). Set ICAL_SYNC_DISABLED=true to turn off. */
export function startIcalSyncScheduler(intervalMs = 15 * 60 * 1000) {
  if (process.env.ICAL_SYNC_DISABLED === "true") {
    console.log("[Scheduler] iCal sync disabled by ICAL_SYNC_DISABLED.");
    return null;
  }
  console.log("[Scheduler] iCal calendar sync worker active.");
  const timer = setInterval(syncAllCalendars, intervalMs);
  timer.unref?.();
  return timer;
}
