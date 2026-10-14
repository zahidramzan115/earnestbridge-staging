import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import {
  continueInvoicePdfIssuance,
  InvoicePdfOrchestratorError,
  OrchestratorSuccessResult,
} from '@/lib/server/invoicePdfOrchestrator';

import {
  dispatchInvoiceEmail,
  InvoiceEmailDispatchError,
} from '@/lib/server/invoiceEmail';

// ============================================================
// Admin Invoice Issue API
// POST /api/admin/invoices/[id]/issue — Full PDF Issuance Pipeline
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client
//   2. Verifies app_metadata.role === 'admin'
//   3. Admin UUID sourced exclusively from authenticated session —
//      never from request body
//   4. All DB operations use service_role (never exposed to browser)
//   5. No financial or issuance payload accepted from browser
//   6. All issuance business logic is authoritative in the RPCs:
//      public.begin_invoice_issuance(p_invoice_id, p_admin_user_id)
//      public.begin_revision_invoice_issuance(p_invoice_id, p_admin_user_id)
//      public.complete_invoice_issuance(...)
//      public.complete_revision_invoice_issuance(...)
//      public.mark_invoice_pdf_failed(...)
//
// WORKFLOW:
//   A. Read current invoice state (safe minimal projection)
//   B. If status === 'draft':
//        Normal draft  → begin_invoice_issuance → validate → orchestrator
//        Revision draft → begin_revision_invoice_issuance → validate → orchestrator
//   C. If status === 'issuing':
//        validate retry preconditions → call orchestrator directly
//   D. If status === 'open':
//        validate strict already-open state → return idempotent already-issued
//        (or 500 invoice_issue_state_invalid if completion fields are corrupt)
//   E. If status is non-issuable (partially_paid, paid, void):
//        return 409 invoice_not_issuable
//   F. invoice_not_draft / revision_invoice_not_draft concurrency:
//        mode-aware re-fetch and route to C or D
//   G. INVOICE_PDF_INVALID_STATE from orchestrator: re-fetch and reconcile
//
// REVISION MODE DETECTION:
//   revision_source_invoice_id !== null  →  Revision invoice
//   revision_source_invoice_id === null  →  Normal invoice
//   Do NOT infer from invoice_number suffix, replaces_invoice_id alone,
//   or invoice_type.
//
// Invoice email delivery is attempted only after successful committed issuance.
// Email delivery failure does not roll back or fail invoice issuance.
// ============================================================

// UUID v4 validation regex
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// ── Safe minimal invoice workflow state ──────────────────────────────────────
// Only the fields needed to route the workflow decision.
// Does NOT select wire_instructions_snapshot, pdf_storage_path, pdf_hash,
// billing fields, bank details, or financial snapshot.
//
// revision_source_invoice_id — authoritative Revision lifecycle indicator.
//   Non-null → Revision invoice. Null → Normal invoice.
// replaces_invoice_id — used for Revision relationship validation only.

interface InvoiceWorkflowState {
  id: string;
  status: string;
  invoice_number: string | null;
  pdf_generation_status: string | null;
  issued_at: string | null;
  revision_source_invoice_id: string | null;
  replaces_invoice_id: string | null;
}

// Structured result distinguishing NOT_FOUND from QUERY_FAILED.
// PGRST116 = no rows returned by .single() → NOT_FOUND.
// Any other query error → QUERY_FAILED.
type WorkflowFetchResult =
  | { outcome: 'FOUND'; state: InvoiceWorkflowState }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'QUERY_FAILED' };

async function fetchInvoiceWorkflowState(
  invoiceId: string
): Promise<WorkflowFetchResult> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('crm_invoices')
    .select(
      'id,status,invoice_number,pdf_generation_status,issued_at,revision_source_invoice_id,replaces_invoice_id'
    )
    .eq('id', invoiceId)
    .single();

  if (error) {
    // PGRST116: no rows returned — invoice definitively does not exist.
    if (error.code === 'PGRST116') {
      return { outcome: 'NOT_FOUND' };
    }
    // Any other error is a database/query failure — do not collapse with not-found.
    // Log only safe fields: no error.message, no error.details, no error.hint.
    console.error('[invoices/issue] workflow state query failed:', {
      invoiceId,
      code: error.code,
    });
    return { outcome: 'QUERY_FAILED' };
  }

  if (!data) {
    // Defensive: data is null without an error — treat as not found.
    return { outcome: 'NOT_FOUND' };
  }

  return { outcome: 'FOUND', state: data as InvoiceWorkflowState };
}

// ── Strict already-open validator ─────────────────────────────────────────────
// status='open' alone is NOT sufficient for an idempotent success.
// All completion fields must be present and valid.
//
// For Revision invoices (revision_source_invoice_id !== null):
//   Also requires replaces_invoice_id === revision_source_invoice_id.
//   If the Revision relationship is malformed, returns false — do NOT
//   return idempotent success.
//
// Returns true only when the invoice is in a fully-completed open state.

