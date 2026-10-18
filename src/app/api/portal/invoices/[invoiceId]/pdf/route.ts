import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Portal Invoice PDF Route
// GET /api/portal/invoices/[invoiceId]/pdf
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client (cookie-based)
//   2. User identity comes ONLY from auth.getUser() → user.id
//   3. Invoice UUID validated server-side before any DB query
//   4. Requires approved CRM Contact (portal_user_id + portal_link_status = 'approved')
//   5. Requires explicit crm_deal_contacts row (contact_id + deal_id = invoice.application_id)
//   6. pdf_storage_path loaded exclusively from DB — never from browser
//   7. PDF downloaded server-side via service_role from private bucket
//   8. PDF magic header (%PDF-) validated before streaming
//   9. Filename derived from authoritative invoice_number only
//  10. No DB mutations, no Storage mutations
//  11. No signed URLs, no public URLs, no raw Supabase URLs exposed
//  12. Unauthorized existing invoice returns same 404 as missing invoice
//
// SUPPORTED QUERY PARAMS:
//   disposition=inline (default) | attachment
//
// PORTAL-ALLOWED INVOICE STATUSES FOR PDF RETRIEVAL:
//   open, partially_paid, paid
//   (void is intentionally excluded — portal clients must not access superseded PDFs)
//
// REQUIRED PDF STATE:
//   pdf_generation_status = 'generated'
//   pdf_storage_path = non-empty string
//   invoice_number = non-empty string
//
// AUTHORIZATION CHAIN:
//   authenticated Portal session
//   → approved CRM Contact (crm_contacts.portal_user_id + portal_link_status = 'approved')
//   → invoice.application_id
//   → explicit crm_deal_contacts (contact_id + deal_id = invoice.application_id)
//
// DO NOT AUTHORIZE USING:
//   borrower_applications.user_id
//   company membership
//   invoice billing email
//   invoice contact_id alone
//   company_id
//   browser-supplied Deal ID
//   browser-supplied storage path
// ============================================================

// UUID v4 validation regex
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Portal-allowed invoice statuses for PDF retrieval
// void is intentionally excluded — portal clients must not access superseded PDFs
const PORTAL_RETRIEVABLE_STATUSES = new Set(['open', 'partially_paid', 'paid']);

// Cache-Control for all responses (auth-gated private content)
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

// ── Auth helpers ─────────────────────────────────────────────────────────────

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

// ── Safe filename derivation ──────────────────────────────────────────────────
// Derives filename from the authoritative invoice_number only.
// Strips any characters that are not alphanumeric, hyphen, or underscore.
// Falls back to 'invoice.pdf' if invoice_number is missing or empty.
// Browser cannot influence the filename.

function safeFilename(invoiceNumber: string | null | undefined): string {
  if (!invoiceNumber || typeof invoiceNumber !== 'string') {
    return 'invoice.pdf';
  }
  const sanitized = invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (!sanitized) return 'invoice.pdf';
  return `${sanitized}.pdf`;
}

