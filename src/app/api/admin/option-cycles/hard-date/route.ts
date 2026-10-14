import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Hard Date API
// POST /api/admin/option-cycles/hard-date
//
// Sets the Original Deposit Goes Hard Date on cycle_number = 1
// for a given Deal.
//
// Behavior:
//   IF cycle 1 exists:
//     UPDATE only deposit_goes_hard_date (and recalculate
//     option_exercise_deadline via fn_subtract_business_days).
//   IF cycle 1 does NOT exist:
//     INSERT a new cycle 1 row using the same safe creation
//     path as POST /api/admin/option-cycles, but WITHOUT
//     requiring app_status = 'funded'.
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client
//   2. Verifies app_metadata.role === 'admin'
//   3. All DB operations use service_role (never exposed to browser)
//   4. Only updates deposit_goes_hard_date on cycle_number = 1
//   5. Does NOT accept arbitrary Option Cycle fields
//   6. Does NOT change any Deal workflow status
//
// VALIDATION:
//   - deposit_goes_hard_date must be YYYY-MM-DD
//   - If funded_date already exists on the Deal:
//       hard date must be > funded_date
//   - If funded_date is blank: hard date is saved as-is
//     (pair validation occurs when funding details are saved)
// ============================================================

// ── UUID v4 validation regex ──────────────────────────────────────────────────
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return user.app_metadata?.role === 'admin' ? user : null;
}

