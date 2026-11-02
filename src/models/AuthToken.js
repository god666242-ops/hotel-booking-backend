import mongoose from "mongoose";
import crypto from "crypto";

/**
 * One-time tokens for password reset and staff invites.
 * Only a SHA-256 hash is stored; the raw token exists only in the email link.
 */
const AuthTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["PASSWORD_RESET", "STAFF_INVITE"], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// MongoDB removes expired documents automatically
AuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

export default mongoose.model("AuthToken", AuthTokenSchema);
