import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../../models/User.js";
import Hotel from "../../models/Hotel.js";
import redis from "../../config/redis.js";
import { encryptSecret, decryptSecret } from "../../services/crypto.service.js";
import {
  sendSuperAdminRegistrationOtp,
  sendHotelierRegistrationOtp,
} from "../../services/notification.service.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REGISTRATION_TTL_SECONDS = 900; // 15 minutes window for verification
const MAX_OTP_ATTEMPTS = 5; // wrong codes allowed per stage before the session is destroyed
const MAX_RESENDS = 3; // resend requests allowed per registration
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_INITIATES_PER_EMAIL_PER_HOUR = 5;

const sessionKey = (id) => `reg:session:${id}`;
const attemptsKey = (stage, id) => `reg:attempts:${stage}:${id}`;
const resendsKey = (id) => `reg:resends:${id}`;
const cooldownKey = (id) => `reg:cooldown:${id}`;
const completeLockKey = (id) => `reg:complete-lock:${id}`;

export const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, tv: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
  );
};

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Cryptographically secure 6-digit OTP (000000-999999) and its SHA-256 hash.
 * Only the hash is ever stored.
 */
function generateOtp() {
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
  return { code, hash: hashOtp(code) };
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(String(code).trim()).digest("hex");
}

/** Constant-time comparison of two hex SHA-256 digests. */
function otpMatches(candidateHash, storedHash) {
  if (typeof candidateHash !== "string" || typeof storedHash !== "string") {
    return false;
  }
  const a = Buffer.from(candidateHash, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseSessionData(sessionRaw) {
  if (!sessionRaw) return null;
  if (typeof sessionRaw === "object") return sessionRaw;
  try {
    return JSON.parse(sessionRaw);
  } catch {
    return null;
  }
}

async function loadSession(registrationId) {
  return parseSessionData(await redis.get(sessionKey(registrationId)));
}

async function saveSession(registrationId, data) {
  await redis.set(sessionKey(registrationId), JSON.stringify(data), {
    ex: REGISTRATION_TTL_SECONDS,
  });
}

/** Destroys a registration and every counter attached to it. */
async function destroySession(registrationId) {
  await Promise.all([
    redis.del(sessionKey(registrationId)),
    redis.del(attemptsKey("admin", registrationId)),
    redis.del(attemptsKey("hotelier", registrationId)),
    redis.del(resendsKey(registrationId)),
    redis.del(cooldownKey(registrationId)),
    redis.del(completeLockKey(registrationId)),
  ]).catch(() => {});
}

/**
 * Atomic counter (INCR) that expires with the registration window.
 * Returns the new count. Atomic so parallel guesses cannot slip past the cap.
 */
async function bumpCounter(key) {
  await redis.set(key, 0, { nx: true, ex: REGISTRATION_TTL_SECONDS });
  return Number(await redis.incr(key));
}

/**
 * Counts one OTP guess for a stage. When the cap is exceeded the whole
 * registration is destroyed, so the code cannot be brute-forced across many IPs.
 * Returns true when the caller may proceed with checking the code.
 */
async function consumeOtpAttempt(stage, registrationId, res) {
  const attempts = await bumpCounter(attemptsKey(stage, registrationId));
  if (attempts > MAX_OTP_ATTEMPTS) {
    await destroySession(registrationId);
    res.status(429).json({
      success: false,
      sessionClosed: true,
      message:
        "Too many incorrect codes. This registration was cancelled for security; please start again.",
    });
    return false;
  }
  return true;
}

const sessionGone = (res) =>
  res.status(410).json({
    success: false,
    sessionClosed: true,
    message:
      "Registration session has expired. Please initiate registration again.",
  });

/**
 * STEP 1: POST /api/v1/admin/auth/register/initiate
 * Validates the signup payload, stores the draft in Redis (password encrypted),
 * and emails the Tier-1 approval OTP to SUPER_ADMIN_EMAIL.
 */
export async function initiateRegistration(req, res, next) {
  try {
    const { name, email, password, hotelName, hotelSlug, phone } =
      req.body || {};

    if (
      ![name, email, password, hotelName, hotelSlug, phone].every(
        isNonEmptyString,
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Name, email, password, phone, hotel name and hotel slug are required.",
      });
    }

    const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || "")
      .trim()
      .toLowerCase();
    if (!superAdminEmail || !EMAIL_PATTERN.test(superAdminEmail)) {
      return res.status(500).json({
        success: false,
        message: "Platform SUPER_ADMIN_EMAIL is not configured on the server.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedSlug = hotelSlug.trim().toLowerCase();

    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters.",
      });
    }

    if (
      normalizedSlug.length < 3 ||
      normalizedSlug.length > 50 ||
      !SLUG_PATTERN.test(normalizedSlug)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Hotel handle must be 3-50 characters: lowercase letters, numbers and single hyphens only.",
      });
    }

    // Verify uniqueness upfront before sending anything
    if (await User.findOne({ email: normalizedEmail }).lean()) {
      return res
        .status(400)
        .json({ success: false, message: "Email is already registered." });
    }

    if (await Hotel.findOne({ slug: normalizedSlug }).lean()) {
      return res
        .status(400)
        .json({ success: false, message: "Hotel slug is already taken." });
    }

    // Throttle per email address so one address cannot be used to flood the admin inbox
    const emailHash = crypto
      .createHash("sha256")
      .update(normalizedEmail)
      .digest("hex");
    const initiateKey = `reg:initiate:email:${emailHash}`;
    await redis.set(initiateKey, 0, { nx: true, ex: 3600 });
    if (Number(await redis.incr(initiateKey)) > MAX_INITIATES_PER_EMAIL_PER_HOUR) {
      return res.status(429).json({
        success: false,
        message:
          "Too many registration attempts for this email. Please try again in an hour.",
      });
    }

    // Session ID & Tier-1 Super Admin OTP
    const registrationId = `reg_${crypto.randomBytes(16).toString("hex")}`;
    const { code: adminOtp, hash: adminOtpHash } = generateOtp();

    const registrationData = {
      name: name.trim(),
      email: normalizedEmail,
      // Never keep the plaintext password in Redis; it is decrypted only at the final step.
      passwordEncrypted: encryptSecret(password),
      hotelName: hotelName.trim(),
      hotelSlug: normalizedSlug,
      phone: phone.trim(),
      adminApproved: false,
      adminOtpHash,
      hotelierOtpHash: null,
      createdAt: Date.now(),
    };

    await saveSession(registrationId, registrationData);

    try {
      await sendSuperAdminRegistrationOtp({
        superAdminEmail,
        hotelName: registrationData.hotelName,
        hotelSlug: normalizedSlug,
        managerName: registrationData.name,
        email: normalizedEmail,
        phone: registrationData.phone,
        otp: adminOtp,
      });
    } catch (mailErr) {
      console.error("[Registration] Could not send admin OTP:", mailErr.message);
      await destroySession(registrationId);
      return res.status(502).json({
        success: false,
        message:
          "We could not send the authorization email. Please try again in a few minutes.",
      });
    }

    // Start the resend cooldown immediately so "Resend" can't be hammered right away
    await redis.set(cooldownKey(registrationId), "1", {
      nx: true,
      ex: RESEND_COOLDOWN_SECONDS,
    });

    return res.status(200).json({
      success: true,
      step: "SUPER_ADMIN_OTP_REQUIRED",
      registrationId,
      message:
        "An authorization code has been sent to the platform administrator for approval.",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * STEP 2: POST /api/v1/admin/auth/register/verify-admin-otp
 * Verifies the Tier-1 OTP. Once valid, generates the Tier-2 OTP and emails the hotelier.
 */
export async function verifySuperAdminOtp(req, res, next) {
  try {
    const { registrationId, otp } = req.body || {};

    if (!isNonEmptyString(registrationId) || !isNonEmptyString(otp)) {
      return res.status(400).json({
        success: false,
        message: "Registration ID and 6-digit approval OTP are required.",
      });
    }

    const sessionData = await loadSession(registrationId);
    if (!sessionData) return sessionGone(res);

    if (sessionData.adminApproved) {
      return res.status(200).json({
        success: true,
        step: "HOTELIER_OTP_REQUIRED",
        registrationId,
        message: "Platform administrator already approved this registration.",
      });
    }

    if (!(await consumeOtpAttempt("admin", registrationId, res))) return;

    if (!otpMatches(hashOtp(otp), sessionData.adminOtpHash)) {
      return res.status(403).json({
        success: false,
        message: "Invalid super admin authorization code.",
      });
    }

    // Tier-1 approved -> generate Tier-2 OTP for the hotelier
    const { code: hotelierOtp, hash: hotelierOtpHash } = generateOtp();

    sessionData.adminApproved = true;
    sessionData.hotelierOtpHash = hotelierOtpHash;
    await saveSession(registrationId, sessionData);

    try {
      await sendHotelierRegistrationOtp({
        to: sessionData.email,
        managerName: sessionData.name,
        hotelName: sessionData.hotelName,
        otp: hotelierOtp,
      });
    } catch (mailErr) {
      // Approval is kept; the person can press "Resend" for the email code.
      console.error("[Registration] Could not send hotelier OTP:", mailErr.message);
      return res.status(502).json({
        success: false,
        message:
          "Approval was recorded but the verification email could not be sent. Please use Resend.",
      });
    }

    await redis.del(attemptsKey("admin", registrationId)).catch(() => {});
    await redis.set(cooldownKey(registrationId), "1", {
      nx: true,
      ex: RESEND_COOLDOWN_SECONDS,
    });

    return res.status(200).json({
      success: true,
      step: "HOTELIER_OTP_REQUIRED",
      registrationId,
      message: `Approval verified. A confirmation code has been sent to ${sessionData.email}.`,
    });
  } catch (error) {
    next(error);
  }
}

/** Thrown inside the DB transaction when the email/slug got taken meanwhile. */
class RegistrationConflictError extends Error {}

/**
 * STEP 3: POST /api/v1/admin/auth/register/complete
 * Verifies the hotelier's Tier-2 OTP, atomically creates Hotel + User in a
 * MongoDB transaction, issues the JWT and deletes the Redis session.
 */
export async function verifyHotelierOtpAndComplete(req, res, next) {
  let lockedRegistrationId = null;

  try {
    const { registrationId, otp } = req.body || {};

    if (!isNonEmptyString(registrationId) || !isNonEmptyString(otp)) {
      return res.status(400).json({
        success: false,
        message: "Registration ID and 6-digit confirmation OTP are required.",
      });
    }

    const sessionData = await loadSession(registrationId);
    if (!sessionData) return sessionGone(res);

    if (!sessionData.adminApproved) {
      return res.status(403).json({
        success: false,
        message:
          "This registration request has not been approved by the platform administrator.",
      });
    }

    if (!(await consumeOtpAttempt("hotelier", registrationId, res))) return;

    if (!otpMatches(hashOtp(otp), sessionData.hotelierOtpHash)) {
      return res.status(403).json({
        success: false,
        message: "Invalid email confirmation code.",
      });
    }

    // Only one completion at a time per registration (double click / retry safety)
    const gotLock = await redis.set(completeLockKey(registrationId), "1", {
      nx: true,
      ex: 60,
    });
    if (!gotLock) {
      return res.status(409).json({
        success: false,
        message: "This registration is already being completed.",
      });
    }
    lockedRegistrationId = registrationId;

    let plainPassword;
    try {
      plainPassword = decryptSecret(sessionData.passwordEncrypted);
    } catch {
      plainPassword = null;
    }
    if (!plainPassword) {
      await destroySession(registrationId);
      return sessionGone(res);
    }

    // Atomic creation of Hotel and Hotelier User
    const dbSession = await mongoose.startSession();
    let hotel = null;
    let user = null;

    try {
      await dbSession.withTransaction(async () => {
        if (
          await User.findOne({ email: sessionData.email }).session(dbSession)
        ) {
          throw new RegistrationConflictError("Email is already registered.");
        }
        if (
          await Hotel.findOne({ slug: sessionData.hotelSlug }).session(dbSession)
        ) {
          throw new RegistrationConflictError("Hotel slug is already taken.");
        }

        [hotel] = await Hotel.create(
          [
            {
              name: sessionData.hotelName,
              slug: sessionData.hotelSlug,
              contact: { email: sessionData.email, phone: sessionData.phone },
            },
          ],
          { session: dbSession },
        );

        [user] = await User.create(
          [
            {
              name: sessionData.name,
              email: sessionData.email,
              password: plainPassword,
              hotelId: hotel._id,
              role: "HOTELIER",
              isActive: true,
            },
          ],
          { session: dbSession },
        );
      });
    } finally {
      await dbSession.endSession();
    }

    await destroySession(registrationId);
    lockedRegistrationId = null;

    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      message: "Account and property registered successfully.",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      hotel: { id: hotel._id, name: hotel.name, slug: hotel.slug },
    });
  } catch (error) {
    if (lockedRegistrationId) {
      // Let the person retry with the same (still valid) code
      await redis.del(completeLockKey(lockedRegistrationId)).catch(() => {});
    }

    if (error instanceof RegistrationConflictError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error?.code === 11000) {
      const field = error.keyPattern ? Object.keys(error.keyPattern)[0] : "";
      return res.status(400).json({
        success: false,
        message:
          field === "slug"
            ? "Hotel slug is already taken."
            : "Email is already registered.",
      });
    }
    next(error);
  }
}

