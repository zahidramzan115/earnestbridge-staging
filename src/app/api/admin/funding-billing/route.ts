import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Funding & Billing API
// GET  /api/admin/funding-billing?application_id=xxx
// PATCH /api/admin/funding-billing
//
// SECURITY MODEL:
//   1. Authenticates the session via SSR Supabase client
//   2. Verifies the caller is an EarnestBridge Admin
//      (app_metadata.role === 'admin')
//   3. Performs a narrowly scoped read/update using service_role
//   4. Only accepts/returns the three funding/billing fields:
//      - emd_funded_cents (BIGINT)
//      - funded_date (DATE)
//      - credit_card_payment_enabled (BOOLEAN)
//   5. GET also returns the original deposit_goes_hard_date
//      from crm_deal_option_cycles where cycle_number = 1
//
// Service-role credentials are NEVER exposed to the browser.
// ============================================================

// ── UUID v4 validation regex ──────────────────────────────────────────────────
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getAuthClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// ── Draft refresh safe status type ───────────────────────────────────────────

type DraftRefreshStatus = 'refreshed' | 'no_draft' | 'no_longer_draft' | 'failed';

// Whitelisted stable RPC error tokens
const KNOWN_REFRESH_ERROR_TOKENS = new Set([
  'admin_not_authorized',
  'draft_refresh_ambiguous',
  'draft_refresh_source_invalid',
  'draft_refresh_line_items_invalid',
]);

// ── Strict RPC result validator ───────────────────────────────────────────────

function validateRefreshResult(
  result: unknown,
  applicationId: string
): DraftRefreshStatus {
  // Must be a non-null, non-array object
  if (
    result === null ||
    result === undefined ||
    typeof result !== 'object' ||
    Array.isArray(result)
  ) {
    return 'failed';
  }

  const r = result as Record<string, unknown>;

  // application_id must match
  if (r.application_id !== applicationId) {
    return 'failed';
  }

  const status = r.status;

  if (status === 'no_draft') {
    return 'no_draft';
  }

  if (status === 'no_longer_draft') {
    // Require invoice_id as non-empty string
    if (typeof r.invoice_id !== 'string' || r.invoice_id.trim() === '') {
      return 'failed';
    }
    return 'no_longer_draft';
  }

  if (status === 'refreshed') {
    // Require all financial fields
    if (typeof r.invoice_id !== 'string' || r.invoice_id.trim() === '') return 'failed';
    if (!Number.isSafeInteger(r.emd_funded_cents)) return 'failed';
    if (typeof r.funding_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.funding_date)) return 'failed';
    if (typeof r.period_start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.period_start_date)) return 'failed';
    if (typeof r.period_end_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.period_end_date)) return 'failed';
    if (!Number.isSafeInteger(r.billable_days)) return 'failed';
    if (!Number.isSafeInteger(r.subtotal_cents)) return 'failed';
    if (!Number.isSafeInteger(r.discount_cents)) return 'failed';
    if (!Number.isSafeInteger(r.tax_cents)) return 'failed';
    if (!Number.isSafeInteger(r.total_cents)) return 'failed';
    return 'refreshed';
  }

  // Unknown status
  return 'failed';
}

// ── Draft refresh follow-on action ───────────────────────────────────────────

async function callDraftRefresh(
  supabase: ReturnType<typeof getServiceClient>,
  applicationId: string,
  adminUserId: string,
  routeName: string
): Promise<DraftRefreshStatus> {
  try {
    const { data, error } = await supabase.rpc(
      'refresh_initial_draft_invoice_snapshot',
      {
        p_application_id: applicationId,
        p_admin_user_id: adminUserId,
      }
    );

    if (error) {
      const token = error.message ?? '';
      if (KNOWN_REFRESH_ERROR_TOKENS.has(token)) {
        console.error(
          `[${routeName}] draft refresh known error:`,
          { applicationId, token, code: error.code ?? 'unknown' }
        );
      } else {
        console.error(
          `[${routeName}] draft refresh error:`,
          { applicationId, code: error.code ?? 'unknown' }
        );
      }
      return 'failed';
    }

    return validateRefreshResult(data, applicationId);
  } catch {
    console.error(`[${routeName}] draft refresh unexpected failure:`, { applicationId });
    return 'failed';
  }
}

// ── Revision Draft refresh types and helpers ──────────────────────────────────

type RevisionDraftRefreshStatus = 'refreshed' | 'no_revision_draft' | 'failed';

