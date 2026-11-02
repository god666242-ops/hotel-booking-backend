// backend/tests/unit/payAtHotel.test.js
import {
  evaluatePayAtHotelCancellation,
  evaluateBookingModification,
} from "../../src/services/cancellation.service.js";

const booking = {
  billing: { grandTotal: 6720 },
  payment: { mode: "PAY_AT_HOTEL", amountPayableNow: 480, amountDueAtHotel: 6240 },
};

describe("pay-at-hotel cancellation", () => {
  it("does not refund the online fee when the guest cancels", () => {
    const e = evaluatePayAtHotelCancellation(booking, {
      cancelledBy: "GUEST_SELF_SERVICE",
    });
    expect(e.refundAmount).toBe(0);
    expect(e.retainedAmount).toBe(480);
    expect(e.isNonRefundable).toBe(false); // the guest must still be able to cancel
  });

  it("refunds the online fee in full when the hotel cancels", () => {
    const e = evaluatePayAtHotelCancellation(booking, { cancelledBy: "HOTELIER" });
    expect(e.refundAmount).toBe(480);
    expect(e.refundPercent).toBe(100);
    expect(e.retainedAmount).toBe(0);
  });
});

describe("pay-at-hotel modification", () => {
  it("never asks for an online payment or refund", () => {
    const up = evaluateBookingModification({
      originalBooking: booking,
      newPricingBreakdown: { grandTotal: 8000 },
    });
    expect(up.action).toBe("PAYMENT_DUE");
    expect(up.requiresOnlinePayment).toBe(false);

    const down = evaluateBookingModification({
      originalBooking: booking,
      newPricingBreakdown: { grandTotal: 5000 },
    });
    expect(down.action).toBe("REFUND_DUE");
    expect(down.requiresOnlineRefund).toBe(false);
  });
});