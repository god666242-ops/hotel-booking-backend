/**
 * notification.service.js
 * Outbound guest vouchers, front-desk alerts, registration OTPs,
 * Guest Lifecycle Automated Emails (#3), and Abandoned Hold Recovery (#4) using Resend.
 * Email templates are table-based with inline styles for Gmail/Outlook/Apple Mail support.
 */

import { sendSystemAlert } from "../utils/systemAlerts.js";

/* ========================================================================== */
/*                                   Helpers                                  */
/* ========================================================================== */

const formatINR = (val) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    val || 0,
  );

/** Escape user-supplied values before injecting into HTML. */
const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;

function getManageBookingUrl(hotelSlug, bookingCode, email) {
  const baseUrl =
    process.env.CLIENT_BASE_URL ||
    process.env.FRONTEND_URL ||
    "http://localhost:3000";
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const encodedEmail = encodeURIComponent(email);
  return `${cleanBase}/manage-booking?hotel=${hotelSlug}&code=${bookingCode}&email=${encodedEmail}`;
}

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const fmtDay = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit" });
const fmtMonthYear = (d) =>
  new Date(d)
    .toLocaleDateString("en-IN", { month: "short", year: "numeric" })
    .toUpperCase();
const fmtWeekday = (d) =>
  new Date(d).toLocaleDateString("en-IN", { weekday: "long" });

/* ========================================================================== */
/*                            Design tokens + layout                          */
/* ========================================================================== */

const T = {
  bg: "#f4efe8", // warm ivory page
  card: "#ffffff",
  ink: "#1c1b1a",
  muted: "#7a746c",
  line: "#e9e2d8",
  soft: "#faf7f2",
  gold: "#b08d57",
  goldDark: "#8f6f3e",
  dark: "#0F172A",
  success: "#2f7d5b",
  danger: "#9b2c2c",
  dangerSoft: "#fbf1f0",
  serif: "Georgia, 'Times New Roman', serif",
  sans: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
};

