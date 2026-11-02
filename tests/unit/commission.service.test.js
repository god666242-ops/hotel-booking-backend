// backend/tests/unit/commission.service.test.js
import {
  getCommissionPercent,
  getCommissionBase,
  calculatePayAtHotelSplit,
  calculateBookingCommission,
} from "../../src/services/commission.service.js";

const billing = {
  roomBaseTariff: 5000,
  addOnsTotal: 1000,
  hotelGst: 720, // 12% of 6000
  platformConvenienceFee: 0,
  grandTotal: 6720,
};

describe("commission.service", () => {
  it("uses the defaults when the hotel has no settings", () => {
    expect(getCommissionPercent({}, "HOTEL_GATEWAY")).toBe(5);
    expect(getCommissionPercent({}, "PAY_AT_HOTEL")).toBe(8);
  });

  it("uses the hotel's own percentages when set", () => {
    const hotel = {
      paymentConfig: { gatewayCommissionPercent: 4, payAtHotelCommissionPercent: 10 },
    };
    expect(getCommissionPercent(hotel, "HOTEL_GATEWAY")).toBe(4);
    expect(getCommissionPercent(hotel, "PAY_AT_HOTEL")).toBe(10);
  });

  it("excludes the hotel GST from the commission base", () => {
    expect(getCommissionBase(billing)).toBe(6000);
  });

  it("splits a pay-at-hotel booking so that the parts add up to the total", () => {
    const s = calculatePayAtHotelSplit({ billing, percent: 8 });
    expect(s.amountPayableNow).toBe(480);
    expect(s.amountDueAtHotel).toBe(6240);
    expect(s.amountPayableNow + s.amountDueAtHotel).toBe(6720);
  });

  it("charges full commission on an un-refunded booking", () => {
    const c = calculateBookingCommission({ billing }, 5);
    expect(c.base).toBe(6000);
    expect(c.commission).toBe(300);
  });

  it("charges nothing when the booking was fully refunded", () => {
    const c = calculateBookingCommission(
      { billing, cancellation: { amountRefunded: 6720 } },
      5,
    );
    expect(c.commission).toBe(0);
  });

  it("charges commission only on the retained part after a 50% refund", () => {
    const c = calculateBookingCommission(
      { billing, cancellation: { amountRefunded: 3360 } },
      5,
    );
    expect(c.base).toBe(3000);
    expect(c.commission).toBe(150);
  });
});