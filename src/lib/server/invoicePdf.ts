/**
 * src/lib/server/invoicePdf.ts
 *
 * Pure server-side invoice PDF renderer.
 *
 * Step: 6A-5C3 (hardened in 6A-5C3.1, final cleanup in 6A-5C3.2)
 * Restyled: 6A-5C5A — EarnestBridge branded layout
 * Polished:  6A-5C5C — Final visual polish pass
 *
 * This module is SERVER-ONLY. It must never be imported into a Client Component bundle.
 * It does NOT:
 *   - authenticate users
 *   - query Supabase
 *   - access service_role
 *   - upload files
 *   - mutate invoice state
 *   - call RPCs
 *
 * It accepts an already-prepared immutable invoice snapshot and returns PDF bytes.
 *
 * Storage immutability note (for future orchestration):
 *   PDF uploads MUST use { upsert: false }.
 *   Issued PDFs are immutable. Retry behavior:
 *     A. No object exists → upload with upsert:false
 *     B. Object exists AND invoice is still issuing → fetch/verify/reuse existing object
 *     C. Invoice already open → never upload or replace the PDF object
 *
 * NULL failure code rejected: YES (enforced in mark_invoice_pdf_failed RPC)
 *
 * 6A-5C3.1 hardening summary:
 *   - discount_cents displayed as negative reduction in totals block
 *   - billing_email rendered in BILL TO block
 *   - FROM/BILL TO columns pre-measured; single checkOverflow(); no independent billingCursor overflow bug
 *   - issuer fields width-wrapped
 *   - wrapText fails closed (INVOICE_PDF_CONTENT_OVERFLOW) on unbreakable token wider than maxWidth
 *   - wrapText supports explicit \n / \r\n line breaks
 *   - assertTextFits helper added for single-line values (routing/account/invoice numbers)
 *   - routing_number and account_number width-checked before draw; fail closed
 *   - Deal Summary layout fixed: Row1=EMD+FundingDate, Row2=BillingPeriod full-width, Row3=BillableDays
 *   - Money fields require Number.isSafeInteger()
 *   - Line item numeric fields validated (quantity, unit_amount_cents, line_amount_cents, sort_order)
 *   - DATE fields (due_date, funding_date, period_start_date, period_end_date) validated as YYYY-MM-DD
 *   - issuing_started_at timezone behavior preserved (America/New_York)
 *   - City/state/postal formatted as "City, ST 12345" (no trailing comma before postal)
 *   - Sensitive values never included in error messages
 *   - Raw input never logged
 *
 * 6A-5C3.2 final PDF layout fail-closed cleanup:
 *   - Wrapped wire fields (Bank Name, Account Name, Bank Address, Memo) now pre-measure total
 *     required height and call checkOverflow() ONCE before drawing; ctx.cursor decremented
 *     directly for each rendered line — no independent local Y cursor invisible to checkOverflow()
 *   - assertTextFits() applied to line-item table: quantity, unit price, line amount per column width
 *   - assertTextFits() applied to totals: subtotal, discount, tax (when rendered), TOTAL DUE
 *   - FROM/BILL TO block height reservation now includes divider spacing (6pt before + 14pt after)
 *     so the full block including its divider remains above safeBottomMargin
 *   - Header issuer name width-checked against safe header-left area; fail-closed if it cannot fit
 *   - issuing_started_at validated as a real timestamp before rendering (INVOICE_PDF_INVALID_DATA)
 *
 * 6A-5C5A restyle:
 *   - Warm ivory/off-white page background
 *   - Dark EarnestBridge green color palette (navy header removed)
 *   - Thin dark-green top accent strip
 *   - Logo + EarnestBridge wordmark header (upper-left)
 *   - Large muted INVOICE + invoice number (upper-right)
 *   - "Lock up the Deal." / "Keep your capital free." tagline (serif fonts)
 *   - Compact EMD details strip (no large DEAL SUMMARY block)
 *   - Simplified line-item table: DESCRIPTION / QTY / AMOUNT (unit price column removed visually)
 *   - Shaded payment instructions box
 *   - Restyled footer
 *   - All safety guards, input validation, and business data preserved
 *
 * 6A-5C5C polish:
 *   - FIXED: Account Number label → wire.account_number, Routing Number label → wire.routing_number
 *   - Branding enlarged ~15% (logo max height 42pt, wordmark 17pt)
 *   - Hero tagline enlarged ~25% (main 16pt), subtitle ~15% (sub 11.5pt)
 *   - Duplicate invoice number removed from billing metadata area (DUE DATE + ISSUE DATE only)
 *   - Vertical breathing room increased throughout (~15% more spacing)
 *   - Line-item row padding increased for more premium feel
 *   - Payment instructions box made more compact (two-column wire fields)
 *   - Footer contrast slightly increased (COLOR_FOOTER replaces COLOR_LIGHT for footer text)
 */

import 'server-only';

import fs from 'fs';
import path from 'path';
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  rgb,
} from 'pdf-lib';

// ---------------------------------------------------------------------------
// Safe renderer error codes
// ---------------------------------------------------------------------------

export type InvoicePdfErrorCode =
  | 'INVOICE_PDF_INVALID_DATA' |'INVOICE_PDF_CONTENT_OVERFLOW' |'INVOICE_PDF_LOGO_ERROR' |'INVOICE_PDF_RENDER_ERROR';

export class InvoicePdfError extends Error {
  public readonly code: InvoicePdfErrorCode;