function button(url, label, { bg = T.dark, color = "#ffffff" } = {}) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
      <tr>
        <td align="center" bgcolor="${bg}" style="border-radius:2px;">
          <a href="${esc(url)}" target="_blank"
             style="display:inline-block;padding:15px 34px;font-family:${T.sans};font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${color};text-decoration:none;border-radius:2px;">
            ${esc(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

function detailRow(label, value, { bold = false } = {}) {
  return `
    <tr>
      <td style="padding:11px 0;border-bottom:1px solid ${T.line};font-family:${T.sans};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${T.muted};width:38%;vertical-align:top;">${esc(label)}</td>
      <td style="padding:11px 0;border-bottom:1px solid ${T.line};font-family:${T.sans};font-size:14px;color:${T.ink};${bold ? "font-weight:600;" : ""}vertical-align:top;">${value}</td>
    </tr>`;
}

/**
 * Shared shell: preheader, branded header, body slot, footer.
 */
function layout({ preheader = "", hotelName, eyebrow, body, footer = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>${esc(hotelName)}</title>
  <style>
    @media only screen and (max-width:620px) {
      .container { width:100% !important; }
      .px { padding-left:22px !important; padding-right:22px !important; }
      .stack { display:block !important; width:100% !important; }
      .stack-gap { padding-top:12px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${T.bg};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.bg}">
    <tr>
      <td align="center" style="padding:32px 12px;">

        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

          <!-- Brand header -->
          <tr>
            <td align="center" bgcolor="${T.dark}" style="padding:34px 24px 30px;border-radius:4px 4px 0 0;">
              <div style="font-family:${T.sans};font-size:10px;letter-spacing:4px;text-transform:uppercase;color:${T.gold};">${esc(eyebrow)}</div>
              <div style="font-family:${T.serif};font-size:26px;line-height:32px;color:#ffffff;margin-top:10px;letter-spacing:1px;">${esc(hotelName)}</div>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:16px;">
                <tr><td width="44" height="1" style="background:${T.gold};font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="px" bgcolor="${T.card}" style="padding:40px 44px 36px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="px" bgcolor="${T.soft}" style="padding:26px 44px;border-top:1px solid ${T.line};border-radius:0 0 4px 4px;">
              ${footer}
            </td>
          </tr>
        </table>

        <div style="font-family:${T.sans};font-size:11px;color:${T.muted};margin-top:18px;letter-spacing:.3px;">
          This is an automated message regarding your direct booking platform account.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function hotelFooter({ hotelName, hotelAddress, hotelPhone }) {
  const address = (hotelAddress || "").replace(/^[,\s]+|[,\s]+$/g, "");
  return `
    <div style="font-family:${T.serif};font-size:15px;color:${T.ink};margin-bottom:8px;">${esc(hotelName)}</div>
    ${address ? `<div style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};">${esc(address)}</div>` : ""}
    ${
      hotelPhone
        ? `<div style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};margin-top:4px;">
             Reservations desk: <a href="tel:${esc(hotelPhone)}" style="color:${T.goldDark};text-decoration:none;">${esc(hotelPhone)}</a>
           </div>`
        : ""
    }`;
}

/** Calendar-style date block used for check-in / check-out. */
function dateBlock(label, date) {
  return `
    <div style="font-family:${T.sans};font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:${T.gold};">${label}</div>
    <div style="font-family:${T.serif};font-size:34px;line-height:40px;color:${T.ink};margin-top:6px;">${fmtDay(date)}</div>
    <div style="font-family:${T.sans};font-size:11px;letter-spacing:1.5px;color:${T.muted};margin-top:2px;">${fmtMonthYear(date)}</div>
    <div style="font-family:${T.sans};font-size:12px;color:${T.muted};margin-top:2px;">${fmtWeekday(date)}</div>`;
}

/* ========================================================================== */
/*                   Phase 3: Guest Lifecycle Automated Emails (#3)            */
/* ========================================================================== */

/**
 * 1. Pre-Arrival Stay Guide & Check-In Details (~24–48 hours prior)
 */
export async function sendPreArrivalGuideEmail({ booking, hotel, roomType }) {
  if (!booking?.guest?.email || !process.env.RESEND_API_KEY)
    return { success: false };

  const manageUrl = getManageBookingUrl(
    hotel.slug,
    booking.bookingCode,
    booking.guest.email,
  );
  const hotelAddress = `${hotel.address?.street || ""}, ${hotel.address?.city || ""}`;
  const checkInTime = hotel.checkInTime || "12:00 PM";

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding-bottom:18px;">
          <span style="display:inline-block;padding:7px 16px;border:1px solid ${T.gold};border-radius:30px;font-family:${T.sans};font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:${T.goldDark};">
            Upcoming Stay
          </span>
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${T.serif};font-size:28px;line-height:36px;color:${T.ink};">
          Your stay begins soon
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:12px 0 26px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
          Dear ${esc(booking.guest.name)}, we are preparing for your arrival at <strong style="color:${T.ink};">${esc(hotel.name)}</strong> on ${esc(fmtDate(booking.dates.checkIn))}. Here is everything you need for a seamless arrival.
        </td>
      </tr>

      <!-- Dates Block -->
      <tr>
        <td bgcolor="${T.soft}" style="padding:22px;border:1px solid ${T.line};border-radius:2px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${detailRow("Check-In Time", `From ${esc(checkInTime)}`, { bold: true })}
            ${detailRow("Room Reserved", `${esc(roomType?.name || "Standard Room")} &middot; ${plural(booking.roomCount || 1, "room")}`)}
            ${detailRow("Property Address", esc(hotelAddress))}
            ${hotel.contact?.phone ? detailRow("Front Desk", `<a href="tel:${esc(hotel.contact.phone)}" style="color:${T.goldDark};text-decoration:none;">${esc(hotel.contact.phone)}</a>`) : ""}
          </table>
        </td>
      </tr>

      <!-- Key Checklist -->
      <tr>
        <td style="padding:26px 0 20px;">
          <div style="font-family:${T.sans};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${T.goldDark};font-weight:bold;margin-bottom:8px;">Arrival Checklist:</div>
          <ul style="margin:0;padding-left:18px;font-family:${T.sans};font-size:13px;line-height:22px;color:${T.ink};">
            <li>Please carry valid government-issued photo identification for all adult guests.</li>
            <li>Early check-in requests are prioritized for direct guests, subject to availability.</li>
            ${hotel.helpfulFacts?.petFriendly ? "<li>This property is pet-friendly.</li>" : ""}
          </ul>
        </td>
      </tr>

      <tr>
        <td align="center" style="padding:20px 0 10px;">
          ${button(manageUrl, "View Voucher & Directions")}
        </td>
      </tr>
    </table>`;

  return sendViaResend({
    to: booking.guest.email,
    subject: `Getting Ready for Your Stay at ${hotel.name} - #${booking.bookingCode}`,
    html: layout({
      preheader: `Check-in is on ${fmtDate(booking.dates.checkIn)}. See address, check-in instructions, and your voucher.`,
      hotelName: hotel.name,
      eyebrow: "Pre-Arrival Guide",
      body,
      footer: hotelFooter({
        hotelName: hotel.name,
        hotelAddress,
        hotelPhone: hotel.contact?.phone,
      }),
    }),
    text: `Your stay at ${hotel.name} starts on ${fmtDate(booking.dates.checkIn)}. Check-in from ${checkInTime}. Address: ${hotelAddress}. View voucher: ${manageUrl}`,
  });
}

/**
 * 2. Welcome Check-In Email (Sent when guest checks in)
 */
export async function sendWelcomeCheckInEmail({ booking, hotel }) {
  if (!booking?.guest?.email || !process.env.RESEND_API_KEY)
    return { success: false };

  const hotelAddress = `${hotel.address?.street || ""}, ${hotel.address?.city || ""}`;

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding-bottom:18px;">
          <span style="display:inline-block;padding:7px 16px;border:1px solid ${T.success};border-radius:30px;font-family:${T.sans};font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:${T.success};">
            Welcome
          </span>
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${T.serif};font-size:28px;line-height:36px;color:${T.ink};">
          Welcome to ${esc(hotel.name)}
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:14px 0 24px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
          Dear ${esc(booking.guest.name)}, we are delighted to have you stay with us.<br>
          Our team is dedicated to making your visit comfortable and memorable.
        </td>
      </tr>

      <tr>
        <td bgcolor="${T.soft}" style="padding:22px 24px;border-radius:2px;border:1px solid ${T.line};">
          <div style="font-family:${T.sans};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${T.goldDark};font-weight:600;margin-bottom:8px;">At Your Service:</div>
          <p style="font-family:${T.sans};font-size:13px;line-height:22px;color:${T.ink};margin:0 0 10px;">
            If you need anything during your stay — from extra towels to local recommendations — dial the front desk from your room phone${hotel.contact?.phone ? ` or call us directly at <strong>${esc(hotel.contact.phone)}</strong>` : ""}.
          </p>
          <div style="font-family:${T.sans};font-size:12px;color:${T.muted};">
            Standard check-out is by <strong>${esc(hotel.checkOutTime || "11:00 AM")}</strong> on <strong>${esc(fmtDate(booking.dates.checkOut))}</strong>.
          </div>
        </td>
      </tr>
    </table>`;

  return sendViaResend({
    to: booking.guest.email,
    subject: `Welcome to ${hotel.name}! Have a Wonderful Stay`,
    html: layout({
      preheader: `Welcome to ${hotel.name}! Front desk and stay amenities are at your service.`,
      hotelName: hotel.name,
      eyebrow: "Welcome to your stay",
      body,
      footer: hotelFooter({
        hotelName: hotel.name,
        hotelAddress,
        hotelPhone: hotel.contact?.phone,
      }),
    }),
    text: `Welcome to ${hotel.name}! We hope you enjoy your stay. Need anything? Contact front desk at ${hotel.contact?.phone || "reception"}.`,
  });
}

/**
 * 3. Post-Departure Thank You & Direct Feedback / Review Solicitation (~24 hrs post check-out)
 */
export async function sendPostStayReviewEmail({
  booking,
  hotel,
  promoCode = null,
}) {
  if (!booking?.guest?.email || !process.env.RESEND_API_KEY)
    return { success: false };

  const hotelAddress = `${hotel.address?.street || ""}, ${hotel.address?.city || ""}`;
  const directBookingSite =
    process.env.CLIENT_BASE_URL || "https://purebook.in";

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="font-family:${T.serif};font-size:28px;line-height:36px;color:${T.ink};">
          Thank you for staying with us
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:14px 0 24px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
          Dear ${esc(booking.guest.name)}, thank you for choosing <strong style="color:${T.ink};">${esc(hotel.name)}</strong>.<br>
          We hope you had a restful stay and a safe journey home.
        </td>
      </tr>

      ${
        promoCode
          ? `
        <!-- Direct Guest Loyalty Offer -->
        <tr>
          <td align="center" bgcolor="${T.soft}" style="padding:22px;border:1px dashed ${T.gold};border-radius:2px;margin-bottom:20px;">
            <div style="font-family:${T.sans};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${T.goldDark};font-weight:600;">
              Exclusive Return Guest Perk
            </div>
            <div style="font-family:${T.serif};font-size:20px;color:${T.ink};margin:8px 0 4px;">
              Enjoy a special discount on your next visit
            </div>
            <div style="font-family:'Courier New',monospace;font-size:22px;font-weight:bold;letter-spacing:3px;color:${T.dark};padding:8px 0;">
              ${esc(promoCode)}
            </div>
            <div style="font-family:${T.sans};font-size:12px;color:${T.muted};">
              Book direct on our website anytime using this code.
            </div>
          </td>
        </tr>
      `
          : ""
      }

      <tr>
        <td align="center" style="padding:24px 0 8px;font-family:${T.sans};font-size:13px;line-height:21px;color:${T.muted};">
          We are always striving to improve our guest hospitality. We would love to hear your feedback on your stay.
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:14px 0;">
          ${button(directBookingSite, "Plan Your Next Visit")}
        </td>
      </tr>
    </table>`;

  return sendViaResend({
    to: booking.guest.email,
    subject: `Thank You for Visiting ${hotel.name}!`,
    html: layout({
      preheader: `Thank you for your stay at ${hotel.name}. Here is an exclusive perk for your next visit.`,
      hotelName: hotel.name,
      eyebrow: "Thank You",
      body,
      footer: hotelFooter({
        hotelName: hotel.name,
        hotelAddress,
        hotelPhone: hotel.contact?.phone,
      }),
    }),
    text: `Thank you for staying at ${hotel.name}! We hope you had a great experience.${promoCode ? ` Use promo code ${promoCode} for a discount on your next direct booking.` : ""}`,
  });
}

/* ========================================================================== */
/*                Phase 3: Abandoned Hold Recovery Automation (#4)             */
/* ========================================================================== */

/**
 * 4. Abandoned Hold Recovery Email (Sent when an online hold expires without payment)
 */
export async function sendAbandonedHoldRecoveryEmail({
  booking,
  hotel,
  roomType,
}) {
  if (!booking?.guest?.email || !process.env.RESEND_API_KEY)
    return { success: false };

  const resumeUrl = getManageBookingUrl(
    hotel.slug,
    booking.bookingCode,
    booking.guest.email,
  );
  const hotelAddress = `${hotel.address?.street || ""}, ${hotel.address?.city || ""}`;

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding-bottom:18px;">
          <span style="display:inline-block;padding:7px 16px;border:1px solid ${T.gold};border-radius:30px;font-family:${T.sans};font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:${T.goldDark};">
            Room Still Available
          </span>
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${T.serif};font-size:28px;line-height:36px;color:${T.ink};">
          Did you leave something behind?
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:12px 0 24px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
          Dear ${esc(booking.guest.name)}, we noticed your reservation hold for <strong style="color:${T.ink};">${esc(roomType?.name || "your room")}</strong> at <strong style="color:${T.ink};">${esc(hotel.name)}</strong> was not completed.
        </td>
      </tr>

      <!-- Reserved details -->
      <tr>
        <td bgcolor="${T.soft}" style="padding:22px;border:1px solid ${T.line};border-radius:2px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${detailRow("Stay Dates", `${esc(fmtDate(booking.dates.checkIn))} &rarr; ${esc(fmtDate(booking.dates.checkOut))}`)}
            ${detailRow("Room Type", esc(roomType?.name || "Standard Room"))}
            ${detailRow("Estimated Total", formatINR(booking.billing?.grandTotal))}
          </table>
        </td>
      </tr>

      <tr>
        <td align="center" style="padding:28px 0 10px;">
          ${button(resumeUrl, "Resume & Secure Your Room")}
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};">
          Rooms at direct rates sell out quickly. Click above to complete your booking securely with no extra OTA commissions.
        </td>
      </tr>
    </table>`;

  return sendViaResend({
    to: booking.guest.email,
    subject: `Still thinking about your stay at ${hotel.name}?`,
    html: layout({
      preheader: `Complete your direct booking for ${fmtDate(booking.dates.checkIn)} at ${hotel.name}.`,
      hotelName: hotel.name,
      eyebrow: "Hold Recovery",
      body,
      footer: hotelFooter({
        hotelName: hotel.name,
        hotelAddress,
        hotelPhone: hotel.contact?.phone,
      }),
    }),
    text: `Your held room at ${hotel.name} for ${fmtDate(booking.dates.checkIn)} was not completed. Click here to resume your reservation: ${resumeUrl}`,
  });
}

/* ========================================================================== */
/*                                 Public API                                 */
/* ========================================================================== */

/**
 * Send Tier-1 Registration Authorization OTP to Super Admin
 */
export async function sendSuperAdminRegistrationOtp({
  superAdminEmail,
  hotelName,
  hotelSlug,
  managerName,
  email,
  phone,
  otp,
}) {
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding-bottom:20px;">
          <span style="display:inline-block;padding:7px 16px;border:1px solid ${T.gold};border-radius:30px;font-family:${T.sans};font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:${T.goldDark};">
            Security Authorization
          </span>
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${T.serif};font-size:28px;line-height:36px;color:${T.ink};">
          New Property Registration
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:14px 0 26px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
          A new hotel property has requested to join your platform.<br>
          Review the credentials below and authorize this account.
        </td>
      </tr>

      <!-- Application Details -->
      <tr>
        <td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${T.line};margin-bottom:26px;">
            ${detailRow("Hotel Name", esc(hotelName), { bold: true })}
            ${detailRow("Widget Slug", `<span style="font-family:'Courier New',monospace;">${esc(hotelSlug)}</span>`, { bold: true })}
            ${detailRow("Manager", esc(managerName))}
            ${detailRow("Manager Email", `<a href="mailto:${esc(email)}" style="color:${T.ink};text-decoration:none;">${esc(email)}</a>`)}
            ${detailRow("Contact Phone", esc(phone))}
          </table>
        </td>
      </tr>

      <!-- 6-digit Code Box -->
      <tr>
        <td align="center" bgcolor="${T.soft}" style="padding:24px 20px;border:1px dashed ${T.gold};border-radius:2px;">
          <div style="font-family:${T.sans};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${T.muted};">
            Super Admin Approval Code
          </div>
          <div style="font-family:'Courier New',monospace;font-size:36px;font-weight:bold;letter-spacing:10px;color:${T.dark};margin-top:10px;">
            ${esc(otp)}
          </div>
          <div style="font-family:${T.sans};font-size:12px;color:${T.muted};margin-top:8px;">
            Expires in 15 minutes &bull; Authorizes hotel registration
          </div>
        </td>
      </tr>
    </table>`;

  const text =
    `Super Admin Registration Authorization\n\n` +
    `Property: ${hotelName} (${hotelSlug})\n` +
    `Manager: ${managerName} (${email}, ${phone})\n\n` +
    `Approval Code: ${otp}\n(Expires in 15 minutes)`;

  if (devOtpFallback("Super admin approval code", superAdminEmail, otp)) return;

  await sendViaResend(
    {
      to: superAdminEmail,
      subject: `[Authorization Required] New Property Registration - ${hotelName}`,
      html: layout({
        preheader: `Authorization code ${otp} for new registration: ${hotelName}.`,
        hotelName: "Platform Console",
        eyebrow: "Administrator Access",
        body,
        footer: `<div style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};">Sent to the platform master admin because a new hotel account was requested.</div>`,
      }),
      text,
    },
    { strict: true },
  );
}

/**
 * Send Tier-2 Email Verification OTP to Hotelier
 */
export async function sendHotelierRegistrationOtp({
  to,
  managerName,
  hotelName,
  otp,
}) {
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding-bottom:20px;">
          <span style="display:inline-block;padding:7px 16px;border:1px solid ${T.success};border-radius:30px;font-family:${T.sans};font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:${T.success};">
            Approved &bull; Email Verification
          </span>
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${T.serif};font-size:28px;line-height:36px;color:${T.ink};">
          Verify your email address
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:14px 0 28px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
          Dear ${esc(managerName)}, your registration for <strong style="color:${T.ink};">${esc(hotelName)}</strong> has been approved by the platform administrator.<br>
          Please verify your email address to complete your account setup.
        </td>
      </tr>

      <!-- 6-digit Code Box -->
      <tr>
        <td align="center" bgcolor="${T.soft}" style="padding:24px 20px;border:1px dashed ${T.gold};border-radius:2px;">
          <div style="font-family:${T.sans};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${T.muted};">
            Your Verification Code
          </div>
          <div style="font-family:'Courier New',monospace;font-size:36px;font-weight:bold;letter-spacing:10px;color:${T.success};margin-top:10px;">
            ${esc(otp)}
          </div>
          <div style="font-family:${T.sans};font-size:12px;color:${T.muted};margin-top:8px;">
            Expires in 15 minutes
          </div>
        </td>
      </tr>

      <tr>
        <td align="center" style="padding-top:28px;font-family:${T.sans};font-size:13px;line-height:21px;color:${T.muted};">
          Enter this code into the registration screen to activate your management dashboard.
        </td>
      </tr>
    </table>`;

  const text =
    `Verify your email for ${hotelName}\n\n` +
    `Dear ${managerName},\nYour verification code is: ${otp}\n` +
    `Enter this code to finish creating your account. Expires in 15 minutes.`;

  if (devOtpFallback("Hotelier verification code", to, otp)) return;

  await sendViaResend(
    {
      to,
      subject: `Verification Code - ${hotelName}`,
      html: layout({
        preheader: `Your verification code is ${otp}. Complete your registration for ${hotelName}.`,
        hotelName,
        eyebrow: "Account Verification",
        body,
        footer: `<div style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};">You received this because an account registration was initiated for ${esc(hotelName)}.</div>`,
      }),
      text,
    },
    { strict: true },
  );
}

