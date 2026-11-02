import Hotel from "../../models/Hotel.js";
import RoomType from "../../models/RoomType.js";
import DailyInventory from "../../models/DailyInventory.js";

export async function getHotelMetadata(req, res, next) {
  try {
    const { hotelSlug } = req.params;

    const hotel = await Hotel.findOne({ slug: hotelSlug, isActive: true })
      .select(
        "name slug contact address photos propertyPhotos checkInTime checkOutTime announcement topReasonsToBook topAmenities helpfulFacts languagesSpoken propertyPolicies faqs cancellationPolicy taxConfig addOns combos paymentConfig.platformFeeFlat paymentConfig.mode paymentConfig.payAtHotelCommissionPercent legal.termsUrl legal.privacyUrl legal.termsVersion legal.privacyVersion integrations ratePlans promoCodes",
      )
      .lean();

    if (!hotel) {
      return res
        .status(404)
        .json({ success: false, message: "Hotel not found or inactive." });
    }

    // Terms / privacy links for the checkout consent box (hotel's own, else the platform's)
    hotel.legal = {
      termsUrl: hotel.legal?.termsUrl || process.env.PLATFORM_TERMS_URL || "",
      privacyUrl:
        hotel.legal?.privacyUrl || process.env.PLATFORM_PRIVACY_URL || "",
      termsVersion: hotel.legal?.termsVersion || "1",
      privacyVersion: hotel.legal?.privacyVersion || "1",
    };

    // Filter out disabled add-ons, combos, and rate plans
    if (Array.isArray(hotel.addOns)) {
      hotel.addOns = hotel.addOns.filter((a) => a.isActive !== false);
    }
    if (Array.isArray(hotel.combos)) {
      hotel.combos = hotel.combos.filter((c) => c.isActive !== false);
    }
    if (Array.isArray(hotel.ratePlans)) {
      hotel.ratePlans = hotel.ratePlans.filter((rp) => rp.isActive !== false);
    }

    // Expose active public promo codes with sanitized metadata (hide internal counters)
    const now = new Date();
    hotel.publicPromos = Array.isArray(hotel.promoCodes)
      ? hotel.promoCodes
          .filter(
            (p) =>
              p.isActive !== false &&
              (!p.validFrom || new Date(p.validFrom) <= now) &&
              (!p.validTill || new Date(p.validTill) >= now) &&
              (p.usageLimit === null || (p.usedCount || 0) < p.usageLimit),
          )
          .map((p) => ({
            code: p.code,
            description: p.description,
            discountType: p.discountType,
            discountValue: p.discountValue,
            minNights: p.minNights || 1,
            minOrderAmount: p.minOrderAmount || 0,
          }))
      : [];

    delete hotel.promoCodes;

    // Marketing & Tracking Pixels
    hotel.integrations = {
      metaPixelId: hotel.integrations?.metaPixelId || "",
      ga4MeasurementId: hotel.integrations?.ga4MeasurementId || "",
      googleTagManagerId: hotel.integrations?.googleTagManagerId || "",
    };

    // Bot protection public site key
    hotel.turnstileSiteKey = process.env.CLOUDFLARE_TURNSTILE_SITE_KEY || "";

    return res.status(200).json({ success: true, data: hotel });
  } catch (error) {
    next(error);
  }
}