// Whitelisted stable RPC error tokens for revision refresh
const KNOWN_REVISION_REFRESH_ERROR_TOKENS = new Set([
  'admin_not_authorized',
  'revision_draft_not_found',
  'revision_draft_not_eligible',
  'revision_source_ineligible',
  'revision_refresh_source_invalid',
  'revision_refresh_line_items_invalid',
]);

/**
 * Strictly validates a successful refresh_revision_draft_invoice_snapshot() response.
 * Returns true only if all required fields are present and well-formed.
 * Malformed responses count as refresh failure.
 *
 * @param result                         - raw RPC response
 * @param revisionInvoiceId              - the Revision Draft id we requested
 * @param expectedRevisionSourceInvoiceId - the revision_source_invoice_id from the
 *                                          discovery row; must be a valid UUID before
 *                                          this function is called
 * @param applicationId                  - current application id
 */
function validateRevisionRefreshResult(
  result: unknown,
  revisionInvoiceId: string,
  expectedRevisionSourceInvoiceId: string,
  applicationId: string
): boolean {
  if (
    result === null ||
    result === undefined ||
    typeof result !== 'object' ||
    Array.isArray(result)
  ) {
    return false;
  }

  const r = result as Record<string, unknown>;

  // status must be 'refreshed'
  if (r.status !== 'refreshed') return false;

  // invoice_id must match the requested Revision Draft id
  if (r.invoice_id !== revisionInvoiceId) return false;

  // revision_source_invoice_id must exactly match the discovered row's value
  if (r.revision_source_invoice_id !== expectedRevisionSourceInvoiceId) return false;

  // application_id must match current application_id
  if (r.application_id !== applicationId) return false;

  // emd_funded_cents must be a safe integer >= 0
  if (!Number.isSafeInteger(r.emd_funded_cents) || (r.emd_funded_cents as number) < 0) return false;

  // funding_date must be YYYY-MM-DD
  if (
    typeof r.funding_date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.funding_date)
  ) {
    return false;
  }

  // period_start_date must be YYYY-MM-DD
  if (
    typeof r.period_start_date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.period_start_date)
  ) {
    return false;
  }

  // period_end_date must be YYYY-MM-DD
  if (
    typeof r.period_end_date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.period_end_date)
  ) {
    return false;
  }

  // billable_days must be a safe integer >= 0
  if (!Number.isSafeInteger(r.billable_days) || (r.billable_days as number) < 0) return false;

  // subtotal_cents must be a safe integer >= 0
  if (!Number.isSafeInteger(r.subtotal_cents) || (r.subtotal_cents as number) < 0) return false;

  // discount_cents must be a safe integer >= 0
  if (!Number.isSafeInteger(r.discount_cents) || (r.discount_cents as number) < 0) return false;

  // tax_cents must be a safe integer and exactly 0
  if (!Number.isSafeInteger(r.tax_cents) || r.tax_cents !== 0) return false;

  // total_cents must be a safe integer >= 0
  if (!Number.isSafeInteger(r.total_cents) || (r.total_cents as number) < 0) return false;

  return true;
}

/**
 * Discovers qualifying Revision Drafts for the given application_id and calls
 * refresh_revision_draft_invoice_snapshot() for each one.
 *
 * Qualifying criteria (ALL must be true):
 *   application_id = current application_id
 *   invoice_type   = 'initial'
 *   status         = 'draft'
 *   revision_source_invoice_id IS NOT NULL
 *   replaces_invoice_id IS NULL
 *
 * Best-effort: primary save is never rolled back due to refresh failure.
 * Returns 'no_revision_draft' if none found, 'refreshed' if all succeed,
 * 'failed' if any fail.
 */