  constructor(code: InvoicePdfErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'InvoicePdfError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Wire snapshot type (explicit — no `any`)
// ---------------------------------------------------------------------------

export interface WireSnapshotIssuer {
  legal_name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

export interface WireSnapshotWire {
  bank_name: string;
  account_name: string;
  routing_number: string;
  account_number: string;
  bank_address: string | null;
  memo_instructions: string | null;
}

export interface WireSnapshotInvoiceText {
  tagline: string | null;
  footer_text: string | null;
}

export interface WireSnapshot {
  schema_version: 1;
  issuer: WireSnapshotIssuer;
  wire: WireSnapshotWire;
  invoice_text: WireSnapshotInvoiceText;
}

// ---------------------------------------------------------------------------
// Line item type
// ---------------------------------------------------------------------------

export interface InvoiceLineItem {
  line_type: string;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  line_amount_cents: number;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// Invoice snapshot input type
// ---------------------------------------------------------------------------

export interface InvoicePdfInput {
  invoice_id: string;
  invoice_number: string;
  application_id: string;
  currency: string;

  issuing_started_at: string;
  due_date: string;

  billing_name: string | null;
  billing_contact_name: string | null;
  billing_email: string;
  billing_address_line1: string | null;
  billing_address_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_postal_code: string | null;
  billing_country: string | null;

  emd_funded_cents: number;
  funding_date: string;
  period_start_date: string;
  period_end_date: string;
  billable_days: number;

  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;

  credit_card_payment_enabled_snapshot: boolean;

  invoice_notes: string | null;

  wire_snapshot: WireSnapshot;

  line_items: InvoiceLineItem[];
}

// ---------------------------------------------------------------------------
// DATE validation helper (YYYY-MM-DD only — no timezone shift)
// ---------------------------------------------------------------------------

const DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function validateDateField(value: string, fieldName: string): void {
  if (!DATE_REGEX.test(value)) {
    throw new InvoicePdfError(
      'INVOICE_PDF_INVALID_DATA',
      `Field ${fieldName} is not a valid YYYY-MM-DD date.`,
    );
  }
  // Additional calendar sanity: parse and verify it doesn't normalize to a different date
  const [year, month, day] = value.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() + 1 !== month ||
    d.getDate() !== day
  ) {
    throw new InvoicePdfError(
      'INVOICE_PDF_INVALID_DATA',
      `Field ${fieldName} is not a valid calendar date.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateInput(input: InvoicePdfInput): void {
  const missing: string[] = [];

  if (!input.invoice_id) missing.push('invoice_id');
  if (!input.application_id) missing.push('application_id');
  if (!input.invoice_number) missing.push('invoice_number');
  if (!input.currency) missing.push('currency');
  if (!input.billing_email) missing.push('billing_email');

  if (missing.length > 0) {
    throw new InvoicePdfError(
      'INVOICE_PDF_INVALID_DATA',
      `Missing required render fields: ${missing.join(', ')}`,
    );
  }

  // issuing_started_at: required PostgreSQL timestamptz — validate as a real timestamp
  // Preserve America/New_York display behavior; do not include raw value in error.
  if (!input.issuing_started_at) {
    throw new InvoicePdfError(
      'INVOICE_PDF_INVALID_DATA',
      'Missing required render field: issuing_started_at',
    );
  }
  const parsedIssuingStartedAt = new Date(input.issuing_started_at);
  if (isNaN(parsedIssuingStartedAt.getTime())) {
    throw new InvoicePdfError(
      'INVOICE_PDF_INVALID_DATA',
      'Field issuing_started_at is not a valid timestamp.',
    );
  }

  // DATE field validation (YYYY-MM-DD, no timezone shift)
  if (!input.due_date) {
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'Missing required render field: due_date');
  }
  validateDateField(input.due_date, 'due_date');

  if (!input.funding_date) {
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'Missing required render field: funding_date');
  }
  validateDateField(input.funding_date, 'funding_date');

  if (!input.period_start_date) {
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'Missing required render field: period_start_date');
  }
  validateDateField(input.period_start_date, 'period_start_date');

  if (!input.period_end_date) {
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'Missing required render field: period_end_date');
  }
  validateDateField(input.period_end_date, 'period_end_date');

  // Safe integer validation for money fields
  const moneyFields: Array<[keyof InvoicePdfInput, string]> = [
    ['emd_funded_cents', 'emd_funded_cents'],
    ['subtotal_cents', 'subtotal_cents'],
    ['discount_cents', 'discount_cents'],
    ['tax_cents', 'tax_cents'],
    ['total_cents', 'total_cents'],
  ];
  for (const [field, label] of moneyFields) {
    const val = input[field];
    if (val == null || !Number.isSafeInteger(val as number)) {
      throw new InvoicePdfError(
        'INVOICE_PDF_INVALID_DATA',
        `Field ${label} must be a safe integer.`,
      );
    }
  }

  // billable_days: integer >= 0
  if (input.billable_days == null || !Number.isInteger(input.billable_days) || input.billable_days < 0) {
    throw new InvoicePdfError(
      'INVOICE_PDF_INVALID_DATA',
      'Field billable_days must be an integer >= 0.',
    );
  }

  // Wire snapshot validation
  if (!input.wire_snapshot) {
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'Missing required render field: wire_snapshot');
  }
  if (input.wire_snapshot.schema_version !== 1) {
    throw new InvoicePdfError(
      'INVOICE_PDF_INVALID_DATA',
      'wire_snapshot.schema_version must be 1',
    );
  }
  if (!input.wire_snapshot.issuer?.legal_name) {
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'Missing required render field: wire_snapshot.issuer.legal_name');
  }
  const wireRequired = ['bank_name', 'account_name', 'routing_number', 'account_number'] as const;
  for (const f of wireRequired) {
    if (!input.wire_snapshot.wire?.[f]) {
      throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', `Missing required render field: wire_snapshot.wire.${f}`);
    }
  }

  // Line items
  if (!input.line_items || input.line_items.length === 0) {
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'At least one line item is required.');
  }

  for (let i = 0; i < input.line_items.length; i++) {
    const item = input.line_items[i];
    if (!item.description || item.description.trim().length === 0) {
      throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', `Line item at index ${i} has empty description.`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', `Line item at index ${i}: quantity must be integer > 0.`);
    }
    if (!Number.isSafeInteger(item.unit_amount_cents)) {
      throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', `Line item at index ${i}: unit_amount_cents must be a safe integer.`);
    }
    if (!Number.isSafeInteger(item.line_amount_cents)) {
      throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', `Line item at index ${i}: line_amount_cents must be a safe integer.`);
    }
    if (!Number.isInteger(item.sort_order)) {
      throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', `Line item at index ${i}: sort_order must be an integer.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Money formatting (integer cents only — no floating-point arithmetic)
// ---------------------------------------------------------------------------

function formatMoney(cents: number, currency: string = 'USD'): string {
  const isNegative = cents < 0;
  const absCents = Math.abs(cents);
  const dollars = Math.floor(absCents / 100);
  const centsRemainder = absCents % 100;

  const dollarsFormatted = dollars.toLocaleString('en-US');
  const centsFormatted = centsRemainder.toString().padStart(2, '0');

  const symbol = currency === 'USD' ? '$' : currency + ' ';
  const formatted = `${symbol}${dollarsFormatted}.${centsFormatted}`;
  return isNegative ? `-${formatted}` : formatted;
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

// issuing_started_at: timestamp → America/New_York business date
function formatDateNY(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// DATE columns (YYYY-MM-DD) — no timezone conversion
function formatDateSimple(isoDateString: string): string {
  const [year, month, day] = isoDateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// Compact date for space-constrained areas (e.g. EMD strip)
function formatDateCompact(isoDateString: string): string {
  const [year, month, day] = isoDateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// City / State / Postal formatting helper
// Produces "City, ST 12345" — no trailing comma before postal
// ---------------------------------------------------------------------------

function formatCityStatePostal(
  city: string | null,
  state: string | null,
  postalCode: string | null,
): string {
  const parts: string[] = [];
  if (city) parts.push(city);

  if (state && postalCode) {
    if (parts.length > 0) {
      parts[parts.length - 1] = parts[parts.length - 1];
      parts.push(`${state} ${postalCode}`);
    } else {
      parts.push(`${state} ${postalCode}`);
    }
  } else if (state) {
    parts.push(state);
  } else if (postalCode) {
    parts.push(postalCode);
  }

  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Text wrapping helper — FAIL CLOSED on unbreakable tokens
// Supports explicit \n and \r\n line breaks
// ---------------------------------------------------------------------------

function wrapText(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  // First split on explicit newlines
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

      // Fail closed: if a single token is wider than maxWidth, throw
      const tokenWidth = font.widthOfTextAtSize(word, fontSize);
      if (tokenWidth > maxWidth) {
        throw new InvoicePdfError(
          'INVOICE_PDF_CONTENT_OVERFLOW',
          'A content token exceeds the permitted column width and cannot be rendered safely.',
        );
      }

      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (testWidth <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          result.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      result.push(currentLine);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single-line width check helper (assertTextFits)
// Use for values that must remain on one line: invoice_number, routing_number,
// account_number, money amounts, etc.
// Throws INVOICE_PDF_CONTENT_OVERFLOW if the text exceeds maxWidth.
// Does NOT include the text value in the error message.
// ---------------------------------------------------------------------------

function assertTextFits(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  fieldLabel: string,
): void {
  const w = font.widthOfTextAtSize(text, size);
  if (w > maxWidth) {
    throw new InvoicePdfError(
      'INVOICE_PDF_CONTENT_OVERFLOW',
      `Field ${fieldLabel} exceeds the permitted column width and cannot be rendered on one line.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

interface DrawContext {
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  fontSerif: PDFFont;
  fontSerifBold: PDFFont;
  fontSerifItalic: PDFFont;
  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginRight: number;
  contentWidth: number;
  cursor: number; // current Y position (decrements as we draw downward)
  safeBottomMargin: number;
}

function checkOverflow(ctx: DrawContext, requiredHeight: number): void {
  if (ctx.cursor - requiredHeight < ctx.safeBottomMargin) {
    throw new InvoicePdfError(
      'INVOICE_PDF_CONTENT_OVERFLOW',
      'Invoice content exceeds one-page limit. Cannot render without truncation.',
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
    color: options.color ?? rgb(0, 0, 0),
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
  ctx.page.drawRectangle({
    x,
    y,
    width,
    height,
    color,
  });
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  // 1. Validate input
  try {
    validateInput(input);
  } catch (err) {
    if (err instanceof InvoicePdfError) throw err;
    throw new InvoicePdfError('INVOICE_PDF_INVALID_DATA', 'Input validation failed.');
  }

  // 2. Sort line items deterministically
  const sortedLineItems = [...input.line_items].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.description.localeCompare(b.description);
  });

  // 3. Load logo from filesystem
  let logoPngBytes: Uint8Array;
  try {
    const logoPath = path.join(process.cwd(), 'public', 'assets', 'images', 'app_logo.png');
    const logoBuffer = fs.readFileSync(logoPath);
    logoPngBytes = new Uint8Array(logoBuffer);
  } catch {
    throw new InvoicePdfError(
      'INVOICE_PDF_LOGO_ERROR',
      'Failed to read EarnestBridge logo from filesystem.',
    );
  }

  // 4. Create PDF document
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.create();
  } catch {
    throw new InvoicePdfError('INVOICE_PDF_RENDER_ERROR', 'Failed to create PDF document.');
  }

  // 5. Set PDF metadata (safe fields only — no email, routing/account, deal address)
  pdfDoc.setTitle(`EarnestBridge Invoice ${input.invoice_number}`);
  pdfDoc.setAuthor('EarnestBridge');
  pdfDoc.setSubject('Invoice');

  // 6. Embed fonts
  let font: PDFFont;
  let fontBold: PDFFont;
  let fontSerif: PDFFont;
  let fontSerifBold: PDFFont;
  let fontSerifItalic: PDFFont;
  try {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    fontSerif = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    fontSerifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    fontSerifItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  } catch {
    throw new InvoicePdfError('INVOICE_PDF_RENDER_ERROR', 'Failed to embed fonts.');
  }

  // 7. Embed logo
  let logoImage: Awaited<ReturnType<typeof pdfDoc.embedPng>>;
  try {
    logoImage = await pdfDoc.embedPng(logoPngBytes);
  } catch {
    throw new InvoicePdfError('INVOICE_PDF_LOGO_ERROR', 'Failed to embed logo PNG into PDF.');
  }

  // 8. Add single US Letter page (612 x 792 points)
  const PAGE_WIDTH = 612;
  const PAGE_HEIGHT = 792;
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  // Layout constants
  const MARGIN_LEFT = 50;
  const MARGIN_RIGHT = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const SAFE_BOTTOM_MARGIN = 40;

  // EB branded color palette
  // Warm ivory page background
  const COLOR_PAGE_BG = rgb(0.97, 0.97, 0.94);
  // Dark EarnestBridge green
  const COLOR_EB_GREEN = rgb(0.06, 0.18, 0.13);
  // Medium muted green
  const COLOR_EB_GREEN_MED = rgb(0.22, 0.38, 0.28);
  // Light divider
  const COLOR_DIVIDER = rgb(0.82, 0.82, 0.78);
  // Payment box background (slightly darker ivory)
  const COLOR_PAYMENT_BOX = rgb(0.93, 0.93, 0.90);
  // Text colors
  const COLOR_DARK = rgb(0.10, 0.10, 0.10);
  const COLOR_MEDIUM = rgb(0.38, 0.38, 0.35);
  const COLOR_LIGHT = rgb(0.55, 0.55, 0.52);
  // Footer text — slightly more contrast than COLOR_LIGHT (6A-5C5C)
  const COLOR_FOOTER = rgb(0.40, 0.40, 0.38);
  // Muted pale for large INVOICE watermark-style text
  const COLOR_INVOICE_PALE = rgb(0.75, 0.80, 0.76);

  const ctx: DrawContext = {
    page,
    font,
    fontBold,
    fontSerif,
    fontSerifBold,
    fontSerifItalic,
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
    marginLeft: MARGIN_LEFT,
    marginRight: MARGIN_RIGHT,
    contentWidth: CONTENT_WIDTH,
    cursor: PAGE_HEIGHT - 8, // will be set after background
    safeBottomMargin: SAFE_BOTTOM_MARGIN,
  };

  try {
    // -----------------------------------------------------------------------
    // BACKGROUND — warm ivory full-page fill
    // -----------------------------------------------------------------------
    drawRect(ctx, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, COLOR_PAGE_BG);

    // -----------------------------------------------------------------------
    // TOP ACCENT STRIP — thin dark green bar across the very top
    // -----------------------------------------------------------------------
    const TOP_STRIP_HEIGHT = 5;
    drawRect(ctx, 0, PAGE_HEIGHT - TOP_STRIP_HEIGHT, PAGE_WIDTH, TOP_STRIP_HEIGHT, COLOR_EB_GREEN);

    // -----------------------------------------------------------------------
    // A. BRAND HEADER — Logo + Wordmark (left) | Large INVOICE + # (right)
    //
    // 6A-5C5C: Logo enlarged to 42pt max height (~17% larger than 36pt)
    //          Wordmark enlarged to 17pt (~13% larger than 15pt)
    // -----------------------------------------------------------------------

    const HEADER_TOP = PAGE_HEIGHT - TOP_STRIP_HEIGHT - 14; // start 14pt below strip
    const HEADER_BLOCK_HEIGHT = 68; // slightly taller to accommodate larger branding
    checkOverflow(ctx, PAGE_HEIGHT - HEADER_TOP + HEADER_BLOCK_HEIGHT);

    // Logo — upper-left (enlarged ~17%)
    const LOGO_MAX_HEIGHT = 42;
    const logoDims = logoImage.scaleToFit(116, LOGO_MAX_HEIGHT);
    const logoY = HEADER_TOP - logoDims.height;
    page.drawImage(logoImage, {
      x: MARGIN_LEFT,
      y: logoY,
      width: logoDims.width,
      height: logoDims.height,
    });

    // EarnestBridge wordmark — beside logo (enlarged to 17pt)
    const wordmarkSize = 17;
    const wordmarkX = MARGIN_LEFT + logoDims.width + 9;
    const wordmarkY = HEADER_TOP - logoDims.height + (logoDims.height - wordmarkSize) / 2 + 2;

    // Width-check wordmark against safe left area
    const HEADER_RIGHT_AREA_WIDTH = CONTENT_WIDTH * 0.38;
    const HEADER_LEFT_SAFE_WIDTH = CONTENT_WIDTH - HEADER_RIGHT_AREA_WIDTH - 10;
    const wordmarkText = 'EarnestBridge';
    assertTextFits(wordmarkText, fontSerifBold, wordmarkSize, HEADER_LEFT_SAFE_WIDTH - logoDims.width - 9, 'wordmark');
    drawText(ctx, wordmarkText, wordmarkX, wordmarkY, {
      font: fontSerifBold,
      size: wordmarkSize,
      color: COLOR_EB_GREEN,
    });

    // Large INVOICE — upper-right, muted/pale treatment
    const invoiceLabelSize = 26;
    const invoiceLabelText = 'INVOICE';
    const invoiceLabelWidth = fontSerifBold.widthOfTextAtSize(invoiceLabelText, invoiceLabelSize);
    const invoiceLabelX = PAGE_WIDTH - MARGIN_RIGHT - invoiceLabelWidth;
    const invoiceLabelY = HEADER_TOP - invoiceLabelSize - 2;
    drawText(ctx, invoiceLabelText, invoiceLabelX, invoiceLabelY, {
      font: fontSerifBold,
      size: invoiceLabelSize,
      color: COLOR_INVOICE_PALE,
    });

    // Invoice number beneath INVOICE label
    const invNumSize = 9;
    assertTextFits(input.invoice_number, fontBold, invNumSize, HEADER_RIGHT_AREA_WIDTH, 'invoice_number');
    const invNumWidth = fontBold.widthOfTextAtSize(input.invoice_number, invNumSize);
    const invNumX = PAGE_WIDTH - MARGIN_RIGHT - invNumWidth;
    const invNumY = invoiceLabelY - 14;
    drawText(ctx, input.invoice_number, invNumX, invNumY, {
      font: fontBold,
      size: invNumSize,
      color: COLOR_EB_GREEN,
    });

    // Advance cursor below header block
    ctx.cursor = Math.min(logoY, invNumY) - 20;

    // -----------------------------------------------------------------------
    // B. TAGLINE / HERO SECTION
    //
    // 6A-5C5C: Main tagline enlarged to 16pt (~23% larger than 13pt)
    //          Subtitle enlarged to 11.5pt (~15% larger than 10pt)
    // -----------------------------------------------------------------------

    checkOverflow(ctx, 50);

    const taglineMainSize = 16;
    const taglineSubSize = 11.5;
    const taglineMainText = 'Lock up the Deal.';
    const taglineSubText = 'Keep your capital free.';

    drawText(ctx, taglineMainText, MARGIN_LEFT, ctx.cursor, {
      font: fontSerifBold,
      size: taglineMainSize,
      color: COLOR_EB_GREEN,
    });
    ctx.cursor -= taglineMainSize + 7;

    drawText(ctx, taglineSubText, MARGIN_LEFT, ctx.cursor, {
      font: fontSerifItalic,
      size: taglineSubSize,
      color: COLOR_EB_GREEN_MED,
    });
    ctx.cursor -= taglineSubSize + 18;

    // Thin divider below tagline
    drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.75, COLOR_EB_GREEN);
    ctx.cursor -= 18;

    // -----------------------------------------------------------------------
    // C. BILLING HEADER — BILLED TO (left) | DUE DATE + ISSUE DATE (right)
    //
    // 6A-5C5C: Invoice number removed from right column (shown under INVOICE heading only).
    //          Right column now contains DUE DATE and ISSUE DATE only.
    //
    // Pre-measure both columns, single checkOverflow.
    // -----------------------------------------------------------------------

    const sectionLabelSize = 7;
    const addrFontSize = 8.5;
    const addrLineH = 12;
    const colBilledX = MARGIN_LEFT;
    const colDueX = MARGIN_LEFT + CONTENT_WIDTH * 0.55;
    const colHalfWidth = CONTENT_WIDTH * 0.50;

    // Divider spacing constants
    const DIVIDER_SPACING_BEFORE = 8;
    const DIVIDER_SPACING_AFTER = 16;

    // --- Pre-wrap BILLED TO column ---
    const billingLines: Array<{ text: string; bold: boolean }> = [];

    if (input.billing_name) {
      for (const l of wrapText(input.billing_name, fontBold, addrFontSize, colHalfWidth)) {
        billingLines.push({ text: l, bold: true });
      }
    }
    if (input.billing_contact_name) {
      for (const l of wrapText(input.billing_contact_name, font, addrFontSize, colHalfWidth)) {
        billingLines.push({ text: l, bold: false });
      }
    }
    if (input.billing_address_line1) {
      for (const l of wrapText(input.billing_address_line1, font, addrFontSize, colHalfWidth)) {
        billingLines.push({ text: l, bold: false });
      }
    }
    if (input.billing_address_line2) {
      for (const l of wrapText(input.billing_address_line2, font, addrFontSize, colHalfWidth)) {
        billingLines.push({ text: l, bold: false });
      }
    }
    const billingCityLine = formatCityStatePostal(
      input.billing_city,
      input.billing_state,
      input.billing_postal_code,
    );
    if (billingCityLine) {
      for (const l of wrapText(billingCityLine, font, addrFontSize, colHalfWidth)) {
        billingLines.push({ text: l, bold: false });
      }
    }
    if (input.billing_country && input.billing_country !== 'US') {
      for (const l of wrapText(input.billing_country, font, addrFontSize, colHalfWidth)) {
        billingLines.push({ text: l, bold: false });
      }
    }
    // billing_email — smaller muted style
    for (const l of wrapText(input.billing_email, font, 7.5, colHalfWidth)) {
      billingLines.push({ text: l, bold: false });
    }

    const leftHeight = billingLines.length * addrLineH;

    // --- Right column: DUE DATE + Issue Date only (invoice # removed — shown under INVOICE heading) ---
    const issueDate = formatDateNY(input.issuing_started_at);
    const dueDate = formatDateSimple(input.due_date);

    // Right column: DUE DATE label + value + gap + Issue Date label + value = 5 rows
    const rightMetaLines = 5;
    const rightHeight = rightMetaLines * addrLineH;

    const blockHeight =
      addrLineH /* section label row */ +
      Math.max(leftHeight, rightHeight) +
      DIVIDER_SPACING_BEFORE +
      DIVIDER_SPACING_AFTER;
    checkOverflow(ctx, blockHeight);

    // Section labels
    drawText(ctx, 'BILLED TO', colBilledX, ctx.cursor, {
      font: fontBold,
      size: sectionLabelSize,
      color: COLOR_EB_GREEN_MED,
    });
    drawText(ctx, 'DUE DATE', colDueX, ctx.cursor, {
      font: fontBold,
      size: sectionLabelSize,
      color: COLOR_EB_GREEN_MED,
    });
    ctx.cursor -= addrLineH;

    const blockStartY = ctx.cursor;

    // Draw BILLED TO column
    let leftY = blockStartY;
    for (const bl of billingLines) {
      // billing_email lines are the last ones — render them smaller and muted
      const isEmailLine = !bl.bold && leftY < blockStartY - (billingLines.length - 1) * addrLineH + addrLineH;
      drawText(ctx, bl.text, colBilledX, leftY, {
        font: bl.bold ? fontBold : font,
        size: isEmailLine ? 7.5 : addrFontSize,
        color: bl.bold ? COLOR_DARK : COLOR_MEDIUM,
      });
      leftY -= addrLineH;
    }

    // Draw right column: DUE DATE value
    let rightY = blockStartY;
    const dueDateValueSize = 11;
    drawText(ctx, dueDate, colDueX, rightY, {
      font: fontSerifBold,
      size: dueDateValueSize,
      color: COLOR_EB_GREEN,
    });
    rightY -= addrLineH + 6;

    // Issue Date label + value
    drawText(ctx, 'ISSUE DATE', colDueX, rightY, {
      font: fontBold,
      size: sectionLabelSize,
      color: COLOR_EB_GREEN_MED,
    });
    rightY -= addrLineH;
    drawText(ctx, issueDate, colDueX, rightY, {
      font,
      size: addrFontSize,
      color: COLOR_DARK,
    });
    rightY -= addrLineH;

    ctx.cursor = Math.min(leftY, rightY) - DIVIDER_SPACING_BEFORE;

    drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.5, COLOR_DIVIDER);
    ctx.cursor -= DIVIDER_SPACING_AFTER;

    // -----------------------------------------------------------------------
    // D. EMD DETAILS STRIP — compact two-column metadata block
    //    (replaces the large DEAL SUMMARY visual block)
    // -----------------------------------------------------------------------

    checkOverflow(ctx, 56);

    const emdFontSize = 8;
    const emdLineH = 12;
    const emdLabelX = MARGIN_LEFT;
    const emdValueX = MARGIN_LEFT + 110;
    const emdRightLabelX = MARGIN_LEFT + CONTENT_WIDTH * 0.52;
    const emdRightValueX = emdRightLabelX + 110;
    const emdValueWidth = CONTENT_WIDTH * 0.40;
    const emdRightValueWidth = CONTENT_WIDTH - (emdRightValueX - MARGIN_LEFT);

    const emdText = formatMoney(input.emd_funded_cents, input.currency);
    const fundingDateText = formatDateCompact(input.funding_date);
    const periodText = `${formatDateCompact(input.period_start_date)} – ${formatDateCompact(input.period_end_date)}`;
    const billableDaysText = String(input.billable_days);

    assertTextFits(emdText, font, emdFontSize, emdValueWidth, 'emd_funded_cents');
    assertTextFits(fundingDateText, font, emdFontSize, emdRightValueWidth, 'funding_date');
    assertTextFits(billableDaysText, font, emdFontSize, emdRightValueWidth, 'billable_days');

    // Row 1: EMD Funded | Funding Date
    drawText(ctx, 'EMD Funded', emdLabelX, ctx.cursor, { font, size: emdFontSize, color: COLOR_LIGHT });
    drawText(ctx, emdText, emdValueX, ctx.cursor, { font: fontBold, size: emdFontSize, color: COLOR_DARK });
    drawText(ctx, 'Funding Date', emdRightLabelX, ctx.cursor, { font, size: emdFontSize, color: COLOR_LIGHT });
    drawText(ctx, fundingDateText, emdRightValueX, ctx.cursor, { font: fontBold, size: emdFontSize, color: COLOR_DARK });
    ctx.cursor -= emdLineH;

    // Row 2: Billing Period (full-width to avoid overlap)
    const periodLines = wrapText(periodText, fontBold, emdFontSize, emdValueWidth);
    drawText(ctx, 'Billing Period', emdLabelX, ctx.cursor, { font, size: emdFontSize, color: COLOR_LIGHT });
    let periodY = ctx.cursor;
    for (const pl of periodLines) {
      drawText(ctx, pl, emdValueX, periodY, { font: fontBold, size: emdFontSize, color: COLOR_DARK });
      periodY -= emdLineH;
    }
    ctx.cursor = periodY;

    // Row 3: Billable Days (right side)
    drawText(ctx, 'Billable Days', emdRightLabelX, ctx.cursor, { font, size: emdFontSize, color: COLOR_LIGHT });
    drawText(ctx, billableDaysText, emdRightValueX, ctx.cursor, { font: fontBold, size: emdFontSize, color: COLOR_DARK });
    ctx.cursor -= emdLineH + 12;

    drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.5, COLOR_DIVIDER);
    ctx.cursor -= 14;

    // -----------------------------------------------------------------------
    // E. LINE ITEM TABLE
    //
    // Visual columns: DESCRIPTION | QTY | AMOUNT
    // unit_amount_cents is NOT shown visually (per spec).
    // Underlying InvoiceLineItem model is unchanged.
    //
    // Column layout:
    //   COL_DESC_X  — description (left)
    //   COL_QTY_X   — quantity (center)
    //   COL_AMT_X   — amount (right-aligned)
    //
    // 6A-5C5C: Row padding increased for more premium feel
    // -----------------------------------------------------------------------

    const COL_DESC_X = MARGIN_LEFT;
    const COL_QTY_X = MARGIN_LEFT + CONTENT_WIDTH * 0.62;
    const COL_AMT_X = MARGIN_LEFT + CONTENT_WIDTH * 0.76;
    const COL_DESC_WIDTH = CONTENT_WIDTH * 0.60;
    const COL_QTY_WIDTH = CONTENT_WIDTH * 0.12;
    const COL_AMT_WIDTH = CONTENT_WIDTH * 0.24;

    const tableHeaderH = 22;
    checkOverflow(ctx, tableHeaderH);

    // Table header — thin dark green line beneath header text
    const tableHeaderFontSize = 7.5;
    const tableHeaderY = ctx.cursor - 13;

    drawText(ctx, 'DESCRIPTION', COL_DESC_X + 4, tableHeaderY, {
      font: fontSerifBold,
      size: tableHeaderFontSize,
      color: COLOR_EB_GREEN,
    });
    drawText(ctx, 'QTY', COL_QTY_X, tableHeaderY, {
      font: fontSerifBold,
      size: tableHeaderFontSize,
      color: COLOR_EB_GREEN,
    });

    const amtHeaderText = 'AMOUNT';
    const amtHeaderWidth = fontSerifBold.widthOfTextAtSize(amtHeaderText, tableHeaderFontSize);
    drawText(ctx, amtHeaderText, COL_AMT_X + COL_AMT_WIDTH - amtHeaderWidth - 4, tableHeaderY, {
      font: fontSerifBold,
      size: tableHeaderFontSize,
      color: COLOR_EB_GREEN,
    });

    ctx.cursor -= tableHeaderH;

    // Dark green rule beneath table header
    drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 1.0, COLOR_EB_GREEN);
    ctx.cursor -= 2;

    const rowFontSize = 8.5;
    const rowLineH = 13;
    // 6A-5C5C: Increased row padding for more premium, less spreadsheet-like feel
    const rowPaddingV = 7;

    for (const item of sortedLineItems) {
      const descLines = wrapText(item.description, font, rowFontSize, COL_DESC_WIDTH - 8);
      const rowHeight = descLines.length * rowLineH + rowPaddingV * 2;

      checkOverflow(ctx, rowHeight);

      const rowTopY = ctx.cursor;

      let descY = rowTopY - rowPaddingV - rowLineH + 3;
      for (const line of descLines) {
        drawText(ctx, line, COL_DESC_X + 4, descY, { font, size: rowFontSize, color: COLOR_DARK });
        descY -= rowLineH;
      }

      const rowMidY = rowTopY - rowHeight / 2 - rowFontSize / 2 + 2;

      // Quantity — centered
      const qtyText = String(item.quantity);
      assertTextFits(qtyText, font, rowFontSize, COL_QTY_WIDTH, 'line_item_quantity');
      drawText(ctx, qtyText, COL_QTY_X, rowMidY, { font, size: rowFontSize, color: COLOR_DARK });

      // Amount (right-aligned) — unit price NOT shown visually
      const amtText = formatMoney(item.line_amount_cents, input.currency);
      assertTextFits(amtText, font, rowFontSize, COL_AMT_WIDTH - 8, 'line_item_amount');
      const amtWidth = font.widthOfTextAtSize(amtText, rowFontSize);
      drawText(ctx, amtText, COL_AMT_X + COL_AMT_WIDTH - amtWidth - 4, rowMidY, {
        font,
        size: rowFontSize,
        color: item.line_amount_cents < 0 ? rgb(0.65, 0.10, 0.10) : COLOR_DARK,
      });

      ctx.cursor -= rowHeight;

      // Subtle divider between rows
      drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.3, COLOR_DIVIDER);
    }

    ctx.cursor -= 14;

    // -----------------------------------------------------------------------
    // F. TOTALS — right-aligned block
    //
    // All totals values are width-checked with assertTextFits before drawing.
    // Tax (0%) is always shown.
    // 6A-5C5C: Slightly more spacing between Tax and Total Due rule
    // -----------------------------------------------------------------------

    const totalsLabelX = MARGIN_LEFT + CONTENT_WIDTH * 0.58;
    const totalsValueX = MARGIN_LEFT + CONTENT_WIDTH * 0.76;
    const totalsValueWidth = CONTENT_WIDTH * 0.24;
    const totalsFontSize = 8.5;
    const totalsLineH = 14;
    const totalsAvailableWidth = totalsValueWidth - 4;

    checkOverflow(ctx, 76);

    // Subtotal
    drawText(ctx, 'Subtotal', totalsLabelX, ctx.cursor, { font, size: totalsFontSize, color: COLOR_MEDIUM });
    const subtotalText = formatMoney(input.subtotal_cents, input.currency);
    assertTextFits(subtotalText, font, totalsFontSize, totalsAvailableWidth, 'subtotal');
    const subtotalWidth = font.widthOfTextAtSize(subtotalText, totalsFontSize);
    drawText(ctx, subtotalText, totalsValueX + totalsValueWidth - subtotalWidth - 4, ctx.cursor, {
      font,
      size: totalsFontSize,
      color: COLOR_DARK,
    });
    ctx.cursor -= totalsLineH;

    // Discount — only when discount_cents > 0
    if (input.discount_cents !== 0) {
      checkOverflow(ctx, totalsLineH);
      drawText(ctx, 'Discount', totalsLabelX, ctx.cursor, { font, size: totalsFontSize, color: COLOR_MEDIUM });
      const discountText = formatMoney(-input.discount_cents, input.currency);
      assertTextFits(discountText, font, totalsFontSize, totalsAvailableWidth, 'discount');
      const discountWidth = font.widthOfTextAtSize(discountText, totalsFontSize);
      drawText(ctx, discountText, totalsValueX + totalsValueWidth - discountWidth - 4, ctx.cursor, {
        font,
        size: totalsFontSize,
        color: rgb(0.65, 0.10, 0.10),
      });
      ctx.cursor -= totalsLineH;
    }

    // Tax (0%) — always shown
    checkOverflow(ctx, totalsLineH);
    drawText(ctx, 'Tax (0%)', totalsLabelX, ctx.cursor, { font, size: totalsFontSize, color: COLOR_MEDIUM });
    const taxText = formatMoney(input.tax_cents, input.currency);
    assertTextFits(taxText, font, totalsFontSize, totalsAvailableWidth, 'tax');
    const taxWidth = font.widthOfTextAtSize(taxText, totalsFontSize);
    drawText(ctx, taxText, totalsValueX + totalsValueWidth - taxWidth - 4, ctx.cursor, {
      font,
      size: totalsFontSize,
      color: COLOR_DARK,
    });
    // 6A-5C5C: Slightly more spacing before Total Due rule
    ctx.cursor -= totalsLineH + 8;

    // Dark green rule above Total Due
    drawLine(ctx, totalsLabelX, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 1.5, COLOR_EB_GREEN);
    ctx.cursor -= 14;

    checkOverflow(ctx, 22);

    const totalDueLabelSize = 10;
    const totalDueValueSize = 12;
    drawText(ctx, 'Total Due', totalsLabelX, ctx.cursor, {
      font: fontSerifBold,
      size: totalDueLabelSize,
      color: COLOR_EB_GREEN,
    });
    const totalText = formatMoney(input.total_cents, input.currency);
    assertTextFits(totalText, fontSerifBold, totalDueValueSize, totalsAvailableWidth, 'total_due');
    const totalWidth = fontSerifBold.widthOfTextAtSize(totalText, totalDueValueSize);
    drawText(ctx, totalText, totalsValueX + totalsValueWidth - totalWidth - 4, ctx.cursor, {
      font: fontSerifBold,
      size: totalDueValueSize,
      color: COLOR_EB_GREEN,
    });
    ctx.cursor -= 26;

    drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.5, COLOR_DIVIDER);
    ctx.cursor -= 18;

    // -----------------------------------------------------------------------
    // G. PAYMENT INSTRUCTIONS — shaded ivory/gray box (compact layout)
    //
    // 6A-5C5C: Compact two-column layout for wire fields to reduce box height.
    //          FIXED: Account Number label → wire.account_number
    //                 Routing Number label → wire.routing_number
    //
    // Wire data sourced from wire_instructions_snapshot only (server-side).
    // routing_number and account_number width-checked before draw; fail closed.
    // No sensitive values in error messages.
    // -----------------------------------------------------------------------

    const wire = input.wire_snapshot.wire;
    const issuer = input.wire_snapshot.issuer;
    const wireFontSize = 8;
    const wireLineH = 11;

    // Compact two-column layout constants
    const wireBoxPaddingH = 10;
    const wireBoxPaddingV = 9;
    const wireCol1X = MARGIN_LEFT + wireBoxPaddingH;
    const wireCol2X = MARGIN_LEFT + wireBoxPaddingH + 100; // label col width = 100
    const wireCol2Width = CONTENT_WIDTH - wireBoxPaddingH * 2 - 100;

    // Pre-wrap variable-length fields
    const bankNameLines = wrapText(wire.bank_name, font, wireFontSize, wireCol2Width);
    const accountNameLines = wrapText(wire.account_name, font, wireFontSize, wireCol2Width);
    let bankAddressLines: string[] = [];
    if (wire.bank_address) {
      bankAddressLines = wrapText(wire.bank_address, font, wireFontSize, wireCol2Width);
    }
    let memoLines: string[] = [];
    if (wire.memo_instructions) {
      memoLines = wrapText(wire.memo_instructions, font, wireFontSize, CONTENT_WIDTH - wireBoxPaddingH * 2);
    }

    // Pre-measure total box height
    // heading + remit + gap + "Bank Transfer:" + bank_name + account_name + routing + account
    // + optional bank_address + optional memo
    let paymentBoxLineCount = 0;
    paymentBoxLineCount += 1; // heading
    const remitText = `Please remit payment to ${issuer.legal_name}`;
    const remitLines = wrapText(remitText, font, wireFontSize, CONTENT_WIDTH - wireBoxPaddingH * 2);
    paymentBoxLineCount += remitLines.length;
    paymentBoxLineCount += 1; // gap + "Bank Transfer:" label
    paymentBoxLineCount += bankNameLines.length;
    paymentBoxLineCount += accountNameLines.length;
    paymentBoxLineCount += 1; // account number (one line)
    paymentBoxLineCount += 1; // routing number (one line)
    if (bankAddressLines.length > 0) paymentBoxLineCount += bankAddressLines.length;
    if (memoLines.length > 0) paymentBoxLineCount += memoLines.length + 1; // +1 for memo label gap

    const paymentBoxContentHeight = paymentBoxLineCount * wireLineH + 4;
    const paymentBoxHeight = paymentBoxContentHeight + wireBoxPaddingV * 2;

    checkOverflow(ctx, paymentBoxHeight + 4);

    // Draw shaded box
    drawRect(
      ctx,
      MARGIN_LEFT,
      ctx.cursor - paymentBoxHeight,
      CONTENT_WIDTH,
      paymentBoxHeight,
      COLOR_PAYMENT_BOX,
    );

    // Thin dark-green left border accent on payment box
    drawRect(
      ctx,
      MARGIN_LEFT,
      ctx.cursor - paymentBoxHeight,
      3,
      paymentBoxHeight,
      COLOR_EB_GREEN,
    );

    ctx.cursor -= wireBoxPaddingV;

    // Payment Instructions heading
    drawText(ctx, 'Payment Instructions', wireCol1X + 3, ctx.cursor, {
      font: fontBold,
      size: 9,
      color: COLOR_EB_GREEN,
    });
    ctx.cursor -= wireLineH + 2;

    // Remit line
    for (const rl of remitLines) {
      checkOverflow(ctx, wireLineH);
      drawText(ctx, rl, wireCol1X + 3, ctx.cursor, {
        font,
        size: wireFontSize,
        color: COLOR_MEDIUM,
      });
      ctx.cursor -= wireLineH;
    }
    ctx.cursor -= 4;

    // Bank Transfer label
    drawText(ctx, 'Bank Transfer:', wireCol1X + 3, ctx.cursor, {
      font: fontBold,
      size: wireFontSize,
      color: COLOR_DARK,
    });
    ctx.cursor -= wireLineH;

    // Bank Name — compact two-column
    {
      const requiredHeight = bankNameLines.length * wireLineH;
      checkOverflow(ctx, requiredHeight);
      drawText(ctx, 'Bank Name', wireCol1X + 3, ctx.cursor, {
        font,
        size: wireFontSize,
        color: COLOR_LIGHT,
      });
      let firstLine = true;
      for (const vl of bankNameLines) {
        if (firstLine) {
          drawText(ctx, vl, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
          firstLine = false;
        } else {
          ctx.cursor -= wireLineH;
          drawText(ctx, vl, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
        }
      }
      ctx.cursor -= wireLineH;
    }

    // Account Name — compact two-column
    {
      const requiredHeight = accountNameLines.length * wireLineH;
      checkOverflow(ctx, requiredHeight);
      drawText(ctx, 'Account Name', wireCol1X + 3, ctx.cursor, {
        font,
        size: wireFontSize,
        color: COLOR_LIGHT,
      });
      let firstLine = true;
      for (const vl of accountNameLines) {
        if (firstLine) {
          drawText(ctx, vl, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
          firstLine = false;
        } else {
          ctx.cursor -= wireLineH;
          drawText(ctx, vl, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
        }
      }
      ctx.cursor -= wireLineH;
    }

    // Account Number — FIXED: label "Account #" → value wire.account_number
    checkOverflow(ctx, wireLineH);
    assertTextFits(wire.account_number, font, wireFontSize, wireCol2Width, 'account_number');
    drawText(ctx, 'Account #', wireCol1X + 3, ctx.cursor, {
      font,
      size: wireFontSize,
      color: COLOR_LIGHT,
    });
    drawText(ctx, wire.account_number, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
    ctx.cursor -= wireLineH;

    // Routing Number — FIXED: label "Routing #" → value wire.routing_number
    checkOverflow(ctx, wireLineH);
    assertTextFits(wire.routing_number, font, wireFontSize, wireCol2Width, 'routing_number');
    drawText(ctx, 'Routing #', wireCol1X + 3, ctx.cursor, {
      font,
      size: wireFontSize,
      color: COLOR_LIGHT,
    });
    drawText(ctx, wire.routing_number, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
    ctx.cursor -= wireLineH;

    // Bank Address (optional)
    if (wire.bank_address && bankAddressLines.length > 0) {
      const requiredHeight = bankAddressLines.length * wireLineH;
      checkOverflow(ctx, requiredHeight);
      drawText(ctx, 'Bank Address', wireCol1X + 3, ctx.cursor, {
        font,
        size: wireFontSize,
        color: COLOR_LIGHT,
      });
      let firstLine = true;
      for (const line of bankAddressLines) {
        if (firstLine) {
          drawText(ctx, line, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
          firstLine = false;
        } else {
          ctx.cursor -= wireLineH;
          drawText(ctx, line, wireCol2X, ctx.cursor, { font, size: wireFontSize, color: COLOR_DARK });
        }
      }
      ctx.cursor -= wireLineH;
    }

    // Memo instructions (optional)
    if (wire.memo_instructions && memoLines.length > 0) {
      const requiredHeight = (memoLines.length + 1) * wireLineH;
      checkOverflow(ctx, requiredHeight);
      ctx.cursor -= 2;
      drawText(ctx, 'Memo:', wireCol1X + 3, ctx.cursor, {
        font: fontBold,
        size: wireFontSize,
        color: COLOR_MEDIUM,
      });
      ctx.cursor -= wireLineH;
      for (const line of memoLines) {
        checkOverflow(ctx, wireLineH);
        drawText(ctx, line, wireCol1X + 3, ctx.cursor, {
          font,
          size: wireFontSize,
          color: COLOR_MEDIUM,
        });
        ctx.cursor -= wireLineH;
      }
    }

    ctx.cursor -= wireBoxPaddingV;

    // -----------------------------------------------------------------------
    // H. CREDIT CARD NOTE (conditional)
    // -----------------------------------------------------------------------

    if (input.credit_card_payment_enabled_snapshot === true) {
      checkOverflow(ctx, 30);

      ctx.cursor -= 6;
      const ccNote =
        'Credit card payment is available for this invoice. Contact EarnestBridge for payment instructions.';
      const ccLines = wrapText(ccNote, font, 7.5, CONTENT_WIDTH);
      for (const line of ccLines) {
        checkOverflow(ctx, 11);
        drawText(ctx, line, MARGIN_LEFT, ctx.cursor, { font, size: 7.5, color: COLOR_MEDIUM });
        ctx.cursor -= 11;
      }
      ctx.cursor -= 4;
    }

    // -----------------------------------------------------------------------
    // I. INVOICE NOTES (conditional) — visually understated
    // internal_notes is NEVER rendered
    // 6A-5C5C: Slightly more spacing from Payment Instructions box
    // -----------------------------------------------------------------------

    if (input.invoice_notes && input.invoice_notes.trim().length > 0) {
      checkOverflow(ctx, 34);

      ctx.cursor -= 10;
      drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.5, COLOR_DIVIDER);
      ctx.cursor -= 13;

      drawText(ctx, 'Notes', MARGIN_LEFT, ctx.cursor, {
        font: fontBold,
        size: 7.5,
        color: COLOR_LIGHT,
      });
      ctx.cursor -= 12;

      const notesLines = wrapText(input.invoice_notes.trim(), font, 8, CONTENT_WIDTH);
      for (const line of notesLines) {
        checkOverflow(ctx, 11);
        drawText(ctx, line, MARGIN_LEFT, ctx.cursor, { font, size: 8, color: COLOR_MEDIUM });
        ctx.cursor -= 11;
      }

      ctx.cursor -= 4;
    }

    // -----------------------------------------------------------------------
    // J. FOOTER — thin divider + centered text
    //
    // 6A-5C5C: Footer uses COLOR_FOOTER (slightly more contrast than COLOR_LIGHT)
    // -----------------------------------------------------------------------

    const invoiceText = input.wire_snapshot.invoice_text;
    const footerContent = invoiceText.footer_text?.trim() || invoiceText.tagline?.trim() || null;

    checkOverflow(ctx, 24);

    ctx.cursor -= 6;
    drawLine(ctx, MARGIN_LEFT, ctx.cursor, PAGE_WIDTH - MARGIN_RIGHT, ctx.cursor, 0.5, COLOR_DIVIDER);
    ctx.cursor -= 12;

    if (footerContent) {
      const footerLines = wrapText(footerContent, font, 7, CONTENT_WIDTH);
      for (const line of footerLines) {
        checkOverflow(ctx, 10);
        const lineWidth = font.widthOfTextAtSize(line, 7);
        const centeredX = MARGIN_LEFT + (CONTENT_WIDTH - lineWidth) / 2;
        // 6A-5C5C: COLOR_FOOTER instead of COLOR_LIGHT for slightly more contrast
        drawText(ctx, line, centeredX, ctx.cursor, { font, size: 7, color: COLOR_FOOTER });
        ctx.cursor -= 10;
      }
    } else {
      // Default footer
      const defaultFooter = 'EarnestBridge — Fast, Seamless Funding with No Debt Obligation.';
      const defaultWidth = font.widthOfTextAtSize(defaultFooter, 7);
      const centeredX = MARGIN_LEFT + (CONTENT_WIDTH - defaultWidth) / 2;
      drawText(ctx, defaultFooter, centeredX, ctx.cursor, { font, size: 7, color: COLOR_FOOTER });
    }

  } catch (err) {
    if (err instanceof InvoicePdfError) throw err;
    throw new InvoicePdfError('INVOICE_PDF_RENDER_ERROR', 'Unexpected error during PDF rendering.');
  }

  // 9. Serialize to bytes
  try {
    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
  } catch {
    throw new InvoicePdfError('INVOICE_PDF_RENDER_ERROR', 'Failed to serialize PDF document.');
  }
}
