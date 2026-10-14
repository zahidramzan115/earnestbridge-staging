import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Create Revision Draft API
// POST /api/admin/invoices/[id]/revise
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client
//   2. Verifies app_metadata.role === 'admin' ONLY
//      — user_metadata / raw_user_meta_data / email are NEVER trusted
//   3. Admin UUID sourced exclusively from authenticated session —
//      never from request body
//   4. Source invoice ID sourced exclusively from route params —
//      never from request body
//   5. All DB operations use service_role (never exposed to browser)
//   6. No request body required or accepted
//   7. All revision business logic is authoritative in the RPC:
//      public.create_revision_draft_invoice(
//        p_source_invoice_id, p_admin_user_id
//      )
//
// WORKFLOW:
//   A. Authenticate admin session (app_metadata.role === 'admin')
//   B. Validate params.id is a syntactically valid UUID
//   C. Call create_revision_draft_invoice RPC via service-role client
//   D. Map stable RPC error tokens to HTTP status codes
//   E. Validate RPC success contract for 'created' and 'existing_draft'
//   F. Return safe payload (no billing/wire/notes/PDF data)
//
// NO MIGRATION, NO UI CHANGES, NO ACTIVITY CREATION IN THIS STEP.
// ============================================================

// UUID v4 validation regex
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Cache-Control header ──────────────────────────────────────────────────────

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

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
  // ONLY trust app_metadata — never user_metadata or email
  return user.app_metadata?.role === 'admin' ? user : null;
}

// ── Safe integer guard ────────────────────────────────────────────────────────
// Returns true if value is a finite integer within Number.MAX_SAFE_INTEGER.

function isSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

// ── RPC success contract validation ──────────────────────────────────────────

interface RpcCreatedPayload {
  status: 'created';
  invoice_id: string;
  revision_source_invoice_id: string;
  application_id: string;
  invoice_type: string;
  source_invoice_number: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
}

interface RpcExistingDraftPayload {
  status: 'existing_draft';
  invoice_id: string;
  revision_source_invoice_id: string;
  application_id: string;
}

type RpcPayload = RpcCreatedPayload | RpcExistingDraftPayload;

/**
 * Validates the common fields required for BOTH 'created' and 'existing_draft'.
 */
function validateCommonFields(
  data: Record<string, unknown>,
  sourceInvoiceId: string
): boolean {
  // rpcData must be a non-array object
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }

  // invoice_id must be a valid UUID string
  if (
    typeof data.invoice_id !== 'string' ||
    !UUID_RE.test(data.invoice_id)
  ) {
    return false;
  }

  // revision_source_invoice_id must equal the source invoice ID we sent
  if (data.revision_source_invoice_id !== sourceInvoiceId) {
    return false;
  }

  // application_id must be a valid UUID string
  if (
    typeof data.application_id !== 'string' ||
    !UUID_RE.test(data.application_id)
  ) {
    return false;
  }

  return true;
}

/**
 * Validates the additional fields required only for status = 'created'.
 */
function validateCreatedFields(data: Record<string, unknown>): boolean {
  // invoice_type must be 'initial'
  if (data.invoice_type !== 'initial') {
    return false;
  }

  // source_invoice_number must be a non-empty string
  if (
    typeof data.source_invoice_number !== 'string' ||
    data.source_invoice_number.trim() === ''
  ) {
    return false;
  }

  // subtotal_cents must be a safe integer >= 0
  if (!isSafeInteger(data.subtotal_cents) || (data.subtotal_cents as number) < 0) {
    return false;
  }

  // discount_cents must be a safe integer >= 0
  if (!isSafeInteger(data.discount_cents) || (data.discount_cents as number) < 0) {
    return false;
  }

  // tax_cents must be exactly 0
  if (data.tax_cents !== 0) {
    return false;
  }

  // total_cents must be a safe integer >= 0
  if (!isSafeInteger(data.total_cents) || (data.total_cents as number) < 0) {
    return false;
  }

  return true;
}

/**
 * Validates and narrows the RPC response to a typed payload.
 * Returns null if the contract is not satisfied.
 */
function validateRpcResponse(
  data: unknown,
  sourceInvoiceId: string
): RpcPayload | null {
  // Must be a non-null, non-array object
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // status must be present
  const status = obj.status;
  if (status !== 'created' && status !== 'existing_draft') {
    return null;
  }

  // Validate common fields for both statuses
  if (!validateCommonFields(obj, sourceInvoiceId)) {
    return null;
  }

  if (status === 'created') {
    if (!validateCreatedFields(obj)) {
      return null;
    }
    return obj as unknown as RpcCreatedPayload;
  }

  // status === 'existing_draft'
  return obj as unknown as RpcExistingDraftPayload;
}

