import crypto from "crypto";
import Booking from "../../models/Booking.js";
import Hotel from "../../models/Hotel.js";
import { decryptSecret } from "../../services/crypto.service.js";
import { confirmPaidBooking } from "../../services/paymentConfirmation.service.js";
import { sendSystemAlert } from "../../utils/systemAlerts.js";
import { markInvoicePaidFromLink } from "../../services/commissionInvoice.service.js";

/**
 * Timing-safe string comparison to prevent side-channel timing attacks
 */
function isSignatureValidTimingSafe(receivedSignature, expectedSignature) {
  if (!receivedSignature || !expectedSignature) return false;
  const receivedBuf = Buffer.from(String(receivedSignature), "utf8");
  const expectedBuf = Buffer.from(String(expectedSignature), "utf8");

  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

function hmacHex(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * POST /api/v1/webhooks/razorpay
 * Verifies signature, confirms booking, and alerts admins if failures occur.
 */
export async function handleRazorpayWebhook(req, res, next) {
  try {
    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      await sendSystemAlert({
        type: "WEBHOOK_FAILURE",
        title: "Missing Razorpay Webhook Signature",
        message: "Webhook arrived without x-razorpay-signature header.",
        severity: "warning",
      });
      return res
        .status(400)
        .json({ success: false, message: "Missing signature header." });
    }

    const event = req.body || {};
    const paymentEntity = event.payload?.payment?.entity;
    const orderId = paymentEntity?.order_id || event.payload?.order?.entity?.id;
    const paymentId = paymentEntity?.id;

    const rawBodyBuffer = req.rawBody
      ? req.rawBody
      : Buffer.from(
          typeof req.body === "string" ? req.body : JSON.stringify(req.body),
          "utf8",
        );

    // 1. Platform (master) webhook secret
    let isSignatureValid = false;
    const masterSecret = process.env.MASTER_RAZORPAY_WEBHOOK_SECRET;
    if (masterSecret) {
      isSignatureValid = isSignatureValidTimingSafe(
        signature,
        hmacHex(masterSecret, rawBodyBuffer),
      );
    }

    // 1b. A hotel paid its weekly commission invoice through a payment link.
    //     These come from YOUR Razorpay account, so only the master secret applies.
    if (event.event === "payment_link.paid") {
      if (!isSignatureValid) {
        await sendSystemAlert({
          type: "WEBHOOK_FAILURE",
          title: "Invalid Signature On Payment Link Webhook",
          message: "payment_link.paid failed the master HMAC signature check.",
          severity: "warning",
        });
        return res
          .status(400)
          .json({ success: false, message: "Invalid webhook signature." });
      }
      try {
        await markInvoicePaidFromLink({
          paymentLinkId: event.payload?.payment_link?.entity?.id,
          paymentId: paymentEntity?.id,
          amountPaise:
            paymentEntity?.amount ??
            event.payload?.payment_link?.entity?.amount_paid,
        });
      } catch (err) {
        await sendSystemAlert({
          type: "WEBHOOK_FAILURE",
          title: "Commission Payment Handling Failed",
          message: err.message,
          severity: "critical",
        });
        throw err; // 5xx so Razorpay retries
      }
      return res.status(200).json({ received: true });
    }

    // 2. Nothing to act on without an order id
    if (!orderId) {
      if (!isSignatureValid) {
        await sendSystemAlert({
          type: "WEBHOOK_FAILURE",
          title: "Invalid Webhook Signature (No Order ID)",
          message:
            "Incoming webhook failed HMAC signature check and carried no order ID.",
          severity: "warning",
        });
        return res
          .status(400)
          .json({ success: false, message: "Invalid webhook signature." });
      }
      return res.status(200).json({ received: true });
    }

    // 3. Locate the booking for this order
    const booking = await Booking.findOne({
      "payment.razorpayOrderId": orderId,
    });

    if (!booking) {
      if (!isSignatureValid) {
        await sendSystemAlert({
          type: "WEBHOOK_FAILURE",
          title: "Unmatched Order & Invalid Signature",
          message: `Webhook order ${orderId} has no matching booking and signature was invalid.`,
          metadata: { orderId, paymentId },
          severity: "warning",
        });
        return res
          .status(400)
          .json({ success: false, message: "Invalid webhook signature." });
      }
      return res.status(200).json({ received: true });
    }

    // 4. Hotel's own webhook secret (BYO gateway)
    if (!isSignatureValid) {
      const hotel = await Hotel.findById(booking.hotelId);
      const encryptedSecret =
        hotel?.paymentConfig?.hotelRazorpay?.webhookSecretEncrypted;

      if (booking.payment?.mode === "HOTEL_GATEWAY" && encryptedSecret) {
        let hotelWebhookSecret = null;
        try {
          hotelWebhookSecret = decryptSecret(encryptedSecret);
        } catch (err) {
          await sendSystemAlert({
            type: "WEBHOOK_FAILURE",
            title: "Hotel Webhook Secret Decryption Failed",
            message: `Could not decrypt webhook secret for hotel ${hotel.slug || hotel._id}`,
            metadata: {
              hotelId: hotel._id,
              bookingCode: booking.bookingCode,
              error: err.message,
            },
            severity: "critical",
          });
        }
        if (hotelWebhookSecret) {
          isSignatureValid = isSignatureValidTimingSafe(
            signature,
            hmacHex(hotelWebhookSecret, rawBodyBuffer),
          );
        }
      }
    }

    if (!isSignatureValid) {
      await sendSystemAlert({
        type: "WEBHOOK_FAILURE",
        title: "Webhook Signature Validation Failed",
        message: `Webhook signature mismatch for booking ${booking.bookingCode}`,
        metadata: {
          bookingCode: booking.bookingCode,
          orderId,
          paymentId,
          hotelId: booking.hotelId,
        },
        severity: "error",
      });
      return res
        .status(400)
        .json({ success: false, message: "Invalid webhook signature." });
    }

    // 5. Handle the event
    switch (event.event) {
      case "payment.captured":
      case "order.paid":
        try {
          await confirmPaidBooking({ booking, paymentId, signature });
        } catch (confirmErr) {
          await sendSystemAlert({
            type: "WEBHOOK_FAILURE",
            title: "Payment Confirmation Crashed",
            message: `confirmPaidBooking failed for booking ${booking.bookingCode}: ${confirmErr.message}`,
            metadata: {
              bookingCode: booking.bookingCode,
              orderId,
              paymentId,
              error: confirmErr.message,
            },
            severity: "critical",
          });
          throw confirmErr;
        }
        break;

      case "payment.failed":
        await Booking.updateOne(
          {
            _id: booking._id,
            status: "HELD",
            "payment.status": "PENDING",
          },
          { $set: { "payment.status": "FAILED" } },
        );
        break;
            case "refund.processed": {
        // Refunds made in the hotel's own Razorpay dashboard land here.
        // Keep amountRefunded accurate so weekly commission is calculated correctly.
        const refundedPaise = Number(paymentEntity?.amount_refunded || 0);
        const paidPaise = Number(paymentEntity?.amount || 0);
        const refundedRupees = refundedPaise / 100;

        if (refundedRupees > Number(booking.cancellation?.amountRefunded || 0)) {
          const update = { "cancellation.amountRefunded": refundedRupees };
          if (paidPaise > 0 && refundedPaise >= paidPaise) {
            update["payment.status"] = "REFUNDED";
          }
          // Refunded outside our cancel flow: flag it so someone reviews the booking.
          if (!["CANCELLED", "CANCELLATION_IN_PROGRESS"].includes(booking.status)) {
            update["reconciliation.needsManualReview"] = true;
          }
          await Booking.updateOne({ _id: booking._id }, { $set: update });
        }
        break;
      }
      
      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    next(error);
  }
}
