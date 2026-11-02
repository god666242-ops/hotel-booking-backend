// backend/src/controllers/hotelier/commission.controller.js
import mongoose from "mongoose";
import CommissionInvoice from "../../models/CommissionInvoice.js";
import Hotel from "../../models/Hotel.js";
import Booking from "../../models/Booking.js";
import { ensurePaymentLink } from "../../services/commissionInvoice.service.js";
import {
  getCommissionPercent,
  MODE_GATEWAY,
  MODE_PAY_AT_HOTEL,
} from "../../services/commission.service.js";

const STATUSES = ["PENDING", "OVERDUE", "PAID", "WAIVED", "CANCELLED"];

/**
 * GET /api/v1/admin/commission/invoices?page=&limit=&status=
 */
export async function listCommissionInvoices(req, res, next) {
  try {
    const hotelId = new mongoose.Types.ObjectId(String(req.user.hotelId));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit, 10) || 20),
    );

    const filter = { hotelId };
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;

    const [rows, total, totals] = await Promise.all([
      CommissionInvoice.find(filter)
        .select("-lines")
        .sort({ periodStart: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CommissionInvoice.countDocuments(filter),
      CommissionInvoice.aggregate([
        { $match: { hotelId } },
        {
          $group: {
            _id: "$status",
            amount: { $sum: "$totalDue" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const summary = { outstanding: 0, paid: 0, outstandingCount: 0 };
    for (const t of totals) {
      if (t._id === "PENDING" || t._id === "OVERDUE") {
        summary.outstanding += t.amount;
        summary.outstandingCount += t.count;
      } else if (t._id === "PAID") {
        summary.paid += t.amount;
      }
    }

    return res.status(200).json({
      success: true,
      data: { invoices: rows, total, page, limit, summary },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/admin/commission/invoices/:id  (includes booking lines)
 */
export async function getCommissionInvoice(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid invoice id." });
    }
    const invoice = await CommissionInvoice.findOne({
      _id: req.params.id,
      hotelId: req.user.hotelId,
    }).lean();

    if (!invoice) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found." });
    }
    return res.status(200).json({ success: true, data: invoice });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/admin/commission/invoices/:id/payment-link
 * Creates a fresh payment link (for example when the old one expired).
 */
export async function regeneratePaymentLink(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid invoice id." });
    }
    const invoice = await CommissionInvoice.findOne({
      _id: req.params.id,
      hotelId: req.user.hotelId,
    });
    if (!invoice) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found." });
    }
    if (!["PENDING", "OVERDUE"].includes(invoice.status)) {
      return res.status(400).json({
        success: false,
        message: `A ${invoice.status} invoice has nothing left to pay.`,
      });
    }

    const hotel = await Hotel.findById(req.user.hotelId)
      .select("name legal contact")
      .lean();
    await ensurePaymentLink(invoice, hotel, { force: true });

    if (!invoice.paymentLinkUrl) {
      return res.status(502).json({
        success: false,
        message:
          "Could not create a payment link right now. Please try again shortly.",
      });
    }
    return res.status(200).json({
      success: true,
      data: { paymentLinkUrl: invoice.paymentLinkUrl },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/admin/commission/summary
 * Numbers for the Commission page and the dashboard revenue card.
 */
export async function getCommissionSummary(req, res, next) {
  try {
    const hotelId = new mongoose.Types.ObjectId(String(req.user.hotelId));
    const live = ["CONFIRMED", "CHECKED_IN", "COMPLETED"];
    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    const [hotel, gross, invoiceTotals, unbilled, feesCollected, upcoming] =
      await Promise.all([
        Hotel.findById(hotelId)
          .select(
            "paymentConfig.mode paymentConfig.gatewayCommissionPercent paymentConfig.payAtHotelCommissionPercent",
          )
          .lean(),
        Booking.aggregate([
          { $match: { hotelId, status: { $in: live } } },
          {
            $group: {
              _id: null,
              total: { $sum: "$billing.grandTotal" },
              count: { $sum: 1 },
            },
          },
        ]),
        CommissionInvoice.aggregate([
          { $match: { hotelId } },
          {
            $group: {
              _id: "$status",
              amount: { $sum: "$totalDue" },
              count: { $sum: 1 },
            },
          },
        ]),
        // Own-gateway stays not yet on an invoice (estimate, before refunds)
        Booking.aggregate([
          {
            $match: {
              hotelId,
              "payment.mode": MODE_GATEWAY,
              "commission.billedAt": null,
              status: { $in: live },
              "payment.status": { $in: ["PAID", "PARTIAL"] },
            },
          },
          {
            $group: {
              _id: null,
              base: {
                $sum: {
                  $add: [
                    { $ifNull: ["$billing.roomBaseTariff", 0] },
                    { $ifNull: ["$billing.addOnsTotal", 0] },
                  ],
                },
              },
              count: { $sum: 1 },
            },
          },
        ]),
        // Pay-at-hotel booking fees kept by the platform, net of refunds
        Booking.aggregate([
          {
            $match: {
              hotelId,
              "payment.mode": MODE_PAY_AT_HOTEL,
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
        // Balance the front desk still has to collect
        Booking.aggregate([
          {
            $match: {
              hotelId,
              "payment.mode": MODE_PAY_AT_HOTEL,
              status: "CONFIRMED",
              "dates.checkOut": { $gte: todayUtc },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$payment.amountDueAtHotel" },
              count: { $sum: 1 },
            },
          },
        ]),
      ]);

    const by = Object.fromEntries(invoiceTotals.map((t) => [t._id, t]));
    const gatewayPercent = getCommissionPercent(hotel, MODE_GATEWAY);

    return res.status(200).json({
      success: true,
      data: {
        mode:
          hotel?.paymentConfig?.mode === "HOTEL_GATEWAY"
            ? "HOTEL_GATEWAY"
            : "PAY_AT_HOTEL",
        gatewayPercent,
        payAtHotelPercent: getCommissionPercent(hotel, MODE_PAY_AT_HOTEL),
        grossBookingValue: r2(gross[0]?.total),
        liveBookings: gross[0]?.count || 0,
        gateway: {
          outstanding: r2(
            (by.PENDING?.amount || 0) + (by.OVERDUE?.amount || 0),
          ),
          outstandingCount: (by.PENDING?.count || 0) + (by.OVERDUE?.count || 0),
          overdueCount: by.OVERDUE?.count || 0,
          paid: r2(by.PAID?.amount),
          unbilledEstimate: r2(
            ((unbilled[0]?.base || 0) * gatewayPercent) / 100,
          ),
          unbilledBookings: unbilled[0]?.count || 0,
        },
        payAtHotel: {
          feesCollected: r2(feesCollected[0]?.total),
          upcomingDueAtHotel: r2(upcoming[0]?.total),
          upcomingBookings: upcoming[0]?.count || 0,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}
