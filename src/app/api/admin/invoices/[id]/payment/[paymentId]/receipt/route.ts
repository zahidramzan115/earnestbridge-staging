import 'server-only';

import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/server/adminAuth';
import {
  generateReceiptPdf,
  ReceiptOrchestratorError,
} from '@/lib/server/receiptPdfOrchestrator';
import {
  dispatchReceiptEmail,
  ReceiptEmailDispatchError,
  type ReceiptEmailOutcome,
} from '@/lib/server/receiptEmail';

// ============================================================
// Admin Receipt API Route
//
// POST /api/admin/invoices/[id]/payment/[paymentId]/receipt
//   Generate the immutable receipt if it does not yet exist, OR
//   recover/return the existing receipt state idempotently.
//
// GET  /api/admin/invoices/[id]/payment/[paymentId]/receipt
//   Serve an already-completed receipt PDF. READ-ONLY.
//   Never generates, allocates, or uploads anything.
//
// SECURITY MODEL:
//   1. requireAdmin() from centralized adminAuth for BOTH verbs
//   2. Invoice ID and payment ID taken ONLY from the URL — never from body
//   3. Admin identity taken ONLY from the authenticated server session
//   4. payment.invoice_id === URL invoice ID enforced before any action
//   5. Service-role client — fails closed if key is absent (no fallback)
//   6. POST body must be empty or {}; any supplied key is rejected
//   7. GET is strictly read-only — no DB writes, no orchestrator calls
//   8. GET derives canonical path from trusted DB values only
//   9. GET validates PDF magic bytes and SHA-256 hash before streaming
//  10. Cache-Control: private, no-store, max-age=0 on all responses
//  11. No raw Supabase errors, SQL detail, or storage internals exposed
// ============================================================

// ── Constants ────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

