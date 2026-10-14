/**
 * src/app/api/dev/generate-review-receipts/route.ts
 *
 * Phase 7B-9I3 — Dev-only route to generate synthetic review PDFs into public/review/
 *
 * GET /api/dev/generate-review-receipts
 *
 * Uses IDENTICAL fixture data and renderer as scripts/testReceiptPdfDeterminism.js.
 * Writes output to:
 *   public/review/receipt-partial-polished.pdf
 *   public/review/receipt-paid-in-full-polished.pdf
 *
 * CONSTRAINTS:
 *   - Synthetic fixture data only
 *   - No Supabase calls
 *   - No receipt RPCs
 *   - No production data
 *   - Does NOT modify receiptPdf.ts or receiptPdfOrchestrator.ts
 *   - Does NOT modify production receipt EBR-2026-000001
 */

import { NextResponse } from 'next/server';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// ── Fixed PDF metadata date (same constant as receiptPdf.ts) ────────────────
const FIXED_PDF_METADATA_DATE = new Date('2000-01-01T00:00:00.000Z');

// ── Money formatter (integer cents only, no floating-point arithmetic) ───────
function formatMoney(cents: number, currency: string = 'USD'): string {
  const isNegative = cents < 0;
  const absCents = Math.abs(cents);
  const dollars = Math.floor(absCents / 100);
  const centsRemainder = absCents % 100;
  const dollarsStr = dollars.toString();
  let dollarsFormatted = '';
  for (let i = 0; i < dollarsStr.length; i++) {
    if (i > 0 && (dollarsStr.length - i) % 3 === 0) dollarsFormatted += ',';
    dollarsFormatted += dollarsStr[i];
  }
  const centsFormatted = centsRemainder.toString().padStart(2, '0');
  const symbol = currency === 'USD' ? '$' : (currency + ' ');
  const formatted = symbol + dollarsFormatted + '.' + centsFormatted;
  return isNegative ? ('-' + formatted) : formatted;
}

