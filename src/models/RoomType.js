import mongoose from 'mongoose';

const AddonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    chargeType: {
      type: String,
      enum: ['PER_STAY', 'PER_NIGHT', 'PER_GUEST', 'PER_GUEST_PER_NIGHT', 'PER_PERSON'],
      default: 'PER_STAY',
    },
    isActive: { type: Boolean, default: true },
  },
  { _id: true }
);

const RoomTypeSchema = new mongoose.Schema(
  {
    hotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hotel',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    baseOccupancy: {
      type: Number,
      required: true,
      default: 2,
    },
    maxOccupancy: {
      type: Number,
      required: true,
      default: 3,
    },
    extraAdultRate: {
      type: Number,
      default: 0,
    },
    extraChildRate: {
      type: Number,
      default: 0,
    },
    basePrice: {
      type: Number,
      required: true,
    },
    totalUnits: {
      type: Number,
      required: true,
    },
    // Optional custom tax override for this room type
    taxPercent: {
      type: Number,
      default: null, // If null, inherits hotel.taxConfig.taxPercent
    },
    photos: {
      type: [String],
      default: [],
    },
    amenities: {
      type: [String],
      default: ['Free Wi-Fi', 'AC', 'Room Service'],
    },
    addOns: [AddonSchema],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model('RoomType', RoomTypeSchema);