function findRoomCombinations(
  availableRooms,
  totalGuests,
  maxRoomsToConsider = 4,
) {
  const combinations = [];

  for (const room of availableRooms) {
    const needed = Math.ceil(totalGuests / room.maxOccupancy);
    if (
      needed > 1 &&
      needed <= room.remainingUnits &&
      needed <= maxRoomsToConsider
    ) {
      const roomBasePerUnit =
        room.pricing.unitPrice || room.pricing.totalBaseTariff;
      combinations.push({
        id: `uniform_${room.roomTypeId}_${needed}`,
        type: "UNIFORM",
        title: `${needed} × ${room.name}`,
        totalRooms: needed,
        totalCapacity: needed * room.maxOccupancy,
        totalPrice: roomBasePerUnit * needed,
        avgPerNight: Math.round(
          (roomBasePerUnit * needed) / room.pricing.nights,
        ),
        breakdown: [
          {
            roomTypeId: room.roomTypeId,
            name: room.name,
            quantity: needed,
            maxOccupancyEach: room.maxOccupancy,
            photos: room.photos || [],
            unitPrice: roomBasePerUnit,
            avgPerNight: room.pricing.avgPerNight,
          },
        ],
      });
    }
  }

  for (let i = 0; i < availableRooms.length; i++) {
    for (let j = i + 1; j < availableRooms.length; j++) {
      const roomA = availableRooms[i];
      const roomB = availableRooms[j];

      const priceA = roomA.pricing.unitPrice || roomA.pricing.totalBaseTariff;
      const priceB = roomB.pricing.unitPrice || roomB.pricing.totalBaseTariff;

      if (roomA.remainingUnits >= 1 && roomB.remainingUnits >= 1) {
        const combinedCapacity = roomA.maxOccupancy + roomB.maxOccupancy;
        if (combinedCapacity >= totalGuests) {
          const comboPrice = priceA + priceB;
          combinations.push({
            id: `mixed_${roomA.roomTypeId}_${roomB.roomTypeId}`,
            type: "MIXED",
            title: `1 × ${roomA.name} + 1 × ${roomB.name}`,
            totalRooms: 2,
            totalCapacity: combinedCapacity,
            totalPrice: comboPrice,
            avgPerNight: Math.round(comboPrice / roomA.pricing.nights),
            breakdown: [
              {
                roomTypeId: roomA.roomTypeId,
                name: roomA.name,
                quantity: 1,
                maxOccupancyEach: roomA.maxOccupancy,
                photos: roomA.photos || [],
                unitPrice: priceA,
                avgPerNight: roomA.pricing.avgPerNight,
              },
              {
                roomTypeId: roomB.roomTypeId,
                name: roomB.name,
                quantity: 1,
                maxOccupancyEach: roomB.maxOccupancy,
                photos: roomB.photos || [],
                unitPrice: priceB,
                avgPerNight: roomB.pricing.avgPerNight,
              },
            ],
          });
        }
      }
    }
  }

  return combinations
    .sort((a, b) => {
      if (a.totalRooms !== b.totalRooms) return a.totalRooms - b.totalRooms;
      return a.totalPrice - b.totalPrice;
    })
    .slice(0, 4);
}