function formatDateForActivity(dateStr: string): string {
  if (!dateStr) return dateStr;
  const [y, m, d] = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
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

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: { application_id?: string; deposit_goes_hard_date?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { application_id, deposit_goes_hard_date } = body;

  if (!application_id || typeof application_id !== 'string') {
    return NextResponse.json({ error: 'application_id is required.' }, { status: 400 });
  }

  if (!deposit_goes_hard_date || typeof deposit_goes_hard_date !== 'string') {
    return NextResponse.json({ error: 'deposit_goes_hard_date is required.' }, { status: 400 });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(deposit_goes_hard_date)) {
    return NextResponse.json({ error: 'deposit_goes_hard_date must be in YYYY-MM-DD format.' }, { status: 422 });
  }

  const supabase = getServiceClient();

  // ── Load the Deal ──────────────────────────────────────────────────────────
  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id, user_id, funded_date')
    .eq('id', application_id)
    .single();

  if (dealError || !deal) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  // ── Pair validation: if funded_date exists, hard date must be after it ─────
  if (deal.funded_date) {
    const fundedTs = new Date(deal.funded_date + 'T00:00:00');
    const hardTs = new Date(deposit_goes_hard_date + 'T00:00:00');
    if (hardTs <= fundedTs) {
      return NextResponse.json({
        error: `Original Deposit Goes Hard Date must be after the Funding Date (${deal.funded_date}).`,
      }, { status: 422 });
    }
  }

  // ── Calculate Option Exercise Deadline via canonical RPC ──────────────────
  const { data: deadlineResult, error: calcError } = await supabase
    .rpc('fn_subtract_business_days', {
      p_start_date: deposit_goes_hard_date,
      p_n: 2,
    });

  if (calcError) {
    if (calcError.message?.includes('Business holiday calendar unavailable')) {
      return NextResponse.json({ error: calcError.message }, { status: 422 });
    }
    return NextResponse.json({
      error: 'Failed to calculate Option Exercise Deadline: ' + calcError.message,
    }, { status: 500 });
  }

  const option_exercise_deadline = deadlineResult as string;

  // ── Check if cycle 1 already exists ───────────────────────────────────────
  const { data: existingCycle, error: cycleError } = await supabase
    .from('crm_deal_option_cycles')
    .select('id, cycle_number, status, deposit_goes_hard_date')
    .eq('application_id', application_id)
    .eq('cycle_number', 1)
    .maybeSingle();

  if (cycleError) {
    console.error('[hard-date] cycle query error:', cycleError.message);
    return NextResponse.json({ error: 'Failed to check existing option cycle.' }, { status: 500 });
  }

  let resultCycle: Record<string, unknown>;

  if (existingCycle) {
    // ── UPDATE existing cycle 1 ──────────────────────────────────────────────
    // Only update deposit_goes_hard_date and recalculate option_exercise_deadline.
    // Do NOT touch status, exercised timestamps, or other lifecycle fields.
    const { data: updated, error: updateError } = await supabase
      .from('crm_deal_option_cycles')
      .update({
        deposit_goes_hard_date,
        option_exercise_deadline,
        updated_by: admin.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingCycle.id)
      .select()
      .single();

    if (updateError) {
      console.error('[hard-date] update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to update Original Deposit Goes Hard Date.' }, { status: 500 });
    }

    resultCycle = updated;

    // Activity log (best-effort)
    try {
      await supabase.from('application_activity').insert({
        application_id,
        user_id: deal.user_id ?? null,
        event_type: 'admin_note',
        title: `Original Deposit Goes Hard Date updated: ${formatDateForActivity(deposit_goes_hard_date)}`,
        detail: `Option Exercise Deadline recalculated: ${formatDateForActivity(option_exercise_deadline)}`,
        actor: admin.email || 'EarnestBridge Admin',
        metadata: {
          changed_by_admin_id: admin.id,
          deposit_goes_hard_date,
          option_exercise_deadline,
          cycle_number: 1,
        },
      });
    } catch {
      // Best-effort
    }
  } else {
    // ── INSERT new cycle 1 ───────────────────────────────────────────────────
    // Safe initial-cycle creation. Does NOT require app_status = 'funded'.
    // Status defaults to 'active' — consistent with the existing creation path.
    const { data: inserted, error: insertError } = await supabase
      .from('crm_deal_option_cycles')
      .insert({
        application_id,
        cycle_number: 1,
        deposit_goes_hard_date,
        option_exercise_deadline,
        status: 'active',
        created_by: admin.id,
        updated_by: admin.id,
      })
      .select()
      .single();

    if (insertError) {
      console.error('[hard-date] insert error:', insertError.message);
      return NextResponse.json({ error: 'Failed to create initial option cycle.' }, { status: 500 });
    }

    resultCycle = inserted;

    // Activity log (best-effort)
    try {
      await supabase.from('application_activity').insert({
        application_id,
        user_id: deal.user_id ?? null,
        event_type: 'option_cycle_created',
        title: `Original Deposit Goes Hard Date set: ${formatDateForActivity(deposit_goes_hard_date)}`,
        detail: `Option Exercise Deadline calculated: ${formatDateForActivity(option_exercise_deadline)}. Cycle 1 created.`,
        actor: admin.email || 'EarnestBridge Admin',
        metadata: {
          changed_by_admin_id: admin.id,
          deposit_goes_hard_date,
          option_exercise_deadline,
          cycle_number: 1,
        },
      });
    } catch {
      // Best-effort
    }
  }

  // ── Normal Initial Draft refresh follow-on (best-effort) ─────────────────
  // Primary save already succeeded. Refresh failure does NOT affect the
  // authoritative save result or HTTP status.

  const draftRefreshStatus = await callDraftRefresh(
    supabase,
    application_id,
    admin.id,
    'hard-date POST'
  );

  // ── Revision Draft refresh follow-on (best-effort) ───────────────────────
  // Discover qualifying Revision Drafts and refresh each one.
  // Primary save and normal Initial Draft refresh are NOT rolled back on failure.
  // Normal Initial Drafts and Revision Drafts intentionally use separate RPCs.

  const revisionDraftRefreshStatus = await discoverAndRefreshRevisionDrafts(
    supabase,
    application_id,
    admin.id,
    'hard-date POST'
  );

  return NextResponse.json({
    success: true,
    deposit_goes_hard_date,
    option_exercise_deadline,
    cycle_existed: !!existingCycle,
    draft_refresh: { status: draftRefreshStatus },
    revision_draft_refresh: { status: revisionDraftRefreshStatus },
  });
}