function isValidAlreadyOpenState(state: InvoiceWorkflowState): boolean {
  // status must be 'open'
  if (state.status !== 'open') return false;

  // invoice_number must be a non-empty string
  if (
    typeof state.invoice_number !== 'string' ||
    state.invoice_number.trim() === ''
  ) {
    return false;
  }

  // pdf_generation_status must be 'generated'
  if (state.pdf_generation_status !== 'generated') return false;

  // issued_at must be a non-empty string that parses as a valid timestamp
  if (
    typeof state.issued_at !== 'string' ||
    state.issued_at.trim() === '' ||
    isNaN(new Date(state.issued_at).getTime())
  ) {
    return false;
  }

  // ── Revision-specific relationship validation ─────────────────────────────
  // If this is a Revision invoice, require replaces_invoice_id to equal
  // revision_source_invoice_id. A malformed Revision relationship must NOT
  // return idempotent success.
  if (state.revision_source_invoice_id !== null) {
    // revision_source_invoice_id must be a valid UUID
    if (!UUID_RE.test(state.revision_source_invoice_id)) {
      return false;
    }
    // replaces_invoice_id must equal revision_source_invoice_id
    if (state.replaces_invoice_id !== state.revision_source_invoice_id) {
      return false;
    }
  }

  return true;
}

// ── Stable RPC error token → HTTP status + safe client message ───────────────
// Normal begin_invoice_issuance error map — preserved unchanged.

const RPC_ERROR_MAP: Record<string, { status: number; message: string }> = {
  admin_not_authorized: {
    status: 403,
    message: 'You are not authorized to issue this invoice.',
  },
  invoice_not_found: {
    status: 404,
    message: 'Invoice not found.',
  },
  invoice_not_draft: {
    // Handled specially for concurrency — not returned directly.
    status: 409,
    message: 'This invoice is not a draft and cannot be issued.',
  },
  invoice_type_not_supported: {
    status: 409,
    message: 'This invoice type is not supported for issuance.',
  },
  invoice_draft_stale: {
    status: 409,
    message:
      'The invoice draft is out of date. Refresh or update the draft before issuing.',
  },
  invoice_settings_incomplete: {
    status: 422,
    message: 'Invoice settings are incomplete.',
  },
  invoice_billing_incomplete: {
    status: 422,
    message: 'Billing information is incomplete.',
  },
  invoice_line_items_invalid: {
    status: 422,
    message: 'Invoice line items are not valid for issuance.',
  },
};

// ── Revision begin RPC error token → HTTP status + safe client message ────────
// Separate from the normal RPC_ERROR_MAP — never mixed.
// revision_invoice_not_draft is handled specially for concurrency.

const REVISION_RPC_ERROR_MAP: Record<
  string,
  { status: number; message: string }
> = {
  admin_not_authorized: {
    status: 403,
    message: 'You are not authorized to issue this invoice.',
  },
  revision_invoice_not_found: {
    status: 404,
    message: 'Invoice not found.',
  },
  revision_invoice_not_draft: {
    // Handled specially for concurrency — not returned directly.
    status: 409,
    message: 'This revision invoice is not a draft and cannot be issued.',
  },
  revision_source_ineligible: {
    status: 409,
    message: 'The source invoice is no longer eligible for revision.',
  },
  revision_draft_stale: {
    status: 409,
    message:
      'The revision draft is out of date. Refresh or update the draft before issuing.',
  },
  revision_settings_incomplete: {
    status: 422,
    message: 'Invoice settings are incomplete.',
  },
  revision_billing_incomplete: {
    status: 422,
    message: 'Billing information is incomplete.',
  },
  revision_line_items_invalid: {
    status: 422,
    message: 'Revision invoice line items are not valid for issuance.',
  },
  revision_source_number_invalid: {
    status: 409,
    message: 'The source invoice number is not valid for revision issuance.',
  },
  revision_suffix_exhausted: {
    status: 409,
    message: 'No further revision number is available for this invoice.',
  },
};

// ── Orchestrator error code → HTTP status + safe client message ──────────────

const ORCHESTRATOR_ERROR_MAP: Record<
  string,
  { status: number; error: string }
> = {
  INVOICE_PDF_INVOICE_NOT_FOUND: {
    status: 404,
    error: 'invoice_not_found',
  },
  INVOICE_PDF_INVALID_STATE: {
    status: 409,
    error: 'invoice_invalid_state',
  },
  INVOICE_PDF_RENDER_FAILED: {
    status: 422,
    error: 'invoice_pdf_generation_failed',
  },
  INVOICE_PDF_SNAPSHOT_ERROR: {
    status: 500,
    error: 'invoice_pdf_processing_failed',
  },
  INVOICE_PDF_STORAGE_FAILED: {
    status: 502,
    error: 'invoice_pdf_storage_failed',
  },
  INVOICE_PDF_COMPLETION_FAILED: {
    status: 502,
    error: 'invoice_pdf_completion_failed',
  },
};

// ── Cache-Control header ──────────────────────────────────────────────────────

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

// ── Orchestrator result validation at API boundary ───────────────────────────
// Defense in depth: even though the orchestrator already validates its result,
// we validate again at the API boundary before returning to the caller.
// Strictly requires all fields; fails closed on any mismatch.
// Does NOT expose Revision lineage fields (revision_source_invoice_id,
// replaces_invoice_id) or source invoice details in the HTTP success response.

