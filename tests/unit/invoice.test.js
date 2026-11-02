import { describe, it, expect } from '@jest/globals';
import {
  isValidGstin,
  financialYearOf,
  formatInvoiceNumber,
  computeInvoiceFigures,
  pickDocumentType,
} from '../../src/utils/invoiceMath.js';
import { renderInvoicePdf } from '../../src/utils/invoicePdf.js';
import { SimplePdf, sanitizePdfText } from '../../src/utils/pdf.js';

describe('GSTIN validation', () => {
  it('accepts valid GSTINs and rejects bad format or check digit', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('29AAGCB7383J1Z4')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false); // wrong check digit
    expect(isValidGstin('NOTAGSTIN')).toBe(false);
    expect(isValidGstin('')).toBe(false);
  });
});

describe('invoice numbering', () => {
  it('uses the Indian financial year in IST', () => {
    expect(financialYearOf(new Date('2026-03-31T18:00:00Z'))).toBe('2025-26'); // 31 Mar 23:30 IST
    expect(financialYearOf(new Date('2026-03-31T19:00:00Z'))).toBe('2026-27'); // 1 Apr 00:30 IST
    expect(financialYearOf(new Date('2026-10-26T00:00:00Z'))).toBe('2026-27');
  });

  it('stays within the 16-character GST limit', () => {
    expect(formatInvoiceNumber('INV', '2026-27', 1)).toBe('INV/2627/00001');
    expect(formatInvoiceNumber('HTLX', '2026-27', 99999).length).toBeLessThanOrEqual(16);
  });
});

describe('invoice figures', () => {
  const billing = { roomBaseTariff: 10000, addOnsTotal: 1500, hotelGst: 1380, platformConvenienceFee: 49, grandTotal: 12929 };

  it('recovers the rate and splits tax into CGST + SGST', () => {
    const f = computeInvoiceFigures({ billing, selectedAddOns: [{ name: 'Breakfast', quantity: 2, subtotal: 1500 }] });
    expect(f.taxableValue).toBe(11500);
    expect(f.gstRate).toBe(12);
    expect(f.cgst + f.sgst).toBe(1380);
    expect(f.invoiceValue).toBe(12880);
    expect(f.grandTotal).toBe(12929);
    expect(f.lines).toHaveLength(2);
  });

  it('never loses a paisa on odd tax amounts', () => {
    const f = computeInvoiceFigures({ billing: { roomBaseTariff: 100, addOnsTotal: 0, hotelGst: 0.05, grandTotal: 100.05 } });
    expect(f.cgst + f.sgst).toBeCloseTo(0.05, 2);
  });

  it('issues the right kind of document', () => {
    expect(pickDocumentType({ gstin: '27AAPFU0939F1ZV', gstAmount: 10 })).toBe('TAX_INVOICE');
    expect(pickDocumentType({ gstin: '27AAPFU0939F1ZV', gstAmount: 0 })).toBe('BILL_OF_SUPPLY');
    expect(pickDocumentType({ gstin: '', gstAmount: 10 })).toBe('RECEIPT');
  });
});

describe('PDF output', () => {
  it('produces a well-formed PDF', () => {
    const buf = new SimplePdf().text(40, 60, 'Hello (world)').toBuffer();
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('Hello \\(world\\)');
  });

  it('replaces characters the built-in fonts cannot draw', () => {
    expect(sanitizePdfText('café ₹5')).toBe('cafe ?5');
  });

  it('renders an invoice', () => {
    const f = computeInvoiceFigures({ billing: { roomBaseTariff: 5000, addOnsTotal: 0, hotelGst: 600, platformConvenienceFee: 0, grandTotal: 5600 } });
    const pdf = renderInvoicePdf({
      docType: 'TAX_INVOICE', invoiceNumber: 'INV/2627/00001', issuedAt: new Date(), status: 'ACTIVE',
      bookingCode: 'BK-1', seller: { legalName: 'Test Hotel', gstin: '27AAPFU0939F1ZV', address: 'Addr' },
      buyer: { name: 'Guest', phone: '1' }, placeOfSupply: { state: 'AP', code: '37' },
      stay: { roomName: 'Deluxe', roomCount: 1, checkIn: new Date(), checkOut: new Date(), nights: 1, adults: 2, children: 0 },
      lines: f.lines, taxableValue: f.taxableValue, gstRate: f.gstRate, cgst: f.cgst, sgst: f.sgst,
      invoiceValue: f.invoiceValue, platformFee: 0, amountPaid: 5600, amountDue: 0,
    });
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.toString('latin1')).toContain('TAX INVOICE');
  });
});
