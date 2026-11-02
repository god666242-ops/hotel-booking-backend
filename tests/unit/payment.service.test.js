import { describe, it, expect, jest } from '@jest/globals';
import { refundPaymentIdempotent } from '../../src/services/payment.service.js';

function fakeRazorpay({ amount, amount_refunded }) {
  return {
    payments: {
      fetch: jest.fn().mockResolvedValue({ amount, amount_refunded }),
      refund: jest.fn().mockResolvedValue({ id: 'rfnd_1' }),
    },
  };
}

describe('refundPaymentIdempotent', () => {
  it('refunds the full target when nothing has been refunded yet', async () => {
    const rzp = fakeRazorpay({ amount: 100000, amount_refunded: 0 });
    const result = await refundPaymentIdempotent(rzp, 'pay_1', 100000);

    expect(rzp.payments.refund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 100000 }));
    expect(result).toMatchObject({ refundId: 'rfnd_1', alreadyRefunded: false });
  });

  it('does not refund again when the target was already refunded (retry after a crash)', async () => {
    const rzp = fakeRazorpay({ amount: 100000, amount_refunded: 100000 });
    const result = await refundPaymentIdempotent(rzp, 'pay_1', 100000);

    expect(rzp.payments.refund).not.toHaveBeenCalled();
    expect(result.alreadyRefunded).toBe(true);
  });

  it('only refunds the remaining difference for a partial earlier refund', async () => {
    const rzp = fakeRazorpay({ amount: 100000, amount_refunded: 30000 });
    await refundPaymentIdempotent(rzp, 'pay_1', 50000);

    expect(rzp.payments.refund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 20000 }));
  });

  it('never refunds more than was paid', async () => {
    const rzp = fakeRazorpay({ amount: 100000, amount_refunded: 0 });
    await refundPaymentIdempotent(rzp, 'pay_1', 999999);

    expect(rzp.payments.refund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 100000 }));
  });
});
