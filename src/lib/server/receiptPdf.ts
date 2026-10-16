/**
 * src/lib/server/receiptPdf.ts
 *
 * Phase: 7B-9L — Receipt PDF Renderer (Approved V2 Design)
 *
 * Pure server-side receipt PDF renderer.
 *
 * SERVER-ONLY. Must never be imported into a Client Component bundle.
 *
 * This module is a PURE FUNCTION:
 *   ReceiptPdfInput → deterministic PDF bytes (Uint8Array)
 *
 * It does NOT:
 *   - query Supabase
 *   - call any RPC
 *   - access browser APIs
 *   - upload files
 *   - modify database state
 *   - call now() or new Date() without an input value for displayed dates
 *   - generate random IDs
 *
 * DETERMINISM GUARANTEE
 * ---------------------
 * Before pdfDoc.save(), all four auto-generated pdf-lib metadata fields are
 * explicitly overridden with a fixed constant epoch anchor date:
 *
 *   FIXED_PDF_METADATA_DATE = new Date('2000-01-01T00:00:00.000Z')
 *
 * This prevents pdf-lib from injecting the current wall-clock time into
 * CreationDate / ModificationDate / Creator / Producer, which would make
 * PDF bytes differ between renders of the same snapshot.
 *
 * MONEY FORMATTING
 * ----------------
 * Integer cents only. No floating-point arithmetic.
 *   750000 → $7,500.00
 *   100    → $1.00
 *   0      → $0.00
 *
 * DATE FORMATTING
 * ---------------
 * All displayed dates come exclusively from input fields:
 *   receipt_issued_at   → Issued date (header)
 *   payment_received_at → Payment received date
 *   invoice_issued_at   → Invoice issued date
 * The renderer never calls new Date() for displayed dates.
 *
 * PAYMENT METHOD LABELS
 * ---------------------
 *   bank_wire   → Bank Wire
 *   check       → Check
 *   ach         → ACH
 *   credit_card → Credit Card
 *   other       → Other
 *
 * LAYOUT (7B-9L — Approved V2)
 * ----------------------------
 * 1. Full-width dark green header band (~78pt)
 *    LEFT:  EarnestBridge / Lock up the Deal.
 *    RIGHT: PAYMENT RECEIPT / {receipt_number} / Issued {date}
 *
 * 2. Payment hero card
 *    Status badge: PAID IN FULL (green) or PARTIAL PAYMENT (neutral)
 *    PAYMENT RECEIVED label
 *    Large payment amount
 *    {payment date} · {payment method}
 *    Reference: {ref} (if present)
 *
 * 3. Two side-by-side info cards
 *    LEFT  — INVOICE: Invoice Number, Invoice Date
 *    RIGHT — PAYMENT: Received, Method, Reference (if present)
 *
 * 4. Full-width BILLED TO card
 *    billing_name
 *    billing_contact_name (only if non-empty AND different from billing_name)
 *    address lines
 *
 * 5. Account summary card
 *    Invoice Total / This Payment / Total Paid / Balance Remaining
 *    Right-aligned monetary values
 *    Balance Remaining strongest row
 *    $0.00 in EB green when paid in full
 *
 * 6. Single confirmation sentence
 *    Partial: "Payment received and applied to invoice {n}. Remaining balance: {b}."
 *    Full:    "Payment received and applied to invoice {n}. This invoice is paid in full."
 *
 * 7. Minimal footer
 *    Rule + "EarnestBridge · Payment Receipt · {receipt_number}"
 */

import 'server-only';

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Fixed PDF metadata date — NEVER changes between renders.
// ---------------------------------------------------------------------------

