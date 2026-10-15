import 'server-only';

import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Portal Receipt Download Route
// GET /api/portal/invoices/[invoiceId]/payment/[paymentId]/receipt
//
// READ-ONLY. Serves an EXISTING immutable receipt PDF only.
// Never generates, regenerates, uploads, writes, or emails anything.
// (No POST handler. No receipt orchestrator / PDF generator / email imports.)
//
// SECURITY MODEL:
//   1. Authenticate via SSR cookie session → auth.getUser()
//   2. Validate invoiceId / paymentId (UUID) and disposition
//   3. Approved CRM contact (portal_user_id + portal_link_status = 'approved')
//   4. Explicit crm_deal_contacts row (contact_id + deal_id = invoice.application_id)
//   5. Unauthorized / cross-tenant / missing resources → same generic 404
//   6. Invoice status must be open | partially_paid | paid
//      (any other status → generic 404 receipt_not_found)
//   7. payment.invoice_id === invoiceId, payment.status === 'received'
//   8. ALL FIVE receipt completion fields must be non-null
//   9. Stored path must equal independently derived canonical path
//  10. Private invoice-pdfs download (server-side, no signed URL)
//  11. %PDF- magic + SHA-256 verification against receipt_pdf_hash
//  12. private, no-store headers; safe filename from DB receipt_number
//
// SUPPORTED QUERY PARAMS:
//   disposition=inline (default) | attachment
// ============================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

const PORTAL_RECEIPT_INVOICE_STATUSES = new Set(['open', 'partially_paid', 'paid']);

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

// ── Auth helpers (same inline pattern as existing portal routes) ─────────────

async function getAuthClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ── Receipt helpers ──────────────────────────────────────────────────────────

