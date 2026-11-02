import { describe, it, expect } from '@jest/globals';
import { pickCapturedPayment } from '../../src/jobs/reconcilePayments.js';

describe('pickCapturedPayment', () => {
  it('returns null when nothing was captured', () => {
    expect(pickCapturedPayment([])).toBeNull();
    expect(pickCapturedPayment(undefined)).toBeNull();
    expect(
      pickCapturedPayment([
        { id: 'pay_1', status: 'failed' },
        { id: 'pay_2', status: 'created' },
        { id: 'pay_3', status: 'refunded' },
      ]),
    ).toBeNull();
  });

  it('ignores failed attempts and returns the captured payment', () => {
    const p = pickCapturedPayment([
      { id: 'pay_1', status: 'failed', created_at: 100 },
      { id: 'pay_2', status: 'captured', created_at: 200 },
    ]);
    expect(p.id).toBe('pay_2');
  });

  it('keeps the earliest capture if the guest paid twice', () => {
    const p = pickCapturedPayment([
      { id: 'pay_late', status: 'captured', created_at: 300 },
      { id: 'pay_early', status: 'captured', created_at: 200 },
    ]);
    expect(p.id).toBe('pay_early');
  });
});