/**
 * Single source of truth for "how much has the guest paid, how much is left".
 * Mirrors paymentFigures() in invoice.service.js so mail, PDF and portal agree.
 */
function getPaymentFigures(booking) {
  const grand = Number(booking.billing?.grandTotal) || 0;
  const mode = booking.payment?.mode;
  const round2 = (n) => Math.round(n * 100) / 100;

  if (mode === "PAY_AT_HOTEL") {
    const paid = Math.min(
      grand,
      Number(booking.payment?.amountPayableNow) || 0,
    );
    return { paid, due: Math.max(0, round2(grand - paid)) };
  }
  if (mode === "OFFLINE") {
    const received = (booking.payment?.offlinePayments || []).reduce(
      (a, x) => a + (Number(x.amount) || 0),
      0,
    );
    const paid = Math.min(grand, received);
    return { paid, due: Math.max(0, round2(grand - paid)) };
  }
  // Own gateway / fully online
  const paid = Number(booking.payment?.amountPaidOnline) || grand;
  return { paid, due: Math.max(0, round2(grand - paid)) };
}

/**
 * Send booking confirmation to guest and notification to hotel desk
 */
export async function sendBookingConfirmation({
  booking,
  hotel,
  roomType,
  invoice = null,
}) {
  try {
    const manageUrl = getManageBookingUrl(
      hotel.slug,
      booking.bookingCode,
      booking.guest.email,
    );

    const pay = getPaymentFigures(booking);

    const guestPayload = {
      to: booking.guest.email,
      guestName: booking.guest.name,
      phone: booking.guest.phone,
      bookingCode: booking.bookingCode,
      hotelName: hotel.name,
      roomName: roomType?.name || "Standard Room",
      roomCount: booking.roomCount || 1,
      checkInRaw: booking.dates.checkIn,
      checkOutRaw: booking.dates.checkOut,
      checkIn: fmtDate(booking.dates.checkIn),
      checkOut: fmtDate(booking.dates.checkOut),
      nights: booking.dates.nights,
      grandTotal: formatINR(booking.billing?.grandTotal),
      paidRaw: pay.paid,
      paidNow: formatINR(pay.paid),
      balanceDue: pay.due > 0 ? formatINR(pay.due) : null,
      invoiceNumber: invoice?.invoiceNumber || null,
      invoicePdf: invoice?.pdf || null,
      selectedAddOns: booking.selectedAddOns || [],
      hotelAddress: `${hotel.address?.street || ""}, ${hotel.address?.city || ""}`,
      hotelPhone: hotel.contact?.phone || "",
      manageUrl,
    };

    // 1. Dispatch Email to Guest
    await dispatchGuestEmail(guestPayload);

    // 2. Dispatch Front-Desk Alert Email to Hotel Staff
    if (hotel.contact?.email) {
      await dispatchFrontDeskEmailAlert({
        hotelEmail: hotel.contact.email,
        hotelName: hotel.name,
        guestPayload,
      });
    }

    // 3. Dispatch WhatsApp Voucher (if credentials configured)
    if (booking.guest.phone) {
      await dispatchGuestWhatsApp(guestPayload);
    }

    return { success: true };
  } catch (err) {
    console.error(
      "[Notification Service Error] Failed to send confirmations:",
      err.message,
    );
    return { success: false, error: err.message };
  }
}

