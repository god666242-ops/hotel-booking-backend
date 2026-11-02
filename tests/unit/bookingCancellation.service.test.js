import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// ---- Mocks (ESM) -----------------------------------------------------------
const calls = [];
const Booking = {
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  findOne: jest.fn(),
};

const markInvoiceCancelled = jest.fn(async () => {});
const offlinePaidTotal = jest.fn(() => 0);
const releaseRoomInventory = jest.fn(async () => calls.push("release"));
const removeRedisHoldLock = jest.fn(async () => {});
const refundPaymentIdempotent = jest.fn(async () => {
  calls.push("refund");
  return { refundId: "rfnd_1", alreadyRefunded: false, refundedPaise: 0 };
});

jest.unstable_mockModule("mongoose", () => ({
  default: {
    startSession: async () => ({
      withTransaction: async (cb) => cb(),
      endSession: async () => {},
    }),
  },
}));
jest.unstable_mockModule("../../src/models/Booking.js", () => ({
  default: Booking,
}));
jest.unstable_mockModule("../../src/models/Hotel.js", () => ({
  default: { findById: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/invoice.service.js", () => ({
  markInvoiceCancelled,
  offlinePaidTotal,
}));
jest.unstable_mockModule("../../src/services/inventory.service.js", () => ({
  releaseRoomInventory,
  removeRedisHoldLock,
}));
jest.unstable_mockModule("../../src/services/payment.service.js", () => ({
  getRazorpayClient: jest.fn(() => ({})),
  refundPaymentIdempotent,
}));

const { cancelConfirmedBooking } =
  await import("../../src/services/bookingCancellation.service.js");

// ---- Fixtures --------------------------------------------------------------
const hotel = {
  checkInTime: "12:00",
  paymentConfig: { mode: "HOTEL_GATEWAY" },
};

function makeBooking(overrides = {}) {
  return {
    _id: "b1",
    bookingCode: "BK-202611-ABC123",
    hotelId: "h1",
    roomTypeId: "r1",
    roomCount: 1,
    dates: {
      checkIn: new Date("2026-12-10T00:00:00.000Z"),
      checkOut: new Date("2026-12-12T00:00:00.000Z"),
    },
    billing: {
      roomBaseTariff: 10000,
      addOnsTotal: 1000,
      hotelGst: 1320,
      platformConvenienceFee: 150,
      grandTotal: 12470,
    },
    payment: { mode: "HOTEL_GATEWAY", razorpayPaymentId: "pay_1" },
    ...overrides,
  };
}

const NOW = new Date("2026-11-01T00:00:00.000Z"); // 39 days before check-in => 100% refund
const base = {
  filter: { _id: "b1" },
  hotel,
  reason: "test",
  cancelledBy: "TEST",
  now: NOW,
};

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  Booking.updateOne.mockResolvedValue({});
});

