import rateLimit from 'express-rate-limit';

/**
 * General public API rate limiter (browsing rooms, availability, rates)
 */
export const publicApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each client IP to 300 requests per 15 min window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/**
 * Checkout hold rate limiter (prevents booking hold flooding / inventory starvation)
 */
export const checkoutHoldLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 30, // Limit each client IP to 30 hold attempts per 10 min window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Checkout rate limit exceeded. Please wait a moment.' },
});

/**
 * Strict authentication limiter (brute-force defense for login and registration)
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 attempts per 15 minutes per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  skipSuccessfulRequests: true, // Only penalize failed login attempts
  message: {
    success: false,
    message: 'Too many failed login attempts from this IP. Please try again after 15 minutes.',
  },
});

/**
 * Registration email limiter. Unlike authLimiter it counts successful requests
 * too, because every successful call sends an email (to the platform admin or
 * to a stranger-supplied address). Used on /register/initiate and /register/resend-otp.
 */
export const registrationEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: {
    success: false,
    message: 'Too many registration requests from this network. Please try again in an hour.',
  },
});

/**
 * Password reset / invite emails: each successful call sends an email, so count them all.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many password reset requests. Please try again in an hour.' },
});