/**
 * Send cancellation confirmation and refund details
 */
export async function sendCancellationNotice({
  booking,
  hotel,
  cancellationResult,
}) {
  try {
    const refundFormatted = formatINR(cancellationResult.refundAmount);
    const message =
      `Booking ${booking.bookingCode} at ${hotel.name} has been cancelled. ` +
      `Refund of ${refundFormatted} (${cancellationResult.refundPercent}%) ` +
      (booking.payment?.mode === "OFFLINE"
        ? `is to be returned to you by the hotel.`
        : booking.payment?.mode === "PAY_AT_HOTEL" &&
            !(cancellationResult.refundAmount > 0)
          ? `does not apply: the online booking fee is non-refundable.`
          : `has been initiated to your original payment method.`);

    console.log(
      `[Notification] Cancellation Notice -> ${booking.guest.email} | ${message}`,
    );

    if (process.env.RESEND_API_KEY && booking.guest.email) {
      const body = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="padding-bottom:22px;">
              <span style="display:inline-block;padding:7px 16px;border:1px solid ${T.danger};border-radius:30px;font-family:${T.sans};font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:${T.danger};">Cancelled</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="font-family:${T.serif};font-size:28px;line-height:36px;color:${T.ink};">Your reservation has been cancelled</td>
          </tr>
          <tr>
            <td align="center" style="padding:14px 0 28px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
              Dear ${esc(booking.guest.name)}, your booking
              <strong style="color:${T.ink};">#${esc(booking.bookingCode)}</strong> at
              <strong style="color:${T.ink};">${esc(hotel.name)}</strong> has been cancelled as requested.
            </td>
          </tr>
          <tr>
            <td bgcolor="${T.dangerSoft}" style="padding:22px 24px;border-left:3px solid ${T.danger};border-radius:2px;">
              <div style="font-family:${T.sans};font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:${T.danger};">Refund summary</div>
              <div style="font-family:${T.serif};font-size:30px;color:${T.ink};margin-top:8px;">${refundFormatted}</div>
              <div style="font-family:${T.sans};font-size:12px;color:${T.muted};margin-top:2px;">${esc(cancellationResult.refundPercent)}% of the amount paid</div>
              <div style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};margin-top:14px;padding-top:14px;border-top:1px solid #efd9d6;">
                ${
                  booking.payment?.mode === "OFFLINE"
                    ? "This booking was paid to the hotel directly, so any refund is returned to you by the hotel."
                    : booking.payment?.mode === "PAY_AT_HOTEL" &&
                        !(cancellationResult.refundAmount > 0)
                      ? "The online booking fee is non-refundable when a guest cancels. Nothing further is payable at the hotel."
                      : "Refunds are processed automatically via Razorpay and reflect in your original payment method within 5–7 business days."
                }
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:30px;font-family:${T.sans};font-size:13px;line-height:21px;color:${T.muted};">
              Questions about your refund? Please contact the hotel desk${
                hotel.contact?.phone
                  ? ` at <a href="tel:${esc(hotel.contact.phone)}" style="color:${T.goldDark};text-decoration:none;">${esc(hotel.contact.phone)}</a>`
                  : ""
              }.
            </td>
          </tr>
        </table>`;

      await sendViaResend({
        to: booking.guest.email,
        subject: `Reservation Cancelled - #${booking.bookingCode}`,
        html: layout({
          preheader: `Booking #${booking.bookingCode} cancelled. Refund of ${refundFormatted} initiated.`,
          hotelName: hotel.name,
          eyebrow: "Cancellation Notice",
          body,
          footer: hotelFooter({
            hotelName: hotel.name,
            hotelAddress: `${hotel.address?.street || ""}, ${hotel.address?.city || ""}`,
            hotelPhone: hotel.contact?.phone,
          }),
        }),
        text: message,
      });
    }

    return { success: true };
  } catch (err) {
    console.error(
      "[Notification Service Error] Failed to send cancellation notice:",
      err.message,
    );
    return { success: false, error: err.message };
  }
}

