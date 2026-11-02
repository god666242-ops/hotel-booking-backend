import { describe, it, expect } from '@jest/globals';
import { evaluateCancellationRefund } from '../../src/services/cancellation.service.js';

describe('Cancellation Service - Tiered Deadlines & Fee Retention', () => {
  const mockHotel = {
    checkInTime: '12:00',
    cancellationPolicy: {
      tiers: [
        { daysBeforeCheckIn: 7, refundPercent: 100 },
        { daysBeforeCheckIn: 2, refundPercent: 50 },
        { daysBeforeCheckIn: 0, refundPercent: 0 },
      ],
    },
  };

  const mockBooking = {
    dates: {
      checkIn: new Date('2026-12-10T00:00:00.000Z'),
    },
    billing: {
      roomBaseTariff: 10000,
      addOnsTotal: 1000,
      hotelGst: 1320,
      platformConvenienceFee: 150,
      grandTotal: 12470, // 10000 + 1000 + 1320 + 150
    },
  };

  it('should grant 100% refund of refundable pool when cancelled >= 7 days prior', () => {
    // Check-in deadline is 2026-12-10 at 12:00 PM.
    // Request on 2026-12-01 (9 days prior).
    const requestDate = new Date('2026-12-01T10:00:00.000Z');

    const result = evaluateCancellationRefund(mockBooking, mockHotel, requestDate);

    // Refundable pool = 10000 + 1000 + 1320 = 12320
    // 100% refund = 12320
    // Retained amount = 150 (strictly the platform fee)
    expect(result.refundPercent).toBe(100);
    expect(result.refundAmount).toBe(12320);
    expect(result.retainedAmount).toBe(150);
    expect(result.nonRefundableFeeRetained).toBe(150);
  });

  it('should grant 50% refund when cancelled between 2 and 6 days prior', () => {
    // Request on 2026-12-06 (4 days prior).
    const requestDate = new Date('2026-12-06T10:00:00.000Z');

    const result = evaluateCancellationRefund(mockBooking, mockHotel, requestDate);

    // Refundable pool = 12320. 50% = 6160.
    // Retained amount = 12470 - 6160 = 6310 (Includes 150 platform fee + 50% room tariff)
    expect(result.refundPercent).toBe(50);
    expect(result.refundAmount).toBe(6160);
    expect(result.retainedAmount).toBe(6310);
    expect(result.nonRefundableFeeRetained).toBe(150);
  });

  it('should grant 0% refund and retain all fees if cancelled within 48 hours of check-in', () => {
    // Request on 2026-12-09 (1 day prior).
    const requestDate = new Date('2026-12-09T14:00:00.000Z');

    const result = evaluateCancellationRefund(mockBooking, mockHotel, requestDate);

    expect(result.refundPercent).toBe(0);
    expect(result.refundAmount).toBe(0);
    expect(result.retainedAmount).toBe(12470);
  });
});