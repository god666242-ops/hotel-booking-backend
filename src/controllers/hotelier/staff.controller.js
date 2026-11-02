import crypto from "crypto";
import mongoose from "mongoose";
import User from "../../models/User.js";
import Hotel from "../../models/Hotel.js";
import { issueAuthToken, adminBaseUrl } from "./account.controller.js";
import { sendStaffInviteEmail } from "../../services/notification.service.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITABLE_ROLES = ["STAFF", "HOTELIER"];

const publicUser = (u) => ({
  id: u._id,
  name: u.name,
  email: u.email,
  role: u.role,
  isActive: u.isActive,
  invitePending: Boolean(u.invitePending),
  createdAt: u.createdAt,
});

async function sendInvite({ user, hotel, inviter }) {
  const raw = await issueAuthToken({ userId: user._id, type: "STAFF_INVITE", ttlMs: INVITE_TTL_MS });
  const inviteUrl = `${adminBaseUrl()}/accept-invite?token=${raw}`;
  await sendStaffInviteEmail({
    to: user.email,
    name: user.name,
    hotelName: hotel?.name || "your hotel",
    inviterName: inviter?.name,
    inviteUrl,
    role: user.role,
  });
}

/** GET /staff - everyone who works at this hotel */
export async function listStaff(req, res, next) {
  try {
    const users = await User.find({ hotelId: req.user.hotelId }).sort({ createdAt: 1 }).lean();
    return res.status(200).json({ success: true, data: users.map(publicUser) });
  } catch (error) {
    next(error);
  }
}

/** POST /staff/invite { name, email, role } - creates the account and emails the invite */
export async function inviteStaff(req, res, next) {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = req.body?.role || "STAFF";

    if (!name || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ success: false, message: "A name and a valid email are required." });
    }
    if (!INVITABLE_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: "Role must be STAFF or HOTELIER." });
    }
    if (await User.findOne({ email }).lean()) {
      return res.status(409).json({ success: false, message: "That email already has an account." });
    }

    const hotel = await Hotel.findById(req.user.hotelId).select("name");

    // The invitee sets the real password when accepting; until then this random
    // value makes the account impossible to sign in to.
    const user = await User.create({
      name,
      email,
      password: crypto.randomBytes(24).toString("hex"),
      hotelId: req.user.hotelId,
      role,
      invitePending: true,
      invitedBy: req.user._id,
    });

    try {
      await sendInvite({ user, hotel, inviter: req.user });
    } catch (mailErr) {
      console.error("[Staff Invite] Email failed:", mailErr.message);
      return res.status(502).json({
        success: false,
        message: "The account was created but the invitation email could not be sent. Use 'Resend invite'.",
        data: publicUser(user),
      });
    }

    return res.status(201).json({ success: true, message: `Invitation sent to ${email}.`, data: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "That email already has an account." });
    }
    next(error);
  }
}

async function loadTeammate(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ success: false, message: "Invalid staff id." });
    return null;
  }
  const user = await User.findOne({ _id: id, hotelId: req.user.hotelId });
  if (!user) {
    res.status(404).json({ success: false, message: "Team member not found." });
    return null;
  }
  return user;
}

/** POST /staff/:id/resend-invite */
export async function resendInvite(req, res, next) {
  try {
    const user = await loadTeammate(req, res);
    if (!user) return;
    if (!user.invitePending) {
      return res.status(400).json({ success: false, message: "This person has already joined." });
    }
    const hotel = await Hotel.findById(req.user.hotelId).select("name");
    try {
      await sendInvite({ user, hotel, inviter: req.user });
    } catch (mailErr) {
      console.error("[Staff Invite] Resend failed:", mailErr.message);
      return res.status(502).json({ success: false, message: "The email could not be sent. Please try again." });
    }
    return res.status(200).json({ success: true, message: `Invitation re-sent to ${user.email}.` });
  } catch (error) {
    next(error);
  }
}

/** PATCH /staff/:id { isActive?, role? } - deactivating also revokes their sessions */
export async function updateStaff(req, res, next) {
  try {
    const user = await loadTeammate(req, res);
    if (!user) return;

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ success: false, message: "You cannot change your own access here." });
    }
    if (user.role === "SUPER_ADMIN") {
      return res.status(403).json({ success: false, message: "That account cannot be changed here." });
    }

    const { isActive, role } = req.body || {};
    if (typeof isActive === "boolean") {
      user.isActive = isActive;
      if (!isActive) user.tokenVersion = (user.tokenVersion ?? 0) + 1; // kick out immediately
    }
    if (role !== undefined) {
      if (!INVITABLE_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: "Role must be STAFF or HOTELIER." });
      }
      user.role = role;
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    }

    // Never leave a hotel without an active manager
    if (user.isModified("isActive") || user.isModified("role")) {
      const otherManagers = await User.countDocuments({
        hotelId: req.user.hotelId,
        _id: { $ne: user._id },
        role: "HOTELIER",
        isActive: true,
      });
      if (otherManagers === 0 && (!user.isActive || user.role !== "HOTELIER")) {
        return res.status(400).json({ success: false, message: "The hotel must keep at least one active manager." });
      }
    }

    await user.save();
    return res.status(200).json({ success: true, data: publicUser(user) });
  } catch (error) {
    next(error);
  }
}