/* ========================================================================== */
/*                             Internal Dispatchers                           */
/* ========================================================================== */

async function dispatchGuestEmail(p) {
  const addOns = (p.selectedAddOns || [])
    .map(
      (a) =>
        `${esc(a.name)}${a.quantity > 1 ? ` &times; ${esc(a.quantity)}` : ""}`,
    )
    .join("<br>");

  // Wording depends on whether anything is still payable at the hotel.
  const introLine = p.balanceDue
    ? p.paidRaw > 0
      ? "Your reservation is confirmed. Your booking fee has been received and the balance is payable at the hotel."
      : "Your reservation is confirmed. The full amount is payable at the hotel."
    : "Your reservation is confirmed and payment has been received.";

  const totalsRow = (label, value, big = false, last = false) => `
                  <tr>
                    <td style="font-family:${T.sans};font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:${T.gold};padding-bottom:${last ? "0" : "10px"};">${esc(label)}</td>
                    <td align="right" style="font-family:${T.serif};font-size:${big ? "24px" : "16px"};color:#ffffff;padding-bottom:${last ? "0" : "10px"};">${esc(value)}</td>
                  </tr>`;

  const totalsRows = p.balanceDue
    ? totalsRow("Booking total", p.grandTotal) +
      totalsRow("Paid so far", p.paidNow) +
      totalsRow("Balance at hotel", p.balanceDue, true, true)
    : totalsRow("Total paid", p.grandTotal, true, true);

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding-bottom:20px;">
          <span style="display:inline-block;padding:7px 16px;border:1px solid ${T.success};border-radius:30px;font-family:${T.sans};font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:${T.success};">&#10003;&nbsp; Confirmed</span>
        </td>
      </tr>

      <tr>
        <td align="center" style="font-family:${T.serif};font-size:30px;line-height:38px;color:${T.ink};">
          We look forward to welcoming you
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:14px 0 30px;font-family:${T.sans};font-size:14px;line-height:23px;color:${T.muted};">
          Dear ${esc(p.guestName)}, thank you for booking directly with us.<br>
          ${esc(introLine)}
        </td>
      </tr>

      <tr>
        <td align="center" bgcolor="${T.soft}" style="padding:20px;border:1px dashed ${T.gold};border-radius:2px;">
          <div style="font-family:${T.sans};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${T.muted};">Booking reference</div>
          <div style="font-family:'Courier New',monospace;font-size:26px;font-weight:bold;letter-spacing:4px;color:${T.ink};margin-top:8px;">${esc(p.bookingCode)}</div>
        </td>
      </tr>

      <tr>
        <td style="padding:30px 0 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td class="stack" width="42%" align="center" valign="top">${dateBlock("Check-in", p.checkInRaw)}</td>
              <td class="stack stack-gap" width="16%" align="center" valign="middle">
                <div style="font-family:${T.sans};font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:${T.gold};border-top:1px solid ${T.line};border-bottom:1px solid ${T.line};padding:6px 0;">
                  ${plural(p.nights, "night")}
                </div>
              </td>
              <td class="stack stack-gap" width="42%" align="center" valign="top">${dateBlock("Check-out", p.checkOutRaw)}</td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="padding-top:26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${T.line};">
            ${detailRow("Property", esc(p.hotelName), { bold: true })}
            ${detailRow("Room", `${esc(p.roomName)} &middot; ${plural(p.roomCount, "room")}`, { bold: true })}
            ${addOns ? detailRow("Add-ons", addOns) : ""}
          </table>
        </td>
      </tr>

      <tr>
        <td style="padding-top:26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td bgcolor="${T.dark}" style="padding:20px 24px;border-radius:2px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${totalsRows}
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td align="center" style="padding:34px 0 14px;">
          ${button(p.manageUrl, "View voucher & manage booking")}
        </td>
      </tr>
      <tr>
        <td align="center" style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};">
          Modify your stay, cancel, or download your official PDF receipt using the button above.
        </td>
      </tr>
    </table>`;

  const text =
    `Reservation confirmed at ${p.hotelName}\n\n` +
    `Booking reference: ${p.bookingCode}\n` +
    `Room: ${p.roomName} (${p.roomCount})\n` +
    `Check-in: ${p.checkIn}\nCheck-out: ${p.checkOut} (${plural(p.nights, "night")})\n` +
    (p.balanceDue
      ? `Booking total: ${p.grandTotal}\nPaid so far: ${p.paidNow}\nBalance payable at the hotel: ${p.balanceDue}\n`
      : `Total paid: ${p.grandTotal}\n`) +
    (p.invoiceNumber
      ? `Invoice ${p.invoiceNumber} is attached as a PDF.\n`
      : "") +
    `\nManage your booking: ${p.manageUrl}`;

  if (process.env.RESEND_API_KEY) {
    await sendViaResend({
      to: p.to,
      subject: `Booking Confirmed - #${p.bookingCode} at ${p.hotelName}`,
      html: layout({
        preheader: `Your stay at ${p.hotelName} is confirmed: ${p.checkIn} to ${p.checkOut}.`,
        hotelName: p.hotelName,
        eyebrow: "Reservation Voucher",
        body,
        footer: hotelFooter(p),
      }),
      text,
      attachments: p.invoicePdf
        ? [
            {
              filename: `Invoice-${String(p.invoiceNumber || p.bookingCode).replace(/[^A-Za-z0-9-]/g, "_")}.pdf`,
              content: p.invoicePdf.toString("base64"),
            },
          ]
        : undefined,
    });
  } else {
    console.log(
      `[Email Mock - RESEND_API_KEY missing] Voucher for ${p.bookingCode} -> ${p.to}`,
    );
  }
}

