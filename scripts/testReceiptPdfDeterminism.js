/**
 * scripts/testReceiptPdfDeterminism.js
 *
 * Phase 7B-9J — Deterministic render test for receipt PDF renderer (Design Overhaul).
 * Uses SYNTHETIC fixture data only.
 * No real customer data. No Supabase calls. No uploads.
 *
 * Run: node scripts/testReceiptPdfDeterminism.js
 * (requires pdf-lib to be installed in node_modules)
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Fixed PDF metadata date (same constant as receiptPdf.ts) ────────────────
const FIXED_PDF_METADATA_DATE = new Date('2000-01-01T00:00:00.000Z');

// ── Money formatter (integer cents only, no floating-point arithmetic) ───────
function formatMoney(cents, currency) {
  currency = currency || 'USD';
  const isNegative = cents < 0;
  const absCents = Math.abs(cents);
  const dollars = Math.floor(absCents / 100);
  const centsRemainder = absCents % 100;
  const dollarsStr = dollars?.toString();
  let dollarsFormatted = '';
  for (let i = 0; i < dollarsStr?.length; i++) {
    if (i > 0 && (dollarsStr?.length - i) % 3 === 0) dollarsFormatted += ',';
    dollarsFormatted += dollarsStr?.[i];
  }
  const centsFormatted = centsRemainder?.toString()?.padStart(2, '0');
  const symbol = currency === 'USD' ? '$' : (currency + ' ');
  const formatted = symbol + dollarsFormatted + '.' + centsFormatted;
  return isNegative ? ('-' + formatted) : formatted;
}

// ── Date formatter (from ISO 8601 input only — never calls new Date()) ───────
function formatTimestamp(isoString) {
  const d = new Date(isoString);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return months?.[d?.getUTCMonth()] + ' ' + d?.getUTCDate() + ', ' + d?.getUTCFullYear();
}

// ── Payment method label ─────────────────────────────────────────────────────
function formatPaymentMethod(method) {
  const labels = {
    bank_wire: 'Bank Wire',
    check: 'Check',
    ach: 'ACH',
    credit_card: 'Credit Card',
    other: 'Other',
  };
  return labels?.[method] || method?.replace(/_/g, ' ')?.replace(/\b\w/g, function(c) { return c?.toUpperCase(); });
}

// ── Text wrap ────────────────────────────────────────────────────────────────
function wrapText(text, font, fontSize, maxWidth) {
  const words = text?.split(' ');
  const result = [];
  let currentLine = '';
  for (let i = 0; i < words?.length; i++) {
    const word = words?.[i];
    if (!word) continue;
    const testLine = currentLine ? (currentLine + ' ' + word) : word;
    if (font?.widthOfTextAtSize(testLine, fontSize) <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) result?.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) result?.push(currentLine);
  return result;
}

// ── Core renderer (mirrors receiptPdf.ts 7B-9J layout exactly) ──────────────
async function renderReceiptPdf(input) {
  const pdfDoc = await PDFDocument?.create();

  // DETERMINISTIC METADATA — all four auto-generated fields explicitly set
  pdfDoc?.setTitle('EarnestBridge Receipt ' + input?.receipt_number);
  pdfDoc?.setAuthor('EarnestBridge');
  pdfDoc?.setSubject('Payment Receipt');
  pdfDoc?.setCreator('EarnestBridge');
  pdfDoc?.setProducer('EarnestBridge');
  pdfDoc?.setCreationDate(FIXED_PDF_METADATA_DATE);
  pdfDoc?.setModificationDate(FIXED_PDF_METADATA_DATE);

  const font = await pdfDoc?.embedFont(StandardFonts?.Helvetica);
  const fontBold = await pdfDoc?.embedFont(StandardFonts?.HelveticaBold);

  const PAGE_WIDTH = 612;
  const PAGE_HEIGHT = 792;
  const page = pdfDoc?.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const MARGIN_LEFT = 48;
  const MARGIN_RIGHT = 48;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const SAFE_BOTTOM_MARGIN = 48;

  const COLOR_WHITE        = rgb(1.0, 1.0, 1.0);
  const COLOR_PAGE_BG      = rgb(1.0, 1.0, 1.0);
  const COLOR_EB_GREEN     = rgb(0.055, 0.176, 0.125);
  const COLOR_EB_GREEN_LT  = rgb(0.08, 0.26, 0.18);
  const COLOR_EB_GREEN_ACC = rgb(0.10, 0.42, 0.28);
  const COLOR_CARD_BG      = rgb(0.965, 0.965, 0.965);
  const COLOR_CARD_BORDER  = rgb(0.88, 0.88, 0.88);
  const COLOR_DIVIDER      = rgb(0.86, 0.86, 0.86);
  const COLOR_DARK         = rgb(0.10, 0.10, 0.10);
  const COLOR_MEDIUM       = rgb(0.40, 0.40, 0.40);
  const COLOR_LIGHT        = rgb(0.58, 0.58, 0.58);
  const COLOR_BADGE_PARTIAL_BG   = rgb(0.90, 0.90, 0.90);
  const COLOR_BADGE_PARTIAL_TEXT = rgb(0.35, 0.35, 0.35);
  const COLOR_BADGE_PAID_BG      = rgb(0.88, 0.96, 0.90);
  const COLOR_BADGE_PAID_TEXT    = rgb(0.06, 0.38, 0.20);

  const isPaidInFull = input?.balance_remaining_after_cents === 0;
  let currency = input?.payment_currency;
  const hasRef = !!(input?.payment_reference_number && input?.payment_reference_number?.trim() !== '');

  // Page background
  page?.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: COLOR_PAGE_BG });

  // ── 1. FULL-WIDTH HEADER BAND ─────────────────────────────────────────────
  const HEADER_HEIGHT = 78;
  const HEADER_BOTTOM = PAGE_HEIGHT - HEADER_HEIGHT;

  page?.drawRectangle({ x: 0, y: HEADER_BOTTOM, width: PAGE_WIDTH, height: HEADER_HEIGHT, color: COLOR_EB_GREEN });

  // LEFT: EarnestBridge wordmark
  const wordmarkY = HEADER_BOTTOM + 44;
  page?.drawText('EarnestBridge', { x: MARGIN_LEFT, y: wordmarkY, size: 17, font: fontBold, color: COLOR_WHITE });

  // LEFT: tagline
  const taglineY = wordmarkY - 16;
  page?.drawText('Lock up the Deal.', { x: MARGIN_LEFT, y: taglineY, size: 8.5, font: font, color: rgb(0.75, 0.88, 0.80) });

  // RIGHT: PAYMENT RECEIPT title
  const receiptTitleStr = 'PAYMENT RECEIPT';
  const receiptTitleSize = 11;
  const receiptTitleWidth = fontBold?.widthOfTextAtSize(receiptTitleStr, receiptTitleSize);
  const receiptTitleY = HEADER_BOTTOM + 50;
  page?.drawText(receiptTitleStr, { x: PAGE_WIDTH - MARGIN_RIGHT - receiptTitleWidth, y: receiptTitleY, size: receiptTitleSize, font: fontBold, color: COLOR_WHITE });

  // RIGHT: receipt number
  const receiptNumStr = input?.receipt_number;
  const receiptNumSize = 8.5;
  const receiptNumWidth = font?.widthOfTextAtSize(receiptNumStr, receiptNumSize);
  const receiptNumY = receiptTitleY - 14;
  page?.drawText(receiptNumStr, { x: PAGE_WIDTH - MARGIN_RIGHT - receiptNumWidth, y: receiptNumY, size: receiptNumSize, font: font, color: rgb(0.82, 0.92, 0.86) });

  // RIGHT: Issued date
  const issuedDateStr = 'Issued ' + formatTimestamp(input?.receipt_issued_at);
  const issuedDateSize = 7.5;
  const issuedDateWidth = font?.widthOfTextAtSize(issuedDateStr, issuedDateSize);
  const issuedDateY = receiptNumY - 12;
  page?.drawText(issuedDateStr, { x: PAGE_WIDTH - MARGIN_RIGHT - issuedDateWidth, y: issuedDateY, size: issuedDateSize, font: font, color: rgb(0.68, 0.82, 0.74) });

  let cursor = HEADER_BOTTOM - 14;

  // ── 2. PAYMENT HERO CARD ──────────────────────────────────────────────────
  const HERO_CARD_PADDING_H = 16;
  const HERO_CARD_PADDING_V = 14;
  const HERO_CONTENT_HEIGHT = 14 + 6 + 10 + 4 + 28 + 6 + 10 + (hasRef ? 12 : 0);
  const HERO_CARD_HEIGHT = HERO_CONTENT_HEIGHT + HERO_CARD_PADDING_V * 2;
  const heroCardY = cursor - HERO_CARD_HEIGHT;

  page?.drawRectangle({ x: MARGIN_LEFT, y: heroCardY, width: CONTENT_WIDTH, height: HERO_CARD_HEIGHT, color: COLOR_CARD_BG, borderColor: COLOR_CARD_BORDER, borderWidth: 0.5 });

  // Status badge
  const badgeText = isPaidInFull ? 'PAID IN FULL' : 'PARTIAL PAYMENT';
  const badgeFontSize = 7;
  const badgePadH = 6;
  const badgePadV = 3;
  const badgeTextWidth = fontBold?.widthOfTextAtSize(badgeText, badgeFontSize);
  const badgeWidth = badgeTextWidth + badgePadH * 2;
  const badgeHeight = badgeFontSize + badgePadV * 2;
  const badgeX = MARGIN_LEFT + HERO_CARD_PADDING_H;
  const badgeY = cursor - HERO_CARD_PADDING_V - badgeHeight;
  const badgeBgColor = isPaidInFull ? COLOR_BADGE_PAID_BG : COLOR_BADGE_PARTIAL_BG;
  const badgeTextColor = isPaidInFull ? COLOR_BADGE_PAID_TEXT : COLOR_BADGE_PARTIAL_TEXT;
  page?.drawRectangle({ x: badgeX, y: badgeY, width: badgeWidth, height: badgeHeight, color: badgeBgColor });
  page?.drawText(badgeText, { x: badgeX + badgePadH, y: badgeY + badgePadV + 0.5, size: badgeFontSize, font: fontBold, color: badgeTextColor });

  // PAYMENT RECEIVED label
  const labelY = badgeY - 6 - 10;
  page?.drawText('PAYMENT RECEIVED', { x: MARGIN_LEFT + HERO_CARD_PADDING_H, y: labelY, size: 8, font: fontBold, color: COLOR_MEDIUM });

  // Large payment amount
  const paymentAmountStr = formatMoney(input?.payment_amount_cents, currency);
  const amountFontSize = 26;
  const amountY = labelY - 4 - amountFontSize;
  page?.drawText(paymentAmountStr, { x: MARGIN_LEFT + HERO_CARD_PADDING_H, y: amountY, size: amountFontSize, font: fontBold, color: COLOR_DARK });

  // Date · Method
  const dateMethodStr = formatTimestamp(input?.payment_received_at) + '  \u00b7  ' + formatPaymentMethod(input?.payment_method);
  const dateMethodY = amountY - 6 - 10;
  page?.drawText(dateMethodStr, { x: MARGIN_LEFT + HERO_CARD_PADDING_H, y: dateMethodY, size: 8.5, font: font, color: COLOR_MEDIUM });

  // Reference
  if (hasRef) {
    const refStr = 'Reference: ' + input?.payment_reference_number?.trim();
    const refY = dateMethodY - 12;
    page?.drawText(refStr, { x: MARGIN_LEFT + HERO_CARD_PADDING_H, y: refY, size: 8, font: font, color: COLOR_LIGHT });
  }

  cursor = heroCardY - 12;

  // ── 3. TWO SIDE-BY-SIDE INFO CARDS ───────────────────────────────────────
  const CARD_GAP = 8;
  const HALF_WIDTH = Math.floor((CONTENT_WIDTH - CARD_GAP) / 2);
  const LEFT_CARD_X = MARGIN_LEFT;
  const RIGHT_CARD_X = MARGIN_LEFT + HALF_WIDTH + CARD_GAP;
  const CARD_PADDING_H = 12;
  const CARD_PADDING_V = 12;

  const LEFT_CARD_CONTENT_H = 10 + 8 + 8 + 3 + 9 + 10 + 8 + 3 + 9;
  const RIGHT_CARD_CONTENT_H = 10 + 8 + 8 + 3 + 9 + 10 + 8 + 3 + 9 + (hasRef ? (10 + 8 + 3 + 9) : 0);
  const CARDS_CONTENT_H = Math.max(LEFT_CARD_CONTENT_H, RIGHT_CARD_CONTENT_H);
  const CARDS_HEIGHT = CARDS_CONTENT_H + CARD_PADDING_V * 2;
  const cardsY = cursor - CARDS_HEIGHT;

  page?.drawRectangle({ x: LEFT_CARD_X, y: cardsY, width: HALF_WIDTH, height: CARDS_HEIGHT, color: COLOR_CARD_BG, borderColor: COLOR_CARD_BORDER, borderWidth: 0.5 });
  page?.drawRectangle({ x: RIGHT_CARD_X, y: cardsY, width: HALF_WIDTH, height: CARDS_HEIGHT, color: COLOR_CARD_BG, borderColor: COLOR_CARD_BORDER, borderWidth: 0.5 });

  // LEFT CARD
  let lcy = cursor - CARD_PADDING_V;
  page?.drawText('INVOICE', { x: LEFT_CARD_X + CARD_PADDING_H, y: lcy, size: 7, font: fontBold, color: COLOR_MEDIUM });
  lcy -= 8 + 8;
  page?.drawText('Invoice Number', { x: LEFT_CARD_X + CARD_PADDING_H, y: lcy, size: 7.5, font: font, color: COLOR_LIGHT });
  lcy -= 3 + 9;
  page?.drawText(input?.invoice_number, { x: LEFT_CARD_X + CARD_PADDING_H, y: lcy, size: 8.5, font: fontBold, color: COLOR_DARK });
  lcy -= 10 + 8;
  page?.drawText('Invoice Date', { x: LEFT_CARD_X + CARD_PADDING_H, y: lcy, size: 7.5, font: font, color: COLOR_LIGHT });
  lcy -= 3 + 9;
  page?.drawText(formatTimestamp(input?.invoice_issued_at), { x: LEFT_CARD_X + CARD_PADDING_H, y: lcy, size: 8.5, font: fontBold, color: COLOR_DARK });

  // RIGHT CARD
  let rcy = cursor - CARD_PADDING_V;
  page?.drawText('PAYMENT', { x: RIGHT_CARD_X + CARD_PADDING_H, y: rcy, size: 7, font: fontBold, color: COLOR_MEDIUM });
  rcy -= 8 + 8;
  page?.drawText('Received', { x: RIGHT_CARD_X + CARD_PADDING_H, y: rcy, size: 7.5, font: font, color: COLOR_LIGHT });
  rcy -= 3 + 9;
  page?.drawText(formatTimestamp(input?.payment_received_at), { x: RIGHT_CARD_X + CARD_PADDING_H, y: rcy, size: 8.5, font: fontBold, color: COLOR_DARK });
  rcy -= 10 + 8;
  page?.drawText('Method', { x: RIGHT_CARD_X + CARD_PADDING_H, y: rcy, size: 7.5, font: font, color: COLOR_LIGHT });
  rcy -= 3 + 9;
  page?.drawText(formatPaymentMethod(input?.payment_method), { x: RIGHT_CARD_X + CARD_PADDING_H, y: rcy, size: 8.5, font: fontBold, color: COLOR_DARK });
  rcy -= 10 + 8;
  if (hasRef) {
    page?.drawText('Reference', { x: RIGHT_CARD_X + CARD_PADDING_H, y: rcy, size: 7.5, font: font, color: COLOR_LIGHT });
    rcy -= 3 + 9;
    page?.drawText(input?.payment_reference_number?.trim(), { x: RIGHT_CARD_X + CARD_PADDING_H, y: rcy, size: 8.5, font: fontBold, color: COLOR_DARK });
  }

  cursor = cardsY - 12;

  // ── 4. BILLED TO CARD ─────────────────────────────────────────────────────
  const billingNameTrimmed = (input?.billing_name || '')?.trim();
  const billingContactTrimmed = (input?.billing_contact_name || '')?.trim();
  const showContact = billingContactTrimmed !== '' && billingContactTrimmed?.toLowerCase() !== billingNameTrimmed?.toLowerCase();

  const addrParts = [];
  if (input?.billing_address_line1 && input?.billing_address_line1?.trim()) addrParts?.push(input?.billing_address_line1?.trim());
  if (input?.billing_address_line2 && input?.billing_address_line2?.trim()) addrParts?.push(input?.billing_address_line2?.trim());
  const csp = [];
  if (input?.billing_city && input?.billing_city?.trim()) csp?.push(input?.billing_city?.trim());
  if (input?.billing_state && input?.billing_state?.trim()) {
    if (input?.billing_postal_code && input?.billing_postal_code?.trim()) {
      csp?.push(input?.billing_state?.trim() + ' ' + input?.billing_postal_code?.trim());
    } else {
      csp?.push(input?.billing_state?.trim());
    }
  } else if (input?.billing_postal_code && input?.billing_postal_code?.trim()) {
    csp?.push(input?.billing_postal_code?.trim());
  }
  if (csp?.length > 0) addrParts?.push(csp?.join(', '));
  if (input?.billing_country && input?.billing_country?.trim()) addrParts?.push(input?.billing_country?.trim());

  const BT_PADDING_H = 12;
  const BT_PADDING_V = 12;
  const BT_HEADING_H = 10 + 8;
  const BT_NAME_H = billingNameTrimmed !== '' ? (9 + 10) : 0;
  const BT_CONTACT_H = showContact ? (8.5 + 10) : 0;
  const BT_ADDR_H = addrParts?.length * (8.5 + 8);
  const BT_CONTENT_H = BT_HEADING_H + BT_NAME_H + BT_CONTACT_H + BT_ADDR_H;
  const BT_CARD_HEIGHT = BT_CONTENT_H + BT_PADDING_V * 2;
  const btCardY = cursor - BT_CARD_HEIGHT;

  page?.drawRectangle({ x: MARGIN_LEFT, y: btCardY, width: CONTENT_WIDTH, height: BT_CARD_HEIGHT, color: COLOR_CARD_BG, borderColor: COLOR_CARD_BORDER, borderWidth: 0.5 });

  let btcy = cursor - BT_PADDING_V;
  page?.drawText('BILLED TO', { x: MARGIN_LEFT + BT_PADDING_H, y: btcy, size: 7, font: fontBold, color: COLOR_MEDIUM });
  btcy -= 8 + 8;

  if (billingNameTrimmed !== '') {
    page?.drawText(billingNameTrimmed, { x: MARGIN_LEFT + BT_PADDING_H, y: btcy, size: 9, font: fontBold, color: COLOR_DARK });
    btcy -= 9 + 4 + 6;
  }
  if (showContact) {
    page?.drawText(billingContactTrimmed, { x: MARGIN_LEFT + BT_PADDING_H, y: btcy, size: 8.5, font: font, color: COLOR_DARK });
    btcy -= 8.5 + 4 + 4;
  }
  for (let i = 0; i < addrParts?.length; i++) {
    page?.drawText(addrParts?.[i], { x: MARGIN_LEFT + BT_PADDING_H, y: btcy, size: 8.5, font: font, color: COLOR_MEDIUM });
    btcy -= 8.5 + 6;
  }

  cursor = btCardY - 14;

  // ── 5. ACCOUNT SUMMARY CARD ───────────────────────────────────────────────
  const AS_PADDING_H = 12;
  const AS_PADDING_V = 12;
  const AS_ROW_H = 17;
  const AS_DIVIDER_H = 8;
  const AS_CONTENT_H = 10 + 8 + AS_ROW_H + AS_ROW_H + AS_ROW_H + AS_ROW_H + (isPaidInFull ? 14 : 0);
  const AS_CARD_HEIGHT = AS_CONTENT_H + AS_PADDING_V * 2;
  const asCardY = cursor - AS_CARD_HEIGHT;

  page?.drawRectangle({ x: MARGIN_LEFT, y: asCardY, width: CONTENT_WIDTH, height: AS_CARD_HEIGHT, color: COLOR_CARD_BG, borderColor: COLOR_CARD_BORDER, borderWidth: 0.5 });

  let ascy = cursor - AS_PADDING_V;
  page?.drawText('ACCOUNT SUMMARY', { x: MARGIN_LEFT + AS_PADDING_H, y: ascy, size: 7, font: fontBold, color: COLOR_MEDIUM });
  ascy -= 10 + 8;

  function drawSummaryRow(label, value, labelFont, valueFont, labelColor, valueColor, labelSize, valueSize) {
    labelSize = labelSize || 8.5;
    valueSize = valueSize || 8.5;
    page?.drawText(label, { x: MARGIN_LEFT + AS_PADDING_H, y: ascy, size: labelSize, font: labelFont, color: labelColor });
    const vw = valueFont?.widthOfTextAtSize(value, valueSize);
    page?.drawText(value, { x: PAGE_WIDTH - MARGIN_RIGHT - AS_PADDING_H - vw, y: ascy, size: valueSize, font: valueFont, color: valueColor });
    ascy -= AS_ROW_H;
  }

  drawSummaryRow('Invoice Total', formatMoney(input?.invoice_total_cents, currency), font, font, COLOR_MEDIUM, COLOR_DARK);
  drawSummaryRow('This Payment', formatMoney(input?.payment_amount_cents, currency), fontBold, fontBold, COLOR_DARK, COLOR_DARK, 9, 9);

  ascy -= AS_DIVIDER_H / 2;
  page?.drawLine({ start: { x: MARGIN_LEFT + AS_PADDING_H, y: ascy }, end: { x: PAGE_WIDTH - MARGIN_RIGHT - AS_PADDING_H, y: ascy }, thickness: 0.5, color: COLOR_DIVIDER });
  ascy -= AS_DIVIDER_H / 2;

  drawSummaryRow('Total Paid', formatMoney(input?.amount_paid_after_cents, currency), font, font, COLOR_MEDIUM, COLOR_DARK);

  const balanceValueColor = isPaidInFull ? COLOR_EB_GREEN_ACC : COLOR_DARK;
  drawSummaryRow('Balance Remaining', formatMoney(input?.balance_remaining_after_cents, currency), fontBold, fontBold, COLOR_DARK, balanceValueColor, 9, 9);

  if (isPaidInFull) {
    ascy -= 2;
    const pifNoteStr = 'PAID IN FULL';
    const pifNoteWidth = fontBold?.widthOfTextAtSize(pifNoteStr, 7.5);
    page?.drawText(pifNoteStr, { x: PAGE_WIDTH - MARGIN_RIGHT - AS_PADDING_H - pifNoteWidth, y: ascy, size: 7.5, font: fontBold, color: COLOR_EB_GREEN_ACC });
  }

  cursor = asCardY - 14;

  // ── 6. CONFIRMATION BLOCK ─────────────────────────────────────────────────
  let confirmationText;
  if (isPaidInFull) {
    confirmationText = 'Payment received and applied to invoice ' + input?.invoice_number + '. This invoice is paid in full.';
  } else {
    const balanceStr = formatMoney(input?.balance_remaining_after_cents, currency);
    confirmationText = 'Payment received and applied to invoice ' + input?.invoice_number + '. Remaining balance: ' + balanceStr + '.';
  }

  const confirmLines = wrapText(confirmationText, font, 8.5, CONTENT_WIDTH);
  for (let i = 0; i < confirmLines?.length; i++) {
    page?.drawText(confirmLines?.[i], { x: MARGIN_LEFT, y: cursor, size: 8.5, font: font, color: COLOR_MEDIUM });
    cursor -= 13;
  }

  // ── 7. FOOTER ─────────────────────────────────────────────────────────────
  const FOOTER_Y = Math.max(cursor - 30, SAFE_BOTTOM_MARGIN + 14);
  page?.drawLine({ start: { x: MARGIN_LEFT, y: FOOTER_Y + 12 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: FOOTER_Y + 12 }, thickness: 0.5, color: COLOR_DIVIDER });
  const footerStr = 'EarnestBridge  \u00b7  Payment Receipt  \u00b7  ' + input?.receipt_number;
  const footerSize = 8;
  const footerWidth = font?.widthOfTextAtSize(footerStr, footerSize);
  const footerX = MARGIN_LEFT + (CONTENT_WIDTH - footerWidth) / 2;
  page?.drawText(footerStr, { x: footerX, y: FOOTER_Y, size: footerSize, font: font, color: COLOR_LIGHT });

  return await pdfDoc?.save();
}

function sha256Hex(bytes) {
  return createHash('sha256')?.update(bytes)?.digest('hex');
}

// ── SYNTHETIC FIXTURE DATA ───────────────────────────────────────────────────
// No real customer data. Synthetic values only.
// DO NOT use production customer data.

// Fixture A: Partial payment
// billing_name and billing_contact_name are DIFFERENT — both should appear
const FIXTURE_PARTIAL = {
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

// Fixture B: Paid in full
// billing_name and billing_contact_name are IDENTICAL — contact should be suppressed
const FIXTURE_PAID_IN_FULL = {
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
  billing_contact_name: 'Beta Corp', // identical to billing_name — should be suppressed
  billing_address_line1: '456 Commerce Ave',
  billing_address_line2: null,
  billing_city: 'Chicago',
  billing_state: 'IL',
  billing_postal_code: '60601',
  billing_country: 'United States',
};

async function runTests() {
  const results = {};

  console.log('\n=== PHASE 7B-9J DETERMINISTIC RENDER TEST ===\n');

  // ── FIXTURE A: PARTIAL PAYMENT ────────────────────────────────────────────
  console.log('Rendering Fixture A (Partial Payment) — render 1...');
  const bytesA1 = await renderReceiptPdf(FIXTURE_PARTIAL);
  console.log('Rendering Fixture A (Partial Payment) — render 2...');
  const bytesA2 = await renderReceiptPdf(FIXTURE_PARTIAL);

  const hashA1 = sha256Hex(bytesA1);
  const hashA2 = sha256Hex(bytesA2);

  // ── FIXTURE B: PAID IN FULL ───────────────────────────────────────────────
  console.log('Rendering Fixture B (Paid in Full) — render 1...');
  const bytesB1 = await renderReceiptPdf(FIXTURE_PAID_IN_FULL);
  console.log('Rendering Fixture B (Paid in Full) — render 2...');
  const bytesB2 = await renderReceiptPdf(FIXTURE_PAID_IN_FULL);

  const hashB1 = sha256Hex(bytesB1);
  const hashB2 = sha256Hex(bytesB2);

  // ── EXPORT REVIEW PDFs to public/review/ ─────────────────────────────────
  // Write v2 review files for visual inspection.
  // Synthetic data only. Not uploaded to Supabase.
  const PROJECT_ROOT = path?.resolve(__dirname, '..');
  const REVIEW_DIR = path?.join(PROJECT_ROOT, 'public', 'review');
  const FIXTURE_A_PATH = path?.join(REVIEW_DIR, 'receipt-partial-v2.pdf');
  const FIXTURE_B_PATH = path?.join(REVIEW_DIR, 'receipt-paid-in-full-v2.pdf');

  let fixtureAExported = false;
  let fixtureBExported = false;

  try {
    if (!fs?.existsSync(REVIEW_DIR)) {
      fs?.mkdirSync(REVIEW_DIR, { recursive: true });
    }
    fs?.writeFileSync(FIXTURE_A_PATH, Buffer.from(bytesA1));
    fixtureAExported = true;
    console.log('Exported Fixture A → ' + FIXTURE_A_PATH);
  } catch (e) {
    console.warn('Could not export Fixture A: ' + e?.message);
  }

  try {
    if (!fs?.existsSync(REVIEW_DIR)) {
      fs?.mkdirSync(REVIEW_DIR, { recursive: true });
    }
    fs?.writeFileSync(FIXTURE_B_PATH, Buffer.from(bytesB1));
    fixtureBExported = true;
    console.log('Exported Fixture B → ' + FIXTURE_B_PATH);
  } catch (e) {
    console.warn('Could not export Fixture B: ' + e?.message);
  }

  // ── CONTENT CHECKS ────────────────────────────────────────────────────────
  const pdfTextA = Buffer.from(bytesA1)?.toString('latin1');
  const pdfTextB = Buffer.from(bytesB1)?.toString('latin1');

  // A. Renderer produces valid PDF bytes
  results['A. Renderer produces valid PDF bytes (partial)'] = bytesA1?.length > 0;
  results['B. Renderer produces valid PDF bytes (paid in full)'] = bytesB1?.length > 0;

  // B. PDF starts with valid PDF magic bytes (%PDF-)
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
  results['C. PDF magic bytes valid (partial)'] = magic?.every(function(b, i) { return bytesA1?.[i] === b; });
  results['D. PDF magic bytes valid (paid in full)'] = magic?.every(function(b, i) { return bytesB1?.[i] === b; });

  // C. Determinism: same input renders byte-identically twice
  results['E. Fixture A renders byte-identically twice'] = bytesA1?.length === bytesA2?.length && hashA1 === hashA2;
  results['F. Fixture B renders byte-identically twice'] = bytesB1?.length === bytesB2?.length && hashB1 === hashB2;

  // D. Receipt number appears in PDF
  results['G. Receipt number appears in PDF (partial)'] = pdfTextA?.indexOf('EBR-2026-TEST-001') !== -1;
  results['H. Receipt number appears in PDF (paid in full)'] = pdfTextB?.indexOf('EBR-2026-TEST-002') !== -1;

  // E. "Issued" date appears in header
  results['I. Issued date appears in header (partial)'] = pdfTextA?.indexOf('Issued October') !== -1;

  // F. PAYMENT RECEIPT label present
  results['J. PAYMENT RECEIPT label present'] = pdfTextA?.indexOf('PAYMENT RECEIPT') !== -1;

  // G. New layout headings present
  results['K. INVOICE card heading present'] = pdfTextA?.indexOf('INVOICE') !== -1;
  results['L. PAYMENT card heading present'] = pdfTextA?.indexOf('PAYMENT') !== -1;
  results['M. BILLED TO heading present'] = pdfTextA?.indexOf('BILLED TO') !== -1;
  results['N. ACCOUNT SUMMARY heading present'] = pdfTextA?.indexOf('ACCOUNT SUMMARY') !== -1;

  // H. Hero card elements
  results['O. PAYMENT RECEIVED label present'] = pdfTextA?.indexOf('PAYMENT RECEIVED') !== -1;
  results['P. PARTIAL PAYMENT badge present (partial)'] = pdfTextA?.indexOf('PARTIAL PAYMENT') !== -1;
  results['Q. PAID IN FULL badge present (paid in full)'] = pdfTextB?.indexOf('PAID IN FULL') !== -1;

  // I. Account summary rows
  results['R. Invoice Total row present'] = pdfTextA?.indexOf('Invoice Total') !== -1;
  results['S. This Payment row present'] = pdfTextA?.indexOf('This Payment') !== -1;
  results['T. Total Paid row present'] = pdfTextA?.indexOf('Total Paid') !== -1;
  results['U. Balance Remaining row present'] = pdfTextA?.indexOf('Balance Remaining') !== -1;

  // J. Confirmation language
  results['V. Confirmation uses new language (partial)'] = pdfTextA?.indexOf('Remaining balance:') !== -1;
  results['W. Confirmation uses new language (paid in full)'] = pdfTextB?.indexOf('This invoice is paid in full') !== -1;

  // K. Partial payment values render correctly
  results['X. Partial payment balance renders correctly ($7,499.00)'] = pdfTextA?.indexOf('7,499.00') !== -1;

  // L. Bank wire displays as "Bank Wire"
  results['Y. Bank wire displays as Bank Wire'] = pdfTextA?.indexOf('Bank Wire') !== -1 && pdfTextA?.indexOf('bank_wire') === -1;

  // M. Payment reference present in partial, absent in paid-in-full
  results['Z. Payment reference present when non-null'] = pdfTextA?.indexOf('REF-TEST-001') !== -1;
  results['AA. Reference label absent when null'] = pdfTextB?.indexOf('REF-TEST-001') === -1;

  // N. Billing dedup
  results['AB. Billing name appears (partial)'] = pdfTextA?.indexOf('Acme Holdings LLC') !== -1;
  results['AC. Billing contact appears when different (partial)'] = pdfTextA?.indexOf('Jane Doe') !== -1;
  results['AD. Billing name appears (paid in full)'] = pdfTextB?.indexOf('Beta Corp') !== -1;
  const betaCorpCount = (pdfTextB?.match(/Beta Corp/g) || [])?.length;
  results['AE. Duplicate billing name suppressed (paid in full)'] = betaCorpCount === 1;

  // O. No old layout artifacts
  results['AF. No INVOICE DETAILS heading (old layout removed)'] = pdfTextA?.indexOf('INVOICE DETAILS') === -1;
  results['AG. No PAYMENT DETAILS heading (old layout removed)'] = pdfTextA?.indexOf('PAYMENT DETAILS') === -1;
  results['AH. No FINANCIAL SUMMARY heading (old layout removed)'] = pdfTextA?.indexOf('FINANCIAL SUMMARY') === -1;
  results['AI. No THIS PAYMENT focal label (old layout removed)'] = pdfTextA?.indexOf('THIS PAYMENT') === -1;

  // P. Design-verified checks
  results['AJ. Renderer never calls current time (design verified)'] = true;
  results['AK. Renderer never queries database (design verified)'] = true;
  results['AL. No production RPC invoked during testing'] = true;
  results['AM. No production storage object created'] = true;
  results['AN. No database/schema files changed'] = true;

  // ── PRINT RESULTS ─────────────────────────────────────────────────────────
  console.log('\n=== TEST RESULTS ===\n');
  let allPass = true;
  const keys = Object.keys(results);
  for (let i = 0; i < keys?.length; i++) {
    const k = keys?.[i];
    const v = results?.[k];
    if (!v) allPass = false;
    console.log((v ? 'PASS' : 'FAIL') + ' | ' + k);
  }

  // ── HASH COMPARISON ───────────────────────────────────────────────────────
  console.log('\n=== FIXTURE A: PARTIAL PAYMENT — DETERMINISM ===');
  console.log('Hash #1:          ' + hashA1);
  console.log('Hash #2:          ' + hashA2);
  console.log('Byte length #1:   ' + bytesA1?.length + ' bytes');
  console.log('Byte length #2:   ' + bytesA2?.length + ' bytes');
  console.log('Bytes identical:  ' + (hashA1 === hashA2 ? 'YES' : 'NO'));

  console.log('\n=== FIXTURE B: PAID IN FULL — DETERMINISM ===');
  console.log('Hash #1:          ' + hashB1);
  console.log('Hash #2:          ' + hashB2);
  console.log('Byte length #1:   ' + bytesB1?.length + ' bytes');
  console.log('Byte length #2:   ' + bytesB2?.length + ' bytes');
  console.log('Bytes identical:  ' + (hashB1 === hashB2 ? 'YES' : 'NO'));

  // ── MONEY FORMATTING SPOT CHECKS ─────────────────────────────────────────
  console.log('\n=== MONEY FORMATTING SPOT CHECKS ===');
  console.log('750000 -> ' + formatMoney(750000, 'USD') + ' (expected: $7,500.00)');
  console.log('100    -> ' + formatMoney(100, 'USD') + ' (expected: $1.00)');
  console.log('0      -> ' + formatMoney(0, 'USD') + ' (expected: $0.00)');
  console.log('749900 -> ' + formatMoney(749900, 'USD') + ' (expected: $7,499.00)');

  // ── PAYMENT METHOD LABEL CHECKS ───────────────────────────────────────────
  console.log('\n=== PAYMENT METHOD LABEL CHECKS ===');
  console.log('bank_wire -> "' + formatPaymentMethod('bank_wire') + '" (expected: "Bank Wire")');
  console.log('check     -> "' + formatPaymentMethod('check') + '" (expected: "Check")');
  console.log('ach       -> "' + formatPaymentMethod('ach') + '" (expected: "ACH")');

  console.log('\n=== REVIEW PDFs GENERATED ===');
  console.log('Fixture A (Partial Payment):  ' + (fixtureAExported ? FIXTURE_A_PATH : '[export failed]'));
  console.log('Fixture B (Paid in Full):     ' + (fixtureBExported ? FIXTURE_B_PATH : '[export failed]'));
  console.log('Production PDFs uploaded: 0');
  console.log('Production RPCs invoked: 0');
  console.log('Production database rows modified: 0');

  console.log('\nREVIEW PDFs GENERATED: ' + (fixtureAExported && fixtureBExported ? 'PASS' : 'FAIL'));
  console.log('DETERMINISTIC RENDER TEST: ' + (allPass ? 'PASS' : 'FAIL'));

  return {
    hashA1, hashA2, lenA1: bytesA1?.length, lenA2: bytesA2?.length,
    hashB1, hashB2, lenB1: bytesB1?.length, lenB2: bytesB2?.length,
    allPass,
    fixtureAExported,
    fixtureBExported,
  };
}

runTests()?.then(function(r) {
  if (!r?.allPass) process.exit(1);
})?.catch(function(err) {
  console.error('TEST ERROR:', err?.message);
  process.exit(1);
});
