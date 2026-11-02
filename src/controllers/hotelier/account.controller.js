import crypto from "crypto";
import User from "../../models/User.js";
import Hotel from "../../models/Hotel.js";
import AuthToken, { hashToken } from "../../models/AuthToken.js";
import { generateToken } from "./auth.controller.js";
import { sendPasswordResetEmail } from "../../services/notification.service.js";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_PASSWORD = 8;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

export const adminBaseUrl = () =>
  (process.env.ADMIN_BASE_URL || process.env.CLIENT_BASE_URL || process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );

const userPayload = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role });

/** Creates a single-use token, replacing any older unused one of the same type. */
export async function issueAuthToken({ userId, type, ttlMs }) {
  await AuthToken.deleteMany({ userId, type, usedAt: null });
  const raw = crypto.randomBytes(32).toString("hex");
  await AuthToken.create({ userId, type, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + ttlMs) });
  return raw;
}

/** Atomically consumes a valid token. Returns the token doc, or null. */
export async function consumeAuthToken(raw, type) {
  if (!isStr(raw) || raw.length > 200) return null;
  return AuthToken.findOneAndUpdate(
    { tokenHash: hashToken(raw), type, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
}

/**
 * POST /auth/forgot-password  { email }
 * Always answers the same way so the endpoint cannot be used to discover accounts.
 */
export async function forgotPassword(req, res, next) {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const generic = {
      success: true,
      message: "If an account exists for that email, a reset link has been sent.",
    };
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });

    const user = await User.findOne({ email });
    if (user && user.isActive && !user.invitePending) {
      const raw = await issueAuthToken({ userId: user._id, type: "PASSWORD_RESET", ttlMs: RESET_TTL_MS });
      const resetUrl = `${adminBaseUrl()}/reset-password?token=${raw}`;
      try {
        await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl });
      } catch (mailErr) {
        console.error("[Password Reset] Email failed:", mailErr.message);
      }
    }
    return res.status(200).json(generic);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/reset-password  { token, password }
 * Sets the new password and revokes every existing session.
 */
export async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body || {};
    if (!isStr(token) || !isStr(password)) {
      return res.status(400).json({ success: false, message: "Token and new password are required." });
    }
    if (password.length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ success: false, message: `Password must be at least ${MIN_PASSWORD} characters.` });
    }

    const record = await consumeAuthToken(token, "PASSWORD_RESET");
    if (!record) {
      return res.status(400).json({
        success: false,
        message: "This reset link is invalid or has expired. Please request a new one.",
      });
    }

    const user = await User.findById(record.userId).select("+password");
    if (!user || !user.isActive) {
      return res.status(400).json({ success: false, message: "This account is not available." });
    }

    user.password = password;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.passwordChangedAt = new Date();
    await user.save();
    await AuthToken.deleteMany({ userId: user._id, type: "PASSWORD_RESET" });

    return res.status(200).json({ success: true, message: "Password updated. Please sign in with your new password." });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/change-password  { currentPassword, newPassword }   (signed in)
 * Revokes all other sessions and returns a fresh token for this one.
 */
export async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!isStr(currentPassword) || !isStr(newPassword)) {
      return res.status(400).json({ success: false, message: "Current and new password are required." });
    }
    if (newPassword.length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ success: false, message: `New password must be at least ${MIN_PASSWORD} characters.` });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ success: false, message: "Choose a password you have not used just now." });
    }

    const user = await User.findById(req.user._id).select("+password");
    if (!user || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ success: false, message: "Current password is incorrect." });
    }

    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.passwordChangedAt = new Date();
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password changed. You were signed out on all other devices.",
      token: generateToken(user),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /auth/logout-all   (signed in)
 * Revokes every token issued for this account, including the current one.
 */
export async function logoutAllDevices(req, res, next) {
  try {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    return res.status(200).json({ success: true, message: "Signed out everywhere." });
  } catch (error) {
    next(error);
  }
}

/** GET /auth/invite/:token - lets the accept page greet the invitee. Does not consume the token. */
export async function getInviteInfo(req, res, next) {
  try {
    const raw = String(req.params.token || "");
    const record = await AuthToken.findOne({
      tokenHash: hashToken(raw),
      type: "STAFF_INVITE",
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!record) {
      return res.status(404).json({ success: false, message: "This invitation is invalid or has expired." });
    }
    const user = await User.findById(record.userId).select("name email role hotelId").lean();
    const hotel = user?.hotelId ? await Hotel.findById(user.hotelId).select("name").lean() : null;
    if (!user) return res.status(404).json({ success: false, message: "This invitation is no longer valid." });
    return res.status(200).json({
      success: true,
      data: { name: user.name, email: user.email, role: user.role, hotelName: hotel?.name || "" },
    });
  } catch (error) {
    next(error);
  }
}

/** POST /auth/accept-invite  { token, password } -> activates the account and signs in. */
export async function acceptInvite(req, res, next) {
  try {
    const { token, password } = req.body || {};
    if (!isStr(token) || !isStr(password)) {
      return res.status(400).json({ success: false, message: "Token and password are required." });
    }
    if (password.length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ success: false, message: `Password must be at least ${MIN_PASSWORD} characters.` });
    }

    const record = await consumeAuthToken(token, "STAFF_INVITE");
    if (!record) {
      return res.status(400).json({
        success: false,
        message: "This invitation is invalid or has expired. Ask your manager to send a new one.",
      });
    }

    const user = await User.findById(record.userId).select("+password");
    if (!user || !user.isActive) {
      return res.status(400).json({ success: false, message: "This account is not available." });
    }

    user.password = password;
    user.invitePending = false;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.passwordChangedAt = new Date();
    await user.save();

    const hotel = user.hotelId ? await Hotel.findById(user.hotelId).select("name slug") : null;
    return res.status(200).json({
      success: true,
      token: generateToken(user),
      user: userPayload(user),
      hotel: hotel ? { id: hotel._id, name: hotel.name, slug: hotel.slug } : null,
    });
  } catch (error) {
    next(error);
  }
}
