const PER_GUEST_CHARGE_TYPES = [
  "PER_GUEST",
  "PER_PERSON",
  "PER_GUEST_PER_NIGHT",
];

/**
 * Validates and calculates discount for an applied promo code.
 * Strictly verifies date bounds, minimum nights, order threshold, room type, and usageLimit.
 */
export function evaluatePromoDiscount({
  promoCode,
  hotel,
  roomTypeId,
  subtotal,
  nights,
  now = new Date(),
}) {
  if (!promoCode || !hotel?.promoCodes?.length) {
    return { valid: false, discount: 0, reason: "No promo code provided." };
  }

  const codeMatch = String(promoCode).trim().toUpperCase();
  const rule = hotel.promoCodes.find(
    (p) => String(p.code).trim().toUpperCase() === codeMatch,
  );

  if (!rule || rule.isActive === false) {
    return {
      valid: false,
      discount: 0,
      reason: "Invalid or inactive coupon code.",
    };
  }

  // Date validity check
  if (rule.validFrom && new Date(rule.validFrom) > now) {
    return {
      valid: false,
      discount: 0,
      reason: "This promotion has not started yet.",
    };
  }
  if (rule.validTill && new Date(rule.validTill) < now) {
    return { valid: false, discount: 0, reason: "This promotion has expired." };
  }

  // Usage limit check
  if (rule.usageLimit != null && (rule.usedCount || 0) >= rule.usageLimit) {
    return {
      valid: false,
      discount: 0,
      reason: "This promo code has reached its maximum usage limit.",
    };
  }

  // Minimum stay requirement
  if (rule.minNights && nights < rule.minNights) {
    return {
      valid: false,
      discount: 0,
      reason: `Requires a minimum stay of ${rule.minNights} nights.`,
    };
  }

  // Minimum subtotal threshold
  if (rule.minOrderAmount && subtotal < rule.minOrderAmount) {
    return {
      valid: false,
      discount: 0,
      reason: `Requires a minimum order value of ₹${rule.minOrderAmount}.`,
    };
  }

  // Room type applicability check
  if (
    Array.isArray(rule.applicableRoomTypeIds) &&
    rule.applicableRoomTypeIds.length > 0 &&
    roomTypeId
  ) {
    const isApplicable = rule.applicableRoomTypeIds.some(
      (id) => String(id) === String(roomTypeId),
    );
    if (!isApplicable) {
      return {
        valid: false,
        discount: 0,
        reason: "Coupon not applicable to the selected room type.",
      };
    }
  }

  // Compute discount amount
  let discountAmount = 0;
  if (rule.discountType === "PERCENT") {
    discountAmount = (subtotal * Number(rule.discountValue || 0)) / 100;
    if (rule.maxDiscountAmount && discountAmount > rule.maxDiscountAmount) {
      discountAmount = Number(rule.maxDiscountAmount);
    }
  } else if (rule.discountType === "FLAT") {
    discountAmount = Number(rule.discountValue || 0);
  }

  discountAmount = Math.min(
    subtotal,
    Math.max(0, Number(discountAmount.toFixed(2))),
  );

  return {
    valid: true,
    code: rule.code,
    discountType: rule.discountType,
    discountValue: rule.discountValue,
    discountAmount,
    promoId: rule._id,
  };
}

/**
 * Calculate stay financial breakdown with dynamic tax, rate plans, and promo discounts
 */