function validateOrchestratorResult(
  result: OrchestratorSuccessResult,
  invoiceId: string
): boolean {
  return (
    result.invoice_id === invoiceId &&
    typeof result.invoice_number === 'string' &&
    result.invoice_number.trim() !== '' &&
    result.status === 'open' &&
    result.pdf_generation_status === 'generated' &&
    typeof result.issued_at === 'string' &&
    result.issued_at.trim() !== '' &&
    !isNaN(new Date(result.issued_at).getTime()) &&
    Number.isSafeInteger(result.total_cents)
  );
}

// ── Already-open idempotent response ─────────────────────────────────────────
// Returns HTTP 200 with already_issued: true.
// Only includes fields from the safe workflow projection.
// Does NOT expose pdf_storage_path, pdf_hash, wire data, or Revision lineage.

function alreadyOpenResponse(state: InvoiceWorkflowState) {
  return NextResponse.json(
    {
      success: true,
      already_issued: true,
      invoice: {
        id: state.id,
        status: 'open',
        invoice_number: state.invoice_number,
      },
    },
    { status: 200, headers: NO_STORE }
  );
}

// ── Safe responses ────────────────────────────────────────────────────────────

function invoiceNotFoundResponse() {
  return NextResponse.json(
    { success: false, error: 'invoice_not_found' },
    { status: 404, headers: NO_STORE }
  );
}

function invoiceIssueFailedResponse() {
  return NextResponse.json(
    { success: false, error: 'invoice_issue_failed' },
    { status: 500, headers: NO_STORE }
  );
}