/**
 * Resend OTP Endpoint
 * POST /api/v1/admin/auth/register/resend-otp
 * Cooldown + cap are enforced server-side (not just by the UI timer).
 */
export async function resendRegistrationOtp(req, res, next) {
  try {
    const { registrationId } = req.body || {};
    if (!isNonEmptyString(registrationId)) {
      return res
        .status(400)
        .json({ success: false, message: "Registration ID is required." });
    }

    const sessionData = await loadSession(registrationId);
    if (!sessionData) return sessionGone(res);

    // Cooldown: SET NX succeeds only if the previous cooldown has expired
    const cooledDown = await redis.set(cooldownKey(registrationId), "1", {
      nx: true,
      ex: RESEND_COOLDOWN_SECONDS,
    });
    if (!cooledDown) {
      return res.status(429).json({
        success: false,
        message: `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another code.`,
      });
    }

    if ((await bumpCounter(resendsKey(registrationId))) > MAX_RESENDS) {
      await destroySession(registrationId);
      return res.status(429).json({
        success: false,
        sessionClosed: true,
        message:
          "Too many code requests. This registration was cancelled; please start again.",
      });
    }

    const { code, hash } = generateOtp();

    try {
      if (!sessionData.adminApproved) {
        const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || "")
          .trim()
          .toLowerCase();
        sessionData.adminOtpHash = hash;
        await saveSession(registrationId, sessionData);
        // A fresh code deserves a fresh set of attempts
        await redis.del(attemptsKey("admin", registrationId)).catch(() => {});

        await sendSuperAdminRegistrationOtp({
          superAdminEmail,
          hotelName: sessionData.hotelName,
          hotelSlug: sessionData.hotelSlug,
          managerName: sessionData.name,
          email: sessionData.email,
          phone: sessionData.phone,
          otp: code,
        });

        return res.status(200).json({
          success: true,
          message: "New authorization code sent to the platform administrator.",
        });
      }

      sessionData.hotelierOtpHash = hash;
      await saveSession(registrationId, sessionData);
      await redis.del(attemptsKey("hotelier", registrationId)).catch(() => {});

      await sendHotelierRegistrationOtp({
        to: sessionData.email,
        managerName: sessionData.name,
        hotelName: sessionData.hotelName,
        otp: code,
      });

      return res.status(200).json({
        success: true,
        message: `New verification code sent to ${sessionData.email}.`,
      });
    } catch (mailErr) {
      console.error("[Registration] Resend failed:", mailErr.message);
      return res.status(502).json({
        success: false,
        message: "We could not send the email. Please try again shortly.",
      });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/admin/auth/login
 */
export async function loginHotelier(req, res, next) {
  try {
    const { email, password } = req.body || {};

    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required." });
    }

    const user = await User.findOne({
      email: email.trim().toLowerCase(),
    }).select("+password");

    if (!user || !(await user.comparePassword(password))) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password." });
    }

    if (user.isActive === false) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password." });
    }

    const token = generateToken(user);
    const hotel = user.hotelId
      ? await Hotel.findById(user.hotelId).select("name slug")
      : null;

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      hotel: hotel
        ? { id: hotel._id, name: hotel.name, slug: hotel.slug }
        : null,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/admin/auth/me
 */
export async function getProfile(req, res, next) {
  try {
    const hotel = req.user.hotelId
      ? await Hotel.findById(req.user.hotelId).select("name slug contact")
      : null;

    return res.status(200).json({
      success: true,
      user: req.user,
      hotel,
    });
  } catch (error) {
    next(error);
  }
}
