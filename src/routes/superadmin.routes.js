import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { requireSuperAdmin } from "../middlewares/superAdmin.middleware.js";
import { authLimiter } from "../middlewares/rateLimiter.middleware.js";
import User from "../models/User.js";
import Hotel from "../models/Hotel.js";
import Booking from "../models/Booking.js";
import CommissionInvoice from "../models/CommissionInvoice.js";
import {
  getCommissionPercent,
  MODE_GATEWAY,
  MODE_PAY_AT_HOTEL,
} from "../services/commission.service.js";
import { settleInvoiceManually } from "../services/commissionInvoice.service.js";
import InventoryLog from "../models/InventoryLog.js";

const router = express.Router();

/**
 * Helper to parse pagination and sorting query parameters safely.
 */
function parsePagination(
  query,
  defaultSortField = "createdAt",
  defaultSortDir = -1,
) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const sortField = query.sortBy || defaultSortField;
  const sortDirection =
    query.sortDir === "asc" || query.sortDir === "1" ? 1 : -1;
  const sort = { [sortField]: sortDirection };

  return { page, limit, skip, sort };
}

/**
 * The commission % that applies to a hotel under its current payment mode:
 * 5% for own-gateway hotels, 8% for pay-at-hotel (both editable per hotel).
 */
function hotelCommissionPercent(hotel) {
  const mode =
    hotel?.paymentConfig?.mode === "HOTEL_GATEWAY"
      ? MODE_GATEWAY
      : MODE_PAY_AT_HOTEL;
  return getCommissionPercent(hotel, mode);
}

