import { describe, it, expect } from '@jest/globals';
import {
  parseClockTime,
  getCheckInDeadline,
} from '../../src/services/cancellation.service.js';

describe('check-in time parsing', () => {
  it('parses 24h and 12h formats', () => {
    expect(parseClockTime('14:30')).toEqual({ hours: 14, minutes: 30 });
    expect(parseClockTime('02:00 PM')).toEqual({ hours: 14, minutes: 0 });
    expect(parseClockTime('12:00 AM')).toEqual({ hours: 0, minutes: 0 });
    expect(parseClockTime('12:15 PM')).toEqual({ hours: 12, minutes: 15 });
  });

  it('falls back to noon instead of producing an invalid date', () => {
    expect(parseClockTime('noonish')).toEqual({ hours: 12, minutes: 0 });
    expect(parseClockTime(undefined)).toEqual({ hours: 12, minutes: 0 });
    expect(parseClockTime('25:99')).toEqual({ hours: 12, minutes: 0 });
  });

  it('computes the deadline in IST (UTC+05:30)', () => {
    const booking = { dates: { checkIn: new Date('2026-12-10T00:00:00.000Z') } };

    // 14:00 IST == 08:30 UTC
    expect(getCheckInDeadline(booking, { checkInTime: '14:00' }).toISOString()).toBe(
      '2026-12-10T08:30:00.000Z',
    );
    // "02:00 PM" must behave exactly like "14:00" (used to become NaN)
    expect(getCheckInDeadline(booking, { checkInTime: '02:00 PM' }).toISOString()).toBe(
      '2026-12-10T08:30:00.000Z',
    );
  });
});