async function discoverAndRefreshRevisionDrafts(
  supabase: ReturnType<typeof getServiceClient>,
  applicationId: string,
  adminUserId: string,
  routeName: string
): Promise<RevisionDraftRefreshStatus> {
  try {
    // Discover qualifying Revision Drafts — minimum fields only
    const { data: revisionDrafts, error: discoveryError } = await supabase
      .from('crm_invoices')
      .select('id, revision_source_invoice_id')
      .eq('application_id', applicationId)
      .eq('invoice_type', 'initial')
      .eq('status', 'draft')
      .not('revision_source_invoice_id', 'is', null)
      .is('replaces_invoice_id', null);

    if (discoveryError) {
      console.error(`[${routeName}] revision draft discovery error:`, {
        applicationId,
        code: discoveryError.code ?? 'unknown',
      });
      return 'failed';
    }

    if (!revisionDrafts || revisionDrafts.length === 0) {
      return 'no_revision_draft';
    }

    // Refresh each qualifying Revision Draft
    let allSucceeded = true;

    for (const draft of revisionDrafts) {
      const revisionInvoiceId: string = draft.id;

      // Guard: id must be a valid UUID
      if (!UUID_RE.test(revisionInvoiceId)) {
        console.error(`[${routeName}] revision draft has invalid id:`, {
          applicationId,
        });
        allSucceeded = false;
        continue;
      }

      // Guard: revision_source_invoice_id must be a valid UUID before calling the RPC
      const revisionSourceInvoiceId: string = draft.revision_source_invoice_id ?? '';
      if (!UUID_RE.test(revisionSourceInvoiceId)) {
        console.error(`[${routeName}] revision draft has invalid revision_source_invoice_id:`, {
          applicationId,
          revisionInvoiceId,
        });
        allSucceeded = false;
        continue;
      }

      try {
        const { data: rpcResult, error: rpcError } = await supabase.rpc(
          'refresh_revision_draft_invoice_snapshot',
          {
            p_invoice_id: revisionInvoiceId,
            p_admin_user_id: adminUserId,
          }
        );

        if (rpcError) {
          const token = rpcError.message ?? '';
          if (KNOWN_REVISION_REFRESH_ERROR_TOKENS.has(token)) {
            console.error(`[${routeName}] revision draft refresh known error:`, {
              applicationId,
              revisionInvoiceId,
              token,
              code: rpcError.code ?? 'unknown',
            });
          } else {
            console.error(`[${routeName}] revision draft refresh error:`, {
              applicationId,
              revisionInvoiceId,
              code: rpcError.code ?? 'unknown',
            });
          }
          allSucceeded = false;
          continue;
        }

        // Strictly validate the RPC response — thread in the discovered source id
        const isValid = validateRevisionRefreshResult(
          rpcResult,
          revisionInvoiceId,
          revisionSourceInvoiceId,
          applicationId
        );

        if (!isValid) {
          console.error(`[${routeName}] revision draft refresh response failed validation:`, {
            applicationId,
            revisionInvoiceId,
          });
          allSucceeded = false;
        }
      } catch {
        console.error(`[${routeName}] revision draft refresh unexpected failure:`, {
          applicationId,
          revisionInvoiceId,
        });
        allSucceeded = false;
      }
    }

    return allSucceeded ? 'refreshed' : 'failed';
  } catch {
    console.error(`[${routeName}] revision draft discovery unexpected failure:`, {
      applicationId,
    });
    return 'failed';
  }
}