// ── Date formatter (from ISO 8601 input only) ────────────────────────────────
function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return months[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

// ── Payment method label ─────────────────────────────────────────────────────
function formatPaymentMethod(method: string): string {
  const labels: Record<string, string> = {
    bank_wire: 'Bank Wire',
    check: 'Check',
    ach: 'ACH',
    credit_card: 'Credit Card',
    other: 'Other',
  };
  return labels[method] || method.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Text wrap ────────────────────────────────────────────────────────────────
function wrapText(text: string, font: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>, fontSize: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const result: string[] = [];
  let currentLine = '';
  for (const word of words) {
    if (!word) continue;
    const testLine = currentLine ? (currentLine + ' ' + word) : word;
    if (font.widthOfTextAtSize(testLine, fontSize) <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) result.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) result.push(currentLine);
  return result;
}

interface FixtureInput {
  receipt_number: string;
  receipt_issued_at: string;
  payment_id: string;
  payment_amount_cents: number;
  payment_received_at: string;
  payment_method: string;
  payment_reference_number: string | null;
  payment_currency: string;
  amount_paid_after_cents: number;
  balance_remaining_after_cents: number;
  invoice_id: string;
  invoice_number: string;
  invoice_total_cents: number;
  invoice_issued_at: string;
  invoice_currency: string;
  billing_name: string | null;
  billing_contact_name: string | null;
  billing_address_line1: string | null;
  billing_address_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_postal_code: string | null;
  billing_country: string | null;
}

// ── Core renderer (mirrors receiptPdf.ts 7B-9I layout exactly) ──────────────
async function renderReceiptPdf(input: FixtureInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  pdfDoc.setTitle('EarnestBridge Receipt ' + input.receipt_number);
  pdfDoc.setAuthor('EarnestBridge');
  pdfDoc.setSubject('Payment Receipt');
  pdfDoc.setCreator('EarnestBridge');
  pdfDoc.setProducer('EarnestBridge');
  pdfDoc.setCreationDate(FIXED_PDF_METADATA_DATE);
  pdfDoc.setModificationDate(FIXED_PDF_METADATA_DATE);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_WIDTH = 612;
  const PAGE_HEIGHT = 792;
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const MARGIN_LEFT = 50;
  const MARGIN_RIGHT = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const SAFE_BOTTOM_MARGIN = 50;

  const COLOR_PAGE_BG      = rgb(0.97, 0.97, 0.94);
  const COLOR_EB_GREEN     = rgb(0.06, 0.18, 0.13);
  const COLOR_EB_GREEN_MED = rgb(0.22, 0.38, 0.28);
  const COLOR_DIVIDER      = rgb(0.82, 0.82, 0.78);
  const COLOR_SUMMARY_BOX  = rgb(0.93, 0.93, 0.90);
  const COLOR_DARK         = rgb(0.10, 0.10, 0.10);
  const COLOR_MEDIUM       = rgb(0.38, 0.38, 0.35);
  const COLOR_LIGHT        = rgb(0.55, 0.55, 0.52);

  page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: COLOR_PAGE_BG });
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 4, width: PAGE_WIDTH, height: 4, color: COLOR_EB_GREEN });

  let cursor = PAGE_HEIGHT - 4;
  const currency = input.payment_currency;

  // ── HEADER ────────────────────────────────────────────────────────────────
  cursor -= 34;
  page.drawText('EarnestBridge', { x: MARGIN_LEFT, y: cursor, size: 16, font: fontBold, color: COLOR_EB_GREEN });
  const receiptLabel = 'PAYMENT RECEIPT';
  page.drawText(receiptLabel, {
    x: PAGE_WIDTH - MARGIN_RIGHT - fontBold.widthOfTextAtSize(receiptLabel, 10),
    y: cursor, size: 10, font: fontBold, color: COLOR_EB_GREEN_MED,
  });
  cursor -= 8;
  page.drawText('Lock up the Deal.', { x: MARGIN_LEFT, y: cursor, size: 8, font: font, color: COLOR_MEDIUM });
  page.drawText(input.receipt_number, {
    x: PAGE_WIDTH - MARGIN_RIGHT - fontBold.widthOfTextAtSize(input.receipt_number, 11),
    y: cursor, size: 11, font: fontBold, color: COLOR_DARK,
  });
  cursor -= 10;
  const issuedDateStr = 'Issued ' + formatTimestamp(input.receipt_issued_at);
  page.drawText(issuedDateStr, {
    x: PAGE_WIDTH - MARGIN_RIGHT - font.widthOfTextAtSize(issuedDateStr, 8),
    y: cursor, size: 8, font: font, color: COLOR_MEDIUM,
  });
  cursor -= 14;
  page.drawLine({ start: { x: MARGIN_LEFT, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor }, thickness: 1.0, color: COLOR_EB_GREEN });
  cursor -= 18;

  // ── TWO-COLUMN DETAILS ────────────────────────────────────────────────────
  const COL_MID = MARGIN_LEFT + Math.floor(CONTENT_WIDTH / 2) + 4;
  const detailsStartCursor = cursor;

  page.drawText('INVOICE DETAILS', { x: MARGIN_LEFT, y: cursor, size: 7.5, font: fontBold, color: COLOR_EB_GREEN_MED });
  let leftCursor = cursor - 12;
  page.drawText('Invoice Number', { x: MARGIN_LEFT, y: leftCursor, size: 8, font: font, color: COLOR_MEDIUM });
  leftCursor -= 11;
  page.drawText(input.invoice_number, { x: MARGIN_LEFT, y: leftCursor, size: 8.5, font: fontBold, color: COLOR_DARK });
  leftCursor -= 13;
  page.drawText('Invoice Issued Date', { x: MARGIN_LEFT, y: leftCursor, size: 8, font: font, color: COLOR_MEDIUM });
  leftCursor -= 11;
  page.drawText(formatTimestamp(input.invoice_issued_at), { x: MARGIN_LEFT, y: leftCursor, size: 8.5, font: fontBold, color: COLOR_DARK });
  leftCursor -= 13;

  let rightCursor = detailsStartCursor;
  page.drawText('PAYMENT DETAILS', { x: COL_MID, y: rightCursor, size: 7.5, font: fontBold, color: COLOR_EB_GREEN_MED });
  rightCursor -= 12;
  page.drawText('Payment Received Date', { x: COL_MID, y: rightCursor, size: 8, font: font, color: COLOR_MEDIUM });
  rightCursor -= 11;
  page.drawText(formatTimestamp(input.payment_received_at), { x: COL_MID, y: rightCursor, size: 8.5, font: fontBold, color: COLOR_DARK });
  rightCursor -= 13;
  page.drawText('Payment Method', { x: COL_MID, y: rightCursor, size: 8, font: font, color: COLOR_MEDIUM });
  rightCursor -= 11;
  page.drawText(formatPaymentMethod(input.payment_method), { x: COL_MID, y: rightCursor, size: 8.5, font: fontBold, color: COLOR_DARK });
  rightCursor -= 13;
  if (input.payment_reference_number && input.payment_reference_number.trim() !== '') {
    page.drawText('Payment Reference', { x: COL_MID, y: rightCursor, size: 8, font: font, color: COLOR_MEDIUM });
    rightCursor -= 11;
    page.drawText(input.payment_reference_number.trim(), { x: COL_MID, y: rightCursor, size: 8.5, font: fontBold, color: COLOR_DARK });
    rightCursor -= 13;
  }

  cursor = Math.min(leftCursor, rightCursor) - 10;
  page.drawLine({ start: { x: MARGIN_LEFT, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor }, thickness: 0.5, color: COLOR_DIVIDER });
  cursor -= 16;

  // ── BILLED TO ─────────────────────────────────────────────────────────────
  page.drawText('BILLED TO', { x: MARGIN_LEFT, y: cursor, size: 7.5, font: fontBold, color: COLOR_EB_GREEN_MED });
  cursor -= 13;
  const billingNameTrimmed = (input.billing_name || '').trim();
  const billingContactTrimmed = (input.billing_contact_name || '').trim();
  if (billingNameTrimmed !== '') {
    page.drawText(billingNameTrimmed, { x: MARGIN_LEFT, y: cursor, size: 9, font: fontBold, color: COLOR_DARK });
    cursor -= 12;
  }
  if (billingContactTrimmed !== '' && billingContactTrimmed.toLowerCase() !== billingNameTrimmed.toLowerCase()) {
    page.drawText(billingContactTrimmed, { x: MARGIN_LEFT, y: cursor, size: 8.5, font: font, color: COLOR_DARK });
    cursor -= 12;
  }
  const addrParts: string[] = [];
  if (input.billing_address_line1?.trim()) addrParts.push(input.billing_address_line1.trim());
  if (input.billing_address_line2?.trim()) addrParts.push(input.billing_address_line2.trim());
  const csp: string[] = [];
  if (input.billing_city?.trim()) csp.push(input.billing_city.trim());
  if (input.billing_state?.trim()) {
    if (input.billing_postal_code?.trim()) {
      csp.push(input.billing_state.trim() + ' ' + input.billing_postal_code.trim());
    } else {
      csp.push(input.billing_state.trim());
    }
  } else if (input.billing_postal_code?.trim()) {
    csp.push(input.billing_postal_code.trim());
  }
  if (csp.length > 0) addrParts.push(csp.join(', '));
  if (input.billing_country?.trim()) addrParts.push(input.billing_country.trim());
  for (const part of addrParts) {
    page.drawText(part, { x: MARGIN_LEFT, y: cursor, size: 8.5, font: font, color: COLOR_MEDIUM });
    cursor -= 12;
  }
  cursor -= 8;
  page.drawLine({ start: { x: MARGIN_LEFT, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor }, thickness: 0.5, color: COLOR_DIVIDER });
  cursor -= 16;

  // ── FINANCIAL SUMMARY ─────────────────────────────────────────────────────
  page.drawText('FINANCIAL SUMMARY', { x: MARGIN_LEFT, y: cursor, size: 8, font: fontBold, color: COLOR_EB_GREEN_MED });
  const allAmountsLabel = 'ALL AMOUNTS ' + currency;
  page.drawText(allAmountsLabel, {
    x: PAGE_WIDTH - MARGIN_RIGHT - font.widthOfTextAtSize(allAmountsLabel, 7.5),
    y: cursor, size: 7.5, font: font, color: COLOR_MEDIUM,
  });
  cursor -= 14;

  const focalBoxHeight = 46;
  const focalBoxY = cursor - focalBoxHeight;
  page.drawRectangle({ x: MARGIN_LEFT, y: focalBoxY, width: CONTENT_WIDTH, height: focalBoxHeight, color: COLOR_SUMMARY_BOX });
  cursor -= 10;
  page.drawText('THIS PAYMENT', { x: MARGIN_LEFT + 12, y: cursor, size: 7.5, font: fontBold, color: COLOR_MEDIUM });
  cursor -= 18;
  const paymentAmountStr = formatMoney(input.payment_amount_cents, currency);
  page.drawText(paymentAmountStr, { x: MARGIN_LEFT + 12, y: cursor, size: 18, font: fontBold, color: COLOR_EB_GREEN });
  cursor = focalBoxY - 12;

  const summaryRowH = 16;
  function drawCompactRow(label: string, value: string, lFont: typeof font, vFont: typeof font, lColor: ReturnType<typeof rgb>, vColor: ReturnType<typeof rgb>) {
    page.drawText(label, { x: MARGIN_LEFT + 10, y: cursor, size: 8.5, font: lFont, color: lColor });
    const vw = vFont.widthOfTextAtSize(value, 8.5);
    page.drawText(value, { x: PAGE_WIDTH - MARGIN_RIGHT - 10 - vw, y: cursor, size: 8.5, font: vFont, color: vColor });
    cursor -= summaryRowH;
  }

  drawCompactRow('Invoice Total', formatMoney(input.invoice_total_cents, currency), font, font, COLOR_MEDIUM, COLOR_DARK);
  drawCompactRow('Amount Paid After This Payment', formatMoney(input.amount_paid_after_cents, currency), font, font, COLOR_MEDIUM, COLOR_DARK);
  const isPaidInFull = input.balance_remaining_after_cents === 0;
  drawCompactRow('Balance Remaining', formatMoney(input.balance_remaining_after_cents, currency), font, fontBold, COLOR_MEDIUM, isPaidInFull ? COLOR_EB_GREEN_MED : COLOR_DARK);
  cursor -= 14;

  // ── CONFIRMATION SENTENCE ─────────────────────────────────────────────────
  let confirmationText: string;
  if (isPaidInFull) {
    confirmationText = 'This receipt confirms the payment shown above was received and applied to the referenced invoice. The invoice balance is now $0.00.';
  } else {
    const balanceStr = formatMoney(input.balance_remaining_after_cents, currency);
    confirmationText = 'This receipt confirms the payment shown above was received and applied to the referenced invoice. A balance of ' + balanceStr + ' remains.';
  }
  const confirmLines = wrapText(confirmationText, font, 8, CONTENT_WIDTH);
  for (const line of confirmLines) {
    page.drawText(line, { x: MARGIN_LEFT, y: cursor, size: 8, font: font, color: COLOR_MEDIUM });
    cursor -= 12;
  }

  // ── FOOTER ────────────────────────────────────────────────────────────────
  const FOOTER_Y = SAFE_BOTTOM_MARGIN + 16;
  page.drawLine({ start: { x: MARGIN_LEFT, y: FOOTER_Y + 12 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: FOOTER_Y + 12 }, thickness: 0.5, color: COLOR_DIVIDER });
  const footerStr = 'EarnestBridge  \u00b7  Payment Receipt \u00b7 ' + input.receipt_number;
  const footerWidth = font.widthOfTextAtSize(footerStr, 7.5);
  const footerX = MARGIN_LEFT + (CONTENT_WIDTH - footerWidth) / 2;
  page.drawText(footerStr, { x: footerX, y: FOOTER_Y, size: 7.5, font: font, color: COLOR_LIGHT });

  return await pdfDoc.save();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── SYNTHETIC FIXTURE DATA (identical to testReceiptPdfDeterminism.js) ───────