export async function checkAvailability(req, res, next) {
  try {
    const { hotelSlug } = req.params;
    const { checkIn, checkOut, adults = 2, children = 0, rooms = 1 } = req.query;

    if (!checkIn || !checkOut) {
      return res.status(400).json({
        success: false,
        message: "checkIn and checkOut dates (YYYY-MM-DD) are required.",
      });
    }

    const checkInDate = new Date(`${checkIn}T00:00:00.000Z`);
    const checkOutDate = new Date(`${checkOut}T00:00:00.000Z`);

    if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date format." });
    }

    const requestedRoomCount = Math.max(1, parseInt(rooms, 10) || 1);
    const totalGuests = Math.max(1, (parseInt(adults, 10) || 1) + (parseInt(children, 10) || 0));
    const nights = Math.round((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
    if (nights <= 0) {
      return res.status(400).json({
        success: false,
        message: "checkOut date must be at least 1 day after checkIn date.",
      });
    }

    const hotel = await Hotel.findOne({ slug: hotelSlug, isActive: true }).lean();
    if (!hotel) {
      return res.status(404).json({ success: false, message: "Hotel not found." });
    }

    const allRoomTypes = await RoomType.find({ hotelId: hotel._id, isActive: true }).lean();
    if (!allRoomTypes.length) {
      return res.status(200).json({ success: true, data: { availableRooms: [], recommendedCombos: [], nights } });
    }

    const roomTypeIds = allRoomTypes.map((rt) => rt._id);
    const dailyInventories = await DailyInventory.find({
      hotelId: hotel._id,
      roomTypeId: { $in: roomTypeIds },
      date: { $gte: checkInDate, $lt: checkOutDate },
    }).lean();

    const stayNights = [];
    for (let i = 0; i < nights; i++) {
      const nightDate = new Date(checkInDate.getTime() + i * 24 * 60 * 60 * 1000);
      stayNights.push(nightDate.toISOString().split("T")[0]);
    }

    const physicallyAvailableRooms = [];

    for (const room of allRoomTypes) {
      const overrideMap = new Map();
      dailyInventories
        .filter((inv) => inv.roomTypeId.toString() === room._id.toString())
        .forEach((inv) => {
          const dateKey = new Date(inv.date).toISOString().split("T")[0];
          overrideMap.set(dateKey, inv);
        });

      let isAvailable = true;
      let totalTariffPerRoom = 0;

      const baselineUnits = Number(room.totalInventory ?? room.totalRooms ?? room.totalUnits ?? 1);
      const baselinePrice = Number(room.basePrice ?? 0);
      let minUnitsAcrossStay = baselineUnits;

      for (const dateKey of stayNights) {
        const override = overrideMap.get(dateKey);
        const nightPrice = override?.price != null ? Number(override.price) : baselinePrice;
        const availableUnits = override?.availableRooms != null ? Number(override.availableRooms) : baselineUnits;
        const isBlocked = Boolean(override?.isBlocked);

        if (isBlocked || availableUnits < 1) {
          isAvailable = false;
          break;
        }

        // Only enforce CTA and Daily Min Stay if it falls on the check-in day
        if (dateKey === stayNights[0]) {
          if (Boolean(override?.closedToArrival)) {
            isAvailable = false;
            break;
          }
          if (override?.minStay > 0 && nights < override.minStay) {
            isAvailable = false;
            break;
          }
        }

        totalTariffPerRoom += nightPrice;
        minUnitsAcrossStay = Math.min(minUnitsAcrossStay, availableUnits);
      }

      if (isAvailable && minUnitsAcrossStay > 0) {
        const roomAddOns = room.addOns && room.addOns.length > 0
            ? room.addOns.filter((a) => a.isActive !== false)
            : (hotel.addOns || []).filter((a) => a.isActive !== false);

        physicallyAvailableRooms.push({
          roomTypeId: room._id,
          name: room.name,
          description: room.description,
          photos: room.photos || room.images || [],
          amenities: room.amenities || [],
          baseOccupancy: room.baseOccupancy || 2,
          maxOccupancy: room.maxOccupancy || 2,
          taxPercent: room.taxPercent ?? null,
          remainingUnits: minUnitsAcrossStay,
          addOns: roomAddOns,
          pricing: {
            unitPrice: totalTariffPerRoom,
            totalBaseTariff: totalTariffPerRoom,
            avgPerNight: Math.round(totalTariffPerRoom / nights),
            nights,
            currency: "INR",
          },
        });
      }
    }

    const requiredCapPerRoom = Math.ceil(totalGuests / requestedRoomCount);
    const directAvailableRooms = physicallyAvailableRooms
      .filter((room) => room.maxOccupancy >= requiredCapPerRoom && room.remainingUnits >= requestedRoomCount)
      .map((room) => ({
        ...room,
        pricing: {
          ...room.pricing,
          totalBaseTariff: room.pricing.unitPrice * requestedRoomCount,
          avgPerNight: Math.round((room.pricing.unitPrice * requestedRoomCount) / nights),
        },
      }));

    let recommendedCombos = [];
    if (directAvailableRooms.length === 0 || totalGuests > 4) {
      recommendedCombos = findRoomCombinations(physicallyAvailableRooms, totalGuests);
    }

    return res.status(200).json({
      success: true,
      data: {
        nights,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        totalGuests,
        requestedRooms: requestedRoomCount,
        availableRooms: directAvailableRooms,
        recommendedCombos,
      },
    });
  } catch (error) {
    next(error);
  }
}