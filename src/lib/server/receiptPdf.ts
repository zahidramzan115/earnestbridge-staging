/**
 * src/lib/server/receiptPdf.ts
 *
 * Phase: 7B-9I — Receipt PDF Renderer (Visual Polish)
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
 * LAYOUT (7B-9I)
 * --------------
 * Header:
 *   LEFT:  EarnestBridge wordmark + "Lock up the Deal." tagline
 *   RIGHT: PAYMENT RECEIPT (section title)
 *          EBR-YYYY-NNNNNN (prominent)
 *          Issued {date} (secondary)
 *
 * Details (two-column):
 *   LEFT:  INVOICE DETAILS — Invoice Number, Invoice Issued Date
 *   RIGHT: PAYMENT DETAILS — Payment Received Date, Payment Method, Payment Reference
 *
 * Billed To:
 *   billing_name
 *   billing_contact_name ONLY IF non-empty AND different from billing_name
 *   address lines
 *
 * Financial Summary:
 *   Heading: FINANCIAL SUMMARY   ALL AMOUNTS {currency}
 *   THIS PAYMENT (focal, large bold)
 *   $amount (very large bold)
 *   Then compact rows: Invoice Total, Amount Paid After This Payment, Balance Remaining
 *
 * Confirmation (one sentence, below summary):
 *   Partial: "This receipt confirms the payment shown above was received and
 *             applied to the referenced invoice. A balance of {balance} remains."
 *   Full:    "This receipt confirms the payment shown above was received and *             applied to the referenced invoice. The invoice balance is now $0.00."
 *
 * Footer (minimal):
 *   Rule + "EarnestBridge  ·  Payment Receipt · {receipt_number}"
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
  const MARGIN_LEFT = 50;
  const MARGIN_RIGHT = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const SAFE_BOTTOM_MARGIN = 50;

  // Color palette — EarnestBridge branded
  const COLOR_PAGE_BG      = rgb(0.97, 0.97, 0.94); // warm ivory
  const COLOR_EB_GREEN     = rgb(0.06, 0.18, 0.13); // dark EB green
  const COLOR_EB_GREEN_MED = rgb(0.22, 0.38, 0.28); // medium green
  const COLOR_DIVIDER      = rgb(0.82, 0.82, 0.78); // light divider
  const COLOR_SUMMARY_BOX  = rgb(0.93, 0.93, 0.90); // slightly darker ivory
  const COLOR_DARK         = rgb(0.10, 0.10, 0.10);
  const COLOR_MEDIUM       = rgb(0.38, 0.38, 0.35);
  const COLOR_LIGHT        = rgb(0.55, 0.55, 0.52);
  const COLOR_WHITE        = rgb(1.0, 1.0, 1.0);

  // Minimal draw context for background/accent (cursor not used here)
  const bgCtx: DrawContext = {
    page, font, fontBold,
    pageWidth: PAGE_WIDTH, pageHeight: PAGE_HEIGHT,
    marginLeft: MARGIN_LEFT, marginRight: MARGIN_RIGHT,
    contentWidth: CONTENT_WIDTH,
    cursor: PAGE_HEIGHT,
    safeBottomMargin: SAFE_BOTTOM_MARGIN,
  };

  // Draw page background
  drawRect(bgCtx, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, COLOR_PAGE_BG);

  // Top accent strip (4pt)
  drawRect(bgCtx, 0, PAGE_HEIGHT - 4, PAGE_WIDTH, 4, COLOR_EB_GREEN);

  // Drawing context
  const ctx: DrawContext = {
    page,
    font,
    fontBold,
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
    marginLeft: MARGIN_LEFT,
    marginRight: MARGIN_RIGHT,
    contentWidth: CONTENT_WIDTH,
    cursor: PAGE_HEIGHT - 4,
    safeBottomMargin: SAFE_BOTTOM_MARGIN,
  };

  const currency = input.payment_currency;

  // ── HEADER ───────────────────────────────────────────────────────────────
  // LEFT:  EarnestBridge wordmark + tagline
  // RIGHT: PAYMENT RECEIPT (section title)
  //        receipt number (prominent)
  //        Issued {date} (secondary)

  ctx.cursor -= 34;

  // "EarnestBridge" wordmark (left)
  drawText(ctx, 'EarnestBridge', MARGIN_LEFT, ctx.cursor, {
    font: fontBold,
    size: 16,
    color: COLOR_EB_GREEN,
  });

  // "PAYMENT RECEIPT" — section title (right, top line)
  const receiptLabel = 'PAYMENT RECEIPT';
  const receiptLabelWidth = fontBold.widthOfTextAtSize(receiptLabel, 10);
  drawText(ctx, receiptLabel, PAGE_WIDTH - MARGIN_RIGHT - receiptLabelWidth, ctx.cursor, {
    font: fontBold,
    size: 10,
    color: COLOR_EB_GREEN_MED,
  });

  ctx.cursor -= 8;

  // Tagline (left)
  drawText(ctx, 'Lock up the Deal.', MARGIN_LEFT, ctx.cursor, {
    font,
    size: 8,
    color: COLOR_MEDIUM,
  });

  // Receipt number — prominent (right, second line)
  const receiptNumStr = input.receipt_number;
  const receiptNumWidth = fontBold.widthOfTextAtSize(receiptNumStr, 11);
  drawText(ctx, receiptNumStr, PAGE_WIDTH - MARGIN_RIGHT - receiptNumWidth, ctx.cursor, {
    font: fontBold,
    size: 11,
    color: COLOR_DARK,
  });

  ctx.cursor -= 10;

  // Issued date — secondary (right, third line)
  const issuedDateStr = `Issued ${formatTimestamp(input.receipt_issued_at)}`;
  const issuedDateWidth = font.widthOfTextAtSize(issuedDateStr, 8);
  drawText(ctx, issuedDateStr, PAGE_WIDTH - MARGIN_RIGHT - issuedDateWidth, ctx.cursor, {
    font,
    size: 8,
    color: COLOR_MEDIUM,
  });

  ctx.cursor -= 14;

  // Header divider
  checkOverflow(ctx, 2);
  drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 1.0, COLOR_EB_GREEN);
  ctx.cursor -= 18;

  // ── TWO-COLUMN DETAILS SECTION ───────────────────────────────────────────
  // LEFT:  INVOICE DETAILS — Invoice Number, Invoice Issued Date
  // RIGHT: PAYMENT DETAILS — Payment Received Date, Payment Method, Payment Reference

  const COL_MID = MARGIN_LEFT + Math.floor(CONTENT_WIDTH / 2) + 4;
  const COL_LEFT_WIDTH = COL_MID - MARGIN_LEFT - 8;
  const COL_RIGHT_WIDTH = PAGE_WIDTH - MARGIN_RIGHT - COL_MID;

  // Column label x positions
  const LEFT_LABEL_X = MARGIN_LEFT;
  const RIGHT_LABEL_X = COL_MID;

  // Column value x positions (indented from label)
  const LEFT_VALUE_X = MARGIN_LEFT;
  const RIGHT_VALUE_X = COL_MID;

  // Measure how tall each column will be
  // Left: heading + invoice number + invoice issued date
  // Right: heading + payment received date + payment method + optional reference

  const detailsStartCursor = ctx.cursor;

  // ── LEFT COLUMN: INVOICE DETAILS ─────────────────────────────────────────

  checkOverflow(ctx, 10);
  drawText(ctx, 'INVOICE DETAILS', LEFT_LABEL_X, ctx.cursor, {
    font: fontBold,
    size: 7.5,
    color: COLOR_EB_GREEN_MED,
  });

  // Track left cursor separately
  let leftCursor = ctx.cursor - 12;

  // Invoice Number
  drawText(ctx, 'Invoice Number', LEFT_LABEL_X, leftCursor, {
    font,
    size: 8,
    color: COLOR_MEDIUM,
  });
  leftCursor -= 11;
  drawText(ctx, input.invoice_number, LEFT_VALUE_X, leftCursor, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });
  leftCursor -= 13;

  // Invoice Issued Date
  drawText(ctx, 'Invoice Issued Date', LEFT_LABEL_X, leftCursor, {
    font,
    size: 8,
    color: COLOR_MEDIUM,
  });
  leftCursor -= 11;
  drawText(ctx, formatTimestamp(input.invoice_issued_at), LEFT_VALUE_X, leftCursor, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });
  leftCursor -= 13;

  // ── RIGHT COLUMN: PAYMENT DETAILS ────────────────────────────────────────

  let rightCursor = detailsStartCursor;

  drawText(ctx, 'PAYMENT DETAILS', RIGHT_LABEL_X, rightCursor, {
    font: fontBold,
    size: 7.5,
    color: COLOR_EB_GREEN_MED,
  });

  rightCursor -= 12;

  // Payment Received Date
  drawText(ctx, 'Payment Received Date', RIGHT_LABEL_X, rightCursor, {
    font,
    size: 8,
    color: COLOR_MEDIUM,
  });
  rightCursor -= 11;
  drawText(ctx, formatTimestamp(input.payment_received_at), RIGHT_VALUE_X, rightCursor, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });
  rightCursor -= 13;

  // Payment Method
  drawText(ctx, 'Payment Method', RIGHT_LABEL_X, rightCursor, {
    font,
    size: 8,
    color: COLOR_MEDIUM,
  });
  rightCursor -= 11;
  drawText(ctx, formatPaymentMethod(input.payment_method), RIGHT_VALUE_X, rightCursor, {
    font: fontBold,
    size: 8.5,
    color: COLOR_DARK,
  });
  rightCursor -= 13;

  // Payment Reference — only if non-null and non-empty
  if (input.payment_reference_number && input.payment_reference_number.trim() !== '') {
    drawText(ctx, 'Payment Reference', RIGHT_LABEL_X, rightCursor, {
      font,
      size: 8,
      color: COLOR_MEDIUM,
    });
    rightCursor -= 11;
    drawText(ctx, input.payment_reference_number.trim(), RIGHT_VALUE_X, rightCursor, {
      font: fontBold,
      size: 8.5,
      color: COLOR_DARK,
    });
    rightCursor -= 13;
  }

  // Advance main cursor past the taller of the two columns
  ctx.cursor = Math.min(leftCursor, rightCursor);

  ctx.cursor -= 10;
  checkOverflow(ctx, 1);
  drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.5, COLOR_DIVIDER);
  ctx.cursor -= 16;

  // Suppress unused variable warnings
  void COL_LEFT_WIDTH;
  void COL_RIGHT_WIDTH;

  // ── BILLING / PAYER BLOCK ────────────────────────────────────────────────

  checkOverflow(ctx, 12);
  drawText(ctx, 'BILLED TO', MARGIN_LEFT, ctx.cursor, {
    font: fontBold,
    size: 7.5,
    color: COLOR_EB_GREEN_MED,
  });
  ctx.cursor -= 13;

  // billing_name
  const billingNameTrimmed = input.billing_name?.trim() ?? '';
  const billingContactTrimmed = input.billing_contact_name?.trim() ?? '';

  if (billingNameTrimmed !== '') {
    const nameLines = wrapText(billingNameTrimmed, fontBold, 9, CONTENT_WIDTH);
    for (const line of nameLines) {
      checkOverflow(ctx, 12);
      drawText(ctx, line, MARGIN_LEFT, ctx.cursor, { font: fontBold, size: 9, color: COLOR_DARK });
      ctx.cursor -= 12;
    }
  }

  // billing_contact_name — only if non-empty AND different from billing_name
  // This deduplicates when billing_name and billing_contact_name are identical.
  if (
    billingContactTrimmed !== '' &&
    billingContactTrimmed.toLowerCase() !== billingNameTrimmed.toLowerCase()
  ) {
    const contactLines = wrapText(billingContactTrimmed, font, 8.5, CONTENT_WIDTH);
    for (const line of contactLines) {
      checkOverflow(ctx, 12);
      drawText(ctx, line, MARGIN_LEFT, ctx.cursor, { font, size: 8.5, color: COLOR_DARK });
      ctx.cursor -= 12;
    }
  }

  // Address lines
  const addrParts: string[] = [];
  if (input.billing_address_line1 && input.billing_address_line1.trim()) {
    addrParts.push(input.billing_address_line1.trim());
  }
  if (input.billing_address_line2 && input.billing_address_line2.trim()) {
    addrParts.push(input.billing_address_line2.trim());
  }

  // City, State Postal
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

  for (const addrLine of addrParts) {
    const wrapped = wrapText(addrLine, font, 8.5, CONTENT_WIDTH);
    for (const line of wrapped) {
      checkOverflow(ctx, 12);
      drawText(ctx, line, MARGIN_LEFT, ctx.cursor, { font, size: 8.5, color: COLOR_MEDIUM });
      ctx.cursor -= 12;
    }
  }

  ctx.cursor -= 8;
  checkOverflow(ctx, 1);
  drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.5, COLOR_DIVIDER);
  ctx.cursor -= 16;

  // ── FINANCIAL SUMMARY ────────────────────────────────────────────────────
  // Heading row: FINANCIAL SUMMARY (left)   ALL AMOUNTS {currency} (right)
  // THIS PAYMENT focal block
  // Compact rows: Invoice Total, Amount Paid After This Payment, Balance Remaining

  checkOverflow(ctx, 100);

  // Heading row
  drawText(ctx, 'FINANCIAL SUMMARY', MARGIN_LEFT, ctx.cursor, {
    font: fontBold,
    size: 8,
    color: COLOR_EB_GREEN_MED,
  });

  const allAmountsLabel = `ALL AMOUNTS ${currency}`;
  const allAmountsWidth = font.widthOfTextAtSize(allAmountsLabel, 7.5);
  drawText(ctx, allAmountsLabel, PAGE_WIDTH - MARGIN_RIGHT - allAmountsWidth, ctx.cursor, {
    font,
    size: 7.5,
    color: COLOR_MEDIUM,
  });

  ctx.cursor -= 14;

  // THIS PAYMENT focal block — draw background box
  const focalBoxHeight = 46;
  const focalBoxY = ctx.cursor - focalBoxHeight;
  drawRect(ctx, MARGIN_LEFT, focalBoxY, CONTENT_WIDTH, focalBoxHeight, COLOR_SUMMARY_BOX);

  ctx.cursor -= 10;

  // "THIS PAYMENT" label
  drawText(ctx, 'THIS PAYMENT', MARGIN_LEFT + 12, ctx.cursor, {
    font: fontBold,
    size: 7.5,
    color: COLOR_MEDIUM,
  });

  ctx.cursor -= 18;

  // Payment amount — large bold, focal
  const paymentAmountStr = formatMoney(input.payment_amount_cents, currency);
  const paymentAmountWidth = fontBold.widthOfTextAtSize(paymentAmountStr, 18);
  drawText(ctx, paymentAmountStr, MARGIN_LEFT + 12, ctx.cursor, {
    font: fontBold,
    size: 18,
    color: COLOR_EB_GREEN,
  });
  void paymentAmountWidth;

  ctx.cursor -= 8;
  ctx.cursor = focalBoxY - 12;

  // Compact summary rows
  const summaryRowH = 16;

  function drawCompactRow(
    label: string,
    value: string,
    labelFont: PDFFont,
    valueFont: PDFFont,
    labelColor: ReturnType<typeof rgb>,
    valueColor: ReturnType<typeof rgb>,
  ): void {
    checkOverflow(ctx, summaryRowH);
    drawText(ctx, label, MARGIN_LEFT + 10, ctx.cursor, {
      font: labelFont,
      size: 8.5,
      color: labelColor,
    });
    const vw = valueFont.widthOfTextAtSize(value, 8.5);
    drawText(ctx, value, PAGE_WIDTH - MARGIN_RIGHT - 10 - vw, ctx.cursor, {
      font: valueFont,
      size: 8.5,
      color: valueColor,
    });
    ctx.cursor -= summaryRowH;
  }

  drawCompactRow(
    'Invoice Total',
    formatMoney(input.invoice_total_cents, currency),
    font, font,
    COLOR_MEDIUM, COLOR_DARK,
  );

  drawCompactRow(
    'Amount Paid After This Payment',
    formatMoney(input.amount_paid_after_cents, currency),
    font, font,
    COLOR_MEDIUM, COLOR_DARK,
  );

  const isPaidInFull = input.balance_remaining_after_cents === 0;

  drawCompactRow(
    'Balance Remaining',
    formatMoney(input.balance_remaining_after_cents, currency),
    font,
    fontBold,
    COLOR_MEDIUM,
    isPaidInFull ? COLOR_EB_GREEN_MED : COLOR_DARK,
  );

  ctx.cursor -= 14;

  // ── CONFIRMATION SENTENCE ────────────────────────────────────────────────
  // One sentence only, directly below financial summary.

  checkOverflow(ctx, 24);

  let confirmationText: string;
  if (isPaidInFull) {
    confirmationText =
      'This receipt confirms the payment shown above was received and applied to ' + 'the referenced invoice. The invoice balance is now $0.00.';
  } else {
    const balanceStr = formatMoney(input.balance_remaining_after_cents, currency);
    confirmationText =
      'This receipt confirms the payment shown above was received and applied to ' +
      `the referenced invoice. A balance of ${balanceStr} remains.`;
  }

  const confirmLines = wrapText(confirmationText, font, 8, CONTENT_WIDTH);
  for (const line of confirmLines) {
    checkOverflow(ctx, 12);
    drawText(ctx, line, MARGIN_LEFT, ctx.cursor, { font, size: 8, color: COLOR_MEDIUM });
    ctx.cursor -= 12;
  }

  // ── FOOTER ───────────────────────────────────────────────────────────────
  // Minimal: subtle rule + "EarnestBridge  ·  Payment Receipt · {receipt_number}"
  // No duplicate confirmation language.

  const FOOTER_Y = SAFE_BOTTOM_MARGIN + 16;

  // Footer rule
  drawLine(ctx, MARGIN_LEFT, FOOTER_Y + 12, PAGE_WIDTH - MARGIN_RIGHT, FOOTER_Y + 12, 0.5, COLOR_DIVIDER);

  // Footer text — centered
  const footerStr = `EarnestBridge  ·  Payment Receipt · ${input.receipt_number}`;
  const footerWidth = font.widthOfTextAtSize(footerStr, 7.5);
  const footerX = MARGIN_LEFT + (CONTENT_WIDTH - footerWidth) / 2;
  drawText(ctx, footerStr, footerX, FOOTER_Y, {
    font,
    size: 7.5,
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