const FIXTURE_PARTIAL: FixtureInput = {
  receipt_number: 'EBR-2026-TEST-001',
  receipt_issued_at: '2026-10-14T14:30:00.000Z',
  payment_id: '00000000-0000-0000-0000-000000000001',
  payment_amount_cents: 100,
  payment_received_at: '2026-10-01T10:00:00.000Z',
  payment_method: 'bank_wire',
  payment_reference_number: 'REF-TEST-001',
  payment_currency: 'USD',
  amount_paid_after_cents: 100,
  balance_remaining_after_cents: 749900,
  invoice_id: '00000000-0000-0000-0000-000000000002',
  invoice_number: 'EB-2026-TEST-001-B',
  invoice_total_cents: 750000,
  invoice_issued_at: '2026-09-15T00:00:00.000Z',
  invoice_currency: 'USD',
  billing_name: 'Acme Holdings LLC',
  billing_contact_name: 'Jane Doe',
  billing_address_line1: '123 Main Street',
  billing_address_line2: 'Suite 400',
  billing_city: 'New York',
  billing_state: 'NY',
  billing_postal_code: '10001',
  billing_country: 'United States',
};

const FIXTURE_PAID_IN_FULL: FixtureInput = {
  receipt_number: 'EBR-2026-TEST-002',
  receipt_issued_at: '2026-10-14T15:00:00.000Z',
  payment_id: '00000000-0000-0000-0000-000000000003',
  payment_amount_cents: 750000,
  payment_received_at: '2026-10-14T09:00:00.000Z',
  payment_method: 'bank_wire',
  payment_reference_number: null,
  payment_currency: 'USD',
  amount_paid_after_cents: 750000,
  balance_remaining_after_cents: 0,
  invoice_id: '00000000-0000-0000-0000-000000000004',
  invoice_number: 'EB-2026-TEST-002-A',
  invoice_total_cents: 750000,
  invoice_issued_at: '2026-09-20T00:00:00.000Z',
  invoice_currency: 'USD',
  billing_name: 'Beta Corp',
  billing_contact_name: 'Beta Corp',
  billing_address_line1: '456 Commerce Ave',
  billing_address_line2: null,
  billing_city: 'Chicago',
  billing_state: 'IL',
  billing_postal_code: '60601',
  billing_country: 'United States',
};