// ── POST /api/admin/invoices/[id]/issue ───────────────────────────────────────

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // ── 1. Authenticate Admin ─────────────────────────────────────────────────
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized.' },
      { status: 401, headers: NO_STORE }
    );
  }

  // ── 2. Admin UUID — sourced exclusively from authenticated session ─────────
  // The browser has no ability to choose or influence the Admin UUID passed
  // to any RPC. It is taken directly from the verified auth.users record.
  const adminUserId = admin.id;

  // ── 3. Validate route parameter UUID ─────────────────────────────────────
  const { id: invoiceId } = await params;

  if (!invoiceId || !UUID_RE.test(invoiceId)) {
    return NextResponse.json(
      { success: false, error: 'Invalid invoice ID.' },
      { status: 400, headers: NO_STORE }
    );
  }

  // ── 4. Read current invoice workflow state ────────────────────────────────
  // Minimal safe projection — only what is needed to route the workflow.
  // Does NOT select wire data, billing fields, bank details, or financial
  // snapshot. Includes revision_source_invoice_id and replaces_invoice_id
  // for lifecycle routing only.
  // Distinguishes NOT_FOUND (PGRST116) from QUERY_FAILED (other DB errors).

  const fetchResult = await fetchInvoiceWorkflowState(invoiceId);

  if (fetchResult.outcome === 'NOT_FOUND') {
    return invoiceNotFoundResponse();
  }

  if (fetchResult.outcome === 'QUERY_FAILED') {
    // Do not report a database failure as "Invoice not found."
    return invoiceIssueFailedResponse();
  }

  const initialState = fetchResult.state;

  // ── 5. Route by current invoice status ───────────────────────────────────

  const { status: initialStatus } = initialState;

  // ── 5A. Already open — strict validation before idempotent response ───────
  // status='open' alone is not sufficient. All completion fields must be valid.
  // For Revision invoices, also validates replaces_invoice_id relationship.
  if (initialStatus === 'open') {
    if (isValidAlreadyOpenState(initialState)) {
      return alreadyOpenResponse(initialState);
    }
    // status='open' but completion fields are inconsistent — do NOT proceed.
    // Do NOT call begin, orchestrator, upload, or mark failed.
    console.error('[invoices/issue POST] open invoice has inconsistent completion state:', {
      invoiceId,
      status: initialState.status,
      hasInvoiceNumber:
        typeof initialState.invoice_number === 'string' &&
        initialState.invoice_number.trim() !== '',
      pdfGenerationStatus: initialState.pdf_generation_status,
      hasIssuedAt:
        typeof initialState.issued_at === 'string' &&
        initialState.issued_at.trim() !== '',
      isRevision: initialState.revision_source_invoice_id !== null,
    });
    return NextResponse.json(
      { success: false, error: 'invoice_issue_state_invalid' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── 5B. Non-issuable states ───────────────────────────────────────────────
  if (
    initialStatus === 'partially_paid' ||
    initialStatus === 'paid' ||
    initialStatus === 'void'
  ) {
    return NextResponse.json(
      { success: false, error: 'invoice_not_issuable' },
      { status: 409, headers: NO_STORE }
    );
  }

  // ── 5C. Issuing retry/resume path ─────────────────────────────────────────
  // Do NOT call begin_invoice_issuance or begin_revision_invoice_issuance again.
  // The orchestrator determines the correct completion RPC from
  // revision_source_invoice_id.
  if (initialStatus === 'issuing') {
    return await runIssuingRetry(invoiceId, adminUserId, initialState);
  }

  // ── 5D. Draft path ────────────────────────────────────────────────────────
  if (initialStatus === 'draft') {
    return await runDraftPath(invoiceId, adminUserId, initialState);
  }

  // ── 5E. Unknown status ────────────────────────────────────────────────────
  console.error('[invoices/issue POST] unexpected invoice status:', {
    invoiceId,
    status: initialStatus,
  });
  return NextResponse.json(
    { success: false, error: 'invoice_not_issuable' },
    { status: 409, headers: NO_STORE }
  );
}

// ── Issuing retry/resume path ─────────────────────────────────────────────────
// Validates minimum retry preconditions before calling orchestrator.
// For Revision issuing invoices, also validates Revision-specific fields.
// The orchestrator re-fetches and determines the correct completion RPC.

async function runIssuingRetry(
  invoiceId: string,
  adminUserId: string,
  state: InvoiceWorkflowState
): Promise<NextResponse> {
  const hasInvoiceNumber =
    typeof state.invoice_number === 'string' &&
    state.invoice_number.trim() !== '';
  const hasRetryablePdfStatus =
    state.pdf_generation_status === 'pending' ||
    state.pdf_generation_status === 'failed';
  const isNotYetIssued = state.issued_at === null;

  if (!hasInvoiceNumber || !hasRetryablePdfStatus || !isNotYetIssued) {
    console.error('[invoices/issue POST] issuing retry precondition failure:', {
      invoiceId,
      hasInvoiceNumber,
      hasRetryablePdfStatus,
      isNotYetIssued,
    });
    return NextResponse.json(
      { success: false, error: 'invoice_invalid_state' },
      { status: 409, headers: NO_STORE }
    );
  }

  // ── Revision issuing retry — additional relationship guards ───────────────
  if (state.revision_source_invoice_id !== null) {
    // revision_source_invoice_id must be a valid UUID
    if (!UUID_RE.test(state.revision_source_invoice_id)) {
      console.error('[invoices/issue POST] issuing Revision has invalid revision_source_invoice_id UUID:', {
        invoiceId,
      });
      return NextResponse.json(
        { success: false, error: 'invoice_invalid_state' },
        { status: 409, headers: NO_STORE }
      );
    }

    // replaces_invoice_id must still be null for an issuing Revision
    if (state.replaces_invoice_id !== null) {
      console.error('[invoices/issue POST] issuing Revision already has replaces_invoice_id set:', {
        invoiceId,
      });
      return NextResponse.json(
        { success: false, error: 'invoice_invalid_state' },
        { status: 409, headers: NO_STORE }
      );
    }
  }

  return await runOrchestrator(invoiceId, adminUserId);
}

// ── Draft path: route to normal or Revision begin ────────────────────────────
// Normal draft  (revision_source_invoice_id === null):
//   → begin_invoice_issuance()
// Revision draft (revision_source_invoice_id !== null):
//   → begin_revision_invoice_issuance()
//
// The two paths are mutually exclusive — a Revision draft NEVER calls
// begin_invoice_issuance, and a normal draft NEVER calls
// begin_revision_invoice_issuance.

async function runDraftPath(
  invoiceId: string,
  adminUserId: string,
  initialState: InvoiceWorkflowState
): Promise<NextResponse> {
  const isRevision = initialState.revision_source_invoice_id !== null;

  if (isRevision) {
    return await runRevisionDraftPath(invoiceId, adminUserId, initialState);
  }

  return await runNormalDraftPath(invoiceId, adminUserId);
}

// ── Normal draft begin path ───────────────────────────────────────────────────

async function runNormalDraftPath(
  invoiceId: string,
  adminUserId: string
): Promise<NextResponse> {
  const supabase = getServiceClient();

  // ── Call begin_invoice_issuance via service-role RPC ─────────────────────
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'begin_invoice_issuance',
    {
      p_invoice_id: invoiceId,
      p_admin_user_id: adminUserId,
    }
  );

  // ── Handle RPC errors ─────────────────────────────────────────────────────
  if (rpcError) {
    const token = rpcError.message?.trim() ?? '';

    // ── invoice_not_draft: concurrency reconciliation ─────────────────────
    // Request A and B both read draft. A succeeded. B now gets invoice_not_draft.
    // Do NOT immediately return 409 — re-fetch and route safely.
    // Mode = normal: revision_source_invoice_id must remain null.
    if (token === 'invoice_not_draft') {
      return await reconcileDraftConcurrency(invoiceId, adminUserId, 'normal', null);
    }

    const mapped = RPC_ERROR_MAP[token];
    if (mapped) {
      return NextResponse.json(
        { success: false, error: mapped.message },
        { status: mapped.status, headers: NO_STORE }
      );
    }

    // Unrecognized error — log only safe metadata. Never log raw message.
    console.error('[invoices/issue POST] unexpected begin_invoice_issuance error:', {
      code: rpcError.code ?? 'unknown',
      invoiceId,
    });

    return NextResponse.json(
      { success: false, error: 'Unable to begin invoice issuance.' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── Validate begin_invoice_issuance success contract ─────────────────────
  // Do NOT fabricate defaults. Fail closed if the response is malformed.
  // Do NOT call continueInvoicePdfIssuance if the contract is not met —
  // issuance state is uncertain.

  const row = rpcData as Record<string, unknown> | null;

  const contractValid =
    row !== null &&
    !Array.isArray(row) &&
    row.invoice_id === invoiceId &&
    row.status === 'issuing' &&
    typeof row.invoice_number === 'string' &&
    row.invoice_number.trim() !== '' &&
    typeof row.issuing_started_at === 'string' &&
    row.issuing_started_at.trim() !== '' &&
    !isNaN(new Date(row.issuing_started_at as string).getTime()) &&
    row.pdf_generation_status === 'pending' &&
    Number.isSafeInteger(row.subtotal_cents) &&
    Number.isSafeInteger(row.discount_cents) &&
    Number.isSafeInteger(row.tax_cents) &&
    Number.isSafeInteger(row.total_cents) &&
    typeof row.due_date === 'string' &&
    row.due_date.trim() !== '';

  if (!contractValid) {
    console.error('[invoices/issue POST] begin_invoice_issuance contract failure:', {
      invoiceId,
      reason: 'contract-failure',
    });
    // Do NOT call orchestrator — issuance state is uncertain.
    return NextResponse.json(
      { success: false, error: 'Unable to begin invoice issuance.' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── Contract validated — proceed to PDF generation ────────────────────────
  return await runOrchestrator(invoiceId, adminUserId);
}

// ── Revision draft begin path ─────────────────────────────────────────────────
// Revision lifecycle is determined ONLY by revision_source_invoice_id !== null.
// Before calling begin_revision_invoice_issuance, validate:
//   - revision_source_invoice_id passes UUID_RE
//   - replaces_invoice_id === null  (not yet linked)
//   - invoice_number === null       (not yet assigned)
// If not, return safe 409 invoice_invalid_state.

async function runRevisionDraftPath(
  invoiceId: string,
  adminUserId: string,
  initialState: InvoiceWorkflowState
): Promise<NextResponse> {
  const { revision_source_invoice_id, replaces_invoice_id, invoice_number } =
    initialState;

  // revision_source_invoice_id must be a valid UUID
  if (
    typeof revision_source_invoice_id !== 'string' ||
    !UUID_RE.test(revision_source_invoice_id)
  ) {
    console.error('[invoices/issue POST] Revision draft has invalid revision_source_invoice_id:', {
      invoiceId,
    });
    return NextResponse.json(
      { success: false, error: 'invoice_invalid_state' },
      { status: 409, headers: NO_STORE }
    );
  }

  // replaces_invoice_id must be null — Revision draft must not yet be linked
  if (replaces_invoice_id !== null) {
    console.error('[invoices/issue POST] Revision draft already has replaces_invoice_id set:', {
      invoiceId,
    });
    return NextResponse.json(
      { success: false, error: 'invoice_invalid_state' },
      { status: 409, headers: NO_STORE }
    );
  }

  // invoice_number must be null — Revision draft must not yet have a number
  if (invoice_number !== null) {
    console.error('[invoices/issue POST] Revision draft already has invoice_number set:', {
      invoiceId,
    });
    return NextResponse.json(
      { success: false, error: 'invoice_invalid_state' },
      { status: 409, headers: NO_STORE }
    );
  }

  const supabase = getServiceClient();

  // ── Call begin_revision_invoice_issuance via service-role RPC ────────────
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'begin_revision_invoice_issuance',
    {
      p_invoice_id: invoiceId,
      p_admin_user_id: adminUserId,
    }
  );

  // ── Handle RPC errors ─────────────────────────────────────────────────────
  if (rpcError) {
    const token = rpcError.message?.trim() ?? '';

    // ── revision_invoice_not_draft: concurrency reconciliation ────────────
    // Request A and B both read Revision draft. A succeeded. B gets this.
    // Do NOT immediately return 409 — re-fetch and route safely.
    // Mode = revision: preserve expected revision_source_invoice_id.
    if (token === 'revision_invoice_not_draft') {
      return await reconcileDraftConcurrency(
        invoiceId,
        adminUserId,
        'revision',
        revision_source_invoice_id
      );
    }

    const mapped = REVISION_RPC_ERROR_MAP[token];
    if (mapped) {
      return NextResponse.json(
        { success: false, error: mapped.message },
        { status: mapped.status, headers: NO_STORE }
      );
    }

    // Unrecognized error — log only safe metadata. Never log raw message.
    console.error('[invoices/issue POST] unexpected begin_revision_invoice_issuance error:', {
      code: rpcError.code ?? 'unknown',
      invoiceId,
    });

    return NextResponse.json(
      { success: false, error: 'Unable to begin revision invoice issuance.' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── Validate begin_revision_invoice_issuance success contract ────────────
  // Strictly validate the returned JSONB before calling the orchestrator.
  // Do NOT fabricate defaults. Fail closed if the contract is malformed.
  // Do NOT call the orchestrator if the contract is not met.

  const row = rpcData as Record<string, unknown> | null;

  const isRevisionContractValid = validateRevisionBeginContract(
    row,
    invoiceId,
    revision_source_invoice_id
  );

  if (!isRevisionContractValid) {
    console.error('[invoices/issue POST] begin_revision_invoice_issuance contract failure:', {
      invoiceId,
      reason: 'revision-contract-failure',
    });
    // Do NOT call orchestrator — issuance state is uncertain.
    return NextResponse.json(
      { success: false, error: 'Unable to begin revision invoice issuance.' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── Contract validated — proceed to PDF generation ────────────────────────
  // The orchestrator re-fetches the invoice and detects Revision mode from
  // revision_source_invoice_id. Do NOT pass lifecycle mode manually.
  return await runOrchestrator(invoiceId, adminUserId);
}

// ── Revision begin success contract validator ─────────────────────────────────
// Strictly validates the JSONB returned by begin_revision_invoice_issuance.
// Returns true only when all required fields are present and correct.
// Do NOT calculate financial totals in TypeScript.
// Do NOT fabricate defaults.

function validateRevisionBeginContract(
  row: Record<string, unknown> | null,
  invoiceId: string,
  expectedRevisionSourceInvoiceId: string
): boolean {
  // row must be a non-null, non-array object
  if (row === null || row === undefined || Array.isArray(row)) {
    return false;
  }

  // invoice_id must match
  if (row.invoice_id !== invoiceId) return false;

  // status must be 'issuing'
  if (row.status !== 'issuing') return false;

  // invoice_number must be a non-empty string
  if (
    typeof row.invoice_number !== 'string' ||
    row.invoice_number.trim() === ''
  ) {
    return false;
  }

  // revision_source_invoice_id must match the expected value
  if (row.revision_source_invoice_id !== expectedRevisionSourceInvoiceId) {
    return false;
  }

  // source_invoice_number must be a non-empty string
  if (
    typeof row.source_invoice_number !== 'string' ||
    row.source_invoice_number.trim() === ''
  ) {
    return false;
  }

  // issuing_started_at must be a non-empty valid timestamp string
  if (
    typeof row.issuing_started_at !== 'string' ||
    row.issuing_started_at.trim() === '' ||
    isNaN(new Date(row.issuing_started_at as string).getTime())
  ) {
    return false;
  }

  // due_date must be a non-empty YYYY-MM-DD string
  if (
    typeof row.due_date !== 'string' ||
    row.due_date.trim() === '' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.due_date)
  ) {
    return false;
  }

  // pdf_generation_status must be 'pending'
  if (row.pdf_generation_status !== 'pending') return false;

  // subtotal_cents: safe integer >= 0
  if (
    !Number.isSafeInteger(row.subtotal_cents) ||
    (row.subtotal_cents as number) < 0
  ) {
    return false;
  }

  // discount_cents: safe integer >= 0
  if (
    !Number.isSafeInteger(row.discount_cents) ||
    (row.discount_cents as number) < 0
  ) {
    return false;
  }

  // tax_cents: safe integer === 0 (Revision invoices have no tax)
  if (
    !Number.isSafeInteger(row.tax_cents) ||
    (row.tax_cents as number) !== 0
  ) {
    return false;
  }

  // total_cents: safe integer >= 0
  if (
    !Number.isSafeInteger(row.total_cents) ||
    (row.total_cents as number) < 0
  ) {
    return false;
  }

  return true;
}

// ── Mode-aware draft concurrency reconciliation ───────────────────────────────
// Called when begin_invoice_issuance returns 'invoice_not_draft' (normal mode)
// or begin_revision_invoice_issuance returns 'revision_invoice_not_draft'
// (revision mode).
//
// Re-fetches the safe workflow state and routes accordingly.
// Never calls either begin RPC again.
// Uses strict already-open validation for the open case.
//
// For revision mode:
//   - Requires refetched.revision_source_invoice_id === expectedRevisionSourceInvoiceId
//   - Issuing: requires replaces_invoice_id === null
//   - Open: requires replaces_invoice_id === revision_source_invoice_id
//
// For normal mode:
//   - Requires refetched.revision_source_invoice_id === null
//   - Prevents accidentally resuming an invoice that changed lifecycle mode.

async function reconcileDraftConcurrency(
  invoiceId: string,
  adminUserId: string,
  mode: 'normal\' | \'revision',
  expectedRevisionSourceInvoiceId: string | null
): Promise<NextResponse> {
  const fetchResult = await fetchInvoiceWorkflowState(invoiceId);

  if (fetchResult.outcome === 'NOT_FOUND') {
    return invoiceNotFoundResponse();
  }

  if (fetchResult.outcome === 'QUERY_FAILED') {
    return invoiceIssueFailedResponse();
  }

  const refetchedState = fetchResult.state;
  const {
    status,
    invoice_number,
    pdf_generation_status,
    issued_at,
    revision_source_invoice_id: refetchedRevisionSourceId,
    replaces_invoice_id: refetchedReplacesId,
  } = refetchedState;

  // ── Mode guard: ensure lifecycle mode has not changed ────────────────────
  // Normal: revision_source_invoice_id must remain null.
  // Revision: revision_source_invoice_id must match the expected value.
  if (mode === 'normal') {
    if (refetchedRevisionSourceId !== null) {
      // Invoice has changed lifecycle mode — fail closed.
      console.error('[invoices/issue POST] concurrency: normal invoice now has revision_source_invoice_id:', {
        invoiceId,
      });
      return NextResponse.json(
        { success: false, error: 'invoice_not_issuable' },
        { status: 409, headers: NO_STORE }
      );
    }
  } else {
    // mode === 'revision'
    if (refetchedRevisionSourceId !== expectedRevisionSourceInvoiceId) {
      // Revision source ID has changed or is missing — fail closed.
      console.error('[invoices/issue POST] concurrency: Revision invoice revision_source_invoice_id mismatch:', {
        invoiceId,
      });
      return NextResponse.json(
        { success: false, error: 'invoice_not_issuable' },
        { status: 409, headers: NO_STORE }
      );
    }
  }

  // ── Concurrent issuing — resume via orchestrator ──────────────────────────
  if (status === 'issuing') {
    const hasInvoiceNumber =
      typeof invoice_number === 'string' && invoice_number.trim() !== '';
    const isNotYetIssued = issued_at === null;
    const hasRetryablePdfStatus =
      pdf_generation_status === 'pending' || pdf_generation_status === 'failed';

    if (!hasInvoiceNumber || !isNotYetIssued || !hasRetryablePdfStatus) {
      console.error('[invoices/issue POST] concurrency: issuing invoice failed retry preconditions:', {
        invoiceId,
        mode,
        hasInvoiceNumber,
        isNotYetIssued,
        hasRetryablePdfStatus,
      });
      return NextResponse.json(
        { success: false, error: 'invoice_not_issuable' },
        { status: 409, headers: NO_STORE }
      );
    }

    // ── Revision issuing concurrency: replaces_invoice_id must be null ───
    if (mode === 'revision' && refetchedReplacesId !== null) {
      console.error('[invoices/issue POST] concurrency: Revision issuing already has replaces_invoice_id:', {
        invoiceId,
      });
      return NextResponse.json(
        { success: false, error: 'invoice_not_issuable' },
        { status: 409, headers: NO_STORE }
      );
    }

    return await runOrchestrator(invoiceId, adminUserId);
  }

  // ── Already open — strict validation before idempotent response ───────────
  // Same strict validator as the initial open check.
  // For Revision open: also requires replaces_invoice_id === revision_source_invoice_id.
  if (status === 'open') {
    if (isValidAlreadyOpenState(refetchedState)) {
      // For Revision open: additionally verify replaces_invoice_id relationship
      if (mode === 'revision') {
        if (refetchedReplacesId !== expectedRevisionSourceInvoiceId) {
          console.error('[invoices/issue POST] concurrency: Revision OPEN replaces_invoice_id mismatch:', {
            invoiceId,
          });
          return NextResponse.json(
            { success: false, error: 'invoice_issue_state_invalid' },
            { status: 500, headers: NO_STORE }
          );
        }
      }
      return alreadyOpenResponse(refetchedState);
    }
    // status='open' but completion fields are inconsistent.
    console.error('[invoices/issue POST] concurrency: open invoice has inconsistent completion state:', {
      invoiceId,
      mode,
      status: refetchedState.status,
      hasInvoiceNumber:
        typeof refetchedState.invoice_number === 'string' &&
        refetchedState.invoice_number.trim() !== '',
      pdfGenerationStatus: refetchedState.pdf_generation_status,
      hasIssuedAt:
        typeof refetchedState.issued_at === 'string' &&
        refetchedState.issued_at.trim() !== '',
    });
    return NextResponse.json(
      { success: false, error: 'invoice_issue_state_invalid' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── Any other state — safe 409 ────────────────────────────────────────────
  console.error('[invoices/issue POST] concurrency: unexpected state:', {
    invoiceId,
    mode,
    status,
  });
  return NextResponse.json(
    { success: false, error: 'invoice_not_issuable' },
    { status: 409, headers: NO_STORE }
  );
}

// ── INVOICE_PDF_INVALID_STATE race reconciliation ─────────────────────────────
// When the orchestrator returns INVOICE_PDF_INVALID_STATE, it may be because
// a concurrent request completed issuance (issuing → open) while this request
// was in-flight. Re-fetch and check if the invoice is now validly open.
//
// Only INVOICE_PDF_INVALID_STATE gets this treatment.
// Render, storage, completion, and snapshot failures do NOT.

async function reconcileInvalidStateError(
  invoiceId: string
): Promise<NextResponse> {
  const fetchResult = await fetchInvoiceWorkflowState(invoiceId);

  if (fetchResult.outcome === 'NOT_FOUND') {
    return invoiceNotFoundResponse();
  }

  if (fetchResult.outcome === 'QUERY_FAILED') {
    return invoiceIssueFailedResponse();
  }

  const state = fetchResult.state;

  // If the invoice is now in a valid already-open state, the concurrent
  // request completed successfully — return already_issued.
  if (isValidAlreadyOpenState(state)) {
    return alreadyOpenResponse(state);
  }

  // Invoice is still issuing or in another state — preserve the 409 mapping.
  console.error('[invoices/issue POST] INVOICE_PDF_INVALID_STATE reconciliation: invoice not validly open:', {
    invoiceId,
    status: state.status,
    pdfGenerationStatus: state.pdf_generation_status,
    hasInvoiceNumber:
      typeof state.invoice_number === 'string' &&
      state.invoice_number.trim() !== '',
    hasIssuedAt:
      typeof state.issued_at === 'string' && state.issued_at.trim() !== '',
  });
  return NextResponse.json(
    { success: false, error: 'invoice_invalid_state' },
    { status: 409, headers: NO_STORE }
  );
}

// ── Orchestrator runner + response builder ────────────────────────────────────
// Calls continueInvoicePdfIssuance and maps its result/errors to HTTP responses.
// Validates the orchestrator result at the API boundary (defense in depth).
// Does NOT return wire data, pdf_storage_path, pdf_hash, PDF bytes, or
// Revision lineage fields (revision_source_invoice_id, replaces_invoice_id).
//
// The orchestrator re-fetches the invoice and detects Revision mode internally
// from revision_source_invoice_id. Do NOT pass lifecycle mode manually.
//
// Special handling for INVOICE_PDF_INVALID_STATE:
//   Re-fetch invoice state to check for issuing→open race before returning 409.
//
// EMAIL DISPATCH:
//   After a NEWLY COMPLETED issuance (not already_issued), dispatchInvoiceEmail
//   is called with the issued invoice ID and admin user ID. Email failure NEVER
//   affects the HTTP 200 invoice success response — invoice issuance is already
//   committed before email delivery begins.

async function runOrchestrator(
  invoiceId: string,
  adminUserId: string
): Promise<NextResponse> {
  let result: OrchestratorSuccessResult;

  try {
    result = await continueInvoicePdfIssuance(invoiceId, adminUserId);
  } catch (err) {
    if (err instanceof InvoicePdfOrchestratorError) {
      // Log only safe identifiers — never log err.message.
      console.error('[invoices/issue POST] orchestrator error:', {
        invoiceId,
        code: err.code,
      });

      // ── INVOICE_PDF_INVALID_STATE: check for issuing→open race ───────────
      // A concurrent request may have completed issuance between when this
      // request read status='issuing' and when the orchestrator ran.
      // Re-fetch to determine if the invoice is now validly open.
      // Only this specific error code gets this reconciliation.
      if (err.code === 'INVOICE_PDF_INVALID_STATE') {
        return await reconcileInvalidStateError(invoiceId);
      }

      const mapped = ORCHESTRATOR_ERROR_MAP[err.code];
      if (mapped) {
        return NextResponse.json(
          { success: false, error: mapped.error },
          { status: mapped.status, headers: NO_STORE }
        );
      }
    } else {
      console.error('[invoices/issue POST] orchestrator threw unknown error:', {
        invoiceId,
      });
    }

    return NextResponse.json(
      { success: false, error: 'invoice_issue_failed' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── Validate orchestrator result at API boundary (defense in depth) ───────
  if (!validateOrchestratorResult(result, invoiceId)) {
    console.error('[invoices/issue POST] orchestrator result failed API boundary validation:', {
      invoiceId,
    });
    return NextResponse.json(
      { success: false, error: 'invoice_issue_failed' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── Attempt automatic email delivery ─────────────────────────────────────
  // Invoice issuance is already committed at this point. Email dispatch is a
  // post-commit secondary action. ANY email outcome (including thrown errors)
  // must NOT roll back issuance, change invoice status, or return a non-200
  // response. The invoice success response is always HTTP 200.
  //
  // dispatchInvoiceEmail is called ONLY here — after a newly completed
  // issuance. It is NEVER called from the already_issued short-circuit path.
  // For Revision invoices, result.invoice_id is the newly issued revision
  // invoice — never the superseded source invoice.

  type EmailDeliveryResult = {
    attempted: boolean;
    outcome: 'sent' | 'already_sent' | 'currently_sending' | 'failed' | 'uncertain' | 'error';
    delivery_id: string | null;
    error_code: string | null;
  };

  let emailDelivery: EmailDeliveryResult;

  try {
    const emailResult = await dispatchInvoiceEmail({
      invoiceId: result.invoice_id,
      adminUserId,
    });

    emailDelivery = {
      attempted: true,
      outcome: emailResult.outcome,
      delivery_id: emailResult.deliveryId ?? null,
      error_code: emailResult.errorCode ?? null,
    };
  } catch (emailErr) {
    // Email dispatch threw — determine safe error code.
    // NEVER roll back invoice. NEVER return non-200.
    // Log only safe fields: invoiceId and safe error code.
    const safeCode =
      emailErr instanceof InvoiceEmailDispatchError
        ? emailErr.code
        : 'INVOICE_EMAIL_DISPATCH_ERROR';

    console.error('[invoices/issue POST] email dispatch error after successful issuance:', {
      invoiceId: result.invoice_id,
      errorCode: safeCode,
    });

    emailDelivery = {
      attempted: true,
      outcome: 'error',
      delivery_id: null,
      error_code: safeCode,
    };
  }

  // ── Return safe success response ──────────────────────────────────────────
  // Does NOT include: wire data, pdf_storage_path, pdf_hash, PDF bytes,
  // revision_source_invoice_id, replaces_invoice_id, or source invoice data.
  // Does NOT include: recipient email, provider message ID, Resend payloads,
  // raw error messages, or any secrets.
  return NextResponse.json(
    {
      success: true,
      already_issued: false,
      invoice: {
        id: result.invoice_id,
        invoice_number: result.invoice_number,
        status: result.status,
        issued_at: result.issued_at,
        pdf_generation_status: result.pdf_generation_status,
        total_cents: result.total_cents,
      },
      email_delivery: emailDelivery,
    },
    { status: 200, headers: NO_STORE }
  );
}