function buildCanonicalPath(
  applicationId: string,
  invoiceId: string,
  paymentId: string
): string {
  return `receipts/${applicationId}/${invoiceId}/${paymentId}.pdf`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeReceiptFilename(receiptNumber: string | null | undefined): string {
  if (!receiptNumber || typeof receiptNumber !== 'string') {
    return 'receipt.pdf';
  }
  const sanitized = receiptNumber.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (!sanitized) return 'receipt.pdf';
  return `EarnestBridge-Receipt-${sanitized}.pdf`;
}

function notFound() {
  return NextResponse.json(
    { error: 'receipt_not_found' },
    { status: 404, headers: NO_STORE_HEADERS }
  );
}

function notAvailable() {
  return NextResponse.json(
    { error: 'receipt_not_available' },
    { status: 409, headers: NO_STORE_HEADERS }
  );
}

function integrityError() {
  return NextResponse.json(
    { error: 'receipt_integrity_error' },
    { status: 500, headers: NO_STORE_HEADERS }
  );
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string; paymentId: string }> }
) {
  try {
    // ── 1. Authenticate ────────────────────────────────────────────────────
    const authClient = await getAuthClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized' },
        { status: 401, headers: NO_STORE_HEADERS }
      );
    }

    // ── 2. Validate inputs ────────────────────────────────────────────────
    const { invoiceId, paymentId } = await params;

    if (!invoiceId || !UUID_RE.test(invoiceId)) {
      return NextResponse.json(
        { error: 'invalid_invoice_id' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    if (!paymentId || !UUID_RE.test(paymentId)) {
      return NextResponse.json(
        { error: 'invalid_payment_id' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    const dispositionParam =
      request.nextUrl.searchParams.get('disposition') ?? 'inline';
    if (dispositionParam !== 'inline' && dispositionParam !== 'attachment') {
      return NextResponse.json(
        { error: 'invalid_disposition' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    const disposition: 'inline' | 'attachment' = dispositionParam;

    // ── 3. Service client (server-only, after authentication) ─────────────
    const supabase = getServiceClient();

    // ── 4. Approved CRM contact ───────────────────────────────────────────
    const { data: approvedContact, error: contactError } = await supabase
      .from('crm_contacts')
      .select('id')
      .eq('portal_user_id', user.id)
      .eq('portal_link_status', 'approved')
      .maybeSingle();

    if (contactError) {
      console.error('[portal/receipt] contact fetch failed:', {
        stage: 'fetch_contact',
        code: contactError.code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'receipt_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }
    if (!approvedContact) return notFound();

    // ── 5. Load invoice ───────────────────────────────────────────────────
    const { data: invoice, error: invoiceError } = await supabase
      .from('crm_invoices')
      .select('id, application_id, invoice_number, status')
      .eq('id', invoiceId)
      .maybeSingle();

    if (invoiceError) {
      console.error('[portal/receipt] invoice fetch failed:', {
        stage: 'fetch_invoice',
        code: invoiceError.code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'receipt_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }
    if (!invoice || !invoice.application_id) return notFound();

    // ── 6. Explicit Deal ↔ Contact authorization ──────────────────────────
    const { data: dealContact, error: dealContactError } = await supabase
      .from('crm_deal_contacts')
      .select('deal_id')
      .eq('contact_id', approvedContact.id)
      .eq('deal_id', invoice.application_id)
      .maybeSingle();

    if (dealContactError) {
      console.error('[portal/receipt] deal contact fetch failed:', {
        stage: 'fetch_deal_contact',
        code: dealContactError.code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'receipt_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }
    if (!dealContact) return notFound();

    // ── 7. Invoice status eligibility ─────────────────────────────────────
    // Deterministic: ineligible status (draft/issuing/void) → generic 404.
    if (!PORTAL_RECEIPT_INVOICE_STATUSES.has(invoice.status)) {
      return notFound();
    }

    // ── 8. Load payment ───────────────────────────────────────────────────
    const { data: payment, error: paymentError } = await supabase
      .from('crm_payments')
      .select(
        'id, invoice_id, status, receipt_number, receipt_issued_at, receipt_pdf_storage_path, receipt_pdf_generated_at, receipt_pdf_hash'
      )
      .eq('id', paymentId)
      .maybeSingle();

    if (paymentError) {
      console.error('[portal/receipt] payment fetch failed:', {
        stage: 'fetch_payment',
        code: paymentError.code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'receipt_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }
    if (!payment || payment.invoice_id !== invoiceId) return notFound();

    if (payment.status !== 'received') return notAvailable();

    // ── 9. ALL FIVE completion fields required — never generate ───────────
    if (
      !payment.receipt_number ||
      !payment.receipt_issued_at ||
      !payment.receipt_pdf_storage_path ||
      !payment.receipt_pdf_generated_at ||
      !payment.receipt_pdf_hash
    ) {
      return notAvailable();
    }

    // ── 10. Canonical path verification ───────────────────────────────────
    const canonicalPath = buildCanonicalPath(
      invoice.application_id,
      invoiceId,
      paymentId
    );
    if (payment.receipt_pdf_storage_path !== canonicalPath) {
      console.error('[portal/receipt] stored path mismatch:', {
        stage: 'canonical_path',
        storedPath: '[redacted]',
      });
      return integrityError();
    }

    // ── 11. Private bucket download (server-side only) ────────────────────
    const { data: blobData, error: storageError } = await supabase.storage
      .from('invoice-pdfs')
      .download(canonicalPath);

    if (storageError || !blobData) {
      console.error('[portal/receipt] storage download failed:', {
        stage: 'storage_download',
        code: storageError ? 'storage_error' : 'no_data',
      });
      return NextResponse.json(
        { error: 'receipt_download_failed' },
        { status: 502, headers: NO_STORE_HEADERS }
      );
    }

    const pdfBytes = new Uint8Array(await blobData.arrayBuffer());

    // ── 12. %PDF- magic ───────────────────────────────────────────────────
    if (
      pdfBytes.length < PDF_MAGIC.length ||
      !PDF_MAGIC.every((byte, i) => pdfBytes[i] === byte)
    ) {
      console.error('[portal/receipt] invalid PDF magic:', { stage: 'magic_check' });
      return integrityError();
    }

    // ── 13. SHA-256 verification ──────────────────────────────────────────
    if (sha256Hex(pdfBytes) !== payment.receipt_pdf_hash.toLowerCase()) {
      console.error('[portal/receipt] hash mismatch:', { stage: 'hash_check' });
      return integrityError();
    }

    // ── 14. Stream PDF ────────────────────────────────────────────────────
    const filename = safeReceiptFilename(payment.receipt_number);
    return new NextResponse(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${disposition}; filename="${filename}"`,
        'Content-Length': String(pdfBytes.length),
      },
    });
  } catch {
    console.error('[portal/receipt] unexpected error:', { stage: 'unexpected_error' });
    return NextResponse.json(
      { error: 'receipt_request_failed' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