// ── GET /api/admin/funding-billing?application_id=xxx ────────────────────────

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const applicationId = searchParams.get('application_id');
  if (!applicationId) {
    return NextResponse.json({ error: 'application_id is required.' }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Fetch the three funding/billing fields + deposit_amount (read-only reference)
  const { data: app, error: appError } = await supabase
    .from('borrower_applications')
    .select('id, emd_funded_cents, funded_date, credit_card_payment_enabled, deposit_amount')
    .eq('id', applicationId)
    .is('purged_at', null)
    .single();

  if (appError || !app) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  // Fetch original hard date from cycle_number = 1
  const { data: cycle } = await supabase
    .from('crm_deal_option_cycles')
    .select('deposit_goes_hard_date')
    .eq('application_id', applicationId)
    .eq('cycle_number', 1)
    .maybeSingle();

  return NextResponse.json({
    emd_funded_cents: app.emd_funded_cents ?? null,
    funded_date: app.funded_date ?? null,
    credit_card_payment_enabled: app.credit_card_payment_enabled ?? false,
    deposit_amount: app.deposit_amount ?? null,
    original_hard_date: cycle?.deposit_goes_hard_date ?? null,
  });
}

// ── PATCH /api/admin/funding-billing ─────────────────────────────────────────

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: {
    application_id?: string;
    emd_funded_cents?: number | null;
    funded_date?: string | null;
    credit_card_payment_enabled?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { application_id, emd_funded_cents, funded_date, credit_card_payment_enabled } = body;

  if (!application_id || typeof application_id !== 'string') {
    return NextResponse.json({ error: 'application_id is required.' }, { status: 400 });
  }

  // ── Server-side validation ────────────────────────────────────────────────

  // emd_funded_cents: must be null or a positive integer
  if (emd_funded_cents !== null && emd_funded_cents !== undefined) {
    if (typeof emd_funded_cents !== 'number' || !Number.isInteger(emd_funded_cents) || emd_funded_cents <= 0) {
      return NextResponse.json({ error: 'emd_funded_cents must be a positive integer (cents) or null.' }, { status: 422 });
    }
  }

  // funded_date: must be null or a valid YYYY-MM-DD string
  if (funded_date !== null && funded_date !== undefined) {
    if (typeof funded_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(funded_date)) {
      return NextResponse.json({ error: 'funded_date must be a YYYY-MM-DD date string or null.' }, { status: 422 });
    }
  }

  // Pair validation: both null or both provided
  const hasAmount = emd_funded_cents !== null && emd_funded_cents !== undefined;
  const hasDate = funded_date !== null && funded_date !== undefined && funded_date !== '';

  if (hasAmount && !hasDate) {
    return NextResponse.json({
      error: 'EarnestBridge Funding Date is required when Actual EMD Funded is provided.',
    }, { status: 422 });
  }
  if (hasDate && !hasAmount) {
    return NextResponse.json({
      error: 'Actual EMD Funded is required when EarnestBridge Funding Date is provided.',
    }, { status: 422 });
  }

  // credit_card_payment_enabled: must be boolean
  if (credit_card_payment_enabled !== undefined && typeof credit_card_payment_enabled !== 'boolean') {
    return NextResponse.json({ error: 'credit_card_payment_enabled must be a boolean.' }, { status: 422 });
  }

  // ── Narrowly scoped update ────────────────────────────────────────────────

  const supabase = getServiceClient();

  // Verify the Deal exists
  const { data: existing, error: fetchError } = await supabase
    .from('borrower_applications')
    .select('id, user_id')
    .eq('id', application_id)
    .is('purged_at', null)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // Only include the three allowed fields — nothing else
  if (emd_funded_cents !== undefined) updatePayload.emd_funded_cents = emd_funded_cents ?? null;
  if (funded_date !== undefined) updatePayload.funded_date = funded_date ?? null;
  if (credit_card_payment_enabled !== undefined) updatePayload.credit_card_payment_enabled = credit_card_payment_enabled;

  const { error: updateError } = await supabase
    .from('borrower_applications')
    .update(updatePayload)
    .eq('id', application_id);

  if (updateError) {
    console.error('[funding-billing] update error:', updateError);
    return NextResponse.json({ error: 'Failed to save funding details.' }, { status: 500 });
  }

  // ── Activity log (best-effort) ────────────────────────────────────────────

  try {
    const parts: string[] = [];
    if (emd_funded_cents !== undefined) {
      parts.push(emd_funded_cents != null
        ? `Actual EMD Funded set to ${(emd_funded_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`
        : 'Actual EMD Funded cleared');
    }
    if (funded_date !== undefined) {
      parts.push(funded_date ? `Funding Date set to ${funded_date}` : 'Funding Date cleared');
    }
    if (credit_card_payment_enabled !== undefined) {
      parts.push(`Credit card payment ${credit_card_payment_enabled ? 'enabled' : 'disabled'}`);
    }

    if (parts.length > 0) {
      await supabase.from('application_activity').insert({
        application_id,
        user_id: existing.user_id,
        event_type: 'admin_note',
        title: 'Funding & Billing Updated',
        detail: parts.join('. ') + '.',
        actor: 'EarnestBridge Admin',
        metadata: {
          changed_by_email: admin.email,
          emd_funded_cents: emd_funded_cents ?? null,
          funded_date: funded_date ?? null,
          credit_card_payment_enabled: credit_card_payment_enabled ?? null,
        },
      });
    }
  } catch {
    // Activity logging is best-effort; never fail the main operation
  }

  // ── Normal Initial Draft refresh follow-on (best-effort) ─────────────────
  // Primary save already succeeded. Refresh failure does NOT affect the
  // authoritative save result or HTTP status.

  const draftRefreshStatus = await callDraftRefresh(
    supabase,
    application_id,
    admin.id,
    'funding-billing PATCH'
  );

  // ── Revision Draft refresh follow-on (best-effort) ───────────────────────
  // Discover qualifying Revision Drafts and refresh each one.
  // Primary save and normal Initial Draft refresh are NOT rolled back on failure.
  // Normal Initial Drafts and Revision Drafts intentionally use separate RPCs.

  const revisionDraftRefreshStatus = await discoverAndRefreshRevisionDrafts(
    supabase,
    application_id,
    admin.id,
    'funding-billing PATCH'
  );

  return NextResponse.json({
    success: true,
    draft_refresh: { status: draftRefreshStatus },
    revision_draft_refresh: { status: revisionDraftRefreshStatus },
  });
}