async function dispatchFrontDeskEmailAlert({
  hotelEmail,
  hotelName,
  guestPayload: p,
}) {
  if (!process.env.RESEND_API_KEY || !hotelEmail) return;

  const addOns = (p.selectedAddOns || [])
    .map(
      (a) =>
        `${esc(a.name)}${a.quantity > 1 ? ` &times; ${esc(a.quantity)}` : ""}`,
    )
    .join(", ");

  const paymentLine = p.balanceDue
    ? `Confirmed on your website. Booking fee received online:
          <strong style="color:${T.success};">${esc(p.paidNow)}</strong>.<br>
          <strong style="color:${T.danger};">Collect ${esc(p.balanceDue)} from the guest at the hotel</strong>
          (booking total ${esc(p.grandTotal)}).`
    : `Paid and confirmed on your website. Amount received:
          <strong style="color:${T.success};">${esc(p.grandTotal)}</strong>`;

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="font-family:${T.sans};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${T.gold};">New direct booking</td>
      </tr>
      <tr>
        <td style="padding:8px 0 4px;font-family:${T.serif};font-size:26px;line-height:33px;color:${T.ink};">
          ${esc(p.guestName)} has booked ${esc(p.roomName)}
        </td>
      </tr>
      <tr>
        <td style="padding-bottom:22px;font-family:${T.sans};font-size:13px;line-height:21px;color:${T.muted};">
          ${paymentLine}
        </td>
      </tr>
      <tr>
        <td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${T.line};">
            ${detailRow("Booking ID", `<span style="font-family:'Courier New',monospace;letter-spacing:1px;">${esc(p.bookingCode)}</span>`, { bold: true })}
            ${detailRow("Guest", esc(p.guestName), { bold: true })}
            ${detailRow("Phone", p.phone ? `<a href="tel:${esc(p.phone)}" style="color:${T.ink};text-decoration:none;">${esc(p.phone)}</a>` : "Not provided")}
            ${detailRow("Email", `<a href="mailto:${esc(p.to)}" style="color:${T.ink};text-decoration:none;">${esc(p.to)}</a>`)}
            ${detailRow("Room", `${esc(p.roomName)} &middot; ${plural(p.roomCount, "room")}`)}
            ${detailRow("Stay", `${esc(p.checkIn)} &rarr; ${esc(p.checkOut)}<br><span style="color:${T.muted};font-size:12px;">${plural(p.nights, "night")}</span>`)}
            ${addOns ? detailRow("Add-ons", addOns) : ""}
            ${p.balanceDue ? detailRow("To collect at hotel", `<span style="color:${T.danger};">${esc(p.balanceDue)}</span>`, { bold: true }) : ""}
          </table>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding-top:30px;">
          ${button(p.manageUrl, "View in portal")}
        </td>
      </tr>
    </table>`;

  await sendViaResend({
    to: hotelEmail,
    subject: `[New Booking] #${p.bookingCode} - ${p.guestName}`,
    html: layout({
      preheader: `${p.guestName} · ${p.roomName} · ${p.checkIn} → ${p.checkOut} · ${p.balanceDue ? `collect ${p.balanceDue} at hotel` : p.grandTotal}`,
      hotelName,
      eyebrow: "Front Desk Alert",
      body,
      footer: `<div style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};">Sent to the ${esc(hotelName)} reservations desk because a guest completed a direct booking.</div>`,
    }),
    text:
      `New booking #${p.bookingCode}\nGuest: ${p.guestName} (${p.phone || "No phone"}, ${p.to})\n` +
      `Room: ${p.roomName} (${p.roomCount})\nDates: ${p.checkIn} -> ${p.checkOut} (${p.nights} nights)\n` +
      (p.balanceDue
        ? `Booking fee received online: ${p.paidNow}\nCollect at hotel: ${p.balanceDue} (total ${p.grandTotal})\n`
        : `Amount received: ${p.grandTotal}\n`) +
      `${p.manageUrl}`,
  });
}

