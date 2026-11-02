import mongoose from 'mongoose';

const DailyInventorySchema = new mongoose.Schema(
  {
    hotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hotel',
      required: true,
      index: true,
    },
    roomTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RoomType',
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true, // Normalized UTC midnight (YYYY-MM-DDT00:00:00.000Z)
    },
    totalRooms: {
      type: Number,
      required: true,
    },
    availableRooms: {
      type: Number,
      required: true,
    },
    price: {
      type: Number,
      required: true, // Specific rate for this date (dynamic/seasonal pricing)
    },
    isBlocked: {
      type: Boolean,
      default: false, // Manual stop-sell / blackout by hotelier
    },
    closedToArrival: {
      type: Boolean,
      default: false, // CTA flag: prevents check-ins on this date, but allows stays extending through it
    },
    minStay: {
      type: Number,
      default: 1, // Specific minimum night rule required for check-ins on this date
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Prevents duplicate records for the same room type on the same date
DailyInventorySchema.index({ hotelId: 1, roomTypeId: 1, date: 1 }, { unique: true });

// Read query performance index
DailyInventorySchema.index({ hotelId: 1, date: 1, availableRooms: 1, isBlocked: 1 });

export default mongoose.model('DailyInventory', DailyInventorySchema);