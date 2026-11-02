// backend/src/jobs/processWeeklyCommission.js
import Hotel from "../models/Hotel.js";
import CommissionInvoice from "../models/CommissionInvoice.js";
import {
  getLastCompletedWeek,
  generateWeeklyInvoiceForHotel,
  processOverdueInvoices,
  retryMissingPaymentLinks,
} from "../services/commissionInvoice.service.js";
import { sendSystemAlert } from "../utils/systemAlerts.js";

let isRunning = false;
let lastBilledPeriodKey = null;

/**
 * One pass:
 *  1. Invoice every own-gateway hotel for the last completed week
 *     (skipped quickly once the week is done; the unique index also
 *     protects against two servers running at once).
 *  2. Retry payment links that failed to create.
 *  3. Send reminders and suspend hotels with long-overdue invoices.
 */
export async function runCommissionBilling(now = new Date()) {
  const { periodStart, periodEnd } = getLastCompletedWeek(now);
  const periodKey = periodStart.toISOString();

  if (lastBilledPeriodKey !== periodKey) {
    const hotels = await Hotel.find({ "paymentConfig.mode": "HOTEL_GATEWAY" })
      .select("name legal contact paymentConfig")
      .lean();

    const alreadyBilled = new Set(
      (await CommissionInvoice.distinct("hotelId", { periodStart })).map(String),
    );

    let failures = 0;
    for (const hotel of hotels) {
      if (alreadyBilled.has(String(hotel._id))) continue;
      try {
        await generateWeeklyInvoiceForHotel(hotel, { periodStart, periodEnd, now });
      } catch (err) {
        failures += 1;
        await sendSystemAlert({
          type: "COMMISSION_BILLING_FAILURE",
          title: "Weekly commission invoice failed",
          message: `Hotel ${hotel._id}: ${err.message}`,
          metadata: { hotelId: hotel._id, periodStart },
          severity: "error",
        });
      }
    }

    // Only stop re-checking this week once every hotel went through cleanly.
    if (failures === 0) lastBilledPeriodKey = periodKey;
  }

  await retryMissingPaymentLinks();
  await processOverdueInvoices(now);
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    await runCommissionBilling();
  } catch (err) {
    await sendSystemAlert({
      type: "COMMISSION_BILLING_FAILURE",
      title: "Commission scheduler crashed",
      message: err.message,
      metadata: { stack: err.stack },
      severity: "critical",
    });
  } finally {
    isRunning = false;
  }
}

/**
 * Runs hourly (and once ~30s after start, so a restart on Monday still bills).
 */
export function startCommissionScheduler(intervalMs = 60 * 60 * 1000) {
  console.log("[Scheduler] Weekly commission billing worker initialized.");
  const first = setTimeout(tick, 30 * 1000);
  first.unref?.();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}