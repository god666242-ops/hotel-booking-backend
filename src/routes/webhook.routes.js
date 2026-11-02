import express from 'express';
import rateLimit from 'express-rate-limit';
import { handleRazorpayWebhook } from '../controllers/webhook/razorpay.controller.js';

const router = express.Router();

/**
 * Dedicated webhook rate limiter:
 * Allows legitimate high-volume callback bursts from Razorpay IPs
 * while preventing DoS attacks and alert fatigue from forged webhooks.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 120, // Max 120 webhook deliveries per minute per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: {
    success: false,
    message: 'Webhook rate limit exceeded. Please retry shortly.',
  },
});

router.post('/razorpay', webhookLimiter, handleRazorpayWebhook);

export default router;