const FIXED_PDF_METADATA_DATE = new Date('2000-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Safe renderer error codes
// ---------------------------------------------------------------------------

export type ReceiptPdfErrorCode =
  | 'RECEIPT_PDF_INVALID_DATA' |'RECEIPT_PDF_CONTENT_OVERFLOW' |'RECEIPT_PDF_RENDER_ERROR';

export class ReceiptPdfError extends Error {
  public readonly code: ReceiptPdfErrorCode;

  constructor(code: ReceiptPdfErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'ReceiptPdfError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// ReceiptPdfInput
// ---------------------------------------------------------------------------

export interface ReceiptPdfInput {
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

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateInput(input: ReceiptPdfInput): void {
  const missing: string[] = [];

  if (!input.receipt_number) missing.push('receipt_number');
  if (!input.receipt_issued_at) missing.push('receipt_issued_at');
  if (!input.payment_id) missing.push('payment_id');
  if (!input.payment_received_at) missing.push('payment_received_at');
  if (!input.payment_method) missing.push('payment_method');
  if (!input.payment_currency) missing.push('payment_currency');
  if (!input.invoice_id) missing.push('invoice_id');
  if (!input.invoice_number) missing.push('invoice_number');
  if (!input.invoice_issued_at) missing.push('invoice_issued_at');
  if (!input.invoice_currency) missing.push('invoice_currency');

  if (missing.length > 0) {
    throw new ReceiptPdfError(
      'RECEIPT_PDF_INVALID_DATA',
      `Missing required render fields: ${missing.join(', ')}`,
    );
  }

  const tsFields: Array<[string, string]> = [
    [input.receipt_issued_at, 'receipt_issued_at'],
    [input.payment_received_at, 'payment_received_at'],
    [input.invoice_issued_at, 'invoice_issued_at'],
  ];
  for (const [val, name] of tsFields) {
    const d = new Date(val);
    if (isNaN(d.getTime())) {
      throw new ReceiptPdfError(
        'RECEIPT_PDF_INVALID_DATA',
        `Field ${name} is not a valid timestamp.`,
      );
    }
  }

  const moneyFields: Array<[number, string]> = [
    [input.payment_amount_cents, 'payment_amount_cents'],
    [input.amount_paid_after_cents, 'amount_paid_after_cents'],
    [input.balance_remaining_after_cents, 'balance_remaining_after_cents'],
    [input.invoice_total_cents, 'invoice_total_cents'],
  ];
  for (const [val, name] of moneyFields) {
    if (val == null || !Number.isSafeInteger(val)) {
      throw new ReceiptPdfError(
        'RECEIPT_PDF_INVALID_DATA',
        `Field ${name} must be a safe integer.`,
      );
    }
    if (val < 0) {
      throw new ReceiptPdfError(
        'RECEIPT_PDF_INVALID_DATA',
        `Field ${name} must be >= 0.`,
      );
    }
  }

  if (input.payment_amount_cents <= 0) {
    throw new ReceiptPdfError(
      'RECEIPT_PDF_INVALID_DATA',
      'payment_amount_cents must be > 0.',
    );
  }
}

// ---------------------------------------------------------------------------
// Money formatting — integer cents only
// ---------------------------------------------------------------------------

function formatMoney(cents: number, currency: string = 'USD'): string {
  const isNegative = cents < 0;
  const absCents = Math.abs(cents);
  const dollars = Math.floor(absCents / 100);
  const centsRemainder = absCents % 100;

  const dollarsStr = dollars.toString();
  let dollarsFormatted = '';
  for (let i = 0; i < dollarsStr.length; i++) {
    if (i > 0 && (dollarsStr.length - i) % 3 === 0) {
      dollarsFormatted += ',';
    }
    dollarsFormatted += dollarsStr[i];
  }

  const centsFormatted = centsRemainder.toString().padStart(2, '0');
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const formatted = `${symbol}${dollarsFormatted}.${centsFormatted}`;
  return isNegative ? `-${formatted}` : formatted;
}

// ---------------------------------------------------------------------------
// Date formatting — from ISO 8601 input only
// ---------------------------------------------------------------------------

function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Payment method label
// ---------------------------------------------------------------------------

function formatPaymentMethod(method: string): string {
  const labels: Record<string, string> = {
    bank_wire: 'Bank Wire',
    check: 'Check',
    ach: 'ACH',
    credit_card: 'Credit Card',
    other: 'Other',
  };
  return labels[method] ?? method.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Text wrapping helper
// ---------------------------------------------------------------------------

function wrapText(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const words = text.split(' ');
  const result: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!word) continue;
    const testLine = currentLine ? `${currentLine} ${word}` : word;
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

// ---------------------------------------------------------------------------
// Safe wrapping — wrapText + deterministic character-level fallback for
// unbroken tokens wider than maxWidth. Never truncates; never overflows.
// ---------------------------------------------------------------------------

function wrapTextSafe(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const baseLines = wrapText(text, font, fontSize, maxWidth);
  const result: string[] = [];

  for (const line of baseLines) {
    if (font.widthOfTextAtSize(line, fontSize) <= maxWidth) {
      result.push(line);
      continue;
    }

    // Line is a single over-wide token (or contains one) — break by character.
    // Re-split on spaces so normal words stay intact where possible.
    const words = line.split(' ');
    let current = '';
    for (const word of words) {
      if (!word) continue;
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) {
        result.push(current);
        current = '';
      }
      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        current = word;
        continue;
      }
      // Character-level split of an over-wide word
      let chunk = '';
      for (const ch of Array.from(word)) {
        const next = chunk + ch;
        if (chunk && font.widthOfTextAtSize(next, fontSize) > maxWidth) {
          result.push(chunk);
          chunk = ch;
        } else {
          chunk = next;
        }
      }
      current = chunk;
    }
    if (current) result.push(current);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main renderer — pure function, deterministic output
// ---------------------------------------------------------------------------

export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Uint8Array> {
  try {
    validateInput(input);
  } catch (err) {
    if (err instanceof ReceiptPdfError) throw err;
    throw new ReceiptPdfError('RECEIPT_PDF_INVALID_DATA', 'Input validation failed.');
  }

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.create();
  } catch {
    throw new ReceiptPdfError('RECEIPT_PDF_RENDER_ERROR', 'Failed to create PDF document.');
  }

  // Deterministic metadata
  pdfDoc.setTitle(`EarnestBridge Receipt ${input.receipt_number}`);
  pdfDoc.setAuthor('EarnestBridge');
  pdfDoc.setSubject('Payment Receipt');
  pdfDoc.setCreator('EarnestBridge');
  pdfDoc.setProducer('EarnestBridge');
  pdfDoc.setCreationDate(FIXED_PDF_METADATA_DATE);
  pdfDoc.setModificationDate(FIXED_PDF_METADATA_DATE);

  let font: PDFFont;
  let fontBold: PDFFont;
  try {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  } catch {
    throw new ReceiptPdfError('RECEIPT_PDF_RENDER_ERROR', 'Failed to embed fonts.');
  }

  // US Letter
  const PAGE_W = 612;
  const PAGE_H = 792;
  const page: PDFPage = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // Layout constants
  const ML = 40;           // margin left
  const MR = 40;           // margin right
  const CW = PAGE_W - ML - MR; // content width = 532
  const SAFE_BOT = 48;

  // ── Color palette ──────────────────────────────────────────────────────────
  const C_WHITE        = rgb(1.00, 1.00, 1.00);
  const C_PAGE_BG      = rgb(0.97, 0.97, 0.95);
  const C_EB_GREEN     = rgb(0.06, 0.18, 0.13);  // dark header green
  const C_EB_GREEN_MED = rgb(0.18, 0.38, 0.26);  // medium green (badges, accents)
  const C_EB_GREEN_LT  = rgb(0.88, 0.95, 0.90);  // light green badge bg
  const C_CARD_BG      = rgb(1.00, 1.00, 1.00);  // card background
  const C_CARD_BG2     = rgb(0.96, 0.97, 0.96);  // slightly tinted card
  const C_DIVIDER      = rgb(0.84, 0.84, 0.82);
  const C_DARK         = rgb(0.10, 0.10, 0.10);
  const C_MEDIUM       = rgb(0.40, 0.40, 0.38);
  const C_LIGHT        = rgb(0.58, 0.58, 0.56);
  const C_NEUTRAL_BADGE_BG = rgb(0.92, 0.92, 0.90);
  const C_NEUTRAL_BADGE_FG = rgb(0.35, 0.35, 0.33);

  // Page background
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C_PAGE_BG });

  const isPaidInFull = input.balance_remaining_after_cents === 0;
  const currency = input.payment_currency;

  // ── CURSOR ─────────────────────────────────────────────────────────────────
  let y = PAGE_H;

  // ── 1. FULL-WIDTH DARK GREEN HEADER BAND ──────────────────────────────────
  // Approx 78pt height
  const HEADER_H = 78;
  const HEADER_Y = PAGE_H - HEADER_H;

  page.drawRectangle({ x: 0, y: HEADER_Y, width: PAGE_W, height: HEADER_H, color: C_EB_GREEN });

  // LEFT side: EarnestBridge wordmark + tagline
  const wordmarkY = HEADER_Y + 46;
  page.drawText('EarnestBridge', {
    x: ML, y: wordmarkY,
    size: 17, font: fontBold, color: C_WHITE,
  });
  page.drawText('Lock up the Deal.', {
    x: ML, y: wordmarkY - 16,
    size: 8.5, font, color: rgb(0.78, 0.88, 0.82),
  });

  // RIGHT side: PAYMENT RECEIPT / receipt_number / Issued date
  const receiptTitleStr = 'PAYMENT RECEIPT';
  const receiptNumStr = input.receipt_number;
  const issuedStr = `Issued ${formatTimestamp(input.receipt_issued_at)}`;

  const receiptTitleW = fontBold.widthOfTextAtSize(receiptTitleStr, 9);
  const receiptNumW = fontBold.widthOfTextAtSize(receiptNumStr, 12);
  const issuedW = font.widthOfTextAtSize(issuedStr, 8);

  const RIGHT_X = PAGE_W - MR;

  page.drawText(receiptTitleStr, {
    x: RIGHT_X - receiptTitleW, y: wordmarkY,
    size: 9, font: fontBold, color: rgb(0.72, 0.85, 0.78),
  });
  page.drawText(receiptNumStr, {
    x: RIGHT_X - receiptNumW, y: wordmarkY - 15,
    size: 12, font: fontBold, color: C_WHITE,
  });
  page.drawText(issuedStr, {
    x: RIGHT_X - issuedW, y: wordmarkY - 28,
    size: 8, font, color: rgb(0.72, 0.85, 0.78),
  });

  y = HEADER_Y - 14;

  // ── 2. PAYMENT HERO CARD ──────────────────────────────────────────────────
  // Status badge + PAYMENT RECEIVED + large amount + date · method + reference
  const refTrimmed = input.payment_reference_number?.trim() ?? '';
  const hasReference = refTrimmed !== '';

  // Hero reference: wrap within the card's inner width (card width minus 16pt padding each side)
  const HERO_REF_SIZE = 7.5;
  const HERO_REF_LINE_H = 10;
  const HERO_INNER_W = CW - 32;
  const heroRefLines: string[] = hasReference
    ? wrapTextSafe(`Reference: ${refTrimmed}`, font, HERO_REF_SIZE, HERO_INNER_W)
    : [];
  const HERO_BASE_H = 100;
  const HERO_EXTRA_H = heroRefLines.length > 1 ? (heroRefLines.length - 1) * HERO_REF_LINE_H : 0;
  const HERO_CARD_H = HERO_BASE_H + HERO_EXTRA_H;
  const HERO_CARD_Y = y - HERO_CARD_H;

  page.drawRectangle({
    x: ML, y: HERO_CARD_Y,
    width: CW, height: HERO_CARD_H,
    color: C_CARD_BG,
  });
  // Card border
  page.drawRectangle({
    x: ML, y: HERO_CARD_Y,
    width: CW, height: HERO_CARD_H,
    color: C_DIVIDER,
    borderWidth: 0.5,
    borderColor: C_DIVIDER,
  });

  // Status badge
  const badgeText = isPaidInFull ? 'PAID IN FULL' : 'PARTIAL PAYMENT';
  const badgeBgColor = isPaidInFull ? C_EB_GREEN_LT : C_NEUTRAL_BADGE_BG;
  const badgeFgColor = isPaidInFull ? C_EB_GREEN_MED : C_NEUTRAL_BADGE_FG;
  const badgeTextW = fontBold.widthOfTextAtSize(badgeText, 7.5);
  const badgePadX = 8;
  const badgePadY = 4;
  const badgeW = badgeTextW + badgePadX * 2;
  const badgeH = 14;
  const badgeX = ML + 16;
  const badgeY = HERO_CARD_Y + HERO_CARD_H - 20;

  page.drawRectangle({
    x: badgeX, y: badgeY - badgePadY,
    width: badgeW, height: badgeH,
    color: badgeBgColor,
  });
  page.drawText(badgeText, {
    x: badgeX + badgePadX, y: badgeY,
    size: 7.5, font: fontBold, color: badgeFgColor,
  });

  // PAYMENT RECEIVED label
  const prLabelY = badgeY - 18;
  page.drawText('PAYMENT RECEIVED', {
    x: ML + 16, y: prLabelY,
    size: 7.5, font: fontBold, color: C_MEDIUM,
  });

  // Large payment amount
  const amountStr = formatMoney(input.payment_amount_cents, currency);
  const amountY = prLabelY - 22;
  page.drawText(amountStr, {
    x: ML + 16, y: amountY,
    size: 22, font: fontBold, color: C_EB_GREEN,
  });

  // Date · Method line
  const dateMethodStr = `${formatTimestamp(input.payment_received_at)}  ·  ${formatPaymentMethod(input.payment_method)}`;
  const dateMethodY = amountY - 16;
  page.drawText(dateMethodStr, {
    x: ML + 16, y: dateMethodY,
    size: 8, font, color: C_MEDIUM,
  });

  // Reference (if present)
  if (heroRefLines.length > 0) {
    let refY = dateMethodY - 12;
    for (const refLine of heroRefLines) {
      page.drawText(refLine, {
        x: ML + 16, y: refY,
        size: HERO_REF_SIZE, font, color: C_LIGHT,
      });
      refY -= HERO_REF_LINE_H;
    }
  }

  y = HERO_CARD_Y - 12;

  // ── 3. TWO SIDE-BY-SIDE INFO CARDS ────────────────────────────────────────
  // LEFT — INVOICE card
  // RIGHT — PAYMENT card
  const INFO_CARD_GAP = 10;
  const INFO_CARD_W = (CW - INFO_CARD_GAP) / 2;

  // Content-aware height. Column heights are measured from the card top to the
  // bottom of the last baseline, plus the bottom padding implied by the
  // original design (72pt card vs. 64pt of content = 8pt).
  const INFO_CARD_MIN_H = 72;
  const INFO_CARD_BOTTOM_PAD = 8;
  const INFO_INNER_W = INFO_CARD_W - 24; // 12pt padding each side
  const PAY_REF_LINE_H = 11;

  // INVOICE column: title(14) + label(14) + value(11) + gap(14) + label(11) + value => 64pt to last baseline
  const invoiceColContentH = 14 + 14 + 11 + 14 + 11;

  // PAYMENT column: same base rows as INVOICE, plus optional Reference block
  const payRefLines: string[] = hasReference
    ? wrapTextSafe(refTrimmed, fontBold, 8.5, INFO_INNER_W)
    : [];
  const paymentBaseContentH = 14 + 14 + 11 + 14 + 11; // title, Received, Method rows (last baseline)
  const paymentColContentH =
    payRefLines.length > 0
      ? paymentBaseContentH + 14 + 11 + (payRefLines.length - 1) * PAY_REF_LINE_H
      : paymentBaseContentH;

  const INFO_CARD_H = Math.max(
    INFO_CARD_MIN_H,
    Math.max(invoiceColContentH, paymentColContentH) + INFO_CARD_BOTTOM_PAD,
  );
  const INFO_CARD_Y = y - INFO_CARD_H;

  const LEFT_CARD_X = ML;
  const RIGHT_CARD_X = ML + INFO_CARD_W + INFO_CARD_GAP;

  // Draw both card backgrounds
  page.drawRectangle({ x: LEFT_CARD_X, y: INFO_CARD_Y, width: INFO_CARD_W, height: INFO_CARD_H, color: C_CARD_BG2 });
  page.drawRectangle({ x: RIGHT_CARD_X, y: INFO_CARD_Y, width: INFO_CARD_W, height: INFO_CARD_H, color: C_CARD_BG2 });

  // LEFT card — INVOICE
  const LC_INNER_X = LEFT_CARD_X + 12;
  let lcY = INFO_CARD_Y + INFO_CARD_H - 14;

  page.drawText('INVOICE', {
    x: LC_INNER_X, y: lcY,
    size: 7, font: fontBold, color: C_EB_GREEN_MED,
  });
  lcY -= 14;

  page.drawText('Invoice Number', { x: LC_INNER_X, y: lcY, size: 7.5, font, color: C_MEDIUM });
  lcY -= 11;
  page.drawText(input.invoice_number, { x: LC_INNER_X, y: lcY, size: 8.5, font: fontBold, color: C_DARK });
  lcY -= 14;

  page.drawText('Invoice Date', { x: LC_INNER_X, y: lcY, size: 7.5, font, color: C_MEDIUM });
  lcY -= 11;
  page.drawText(formatTimestamp(input.invoice_issued_at), { x: LC_INNER_X, y: lcY, size: 8.5, font: fontBold, color: C_DARK });

  // RIGHT card — PAYMENT
  const RC_INNER_X = RIGHT_CARD_X + 12;
  let rcY = INFO_CARD_Y + INFO_CARD_H - 14;

  page.drawText('PAYMENT', {
    x: RC_INNER_X, y: rcY,
    size: 7, font: fontBold, color: C_EB_GREEN_MED,
  });
  rcY -= 14;

  page.drawText('Received', { x: RC_INNER_X, y: rcY, size: 7.5, font, color: C_MEDIUM });
  rcY -= 11;
  page.drawText(formatTimestamp(input.payment_received_at), { x: RC_INNER_X, y: rcY, size: 8.5, font: fontBold, color: C_DARK });
  rcY -= 14;

  page.drawText('Method', { x: RC_INNER_X, y: rcY, size: 7.5, font, color: C_MEDIUM });
  rcY -= 11;
  page.drawText(formatPaymentMethod(input.payment_method), { x: RC_INNER_X, y: rcY, size: 8.5, font: fontBold, color: C_DARK });
  rcY -= 14;

  if (payRefLines.length > 0) {
    page.drawText('Reference', { x: RC_INNER_X, y: rcY, size: 7.5, font, color: C_MEDIUM });
    rcY -= 11;
    for (let i = 0; i < payRefLines.length; i++) {
      page.drawText(payRefLines[i], { x: RC_INNER_X, y: rcY, size: 8.5, font: fontBold, color: C_DARK });
      if (i < payRefLines.length - 1) rcY -= PAY_REF_LINE_H;
    }
  }

  y = INFO_CARD_Y - 12;

  // ── 4. BILLED TO CARD ─────────────────────────────────────────────────────
  const billingNameTrimmed = input.billing_name?.trim() ?? '';
  const billingContactTrimmed = input.billing_contact_name?.trim() ?? '';

  // Build billing lines
  const billingLines: Array<{ text: string; bold: boolean }> = [];

  if (billingNameTrimmed !== '') {
    billingLines.push({ text: billingNameTrimmed, bold: true });
  }
  if (
    billingContactTrimmed !== '' &&
    billingContactTrimmed.toLowerCase() !== billingNameTrimmed.toLowerCase()
  ) {
    billingLines.push({ text: billingContactTrimmed, bold: false });
  }

  const addrParts: string[] = [];
  if (input.billing_address_line1?.trim()) addrParts.push(input.billing_address_line1.trim());
  if (input.billing_address_line2?.trim()) addrParts.push(input.billing_address_line2.trim());

  const csp: string[] = [];
  if (input.billing_city?.trim()) csp.push(input.billing_city.trim());
  if (input.billing_state?.trim()) {
    if (input.billing_postal_code?.trim()) {
      csp.push(`${input.billing_state.trim()} ${input.billing_postal_code.trim()}`);
    } else {
      csp.push(input.billing_state.trim());
    }
  } else if (input.billing_postal_code?.trim()) {
    csp.push(input.billing_postal_code.trim());
  }
  if (csp.length > 0) addrParts.push(csp.join(', '));
  if (input.billing_country?.trim()) addrParts.push(input.billing_country.trim());

  for (const a of addrParts) {
    billingLines.push({ text: a, bold: false });
  }

  const BILLED_LINE_H = 12;
  const BILLED_INNER_PAD = 12;
  const BILLED_CARD_H = BILLED_INNER_PAD + 14 + billingLines.length * BILLED_LINE_H + BILLED_INNER_PAD;
  const BILLED_CARD_Y = y - BILLED_CARD_H;

  page.drawRectangle({ x: ML, y: BILLED_CARD_Y, width: CW, height: BILLED_CARD_H, color: C_CARD_BG });

  let btY = BILLED_CARD_Y + BILLED_CARD_H - BILLED_INNER_PAD;

  page.drawText('BILLED TO', {
    x: ML + BILLED_INNER_PAD, y: btY,
    size: 7, font: fontBold, color: C_EB_GREEN_MED,
  });
  btY -= 14;

  for (const line of billingLines) {
    const wrappedLines = wrapText(line.text, line.bold ? fontBold : font, 8.5, CW - BILLED_INNER_PAD * 2);
    for (const wl of wrappedLines) {
      page.drawText(wl, {
        x: ML + BILLED_INNER_PAD, y: btY,
        size: 8.5,
        font: line.bold ? fontBold : font,
        color: line.bold ? C_DARK : C_MEDIUM,
      });
      btY -= BILLED_LINE_H;
    }
  }

  y = BILLED_CARD_Y - 12;

  // ── 5. ACCOUNT SUMMARY CARD ───────────────────────────────────────────────
  // Rows: Invoice Total / This Payment / Total Paid / Balance Remaining
  // Right-aligned monetary values
  const SUMMARY_ROW_H = 18;
  const SUMMARY_ROWS = 4;
  const SUMMARY_INNER_PAD = 12;
  const SUMMARY_CARD_H = SUMMARY_INNER_PAD + 14 + SUMMARY_ROWS * SUMMARY_ROW_H + SUMMARY_INNER_PAD;
  const SUMMARY_CARD_Y = y - SUMMARY_CARD_H;

  page.drawRectangle({ x: ML, y: SUMMARY_CARD_Y, width: CW, height: SUMMARY_CARD_H, color: C_CARD_BG });

  let smY = SUMMARY_CARD_Y + SUMMARY_CARD_H - SUMMARY_INNER_PAD;

  // Heading
  page.drawText('ACCOUNT SUMMARY', {
    x: ML + SUMMARY_INNER_PAD, y: smY,
    size: 7, font: fontBold, color: C_EB_GREEN_MED,
  });
  smY -= 16;

  // Helper: draw a summary row
  function drawSummaryRow(
    label: string,
    value: string,
    labelFnt: PDFFont,
    valueFnt: PDFFont,
    labelClr: ReturnType<typeof rgb>,
    valueClr: ReturnType<typeof rgb>,
    rowBg?: ReturnType<typeof rgb>,
  ): void {
    if (rowBg) {
      page.drawRectangle({
        x: ML + 4, y: smY - 4,
        width: CW - 8, height: SUMMARY_ROW_H,
        color: rowBg,
      });
    }
    page.drawText(label, {
      x: ML + SUMMARY_INNER_PAD, y: smY,
      size: 8.5, font: labelFnt, color: labelClr,
    });
    const vw = valueFnt.widthOfTextAtSize(value, 8.5);
    page.drawText(value, {
      x: ML + CW - SUMMARY_INNER_PAD - vw, y: smY,
      size: 8.5, font: valueFnt, color: valueClr,
    });
    smY -= SUMMARY_ROW_H;
  }

  // Invoice Total
  drawSummaryRow(
    'Invoice Total',
    formatMoney(input.invoice_total_cents, currency),
    font, font,
    C_MEDIUM, C_DARK,
  );

  // This Payment — slightly emphasized
  drawSummaryRow(
    'This Payment',
    formatMoney(input.payment_amount_cents, currency),
    fontBold, fontBold,
    C_DARK, C_EB_GREEN,
    C_CARD_BG2,
  );

  // Total Paid
  drawSummaryRow(
    'Total Paid',
    formatMoney(input.amount_paid_after_cents, currency),
    font, font,
    C_MEDIUM, C_DARK,
  );

  // Balance Remaining — strongest row
  const balanceValueColor = isPaidInFull ? C_EB_GREEN_MED : C_DARK;
  drawSummaryRow(
    'Balance Remaining',
    formatMoney(input.balance_remaining_after_cents, currency),
    fontBold, fontBold,
    C_DARK, balanceValueColor,
  );

  // PAID IN FULL treatment when balance is $0.00
  if (isPaidInFull) {
    const pifLabel = 'PAID IN FULL';
    const pifLabelW = fontBold.widthOfTextAtSize(pifLabel, 7);
    const pifPadX = 6;
    const pifBadgeW = pifLabelW + pifPadX * 2;
    const pifBadgeH = 12;
    const pifBadgeX = ML + CW - SUMMARY_INNER_PAD - pifBadgeW;
    const pifBadgeY = smY + 2;

    page.drawRectangle({
      x: pifBadgeX, y: pifBadgeY,
      width: pifBadgeW, height: pifBadgeH,
      color: C_EB_GREEN_LT,
    });
    page.drawText(pifLabel, {
      x: pifBadgeX + pifPadX, y: pifBadgeY + 3,
      size: 7, font: fontBold, color: C_EB_GREEN_MED,
    });
    smY -= 14;
  }

  y = SUMMARY_CARD_Y - 14;

  // ── 6. CONFIRMATION ───────────────────────────────────────────────────────
  let confirmText: string;
  if (isPaidInFull) {
    confirmText =
      `Payment received and applied to invoice ${input.invoice_number}. ` +
      'This invoice is paid in full.';
  } else {
    const balStr = formatMoney(input.balance_remaining_after_cents, currency);
    confirmText =
      `Payment received and applied to invoice ${input.invoice_number}. ` +
      `Remaining balance: ${balStr}.`;
  }

  const confirmLines = wrapText(confirmText, font, 8, CW);
  for (const line of confirmLines) {
    page.drawText(line, {
      x: ML, y,
      size: 8, font, color: C_MEDIUM,
    });
    y -= 12;
  }

  // Overflow guard: content must stay above the footer rule (FOOTER_Y + 14).
  // The payment API caps reference_number at 255 chars, which always fits; this
  // is a defensive backstop so content is never silently overlapped or clipped.
  if (y < SAFE_BOT + 14 + 14 + 4) {
    throw new ReceiptPdfError(
      'RECEIPT_PDF_CONTENT_OVERFLOW',
      'Receipt content does not fit on a single page.',
    );
  }

  // ── 7. FOOTER ─────────────────────────────────────────────────────────────
  const FOOTER_Y = SAFE_BOT + 14;

  page.drawLine({
    start: { x: ML, y: FOOTER_Y + 14 },
    end: { x: PAGE_W - MR, y: FOOTER_Y + 14 },
    thickness: 0.5,
    color: C_DIVIDER,
  });

  const footerStr = `EarnestBridge  \u00b7  Payment Receipt  \u00b7  ${input.receipt_number}`;
  const footerW = font.widthOfTextAtSize(footerStr, 7.5);
  const footerX = ML + (CW - footerW) / 2;
  page.drawText(footerStr, {
    x: footerX, y: FOOTER_Y,
    size: 7.5, font, color: C_LIGHT,
  });

  // Serialize
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await pdfDoc.save();
  } catch {
    throw new ReceiptPdfError('RECEIPT_PDF_RENDER_ERROR', 'Failed to serialize PDF document.');
  }

  return pdfBytes;
}
