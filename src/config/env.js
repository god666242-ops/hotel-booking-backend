import { encryptSecret } from "../services/crypto.service.js";

const WEAK_JWT_SECRETS = [
  "your_jwt_secret_minimum_32_characters_long",
  "secret",
  "changeme",
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Fails fast at boot with ONE readable error listing everything that is wrong,
 * instead of failing later (and obscurely) on the first request that needs it.
 */
export function validateEnv() {
  const problems = [];
  const isProd = process.env.NODE_ENV === "production";

  if (!process.env.MONGODB_URI) {
    problems.push("MONGODB_URI is missing.");
  }

  const jwtSecret = process.env.JWT_SECRET || "";
  if (jwtSecret.length < 32 || WEAK_JWT_SECRETS.includes(jwtSecret)) {
    problems.push("JWT_SECRET must be a unique random string of at least 32 characters.");
  }

  try {
    encryptSecret("env-self-check"); // exercises key presence, length and example-value checks
  } catch (err) {
    problems.push(err.message);
  }

  // Turnstile Bot Protection: If secret is set, site key MUST be set
  // Otherwise, widget cannot render the challenge and all checkout holds get rejected
  if (
    process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY &&
    !process.env.CLOUDFLARE_TURNSTILE_SITE_KEY
  ) {
    problems.push(
      "CLOUDFLARE_TURNSTILE_SITE_KEY must be configured when CLOUDFLARE_TURNSTILE_SECRET_KEY is provided.",
    );
  }

  // Optional: Verify alert email format if provided
  if (
    process.env.SUPER_ADMIN_ALERT_EMAIL &&
    !EMAIL_REGEX.test(process.env.SUPER_ADMIN_ALERT_EMAIL.trim())
  ) {
    problems.push("SUPER_ADMIN_ALERT_EMAIL is not a valid email address.");
  }

  if (isProd) {
    for (const name of [
      "MASTER_RAZORPAY_KEY_ID",
      "MASTER_RAZORPAY_KEY_SECRET",
      "MASTER_RAZORPAY_WEBHOOK_SECRET",
      "ALLOWED_ORIGINS",
      // Hotel registration needs Redis (pending signups) and email (OTP codes)
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "SUPER_ADMIN_EMAIL",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      // Guest emails link back to the booking management page
      "CLIENT_BASE_URL",
    ]) {
      if (!process.env[name]) problems.push(`${name} is required in production.`);
    }

    if (
      process.env.SUPER_ADMIN_EMAIL &&
      !EMAIL_REGEX.test(process.env.SUPER_ADMIN_EMAIL.trim())
    ) {
      problems.push("SUPER_ADMIN_EMAIL is not a valid email address.");
    }

    if (/^x+$/i.test(process.env.ALLOWED_ORIGINS || "")) {
      problems.push("ALLOWED_ORIGINS still contains the placeholder value.");
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n - ${problems.join("\n - ")}`,
    );
  }
}