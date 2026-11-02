import { SimplePdf } from "./pdf.js";
import { DOCUMENT_TITLES, formatInr } from "./invoiceMath.js";

const M = 40; // page margin
const W = 595.28;
const CONTENT_W = W - M * 2;
const INK = [0.11, 0.11, 0.1];
const MUTED = [0.45, 0.43, 0.4];
const DARK = [0.06, 0.09, 0.16];
const GOLD = [0.69, 0.55, 0.34];
const RED = [0.7, 0.15, 0.15];

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const fmtIssued = (d) =>
  new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

/**
 * Renders an invoice snapshot (see models/Invoice.js) to a PDF Buffer.
 * Takes a plain object, so it is easy to unit test.
 */
export function renderInvoicePdf(inv) {
  const pdf = new SimplePdf({
    title: `${DOCUMENT_TITLES[inv.docType] || "Invoice"} ${inv.invoiceNumber}`,
  });
  const title = DOCUMENT_TITLES[inv.docType] || "INVOICE";

  // Header band
  pdf.rect(0, 0, W, 86, { fill: DARK });
  pdf.text(M, 38, inv.seller.legalName || inv.seller.tradeName || "Hotel", {
    size: 17,
    bold: true,
    color: [1, 1, 1],
  });
  if (inv.seller.tradeName && inv.seller.tradeName !== inv.seller.legalName) {
    pdf.text(M, 54, `Trading as ${inv.seller.tradeName}`, {
      size: 9,
      color: [0.8, 0.8, 0.8],
    });
  }
  pdf.text(
    M,
    70,
    inv.seller.gstin ? `GSTIN: ${inv.seller.gstin}` : "GSTIN: not registered",
    {
      size: 9,
      bold: true,
      color: GOLD,
    },
  );
  pdf.text(M, 40, title, {
    size: 15,
    bold: true,
    align: "right",
    width: CONTENT_W,
    color: [1, 1, 1],
  });
  pdf.text(M, 58, `No. ${inv.invoiceNumber}`, {
    size: 10,
    align: "right",
    width: CONTENT_W,
    color: [1, 1, 1],
  });
  pdf.text(M, 72, `Date: ${fmtIssued(inv.issuedAt)}`, {
    size: 9,
    align: "right",
    width: CONTENT_W,
    color: [0.8, 0.8, 0.8],
  });

  let y = 112;
  if (inv.status === "CANCELLED") {
    pdf.text(M, y, "CANCELLED - this document is no longer valid", {
      size: 11,
      bold: true,
      color: RED,
    });
    y += 18;
  }

  // Seller + buyer columns
  const colW = CONTENT_W / 2 - 10;
  pdf.text(M, y, "FROM", { size: 8, bold: true, color: GOLD });
  pdf.text(M + colW + 20, y, "BILLED TO", { size: 8, bold: true, color: GOLD });
  let ly = y + 14;
  const left = [
    inv.seller.address,
    inv.seller.phone && `Phone: ${inv.seller.phone}`,
    inv.seller.email,
  ].filter(Boolean);
  for (const line of left) {
    pdf.text(M, ly, line, { size: 9, color: INK });
    ly += 12;
  }
  let ry = y + 14;
  pdf.text(M + colW + 20, ry, inv.buyer.name, {
    size: 10,
    bold: true,
    color: INK,
  });
  ry += 13;
  for (const line of [
    inv.buyer.phone && `Phone: ${inv.buyer.phone}`,
    inv.buyer.email,
  ].filter(Boolean)) {
    pdf.text(M + colW + 20, ry, line, { size: 9, color: INK });
    ry += 12;
  }
  pdf.text(
    M + colW + 20,
    ry,
    `Place of supply: ${inv.placeOfSupply.state}${
      inv.placeOfSupply.code ? ` (${inv.placeOfSupply.code})` : ""
    }`,
    {
      size: 9,
      color: MUTED,
    },
  );
  ry += 12;

  y = Math.max(ly, ry) + 10;
  pdf.line(M, y, W - M, y);
  y += 16;

  // Stay details
  pdf.text(M, y, "STAY DETAILS", { size: 8, bold: true, color: GOLD });
  y += 14;
  const stay = [
    ["Booking reference", inv.bookingCode],
    [
      "Room",
      `${inv.stay.roomName}${
        inv.stay.roomCount > 1 ? ` x ${inv.stay.roomCount}` : ""
      }`,
    ],
    ["Check-in", fmtDate(inv.stay.checkIn)],
    ["Check-out", fmtDate(inv.stay.checkOut)],
    [
      "Nights / guests",
      `${inv.stay.nights} night${inv.stay.nights === 1 ? "" : "s"} / ${
        inv.stay.adults
      } adult${inv.stay.adults === 1 ? "" : "s"}${
        inv.stay.children
          ? `, ${inv.stay.children} child${
              inv.stay.children === 1 ? "" : "ren"
            }`
          : ""
      }`,
    ],
  ];
  for (const [k, v] of stay) {
    pdf.text(M, y, k, { size: 9, color: MUTED });
    pdf.text(M + 110, y, v, { size: 9, bold: true, color: INK });
    y += 13;
  }
  y += 8;

  // Line items
  const colSac = M + 330;
  const colAmt = M;
  pdf.rect(M, y, CONTENT_W, 20, { fill: [0.95, 0.93, 0.9] });
  pdf.text(M + 8, y + 14, "Description", { size: 9, bold: true });
  pdf.text(colSac, y + 14, "SAC", { size: 9, bold: true });
  pdf.text(colAmt, y + 14, "Amount", {
    size: 9,
    bold: true,
    align: "right",
    width: CONTENT_W - 8,
  });
  y += 20;

  for (const line of inv.lines) {
    if (y > 700) {
      pdf.addPage();
      y = 60;
    }
    y += 16;
    pdf.text(M + 8, y, line.description, { size: 9.5, color: INK });
    pdf.text(colSac, y, line.sac || "-", { size: 9.5, color: MUTED });
    pdf.text(colAmt, y, formatInr(line.amount), {
      size: 9.5,
      align: "right",
      width: CONTENT_W - 8,
      color: INK,
    });
    pdf.line(M, y + 6, W - M, y + 6, { color: [0.9, 0.9, 0.9] });
  }
  y += 22;

  // Totals block (right aligned)
  const labelX = M + 300;
  const row = (label, value, { bold = false, rule = false } = {}) => {
    if (rule) pdf.line(labelX, y - 11, W - M, y - 11, { color: [0.6, 0.6, 0.6] });
    pdf.text(labelX, y, label, { size: 9.5, bold, color: INK });
    pdf.text(labelX, y, value, {
      size: 9.5,
      bold,
      align: "right",
      width: CONTENT_W - 300 - 8,
      color: INK,
    });
    y += 15;
  };
  row("Taxable value", formatInr(inv.taxableValue));
  if (inv.docType === "TAX_INVOICE") {
    const half = inv.gstRate / 2;
    row(`CGST @ ${half}%`, formatInr(inv.cgst));
    row(`SGST @ ${half}%`, formatInr(inv.sgst));
  }
  row(
    inv.docType === "TAX_INVOICE" ? "Invoice value" : "Total",
    formatInr(inv.invoiceValue),
    { bold: true, rule: true },
  );
  if (inv.platformFee > 0) {
    row("Platform convenience fee*", formatInr(inv.platformFee));
  }
  pdf.rect(labelX - 8, y - 11, CONTENT_W - 300 + 8, 22, { fill: DARK });
  pdf.text(
    labelX,
    y + 4,
    inv.amountDue > 0 ? "Amount paid" : "Total paid",
    { size: 10.5, bold: true, color: [1, 1, 1] },
  );
  pdf.text(labelX, y + 4, formatInr(inv.amountPaid), {
    size: 10.5,
    bold: true,
    align: "right",
    width: CONTENT_W - 300 - 8,
    color: [1, 1, 1],
  });
  y += 30;
  if (inv.amountDue > 0) {
    pdf.text(
      labelX,
      y - 6,
      `Balance payable at hotel: ${formatInr(inv.amountDue)}`,
      { size: 9.5, bold: true, color: RED },
    );
    y += 14;
  }

  if (inv.paymentSummary) {
    pdf.text(M, y, inv.paymentSummary, { size: 9, color: MUTED });
    y += 14;
  }
  if (inv.status === "CANCELLED") {
    pdf.text(
      M,
      y,
      `Booking cancelled. Refund of ${formatInr(
        inv.refundAmount || 0,
      )} processed per the cancellation policy.`,
      { size: 9, color: RED },
    );
    y += 14;
  }

  // Footer notes
  y = Math.max(y + 18, 740);
  pdf.line(M, y, W - M, y);
  y += 14;
  const notes = [
    "This is a computer-generated document and does not require a signature.",
    inv.platformFee > 0
      ? `*The platform convenience fee is charged by ${
          inv.platform?.name || "the booking platform"
        }${
          inv.platform?.gstin ? ` (GSTIN ${inv.platform.gstin})` : ""
        } and is not part of the hotel's invoice value.`
      : null,
    "Hotel accommodation is supplied at the hotel's location; tax is shown as CGST + SGST.",
  ].filter(Boolean);
  for (const n of notes) {
    pdf.text(M, y, n, { size: 8, color: MUTED });
    y += 11;
  }

  return pdf.toBuffer();
}

