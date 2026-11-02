import DailyInventory from "../../models/DailyInventory.js";
import RoomType from "../../models/RoomType.js";
import InventoryLog from "../../models/InventoryLog.js";

/**
 * GET /api/v1/admin/inventory?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function getInventoryRange(req, res, next) {
  try {
    const { from, to, roomTypeId } = req.query;
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "from and to query parameters are required.",
      });
    }

    const query = {
      hotelId: req.user.hotelId,
      date: { $gte: new Date(from), $lte: new Date(to) },
    };
    if (roomTypeId) query.roomTypeId = roomTypeId;

    const inventories = await DailyInventory.find(query)
      .sort({ date: 1 })
      .lean();
    return res.status(200).json({ success: true, data: inventories });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/admin/inventory/history
 */
export async function getInventoryHistory(req, res, next) {
  try {
    const { roomTypeId, limit = 30, page = 1 } = req.query;
    const now = new Date();

    // Proactively clean up any history items whose 7-day retention period has passed
    await InventoryLog.deleteMany({
      hotelId: req.user.hotelId,
      expiresAt: { $lte: now },
    });

    const query = {
      hotelId: req.user.hotelId,
      expiresAt: { $gt: now }, // Only return non-expired history
    };

    if (roomTypeId) {
      query.roomTypeId = roomTypeId;
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const [logs, total] = await Promise.all([
      InventoryLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .lean(),
      InventoryLog.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        logs,
        total,
        page: parseInt(page, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
        retentionPolicyDays: 7,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/admin/inventory/bulk-update
 */
export async function bulkUpdateInventory(req, res, next) {
  try {
    const {
      roomTypeId,
      startDate,
      endDate,
      price,
      availableRooms,
      isBlocked,
      closedToArrival,
      minStay,
    } = req.body;

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Both startDate and endDate are required.",
        });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (start > end) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date range: "From Date" cannot be after "To Date".',
      });
    }

    const room = await RoomType.findOne({
      _id: roomTypeId,
      hotelId: req.user.hotelId,
    });
    if (!room)
      return res
        .status(404)
        .json({ success: false, message: "Room type not found." });

    if (
      availableRooms !== undefined &&
      availableRooms !== null &&
      availableRooms !== ""
    ) {
      const units = Number(availableRooms);
      if (units < 0) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Available units cannot be negative.",
          });
      }
      if (units > room.totalUnits) {
        return res.status(400).json({
          success: false,
          message: `Available units (${units}) cannot exceed physical capacity (${room.totalUnits}).`,
        });
      }
    }

    const bulkOps = [];
    let daysCount = 0;

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      daysCount++;
      const normalizedDate = new Date(d);
      normalizedDate.setUTCHours(0, 0, 0, 0);

      const updateSet = { totalRooms: room.totalUnits };
      const setOnInsert = {};

      if (price !== undefined) {
        updateSet.price =
          price === null || price === "" ? room.basePrice : Number(price);
      } else {
        setOnInsert.price = room.basePrice;
      }

      if (availableRooms !== undefined) {
        updateSet.availableRooms =
          availableRooms === null || availableRooms === ""
            ? room.totalUnits
            : Number(availableRooms);
      } else {
        setOnInsert.availableRooms = room.totalUnits;
      }

      if (isBlocked !== undefined) {
        updateSet.isBlocked = Boolean(isBlocked);
      } else {
        setOnInsert.isBlocked = false;
      }

      if (closedToArrival !== undefined) {
        updateSet.closedToArrival = Boolean(closedToArrival);
      } else {
        setOnInsert.closedToArrival = false;
      }

      if (minStay !== undefined) {
        updateSet.minStay =
          minStay === null || minStay === "" ? 1 : Number(minStay);
      } else {
        setOnInsert.minStay = 1;
      }

      bulkOps.push({
        updateOne: {
          filter: {
            hotelId: req.user.hotelId,
            roomTypeId: room._id,
            date: normalizedDate,
          },
          update: { $set: updateSet, $setOnInsert: setOnInsert },
          upsert: true,
        },
      });
    }

    if (bulkOps.length > 0) {
      await DailyInventory.bulkWrite(bulkOps);
    }

    let actionType = "MIXED";
    const isPriceReset = price === null || price === "";
    const isUnitsReset = availableRooms === null || availableRooms === "";

    if (isBlocked) {
      actionType = "BLACKOUT";
    } else if (isPriceReset && isUnitsReset) {
      actionType = "RESET";
    } else if (!isPriceReset && isUnitsReset) {
      actionType = "RATE_OVERRIDE";
    } else if (isPriceReset && !isUnitsReset) {
      actionType = "STOCK_OVERRIDE";
    }

    const expiresAt = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000);
    expiresAt.setUTCHours(23, 59, 59, 999);

    await InventoryLog.create({
      hotelId: req.user.hotelId,
      roomTypeId: room._id,
      roomName: room.name,
      startDate: start,
      endDate: end,
      daysCount,
      actionType,
      changes: {
        price:
          price !== undefined
            ? isPriceReset
              ? `Default (₹${room.basePrice})`
              : `₹${price}`
            : "Unchanged",
        availableRooms:
          availableRooms !== undefined
            ? isUnitsReset
              ? `Default (${room.totalUnits} units)`
              : `${availableRooms} units`
            : "Unchanged",
        isBlocked: isBlocked !== undefined ? Boolean(isBlocked) : undefined,
        closedToArrival:
          closedToArrival !== undefined ? Boolean(closedToArrival) : undefined,
        minStay:
          minStay !== undefined
            ? minStay === null || minStay === ""
              ? 1
              : Number(minStay)
            : undefined,
      },
      updatedBy: {
        userId: req.user._id,
        email: req.user.email || "Admin",
      },
      expiresAt,
    });

    return res.status(200).json({
      success: true,
      message: `Updated inventory for ${bulkOps.length} date(s).`,
    });
  } catch (error) {
    next(error);
  }
}
