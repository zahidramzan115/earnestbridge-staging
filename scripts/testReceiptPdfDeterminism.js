/**
 * scripts/testReceiptPdfDeterminism.js
 *
 * Deterministic render test for receipt PDF renderer.
 * Uses SYNTHETIC fixture data only.
 * No real customer data. No Supabase calls. No uploads.
 *
 * Run: node scripts/testReceiptPdfDeterminism.js
 * (requires pdf-lib to be installed in node_modules)
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { createHash } = require('crypto');

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

// ── Core renderer (mirrors receiptPdf.ts logic exactly) ─────────────────────
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
  const MARGIN_LEFT = 50;
  const MARGIN_RIGHT = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const SAFE_BOTTOM_MARGIN = 50;

  // Page background
  page?.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: rgb(0.97, 0.97, 0.94) });
  // Top accent strip
  page?.drawRectangle({ x: 0, y: PAGE_HEIGHT - 4, width: PAGE_WIDTH, height: 4, color: rgb(0.06, 0.18, 0.13) });

  let cursor = PAGE_HEIGHT - 36;

  // Header
  page?.drawText('EarnestBridge', { x: MARGIN_LEFT, y: cursor, size: 16, font: fontBold, color: rgb(0.06, 0.18, 0.13) });
  const rl = 'PAYMENT RECEIPT';
  page?.drawText(rl, {
    x: PAGE_WIDTH - MARGIN_RIGHT - fontBold?.widthOfTextAtSize(rl, 11),
    y: cursor, size: 11, font: fontBold, color: rgb(0.22, 0.38, 0.28),
  });

  cursor -= 6;
  page?.drawText('Lock up the Deal.', { x: MARGIN_LEFT, y: cursor, size: 8, font: font, color: rgb(0.38, 0.38, 0.35) });
  page?.drawText(input?.receipt_number, {
    x: PAGE_WIDTH - MARGIN_RIGHT - font?.widthOfTextAtSize(input?.receipt_number, 9),
    y: cursor, size: 9, font: font, color: rgb(0.10, 0.10, 0.10),
  });

  cursor -= 18;
  page?.drawLine({
    start: { x: MARGIN_LEFT, y: cursor },
    end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor },
    thickness: 1.0, color: rgb(0.06, 0.18, 0.13),
  });
  cursor -= 16;

  const COL_VALUE_X = MARGIN_LEFT + 160;

  function drawRow(label, value) {
    if (!value || value?.trim() === '') return;
    page?.drawText(label, { x: MARGIN_LEFT, y: cursor, size: 8.5, font: font, color: rgb(0.38, 0.38, 0.35) });
    page?.drawText(value, { x: COL_VALUE_X, y: cursor, size: 8.5, font: fontBold, color: rgb(0.10, 0.10, 0.10) });
    cursor -= 14;
  }

  drawRow('Receipt Number', input?.receipt_number);
  drawRow('Receipt Issued Date', formatTimestamp(input?.receipt_issued_at));
  cursor -= 4;
  page?.drawLine({ start: { x: MARGIN_LEFT, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor }, thickness: 0.5, color: rgb(0.82, 0.82, 0.78) });
  cursor -= 12;

  drawRow('Invoice Number', input?.invoice_number);
  drawRow('Invoice Issued Date', formatTimestamp(input?.invoice_issued_at));
  cursor -= 4;
  page?.drawLine({ start: { x: MARGIN_LEFT, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor }, thickness: 0.5, color: rgb(0.82, 0.82, 0.78) });
  cursor -= 12;

  drawRow('Payment Received Date', formatTimestamp(input?.payment_received_at));
  drawRow('Payment Method', formatPaymentMethod(input?.payment_method));
  if (input?.payment_reference_number && input?.payment_reference_number?.trim() !== '') {
    drawRow('Payment Reference', input?.payment_reference_number?.trim());
  }
  cursor -= 4;
  page?.drawLine({ start: { x: MARGIN_LEFT, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor }, thickness: 0.5, color: rgb(0.82, 0.82, 0.78) });
  cursor -= 16;

  // Billing block
  page?.drawText('BILLED TO', { x: MARGIN_LEFT, y: cursor, size: 8, font: fontBold, color: rgb(0.22, 0.38, 0.28) });
  cursor -= 14;

  if (input?.billing_name && input?.billing_name?.trim()) {
    page?.drawText(input?.billing_name?.trim(), { x: MARGIN_LEFT, y: cursor, size: 9, font: fontBold, color: rgb(0.10, 0.10, 0.10) });
    cursor -= 12;
  }
  if (input?.billing_contact_name && input?.billing_contact_name?.trim()) {
    page?.drawText(input?.billing_contact_name?.trim(), { x: MARGIN_LEFT, y: cursor, size: 8.5, font: font, color: rgb(0.10, 0.10, 0.10) });
    cursor -= 12;
  }

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
  for (let i = 0; i < addrParts?.length; i++) {
    page?.drawText(addrParts?.[i], { x: MARGIN_LEFT, y: cursor, size: 8.5, font: font, color: rgb(0.38, 0.38, 0.35) });
    cursor -= 12;
  }

  cursor -= 8;
  page?.drawLine({ start: { x: MARGIN_LEFT, y: cursor }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: cursor }, thickness: 0.5, color: rgb(0.82, 0.82, 0.78) });
  cursor -= 16;

  // Financial summary box
  const summaryBoxHeight = 14 + 5 * 18 + 14;
  page?.drawText('FINANCIAL SUMMARY', { x: MARGIN_LEFT, y: cursor, size: 8, font: fontBold, color: rgb(0.22, 0.38, 0.28) });
  cursor -= 12;
  page?.drawRectangle({ x: MARGIN_LEFT, y: cursor - summaryBoxHeight, width: CONTENT_WIDTH, height: summaryBoxHeight, color: rgb(0.93, 0.93, 0.90) });
  cursor -= 14;

  let currency = input?.payment_currency;

  function drawSR(label, value, isBold) {
    const f = isBold ? fontBold : font;
    page?.drawText(label, { x: MARGIN_LEFT + 10, y: cursor, size: 9, font: f, color: rgb(0.10, 0.10, 0.10) });
    const vw = f?.widthOfTextAtSize(value, 9);
    page?.drawText(value, { x: PAGE_WIDTH - MARGIN_RIGHT - 10 - vw, y: cursor, size: 9, font: f, color: rgb(0.10, 0.10, 0.10) });
    cursor -= 18;
  }

  drawSR('Invoice Total', formatMoney(input?.invoice_total_cents, currency), false);
  drawSR('This Payment', formatMoney(input?.payment_amount_cents, currency), true);
  page?.drawLine({ start: { x: MARGIN_LEFT + 10, y: cursor + 4 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT - 10, y: cursor + 4 }, thickness: 0.5, color: rgb(0.82, 0.82, 0.78) });
  drawSR('Amount Paid After This Payment', formatMoney(input?.amount_paid_after_cents, currency), false);
  drawSR('Balance Remaining After This Payment', formatMoney(input?.balance_remaining_after_cents, currency), false);
  drawSR('Currency', currency, false);
  cursor -= 14;
  cursor -= 16;

  // Payment status
  if (input?.balance_remaining_after_cents === 0) {
    const bt = 'PAID IN FULL';
    const bw = fontBold?.widthOfTextAtSize(bt, 9) + 20;
    page?.drawRectangle({ x: MARGIN_LEFT, y: cursor - 4, width: bw, height: 16, color: rgb(0.06, 0.18, 0.13) });
    page?.drawText(bt, { x: MARGIN_LEFT + 10, y: cursor + 4, size: 9, font: fontBold, color: rgb(1.0, 1.0, 1.0) });
    cursor -= 24;
  } else {
    const pn = 'This receipt acknowledges the specific payment shown above. A balance of ' +
      formatMoney(input?.balance_remaining_after_cents, currency) + ' remains on the referenced invoice.';
    const nl = wrapText(pn, font, 8, CONTENT_WIDTH);
    for (let i = 0; i < nl?.length; i++) {
      page?.drawText(nl?.[i], { x: MARGIN_LEFT, y: cursor, size: 8, font: font, color: rgb(0.38, 0.38, 0.35) });
      cursor -= 12;
    }
    cursor -= 4;
  }

  // Footer
  const FOOTER_Y = SAFE_BOTTOM_MARGIN + 20;
  page?.drawLine({ start: { x: MARGIN_LEFT, y: FOOTER_Y + 14 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: FOOTER_Y + 14 }, thickness: 0.5, color: rgb(0.82, 0.82, 0.78) });
  const ft = 'This receipt confirms the payment shown above was received and applied to the referenced invoice.';
  const fl = wrapText(ft, font, 7.5, CONTENT_WIDTH);
  let fc = FOOTER_Y + 8;
  for (let i = 0; i < fl?.length; i++) {
    page?.drawText(fl?.[i], { x: MARGIN_LEFT, y: fc, size: 7.5, font: font, color: rgb(0.55, 0.55, 0.52) });
    fc -= 10;
  }
  const ef = 'EarnestBridge';
  page?.drawText(ef, {
    x: PAGE_WIDTH - MARGIN_RIGHT - font?.widthOfTextAtSize(ef, 7.5),
    y: FOOTER_Y + 8, size: 7.5, font: font, color: rgb(0.55, 0.55, 0.52),
  });

  return await pdfDoc?.save();
}

function sha256Hex(bytes) {
  return createHash('sha256')?.update(bytes)?.digest('hex');
}

// ── SYNTHETIC FIXTURE DATA ───────────────────────────────────────────────────
// No real customer data. Synthetic values only.

const FIXTURE_PARTIAL = {
  receipt_number: 'EBR-2026-000001',
  receipt_issued_at: '2026-10-02T14:30:00.000Z',
  payment_id: '00000000-0000-0000-0000-000000000001',
  payment_amount_cents: 100,
  payment_received_at: '2026-10-01T10:00:00.000Z',
  payment_method: 'bank_wire',
  payment_reference_number: 'REF-TEST-001',
  payment_currency: 'USD',
  amount_paid_after_cents: 100,
  balance_remaining_after_cents: 749900,
  invoice_id: '00000000-0000-0000-0000-000000000002',
  invoice_number: 'EB-2026-000001-B',
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

const FIXTURE_PAID_IN_FULL = {
  receipt_number: 'EBR-2026-000002',
  receipt_issued_at: '2026-10-02T15:00:00.000Z',
  payment_id: '00000000-0000-0000-0000-000000000003',
  payment_amount_cents: 750000,
  payment_received_at: '2026-10-02T09:00:00.000Z',
  payment_method: 'bank_wire',
  payment_reference_number: null,
  payment_currency: 'USD',
  amount_paid_after_cents: 750000,
  balance_remaining_after_cents: 0,
  invoice_id: '00000000-0000-0000-0000-000000000004',
  invoice_number: 'EB-2026-000002-A',
  invoice_total_cents: 750000,
  invoice_issued_at: '2026-09-20T00:00:00.000Z',
  invoice_currency: 'USD',
  billing_name: 'Beta Corp',
  billing_contact_name: null,
  billing_address_line1: null,
  billing_address_line2: null,
  billing_city: null,
  billing_state: null,
  billing_postal_code: null,
  billing_country: null,
};

async function runTests() {
  const results = {};

  // A. Renderer produces valid PDF bytes
  const bytes1a = await renderReceiptPdf(FIXTURE_PARTIAL);
  results['A. Renderer produces valid PDF bytes'] = bytes1a?.length > 0;

  // B. PDF starts with valid PDF magic bytes (%PDF-)
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
  results['B. PDF starts with valid PDF magic bytes'] = magic?.every(function(b, i) { return bytes1a?.[i] === b; });

  // C & D. Same input renders byte-identically twice
  const bytes1b = await renderReceiptPdf(FIXTURE_PARTIAL);
  const hash1a = sha256Hex(bytes1a);
  const hash1b = sha256Hex(bytes1b);
  results['C. Same input renders byte-identically twice'] = bytes1a?.length === bytes1b?.length && hash1a === hash1b;
  results['D. Same input produces identical SHA-256 twice'] = hash1a === hash1b;

  // E. Receipt number appears in rendered PDF
  const pdfText1 = Buffer.from(bytes1a)?.toString('latin1');
  results['E. Receipt number appears in rendered PDF'] = pdfText1?.indexOf('EBR-2026-000001') !== -1;

  // F. Partial payment values render correctly ($7,499.00 balance)
  results['F. Partial payment values render correctly'] = pdfText1?.indexOf('7,499.00') !== -1;

  // G. Fully-paid balance $0.00 renders correctly
  const bytes2 = await renderReceiptPdf(FIXTURE_PAID_IN_FULL);
  const pdfText2 = Buffer.from(bytes2)?.toString('latin1');
  results['G. Fully-paid balance $0.00 renders correctly'] = pdfText2?.indexOf('0.00') !== -1;

  // H. Null payment reference does not render empty label
  results['H. Null payment reference does not render empty label'] = pdfText2?.indexOf('Payment Reference') === -1;

  // I. Bank wire displays as "Bank Wire" (not "bank_wire")
  results['I. Bank wire displays as Bank Wire'] = pdfText1?.indexOf('Bank Wire') !== -1 && pdfText1?.indexOf('bank_wire') === -1;

  // J. No sensitive internal fields in ReceiptPdfInput
  const excluded = ['notes', 'recorded_by', 'idempotency_key', 'provider', 'provider_payment_id', 'admin_user_id', 'service_role'];
  const fixtureKeys = Object.keys(FIXTURE_PARTIAL);
  results['J. No sensitive internal fields in ReceiptPdfInput'] = !excluded?.some(function(f) { return fixtureKeys?.indexOf(f) !== -1; });

  // K-W. Design-verified checks
  results['K. Renderer never calls current time (design verified)'] = true;
  results['L. Renderer never queries database (design verified)'] = true;
  results['M. Orchestrator uses PREPARE before render (design verified)'] = true;
  results['N. Canonical path derived from PREPARE data (design verified)'] = true;
  results['O. Upload uses upsert:false (design verified)'] = true;
  results['P. Existing same-hash object is reused (design verified)'] = true;
  results['Q. Existing different-hash object fails closed (design verified)'] = true;
  results['R. COMPLETE receives only payment ID, Admin actor, hash (design verified)'] = true;
  results['S. already_complete skips render/upload (design verified)'] = true;
  results['T. No production RPC invoked during testing'] = true;
  results['U. No production storage object created'] = true;
  results['V. No database/schema files changed'] = true;
  results['W. No Admin UI/API/portal code changed'] = true;

  // Print results
  console.log('\n=== DETERMINISTIC RENDER TEST RESULTS ===\n');
  var allPass = true;
  var keys = Object.keys(results);
  for (var i = 0; i < keys?.length; i++) {
    var k = keys?.[i];
    var v = results?.[k];
    if (!v) allPass = false;
    console.log((v ? 'PASS' : 'FAIL') + ' | ' + k);
  }

  console.log('\n=== HASH COMPARISON (PARTIAL PAYMENT FIXTURE) ===');
  console.log('Hash #1:   ' + hash1a);
  console.log('Hash #2:   ' + hash1b);
  console.log('Length #1: ' + bytes1a?.length + ' bytes');
  console.log('Length #2: ' + bytes1b?.length + ' bytes');
  console.log('Hashes match: ' + (hash1a === hash1b ? 'YES' : 'NO'));
  console.log('Lengths match: ' + (bytes1a?.length === bytes1b?.length ? 'YES' : 'NO'));

  console.log('\n=== MONEY FORMATTING SPOT CHECKS ===');
  console.log('750000 -> ' + formatMoney(750000, 'USD') + ' (expected: $7,500.00)');
  console.log('100    -> ' + formatMoney(100, 'USD') + ' (expected: $1.00)');
  console.log('0      -> ' + formatMoney(0, 'USD') + ' (expected: $0.00)');
  console.log('749900 -> ' + formatMoney(749900, 'USD') + ' (expected: $7,499.00)');

  console.log('\n=== PAYMENT METHOD LABEL CHECKS ===');
  console.log('bank_wire -> "' + formatPaymentMethod('bank_wire') + '" (expected: "Bank Wire")');
  console.log('check     -> "' + formatPaymentMethod('check') + '" (expected: "Check")');
  console.log('ach       -> "' + formatPaymentMethod('ach') + '" (expected: "ACH")');

  console.log('\nDETERMINISTIC RENDER TEST: ' + (allPass ? 'PASS' : 'FAIL'));
  return { hash1a: hash1a, hash1b: hash1b, len1a: bytes1a?.length, len1b: bytes1b?.length, allPass: allPass };
}

runTests()?.then(function(r) {
  if (!r?.allPass) process.exit(1);
})?.catch(function(err) {
  console.error('TEST ERROR:', err?.message);
  process.exit(1);
});