describe("cancelConfirmedBooking", () => {
  it("does not refund the online fee when a guest cancels a pay-at-hotel booking", async () => {
    const locked = makeBooking({
      payment: {
        mode: "PAY_AT_HOTEL",
        razorpayPaymentId: "pay_1",
        amountPayableNow: 480,
      },
    });
    Booking.findOneAndUpdate
      .mockResolvedValueOnce(locked)
      .mockResolvedValueOnce({ ...locked, status: "CANCELLED" });

    const result = await cancelConfirmedBooking({
      ...base,
      cancelledBy: "GUEST_SELF_SERVICE",
    });

    expect(result.ok).toBe(true);
    expect(refundPaymentIdempotent).not.toHaveBeenCalled();
    expect(result.evaluation.refundAmount).toBe(0);
    expect(calls).toEqual(["release"]);
  });

  it("refunds the full online fee when the hotel cancels a pay-at-hotel booking", async () => {
    const locked = makeBooking({
      payment: {
        mode: "PAY_AT_HOTEL",
        razorpayPaymentId: "pay_1",
        amountPayableNow: 480,
      },
    });
    Booking.findOneAndUpdate
      .mockResolvedValueOnce(locked)
      .mockResolvedValueOnce({ ...locked, status: "CANCELLED" });

    const result = await cancelConfirmedBooking({
      ...base,
      cancelledBy: "HOTELIER",
    });

    expect(result.ok).toBe(true);
    expect(refundPaymentIdempotent).toHaveBeenCalledWith(
      expect.anything(),
      "pay_1",
      48000, // 480 rupees in paise
      expect.any(Object),
    );
    expect(calls).toEqual(["refund", "release"]);
  });

  it("returns NOT_CANCELLABLE and touches nothing when the lock is not acquired", async () => {
    Booking.findOneAndUpdate.mockResolvedValueOnce(null);

    const result = await cancelConfirmedBooking(base);

    expect(result).toMatchObject({ ok: false, code: "NOT_CANCELLABLE" });
    expect(refundPaymentIdempotent).not.toHaveBeenCalled();
    expect(releaseRoomInventory).not.toHaveBeenCalled();
  });

  it("refunds BEFORE releasing inventory", async () => {
    const locked = makeBooking();
    Booking.findOneAndUpdate
      .mockResolvedValueOnce(locked) // lock
      .mockResolvedValueOnce({ ...locked, status: "CANCELLED" }); // finalize

    const result = await cancelConfirmedBooking(base);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["refund", "release"]);
    // Refund is 100% of (10000 + 1000 + 1320) = 12320 => 1232000 paise
    expect(refundPaymentIdempotent).toHaveBeenCalledWith(
      expect.anything(),
      "pay_1",
      1232000,
      expect.any(Object),
    );

    // The invoice is voided (credit note issued downstream) with the refunded amount
    expect(markInvoiceCancelled).toHaveBeenCalledWith("b1", {
      refundAmount: 12320,
    });
  });

  it("unlocks and does NOT release rooms when the refund fails", async () => {
    Booking.findOneAndUpdate.mockResolvedValueOnce(makeBooking());
    refundPaymentIdempotent.mockRejectedValueOnce(new Error("gateway down"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await cancelConfirmedBooking(base);

    expect(result).toMatchObject({
      ok: false,
      code: "REFUND_FAILED",
      status: 502,
    });
    expect(releaseRoomInventory).not.toHaveBeenCalled();
    expect(markInvoiceCancelled).not.toHaveBeenCalled();
    expect(Booking.updateOne).toHaveBeenCalledWith(
      { _id: "b1", status: "CANCELLATION_IN_PROGRESS" },
      { $set: { status: "CONFIRMED" } },
    );
  });

  it("enforces the check-in cutoff for guests and unlocks without refunding", async () => {
    Booking.findOneAndUpdate.mockResolvedValueOnce(makeBooking());

    const result = await cancelConfirmedBooking({
      ...base,
      enforceCutoff: true,
      now: new Date("2026-12-10T10:00:00.000Z"), // 15:30 IST, after 12:00 IST check-in
    });

    expect(result).toMatchObject({ ok: false, code: "WINDOW_CLOSED" });
    expect(refundPaymentIdempotent).not.toHaveBeenCalled();
    expect(Booking.updateOne).toHaveBeenCalled();
  });

  it("refuses to cancel when a refund is due but there is no payment reference", async () => {
    Booking.findOneAndUpdate.mockResolvedValueOnce(
      makeBooking({
        payment: { mode: "HOTEL_GATEWAY", razorpayPaymentId: null },
      }),
    );

    const result = await cancelConfirmedBooking(base);

    expect(result).toMatchObject({
      ok: false,
      code: "PAYMENT_REFERENCE_MISSING",
    });
    expect(releaseRoomInventory).not.toHaveBeenCalled();
  });

  it("keeps the booking locked (for the sweeper) if finalize throws after a refund", async () => {
    Booking.findOneAndUpdate
      .mockResolvedValueOnce(makeBooking())
      .mockRejectedValueOnce(new Error("db blip"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(cancelConfirmedBooking(base)).rejects.toThrow("db blip");

    // No revert to CONFIRMED: money already moved, the sweeper must finish the job
    expect(Booking.updateOne).not.toHaveBeenCalled();
  });

  it("reports ALREADY_FINALIZED when another actor completed it first", async () => {
    Booking.findOneAndUpdate
      .mockResolvedValueOnce(makeBooking())
      .mockResolvedValueOnce(null);

    const result = await cancelConfirmedBooking(base);

    expect(result).toMatchObject({ ok: false, code: "ALREADY_FINALIZED" });
    expect(releaseRoomInventory).not.toHaveBeenCalled();
  });
});
