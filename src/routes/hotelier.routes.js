import express from "express";
import {
  initiateRegistration,
  verifySuperAdminOtp,
  verifyHotelierOtpAndComplete,
  resendRegistrationOtp,
  loginHotelier,
  getProfile,
} from "../controllers/hotelier/auth.controller.js";
import {
  getHotelSettings,
  updateHotelSettings,
  updateHotelAddOns,
  updatePaymentGateway,
  updateCancellationPolicy,
  updateTaxSettings,
  updateHotelTrustContent,
  updateLegalSettings,
} from "../controllers/hotelier/hotel.controller.js";
import {
  getRooms,
  createRoom,
  updateRoom,
  deleteRoom,
} from "../controllers/hotelier/room.controller.js";
import {
  getInventoryRange,
  bulkUpdateInventory,
  getInventoryHistory,
} from "../controllers/hotelier/inventory.controller.js";
import {
  getBookings,
  cancelBooking,
  getHotelAnalytics,
  exportBookingsCsv,
  modifyBooking,
} from "../controllers/hotelier/booking.controller.js";
import {
  createOfflineBooking,
  checkInBooking,
  checkOutBooking,
  recordOfflinePayment,
  downloadBookingInvoice,
} from "../controllers/hotelier/frontdesk.controller.js";
import {
  forgotPassword,
  resetPassword,
  changePassword,
  logoutAllDevices,
  getInviteInfo,
  acceptInvite,
} from "../controllers/hotelier/account.controller.js";
import {
  listStaff,
  inviteStaff,
  resendInvite,
  updateStaff,
} from "../controllers/hotelier/staff.controller.js";
import {
  getCalendarSync,
  addCalendar,
  syncCalendarNow,
  removeCalendar,
  regenerateExportToken,
} from "../controllers/hotelier/calendar.controller.js";
import { protect, authorizeRoles } from "../middlewares/auth.middleware.js";
import {
  authLimiter,
  registrationEmailLimiter,
  passwordResetLimiter,
} from "../middlewares/rateLimiter.middleware.js";
import {
  uploadMiddleware,
  handleImageUpload,
} from "../controllers/hotelier/upload.controller.js";
import {
  listCommissionInvoices,
  getCommissionInvoice,
  regeneratePaymentLink,
  getCommissionSummary,
} from "../controllers/hotelier/commission.controller.js";

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Auth & 2-Tier Registration Verification Flow                       */
/* ------------------------------------------------------------------ */

router.post(
  "/auth/register/initiate",
  registrationEmailLimiter,
  authLimiter,
  initiateRegistration,
);
router.post(
  "/auth/register/verify-admin-otp",
  authLimiter,
  verifySuperAdminOtp,
);
router.post(
  "/auth/register/complete",
  authLimiter,
  verifyHotelierOtpAndComplete,
);
router.post(
  "/auth/register/resend-otp",
  registrationEmailLimiter,
  authLimiter,
  resendRegistrationOtp,
);

router.post("/auth/login", authLimiter, loginHotelier);
router.get("/auth/me", protect, getProfile);

router.post("/auth/forgot-password", passwordResetLimiter, forgotPassword);
router.post("/auth/reset-password", authLimiter, resetPassword);
router.post("/auth/change-password", protect, authLimiter, changePassword);
router.post("/auth/logout-all", protect, logoutAllDevices);

router.get("/auth/invite/:token", authLimiter, getInviteInfo);
router.post("/auth/accept-invite", authLimiter, acceptInvite);

/* ------------------------------------------------------------------ */
/* Hotelier Management Endpoints                                      */
/* ------------------------------------------------------------------ */

const managerOnly = authorizeRoles("HOTELIER", "SUPER_ADMIN");
const frontDesk = authorizeRoles("HOTELIER", "STAFF", "SUPER_ADMIN");