// ── GET /api/portal/invoices/[invoiceId]/pdf ──────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  // ── Top-level fail-closed catch ───────────────────────────────────────────
  // Captures any unexpected exception that escapes the normal return paths.
  // Intentional 400 / 401 / 404 / 409 / 502 responses are returned before
  // this catch is ever reached, so they are never converted to 500.
  let resolvedInvoiceId: string | undefined;
  try {
    // ── 1. Server-side authentication ─────────────────────────────────────
    // User identity comes ONLY from the SSR cookie session — never from
    // request body, query string, headers, or invoice metadata.
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

    // Authenticated user ID — server-derived only
    const authenticatedUserId = user.id;

    // ── 2. Validate invoice UUID ───────────────────────────────────────────
    // Validate before any DB query to avoid unnecessary round-trips.
    const { invoiceId } = await params;
    resolvedInvoiceId = invoiceId;
    if (!resolvedInvoiceId || !UUID_RE.test(resolvedInvoiceId)) {
      return NextResponse.json(
        { error: 'invalid_invoice_id' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // ── 3. Validate disposition query param ───────────────────────────────
    // Do not pass arbitrary disposition strings into response headers.
    const dispositionParam =
      request.nextUrl.searchParams.get('disposition') ?? 'inline';
    if (dispositionParam !== 'inline' && dispositionParam !== 'attachment') {
      return NextResponse.json(
        { error: 'invalid_disposition' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    const disposition: 'inline' | 'attachment' = dispositionParam;

    // ── Service-role client (server-only) ─────────────────────────────────
    const supabase = getServiceClient();

    // ── 4. Require approved CRM Contact ───────────────────────────────────
    // The authenticated user must have an approved CRM Contact linked to
    // their auth.uid(). Company membership alone grants nothing.
    const { data: approvedContacts, error: contactError } = await supabase
      .from('crm_contacts')
      .select('id')
      .eq('portal_user_id', authenticatedUserId)
      .eq('portal_link_status', 'approved');

    if (contactError) {
      console.error('[portal/invoices/pdf] contact fetch failed:', {
        stage: 'fetch_contact',
        code: contactError.code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'invoice_pdf_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }

    const approvedContactIds = (approvedContacts ?? []).map(
      (c: { id: string }) => c.id
    );

    // No approved Contact — return same generic not-found as inaccessible invoice.
    // Do NOT reveal whether an invoice ID is valid but belongs to another client.
    if (approvedContactIds.length === 0) {
      return NextResponse.json(
        { error: 'invoice_not_found' },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    // ── 5. Load invoice server-side via service_role ───────────────────────
    // Select ONLY the fields needed for authorization and PDF retrieval.
    // application_id is used ONLY server-side for authorization — never returned.
    // Do NOT select: wire_instructions_snapshot, pdf_hash, pdf_generation_error,
    //                internal_notes, billing fields, created_by, voided_by,
    //                revision_source_invoice_id, replaces_invoice_id, line items, payments.
    const { data: invoice, error: invoiceError } = await supabase
      .from('crm_invoices')
      .select('id, application_id, invoice_number, status, pdf_generation_status, pdf_storage_path')
      .eq('id', resolvedInvoiceId)
      .maybeSingle();

    if (invoiceError) {
      console.error('[portal/invoices/pdf] invoice fetch failed:', {
        stage: 'fetch_invoice',
        code: invoiceError.code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'invoice_pdf_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }

    // Invoice does not exist — genuine 404
    if (!invoice) {
      return NextResponse.json(
        { error: 'invoice_not_found' },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    // ── 6. Explicit Deal ↔ Contact authorization ───────────────────────────
    // Verify the approved Contact has an explicit crm_deal_contacts row for
    // invoice.application_id. This is the ONLY authorization path.
    // DO NOT fall back to: borrower_applications.user_id, company membership,
    //                       email matching, primary_contact_id, invoice contact_id.
    const { data: dealContacts, error: dealContactError } = await supabase
      .from('crm_deal_contacts')
      .select('deal_id')
      .in('contact_id', approvedContactIds)
      .eq('deal_id', invoice.application_id)
      .limit(1);

    if (dealContactError) {
      console.error('[portal/invoices/pdf] deal contact fetch failed:', {
        stage: 'fetch_deal_contact',
        code: dealContactError.code ?? 'unknown',
      });
      return NextResponse.json(
        { error: 'invoice_pdf_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }

    // No explicit Deal ↔ Contact relationship — return same 404 as missing invoice.
    // This is intentional: do NOT return 403, which would allow an authenticated
    // user to determine whether another customer's invoice UUID exists.
    if (!dealContacts || dealContacts.length === 0) {
      return NextResponse.json(
        { error: 'invoice_not_found' },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    // ── 6b. Parent Deal must be active (not purged) ────────────────────────
    // Service role bypasses RLS; enforce purge visibility explicitly with the
    // same 404 as a missing invoice.
    const { data: activeDeal, error: activeDealError } = await supabase
      .from('borrower_applications').select('id').eq('id', invoice.application_id).is('purged_at', null)
      .maybeSingle();

    if (activeDealError) {
      return NextResponse.json(
        { error: 'invoice_pdf_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }

    if (!activeDeal) {
      return NextResponse.json(
        { error: 'invoice_not_found' },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    // ── 7. Portal-specific status check ───────────────────────────────────
    // Portal allows ONLY: open, partially_paid, paid.
    // void is intentionally excluded — portal clients must not access
    // superseded/void invoice PDFs. This differs from the Admin route which
    // permits void for historical access.
    // draft and issuing are also excluded.
    const isPortalRetrievableStatus = PORTAL_RETRIEVABLE_STATUSES.has(invoice.status);
    const isPdfGenerated = invoice.pdf_generation_status === 'generated';
    const hasStoragePath =
      typeof invoice.pdf_storage_path === 'string' &&
      invoice.pdf_storage_path.trim().length > 0;
    const hasInvoiceNumber =
      typeof invoice.invoice_number === 'string' &&
      invoice.invoice_number.trim().length > 0;

    // Authorized for the Deal but invoice is not currently PDF-retrievable.
    // Do NOT expose which internal condition failed.
    if (!isPortalRetrievableStatus || !isPdfGenerated || !hasStoragePath || !hasInvoiceNumber) {
      return NextResponse.json(
        { error: 'invoice_pdf_not_available' },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }

    // ── 8. Download private PDF server-side via service_role ──────────────
    // pdf_storage_path is loaded exclusively from DB — never from browser input.
    // The private invoice-pdfs bucket is never made public.
    // No signed URL is created or exposed.
    // The browser/request must NEVER supply: bucket name, storage path, filename,
    // or application_id.
    const storagePath: string = invoice.pdf_storage_path;

    const { data: blobData, error: storageError } = await supabase.storage
      .from('invoice-pdfs')
      .download(storagePath);

    if (storageError || !blobData) {
      console.error('[portal/invoices/pdf] storage download failed:', {
        stage: 'storage_download',code: storageError?.message ? 'storage_error' : 'no_data',
      });
      return NextResponse.json(
        { error: 'invoice_pdf_storage_failed' },
        { status: 502, headers: NO_STORE_HEADERS }
      );
    }

    // ── 9. Convert Blob to bytes and validate ─────────────────────────────
    let pdfBytes: Uint8Array;
    try {
      const arrayBuffer = await blobData.arrayBuffer();
      pdfBytes = new Uint8Array(arrayBuffer);
    } catch {
      console.error('[portal/invoices/pdf] blob conversion failed:', {
        stage: 'blob_to_bytes',
      });
      return NextResponse.json(
        { error: 'invoice_pdf_invalid' },
        { status: 502, headers: NO_STORE_HEADERS }
      );
    }

    // Require non-empty bytes
    if (pdfBytes.length === 0) {
      console.error('[portal/invoices/pdf] empty PDF bytes:', {
        stage: 'byte_length_check',
      });
      return NextResponse.json(
        { error: 'invoice_pdf_invalid' },
        { status: 502, headers: NO_STORE_HEADERS }
      );
    }

    // Validate PDF magic header: first 5 bytes must equal "%PDF-"
    // hex: 25 50 44 46 2D
    const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
    const hasMagicHeader =
      pdfBytes.length >= 5 &&
      PDF_MAGIC.every((byte, i) => pdfBytes[i] === byte);

    if (!hasMagicHeader) {
      console.error('[portal/invoices/pdf] invalid PDF magic header:', {
        stage: 'magic_header_check',
      });
      return NextResponse.json(
        { error: 'invoice_pdf_invalid' },
        { status: 502, headers: NO_STORE_HEADERS }
      );
    }

    // ── 10. Build safe Content-Disposition from authoritative invoice_number
    // Filename is derived exclusively from invoice_number loaded from DB.
    // Browser cannot influence the filename.
    // Do NOT derive filename from: query params, storage path, browser input.
    const filename = safeFilename(invoice.invoice_number);
    const contentDisposition = `${disposition}; filename="${filename}"`;

    // ── 11. Stream PDF bytes with secure response headers ─────────────────
    // No storage metadata, no internal headers, no Supabase URLs exposed.
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
  } catch {
    // ── Outer fail-closed handler ─────────────────────────────────────────
    // Only reached by truly unexpected exceptions that escaped all normal
    // return paths above. Intentional 400/401/404/409/502 responses are
    // returned before this point and are never caught here.
    console.error('[portal/invoices/pdf] unexpected error:', {
      stage: 'unexpected_error',
    });
    return NextResponse.json(
      { error: 'invoice_pdf_request_failed' },
      {
        status: 500,
        headers: { 'Cache-Control': 'private, no-store, max-age=0' },
      }
    );
  }
}