// ----------------------------------------------------
// 1. Super Admin Auth (Login & Profile)
// ----------------------------------------------------
router.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    const user = await User.findOne({
      email: email.toLowerCase().trim(),
      role: "SUPER_ADMIN",
    }).select("+password");

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res
        .status(401)
        .json({ message: "Invalid Super Admin credentials" });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "Account is deactivated" });
    }

    const token = jwt.sign(
      {
        userId: user._id,
        role: user.role,
        email: user.email,
        tv: user.tokenVersion ?? 0,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
    );

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Guard all subsequent endpoints with requireSuperAdmin
router.use(requireSuperAdmin);

router.get("/auth/me", (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

// ----------------------------------------------------
// 2. Metrics & Overview
// ----------------------------------------------------
// ----------------------------------------------------
// 3. Hotel Management
// ----------------------------------------------------
router.get("/hotels", async (req, res) => {
  try {
    const { status, search } = req.query;
    const { page, limit, skip, sort } = parsePagination(
      req.query,
      "createdAt",
      -1,
    );
    const filter = {};

    if (status) {
      if (status === "ACTIVE") filter.isActive = true;
      else if (status === "SUSPENDED") filter.isActive = false;
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search.trim(), $options: "i" } },
        { "address.city": { $regex: search.trim(), $options: "i" } },
      ];
    }

    const [hotels, total] = await Promise.all([
      Hotel.find(filter).sort(sort).skip(skip).limit(limit),
      Hotel.countDocuments(filter),
    ]);

    const formatted = hotels.map((h) => ({
      _id: h._id,
      id: h._id,
      name: h.name,
      city: h.address?.city || h.city || "—",
      status: h.isActive ? "ACTIVE" : "SUSPENDED",
      commissionPercent: hotelCommissionPercent(h),
      paymentMode: h.paymentConfig?.mode || "PAY_AT_HOTEL",
      createdAt: h.createdAt,
    }));

    return res.json({
      hotels: formatted,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.patch("/hotels/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const isActive = status === "ACTIVE";

    const hotel = await Hotel.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true },
    );
    if (!hotel) return res.status(404).json({ message: "Hotel not found" });

    return res.json({
      success: true,
      status: hotel.isActive ? "ACTIVE" : "SUSPENDED",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.patch("/hotels/:id/commission", async (req, res) => {
  try {
    const pct = Number(req.body.commissionPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res
        .status(400)
        .json({ message: "Commission must be a number between 0 and 100" });
    }

    const existing = await Hotel.findById(req.params.id).select(
      "paymentConfig.mode",
    );
    if (!existing) return res.status(404).json({ message: "Hotel not found" });

    // Sets the percentage for the hotel's CURRENT mode only.
    const field =
      existing.paymentConfig?.mode === "HOTEL_GATEWAY"
        ? "paymentConfig.gatewayCommissionPercent"
        : "paymentConfig.payAtHotelCommissionPercent";

    const hotel = await Hotel.findByIdAndUpdate(
      req.params.id,
      { [field]: pct },
      { new: true },
    );

    return res.json({
      success: true,
      commissionPercent: hotelCommissionPercent(hotel),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/hotels/:id/audit-logs", async (req, res) => {
  try {
    const { page, limit, skip, sort } = parsePagination(
      req.query,
      "createdAt",
      -1,
    );
    const filter = { hotelId: req.params.id };

    const [logs, total] = await Promise.all([
      InventoryLog.find(filter).sort(sort).skip(skip).limit(limit),
      InventoryLog.countDocuments(filter),
    ]);

    const formatted = logs.map((l) => ({
      _id: l._id,
      createdAt: l.createdAt,
      actor: l.updatedBy?.email || "Hotel Admin",
      action: `${l.actionType} on "${l.roomName}" (${l.daysCount} day${l.daysCount === 1 ? "" : "s"})`,
    }));

    return res.json({
      logs: formatted,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ----------------------------------------------------
// 4. Bookings Management
// ----------------------------------------------------
router.get("/bookings", async (req, res) => {
  try {
    const { paymentId, from, to, status, search } = req.query;
    const { page, limit, skip, sort } = parsePagination(
      req.query,
      "createdAt",
      -1,
    );
    const filter = {};

    if (paymentId) {
      filter["payment.razorpayPaymentId"] = {
        $regex: paymentId.trim(),
        $options: "i",
      };
    }

    if (status) {
      filter.status = status.toUpperCase();
    }

    if (search) {
      filter.$or = [
        { bookingCode: { $regex: search.trim(), $options: "i" } },
        { "guest.name": { $regex: search.trim(), $options: "i" } },
        { "guest.email": { $regex: search.trim(), $options: "i" } },
        { "guest.phone": { $regex: search.trim(), $options: "i" } },
      ];
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        filter.createdAt.$lte = new Date(
          new Date(to).setUTCHours(23, 59, 59, 999),
        );
      }
    }

    const [bookings, total] = await Promise.all([
      Booking.find(filter)
        .populate("hotelId", "name")
        .sort(sort)
        .skip(skip)
        .limit(limit),
      Booking.countDocuments(filter),
    ]);

    const formatted = bookings.map((b) => ({
      _id: b._id,
      id: b._id,
      reference: b.bookingCode,
      hotelName: b.hotelId?.name || "Unknown Hotel",
      guestName: b.guest?.name || "Guest",
      amount: b.billing?.grandTotal || 0,
      paymentMode: b.payment?.mode || null,
      collectedOnline:
        b.payment?.mode === "PAY_AT_HOTEL"
          ? Number(b.payment?.amountPayableNow) || 0
          : b.billing?.grandTotal || 0,
      razorpayPaymentId: b.payment?.razorpayPaymentId || "—",
      status: b.status.toLowerCase(),
      createdAt: b.createdAt,
    }));

    return res.json({
      bookings: formatted,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ----------------------------------------------------
// 5. Commission Invoices
// ----------------------------------------------------
router.get("/commission-invoices", async (req, res) => {
  try {
    const { status } = req.query;
    const { page, limit, skip, sort } = parsePagination(
      req.query,
      "createdAt",
      -1,
    );
    const filter = {};
    if (status) filter.status = String(status).toUpperCase();

    const [rows, total] = await Promise.all([
      CommissionInvoice.find(filter)
        .select("-lines")
        .populate("hotelId", "name")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      CommissionInvoice.countDocuments(filter),
    ]);

    const invoices = rows.map((i) => ({
      _id: i._id,
      id: i._id,
      createdAt: i.createdAt,
      hotelName: i.hotelId?.name || "Unknown Property",
      invoiceNumber: i.invoiceNumber,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      bookingCount: i.bookingCount,
      commissionAmount: i.commissionAmount,
      gstAmount: i.gstAmount,
      totalDue: i.totalDue,
      status: i.status,
      dueDate: i.dueDate,
      paidAt: i.paidAt,
      paymentLinkUrl: i.paymentLinkUrl,
      suspendedHotel: i.suspendedHotel,
    }));

    return res.json({
      invoices,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Mark an invoice as paid outside Razorpay (bank transfer, cash).
router.post("/commission-invoices/:id/mark-paid", async (req, res) => {
  try {
    const reference =
      typeof req.body?.reference === "string" && req.body.reference.trim()
        ? req.body.reference.trim()
        : "MANUAL";
    const invoice = await settleInvoiceManually(req.params.id, {
      status: "PAID",
      reference,
    });
    if (!invoice) {
      return res.status(409).json({
        message: "Invoice not found, or it is already paid or waived.",
      });
    }
    return res.json({ success: true, status: invoice.status });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Waive an invoice (you decide the hotel owes nothing for that week).
router.post("/commission-invoices/:id/waive", async (req, res) => {
  try {
    const invoice = await settleInvoiceManually(req.params.id, {
      status: "WAIVED",
    });
    if (!invoice) {
      return res.status(409).json({
        message: "Invoice not found, or it is already paid or waived.",
      });
    }
    return res.json({ success: true, status: invoice.status });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ----------------------------------------------------
// 6. Platform Audit Logs
// ----------------------------------------------------
router.get("/audit-logs", async (req, res) => {
  try {
    const { page, limit, skip, sort } = parsePagination(
      req.query,
      "createdAt",
      -1,
    );

    const [logs, total] = await Promise.all([
      InventoryLog.find()
        .populate("hotelId", "name")
        .sort(sort)
        .skip(skip)
        .limit(limit),
      InventoryLog.countDocuments(),
    ]);

    const formatted = logs.map((l) => ({
      _id: l._id,
      createdAt: l.createdAt,
      actor: l.updatedBy?.email || "System",
      target: l.hotelId?.name || "Platform",
      action: `${l.actionType} on "${l.roomName}" (${l.daysCount} day${l.daysCount === 1 ? "" : "s"})`,
    }));

    return res.json({
      logs: formatted,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/metrics/overview", async (req, res) => {
  try {
    const liveStatuses = ["CONFIRMED", "CHECKED_IN", "COMPLETED"];
    const onlineOnly = [{ source: "ONLINE" }, { source: { $exists: false } }];

    const [
      totalBookingsCount,
      gmvAggregate,
      activeHotelsCount,
      pendingHotelsCount,
      overdueInvoicesCount,
      outstandingAggregate,
      gatewayFeesAggregate,
      payAtHotelFeesAggregate,
    ] = await Promise.all([
      Booking.countDocuments({
        status: { $in: liveStatuses },
        $or: onlineOnly,
      }),
      Booking.aggregate([
        { $match: { status: { $in: liveStatuses }, $or: onlineOnly } },
        {
          $group: {
            _id: null,
            totalGMV: { $sum: "$billing.grandTotal" },
            totalCollected: {
              $sum: {
                $cond: [
                  { $eq: ["$payment.mode", "PAY_AT_HOTEL"] },
                  { $ifNull: ["$payment.amountPayableNow", 0] },
                  "$billing.grandTotal",
                ],
              },
            },
          },
        },
      ]),
      Hotel.countDocuments({ isActive: true }),
      Hotel.countDocuments({ isActive: false }),
      CommissionInvoice.countDocuments({ status: "OVERDUE" }),
      CommissionInvoice.aggregate([
        { $match: { status: { $in: ["PENDING", "OVERDUE"] } } },
        { $group: { _id: null, total: { $sum: "$totalDue" } } },
      ]),
      // Commission already collected from own-gateway hotels
      CommissionInvoice.aggregate([
        { $match: { status: "PAID" } },
        { $group: { _id: null, total: { $sum: "$commissionAmount" } } },
      ]),
      // Commission collected upfront on pay-at-hotel bookings, net of refunds
      Booking.aggregate([
        {
          $match: {
            "payment.mode": "PAY_AT_HOTEL",
            "commission.status": "PAID",
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $subtract: [
                  "$commission.amount",
                  { $ifNull: ["$cancellation.amountRefunded", 0] },
                ],
              },
            },
          },
        },
      ]),
    ]);

    const platformFees =
      (gatewayFeesAggregate[0]?.total || 0) +
      (payAtHotelFeesAggregate[0]?.total || 0);

    return res.json({
      gmv: gmvAggregate[0]?.totalGMV || 0,
      collectedOnline: gmvAggregate[0]?.totalCollected || 0,
      totalBookings: totalBookingsCount || 0,
      activeHotels: activeHotelsCount || 0,
      pendingHotels: pendingHotelsCount || 0,
      failedPayouts: 0, // legacy key; the old dashboard card is replaced in Stage 4
      overdueInvoices: overdueInvoicesCount || 0,
      outstandingCommission:
        Math.round((outstandingAggregate[0]?.total || 0) * 100) / 100,
      platformFees: Math.round(platformFees * 100) / 100,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/hotels/:id", async (req, res) => {
  try {
    const hotel = await Hotel.findById(req.params.id);
    if (!hotel) return res.status(404).json({ message: "Hotel not found" });

    return res.json({
      hotel: {
        _id: hotel._id,
        id: hotel._id,
        name: hotel.name,
        slug: hotel.slug,
        email: hotel.contact?.email || "",
        phone: hotel.contact?.phone || "",
        city: hotel.address?.city || hotel.city || "—",
        status: hotel.isActive ? "ACTIVE" : "SUSPENDED",
        commissionPercent: hotelCommissionPercent(hotel),
        paymentMode: hotel.paymentConfig?.mode || "PAY_AT_HOTEL",
        createdAt: hotel.createdAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

export default router;
