// backend/tests/unit/paymentAmounts.test.js
//
// Regression tests for the "total shown / used as paid" fixes:
//   1. Late-paid expired holds refund the right amount (pay-at-hotel = fee only)
//   2. Hotelier price-drop refund keeps payment.amountPaidOnline in step
//   3. Guest cancellation of a pay-at-hotel booking never refunds the fee
//
// Everything external (Mongo, Razorpay, e-mail, inventory) is mocked, so these
// run without a database or network.
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------
const Booking = {
  findOneAndUpdate: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
};
const Hotel = { findById: jest.fn() };
const RoomType = { findOne: jest.fn() };
const DailyInventory = { find: jest.fn() };

const session = {
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(async () => {}),
  abortTransaction: jest.fn(async () => {}),
  endSession: jest.fn(async () => {}),
  inTransaction: jest.fn(() => false),
  withTransaction: async (cb) => cb(),
};

const holdRoomInventory = jest.fn();
const releaseRoomInventory = jest.fn(async () => {});
const removeRedisHoldLock = jest.fn(async () => {});
const refundPaymentIdempotent = jest.fn();
const rzp = { payments: { fetch: jest.fn() } };
const getRazorpayClient = jest.fn(() => rzp);
const sendSystemAlert = jest.fn(async () => {});
const calculatePricingBreakdown = jest.fn();

jest.unstable_mockModule("mongoose", () => ({
  default: {
    isValidObjectId: () => true,
    startSession: async () => session,
    Types: { ObjectId: class {} },
  },
}));
jest.unstable_mockModule("../../src/models/Booking.js", () => ({
  default: Booking,
}));
jest.unstable_mockModule("../../src/models/Hotel.js", () => ({
  default: Hotel,
}));
jest.unstable_mockModule("../../src/models/RoomType.js", () => ({
  default: RoomType,
}));
jest.unstable_mockModule("../../src/models/DailyInventory.js", () => ({
  default: DailyInventory,
}));
jest.unstable_mockModule("../../src/services/inventory.service.js", () => ({
  holdRoomInventory,
  releaseRoomInventory,
  removeRedisHoldLock,
}));
jest.unstable_mockModule("../../src/services/notification.service.js", () => ({
  sendBookingConfirmation: jest.fn(async () => {}),
  sendCancellationNotice: jest.fn(async () => {}),
}));
jest.unstable_mockModule("../../src/services/invoice.service.js", () => ({
  tryIssueInvoiceForEmail: jest.fn(async () => {}),
  syncInvoiceAfterModification: jest.fn(async () => {}),
  offlinePaidTotal: jest.fn(() => 0),
}));
jest.unstable_mockModule("../../src/services/payment.service.js", () => ({
  getRazorpayClient,
  refundPaymentIdempotent,
}));
jest.unstable_mockModule("../../src/services/pricing.service.js", () => ({
  calculatePricingBreakdown,
}));
jest.unstable_mockModule(
  "../../src/services/bookingCancellation.service.js",
  () => ({ cancelConfirmedBooking: jest.fn() }),
);
jest.unstable_mockModule("../../src/utils/systemAlerts.js", () => ({
  sendSystemAlert,
}));

const { confirmPaidBooking } =
  await import("../../src/services/paymentConfirmation.service.js");
const { modifyBooking } =
  await import("../../src/controllers/hotelier/booking.controller.js");
const { evaluatePayAtHotelCancellation } =
  await import("../../src/services/cancellation.service.js");

// Finds the Booking.updateOne call whose update sets the given dotted key.
const updateSetting = (key) =>
  Booking.updateOne.mock.calls.find((c) => c[1]?.$set && key in c[1].$set);
const updateSettingStatus = (status) =>
  Booking.updateOne.mock.calls.find((c) => c[1]?.$set?.status === status);
jest.spyOn(console, "error").mockImplementation(() => {});
beforeEach(() => {
  jest.clearAllMocks();
  Booking.updateOne.mockResolvedValue({});
  refundPaymentIdempotent.mockResolvedValue({ refundId: "rfnd_1" });
  holdRoomInventory.mockResolvedValue({ success: true });
});

