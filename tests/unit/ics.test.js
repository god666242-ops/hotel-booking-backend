import { describe, it, expect } from '@jest/globals';
import { buildIcs, parseIcsEvents, looksLikeIcs, addDaysYmd } from '../../src/utils/ics.js';

describe('iCal parser', () => {
  it('reads all-day events and treats DTEND as the (exclusive) check-out', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\nDTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261108\r\nSUMMARY:Reserved\\, OTA\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(parseIcsEvents(ics)).toEqual([
      { uid: 'abc', start: '2026-11-05', end: '2026-11-08', summary: 'Reserved, OTA', cancelled: false },
    ]);
  });

  it('defaults a missing DTEND to one night and flags cancelled events', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261210\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261201T150000Z\r\nDTEND:20261203T110000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const [a, b] = parseIcsEvents(ics);
    expect(a.end).toBe('2026-12-11');
    expect(b.cancelled).toBe(true);
    expect(b.start).toBe('2026-12-01');
  });

  it('unfolds long lines', () => {
    const ics = 'BEGIN:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Part one\r\n  and two\r\nEND:VEVENT';
    expect(parseIcsEvents(ics)[0].summary).toBe('Part one and two');
  });

  it('rejects things that are not calendars', () => {
    expect(looksLikeIcs('<html>login</html>')).toBe(false);
    expect(looksLikeIcs('BEGIN:VCALENDAR\r\n')).toBe(true);
  });

  it('round-trips what it writes', () => {
    const out = buildIcs({ events: [{ uid: 'r@purebook.in', start: '2026-11-01', end: '2026-11-04', summary: 'Not available' }] });
    expect(out.endsWith('\r\n')).toBe(true);
    expect(parseIcsEvents(out)).toEqual([
      { uid: 'r@purebook.in', start: '2026-11-01', end: '2026-11-04', summary: 'Not available', cancelled: false },
    ]);
  });

  it('adds days across month ends', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
  });
});