/**
 * Renders a formal GST Credit Note for a cancelled/refunded invoice snapshot.
 * Conforms to Section 34 of the CGST Act (Original Invoice Number & Date reference,
 * GST reversal breakdown, and reason for issuance).
 */
export function renderCreditNotePdf(inv) {
  const cnNumber = inv.creditNoteNumber || `CN-${inv.invoiceNumber}`;
  const pdf = new SimplePdf({ title: `Credit Note ${cnNumber}` });

  // Header band with distinct Maroon/Dark banner for Credit Note
  pdf.rect(0, 0, W, 86, { fill: [0.12, 0.04, 0.04] });
  pdf.text(M, 38, inv.seller.legalName || inv.seller.tradeName || "Hotel", {
    size: 17,
    bold: true,
    color: [1, 1, 1],
  });
  if (inv.seller.tradeName && inv.seller.tradeName !== inv.seller.legalName) {
    pdf.text(M, 54, `Trading as ${inv.seller.tradeName}`, {
      size: 9,
      color: [0.8, 0.8, 0.8],
    });
  }
  pdf.text(
    M,
    70,
    inv.seller.gstin ? `GSTIN: ${inv.seller.gstin}` : "GSTIN: not registered",
    {
      size: 9,
      bold: true,
      color: GOLD,
    },
  );
  pdf.text(M, 40, "CREDIT NOTE", {
    size: 15,
    bold: true,
    align: "right",
    width: CONTENT_W,
    color: [1, 0.85, 0.85],
  });
  pdf.text(M, 58, `No. ${cnNumber}`, {
    size: 10,
    align: "right",
    width: CONTENT_W,
    color: [1, 1, 1],
  });
  pdf.text(
    M,
    72,
    `Date: ${fmtIssued(inv.creditNoteIssuedAt || inv.cancelledAt || new Date())}`,
    {
      size: 9,
      align: "right",
      width: CONTENT_W,
      color: [0.85, 0.85, 0.85],
    },
  );

  let y = 106;

  // Cross-reference banner to Original Tax Invoice
  pdf.rect(M, y, CONTENT_W, 28, { fill: [0.97, 0.94, 0.94] });
  pdf.text(M + 10, y + 12, "ORIGINAL INVOICE REFERENCE", {
    size: 8,
    bold: true,
    color: RED,
  });
  pdf.text(
    M + 10,
    y + 22,
    `Original Invoice No: ${inv.invoiceNumber} | Issued: ${fmtIssued(
      inv.issuedAt,
    )} | Reason: Reservation Cancellation & Tax Reversal`,
    { size: 8.5, color: INK },
  );
  y += 42;

  // Seller + buyer columns
  const colW = CONTENT_W / 2 - 10;
  pdf.text(M, y, "ISSUED BY", { size: 8, bold: true, color: GOLD });
  pdf.text(M + colW + 20, y, "CREDITED TO", { size: 8, bold: true, color: GOLD });
  let ly = y + 14;
  const left = [
    inv.seller.address,
    inv.seller.phone && `Phone: ${inv.seller.phone}`,
    inv.seller.email,
  ].filter(Boolean);
  for (const line of left) {
    pdf.text(M, ly, line, { size: 9, color: INK });
    ly += 12;
  }
  let ry = y + 14;
  pdf.text(M + colW + 20, ry, inv.buyer.name, {
    size: 10,
    bold: true,
    color: INK,
  });
  ry += 13;
  for (const line of [
    inv.buyer.phone && `Phone: ${inv.buyer.phone}`,
    inv.buyer.email,
  ].filter(Boolean)) {
    pdf.text(M + colW + 20, ry, line, { size: 9, color: INK });
    ry += 12;
  }
  pdf.text(
    M + colW + 20,
    ry,
    `Place of supply: ${inv.placeOfSupply.state}${
      inv.placeOfSupply.code ? ` (${inv.placeOfSupply.code})` : ""
    }`,
    {
      size: 9,
      color: MUTED,
    },
  );
  ry += 12;

  y = Math.max(ly, ry) + 10;
  pdf.line(M, y, W - M, y);
  y += 16;

  // Stay details reference
  pdf.text(M, y, "RESERVATION REFERENCE", { size: 8, bold: true, color: GOLD });
  y += 14;
  const stay = [
    ["Booking reference", inv.bookingCode],
    [
      "Room",
      `${inv.stay.roomName}${
        inv.stay.roomCount > 1 ? ` x ${inv.stay.roomCount}` : ""
      }`,
    ],
    ["Scheduled check-in", fmtDate(inv.stay.checkIn)],
    ["Scheduled check-out", fmtDate(inv.stay.checkOut)],
  ];
  for (const [k, v] of stay) {
    pdf.text(M, y, k, { size: 9, color: MUTED });
    pdf.text(M + 120, y, v, { size: 9, bold: true, color: INK });
    y += 13;
  }
  y += 8;

  // Credit items
  const colSac = M + 330;
  const colAmt = M;
  pdf.rect(M, y, CONTENT_W, 20, { fill: [0.95, 0.92, 0.92] });
  pdf.text(M + 8, y + 14, "Description (Credit Adjustment)", {
    size: 9,
    bold: true,
  });
  pdf.text(colSac, y + 14, "SAC", { size: 9, bold: true });
  pdf.text(colAmt, y + 14, "Credit Amount", {
    size: 9,
    bold: true,
    align: "right",
    width: CONTENT_W - 8,
  });
  y += 20;

  for (const line of inv.lines) {
    if (y > 700) {
      pdf.addPage();
      y = 60;
    }
    y += 16;
    pdf.text(M + 8, y, `Reversal of: ${line.description}`, {
      size: 9,
      color: INK,
    });
    pdf.text(colSac, y, line.sac || "-", { size: 9, color: MUTED });
    pdf.text(colAmt, y, `-${formatInr(line.amount)}`, {
      size: 9.5,
      align: "right",
      width: CONTENT_W - 8,
      color: INK,
    });
    pdf.line(M, y + 6, W - M, y + 6, { color: [0.9, 0.9, 0.9] });
  }
  y += 22;

  // Totals block (right aligned)
  const labelX = M + 280;
  const row = (label, value, { bold = false, rule = false } = {}) => {
    if (rule) pdf.line(labelX, y - 11, W - M, y - 11, { color: [0.6, 0.6, 0.6] });
    pdf.text(labelX, y, label, { size: 9.5, bold, color: INK });
    pdf.text(labelX, y, value, {
      size: 9.5,
      bold,
      align: "right",
      width: CONTENT_W - 280 - 8,
      color: INK,
    });
    y += 15;
  };

  row("Taxable value reversed", `-${formatInr(inv.taxableValue)}`);
  if (inv.docType === "TAX_INVOICE") {
    const half = (inv.gstRate || 0) / 2;
    row(`CGST reversed @ ${half}%`, `-${formatInr(inv.cgst || 0)}`);
    row(`SGST reversed @ ${half}%`, `-${formatInr(inv.sgst || 0)}`);
  }
  row(
    "Total credit adjustment",
    `-${formatInr(inv.invoiceValue)}`,
    { bold: true, rule: true },
  );

  y += 6;
  pdf.rect(labelX - 8, y - 11, CONTENT_W - 280 + 8, 22, {
    fill: [0.12, 0.04, 0.04],
  });
  pdf.text(labelX, y + 4, "Total refund credited", {
    size: 10,
    bold: true,
    color: [1, 1, 1],
  });
  pdf.text(
    labelX,
    y + 4,
    formatInr(inv.refundAmount !== undefined ? inv.refundAmount : inv.amountPaid),
    {
      size: 10,
      bold: true,
      align: "right",
      width: CONTENT_W - 280 - 8,
      color: [1, 1, 1],
    },
  );
  y += 32;

  // Statutory Footer
  y = Math.max(y + 20, 740);
  pdf.line(M, y, W - M, y);
  y += 14;
  const notes = [
    "This Credit Note is issued in accordance with the provisions of Section 34 of the CGST Act, 2017.",
    "The tax liability has been adjusted to the extent of supply cancellation and refund issued.",
    "This is an electronically generated document and does not require a physical signature.",
  ];
  for (const n of notes) {
    pdf.text(M, y, n, { size: 8, color: MUTED });
    y += 11;
  }

  return pdf.toBuffer();
}