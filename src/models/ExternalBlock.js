import mongoose from "mongoose";

/**
 * One reservation imported from an external calendar. When status is APPLIED we
 * have removed one room from our inventory for [start, end). CONFLICT means the
 * OTA took a booking for dates we had already sold out - nothing was removed and
 * the hotel needs to resolve it.
 */
const ExternalBlockSchema = new mongoose.Schema(
  {
    calendarId: { type: mongoose.Schema.Types.ObjectId, ref: "ExternalCalendar", required: true, index: true },
    hotelId: { type: mongoose.Schema.Types.ObjectId, ref: "Hotel", required: true, index: true },
    roomTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "RoomType", required: true },
    uid: { type: String, required: true },
    start: { type: Date, required: true }, // UTC midnight, first blocked night
    end: { type: Date, required: true }, // UTC midnight, check-out (exclusive)
    // First night actually taken from inventory (the feed start, or today if it began earlier)
    appliedStart: { type: Date, default: null },
    summary: { type: String, default: "" },
    status: { type: String, enum: ["APPLIED", "CONFLICT"], required: true },
  },
  { timestamps: true },
);

ExternalBlockSchema.index({ calendarId: 1, uid: 1 }, { unique: true });

export default mongoose.model("ExternalBlock", ExternalBlockSchema);
