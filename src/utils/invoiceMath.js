/**
 * Pure helpers for GST invoices (no database access, easy to test).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const INVOICE_PREFIX_PATTERN = /^[A-Z0-9]{1,4}$/;

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Standard 2-digit Indian State & Union Territory Codes under GST:
 */
export const GST_STATE_CODES = new Set([
  "01", // Jammu & Kashmir
  "02", // Himachal Pradesh
  "03", // Punjab
  "04", // Chandigarh
  "05", // Uttarakhand
  "06", // Haryana
  "07", // Delhi
  "08", // Rajasthan
  "09", // Uttar Pradesh
  "10", // Bihar
  "11", // Sikkim
  "12", // Arunachal Pradesh
  "13", // Nagaland
  "14", // Manipur
  "15", // Mizoram
  "16", // Tripura
  "17", // Meghalaya
  "18", // Assam
  "19", // West Bengal
  "20", // Jharkhand
  "21", // Odisha
  "22", // Chhattisgarh
  "23", // Madhya Pradesh
  "24", // Gujarat
  "26", // Dadra & Nagar Haveli and Daman & Diu
  "27", // Maharashtra
  "29", // Karnataka
  "30", // Goa
  "31", // Lakshadweep
  "32", // Kerala
  "33", // Tamil Nadu
  "34", // Puducherry
  "35", // Andaman & Nicobar Islands
  "36", // Telangana
  "37", // Andhra Pradesh
  "38", // Ladakh
  "97", // Other Territory
]);

/**
 * Checks format, valid Indian state code, and GSTIN checksum digit.
 */
export function isValidGstin(value) {
  const g = String(value || "")
    .trim()
    .toUpperCase();

  // 1. Regex check
  if (!GSTIN_PATTERN.test(g)) return false;

  // 2. State code check
  const stateCode = g.slice(0, 2);
  if (!GST_STATE_CODES.has(stateCode)) return false;

  // 3. Modulo-36 Checksum verification
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GSTIN_CHARS.indexOf(g[i]);
    const factor = i % 2 === 0 ? 1 : 2;
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  return check === g[14];
}

export const stateCodeFromGstin = (gstin) => String(gstin || "").slice(0, 2);

/** Indian financial year (Apr-Mar) of a moment, in IST. e.g. "2026-27". */
export function financialYearOf(date = new Date()) {
  const ist = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const startYear = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * GST rules cap an invoice number at 16 characters of letters, digits, "/" and "-".
 * Format: PREFIX/FYFY/00001 e.g. "INV/2627/00001" (14 chars with a 3-letter prefix).
 */
export function formatInvoiceNumber(prefix, financialYear, seq) {
  const [start, end] = financialYear.split("-");
  const fyShort = `${start.slice(2)}${end}`;
  return `${prefix}/${fyShort}/${String(seq).padStart(5, "0")}`;
}

export const round2 = (n) =>
  Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const formatInr = (n) =>
  `INR ${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n) || 0)}`;

/**
 * Decides what kind of document the hotel may legally issue.
 * Tax invoice needs a GSTIN and tax charged; with a GSTIN but no tax it is a
 * bill of supply; without a GSTIN we can only give a plain receipt.
 */
export function pickDocumentType({ gstin, gstAmount }) {
  if (gstin && gstAmount > 0) return "TAX_INVOICE";
  if (gstin) return "BILL_OF_SUPPLY";
  return "RECEIPT";
}

export const DOCUMENT_TITLES = {
  TAX_INVOICE: "TAX INVOICE",
  BILL_OF_SUPPLY: "BILL OF SUPPLY",
  RECEIPT: "RECEIPT",
};

/**
 * Splits stored booking billing into invoice figures.
 * The system charges one GST rate on room tariff and add-ons, so the rate is
 * recovered from what was actually charged. Hotel services are supplied at the
 * hotel's location, so tax is always split equally into CGST + SGST.
 */
export function computeInvoiceFigures({ billing, selectedAddOns = [] }) {
  const roomBase = round2(billing?.roomBaseTariff);
  const addOnsTotal = round2(billing?.addOnsTotal);
  const taxableValue = round2(roomBase + addOnsTotal);
  const gst = round2(billing?.hotelGst);
  const platformFee = round2(billing?.platformConvenienceFee);
  const gstRate =
    taxableValue > 0 && gst > 0 ? round2((gst / taxableValue) * 100) : 0;

  const cgst = round2(gst / 2);
  const sgst = round2(gst - cgst);

  const lines = [
    { description: "Room accommodation", sac: "996311", amount: roomBase },
  ];
  for (const a of selectedAddOns) {
    const amount = round2(
      a.subtotal ?? Number(a.price) * Number(a.quantity || 1),
    );
    if (amount > 0) {
      lines.push({
        description: `${a.name}${a.quantity > 1 ? ` x ${a.quantity}` : ""}`,
        sac: "9963",
        amount,
      });
    }
  }

  return {
    lines,
    taxableValue,
    gstRate,
    cgst,
    sgst,
    gstTotal: gst,
    invoiceValue: round2(taxableValue + gst),
    platformFee,
    grandTotal: round2(taxableValue + gst + platformFee),
  };
}