/**
 * Sends transactional email via Resend API and raises system alert on failure
 */
async function sendViaResend(
  { to, subject, html, text, attachments },
  { strict = false } = {},
) {
  if (!process.env.RESEND_API_KEY) {
    const message =
      "[Resend] RESEND_API_KEY is not configured; email was not sent.";
    if (strict) throw new Error(message);
    console.warn(message);
    return;
  }

  let failure = null;
  const recipient = Array.isArray(to) ? to.join(", ") : to;

  try {
    const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(text ? { text } : {}),
        ...(attachments?.length ? { attachments } : {}),
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn("[Resend API Error Response]:", data);
      failure = new Error(
        data?.message || `Resend responded with HTTP ${response.status}`,
      );
    } else {
      console.log(`[Resend Email Sent] ID: ${data.id} -> ${recipient}`);
    }
  } catch (err) {
    console.error("[Resend Network Error]:", err.message);
    failure = err;
  }

  if (failure) {
    // Raise system alert across Sentry and Ops webhook
    await sendSystemAlert({
      type: "EMAIL_FAILURE",
      title: "Transactional Email Dispatch Failed",
      message: failure.message,
      metadata: { to: recipient, subject, error: failure.message },
      severity: strict ? "error" : "warning",
    }).catch((alertErr) => {
      console.error(
        "[Notification Service] System alert dispatch failed:",
        alertErr.message,
      );
    });

    if (strict) throw failure;
  }
}

function devOtpFallback(label, to, otp) {
  if (process.env.RESEND_API_KEY || process.env.NODE_ENV === "production")
    return false;
  console.log(`[DEV OTP - RESEND_API_KEY not set] ${label} for ${to}: ${otp}`);
  return true;
}