// ===========================================================================
// 1. Late-paid expired hold: refund amount
// ===========================================================================
describe("late payment on an expired hold, rooms already resold", () => {
  const expiredBooking = { _id: "b1", status: "EXPIRED", hotelId: "h1" };

  function lockedBooking(payment, grandTotal) {
    return {
      _id: "b1",
      bookingCode: "BK-202611-LATE01",
      hotelId: "h1",
      roomTypeId: "r1",
      roomCount: 1,
      dates: {
        checkIn: new Date("2026-12-10T00:00:00.000Z"),
        checkOut: new Date("2026-12-12T00:00:00.000Z"),
      },
      billing: { grandTotal },
      payment,
    };
  }

  function arrange(locked, razorpayPayment) {
    Hotel.findById.mockResolvedValue({ _id: "h1" });
    // 1st call: HELD -> CONFIRMED finds nothing (hold expired)
    // 2nd call: EXPIRED -> REHOLD_IN_PROGRESS lock succeeds
    Booking.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(locked);
    holdRoomInventory.mockResolvedValue({ success: false }); // rooms resold
    rzp.payments.fetch.mockResolvedValue(razorpayPayment);
  }

  it("refunds only the booking fee for a pay-at-hotel booking", async () => {
    // Guest paid the Rs 368 fee online; the Rs 5,152 total is due at the hotel.
    arrange(
      lockedBooking({ mode: "PAY_AT_HOTEL", amountPayableNow: 368 }, 5152),
      { amount: 36800, amount_refunded: 0 },
    );

    const result = await confirmPaidBooking({
      booking: expiredBooking,
      paymentId: "pay_late",
      signature: "sig",
    });

    expect(result).toBeNull();
    expect(refundPaymentIdempotent).toHaveBeenCalledTimes(1);
    // paise: 36800, NOT 515200 (which Razorpay would reject)
    expect(refundPaymentIdempotent.mock.calls[0][1]).toBe("pay_late");
    expect(refundPaymentIdempotent.mock.calls[0][2]).toBe(36800);

    const done = updateSettingStatus("EXPIRED_REFUNDED");
    expect(done).toBeDefined();
    expect(done[1].$set.cancellation.amountRefunded).toBe(368);
  });

  it("refunds the full total for a fully prepaid online booking", async () => {
    arrange(lockedBooking({ mode: "HOTEL_GATEWAY" }, 5152), {
      amount: 515200,
      amount_refunded: 0,
    });

    await confirmPaidBooking({
      booking: expiredBooking,
      paymentId: "pay_late",
      signature: "sig",
    });

    expect(refundPaymentIdempotent.mock.calls[0][2]).toBe(515200);
    expect(
      updateSettingStatus("EXPIRED_REFUNDED")[1].$set.cancellation
        .amountRefunded,
    ).toBe(5152);
  });

  it("does not refund twice when Razorpay shows the fee already refunded", async () => {
    arrange(
      lockedBooking({ mode: "PAY_AT_HOTEL", amountPayableNow: 368 }, 5152),
      { amount: 36800, amount_refunded: 36800 },
    );

    await confirmPaidBooking({
      booking: expiredBooking,
      paymentId: "pay_late",
      signature: "sig",
    });

    expect(refundPaymentIdempotent).not.toHaveBeenCalled();
    expect(
      updateSettingStatus("EXPIRED_REFUNDED")[1].$set.cancellation
        .amountRefunded,
    ).toBe(368);
  });
});

