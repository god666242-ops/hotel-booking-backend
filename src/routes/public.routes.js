import express from 'express';
import { getHotelMetadata, checkAvailability } from '../controllers/public/availability.controller.js';
import { initiateBookingHold, releaseBookingHold } from '../controllers/public/checkout.controller.js';
import { publicApiLimiter, checkoutHoldLimiter } from '../middlewares/rateLimiter.middleware.js';
import { getCalendarRates, validatePromoCode } from '../controllers/public/rates.controller.js';
import {
  getGuestBookingDetails,
  cancelGuestBooking,
  downloadGuestInvoice,
  downloadGuestCreditNote,
  previewGuestBookingModification,
  modifyGuestBooking,
} from '../controllers/public/guestBooking.controller.js';
import { serveIcalFeed } from '../controllers/public/ical.controller.js';

const router = express.Router();

// OTA calendar feed (token-protected). Registered first so it never clashes with /:hotelSlug/...
router.get('/ical/:hotelSlug/:roomTypeId/:file', publicApiLimiter, serveIcalFeed);

// Hotel metadata, room availability & calendar rates
router.get('/:hotelSlug/meta', publicApiLimiter, getHotelMetadata);
router.get('/:hotelSlug/availability', publicApiLimiter, checkAvailability);
router.get('/:hotelSlug/rates', publicApiLimiter, getCalendarRates);

// Promo code verification
router.post('/:hotelSlug/validate-promo', publicApiLimiter, validatePromoCode);

// Checkout hold & instant hold release
router.post('/:hotelSlug/hold', checkoutHoldLimiter, initiateBookingHold);
router.post('/:hotelSlug/release-hold', publicApiLimiter, releaseBookingHold);

// Customer self-service: Manage booking, voucher receipt, credit note & cancellation
router.get('/:hotelSlug/bookings/:bookingCode', publicApiLimiter, getGuestBookingDetails);
router.get('/:hotelSlug/bookings/:bookingCode/invoice', publicApiLimiter, downloadGuestInvoice);
router.get('/:hotelSlug/bookings/:bookingCode/credit-note', publicApiLimiter, downloadGuestCreditNote);
router.post('/:hotelSlug/bookings/:bookingCode/cancel', publicApiLimiter, cancelGuestBooking);

router.post('/:hotelSlug/bookings/:bookingCode/modify-preview', publicApiLimiter, previewGuestBookingModification);
router.post('/:hotelSlug/bookings/:bookingCode/modify', publicApiLimiter, modifyGuestBooking);

export default router;