async function dispatchGuestWhatsApp(payload) {
  const whatsappToken = process.env.WHATSAPP_API_TOKEN;
  const phoneId =
    process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID;

  if (!whatsappToken || !phoneId) return;

  try {
    let cleanPhone = payload.phone.replace(/[^0-9]/g, "");
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;

    const bodyText =
      `🏨 *Booking Confirmed at ${payload.hotelName}*\n\n` +
      `Booking ID: *${payload.bookingCode}*\n` +
      `Guest: ${payload.guestName}\n` +
      `Room: ${payload.roomName}\n` +
      `Check-in: ${payload.checkIn}\n` +
      `Check-out: ${payload.checkOut} (${payload.nights} Night(s))\n` +
      (payload.balanceDue
        ? `Booking Total: ${payload.grandTotal}\nPaid Online: ${payload.paidNow}\nBalance at Hotel: ${payload.balanceDue}\n\n`
        : `Amount Paid: ${payload.grandTotal}\n\n`) +
      `📄 *Manage Booking & Download Receipt:*\n` +
      `${payload.manageUrl}`;

    const response = await fetch(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: cleanPhone,
          type: "text",
          text: { body: bodyText },
        }),
      },
    );

    if (!response.ok) {
      const resData = await response.json().catch(() => ({}));
      console.warn("[WhatsApp Cloud API Warning]", resData);
    }
  } catch (apiErr) {
    console.error("[WhatsApp Cloud API Error]", apiErr.message);
  }
}

/* ========================================================================== */
/*                       Account emails (reset / staff invite)                */
/* ========================================================================== */

function devLinkFallback(label, to, url) {
  if (process.env.RESEND_API_KEY || process.env.NODE_ENV === "production")
    return false;
  console.log(`[DEV LINK - RESEND_API_KEY not set] ${label} for ${to}: ${url}`);
  return true;
}

export async function sendPasswordResetEmail({
  to,
  name,
  resetUrl,
  expiresInMinutes = 60,
}) {
  if (devLinkFallback("Password reset", to, resetUrl)) return;

  const body = `
    <div style="font-family:${T.serif};font-size:22px;color:${T.ink};margin-bottom:14px;">Reset your password</div>
    <p style="font-family:${T.sans};font-size:14px;line-height:22px;color:${T.ink};margin:0 0 22px;">
      Hello ${esc(name || "there")}, we received a request to reset the password for your account.
      This link works once and expires in ${esc(expiresInMinutes)} minutes.
    </p>
    <div style="padding:6px 0 22px;">${button(resetUrl, "Choose a new password")}</div>
    <p style="font-family:${T.sans};font-size:12px;line-height:19px;color:${T.muted};margin:0;">
      If you did not ask for this, you can ignore this email; your password stays the same.
      For security, resetting also signs you out of every device.
    </p>`;

  await sendViaResend(
    {
      to,
      subject: "Reset your password",
      html: layout({
        preheader: "Use this link to choose a new password.",
        hotelName: "Account security",
        eyebrow: "Password reset",
        body,
        footer: `<div style="font-family:${T.sans};font-size:12px;color:${T.muted};">Link not working? Request a new one from the sign-in page.</div>`,
      }),
      text: `Reset your password: ${resetUrl}\n\nThis link works once and expires in ${expiresInMinutes} minutes. If you did not ask for it, ignore this email.`,
    },
    { strict: true },
  );
}

export async function sendStaffInviteEmail({
  to,
  name,
  hotelName,
  inviterName,
  inviteUrl,
  role = "STAFF",
  expiresInDays = 7,
}) {
  if (devLinkFallback("Staff invite", to, inviteUrl)) return;

  const body = `
    <div style="font-family:${T.serif};font-size:22px;color:${T.ink};margin-bottom:14px;">You have been invited</div>
    <p style="font-family:${T.sans};font-size:14px;line-height:22px;color:${T.ink};margin:0 0 22px;">
      Hello ${esc(name || "there")}, ${esc(inviterName || "a colleague")} invited you to join
      <strong>${esc(hotelName)}</strong> as ${esc(role === "HOTELIER" ? "a manager" : "front-desk staff")}.
      Set your password to activate your account. The link expires in ${esc(expiresInDays)} days.
    </p>
    <div style="padding:6px 0 22px;">${button(inviteUrl, "Accept invitation")}</div>`;

  await sendViaResend(
    {
      to,
      subject: `You're invited to ${hotelName}`,
      html: layout({
        preheader: `${inviterName || "A colleague"} invited you to ${hotelName}.`,
        hotelName,
        eyebrow: "Team invitation",
        body,
        footer: `<div style="font-family:${T.sans};font-size:12px;color:${T.muted};">If you were not expecting this, you can ignore this email.</div>`,
      }),
      text: `${inviterName || "A colleague"} invited you to ${hotelName}. Accept: ${inviteUrl} (expires in ${expiresInDays} days)`,
    },
    { strict: true },
  );
}

export async function sendHotelAlertEmail({
  to,
  hotelName,
  subject,
  heading,
  lines = [],
}) {
  try {
    if (!to) return;
    const items = lines
      .map(
        (l) =>
          `<li style="font-family:${T.sans};font-size:13px;line-height:21px;color:${T.ink};margin-bottom:6px;">${esc(l)}</li>`,
      )
      .join("");
    const body = `
      <div style="font-family:${T.serif};font-size:21px;color:${T.ink};margin-bottom:14px;">${esc(heading)}</div>
      <ul style="margin:0;padding-left:18px;">${items}</ul>`;
    await sendViaResend({
      to,
      subject,
      html: layout({
        preheader: heading,
        hotelName,
        eyebrow: "Attention needed",
        body,
        footer: `<div style="font-family:${T.sans};font-size:12px;color:${T.muted};">Sign in to your dashboard to review.</div>`,
      }),
      text: `${heading}\n\n${lines.map((l) => `- ${l}`).join("\n")}`,
    });
  } catch (err) {
    console.error("[Hotel Alert Email Error]", err?.message || err);
  }
}