// ===========================================================================
// 2. Hotelier price-drop modification keeps amountPaidOnline in step
// ===========================================================================
describe("hotelier modifyBooking: refund and amountPaidOnline", () => {
  function makeBooking({ payment, grandTotal = 7000 } = {}) {
    return {
      _id: "b1",
      bookingCode: "BK-202611-MOD001",
      hotelId: "h1",
      roomTypeId: "r1",
      roomCount: 1,
      status: "CONFIRMED",
      dates: {
        checkIn: new Date("2026-12-10T00:00:00.000Z"),
        checkOut: new Date("2026-12-12T00:00:00.000Z"),
        nights: 2,
      },
      occupancy: { adults: 2, children: 0 },
      billing: {
        roomBaseTariff: 6000,
        discountTotal: 0,
        addOnsTotal: 0,
        hotelGst: 720,
        platformConvenienceFee: 280,
        grandTotal,
      },
      payment,
      promotions: {},
      selectedAddOns: [],
      save: jest.fn(async () => {}),
    };
  }

  function newPricing(grandTotal) {
    calculatePricingBreakdown.mockReturnValue({
      roomBaseTariff: grandTotal - 1000,
      discountTotal: 0,
      addOnsTotal: 0,
      hotelGst: 720,
      grandTotal,
    });
  }

  async function run(booking) {
    Booking.findOne.mockResolvedValue(booking);
    Hotel.findById.mockResolvedValue({ _id: "h1", ratePlans: [] });
    RoomType.findOne.mockResolvedValue({ _id: "r1", basePrice: 3000 });
    DailyInventory.find.mockReturnValue({ lean: async () => [] });

    const req = {
      params: { id: "b1" },
      body: {},
      user: { hotelId: "h1", _id: "u1" },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    await modifyBooking(req, res, next);
    return { res, next };
  }

  it("lowers amountPaidOnline by exactly the refunded amount (DB and response)", async () => {
    // Previously modified online booking: Rs 7,000 recorded as paid.
    const booking = makeBooking({
      payment: {
        mode: "HOTEL_GATEWAY",
        razorpayPaymentId: "pay_1",
        amountPaidOnline: 7000,
        offlinePayments: [],
      },
    });
    newPricing(5000); // price drop of Rs 2,000

    const { res, next } = await run(booking);

    expect(next).not.toHaveBeenCalled();
    expect(refundPaymentIdempotent).toHaveBeenCalledTimes(1);
    expect(refundPaymentIdempotent.mock.calls[0][1]).toBe("pay_1");
    expect(refundPaymentIdempotent.mock.calls[0][2]).toBe(200000); // paise

    const sync = updateSetting("payment.amountPaidOnline");
    expect(sync).toBeDefined();
    expect(sync[1].$set["payment.amountPaidOnline"]).toBe(5000);
    // the object returned in the API response matches the DB
    expect(booking.payment.amountPaidOnline).toBe(5000);
    expect(sendSystemAlert).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("leaves amountPaidOnline alone when it was never set (fallback is already right)", async () => {
    const booking = makeBooking({
      payment: {
        mode: "HOTEL_GATEWAY",
        razorpayPaymentId: "pay_1",
        amountPaidOnline: 0,
        offlinePayments: [],
      },
    });
    newPricing(5000);

    await run(booking);

    expect(refundPaymentIdempotent).toHaveBeenCalledTimes(1);
    expect(updateSetting("payment.amountPaidOnline")).toBeUndefined();
  });

  it("does not touch amountPaidOnline and flags review when the gateway refund fails", async () => {
    const booking = makeBooking({
      payment: {
        mode: "HOTEL_GATEWAY",
        razorpayPaymentId: "pay_1",
        amountPaidOnline: 7000,
        offlinePayments: [],
      },
    });
    newPricing(5000);
    refundPaymentIdempotent.mockRejectedValueOnce(new Error("gateway down"));

    const { res } = await run(booking);

    expect(updateSetting("payment.amountPaidOnline")).toBeUndefined();
    expect(updateSetting("reconciliation.needsManualReview")).toBeDefined();
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(booking.payment.amountPaidOnline).toBe(7000);
    const body = res.json.mock.calls[0][0];
    expect(body.data.refundIssued).toBe(false);
  });

  it("does not raise a false 'refund failed' alert when only the amountPaidOnline DB sync fails", async () => {
    const booking = makeBooking({
      payment: {
        mode: "HOTEL_GATEWAY",
        razorpayPaymentId: "pay_1",
        amountPaidOnline: 7000,
        offlinePayments: [],
      },
    });
    newPricing(5000);
    Booking.updateOne.mockRejectedValueOnce(new Error("db blip"));

    const { res, next } = await run(booking);

    expect(next).not.toHaveBeenCalled();
    expect(sendSystemAlert).not.toHaveBeenCalled();
    expect(updateSetting("reconciliation.needsManualReview")).toBeUndefined();
    const body = res.json.mock.calls[0][0];
    expect(body.data.refundIssued).toBe(true);
    expect(body.data.refundError).toBeNull();
  });

  it("rejects a price increase on an online booking and saves nothing", async () => {
    const booking = makeBooking({
      payment: {
        mode: "HOTEL_GATEWAY",
        razorpayPaymentId: "pay_1",
        amountPaidOnline: 7000,
        offlinePayments: [],
      },
    });
    newPricing(9000);

    const { res } = await run(booking);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe("BALANCE_DUE");
    expect(booking.save).not.toHaveBeenCalled();
    expect(refundPaymentIdempotent).not.toHaveBeenCalled();
  });

  it("never refunds online for a pay-at-hotel price drop; only the balance at the hotel changes", async () => {
    const booking = makeBooking({
      grandTotal: 6720,
      payment: {
        mode: "PAY_AT_HOTEL",
        razorpayPaymentId: "pay_fee",
        amountPayableNow: 480,
        amountDueAtHotel: 6240,
        offlinePayments: [],
      },
    });
    newPricing(5000);

    const { res } = await run(booking);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(refundPaymentIdempotent).not.toHaveBeenCalled();
    expect(updateSetting("payment.amountPaidOnline")).toBeUndefined();
    expect(booking.payment.amountPayableNow).toBe(480); // fee untouched
    expect(booking.payment.amountDueAtHotel).toBe(4520); // 5000 - 480
  });
});

// ===========================================================================
// 3. Guest cancels a pay-at-hotel booking
//    (these figures drive the wording on the manage-booking page)
// ===========================================================================
describe("guest cancellation of a pay-at-hotel booking", () => {
  const booking = {
    billing: { grandTotal: 5152 },
    payment: {
      mode: "PAY_AT_HOTEL",
      amountPayableNow: 368,
      amountDueAtHotel: 4784,
    },
  };

  it("refunds nothing and retains the fee, so the page shows the 'non-refundable fee' message", () => {
    const e = evaluatePayAtHotelCancellation(booking, {
      cancelledBy: "GUEST_SELF_SERVICE",
    });
    expect(e.refundAmount).toBe(0);
    expect(e.refundPercent).toBe(0);
    expect(e.retainedAmount).toBe(368);
  });

  it("refunds the whole fee when the hotel cancels instead", () => {
    const e = evaluatePayAtHotelCancellation(booking, {
      cancelledBy: "HOTELIER",
    });
    expect(e.refundAmount).toBe(368);
    expect(e.retainedAmount).toBe(0);
  });
});
