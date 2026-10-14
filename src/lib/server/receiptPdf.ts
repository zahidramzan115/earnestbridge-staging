/**
 * src/lib/server/receiptPdf.ts
 *
 * Phase: 7B-9J — Receipt PDF Renderer (Design Overhaul)
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
 * The user-facing "Receipt Issued Date" is rendered as body text from
 * receipt_issued_at — NOT from PDF metadata.
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
 *   receipt_issued_at   → Receipt Issued Date (header only)
 *   payment_received_at → Payment Received Date
 *   invoice_issued_at   → Invoice Issued Date
 * The renderer never calls new Date() for displayed dates.
 *
 * PAYMENT METHOD LABELS
 * ---------------------
 * Internal enum values are mapped to clean user-facing labels:
 *   bank_wire → Bank Wire
 *   check     → Check
 *   ach       → ACH
 *   credit_card → Credit Card
 *   other     → Other
 *
 * LAYOUT (7B-9J — Design Overhaul)
 * ---------------------------------
 * 1. Full-width dark green header band (70-85pt)
 *    LEFT:  EarnestBridge / Lock up the Deal.
 *    RIGHT: PAYMENT RECEIPT / receipt_number / Issued {date}
 *
 * 2. Payment Hero Card
 *    Status badge: PAID IN FULL | PARTIAL PAYMENT
 *    PAYMENT RECEIVED
 *    Large payment amount
 *    Date · Method
 *    Reference (if present)
 *
 * 3. Two side-by-side info cards
 *    LEFT:  INVOICE — Invoice Number, Invoice Date
 *    RIGHT: PAYMENT — Received, Method, Reference
 *
 * 4. Full-width BILLED TO card
 *    billing_name
 *    billing_contact_name (if non-empty and different from billing_name)
 *    address lines
 *
 * 5. Full-width ACCOUNT SUMMARY
 *    Invoice Total, This Payment, Total Paid, Balance Remaining
 *    Right-aligned monetary values
 *    Balance Remaining = $0.00 in green when paid in full
 *
 * 6. Short confirmation block
 *    Partial: "Payment received and applied to invoice {n}. Remaining balance: {b}."
 *    Full:    "Payment received and applied to invoice {n}. This invoice is paid in full."
 *
 * 7. Minimal footer
 *    Subtle rule + "EarnestBridge · Payment Receipt · {receipt_number}"
 */

import 'server-only';

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Fixed PDF metadata date — NEVER changes between renders.
// This is NOT the receipt issued date. It is a fixed anchor used only for
// PDF document metadata (CreationDate, ModificationDate) to ensure
// byte-identical output across renders of the same snapshot.
// ---------------------------------------------------------------------------

