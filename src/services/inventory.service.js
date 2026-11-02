import mongoose from "mongoose";
import DailyInventory from "../models/DailyInventory.js";
import RoomType from "../models/RoomType.js";
import { getRedisClient } from "../config/redis.js";

/**
 * Atomically checks availability and decrements available rooms for all nights.
 * Automatically initializes unconfigured dates from RoomType defaults.
 */
export async function holdRoomInventory({
  hotelId,
  roomTypeId,
  checkInDate,
  checkOutDate,
  roomCount,
  session,
}) {
  // 1. Explicitly cast IDs to MongoDB ObjectIds for bulkWrite compatibility
  const hId = new mongoose.Types.ObjectId(hotelId);
  const rId = new mongoose.Types.ObjectId(roomTypeId);
  const count = Number(roomCount) || 1;

  const room = await RoomType.findById(rId).session(session);
  if (!room || !room.isActive) {
    return { success: false, message: "Room type is inactive or not found." };
  }

  // Support all common field names for baseline room count
  const defaultTotalRooms = Number(
    room.totalInventory ?? room.totalRooms ?? room.totalUnits ?? room.inventory ?? 10
  );
  const defaultBasePrice = Number(room.basePrice ?? 0);

  // 2. Normalize dates to pure UTC Midnight
  const start = new Date(checkInDate);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(checkOutDate);
  end.setUTCHours(0, 0, 0, 0);

  const nights = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  if (nights <= 0) {
    return { success: false, message: "Invalid date range." };
  }

  // 3. Ensure daily inventory records exist with atomic upsert
  const initOps = [];
  for (let i = 0; i < nights; i++) {
    const dayDate = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    dayDate.setUTCHours(0, 0, 0, 0);

    initOps.push({
      updateOne: {
        filter: { hotelId: hId, roomTypeId: rId, date: dayDate },
        update: {
          $setOnInsert: {
            hotelId: hId,
            roomTypeId: rId,
            date: dayDate,
            price: defaultBasePrice,
            totalRooms: defaultTotalRooms,
            availableRooms: defaultTotalRooms,
            isBlocked: false,
          },
        },
        upsert: true,
      },
    });
  }

  await DailyInventory.bulkWrite(initOps, { session });

  // 4. Decrement inventory atomically across all stay dates
  const bulkOps = [];
  for (let i = 0; i < nights; i++) {
    const dayDate = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    dayDate.setUTCHours(0, 0, 0, 0);

    bulkOps.push({
      updateOne: {
        filter: {
          hotelId: hId,
          roomTypeId: rId,
          date: dayDate,
          availableRooms: { $gte: count },
          isBlocked: false,
        },
        update: {
          $inc: { availableRooms: -count },
        },
      },
    });
  }

  const result = await DailyInventory.bulkWrite(bulkOps, { session });

  if (result.modifiedCount !== nights) {
    return {
      success: false,
      message: "One or more selected dates are sold out or unavailable.",
    };
  }

  return { success: true };
}

/**
 * Atomically restores available rooms (used for cancellations and expired holds)
 */
export async function releaseRoomInventory({
  hotelId,
  roomTypeId,
  checkInDate,
  checkOutDate,
  roomCount,
  session = null,
}) {
  const options = session ? { session } : {};
  const hId = new mongoose.Types.ObjectId(hotelId);
  const rId = new mongoose.Types.ObjectId(roomTypeId);
  const count = Number(roomCount) || 1;

  const start = new Date(checkInDate);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(checkOutDate);
  end.setUTCHours(0, 0, 0, 0);

  return DailyInventory.updateMany(
    {
      hotelId: hId,
      roomTypeId: rId,
      date: { $gte: start, $lt: end },
    },
    {
      $inc: { availableRooms: count },
    },
    options,
  );
}

export async function setRedisHoldLock(bookingId, metadata) {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.set(`hold:${bookingId}`, JSON.stringify(metadata), { ex: 600 });
  } catch (err) {
    console.error("[Redis Lock Error]", err.message);
  }
}

export async function removeRedisHoldLock(bookingId) {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.del(`hold:${bookingId}`);
  } catch (err) {
    console.error("[Redis Delete Lock Error]", err.message);
  }
}

export const deleteRedisHoldLock = removeRedisHoldLock;