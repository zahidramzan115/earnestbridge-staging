import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Invoice PDF Route
// GET /api/admin/invoices/[id]/pdf
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client
//   2. Verifies app_metadata.role === 'admin'
//   3. Invoice UUID validated server-side
//   4. pdf_storage_path loaded exclusively from DB — never from browser
//   5. PDF downloaded server-side via service_role from private bucket
//   6. PDF magic header validated before streaming
//   7. Filename derived from authoritative invoice_number only
//   8. No DB mutations, no Storage mutations
//   9. No signed URLs, no public URLs, no raw Supabase URLs exposed
//
// SUPPORTED QUERY PARAMS:
//   disposition=inline (default) | attachment
//
// ALLOWED INVOICE STATUSES FOR PDF RETRIEVAL:
//   open, partially_paid, paid, void
//
// REQUIRED PDF STATE:
//   pdf_generation_status = 'generated'
//   pdf_storage_path = non-empty string
// ============================================================

// UUID v4 validation regex
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Invoice statuses that permit PDF retrieval
const RETRIEVABLE_STATUSES = new Set(['open', 'partially_paid', 'paid', 'void']);

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

async function requireAdmin() {
  const supabase = await getAuthClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return user.app_metadata?.role === 'admin' ? user : null;
}

// ── Safe filename derivation ──────────────────────────────────────────────────
// Derives filename from the authoritative invoice_number only.
// Strips any characters that are not alphanumeric, hyphen, or underscore.
// Falls back to 'invoice.pdf' if invoice_number is missing or empty.

function safeFilename(invoiceNumber: string | null | undefined): string {
  if (!invoiceNumber || typeof invoiceNumber !== 'string') {
    return 'invoice.pdf';
  }
  // Sanitize: keep alphanumeric, hyphens, underscores only
  const sanitized = invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (!sanitized) return 'invoice.pdf';
  return `${sanitized}.pdf`;
}

// ── GET /api/admin/invoices/[id]/pdf ─────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // ── Top-level fail-closed catch ───────────────────────────────────────────
  // Captures any unexpected exception that escapes the normal return paths.
  // Intentional 400 / 401 / 404 / 409 / 502 responses are returned before
  // this catch is ever reached, so they are never converted to 500.
  let invoiceId: string | undefined;
  try {
  // ── 1. Admin authentication ───────────────────────────────────────────────
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  // ── 2. Validate invoice UUID ──────────────────────────────────────────────
  const { id: resolvedId } = await params;
  invoiceId = resolvedId;
  if (!invoiceId || !UUID_RE.test(invoiceId)) {
    return NextResponse.json(
      { error: 'invalid_invoice_id' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // ── 3. Validate disposition query param ──────────────────────────────────
  const dispositionParam = request.nextUrl.searchParams.get('disposition') ?? 'inline';
  if (dispositionParam !== 'inline' && dispositionParam !== 'attachment') {
    return NextResponse.json(
      { error: 'invalid_disposition' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  const disposition: 'inline' | 'attachment' = dispositionParam;

  // ── 4. Load safe server-side PDF metadata via service_role ───────────────
  // Select ONLY the fields needed for this route.
  // Do NOT select: wire_instructions_snapshot, pdf_hash, billing data,
  //                notes, financial details.
  const supabase = getServiceClient();

  const { data: invoice, error: invoiceError } = await supabase
    .from('crm_invoices')
    .select('id, invoice_number, status, pdf_generation_status, pdf_storage_path')
    .eq('id', invoiceId)
    .maybeSingle();

  // A real Supabase/database error — do NOT surface as 404
  if (invoiceError) {
    console.error('[invoices/pdf] invoice fetch failed:', {
      invoiceId,
      stage: 'fetch_invoice',
      code: invoiceError.code ?? 'unknown',
    });
    return NextResponse.json(
      { error: 'invoice_pdf_request_failed' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  // No matching row — genuine 404
  if (!invoice) {
    return NextResponse.json(
      { error: 'invoice_not_found' },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }

  // ── 5. Require generated PDF and retrievable invoice status ──────────────
  const isRetrievableStatus = RETRIEVABLE_STATUSES.has(invoice.status);
  const isPdfGenerated = invoice.pdf_generation_status === 'generated';
  const hasStoragePath =
    typeof invoice.pdf_storage_path === 'string' &&
    invoice.pdf_storage_path.trim().length > 0;

  if (!isRetrievableStatus || !isPdfGenerated || !hasStoragePath) {
    console.error('[invoices/pdf] PDF not available:', {
      invoiceId,
      stage: 'availability_check',
      status: invoice.status,
      pdf_generation_status: invoice.pdf_generation_status,
      has_storage_path: hasStoragePath,
    });
    return NextResponse.json(
      { error: 'invoice_pdf_not_available' },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }

  // ── 6. Download private PDF server-side via service_role ─────────────────
  // pdf_storage_path is loaded exclusively from DB — never from browser input.
  // The private invoice-pdfs bucket is never made public.
  // No signed URL is created or exposed.
  const storagePath: string = invoice.pdf_storage_path;

  const { data: blobData, error: storageError } = await supabase.storage
    .from('invoice-pdfs')
    .download(storagePath);

  if (storageError || !blobData) {
    console.error('[invoices/pdf] storage download failed:', {
      invoiceId,
      stage: 'storage_download',
      code: storageError?.message ? 'storage_error' : 'no_data',
    });
    return NextResponse.json(
      { error: 'invoice_pdf_storage_failed' },
      { status: 502, headers: NO_STORE_HEADERS }
    );
  }

  // ── 7. Convert Blob to bytes and validate ─────────────────────────────────
  let pdfBytes: Uint8Array;
  try {
    const arrayBuffer = await blobData.arrayBuffer();
    pdfBytes = new Uint8Array(arrayBuffer);
  } catch {
    console.error('[invoices/pdf] blob conversion failed:', {
      invoiceId,
      stage: 'blob_to_bytes',
    });
    return NextResponse.json(
      { error: 'invoice_pdf_invalid' },
      { status: 502, headers: NO_STORE_HEADERS }
    );
  }

  // Require non-empty bytes
  if (pdfBytes.length === 0) {
    console.error('[invoices/pdf] empty PDF bytes:', {
      invoiceId,
      stage: 'byte_length_check',
    });
    return NextResponse.json(
      { error: 'invoice_pdf_invalid' },
      { status: 502, headers: NO_STORE_HEADERS }
    );
  }

  // Validate PDF magic header: first 5 bytes must equal "%PDF-" (0x25 0x50 0x44 0x46 0x2D)
  const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const hasMagicHeader =
    pdfBytes.length >= 5 &&
    PDF_MAGIC.every((byte, i) => pdfBytes[i] === byte);

  if (!hasMagicHeader) {
    console.error('[invoices/pdf] invalid PDF magic header:', {
      invoiceId,
      stage: 'magic_header_check',
    });
    return NextResponse.json(
      { error: 'invoice_pdf_invalid' },
      { status: 502, headers: NO_STORE_HEADERS }
    );
  }

  // ── 8. Build safe Content-Disposition from authoritative invoice_number ───
  // Filename is derived exclusively from invoice_number loaded from DB.
  // Browser cannot influence the filename.
  const filename = safeFilename(invoice.invoice_number);
  const contentDisposition = `${disposition}; filename="${filename}"`;

  // ── 9. Stream PDF bytes with secure response headers ─────────────────────
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
    console.error('[invoices/pdf] unexpected error:', {
      invoiceId,
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