const FIXED_PDF_METADATA_DATE = new Date('2000-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Safe renderer error codes
// ---------------------------------------------------------------------------

export type ReceiptPdfErrorCode =
  | 'RECEIPT_PDF_INVALID_DATA' | 'RECEIPT_PDF_CONTENT_OVERFLOW' | 'RECEIPT_PDF_RENDER_ERROR';

export class ReceiptPdfError extends Error {
  public readonly code: ReceiptPdfErrorCode;

  constructor(code: ReceiptPdfErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'ReceiptPdfError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// ReceiptPdfInput — strict type containing ONLY the immutable values
// returned by prepare_receipt_generation() that are required to render.
//
// Explicitly excluded:
//   notes, recorded_by, idempotency_key, provider, provider_payment_id,
//   Admin UUID, Admin email, service-role information, storage path.
// ---------------------------------------------------------------------------

export interface ReceiptPdfInput {
  // Receipt identity (write-once, set at PREPARE)
  receipt_number: string;
  receipt_issued_at: string; // ISO 8601 timestamptz

  // Payment facts
  payment_id: string;
  payment_amount_cents: number;
  payment_received_at: string; // ISO 8601 timestamptz
  payment_method: string;
  payment_reference_number: string | null;
  payment_currency: string;

  // Running totals snapshot
  amount_paid_after_cents: number;
  balance_remaining_after_cents: number;

  // Invoice snapshot
  invoice_id: string;
  invoice_number: string;
  invoice_total_cents: number;
  invoice_issued_at: string; // ISO 8601 timestamptz
  invoice_currency: string;

  // Billing / payer snapshot
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

  // Validate timestamps parse correctly
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

  // Money fields: safe integers
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
// Money formatting — integer cents only, no floating-point arithmetic
// ---------------------------------------------------------------------------

function formatMoney(cents: number, currency: string = 'USD'): string {
  const isNegative = cents < 0;
  const absCents = Math.abs(cents);
  const dollars = Math.floor(absCents / 100);
  const centsRemainder = absCents % 100;

  // Build thousands-separated dollars string without locale dependency
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
// Date formatting — from ISO 8601 timestamptz input only
// Never calls new Date() without an input value.
// ---------------------------------------------------------------------------

function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  // Use UTC to avoid server timezone affecting display
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${month} ${day}, ${year}`;
}

// ---------------------------------------------------------------------------
// Payment method label — clean user-facing display
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
  const paragraphs = text.split(/\r?\n/);
  const result: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      result.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (word.length === 0) continue;

      const tokenWidth = font.widthOfTextAtSize(word, fontSize);
      if (tokenWidth > maxWidth) {
        throw new ReceiptPdfError(
          'RECEIPT_PDF_CONTENT_OVERFLOW',
          'A content token exceeds the permitted column width.',
        );
      }

      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (testWidth <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) result.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) result.push(currentLine);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Drawing context
// ---------------------------------------------------------------------------

interface DrawContext {
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginRight: number;
  contentWidth: number;
  cursor: number;
  safeBottomMargin: number;
}

function checkOverflow(ctx: DrawContext, requiredHeight: number): void {
  if (ctx.cursor - requiredHeight < ctx.safeBottomMargin) {
    throw new ReceiptPdfError(
      'RECEIPT_PDF_CONTENT_OVERFLOW',
      'Receipt content exceeds one-page limit.',
    );
  }
}

function drawText(
  ctx: DrawContext,
  text: string,
  x: number,
  y: number,
  options: {
    font?: PDFFont;
    size?: number;
    color?: ReturnType<typeof rgb>;
  } = {},
): void {
  ctx.page.drawText(text, {
    x,
    y,
    size: options.size ?? 9,
    font: options.font ?? ctx.font,
    color: options.color ?? rgb(0.1, 0.1, 0.1),
  });
}

function drawLine(
  ctx: DrawContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number = 0.5,
  color: ReturnType<typeof rgb> = rgb(0.82, 0.82, 0.78),
): void {
  ctx.page.drawLine({
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thickness,
    color,
  });
}

function drawRect(
  ctx: DrawContext,
  x: number,
  y: number,
  width: number,
  height: number,
  color: ReturnType<typeof rgb>,
): void {
  ctx.page.drawRectangle({ x, y, width, height, color });
}

// ---------------------------------------------------------------------------
// Main renderer — pure function, deterministic output
// ---------------------------------------------------------------------------

export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Uint8Array> {
  // 1. Validate input
  try {
    validateInput(input);
  } catch (err) {
    if (err instanceof ReceiptPdfError) throw err;
    throw new ReceiptPdfError('RECEIPT_PDF_INVALID_DATA', 'Input validation failed.');
  }

  // 2. Create PDF document
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.create();
  } catch {
    throw new ReceiptPdfError('RECEIPT_PDF_RENDER_ERROR', 'Failed to create PDF document.');
  }

  // 3. Set DETERMINISTIC PDF metadata
  // All four auto-generated fields are explicitly overridden with a fixed
  // constant date. This prevents pdf-lib from injecting the current wall-clock
  // time, which would make PDF bytes differ between renders.
  pdfDoc.setTitle(`EarnestBridge Receipt ${input.receipt_number}`);
  pdfDoc.setAuthor('EarnestBridge');
  pdfDoc.setSubject('Payment Receipt');
  pdfDoc.setCreator('EarnestBridge');
  pdfDoc.setProducer('EarnestBridge');
  pdfDoc.setCreationDate(FIXED_PDF_METADATA_DATE);
  pdfDoc.setModificationDate(FIXED_PDF_METADATA_DATE);

  // 4. Embed fonts
  let font: PDFFont;
  let fontBold: PDFFont;
  try {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  } catch {
    throw new ReceiptPdfError('RECEIPT_PDF_RENDER_ERROR', 'Failed to embed fonts.');
  }

  // 5. Add US Letter page (612 x 792 points)
  const PAGE_WIDTH = 612;
  const PAGE_HEIGHT = 792;
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  // Layout constants
  const MARGIN_LEFT = 48;
  const MARGIN_RIGHT = 48;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const SAFE_BOTTOM_MARGIN = 48;

  // ── Color palette — EarnestBridge branded ──────────────────────────────
  const COLOR_WHITE        = rgb(1.0, 1.0, 1.0);
  const COLOR_PAGE_BG      = rgb(1.0, 1.0, 1.0);          // white page
  const COLOR_EB_GREEN     = rgb(0.055, 0.176, 0.125);     // dark EB green #0E2D20
  const COLOR_EB_GREEN_LT  = rgb(0.08, 0.26, 0.18);        // slightly lighter green for hero
  const COLOR_EB_GREEN_ACC = rgb(0.10, 0.42, 0.28);        // accent green for paid-in-full badge
  const COLOR_CARD_BG      = rgb(0.965, 0.965, 0.965);     // subtle warm/light gray card
  const COLOR_CARD_BORDER  = rgb(0.88, 0.88, 0.88);        // card border
  const COLOR_DIVIDER      = rgb(0.86, 0.86, 0.86);        // divider lines
  const COLOR_DARK         = rgb(0.10, 0.10, 0.10);        // strong text
  const COLOR_MEDIUM       = rgb(0.40, 0.40, 0.40);        // secondary text
  const COLOR_LIGHT        = rgb(0.58, 0.58, 0.58);        // tertiary text
  const COLOR_BADGE_PARTIAL_BG   = rgb(0.90, 0.90, 0.90);  // neutral badge bg
  const COLOR_BADGE_PARTIAL_TEXT = rgb(0.35, 0.35, 0.35);  // neutral badge text
  const COLOR_BADGE_PAID_BG      = rgb(0.88, 0.96, 0.90);  // subtle green badge bg
  const COLOR_BADGE_PAID_TEXT    = rgb(0.06, 0.38, 0.20);  // green badge text

  const isPaidInFull = input.balance_remaining_after_cents === 0;
  const currency = input.payment_currency;

  // Draw context (cursor starts at top)
  const ctx: DrawContext = {
    page,
    font,
    fontBold,
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
    marginLeft: MARGIN_LEFT,
    marginRight: MARGIN_RIGHT,
    contentWidth: CONTENT_WIDTH,
    cursor: PAGE_HEIGHT,
    safeBottomMargin: SAFE_BOTTOM_MARGIN,
  };

  // ── PAGE BACKGROUND ──────────────────────────────────────────────────────
  drawRect(ctx, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, COLOR_PAGE_BG);

  // ════════════════════════════════════════════════════════════════════════
  // 1. FULL-WIDTH HEADER BAND
  //    Dark EB green, ~78pt tall
  //    LEFT:  EarnestBridge (white, 17pt bold) / Lock up the Deal. (white, 8.5pt)
  //    RIGHT: PAYMENT RECEIPT (white, 11pt bold) / receipt_number (white, 9pt) / Issued {date} (white/light, 8pt)
  // ════════════════════════════════════════════════════════════════════════

  const HEADER_HEIGHT = 78;
  const HEADER_TOP = PAGE_HEIGHT;
  const HEADER_BOTTOM = PAGE_HEIGHT - HEADER_HEIGHT;

  // Header band background
  drawRect(ctx, 0, HEADER_BOTTOM, PAGE_WIDTH, HEADER_HEIGHT, COLOR_EB_GREEN);

  // LEFT: EarnestBridge wordmark — vertically centered in upper portion
  const wordmarkY = HEADER_BOTTOM + 44;
  drawText(ctx, 'EarnestBridge', MARGIN_LEFT, wordmarkY, {
    font: fontBold,
    size: 17,
    color: COLOR_WHITE,
  });

  // LEFT: tagline below wordmark
  const taglineY = wordmarkY - 16;
  drawText(ctx, 'Lock up the Deal.', MARGIN_LEFT, taglineY, {
    font,
    size: 8.5,
    color: rgb(0.75, 0.88, 0.80), // soft white-green
  });

  // RIGHT: PAYMENT RECEIPT title — prominent
  const receiptTitleStr = 'PAYMENT RECEIPT';
  const receiptTitleSize = 11;
  const receiptTitleWidth = fontBold.widthOfTextAtSize(receiptTitleStr, receiptTitleSize);
  const receiptTitleY = HEADER_BOTTOM + 50;
  drawText(ctx, receiptTitleStr, PAGE_WIDTH - MARGIN_RIGHT - receiptTitleWidth, receiptTitleY, {
    font: fontBold,
    size: receiptTitleSize,
    color: COLOR_WHITE,
  });

  // RIGHT: receipt number — below title, slightly smaller
  const receiptNumStr = input.receipt_number;
  const receiptNumSize = 8.5;
  const receiptNumWidth = font.widthOfTextAtSize(receiptNumStr, receiptNumSize);
  const receiptNumY = receiptTitleY - 14;
  drawText(ctx, receiptNumStr, PAGE_WIDTH - MARGIN_RIGHT - receiptNumWidth, receiptNumY, {
    font,
    size: receiptNumSize,
    color: rgb(0.82, 0.92, 0.86), // soft white-green
  });

  // RIGHT: Issued date — below receipt number
  const issuedDateStr = `Issued ${formatTimestamp(input.receipt_issued_at)}`;
  const issuedDateSize = 7.5;
  const issuedDateWidth = font.widthOfTextAtSize(issuedDateStr, issuedDateSize);
  const issuedDateY = receiptNumY - 12;
  drawText(ctx, issuedDateStr, PAGE_WIDTH - MARGIN_RIGHT - issuedDateWidth, issuedDateY, {
    font,
    size: issuedDateSize,
    color: rgb(0.68, 0.82, 0.74), // lighter white-green
  });

  // Advance cursor past header
  ctx.cursor = HEADER_BOTTOM - 14;

  // ════════════════════════════════════════════════════════════════════════
  // 2. PAYMENT HERO CARD
  //    Full-width card with status badge, PAYMENT RECEIVED label,
  //    large payment amount, date · method, optional reference
  // ════════════════════════════════════════════════════════════════════════

  const HERO_CARD_PADDING_H = 16;
  const HERO_CARD_PADDING_V = 14;

  // Measure hero card content height:
  // badge row (14) + gap (6) + label (10) + gap (4) + amount (28) + gap (6) + date·method (10) + optional ref (12) + padding*2
  const hasRef = !!(input.payment_reference_number && input.payment_reference_number.trim() !== '');
  const HERO_CONTENT_HEIGHT = 14 + 6 + 10 + 4 + 28 + 6 + 10 + (hasRef ? 12 : 0);
  const HERO_CARD_HEIGHT = HERO_CONTENT_HEIGHT + HERO_CARD_PADDING_V * 2;

  checkOverflow(ctx, HERO_CARD_HEIGHT + 10);

  const heroCardY = ctx.cursor - HERO_CARD_HEIGHT;

  // Hero card background
  drawRect(ctx, MARGIN_LEFT, heroCardY, CONTENT_WIDTH, HERO_CARD_HEIGHT, COLOR_CARD_BG);

  // Hero card border (subtle)
  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: heroCardY,
    width: CONTENT_WIDTH,
    height: HERO_CARD_HEIGHT,
    borderColor: COLOR_CARD_BORDER,
    borderWidth: 0.5,
    color: COLOR_CARD_BG,
  });

  // Status badge — top-left inside card
  const badgeText = isPaidInFull ? 'PAID IN FULL' : 'PARTIAL PAYMENT';
  const badgeFontSize = 7;
  const badgePadH = 6;
  const badgePadV = 3;
  const badgeTextWidth = fontBold.widthOfTextAtSize(badgeText, badgeFontSize);
  const badgeWidth = badgeTextWidth + badgePadH * 2;
  const badgeHeight = badgeFontSize + badgePadV * 2;
  const badgeX = MARGIN_LEFT + HERO_CARD_PADDING_H;
  const badgeY = ctx.cursor - HERO_CARD_PADDING_V - badgeHeight;

  const badgeBgColor = isPaidInFull ? COLOR_BADGE_PAID_BG : COLOR_BADGE_PARTIAL_BG;
  const badgeTextColor = isPaidInFull ? COLOR_BADGE_PAID_TEXT : COLOR_BADGE_PARTIAL_TEXT;

  drawRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, badgeBgColor);
  drawText(ctx, badgeText, badgeX + badgePadH, badgeY + badgePadV + 0.5, {
    font: fontBold,
    size: badgeFontSize,
    color: badgeTextColor,
  });

  // PAYMENT RECEIVED label
  const labelY = badgeY - 6 - 10;
  drawText(ctx, 'PAYMENT RECEIVED', MARGIN_LEFT + HERO_CARD_PADDING_H, labelY, {
    font: fontBold,
    size: 8,
    color: COLOR_MEDIUM,
  });

  // Large payment amount
  const paymentAmountStr = formatMoney(input.payment_amount_cents, currency);
  const amountFontSize = 26;
  const amountY = labelY - 4 - amountFontSize;
  drawText(ctx, paymentAmountStr, MARGIN_LEFT + HERO_CARD_PADDING_H, amountY, {
    font: fontBold,
    size: amountFontSize,
    color: COLOR_DARK,
  });

  // Date · Method line
  const paymentDateStr = formatTimestamp(input.payment_received_at);
  const paymentMethodStr = formatPaymentMethod(input.payment_method);
  const dateMethodStr = `${paymentDateStr}  ·  ${paymentMethodStr}`;
  const dateMethodY = amountY - 6 - 10;
  drawText(ctx, dateMethodStr, MARGIN_LEFT + HERO_CARD_PADDING_H, dateMethodY, {
    font,
    size: 8.5,
    color: COLOR_MEDIUM,
  });

  // Reference (if present)
  if (hasRef) {
    const refStr = `Reference: ${input.payment_reference_number!.trim()}`;
    const refY = dateMethodY - 12;
    drawText(ctx, refStr, MARGIN_LEFT + HERO_CARD_PADDING_H, refY, {
      font,
      size: 8,
      color: COLOR_LIGHT,
    });
  }

  ctx.cursor = heroCardY - 12;

  // ════════════════════════════════════════════════════════════════════════
  // 3. TWO SIDE-BY-SIDE INFORMATION CARDS
  //    LEFT:  INVOICE — Invoice Number, Invoice Date
  //    RIGHT: PAYMENT — Received, Method, Reference
  // ════════════════════════════════════════════════════════════════════════

  const CARD_GAP = 8;
  const HALF_WIDTH = Math.floor((CONTENT_WIDTH - CARD_GAP) / 2);
  const LEFT_CARD_X = MARGIN_LEFT;
  const RIGHT_CARD_X = MARGIN_LEFT + HALF_WIDTH + CARD_GAP;
  const CARD_PADDING_H = 12;
  const CARD_PADDING_V = 12;

  // Measure card heights
  // Left card: heading + 2 fields (label+value each) = heading(10) + gap(8) + label(8) + gap(3) + value(9) + gap(10) + label(8) + gap(3) + value(9) + bottom padding
  const LEFT_CARD_CONTENT_H = 10 + 8 + 8 + 3 + 9 + 10 + 8 + 3 + 9;
  // Right card: heading + 2-3 fields
  const RIGHT_CARD_CONTENT_H = 10 + 8 + 8 + 3 + 9 + 10 + 8 + 3 + 9 + (hasRef ? (10 + 8 + 3 + 9) : 0);
  const CARDS_CONTENT_H = Math.max(LEFT_CARD_CONTENT_H, RIGHT_CARD_CONTENT_H);
  const CARDS_HEIGHT = CARDS_CONTENT_H + CARD_PADDING_V * 2;

  checkOverflow(ctx, CARDS_HEIGHT + 10);

  const cardsY = ctx.cursor - CARDS_HEIGHT;

  // Draw left card
  ctx.page.drawRectangle({
    x: LEFT_CARD_X,
    y: cardsY,
    width: HALF_WIDTH,
    height: CARDS_HEIGHT,
    color: COLOR_CARD_BG,
    borderColor: COLOR_CARD_BORDER,
    borderWidth: 0.5,
  });

  // Draw right card
  ctx.page.drawRectangle({
    x: RIGHT_CARD_X,
    y: cardsY,
    width: HALF_WIDTH,
    height: CARDS_HEIGHT,
    color: COLOR_CARD_BG,
    borderColor: COLOR_CARD_BORDER,
    borderWidth: 0.5,
  });

  // LEFT CARD content
  let lcy = ctx.cursor - CARD_PADDING_V; // left card y cursor

  // INVOICE heading
  drawText(ctx, 'INVOICE', LEFT_CARD_X + CARD_PADDING_H, lcy, {
    font: fontBold,
    size: 7,
    color: COLOR_MEDIUM,
  });
  lcy -= 8 + 8;

  // Invoice Number
  drawText(ctx, 'Invoice Number', LEFT_CARD_X + CARD_PADDING_H, lcy, {
    font,
    size: 7.5,
    color: COLOR_LIGHT,
  });
  lcy -= 3 + 9;
  drawText(ctx, input.invoice_number, LEFT_CARD_X + CARD_PADDING_H, lcy, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });
  lcy -= 10 + 8;

  // Invoice Date
  drawText(ctx, 'Invoice Date', LEFT_CARD_X + CARD_PADDING_H, lcy, {
    font,
    size: 7.5,
    color: COLOR_LIGHT,
  });
  lcy -= 3 + 9;
  drawText(ctx, formatTimestamp(input.invoice_issued_at), LEFT_CARD_X + CARD_PADDING_H, lcy, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });

  // RIGHT CARD content
  let rcy = ctx.cursor - CARD_PADDING_V; // right card y cursor

  // PAYMENT heading
  drawText(ctx, 'PAYMENT', RIGHT_CARD_X + CARD_PADDING_H, rcy, {
    font: fontBold,
    size: 7,
    color: COLOR_MEDIUM,
  });
  rcy -= 8 + 8;

  // Received
  drawText(ctx, 'Received', RIGHT_CARD_X + CARD_PADDING_H, rcy, {
    font,
    size: 7.5,
    color: COLOR_LIGHT,
  });
  rcy -= 3 + 9;
  drawText(ctx, formatTimestamp(input.payment_received_at), RIGHT_CARD_X + CARD_PADDING_H, rcy, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });
  rcy -= 10 + 8;

  // Method
  drawText(ctx, 'Method', RIGHT_CARD_X + CARD_PADDING_H, rcy, {
    font,
    size: 7.5,
    color: COLOR_LIGHT,
  });
  rcy -= 3 + 9;
  drawText(ctx, formatPaymentMethod(input.payment_method), RIGHT_CARD_X + CARD_PADDING_H, rcy, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });
  rcy -= 10 + 8;

  // Reference (if present)
  if (hasRef) {
    drawText(ctx, 'Reference', RIGHT_CARD_X + CARD_PADDING_H, rcy, {
      font,
      size: 7.5,
      color: COLOR_LIGHT,
    });
    rcy -= 3 + 9;
    drawText(ctx, input.payment_reference_number!.trim(), RIGHT_CARD_X + CARD_PADDING_H, rcy, {
      font: fontBold,
      size: 8.5,
      color: COLOR_DARK,
    });
  }

  ctx.cursor = cardsY - 12;

  // ════════════════════════════════════════════════════════════════════════
  // 4. BILLED TO CARD — full-width
  // ════════════════════════════════════════════════════════════════════════

  const billingNameTrimmed = input.billing_name?.trim() ?? '';
  const billingContactTrimmed = input.billing_contact_name?.trim() ?? '';
  const showContact =
    billingContactTrimmed !== '' &&
    billingContactTrimmed.toLowerCase() !== billingNameTrimmed.toLowerCase();

  // Build address parts
  const addrParts: string[] = [];
  if (input.billing_address_line1 && input.billing_address_line1.trim()) {
    addrParts.push(input.billing_address_line1.trim());
  }
  if (input.billing_address_line2 && input.billing_address_line2.trim()) {
    addrParts.push(input.billing_address_line2.trim());
  }
  const cityStateParts: string[] = [];
  if (input.billing_city && input.billing_city.trim()) cityStateParts.push(input.billing_city.trim());
  if (input.billing_state && input.billing_state.trim()) {
    if (input.billing_postal_code && input.billing_postal_code.trim()) {
      cityStateParts.push(`${input.billing_state.trim()} ${input.billing_postal_code.trim()}`);
    } else {
      cityStateParts.push(input.billing_state.trim());
    }
  } else if (input.billing_postal_code && input.billing_postal_code.trim()) {
    cityStateParts.push(input.billing_postal_code.trim());
  }
  if (cityStateParts.length > 0) addrParts.push(cityStateParts.join(', '));
  if (input.billing_country && input.billing_country.trim()) {
    addrParts.push(input.billing_country.trim());
  }

  // Measure billed-to card height
  const BT_PADDING_H = 12;
  const BT_PADDING_V = 12;
  const BT_HEADING_H = 10 + 8; // heading + gap
  const BT_NAME_H = billingNameTrimmed !== '' ? (9 + 10) : 0;
  const BT_CONTACT_H = showContact ? (8.5 + 10) : 0;
  const BT_ADDR_H = addrParts.length * (8.5 + 8);
  const BT_CONTENT_H = BT_HEADING_H + BT_NAME_H + BT_CONTACT_H + BT_ADDR_H;
  const BT_CARD_HEIGHT = BT_CONTENT_H + BT_PADDING_V * 2;

  checkOverflow(ctx, BT_CARD_HEIGHT + 10);

  const btCardY = ctx.cursor - BT_CARD_HEIGHT;

  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: btCardY,
    width: CONTENT_WIDTH,
    height: BT_CARD_HEIGHT,
    color: COLOR_CARD_BG,
    borderColor: COLOR_CARD_BORDER,
    borderWidth: 0.5,
  });

  let btcy = ctx.cursor - BT_PADDING_V;

  // BILLED TO heading
  drawText(ctx, 'BILLED TO', MARGIN_LEFT + BT_PADDING_H, btcy, {
    font: fontBold,
    size: 7,
    color: COLOR_MEDIUM,
  });
  btcy -= 8 + 8;

  // billing_name
  if (billingNameTrimmed !== '') {
    const nameLines = wrapText(billingNameTrimmed, fontBold, 9, CONTENT_WIDTH - BT_PADDING_H * 2);
    for (const line of nameLines) {
      drawText(ctx, line, MARGIN_LEFT + BT_PADDING_H, btcy, {
        font: fontBold,
        size: 9,
        color: COLOR_DARK,
      });
      btcy -= 9 + 4;
    }
    btcy -= 6;
  }

  // billing_contact_name (deduped)
  if (showContact) {
    const contactLines = wrapText(billingContactTrimmed, font, 8.5, CONTENT_WIDTH - BT_PADDING_H * 2);
    for (const line of contactLines) {
      drawText(ctx, line, MARGIN_LEFT + BT_PADDING_H, btcy, {
        font,
        size: 8.5,
        color: COLOR_DARK,
      });
      btcy -= 8.5 + 4;
    }
    btcy -= 4;
  }

  // Address lines
  for (const addrLine of addrParts) {
    const wrapped = wrapText(addrLine, font, 8.5, CONTENT_WIDTH - BT_PADDING_H * 2);
    for (const line of wrapped) {
      drawText(ctx, line, MARGIN_LEFT + BT_PADDING_H, btcy, {
        font,
        size: 8.5,
        color: COLOR_MEDIUM,
      });
      btcy -= 8.5 + 6;
    }
  }

  ctx.cursor = btCardY - 14;

  // ════════════════════════════════════════════════════════════════════════
  // 5. ACCOUNT SUMMARY — full-width card
  //    Rows: Invoice Total, This Payment, Total Paid, Balance Remaining
  //    Right-aligned monetary values
  // ════════════════════════════════════════════════════════════════════════

  const AS_PADDING_H = 12;
  const AS_PADDING_V = 12;
  const AS_ROW_H = 17;
  const AS_DIVIDER_H = 8;
  // heading + gap + 4 rows + optional paid-in-full note
  const AS_CONTENT_H = 10 + 8 + AS_ROW_H + AS_ROW_H + AS_ROW_H + AS_ROW_H + (isPaidInFull ? 14 : 0);
  const AS_CARD_HEIGHT = AS_CONTENT_H + AS_PADDING_V * 2;

  checkOverflow(ctx, AS_CARD_HEIGHT + 10);

  const asCardY = ctx.cursor - AS_CARD_HEIGHT;

  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: asCardY,
    width: CONTENT_WIDTH,
    height: AS_CARD_HEIGHT,
    color: COLOR_CARD_BG,
    borderColor: COLOR_CARD_BORDER,
    borderWidth: 0.5,
  });

  let ascy = ctx.cursor - AS_PADDING_V;

  // ACCOUNT SUMMARY heading
  drawText(ctx, 'ACCOUNT SUMMARY', MARGIN_LEFT + AS_PADDING_H, ascy, {
    font: fontBold,
    size: 7,
    color: COLOR_MEDIUM,
  });
  ascy -= 10 + 8;

  // Helper: draw a summary row with right-aligned value
  function drawSummaryRow(
    label: string,
    value: string,
    labelFont: PDFFont,
    valueFont: PDFFont,
    labelColor: ReturnType<typeof rgb>,
    valueColor: ReturnType<typeof rgb>,
    labelSize: number = 8.5,
    valueSize: number = 8.5,
  ): void {
    checkOverflow(ctx, AS_ROW_H);
    drawText(ctx, label, MARGIN_LEFT + AS_PADDING_H, ascy, {
      font: labelFont,
      size: labelSize,
      color: labelColor,
    });
    const vw = valueFont.widthOfTextAtSize(value, valueSize);
    drawText(ctx, value, PAGE_WIDTH - MARGIN_RIGHT - AS_PADDING_H - vw, ascy, {
      font: valueFont,
      size: valueSize,
      color: valueColor,
    });
    ascy -= AS_ROW_H;
  }

  // Invoice Total
  drawSummaryRow(
    'Invoice Total',
    formatMoney(input.invoice_total_cents, currency),
    font, font,
    COLOR_MEDIUM, COLOR_DARK,
  );

  // This Payment — slightly stronger
  drawSummaryRow(
    'This Payment',
    formatMoney(input.payment_amount_cents, currency),
    fontBold, fontBold,
    COLOR_DARK, COLOR_DARK,
    9, 9,
  );

  // Thin divider before totals
  ascy -= AS_DIVIDER_H / 2;
  drawLine(ctx, MARGIN_LEFT + AS_PADDING_H, ascy, PAGE_WIDTH - MARGIN_RIGHT - AS_PADDING_H, ascy, 0.5, COLOR_DIVIDER);
  ascy -= AS_DIVIDER_H / 2;

  // Total Paid
  drawSummaryRow(
    'Total Paid',
    formatMoney(input.amount_paid_after_cents, currency),
    font, font,
    COLOR_MEDIUM, COLOR_DARK,
  );

  // Balance Remaining — strongest row
  const balanceValueColor = isPaidInFull ? COLOR_EB_GREEN_ACC : COLOR_DARK;
  drawSummaryRow(
    'Balance Remaining',
    formatMoney(input.balance_remaining_after_cents, currency),
    fontBold, fontBold,
    COLOR_DARK, balanceValueColor,
    9, 9,
  );

  // PAID IN FULL note (if applicable)
  if (isPaidInFull) {
    ascy -= 2;
    const pifNoteStr = 'PAID IN FULL';
    const pifNoteWidth = fontBold.widthOfTextAtSize(pifNoteStr, 7.5);
    drawText(ctx, pifNoteStr, PAGE_WIDTH - MARGIN_RIGHT - AS_PADDING_H - pifNoteWidth, ascy, {
      font: fontBold,
      size: 7.5,
      color: COLOR_EB_GREEN_ACC,
    });
  }

  ctx.cursor = asCardY - 14;

  // ════════════════════════════════════════════════════════════════════════
  // 6. CONFIRMATION BLOCK — short, below account summary
  // ════════════════════════════════════════════════════════════════════════

  checkOverflow(ctx, 30);

  let confirmationText: string;
  if (isPaidInFull) {
    confirmationText = `Payment received and applied to invoice ${input.invoice_number}. This invoice is paid in full.`;
  } else {
    const balanceStr = formatMoney(input.balance_remaining_after_cents, currency);
    confirmationText = `Payment received and applied to invoice ${input.invoice_number}. Remaining balance: ${balanceStr}.`;
  }

  const confirmLines = wrapText(confirmationText, font, 8.5, CONTENT_WIDTH);
  for (const line of confirmLines) {
    checkOverflow(ctx, 12);
    drawText(ctx, line, MARGIN_LEFT, ctx.cursor, {
      font,
      size: 8.5,
      color: COLOR_MEDIUM,
    });
    ctx.cursor -= 13;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 7. FOOTER — minimal, closer to content
  //    Subtle horizontal rule + centered footer text
  // ════════════════════════════════════════════════════════════════════════

  // Place footer ~30pt below confirmation block, but at least SAFE_BOTTOM_MARGIN from bottom
  const FOOTER_Y = Math.max(ctx.cursor - 30, SAFE_BOTTOM_MARGIN + 14);

  // Footer rule
  drawLine(ctx, MARGIN_LEFT, FOOTER_Y + 12, PAGE_WIDTH - MARGIN_RIGHT, FOOTER_Y + 12, 0.5, COLOR_DIVIDER);

  // Footer text — centered, readable
  const footerStr = `EarnestBridge  ·  Payment Receipt  ·  ${input.receipt_number}`;
  const footerSize = 8;
  const footerWidth = font.widthOfTextAtSize(footerStr, footerSize);
  const footerX = MARGIN_LEFT + (CONTENT_WIDTH - footerWidth) / 2;
  drawText(ctx, footerStr, footerX, FOOTER_Y, {
    font,
    size: footerSize,
    color: COLOR_LIGHT,
  });

  // 6. Save with deterministic metadata already set above
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await pdfDoc.save();
  } catch {
    throw new ReceiptPdfError('RECEIPT_PDF_RENDER_ERROR', 'Failed to serialize PDF document.');
  }

  return pdfBytes;
}
