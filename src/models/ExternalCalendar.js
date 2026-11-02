import mongoose from "mongoose";

/** An iCal feed (from Booking.com, Airbnb, MakeMyTrip...) that blocks one room type. */
const ExternalCalendarSchema = new mongoose.Schema(
  {
    hotelId: { type: mongoose.Schema.Types.ObjectId, ref: "Hotel", required: true, index: true },
    roomTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "RoomType", required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 }, // e.g. "Booking.com"
    // Feed URLs usually contain a secret token, so they are stored encrypted
    urlEncrypted: { type: String, required: true },
    urlHint: { type: String, default: "" }, // host only, safe to show
    isActive: { type: Boolean, default: true },

    lastSyncAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    eventCount: { type: Number, default: 0 },
    conflictCount: { type: Number, default: 0 },
    // Lets several server instances share the work without syncing the same feed twice
    syncLockUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("ExternalCalendar", ExternalCalendarSchema);
