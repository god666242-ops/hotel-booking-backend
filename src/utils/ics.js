/**
 * Tiny iCalendar (RFC 5545) reader/writer, enough for OTA availability feeds.
 * Only the fields channel feeds actually use are supported (no RRULE).
 */

const pad = (n) => String(n).padStart(2, "0");

export function toYmd(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDaysYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

/** Joins folded lines ("\r\n " continuation) into logical lines. */
function unfold(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function unescapeText(v) {
  return v.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** "20261101" or "20261101T150000Z" -> "2026-11-01" (the calendar date as written). */
function parseDateValue(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(raw || "").trim());
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(new Date(`${ymd}T00:00:00.000Z`).getTime()) ? null : ymd;
}

export function looksLikeIcs(text) {
  return /BEGIN:VCALENDAR/i.test(String(text).slice(0, 2000));
}

/**
 * Returns [{ uid, start, end, summary, cancelled }] with start/end as YYYY-MM-DD.
 * `end` is exclusive (the night of `end` is free), matching hotel check-out.
 */
export function parseIcsEvents(text) {
  const events = [];
  let current = null;

  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      current = {};
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      if (current?.start) {
        let end = current.end || addDaysYmd(current.start, 1);
        if (end <= current.start) end = addDaysYmd(current.start, 1);
        events.push({
          uid: current.uid || `${current.start}_${end}_${current.summary || ""}`,
          start: current.start,
          end,
          summary: current.summary || "",
          cancelled: /^CANCELLED$/i.test(current.status || ""),
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1);

    if (name === "DTSTART") current.start = parseDateValue(value);
    else if (name === "DTEND") current.end = parseDateValue(value);
    else if (name === "UID") current.uid = value.trim();
    else if (name === "SUMMARY") current.summary = unescapeText(value).trim().slice(0, 200);
    else if (name === "STATUS") current.status = value.trim();
  }
  return events;
}

function escapeText(v) {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets, as RFC 5545 requires. */
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

const compact = (ymd) => ymd.replace(/-/g, "");

/** events: [{ uid, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', summary }] */
export function buildIcs({ calendarName, prodId = "-//HBE//Availability//EN", events = [], now = new Date() }) {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodId}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (calendarName) lines.push(`X-WR-CALNAME:${escapeText(calendarName)}`);

  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.start)}`,
      `DTEND;VALUE=DATE:${compact(e.end)}`,
      `SUMMARY:${escapeText(e.summary || "Not available")}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
