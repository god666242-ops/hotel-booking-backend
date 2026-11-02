import { describe, it, expect } from "@jest/globals";
import { calculatePricingBreakdown } from "../../src/services/pricing.service.js";

describe("Pricing Service - Bill Breakdown & Surcharge Rules", () => {
  const mockHotel = {
    taxConfig: {
      gstEnabled: true,
      useSlab: true, // the tiered 12%/18% rule only applies when slab mode is on
      tierThreshold: 7500, // ₹7,500/night threshold
      rateBelowThreshold: 12, // 12%
      rateAboveThreshold: 18, // 18%
    },
    paymentConfig: {
      platformFeeFlat: 150, // Non-refundable platform fee
    },
  };

  it("should correctly apply 12% GST when avg room night tariff is below ₹7,500", () => {
    const dailyInventories = [
      { date: new Date("2026-11-01"), price: 3000 },
      { date: new Date("2026-11-02"), price: 3000 },
    ];
    const roomCount = 1;

    const breakdown = calculatePricingBreakdown({
      dailyInventories,
      roomCount,
      addOns: [],
      hotel: mockHotel,
    });

    // Room tariff: 3000 * 2 = 6000
    // GST (12% of 6000): 720
    // Platform fee: 150
    // Grand Total: 6000 + 720 + 150 = 6870
    expect(breakdown.roomBaseTariff).toBe(6000);
    expect(breakdown.hotelGst).toBe(720);
    expect(breakdown.platformConvenienceFee).toBe(150);
    expect(breakdown.grandTotal).toBe(6870);
  });

  it("should switch to 18% GST when avg room tariff meets or exceeds ₹7,500", () => {
    const dailyInventories = [
      { date: new Date("2026-11-01"), price: 8000 },
      { date: new Date("2026-11-02"), price: 8000 },
    ];

    const breakdown = calculatePricingBreakdown({
      dailyInventories,
      roomCount: 1,
      addOns: [],
      hotel: mockHotel,
    });

    // Room tariff: 16000
    // GST (18% of 16000): 2880
    // Platform fee: 150
    // Grand Total: 16000 + 2880 + 150 = 19030
    expect(breakdown.roomBaseTariff).toBe(16000);
    expect(breakdown.hotelGst).toBe(2880);
    expect(breakdown.grandTotal).toBe(19030);
  });

  it("should accurately compute PER_NIGHT add-ons across multiple dates", () => {
    const dailyInventories = [
      { date: new Date("2026-11-01"), price: 4000 },
      { date: new Date("2026-11-02"), price: 4000 },
    ];

    const addOns = [
      { name: "Extra Bed", price: 500, chargeType: "PER_NIGHT", quantity: 1 },
      {
        name: "Airport Shuttle",
        price: 1200,
        chargeType: "PER_STAY",
        quantity: 1,
      },
    ];

    const breakdown = calculatePricingBreakdown({
      dailyInventories,
      roomCount: 1,
      addOns,
      hotel: mockHotel,
    });

    // Room tariff: 8000
    // Add-ons: (500 * 2 nights) + (1200 * 1 stay) = 2200
    // Taxable: 8000 + 2200 = 10200
    // Avg room night is 8000/2 = 4000 (< 7500 => 12%)
    // GST (12% of 10200): 1224
    // Platform fee: 150
    // Grand total: 8000 + 2200 + 1224 + 150 = 11574
    expect(breakdown.addOnsTotal).toBe(2200);
    expect(breakdown.hotelGst).toBe(1224);
    expect(breakdown.grandTotal).toBe(11574);
  });

  it("charges per-guest add-ons by the verified guest count and ignores client quantity", () => {
    const dailyInventories = [
      { date: new Date("2026-11-01"), price: 4000 },
      { date: new Date("2026-11-02"), price: 4000 },
    ];

    const breakdown = calculatePricingBreakdown({
      dailyInventories,
      roomCount: 1,
      totalGuests: 3,
      addOns: [
        // A tampered client tries to pay for 1 head (and another tries to inflate it)
        { name: "Breakfast", price: 300, chargeType: "PER_GUEST", quantity: 1 },
        {
          name: "Spa",
          price: 100,
          chargeType: "PER_GUEST_PER_NIGHT",
          quantity: 9,
        },
      ],
      hotel: mockHotel,
    });

    // 300 * 3 guests = 900 ; 100 * 3 guests * 2 nights = 600
    expect(breakdown.addOnsTotal).toBe(1500);
    expect(breakdown.calculatedAddOns.every((a) => a.quantity === 1)).toBe(
      true,
    );
  });
});