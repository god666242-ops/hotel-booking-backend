import * as Sentry from "@sentry/node";

/**
 * Dispatches critical system alerts across Sentry, Admin Email, and Webhook/Slack.
 */
export async function sendSystemAlert({
  type, // 'WEBHOOK_FAILURE' | 'PAYOUT_FAILURE' | 'STUCK_BOOKING' | 'EMAIL_FAILURE'
  title,
  message,
  metadata = {},
  severity = "error", // 'warning' | 'error' | 'critical'
}) {
  const timestamp = new Date().toISOString();
  console.error(`[SYSTEM ALERT - ${severity.toUpperCase()}][${type}] ${title}: ${message}`, metadata);

  // 1. Send to Sentry with enriched tags
  try {
    Sentry.withScope((scope) => {
      scope.setLevel(severity === "critical" ? "fatal" : severity);
      scope.setTag("alertType", type);
      if (metadata.hotelId) scope.setTag("hotelId", String(metadata.hotelId));
      if (metadata.bookingCode) scope.setTag("bookingCode", String(metadata.bookingCode));
      scope.setExtras(metadata);
      Sentry.captureMessage(`[${type}] ${title}: ${message}`);
    });
  } catch (sentryErr) {
    console.error("[SystemAlert] Sentry dispatch failed:", sentryErr.message);
  }

  // 2. Optional: Forward to Slack / Discord / Ops Webhook if configured
  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🚨 *[${severity.toUpperCase()}] ${title}*\n*Type:* \`${type}\`\n*Message:* ${message}\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\``,
        }),
      }).catch(() => {});
    } catch (_) {}
  }

  // 3. Optional: Dispatch Email to Platform Super Admin for Critical Incidents
  const superAdminEmail = process.env.SUPER_ADMIN_ALERT_EMAIL;
  if (superAdminEmail && (severity === "critical" || severity === "error") && process.env.RESEND_API_KEY) {
    try {
      const from = process.env.EMAIL_FROM || "alerts@resend.dev";
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [superAdminEmail],
          subject: `🚨 [Platform Alert] ${title}`,
          html: `<div style="font-family:sans-serif;padding:20px;background:#fef2f2;border-left:4px solid #ef4444;">
            <h2 style="color:#991b1b;margin-top:0;">${title}</h2>
            <p style="color:#374151;">${message}</p>
            <pre style="background:#fff;padding:12px;border:1px solid #fee2e2;border-radius:4px;font-size:12px;">${JSON.stringify(metadata, null, 2)}</pre>
            <small style="color:#6b7280;">Timestamp: ${timestamp}</small>
          </div>`,
        }),
      }).catch(() => {});
    } catch (_) {}
  }
}