export function calculatePricingBreakdown({
  dailyInventories,
  roomCount = 1,
  totalGuests = 2,
  addOns = [],
  hotel,
  roomType = null,
  isCombo = false,
  comboDetails = null,
  promoCode = null,
  ratePlan = null,
}) {
  const safeRoomCount = Math.max(1, parseInt(roomCount, 10) || 1);
  const safeGuests = Math.max(1, parseInt(totalGuests, 10) || 1);
  const nights = Math.max(1, dailyInventories?.length || 1);

  // 1. Calculate base room tariff across all nights
  let roomBaseTariff = (dailyInventories || []).reduce((acc, day) => {
    const dailyPrice = Number(day.price) || 0;
    return acc + dailyPrice * safeRoomCount;
  }, 0);

  // Combo package adjustment
  if (isCombo && comboDetails) {
    if (
      typeof comboDetails.packagePrice === "number" &&
      comboDetails.packagePrice > 0
    ) {
      roomBaseTariff = comboDetails.packagePrice * safeRoomCount;
    } else if (
      typeof comboDetails.discountPercent === "number" &&
      comboDetails.discountPercent > 0
    ) {
      const discount = (roomBaseTariff * comboDetails.discountPercent) / 100;
      roomBaseTariff = Math.max(0, roomBaseTariff - discount);
    }
  }

  // Rate Plan adjustment (Supports discountType: PERCENT/FLAT & legacy discountPercent/discountAmount)
  let ratePlanDiscount = 0;
  let appliedRatePlan = null;
  if (ratePlan && typeof ratePlan === "object") {
    const dType =
      ratePlan.discountType || (ratePlan.discountPercent ? "PERCENT" : "FLAT");
    const dVal =
      ratePlan.discountValue !== undefined
        ? Number(ratePlan.discountValue)
        : Number(ratePlan.discountPercent || ratePlan.discountAmount || 0);

    if (dType === "PERCENT" && dVal > 0) {
      ratePlanDiscount = Number(((roomBaseTariff * dVal) / 100).toFixed(2));
    } else if (dType === "FLAT" && dVal > 0) {
      ratePlanDiscount = Number(dVal);
    }

    ratePlanDiscount = Math.min(roomBaseTariff, ratePlanDiscount);
    roomBaseTariff = Math.max(0, roomBaseTariff - ratePlanDiscount);

    appliedRatePlan = {
      id: ratePlan.id || ratePlan._id,
      name: ratePlan.name,
      code: ratePlan.code,
      isNonRefundable: Boolean(ratePlan.isNonRefundable),
      mealsIncluded: Boolean(ratePlan.mealsIncluded),
      discountAmount: ratePlanDiscount,
    };
  }

  roomBaseTariff = Number(roomBaseTariff.toFixed(2));

  // 2. Promo Code discount evaluation (applied on room tariff)
  let promoDiscount = 0;
  let appliedPromo = null;

  if (promoCode) {
    const targetRoomId = roomType?._id || roomType?.roomTypeId;
    const promoResult = evaluatePromoDiscount({
      promoCode,
      hotel,
      roomTypeId: targetRoomId,
      subtotal: roomBaseTariff,
      nights,
    });

    if (promoResult.valid) {
      promoDiscount = promoResult.discountAmount;
      appliedPromo = {
        code: promoResult.code,
        discountType: promoResult.discountType,
        discountValue: promoResult.discountValue,
        discountAmount: promoDiscount,
        promoId: promoResult.promoId,
      };
      roomBaseTariff = Math.max(
        0,
        Number((roomBaseTariff - promoDiscount).toFixed(2)),
      );
    }
  }

  // 3. Calculate add-ons total
  let addOnsTotal = 0;
  const calculatedAddOns = [];

  for (const item of addOns || []) {
    const itemPrice = Math.max(0, Number(item.price) || 0);
    const quantity = PER_GUEST_CHARGE_TYPES.includes(item.chargeType)
      ? 1
      : Math.max(1, parseInt(item.quantity, 10) || 1);
    let subtotal = 0;

    switch (item.chargeType) {
      case "PER_NIGHT":
        subtotal = itemPrice * quantity * nights;
        break;
      case "PER_GUEST":
      case "PER_PERSON":
        subtotal = itemPrice * quantity * safeGuests;
        break;
      case "PER_GUEST_PER_NIGHT":
        subtotal = itemPrice * quantity * safeGuests * nights;
        break;
      case "PER_STAY":
      default:
        subtotal = itemPrice * quantity;
        break;
    }

    subtotal = Number(subtotal.toFixed(2));
    addOnsTotal += subtotal;

    calculatedAddOns.push({
      addOnId: item.addOnId || item._id,
      name: item.name,
      price: itemPrice,
      quantity,
      chargeType: item.chargeType || "PER_STAY",
      subtotal,
    });
  }

  addOnsTotal = Number(addOnsTotal.toFixed(2));

  // 4. Dynamic Tax / GST Calculation on net discounted subtotal
  let hotelGst = 0;
  let effectiveTaxPercent = 0;
  const taxableRoomTariff = roomBaseTariff + addOnsTotal;

  if (hotel?.taxConfig && hotel.taxConfig.gstEnabled) {
    if (
      roomType?.taxPercent !== null &&
      roomType?.taxPercent !== undefined &&
      !isNaN(Number(roomType.taxPercent))
    ) {
      effectiveTaxPercent = Number(roomType.taxPercent);
    } else if (hotel.taxConfig.useSlab) {
      const avgPerRoomNight = roomBaseTariff / (safeRoomCount * nights);
      const slabThreshold = Number(hotel.taxConfig.tierThreshold ?? 7500);

      effectiveTaxPercent =
        avgPerRoomNight >= slabThreshold
          ? Number(hotel.taxConfig.rateAboveThreshold ?? 18)
          : Number(hotel.taxConfig.rateBelowThreshold ?? 12);
    } else {
      effectiveTaxPercent = Number(hotel.taxConfig.taxPercent ?? 12);
    }

    hotelGst = Number(
      ((taxableRoomTariff * effectiveTaxPercent) / 100).toFixed(2),
    );
  }

  // 5. Platform fee configuration
  const platformConvenienceFee = Number(
    hotel?.paymentConfig?.platformFeeFlat || 0,
  );

  // 6. Grand Total charged to guest
  const grandTotal = Number(
    (roomBaseTariff + addOnsTotal + hotelGst + platformConvenienceFee).toFixed(
      2,
    ),
  );

  const discountTotal = Number((ratePlanDiscount + promoDiscount).toFixed(2));

  return {
    roomBaseTariff,
    addOnsTotal,
    hotelGst,
    effectiveTaxPercent,
    platformConvenienceFee,
    discountTotal,
    appliedPromo,
    appliedRatePlan,
    grandTotal,
    calculatedAddOns,
    nights,
  };
}