// Hotel Profile & Settings (supports /hotel and /hotel/settings with PUT and PATCH)
router.get("/hotel", protect, getHotelSettings);
router.put("/hotel", protect, managerOnly, updateHotelSettings);
router.patch("/hotel", protect, managerOnly, updateHotelSettings);
router.get("/hotel/settings", protect, getHotelSettings);
router.put("/hotel/settings", protect, managerOnly, updateHotelSettings);
router.patch("/hotel/settings", protect, managerOnly, updateHotelSettings);

router.put("/hotel/addons", protect, managerOnly, updateHotelAddOns);
router.put(
  "/hotel/gateway",
  protect,
  managerOnly,
  authLimiter,
  updatePaymentGateway,
);
router.put("/hotel/policies", protect, managerOnly, updateCancellationPolicy);
router.patch("/hotel/policies", protect, managerOnly, updateCancellationPolicy);
router.put("/hotel/taxes", protect, managerOnly, updateTaxSettings);
router.put("/hotel/legal", protect, managerOnly, updateLegalSettings);
router.put(
  "/hotel/trust-content",
  protect,
  managerOnly,
  updateHotelTrustContent,
);

// Room Types
router.get("/rooms", protect, getRooms);
router.post("/rooms", protect, managerOnly, createRoom);
router.put("/rooms/:id", protect, managerOnly, updateRoom);
router.delete("/rooms/:id", protect, managerOnly, deleteRoom);

// Dynamic Inventory & Pricing
router.get("/inventory", protect, getInventoryRange);
router.post(
  "/inventory/bulk-update",
  protect,
  managerOnly,
  bulkUpdateInventory,
);
router.get("/inventory/history", protect, getInventoryHistory);

// ADR/RevPAR Analytics & CSV Export
router.get(
  "/bookings/analytics/adr-revpar",
  protect,
  managerOnly,
  getHotelAnalytics,
);
router.get("/bookings/export/csv", protect, managerOnly, exportBookingsCsv);

// Bookings, Modification & Cancellation
router.get("/bookings", protect, getBookings);
router.post("/bookings/:id/modify", protect, frontDesk, modifyBooking);
router.post("/bookings/:id/cancel", protect, managerOnly, cancelBooking);

// Front Desk Operations
router.post("/bookings/offline", protect, frontDesk, createOfflineBooking);
router.post("/bookings/:id/check-in", protect, frontDesk, checkInBooking);
router.post("/bookings/:id/check-out", protect, frontDesk, checkOutBooking);
router.post("/bookings/:id/payments", protect, frontDesk, recordOfflinePayment);
router.get("/bookings/:id/invoice", protect, frontDesk, downloadBookingInvoice);

// Team Management
router.get("/staff", protect, managerOnly, listStaff);
router.post(
  "/staff/invite",
  protect,
  managerOnly,
  passwordResetLimiter,
  inviteStaff,
);
router.post(
  "/staff/:id/resend-invite",
  protect,
  managerOnly,
  passwordResetLimiter,
  resendInvite,
);
router.patch("/staff/:id", protect, managerOnly, updateStaff);

// Calendar Sync (iCal)
router.get("/calendars", protect, managerOnly, getCalendarSync);
router.post("/calendars", protect, managerOnly, addCalendar);
router.post(
  "/calendars/regenerate-token",
  protect,
  managerOnly,
  regenerateExportToken,
);
router.post("/calendars/:id/sync", protect, managerOnly, syncCalendarNow);
router.delete("/calendars/:id", protect, managerOnly, removeCalendar);

// Asset Uploads
router.post(
  "/upload/images",
  protect,
  managerOnly,
  uploadMiddleware.array("images", 8),
  handleImageUpload,
);

// Commission invoices (own-gateway hotels)
router.get(
  "/commission/invoices",
  protect,
  managerOnly,
  listCommissionInvoices,
);
router.get(
  "/commission/invoices/:id",
  protect,
  managerOnly,
  getCommissionInvoice,
);
router.post(
  "/commission/invoices/:id/payment-link",
  protect,
  authorizeRoles("HOTELIER"),
  regeneratePaymentLink,
);
router.get("/commission/summary", protect, managerOnly, getCommissionSummary);

export default router;
