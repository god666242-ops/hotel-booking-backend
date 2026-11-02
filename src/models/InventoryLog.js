import mongoose from 'mongoose';

const inventoryLogSchema = new mongoose.Schema(
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
    },
    roomName: {
      type: String,
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    daysCount: {
      type: Number,
      required: true,
    },
    actionType: {
      type: String,
      enum: ['RATE_OVERRIDE', 'STOCK_OVERRIDE', 'BLACKOUT', 'RESET', 'MIXED'],
      required: true,
    },
    changes: {
      price: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },
      availableRooms: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },
      isBlocked: {
        type: Boolean,
        default: false,
      },
    },
    updatedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      email: { type: String, default: 'Admin' },
    },
    // Retention timestamp: endDate + 7 days
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // MongoDB TTL Index: automatically deletes document when current time >= expiresAt
    },
  },
  { timestamps: true }
);

inventoryLogSchema.index({ hotelId: 1, createdAt: -1 });

export default mongoose.model('InventoryLog', inventoryLogSchema);