// POST body fields that are explicitly forbidden — browser must never supply these
const FORBIDDEN_POST_BODY_KEYS = [
  'admin_user_id',
  'invoice_id',
  'payment_id',
  'receipt_number',
  'receipt_issued_at',
  'storage_path',
  'pdf_hash',
  'generated_at',
  'receipt_pdf_storage_path',
  'receipt_pdf_hash',
  'receipt_pdf_generated_at',
  'recorded_by',
  'idempotency_key',
  'provider',
  'provider_payment_id',
  'status',
  'amount_cents',
  'notes',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Service-role Supabase client.
 * Fails closed — no fallback to anon key.
 * Throws if SUPABASE_SERVICE_ROLE_KEY is absent.
 */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase service configuration is missing.');
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Derive the canonical receipt PDF storage path from trusted DB values.
 * receipts/{application_id}/{invoice_id}/{payment_id}.pdf
 * All components must come from DB — never from caller input.
 */
function buildCanonicalPath(
  applicationId: string,
  invoiceId: string,
  paymentId: string,
): string {
  return `receipts/${applicationId}/${invoiceId}/${paymentId}.pdf`;
}

/**
 * Compute SHA-256 over bytes and return lowercase 64-char hex.
 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Derive a safe PDF filename from the receipt_number.
 * Strips any characters that are not alphanumeric, hyphen, or underscore.
 * Falls back to 'receipt.pdf' if receipt_number is missing or empty.
 */
function safeReceiptFilename(receiptNumber: string | null | undefined): string {
  if (!receiptNumber || typeof receiptNumber !== 'string') {
    return 'receipt.pdf';
  }
  const sanitized = receiptNumber.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (!sanitized) return 'receipt.pdf';
  return `EarnestBridge-Receipt-${sanitized}.pdf`;
}

type BrowserEmailOutcome = 'sent' | 'skipped' | 'failed' | 'uncertain';

/**
 * Normalize the rich internal dispatcher outcome into the only value the
 * browser is allowed to see. 'uncertain' is never collapsed.
 */
function normalizeEmailOutcome(outcome: ReceiptEmailOutcome): BrowserEmailOutcome {
  switch (outcome) {
    case 'sent':
      return 'sent';
    case 'already_sent':
    case 'currently_sending':
      return 'skipped';
    case 'uncertain':
      return 'uncertain';
    case 'failed':
    default:
      return 'failed';
  }
}

// ── POST ─────────────────────────────────────────────────────────────────────
//
// POST /api/admin/invoices/[id]/payment/[paymentId]/receipt
//
// Generates the immutable receipt if it does not yet exist, or recovers and
// returns the existing receipt state idempotently.
//
// Request body: must be empty, absent, or {}. Any supplied key is rejected.
// Admin actor identity comes ONLY from requireAdmin() — never from body.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> },
) {
  // ── 1. Admin authentication ───────────────────────────────────────────────
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Unauthorized.' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  // ── 2. Validate URL parameters ────────────────────────────────────────────
  const { id: invoiceId, paymentId } = await params;

  if (!isValidUUID(invoiceId)) {
    return NextResponse.json(
      { error: 'Invalid invoice ID.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (!isValidUUID(paymentId)) {
    return NextResponse.json(
      { error: 'Invalid payment ID.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // ── 3. Parse and validate request body ───────────────────────────────────
  // Read the raw body ONCE.
  //
  // VALID:
  //   A. Truly empty body (Content-Length: 0 or no body)
  //   B. Whitespace-only body
  //   C. application/json + {}
  //
  // INVALID (→ 400):
  //   D. application/json + malformed JSON
  //   E. application/json + JSON object with ANY key
  //   F. application/json + JSON array
  //   G. application/json + JSON primitive (null, string, number, boolean)
  //   H. Non-empty body with any non-JSON Content-Type
  //   I. Non-empty body with missing Content-Type
  //
  // The browser must never be able to smuggle ignored request content
  // through this route.
  let body: Record<string, unknown> = {};

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { error: 'Failed to read request body.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (rawBody.trim().length > 0) {
    // Non-empty body: Content-Type MUST be application/json.
    // Any other content type (text/plain, application/x-www-form-urlencoded,
    // missing, or unknown) is rejected to prevent content smuggling.
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return NextResponse.json(
        { error: 'Non-empty request body requires Content-Type: application/json.' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    // Must be a plain object (not null, not array, not primitive)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object or empty.' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    body = parsed as Record<string, unknown>;
  }
  // If rawBody.trim().length === 0 → body stays {} → valid (cases A and B)

  // Reject any supplied key — the browser chooses none of these
  for (const key of Object.keys(body)) {
    return NextResponse.json(
      { error: `Unexpected field: "${key}". The request body must be empty or {}.` },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // Explicitly reject forbidden fields (belt-and-suspenders — already caught above)
  for (const key of FORBIDDEN_POST_BODY_KEYS) {
    if (key in body) {
      return NextResponse.json(
        { error: `Field "${key}" cannot be supplied by the caller.` },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
  }

  // ── 4. Pre-flight: verify payment exists and is bound to the URL invoice ──
  let payment: {
    id: string;
    invoice_id: string;
    status: string;
  };

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('crm_payments')
      .select('id, invoice_id, status')
      .eq('id', paymentId)
      .maybeSingle();

    if (error) {
      console.error('[receipt POST] payment fetch failed:', {
        paymentId,
        code: (error as { code?: string }).code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'An unexpected error occurred. Please try again.' },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: 'Payment not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    payment = data;
  } catch {
    return NextResponse.json(
      { error: 'Service configuration error.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // ── 5. Confirm payment.invoice_id === URL invoice ID ─────────────────────
  if (payment.invoice_id !== invoiceId) {
    return NextResponse.json(
      { error: 'Payment not found.' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  // ── 6. Confirm payment.status === 'received' ──────────────────────────────
  if (payment.status !== 'received') {
    return NextResponse.json(
      { error: 'Receipt generation is only available for received payments.' },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }

  // ── 7. Call the approved orchestrator ────────────────────────────────────
  // Admin UUID comes ONLY from requireAdmin() — never from request input.
  // The orchestrator handles the full PREPARE→RENDER→HASH→STORAGE→COMPLETE
  // lifecycle. This route remains thin.
  let result;
  try {
    result = await generateReceiptPdf(paymentId, admin.id);
  } catch (err) {
    if (err instanceof ReceiptOrchestratorError) {
      const code = err.code;

      if (code === 'receipt_storage_conflict') {
        console.error('[receipt POST] orchestrator storage conflict:', { paymentId });
        return NextResponse.json(
          { error: 'A receipt conflict was detected. Please contact support.' },
          { status: 409, headers: NO_STORE_HEADERS },
        );
      }

      if (code === 'receipt_prepare_failed') {
        console.error('[receipt POST] orchestrator prepare failed:', { paymentId });
        return NextResponse.json(
          { error: 'Receipt preparation failed. Please try again.' },
          { status: 500, headers: NO_STORE_HEADERS },
        );
      }

      if (code === 'receipt_render_failed') {
        console.error('[receipt POST] orchestrator render failed:', { paymentId });
        return NextResponse.json(
          { error: 'Receipt generation failed. Please try again.' },
          { status: 500, headers: NO_STORE_HEADERS },
        );
      }

      if (code === 'receipt_upload_failed') {
        console.error('[receipt POST] orchestrator upload failed:', { paymentId });
        return NextResponse.json(
          { error: 'Receipt upload failed. Please retry — the operation is safe to retry.' },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }

      if (code === 'receipt_complete_failed') {
        console.error('[receipt POST] orchestrator complete failed:', { paymentId });
        return NextResponse.json(
          { error: 'Receipt completion failed. Please retry — the operation is safe to retry.' },
          { status: 503, headers: NO_STORE_HEADERS },
        );
      }

      // Unknown orchestrator error category
      console.error('[receipt POST] orchestrator unknown error:', { paymentId, code });
      return NextResponse.json(
        { error: 'An unexpected error occurred. Please try again.' },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }

    // Non-orchestrator error (e.g. service config missing)
    console.error('[receipt POST] unexpected error:', { paymentId });
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // ── 7b. Automatic receipt email ──────────────────────────────────────────
  // Receipt generation has succeeded and is valid. Email is independent:
  // no email problem may fail, roll back, or invalidate the receipt.
  // Invoked for BOTH newly generated and already_complete receipts —
  // the delivery table (claim_receipt_email_delivery) is the sole
  // idempotency authority. Awaited — never fire-and-forget.
  // Admin identity comes ONLY from the authenticated server session.
  let emailOutcome: BrowserEmailOutcome = 'failed';
  try {
    const emailResult = await dispatchReceiptEmail({
      paymentId,
      adminUserId: admin.id,
    });
    emailOutcome = normalizeEmailOutcome(emailResult.outcome);
  } catch (emailErr) {
    if (
      emailErr instanceof ReceiptEmailDispatchError &&
      emailErr.code === 'RECEIPT_EMAIL_FINALIZE_ERROR'
    ) {
      // Finalization could not be persisted; a provider call may already
      // have occurred, so delivery state is ambiguous.
      emailOutcome = 'uncertain';
    } else {
      emailOutcome = 'failed';
    }
    console.error('[receipt POST] receipt email dispatch error:', {
      paymentId,
      code:
        emailErr instanceof ReceiptEmailDispatchError
          ? emailErr.code
          : 'unexpected',
    });
  }

  // ── 8. Return safe success response ──────────────────────────────────────
  // Excluded: storage_path, pdf_hash, Admin UUID, Admin email, notes,
  //           recorded_by, idempotency_key, provider, provider_payment_id,
  //           service-role information, raw RPC results, email delivery
  //           internals (deliveryId, attemptCount, recipient, provider IDs).
  return NextResponse.json(
    {
      success: true,
      receipt: {
        payment_id: result.payment_id,
        invoice_id: result.invoice_id,
        receipt_number: result.receipt_number,
        receipt_issued_at: result.receipt_issued_at,
        generated_at: result.generated_at,
        already_complete: result.already_complete,
      },
      email: {
        outcome: emailOutcome,
      },
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

// ── GET ──────────────────────────────────────────────────────────────────────
//
// GET /api/admin/invoices/[id]/payment/[paymentId]/receipt
//
// Serves an already-completed receipt PDF. Strictly read-only.
//
// This handler NEVER:
//   - calls generateReceiptPdf()
//   - calls prepare_receipt_generation()
//   - calls complete_receipt_generation()
//   - allocates a receipt number
//   - uploads a PDF
//   - modifies the database
//
// Supports: ?disposition=inline (default) | attachment
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> },
) {
  // ── 1. Admin authentication ───────────────────────────────────────────────
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Unauthorized.' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  // ── 2. Validate URL parameters ────────────────────────────────────────────
  const { id: invoiceId, paymentId } = await params;

  if (!isValidUUID(invoiceId)) {
    return NextResponse.json(
      { error: 'Invalid invoice ID.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (!isValidUUID(paymentId)) {
    return NextResponse.json(
      { error: 'Invalid payment ID.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // ── 3. Validate disposition query param (reuse existing PDF route pattern) ─
  const dispositionParam =
    request.nextUrl.searchParams.get('disposition') ?? 'inline';
  if (dispositionParam !== 'inline' && dispositionParam !== 'attachment') {
    return NextResponse.json(
      { error: 'Invalid disposition parameter.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const disposition: 'inline' | 'attachment' = dispositionParam;

  // ── 4. Load payment and invoice fields needed to serve the receipt ────────
  // Only the fields required for receipt serving are selected.
  // No notes, no recorded_by, no provider data, no Admin identity.
  let paymentRow: {
    id: string;
    invoice_id: string;
    status: string;
    receipt_number: string | null;
    receipt_issued_at: string | null;
    receipt_pdf_storage_path: string | null;
    receipt_pdf_generated_at: string | null;
    receipt_pdf_hash: string | null;
  };

  let invoiceRow: {
    id: string;
    application_id: string | null;
  };

  try {
    const supabase = getServiceClient();

    const { data: pData, error: pError } = await supabase
      .from('crm_payments')
      .select(
        'id, invoice_id, status, receipt_number, receipt_issued_at, receipt_pdf_storage_path, receipt_pdf_generated_at, receipt_pdf_hash',
      )
      .eq('id', paymentId)
      .maybeSingle();

    if (pError) {
      console.error('[receipt GET] payment fetch failed:', {
        paymentId,
        code: (pError as { code?: string }).code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'An unexpected error occurred.' },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }

    if (!pData) {
      return NextResponse.json(
        { error: 'Receipt not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    paymentRow = pData;

    // ── 5. Confirm payment.invoice_id === URL invoice ID ──────────────────
    if (paymentRow.invoice_id !== invoiceId) {
      return NextResponse.json(
        { error: 'Receipt not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    // ── 6. Require payment.status === 'received' ──────────────────────────
    if (paymentRow.status !== 'received') {
      return NextResponse.json(
        { error: 'Receipt not available for this payment.' },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }

    // ── 7. Require all receipt fields to be non-NULL ──────────────────────
    if (
      !paymentRow.receipt_number ||
      !paymentRow.receipt_issued_at ||
      !paymentRow.receipt_pdf_storage_path ||
      !paymentRow.receipt_pdf_generated_at ||
      !paymentRow.receipt_pdf_hash
    ) {
      return NextResponse.json(
        { error: 'Receipt has not been generated yet.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    // ── 8. Load related invoice for application_id ────────────────────────
    const { data: iData, error: iError } = await supabase
      .from('crm_invoices')
      .select('id, application_id')
      .eq('id', invoiceId)
      .maybeSingle();

    if (iError) {
      console.error('[receipt GET] invoice fetch failed:', {
        invoiceId,
        code: (iError as { code?: string }).code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'An unexpected error occurred.' },
        { status: 500, headers: NO_STORE_HEADERS },
      );
    }

    if (!iData) {
      return NextResponse.json(
        { error: 'Receipt not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    invoiceRow = iData;
  } catch {
    return NextResponse.json(
      { error: 'Service configuration error.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // ── 9. Canonical path verification ───────────────────────────────────────
  // Derive expected canonical path from trusted DB values only.
  // receipts/{application_id}/{invoice_id}/{payment_id}.pdf
  // Fail closed if stored path does not match.
  if (!invoiceRow.application_id) {
    console.error('[receipt GET] invoice missing application_id:', { invoiceId });
    return NextResponse.json(
      { error: 'Receipt integrity error.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const expectedCanonicalPath = buildCanonicalPath(
    invoiceRow.application_id,
    invoiceId,
    paymentId,
  );

  if (paymentRow.receipt_pdf_storage_path !== expectedCanonicalPath) {
    console.error('[receipt GET] stored path does not match canonical path:', {
      paymentId,
      storedPath: '[redacted]',
      expectedPath: '[redacted]',
    });
    return NextResponse.json(
      { error: 'Receipt integrity error.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // ── 10. Download from private bucket server-side ──────────────────────────
  // No signed URL. No public URL. No redirect to storage.
  // Bytes are read server-side via service-role client.
  let pdfBytes: Uint8Array;

  try {
    const supabase = getServiceClient();

    const { data: blobData, error: storageError } = await supabase.storage
      .from('invoice-pdfs')
      .download(expectedCanonicalPath);

    if (storageError || !blobData) {
      console.error('[receipt GET] storage download failed:', {
        paymentId,
        code: storageError
          ? (storageError as { statusCode?: string }).statusCode ?? 'unknown' :'no_data',
      });
      return NextResponse.json(
        { error: 'Receipt download failed.' },
        { status: 502, headers: NO_STORE_HEADERS },
      );
    }

    const arrayBuffer = await blobData.arrayBuffer();
    pdfBytes = new Uint8Array(arrayBuffer);
  } catch {
    return NextResponse.json(
      { error: 'Service configuration error.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // ── 11. Validate PDF magic bytes (%PDF-) ──────────────────────────────────
  if (
    pdfBytes.length < PDF_MAGIC.length ||
    !PDF_MAGIC.every((byte, i) => pdfBytes[i] === byte)
  ) {
    console.error('[receipt GET] invalid PDF magic bytes:', { paymentId });
    return NextResponse.json(
      { error: 'Receipt integrity error.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // ── 12. Recompute SHA-256 and require hash match ──────────────────────────
  const computedHash = sha256Hex(pdfBytes);
  const storedHash = paymentRow.receipt_pdf_hash!.toLowerCase();

  if (computedHash !== storedHash) {
    console.error('[receipt GET] SHA-256 hash mismatch:', { paymentId });
    return NextResponse.json(
      { error: 'Receipt integrity error.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // ── 13. Build safe Content-Disposition from receipt_number ───────────────
  // Filename derived exclusively from receipt_number loaded from DB.
  // Browser cannot influence the filename.
  const filename = safeReceiptFilename(paymentRow.receipt_number);
  const contentDisposition = `${disposition}; filename="${filename}"`;

  // ── 14. Stream PDF bytes with secure response headers ────────────────────
  // No storage path, stored hash, service-role info, Admin identity,
  // payment notes, or provider data is exposed.
  return new NextResponse(pdfBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': contentDisposition,
      'Content-Length': String(pdfBytes.length),
    },
  });
}