// ── Stable RPC error token → HTTP status mapping ──────────────────────────────

const RPC_ERROR_MAP: Record<string, number> = {
  admin_not_authorized: 403,
  revision_source_not_found: 404,
  revision_source_ineligible: 409,
  revision_already_in_progress: 409,
  revision_create_source_invalid: 409,
  revision_create_line_items_invalid: 409,
};

// ── POST /api/admin/invoices/[id]/revise ──────────────────────────────────────

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // ── 1. Authenticate and authorize admin ───────────────────────────────────
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized.' },
      { status: 401, headers: NO_STORE }
    );
  }

  // ── 2. Validate source invoice UUID from route params ─────────────────────
  const { id: sourceInvoiceId } = await params;

  if (!sourceInvoiceId || !UUID_RE.test(sourceInvoiceId)) {
    return NextResponse.json(
      { success: false, error: 'invalid_invoice_id' },
      { status: 400, headers: NO_STORE }
    );
  }

  // ── 3. Call atomic RPC via service-role client ────────────────────────────
  // The service-role client is created server-side only.
  // The browser never calls the RPC directly.
  const supabase = getServiceClient();

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'create_revision_draft_invoice',
    {
      p_source_invoice_id: sourceInvoiceId,
      p_admin_user_id: admin.id,
    }
  );

  // ── 4. Handle RPC errors ──────────────────────────────────────────────────
  if (rpcError) {
    // Extract the stable error token from the message.
    // PostgreSQL RAISE EXCEPTION with a stable token is in rpcError.message.
    // We trim to normalize whitespace.
    const token = rpcError.message?.trim() ?? '';

    // Check for a known stable error token
    if (token in RPC_ERROR_MAP) {
      const httpStatus = RPC_ERROR_MAP[token];
      return NextResponse.json(
        { success: false, error: token },
        { status: httpStatus, headers: NO_STORE }
      );
    }

    // Unexpected RPC error — log only safe metadata, never billing/notes/wire data
    console.error('[invoices/revise] unexpected RPC error:', {
      sourceInvoiceId,
      // Log Supabase error code if available (safe metadata)
      code: rpcError.code ?? null,
      // Do NOT log rpcError.message, rpcError.details, rpcError.hint —
      // they may contain sensitive PostgreSQL DETAIL text
    });

    return NextResponse.json(
      { success: false, error: 'revision_create_failed' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── 5. Validate RPC success contract ─────────────────────────────────────
  // Do NOT blindly trust rpcData. Validate the full contract before responding.
  const validated = validateRpcResponse(rpcData, sourceInvoiceId);

  if (!validated) {
    // Log only safe metadata — no billing/notes/wire data
    const safeStatus =
      rpcData &&
      typeof rpcData === 'object' &&
      !Array.isArray(rpcData) &&
      typeof (rpcData as Record<string, unknown>).status === 'string'
        ? (rpcData as Record<string, unknown>).status
        : null;

    console.error('[invoices/revise] RPC response failed contract validation:', {
      sourceInvoiceId,
      returnedStatus: safeStatus,
    });

    return NextResponse.json(
      { success: false, error: 'revision_create_invalid_response' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── 6. Return safe success response ──────────────────────────────────────

  if (validated.status === 'created') {
    // HTTP 201 — new Revision Draft created
    // Return only safe fields — no billing/notes/wire/PDF data
    return NextResponse.json(
      {
        success: true,
        status: 'created',
        invoice_id: validated.invoice_id,
        revision_source_invoice_id: validated.revision_source_invoice_id,
        application_id: validated.application_id,
        source_invoice_number: validated.source_invoice_number,
        invoice_type: validated.invoice_type,
        subtotal_cents: validated.subtotal_cents,
        discount_cents: validated.discount_cents,
        tax_cents: validated.tax_cents,
        total_cents: validated.total_cents,
      },
      { status: 201, headers: NO_STORE }
    );
  }

  // status === 'existing_draft'
  // HTTP 200 — idempotent: a Revision Draft already exists for this source
  // Allows double-click/retry to safely navigate to the existing draft
  return NextResponse.json(
    {
      success: true,
      status: 'existing_draft',
      invoice_id: validated.invoice_id,
      revision_source_invoice_id: validated.revision_source_invoice_id,
      application_id: validated.application_id,
    },
    { status: 200, headers: NO_STORE }
  );
}
