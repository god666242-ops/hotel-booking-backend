import Hotel from '../../models/Hotel.js';
import RoomType from '../../models/RoomType.js';
import DailyInventory from '../../models/DailyInventory.js';
import { evaluatePromoDiscount } from '../../services/pricing.service.js';

/**
 * GET /api/v1/public/:hotelSlug/rates?from=YYYY-MM-DD&to=YYYY-MM-DD&roomTypeId=...
 * Returns the lowest starting rate per day for the calendar badges
 */
export async function getCalendarRates(req, res, next) {
  try {
    const { hotelSlug } = req.params;
    const { from, to, roomTypeId } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: 'from and to query parameters (YYYY-MM-DD) are required.',
      });
    }

    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    const hotel = await Hotel.findOne({ slug: hotelSlug, isActive: true }).lean();
    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }

    // Filter room categories
    const roomQuery = { hotelId: hotel._id, isActive: true };
    if (roomTypeId) {
      roomQuery._id = roomTypeId;
    }
    const rooms = await RoomType.find(roomQuery).lean();

    if (!rooms.length) {
      return res.status(200).json({ success: true, data: { rates: {} } });
    }

    const roomIds = rooms.map((r) => r._id);

    // Fetch daily overrides for all rooms in date range
    const dailyOverrides = await DailyInventory.find({
      hotelId: hotel._id,
      roomTypeId: { $in: roomIds },
      date: { $gte: fromDate, $lte: toDate },
    }).lean();

    // Map overrides: key = `${roomTypeId}_${YYYY-MM-DD}`
    const overrideMap = new Map();
    dailyOverrides.forEach((rec) => {
      const dateStr = new Date(rec.date).toISOString().split('T')[0];
      overrideMap.set(`${rec.roomTypeId.toString()}_${dateStr}`, rec);
    });

    const rates = {};
    const defaultCatalogMinPrice = Math.min(...rooms.map((r) => r.basePrice || Infinity));

    // Loop through each calendar date from `from` to `to`
    for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];

      let lowestDayRate = Infinity;
      let anyRoomAvailable = false;

      for (const room of rooms) {
        const key = `${room._id.toString()}_${dateStr}`;
        const override = overrideMap.get(key);

        const price = override?.price != null ? override.price : room.basePrice;
        const availableUnits = override?.availableRooms != null ? override.availableRooms : room.totalUnits;
        const isBlocked = override?.isBlocked != null ? override.isBlocked : false;

        if (!isBlocked && availableUnits > 0) {
          anyRoomAvailable = true;
          if (price < lowestDayRate) {
            lowestDayRate = price;
          }
        }
      }

      rates[dateStr] = {
        price: lowestDayRate === Infinity ? defaultCatalogMinPrice : lowestDayRate,
        isSoldOut: !anyRoomAvailable,
      };
    }

    return res.status(200).json({
      success: true,
      data: {
        rates,
        defaultNightlyRate: defaultCatalogMinPrice,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/public/:hotelSlug/validate-promo
 * Body: { promoCode, roomTypeId, subtotal, nights }
 */
export async function validatePromoCode(req, res, next) {
  try {
    const { hotelSlug } = req.params;
    const { promoCode, roomTypeId, subtotal, nights } = req.body;

    if (!promoCode) {
      return res.status(400).json({
        success: false,
        message: 'Promo code is required.',
      });
    }

    const hotel = await Hotel.findOne({ slug: hotelSlug, isActive: true });
    if (!hotel) {
      return res.status(404).json({ success: false, message: 'Hotel not found.' });
    }

    const result = evaluatePromoDiscount({
      promoCode,
      hotel,
      roomTypeId,
      subtotal: Number(subtotal) || 0,
      nights: Number(nights) || 1,
    });

    if (!result.valid) {
      return res.status(400).json({
        success: false,
        message: result.reason || 'Invalid promo code.',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        code: result.code,
        discountType: result.discountType,
        discountValue: result.discountValue,
        discountAmount: result.discountAmount,
      },
    });
  } catch (error) {
    next(error);
  }
}