export async function GET() {
  try {
    const OUTPUT_DIR = path.join(process.cwd(), 'public', 'review');

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const PARTIAL_PATH = path.join(OUTPUT_DIR, 'receipt-partial-polished.pdf');
    const PAID_PATH = path.join(OUTPUT_DIR, 'receipt-paid-in-full-polished.pdf');

    // Render both fixtures (double-render for determinism check)
    const bytesA1 = await renderReceiptPdf(FIXTURE_PARTIAL);
    const bytesA2 = await renderReceiptPdf(FIXTURE_PARTIAL);
    const bytesB1 = await renderReceiptPdf(FIXTURE_PAID_IN_FULL);
    const bytesB2 = await renderReceiptPdf(FIXTURE_PAID_IN_FULL);

    const hashA1 = sha256Hex(bytesA1);
    const hashA2 = sha256Hex(bytesA2);
    const hashB1 = sha256Hex(bytesB1);
    const hashB2 = sha256Hex(bytesB2);

    const deterministicA = hashA1 === hashA2;
    const deterministicB = hashB1 === hashB2;

    // Write PDFs to public/review/
    fs.writeFileSync(PARTIAL_PATH, Buffer.from(bytesA1));
    fs.writeFileSync(PAID_PATH, Buffer.from(bytesB1));

    const statA = fs.statSync(PARTIAL_PATH);
    const statB = fs.statSync(PAID_PATH);

    const allPass = deterministicA && deterministicB && statA.size > 0 && statB.size > 0;

    return NextResponse.json({
      status: allPass ? 'PASS' : 'FAIL',
      message: 'REVIEW PDFs GENERATED: ' + (allPass ? 'PASS' : 'FAIL'),
      files_created: [
        'public/review/receipt-partial-polished.pdf',
        'public/review/receipt-paid-in-full-polished.pdf',
      ],
      fixture_a_partial: {
        file: 'public/review/receipt-partial-polished.pdf',
        preview_url: '/review/receipt-partial-polished.pdf',
        byte_length: bytesA1.length,
        file_size_on_disk: statA.size,
        sha256_render1: hashA1,
        sha256_render2: hashA2,
        bytes_identical: deterministicA,
      },
      fixture_b_paid_in_full: {
        file: 'public/review/receipt-paid-in-full-polished.pdf',
        preview_url: '/review/receipt-paid-in-full-polished.pdf',
        byte_length: bytesB1.length,
        file_size_on_disk: statB.size,
        sha256_render1: hashB1,
        sha256_render2: hashB2,
        bytes_identical: deterministicB,
      },
      source_files_modified: [],
      production_rpcs_invoked: 0,
      production_database_rows_modified: 0,
      production_pdfs_modified: 0,
      netlify_deployed: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: 'FAIL', error: message }, { status: 500 });
  }
}
