import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import DailyInventory from "../../src/models/DailyInventory.js";
import { holdRoomInventory } from "../../src/services/inventory.service.js";
import RoomType from "../../src/models/RoomType.js";

describe("Atomic Inventory Engine - Concurrent Hold Race Conditions", () => {
  let mongoServer;
  const hotelId = new mongoose.Types.ObjectId();
  const roomTypeId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    // The hold engine requires the room type to exist
    await RoomType.create({
      _id: roomTypeId,
      hotelId,
      name: "Test Room",
      basePrice: 3500,
      totalUnits: 1,
    });

    // Seed 1 room available across 2 nights
    await DailyInventory.create([
      {
        hotelId,
        roomTypeId,
        date: new Date("2026-11-10T00:00:00.000Z"),
        totalRooms: 1,
        availableRooms: 1, // Only 1 left!
        price: 3500,
        isBlocked: false,
      },
      {
        hotelId,
        roomTypeId,
        date: new Date("2026-11-11T00:00:00.000Z"),
        totalRooms: 1,
        availableRooms: 1, // Only 1 left!
        price: 3500,
        isBlocked: false,
      },
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it("should allow only one concurrent hold and reject the second with insufficient inventory", async () => {
    const checkIn = new Date("2026-11-10T00:00:00.000Z");
    const checkOut = new Date("2026-11-11T00:00:00.000Z"); // 1 night: one atomic update

    // Simulate two simultaneous users pressing "Proceed to Payment"
    const [user1Result, user2Result] = await Promise.all([
      holdRoomInventory({
        hotelId,
        roomTypeId,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        roomCount: 1,
      }),
      holdRoomInventory({
        hotelId,
        roomTypeId,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        roomCount: 1,
      }),
    ]);

    // Exactly one should succeed, and one should fail
    const successCount = [user1Result.success, user2Result.success].filter(
      Boolean,
    ).length;
    expect(successCount).toBe(1);

    // Verify inventory left in database is exactly 0 (no negative values)
    const records = await DailyInventory.find({ hotelId, roomTypeId }).sort({
      date: 1,
    });
    expect(records[0].availableRooms).toBe(0); // 10 Nov: exactly one hold took the room
    expect(records[1].availableRooms).toBe(1); // 11 Nov: untouched, never negative
  });
});
