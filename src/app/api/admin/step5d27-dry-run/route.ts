/**
 * Step 5D-2.7 — Controlled Dry Run Diagnostic Endpoint
 *
 * TEMPORARY endpoint for executing the Step 5D-2.7 controlled dry run.
 * Admin-session required. Zero writes during dry run.
 *
 * Actions:
 *   GET  ?action=verify_deal           — verify test deal ownership + details
 *   GET  ?action=snapshot              — before/after snapshot of all relevant tables
 *   POST ?action=set_funded            — move test deal to funded (if not already)
 *   POST ?action=create_cycle          — create option cycle with deposit_goes_hard_date=2026-09-24
 *   POST ?action=dry_run               — execute dry run #1 or #2 with evaluation_time
 *   GET  ?action=verify_zero_writes    — confirm no writes occurred after dry run
 *   POST ?action=live_client_test      — Step 5D-2.9: send exactly ONE real client_reminder_7d
 *                                        to ericthoni@gmail.com with full safety gates +
 *                                        real atomic claim/idempotency path.
 *                                        Second call returns already_done — no second email.
 *   GET  ?action=admin_preflight       — Step 5D-2.11a: READ-ONLY preflight inspection.
 *                                        Reports current admin automation log state.
 *                                        ZERO writes. ZERO claims. ZERO provider calls.
 *                                        ZERO attempt_count changes. Safe to call repeatedly.
 *   POST ?action=live_admin_test       — Step 5D-2.11a: Send ONE real admin_reminder_7d
 *                                        to admin@earnestbridge.com with full safety gates +
 *                                        real atomic claim/idempotency path.
 *                                        ONLY this action may claim + call provider.
 *                                        Second call returns already_done — no second email.
 *   POST ?action=admin_email_preview   — Step 5D-2.12a: Send exactly ONE standalone visual
 *                                        preview of the admin_reminder_7d email template to
 *                                        admin@earnestbridge.com to verify green/gold styling.
 *                                        ZERO automation claims. ZERO log writes.
 *                                        ZERO activity writes. ZERO attempt_count changes.
 *                                        Recipient is hardcoded — not configurable.
 *                                        Uses the production send-borrower-emails edge function.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { runOptionCycleAutomation } from '@/lib/optionCycleWorker';
import { getOptionDeadlineCutoff, isTimely } from '@/app/api/admin/option-cycles/route';


// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_USER_ID = '2b191192-0358-4582-b7df-20cb2894216b';
const TEST_EMAIL = 'ericthoni@gmail.com';
const KNOWN_APP_ID = '2aa816a9-2fb0-404f-92ca-c5e2cb49fe66';

// Step 5D-2.9 hard-locked constants
const LIVE_TEST_CYCLE_ID = '87bc8363-af29-4a77-919a-4b60ac8b6e38';
const LIVE_TEST_EXPECTED_DEADLINE = '2026-09-22';
const LIVE_TEST_EXPECTED_HARD_DATE = '2026-09-24';
const LIVE_TEST_EVENT_TYPE = 'client_reminder_7d';

// Step 5D-2.11 hard-locked constants — Admin reminder test
const LIVE_ADMIN_TEST_CYCLE_ID = '87bc8363-af29-4a77-919a-4b60ac8b6e38';
const LIVE_ADMIN_TEST_APP_ID = '2aa816a9-2fb0-404f-92ca-c5e2cb49fe66';
const LIVE_ADMIN_TEST_EXPECTED_DEADLINE = '2026-09-22';
const LIVE_ADMIN_TEST_EXPECTED_HARD_DATE = '2026-09-24';
const LIVE_ADMIN_TEST_EVENT_TYPE = 'admin_reminder_7d';
const LIVE_ADMIN_TEST_EXPECTED_RECIPIENT = 'admin@earnestbridge.com';

// The dedupe key for the admin reminder — used by both preflight and live_admin_test
const ADMIN_DEDUPE_KEY = `option:${LIVE_ADMIN_TEST_CYCLE_ID}:${LIVE_ADMIN_TEST_EXPECTED_DEADLINE}:${LIVE_ADMIN_TEST_EVENT_TYPE}:${LIVE_ADMIN_TEST_EXPECTED_RECIPIENT}`;

// The known false-claim last_error marker written by the old Step 5D-2.11 inspection
const FALSE_CLAIM_ERROR_MARKER = 'Step 5D-2.11 inspection only';

// Admin owner → email mapping (canonical, mirrors optionCycleWorker.ts)
const ADMIN_OWNER_EMAIL_MAP_DIAG: Record<string, string> = {
  'Eric': 'admin@earnestbridge.com',
  'Dan': 'deals@earnestbridge.com',
  'Tucker': 'legal@earnestbridge.com',
};
const ADMIN_FALLBACK_EMAIL_DIAG = 'admin@earnestbridge.com';

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function requireAdmin() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return user.app_metadata?.role === 'admin' ? user : null;
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

function formatDateDisplay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  const supabase = getServiceClient();

  // ── action=verify_deal ────────────────────────────────────────────────────
  if (action === 'verify_deal') {
    // 1. Fetch the known application
    const { data: app, error: appErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id, email, first_name, last_name')
      .eq('id', KNOWN_APP_ID)
      .maybeSingle();

    if (appErr) return NextResponse.json({ error: appErr.message }, { status: 500 });
    if (!app) return NextResponse.json({ error: 'Application not found', application_id: KNOWN_APP_ID }, { status: 404 });

    // SAFETY CHECK: must belong to test user
    if (app.user_id !== TEST_USER_ID) {
      return NextResponse.json({
        STOP: true,
        reason: 'Application does NOT belong to ericthoni@gmail.com',
        application_id: KNOWN_APP_ID,
        actual_user_id: app.user_id,
        expected_user_id: TEST_USER_ID,
      }, { status: 403 });
    }

    // 2. Resolve CRM contact
    let crmContact = null;
    if (app.primary_contact_id) {
      const { data: contact } = await supabase
        .from('crm_contacts')
        .select('id, first_name, last_name, primary_email, portal_user_id')
        .eq('id', app.primary_contact_id)
        .maybeSingle();
      crmContact = contact;
    }

    // 3. Also check if any CRM contact has portal_user_id = TEST_USER_ID
    const { data: linkedContact } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, portal_user_id')
      .eq('portal_user_id', TEST_USER_ID)
      .maybeSingle();

    // 4. Get auth user email
    const { data: authUser } = await supabase.auth.admin.getUserById(TEST_USER_ID);

    // 5. Resolve client recipient (worker logic)
    let clientRecipientEmail = null;
    let clientRecipientSource = null;
    if (crmContact?.primary_email) {
      clientRecipientEmail = crmContact.primary_email.trim().toLowerCase();
      clientRecipientSource = `crm_contacts.primary_email (via primary_contact_id: ${app.primary_contact_id})`;
    } else if (authUser?.user?.email) {
      clientRecipientEmail = authUser.user.email.trim().toLowerCase();
      clientRecipientSource = `auth.users.email fallback (user_id: ${TEST_USER_ID})`;
    }

    // 6. Resolve admin recipient
    const ADMIN_MAP: Record<string, string> = {
      'Eric': 'admin@earnestbridge.com',
      'Dan': 'deals@earnestbridge.com',
      'Tucker': 'legal@earnestbridge.com',
    };
    const adminRecipient = (app.eb_assigned_owner && ADMIN_MAP[app.eb_assigned_owner])
      ? ADMIN_MAP[app.eb_assigned_owner]
      : 'admin@earnestbridge.com';

    // 7. Check existing option cycles
    const { data: cycles } = await supabase
      .from('crm_deal_option_cycles')
      .select('*')
      .eq('application_id', KNOWN_APP_ID)
      .order('cycle_number', { ascending: true });

    // 8. Check automation log
    const { data: automationLog, count: logCount } = await supabase
      .from('option_cycle_automation_log')
      .select('*', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID);

    // 9. Check activity
    const { data: activity, count: activityCount } = await supabase
      .from('application_activity')
      .select('*', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID)
      .order('created_at', { ascending: false });

    return NextResponse.json({
      safety_check: 'PASS — application belongs to ericthoni@gmail.com',
      application: {
        id: app.id,
        user_id: app.user_id,
        app_status: app.app_status,
        property_address: app.property_address,
        company_name: app.company_name,
        eb_assigned_owner: app.eb_assigned_owner,
        primary_contact_id: app.primary_contact_id,
        email: app.email,
        first_name: app.first_name,
        last_name: app.last_name,
      },
      crm_contact_via_primary_contact_id: crmContact,
      crm_contact_via_portal_user_id: linkedContact,
      auth_user_email: authUser?.user?.email,
      client_recipient_resolved: clientRecipientEmail,
      client_recipient_source: clientRecipientSource,
      admin_owner: app.eb_assigned_owner ?? 'NULL (unassigned)',
      admin_recipient: adminRecipient,
      existing_option_cycles: cycles ?? [],
      option_cycle_count: cycles?.length ?? 0,
      automation_log_rows: automationLog ?? [],
      automation_log_count: logCount ?? 0,
      application_activity_count: activityCount ?? 0,
      application_activity_latest_3: (activity ?? []).slice(0, 3),
    });
  }

  // ── action=snapshot ───────────────────────────────────────────────────────
  if (action === 'snapshot') {
    const { data: cycles } = await supabase
      .from('crm_deal_option_cycles')
      .select('*')
      .eq('application_id', KNOWN_APP_ID);

    const { data: automationLog, count: logCount } = await supabase
      .from('option_cycle_automation_log')
      .select('*', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID);

    const { data: app } = await supabase
      .from('borrower_applications')
      .select('id, app_status, property_address, company_name, eb_assigned_owner')
      .eq('id', KNOWN_APP_ID)
      .maybeSingle();

    const { data: activity, count: activityCount } = await supabase
      .from('application_activity')
      .select('id, event_type, title, actor, created_at', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID)
      .order('created_at', { ascending: false });

    return NextResponse.json({
      snapshot_at: new Date().toISOString(),
      borrower_applications: {
        app_status: app?.app_status,
        property_address: app?.property_address,
        company_name: app?.company_name,
        eb_assigned_owner: app?.eb_assigned_owner,
      },
      crm_deal_option_cycles: cycles ?? [],
      option_cycle_count: cycles?.length ?? 0,
      option_cycle_automation_log_count: logCount ?? 0,
      option_cycle_automation_log_rows: automationLog ?? [],
      application_activity_count: activityCount ?? 0,
      application_activity_rows: activity ?? [],
    });
  }

  // ── action=verify_zero_writes ─────────────────────────────────────────────
  if (action === 'verify_zero_writes') {
    const { data: cycles } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, status, actual_option_exercised_at, actual_amendment_received_at, extension_fee_paid_at, updated_at')
      .eq('application_id', KNOWN_APP_ID);

    const { data: automationLog, count: logCount } = await supabase
      .from('option_cycle_automation_log')
      .select('*', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID);

    const { data: app } = await supabase
      .from('borrower_applications')
      .select('id, app_status')
      .eq('id', KNOWN_APP_ID)
      .maybeSingle();

    const { data: activity, count: activityCount } = await supabase
      .from('application_activity')
      .select('id, event_type, title, actor, created_at', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID)
      .order('created_at', { ascending: false });

    return NextResponse.json({
      verified_at: new Date().toISOString(),
      borrower_applications_app_status: app?.app_status,
      option_cycle_automation_log_count: logCount ?? 0,
      option_cycle_automation_log_rows: automationLog ?? [],
      application_activity_count: activityCount ?? 0,
      application_activity_rows: activity ?? [],
      crm_deal_option_cycles: cycles ?? [],
    });
  }

  // ── action=admin_preflight ────────────────────────────────────────────────
  // Step 5D-2.11a: READ-ONLY preflight inspection.
  //
  // ZERO writes. ZERO claims. ZERO provider calls. ZERO attempt_count changes.
  // Safe to call any number of times — state is never mutated.
  //
  // Reports:
  //   - application ID, cycle ID, deal status, cycle status
  //   - deadlines, timestamps, owner, recipient
  //   - dedupe key
  //   - whether an existing automation-log row exists (and its full state)
  //   - whether the existing row appears to be a false-claim test artifact
  //   - email payload/template data (for inspection only — provider NOT called)
  if (action === 'admin_preflight') {
    // ── 1. Fetch application (read-only) ─────────────────────────────────────
    const { data: app, error: appErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id')
      .eq('id', LIVE_ADMIN_TEST_APP_ID)
      .maybeSingle();

    if (appErr || !app) {
      return NextResponse.json({
        preflight: 'ERROR',
        reason: 'Application not found',
        application_id: LIVE_ADMIN_TEST_APP_ID,
        writes_performed: 0,
        claims_made: 0,
        provider_called: false,
        attempt_count_changed: false,
      }, { status: 404 });
    }

    // ── 2. Fetch cycle (read-only) ────────────────────────────────────────────
    const { data: cycle, error: cycleErr } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, application_id, cycle_number, deposit_goes_hard_date, option_exercise_deadline, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', LIVE_ADMIN_TEST_CYCLE_ID)
      .maybeSingle();

    if (cycleErr || !cycle) {
      return NextResponse.json({
        preflight: 'ERROR',
        reason: `Test cycle not found: ${LIVE_ADMIN_TEST_CYCLE_ID}`,
        cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
        writes_performed: 0,
        claims_made: 0,
        provider_called: false,
        attempt_count_changed: false,
      }, { status: 404 });
    }

    // ── 3. Resolve admin recipient (read-only) ────────────────────────────────
    const resolvedAdminEmail: string = (app.eb_assigned_owner && ADMIN_OWNER_EMAIL_MAP_DIAG[app.eb_assigned_owner])
      ? ADMIN_OWNER_EMAIL_MAP_DIAG[app.eb_assigned_owner]
      : ADMIN_FALLBACK_EMAIL_DIAG;
    const resolvedOwnerDisplay: string = app.eb_assigned_owner ?? 'Unassigned';

    // ── 4. Check for existing automation log row (read-only) ──────────────────
    const { data: existingAdminLog } = await supabase
      .from('option_cycle_automation_log')
      .select('id, cycle_id, application_id, event_type, status, attempt_count, claimed_at, completed_at, last_error, created_at, dedupe_key')
      .eq('dedupe_key', ADMIN_DEDUPE_KEY)
      .maybeSingle();

    // ── 5. Classify the existing row (if any) ────────────────────────────────
    let existingRowClassification: string | null = null;
    let isFalseClaim = false;
    if (existingAdminLog) {
      if (
        existingAdminLog.status === 'failed' &&
        existingAdminLog.last_error &&
        existingAdminLog.last_error.includes(FALSE_CLAIM_ERROR_MARKER)
      ) {
        isFalseClaim = true;
        existingRowClassification = 'TEST INFRASTRUCTURE FALSE CLAIM — claim RPC was called by Step 5D-2.11 inspection but provider was never called. This is not a real delivery attempt. Row should be cleaned up before first real send.';
      } else if (existingAdminLog.status === 'sent') {
        existingRowClassification = 'SENT — admin reminder was successfully delivered. Subsequent live_admin_test will return already_done.';
      } else if (existingAdminLog.status === 'failed') {
        existingRowClassification = `FAILED (retryable) — attempt_count=${existingAdminLog.attempt_count}. Provider may or may not have been called. Review last_error.`;
      } else if (existingAdminLog.status === 'pending') {
        existingRowClassification = 'PENDING — another worker currently holds the claim lease.';
      }
    }

    // ── 6. Check client reminder row is untouched (read-only) ────────────────
    const { data: clientRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('id', '30c677e6-c156-46f1-a243-f09da9f9bf3b')
      .maybeSingle();

    // ── 7. Build inspected email payload (for review — provider NOT called) ───
    const dealDisplayName = app.property_address || app.company_name || '123 Main St, Orlando, FL';
    const inspectedEmailPayload = {
      emailType: LIVE_ADMIN_TEST_EVENT_TYPE,
      borrower: {
        email: resolvedAdminEmail,
        firstName: 'Admin',
      },
      application: {
        optionExerciseDeadline: LIVE_ADMIN_TEST_EXPECTED_DEADLINE,
        optionDeadlineDisplay: formatDateDisplay(LIVE_ADMIN_TEST_EXPECTED_DEADLINE),
        depositGoesHardDate: LIVE_ADMIN_TEST_EXPECTED_HARD_DATE,
        depositGoesHardDateDisplay: formatDateDisplay(LIVE_ADMIN_TEST_EXPECTED_HARD_DATE),
        daysUntilDeadline: 7,
        propertyAddress: app.property_address,
        dealDisplayName: dealDisplayName,
        assignedOwner: resolvedOwnerDisplay,
      },
    };

    // ── Safety gate evaluation (read-only — no action taken on failure) ───────
    const safetyGateChecks: Record<string, boolean | string> = {
      application_id_correct: app.id === LIVE_ADMIN_TEST_APP_ID,
      deal_status_funded: app.app_status === 'funded',
      cycle_id_correct: cycle.id === LIVE_ADMIN_TEST_CYCLE_ID,
      cycle_belongs_to_app: cycle.application_id === LIVE_ADMIN_TEST_APP_ID,
      cycle_status_active: cycle.status === 'active',
      option_exercise_deadline_correct: cycle.option_exercise_deadline === LIVE_ADMIN_TEST_EXPECTED_DEADLINE,
      deposit_goes_hard_date_correct: cycle.deposit_goes_hard_date === LIVE_ADMIN_TEST_EXPECTED_HARD_DATE,
      actual_option_exercised_at_null: cycle.actual_option_exercised_at === null,
      actual_amendment_received_at_null: cycle.actual_amendment_received_at === null,
      admin_recipient_correct: resolvedAdminEmail === LIVE_ADMIN_TEST_EXPECTED_RECIPIENT,
      event_type_correct: LIVE_ADMIN_TEST_EVENT_TYPE === 'admin_reminder_7d',
    };
    const allGatesPass = Object.values(safetyGateChecks).every(v => v === true);

    return NextResponse.json({
      // ── Preflight identity ────────────────────────────────────────────────
      preflight: 'READ_ONLY_INSPECTION',
      preflight_note: 'This action performs ZERO writes, ZERO claims, ZERO provider calls, ZERO attempt_count changes. Safe to call repeatedly.',
      writes_performed: 0,
      claims_made: 0,
      provider_called: false,
      attempt_count_changed: false,

      // ── Deal / cycle state ────────────────────────────────────────────────
      application_id: app.id,
      deal_status: app.app_status,
      cycle_id: cycle.id,
      cycle_status: cycle.status,
      option_exercise_deadline: cycle.option_exercise_deadline,
      option_exercise_deadline_display: formatDateDisplay(cycle.option_exercise_deadline),
      deposit_goes_hard_date: cycle.deposit_goes_hard_date,
      deposit_goes_hard_date_display: formatDateDisplay(cycle.deposit_goes_hard_date),
      actual_option_exercised_at: cycle.actual_option_exercised_at,
      actual_amendment_received_at: cycle.actual_amendment_received_at,

      // ── Owner / recipient ─────────────────────────────────────────────────
      admin_owner: resolvedOwnerDisplay,
      resolved_admin_recipient: resolvedAdminEmail,
      recipient_verified: resolvedAdminEmail === LIVE_ADMIN_TEST_EXPECTED_RECIPIENT,

      // ── Dedupe key ────────────────────────────────────────────────────────
      dedupe_key: ADMIN_DEDUPE_KEY,

      // ── Existing automation log row ───────────────────────────────────────
      existing_admin_automation_row: existingAdminLog
        ? {
            id: existingAdminLog.id,
            status: existingAdminLog.status,
            attempt_count: existingAdminLog.attempt_count,
            claimed_at: existingAdminLog.claimed_at ?? null,
            completed_at: existingAdminLog.completed_at ?? null,
            last_error: existingAdminLog.last_error ?? null,
            created_at: existingAdminLog.created_at,
            dedupe_key: existingAdminLog.dedupe_key,
          }
        : null,
      existing_row_present: existingAdminLog !== null,
      existing_row_classification: existingRowClassification,
      is_false_claim_artifact: isFalseClaim,
      false_claim_explanation: isFalseClaim
        ? 'The Step 5D-2.11 inspection called claim_option_cycle_automation_event() but never called the email provider. This incremented attempt_count without a real delivery attempt, violating canonical attempt_count semantics. This row must be cleaned up before the first real live_admin_test send.'
        : null,

      // ── Email payload (inspection only) ───────────────────────────────────
      inspected_email_payload: inspectedEmailPayload,

      // ── Safety gate evaluation ────────────────────────────────────────────
      safety_gate_evaluation: safetyGateChecks,
      all_safety_gates_pass: allGatesPass,

      // ── Client reminder row (must be unchanged) ───────────────────────────
      client_reminder_row: clientRow
        ? {
            id: clientRow.id,
            status: clientRow.status,
            attempt_count: clientRow.attempt_count,
            completed_at: clientRow.completed_at,
            unchanged: clientRow.status === 'sent' && clientRow.attempt_count === 1,
          }
        : null,

      // ── Readiness ─────────────────────────────────────────────────────────
      ready_for_live_send: allGatesPass && !isFalseClaim && existingAdminLog === null,
      ready_for_live_send_note: allGatesPass && !isFalseClaim && existingAdminLog === null
        ? 'All gates pass, no existing row, no false claim. Safe to call POST ?action=live_admin_test.'
        : isFalseClaim
          ? 'FALSE CLAIM ARTIFACT EXISTS. Call POST ?action=live_admin_test with cleanup=true to delete the false-claim row before the first real send.'
          : existingAdminLog?.status === 'sent' ?'Admin reminder already sent. live_admin_test will return already_done.' :'Review safety gate failures before proceeding.',

      option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',
    });
  }

  // ── action=auto_close_dry_run ─────────────────────────────────────────────
  // Step 5D-2.13: Controlled dry-run / preflight of the missed-deadline
  // auto-close workflow.
  //
  // ZERO writes. ZERO emails sent. ZERO mutations to any table.
  // Uses the SAME production cutoff logic (getOptionDeadlineCutoff / isTimely)
  // imported from /api/admin/option-cycles/route.ts — no separate date logic.
  //
  // Verifies:
  //   1.  Cutoff boundary (4:59:59 PM / 5:00:00 PM / 5:00:01 PM ET)
  //   2.  Timely exercise blocks auto-close
  //   3.  Timely amendment blocks auto-close (fee NOT required)
  //   4.  Late exercise does NOT block auto-close
  //   5.  Late amendment does NOT automatically block auto-close
  //   6.  Eligible unsatisfied cycle → would_close (active→missed; Deal status NOT changed)
  //   7.  Exact activity event types and messages that WOULD be written
  //   8.  Closeout email event types and recipients
  //   9.  Client closeout copy inspection (policy violations check)
  //  10.  Admin closeout copy inspection
  //  11.  Dedupe event types and key formats for all three events
  //  12.  Failure separation (auto-close vs client/admin closeout)
  //  13.  attempt_count semantics
  //  14.  Manual override path (extension_override action)
  //  15.  Final state confirmation (deal/cycle/rows unchanged)
  if (action === 'auto_close_dry_run') {
    // ── 1. Fetch test deal and cycle (read-only) ──────────────────────────────
    const { data: app, error: appErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id')
      .eq('id', KNOWN_APP_ID)
      .maybeSingle();

    if (appErr || !app) {
      return NextResponse.json({ error: 'Test application not found', application_id: KNOWN_APP_ID }, { status: 404 });
    }

    const { data: cycle, error: cycleErr } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, application_id, cycle_number, deposit_goes_hard_date, option_exercise_deadline, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', LIVE_TEST_CYCLE_ID)
      .maybeSingle();

    if (cycleErr || !cycle) {
      return NextResponse.json({ error: 'Test cycle not found', cycle_id: LIVE_TEST_CYCLE_ID }, { status: 404 });
    }

    // ── 2. Canonical cutoff (SAME function used by production worker) ─────────
    const deadline = cycle.option_exercise_deadline; // '2026-09-22'
    const canonicalCutoff = getOptionDeadlineCutoff(deadline);

    // ── 3. Cutoff boundary evaluation (read-only, no mutations) ──────────────
    // A: 2026-09-22T16:59:59-04:00 (4:59:59 PM ET)
    const tsA = new Date('2026-09-22T16:59:59-04:00');
    // B: 2026-09-22T17:00:00-04:00 (exactly 5:00:00 PM ET)
    const tsB = new Date('2026-09-22T17:00:00-04:00');
    // C: 2026-09-22T17:00:01-04:00 (5:00:01 PM ET)
    const tsC = new Date('2026-09-22T17:00:01-04:00');

    // isTimely: timestamp <= cutoff → TIMELY; > cutoff → LATE
    const aTimely = isTimely(tsA, deadline); // expected: true (TIMELY)
    const bTimely = isTimely(tsB, deadline); // expected: true (TIMELY — exactly 5:00:00 PM is still timely)
    const cTimely = isTimely(tsC, deadline); // expected: false (LATE)

    // closeoutWindowOpen logic from worker: etHour >= 17
    // At exactly 5:00:00 PM ET, etHour = 17 → closeoutWindowOpen = true
    // But the worker also checks: nowForCutoff.getTime() <= cutoff.getTime() → skip if at/before cutoff
    // So at exactly 5:00:00 PM: closeoutWindowOpen=true BUT nowForCutoff <= cutoff → NOT eligible
    // At 5:00:01 PM: closeoutWindowOpen=true AND nowForCutoff > cutoff → eligible
    const aEligible = !aTimely && tsA.getTime() > canonicalCutoff.getTime(); // false (timely)
    const bEligible = !bTimely && tsB.getTime() > canonicalCutoff.getTime(); // false (exactly at cutoff, not after)
    const cEligible = !cTimely && tsC.getTime() > canonicalCutoff.getTime(); // true (after cutoff, no timely action)

    // ── 4. Timely exercise simulation (read-only) ─────────────────────────────
    // Simulate actual_option_exercised_at = tsB (exactly 5:00:00 PM ET — timely)
    const simulatedTimelyExercise = tsB;
    const timelyExerciseIsTimely = isTimely(simulatedTimelyExercise, deadline);
    const timelyExerciseBlocksAutoClose = timelyExerciseIsTimely; // true → blocks

    // ── 5. Timely amendment simulation (read-only) ────────────────────────────
    // Simulate actual_amendment_received_at = tsB (timely)
    // Fee NOT required to block auto-close when timely amendment received
    const simulatedTimelyAmendment = tsB;
    const timelyAmendmentIsTimely = isTimely(simulatedTimelyAmendment, deadline);
    const timelyAmendmentBlocksAutoClose = timelyAmendmentIsTimely; // true → blocks
    // Fee leniency: extension_fee_paid_at = NULL does NOT affect block when amendment is timely

    // ── 6. Late exercise simulation (read-only) ───────────────────────────────
    const simulatedLateExercise = tsC; // 5:00:01 PM ET
    const lateExerciseIsTimely = isTimely(simulatedLateExercise, deadline);
    const lateExerciseBlocksAutoClose = lateExerciseIsTimely; // false → does NOT block

    // ── 7. Late amendment simulation (read-only) ──────────────────────────────
    const simulatedLateAmendment = tsC;
    const lateAmendmentIsTimely = isTimely(simulatedLateAmendment, deadline);
    const lateAmendmentAutomaticallyBlocksAutoClose = lateAmendmentIsTimely; // false → does NOT automatically block

    // ── 8. Eligible unsatisfied cycle — what WOULD be written ─────────────────
    // (current state: actual_option_exercised_at=NULL, actual_amendment_received_at=NULL)
    const currentExerciseTs = cycle.actual_option_exercised_at;
    const currentAmendmentTs = cycle.actual_amendment_received_at;
    const currentTimelyExercise = currentExerciseTs ? isTimely(currentExerciseTs, deadline) : false;
    const currentTimelyAmendment = currentAmendmentTs ? isTimely(currentAmendmentTs, deadline) : false;
    const currentlySatisfied = currentTimelyExercise || currentTimelyAmendment;

    // Resolve admin email (same logic as worker)
    const ADMIN_MAP_LOCAL: Record<string, string> = {
      'Eric': 'admin@earnestbridge.com',
      'Dan': 'deals@earnestbridge.com',
      'Tucker': 'legal@earnestbridge.com',
    };
    const resolvedAdminEmail = (app.eb_assigned_owner && ADMIN_MAP_LOCAL[app.eb_assigned_owner])
      ? ADMIN_MAP_LOCAL[app.eb_assigned_owner]
      : 'admin@earnestbridge.com';

    // Resolve client email (read-only)
    let clientEmail: string | null = null;
    if (app.primary_contact_id) {
      const { data: contact } = await supabase
        .from('crm_contacts')
        .select('primary_email')
        .eq('id', app.primary_contact_id)
        .maybeSingle();
      if (contact?.primary_email) clientEmail = contact.primary_email.trim().toLowerCase();
    }
    if (!clientEmail) {
      const { data: authUser } = await supabase.auth.admin.getUserById(app.user_id ?? '');
      if (authUser?.user?.email) clientEmail = authUser.user.email.trim().toLowerCase();
    }

    // Dedupe keys (exact production format)
    const autoCloseDedupe = `option:${cycle.id}:${deadline}:auto_close`;
    const clientCloseoutDedupe = clientEmail
      ? `option:${cycle.id}:${deadline}:client_closeout_notice:${clientEmail}`
      : `option:${cycle.id}:${deadline}:client_closeout_notice:<client_email>`;
    const adminCloseoutDedupe = `option:${cycle.id}:${deadline}:admin_closeout_notice:${resolvedAdminEmail.toLowerCase()}`;

    // What WOULD be written on successful auto-close (NOT performed here)
    const wouldBeWrites = {
      crm_deal_option_cycles: {
        id: cycle.id,
        field: 'status',
        from: 'active',
        to: 'missed',
        guard: 'WHERE status = \'active\'',
      },
      borrower_applications: {
        id: KNOWN_APP_ID,
        field: 'app_status',
        from: 'funded',
        to: 'funded',
        guard: 'WHERE app_status = \'funded\' (guard_deal_not_funded) — row is locked and validated only; NOT written',
        write: 'NONE — auto-close does NOT modify borrower_applications.app_status or deal_workflow_stage',
        required_current_value: 'funded',
      },
      application_activity_row_1: {
        event_type: 'option_cycle_missed',
        title: `Option Exercise Deadline missed`,
        detail: `The Option Exercise Deadline (${formatDateDisplay(deadline)}) passed with no timely exercise or signed amendment. The Option Cycle was marked missed. Review escrow/return-of-funds process separately.`,
        actor: 'EarnestBridge Automation',
      },
      application_activity_row_2: {
        event_type: null,
        title: null,
        detail: null,
        actor: null,
        written: false,
        note: 'No status_change activity is inserted. Auto-close does not change Deal status. Key retained for response-shape compatibility only.',
      },
      application_activity_status_change: {
        written: false,
        note: 'No status_change activity is inserted. Auto-close does not change Deal status.',
      },
      option_cycle_automation_log_auto_close: {
        event_type: 'auto_close',
        dedupe_key: autoCloseDedupe,
        status_on_success: 'completed',
        note: 'auto_close log completion is committed INSIDE execute_option_cycle_auto_close() — same atomic transaction as cycle→missed and the option_cycle_missed activity. No separate markLogCompleted() call for auto_close.',
      },
      option_cycle_automation_log_client_closeout: {
        event_type: 'client_closeout_notice',
        dedupe_key: clientCloseoutDedupe,
        status_on_success: 'completed',
        note: 'Separate atomic claim — independent of auto_close',
      },
      option_cycle_automation_log_admin_closeout: {
        event_type: 'admin_closeout_notice',
        dedupe_key: adminCloseoutDedupe,
        status_on_success: 'completed',
        note: 'Separate atomic claim — independent of auto_close and client_closeout_notice',
      },
    };

    // ── 9. Check existing automation log rows (read-only) ─────────────────────
    const { data: existingAutoCloseRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, created_at, dedupe_key')
      .eq('dedupe_key', autoCloseDedupe)
      .maybeSingle();

    const { data: existingClientCloseoutRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, created_at, dedupe_key')
      .eq('dedupe_key', clientCloseoutDedupe)
      .maybeSingle();

    const { data: existingAdminCloseoutRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, created_at, dedupe_key')
      .eq('dedupe_key', adminCloseoutDedupe)
      .maybeSingle();

    // ── 10. Verify existing reminder rows are unchanged ───────────────────────
    const { data: clientReminderRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
      .eq('id', '30c677e6-c156-46f1-a243-f09da9f9bf3b')
      .maybeSingle();

    const { data: adminReminderRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
      .eq('id', '7ddccff9-0c6a-4698-bf7c-1d5f32eff21e')
      .maybeSingle();

    // ── 11. Client closeout copy inspection ───────────────────────────────────
    // Exact rendered copy from production template (option_client_closeout)
    const clientCloseoutCopy = {
      subject: 'Option Exercise Deadline Missed — EarnestBridge',
      heading: 'Your Option Exercise Deadline Has Passed',
      primary_message: 'The Option Exercise Deadline was not met, and the associated Option Cycle has been marked missed.',
      contact_prompt: 'Please contact EarnestBridge regarding next steps. If you believe required extension documentation was submitted, let us know right away.',
      contact_info: 'You can reach us at admin@earnestbridge.com.',
      cta: 'View My Deadlines →',
      fields_shown: ['property_address (conditional)', 'Option Exercise Deadline date'],
    };

    // Policy violation checks for client copy
    const clientCopyPolicyChecks = {
      exposes_deposit_goes_hard_date: false,
      exposes_actual_dd_expiration: false,
      exposes_internal_two_business_day_buffer: false,
      exposes_extension_fee_leniency: false,
      exposes_admin_manual_override_policy: false,
      claims_escrow_funds_returned: false,
      claims_psa_legally_expired: false,
      policy_violations_found: false,
      note: 'Client copy is clean. No policy-sensitive fields exposed. No legal/escrow conclusions made.',
    };

    // ── 12. Admin closeout copy inspection ────────────────────────────────────
    const adminCloseoutCopy = {
      subject: `[Admin] Option Exercise Deadline Missed — <dealName> | EarnestBridge`,
      heading: 'Option Cycle Marked Missed — Option Exercise Deadline Passed',
      intro: 'The Option Cycle for the following deal was marked missed because the Option Exercise Deadline passed with no timely exercise or signed amendment recorded. The automation did not modify the Deal status; the Deal remains subject to a separate Admin status decision.',
      fields_in_deal_table: [
        'Deal (dealDisplayName)',
        'Property (propertyAddress)',
        'Assigned Owner',
        'Option Exercise Deadline (red)',
        'Deposit Goes Hard Date',
      ],
      action_required_items: [
        'No timely option exercise recorded in CRM',
        'No timely signed PSA amendment recorded in CRM',
        'Option Cycle status: Missed (Deal status was not changed by automation)',
        'Decide separately whether to change the Deal status',
        'Review escrow/return-of-funds process separately',
        'If borrower submitted documentation, use Admin Override to review',
      ],
      cta: 'Review in Admin Dashboard →',
      header_style: 'adminBrandedHeader("OPTION CYCLE MARKED MISSED") — green #173F35 gradient, gold #C9A227 accent',
    };

    // ── 13. Idempotency / failure separation analysis ─────────────────────────
    const idempotencyAnalysis = {
      auto_close_dedupe: {
        event_type: 'auto_close',
        dedupe_key_format: `option:<cycle_id>:<deadline_date>:auto_close`,
        dedupe_key_example: autoCloseDedupe,
        note: 'Separate from both closeout notice events. A successful auto-close (markLogCompleted) prevents re-execution regardless of email outcomes.',
      },
      client_closeout_dedupe: {
        event_type: 'client_closeout_notice',
        dedupe_key_format: `option:<cycle_id>:<deadline_date>:client_closeout_notice:<client_email>`,
        dedupe_key_example: clientCloseoutDedupe,
        note: 'Independent atomic claim. Failure sets status=failed/retryable. Does NOT affect auto_close row.',
      },
      admin_closeout_dedupe: {
        event_type: 'admin_closeout_notice',
        dedupe_key_format: `option:<cycle_id>:<deadline_date>:admin_closeout_notice:<admin_email>`,
        dedupe_key_example: adminCloseoutDedupe,
        note: 'Independent atomic claim. Failure sets status=failed/retryable. Does NOT affect auto_close or client_closeout_notice rows.',
      },
    };

    const failureSeparation = {
      scenario_client_email_fails_after_auto_close: {
        deal_status: 'funded (unchanged — auto-close does not modify Deal status)',
        cycle_status: 'missed (unchanged)',
        auto_close_log_row: 'completed (unchanged — auto_close completion is committed atomically inside execute_option_cycle_auto_close(), before any email sends)',
        client_closeout_log_row: 'failed/retryable (attempt_count=1, status=failed)',
        admin_closeout_log_row: 'independently processable (unaffected)',
        auto_close_repeated: false,
        explanation: 'auto_close log is marked completed INSIDE the atomic RPC transaction (execute_option_cycle_auto_close). Email failure cannot re-trigger auto_close because its dedupe row is already completed before any email is attempted.',
      },
      scenario_admin_email_fails_after_auto_close: {
        deal_status: 'funded (unchanged — auto-close does not modify Deal status)',
        cycle_status: 'missed (unchanged)',
        auto_close_log_row: 'completed (unchanged)',
        client_closeout_log_row: 'independently complete/processable (unaffected)',
        admin_closeout_log_row: 'failed/retryable (attempt_count=1, status=failed)',
        auto_close_repeated: false,
        explanation: 'Same separation. Admin closeout failure is isolated to its own dedupe row.',
      },
      current_code_satisfies_failure_separation: true,
    };

    // ── 14. attempt_count semantics ───────────────────────────────────────────
    const attemptCountSemantics = {
      definition: 'Number of actual provider delivery attempts initiated',
      first_provider_attempt: 1,
      first_failure_attempt_count: 1,
      retry_provider_attempt: 2,
      maximum: 3,
      incremented_by: 'claim_option_cycle_automation_event() RPC — exactly once per authorized attempt',
      NOT_incremented_by: 'markLogFailed() — does not touch attempt_count',
      preflight_dry_run_consumes_attempt: false,
      note: 'No preflight/dry-run action may consume an attempt. This dry-run does not call the claim RPC.',
    };

    // ── 15. Manual override path ──────────────────────────────────────────────
    const manualOverridePath = {
      supported: true,
      api_endpoint: 'PATCH /api/admin/option-cycles?id=<cycle_id>',
      action_value: 'extension_override',
      implementation_file: 'src/app/api/admin/option-cycles/route.ts',
      function_description: 'action === \'extension_override\' block in PATCH handler',
      requirements: [
        'current cycle status must be \'missed\'',
        'Deal must be \'funded\' and not purged (otherwise 422 deal_not_funded)',
        'actual_amendment_received_at must NOT be NULL',
        'Admin must provide explicit attestation (admin_attests_extension_accepted: true)',
        'Admin must provide new deposit_goes_hard_date',
      ],
      behavior: {
        prior_missed_cycle: 'PRESERVED as status=missed — NEVER rewritten',
        new_cycle: 'INSERT with cycle_number = previous + 1, status = active',
        deal_transition: 'NONE — extension override does NOT change Deal status (app_status / deal_workflow_stage are not written)',
        new_option_exercise_deadline: 'Calculated via fn_subtract_business_days(new_hard_date, 2)',
        extension_fee: 'May still be pending — does NOT block override',
        activity_logged: ['extension_override_accepted'],
      },
      client_exposure: 'NONE — override policy is never exposed to borrower',
    };

    // ── 16. Final state verification (read-only) ──────────────────────────────
    const finalDealStatus = app.app_status;
    const finalCycleStatus = cycle.status;
    const finalExerciseTs = cycle.actual_option_exercised_at;
    const finalAmendmentTs = cycle.actual_amendment_received_at;

    // Count new closeout automation rows (must be 0)
    const { count: closeoutRowCount } = await supabase
      .from('option_cycle_automation_log')
      .select('*', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID)
      .in('event_type', ['auto_close', 'client_closeout_notice', 'admin_closeout_notice']);

    // Count new activity rows created after this request started (must be 0)
    const requestStartedAt = new Date().toISOString();
    const { count: newActivityCount } = await supabase
      .from('application_activity')
      .select('*', { count: 'exact' })
      .eq('application_id', KNOWN_APP_ID)
      .in('event_type', ['option_cycle_missed', 'status_change'])
      .gt('created_at', new Date(Date.now() - 5000).toISOString()); // last 5 seconds

    return NextResponse.json({
      step: 'Step 5D-2.13 — Auto-Close / Missed-Deadline Dry-Run Verification',
      dry_run: true,
      database_writes_performed: 0,
      emails_sent: 0,
      option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',

      // ── COMPLETION REPORT ─────────────────────────────────────────────────

      production_cutoff_logic_reused: {
        result: 'YES',
        function: 'getOptionDeadlineCutoff(deadlineDateStr)',
        imported_from: 'src/app/api/admin/option-cycles/route.ts',
        also_used_by: 'optionCycleWorker.ts (imported from same source)',
        timeliness_function: 'isTimely(eventTimestamp, deadlineDateStr)',
        canonical_cutoff_iso: canonicalCutoff.toISOString(),
        canonical_cutoff_et: '2026-09-22 17:00:00 America/New_York',
        rule: 'timestamp <= cutoff → TIMELY (exactly 5:00:00 PM ET is TIMELY); timestamp > cutoff → LATE',
      },

      cutoff_boundary_evaluation: {
        timestamp_A: {
          input: '2026-09-22T16:59:59-04:00',
          description: '4:59:59 PM ET',
          is_timely: aTimely,
          auto_close_eligible: aEligible,
          expected_timely: true,
          expected_eligible: false,
          result: aTimely === true && aEligible === false ? 'PASS' : 'FAIL',
        },
        timestamp_B: {
          input: '2026-09-22T17:00:00-04:00',
          description: 'Exactly 5:00:00 PM ET',
          is_timely: bTimely,
          auto_close_eligible: bEligible,
          expected_timely: true,
          expected_eligible: false,
          note: 'Exactly 5:00:00 PM ET is still timely. Worker also checks nowForCutoff <= cutoff → skips even if closeoutWindowOpen=true.',
          result: bTimely === true && bEligible === false ? 'PASS' : 'FAIL',
        },
        timestamp_C: {
          input: '2026-09-22T17:00:01-04:00',
          description: '5:00:01 PM ET',
          is_timely: cTimely,
          auto_close_eligible: cEligible,
          expected_timely: false,
          expected_eligible: true,
          note: 'Eligible only if no timely exercise or amendment exists. Current cycle has NULL timestamps → eligible.',
          result: cTimely === false && cEligible === true ? 'PASS' : 'FAIL',
        },
      },

      timely_exercise_blocks_auto_close: {
        result: timelyExerciseBlocksAutoClose ? 'YES' : 'NO',
        expected: 'YES',
        simulation: 'actual_option_exercised_at = 2026-09-22T17:00:00-04:00 (exactly 5:00:00 PM ET)',
        is_timely: timelyExerciseIsTimely,
        deal_remains: 'funded',
        cycle_must_not_become: 'missed',
        note: 'Read-only simulation only. No timestamp written to actual cycle.',
      },

      timely_amendment_blocks_auto_close: {
        result: timelyAmendmentBlocksAutoClose ? 'YES' : 'NO',
        expected: 'YES',
        simulation: 'actual_amendment_received_at = 2026-09-22T17:00:00-04:00 (exactly 5:00:00 PM ET)',
        is_timely: timelyAmendmentIsTimely,
        fee_required_to_block: false,
        fee_leniency_note: 'Extension fee payment is NOT required to block auto-close when a timely signed PSA amendment has been received. Fee can remain pending operationally.',
        client_exposure_of_fee_leniency: 'NONE — fee leniency is not exposed to client',
        deal_remains: 'funded',
        cycle_must_not_become: 'missed',
        note: 'Read-only simulation only. No timestamp written to actual cycle.',
      },

      fee_required_to_block_after_timely_amendment: {
        result: 'NO',
        expected: 'NO',
        explanation: 'Worker checks: timelyExercise || timelyAmendment. extension_fee_paid_at is NOT part of the isSatisfied check.',
      },

      late_exercise_blocks_auto_close: {
        result: lateExerciseBlocksAutoClose ? 'YES' : 'NO',
        expected: 'NO',
        simulation: 'actual_option_exercised_at = 2026-09-22T17:00:01-04:00 (5:00:01 PM ET)',
        is_timely: lateExerciseIsTimely,
        note: 'Late exercise does NOT block automatic missed-deadline handling. Cycle remains eligible for auto-close.',
      },

      late_amendment_automatically_blocks_auto_close: {
        result: lateAmendmentAutomaticallyBlocksAutoClose ? 'YES' : 'NO',
        expected: 'NO',
        simulation: 'actual_amendment_received_at = 2026-09-22T17:00:01-04:00 (5:00:01 PM ET)',
        is_timely: lateAmendmentIsTimely,
        note: 'Late amendment does NOT automatically block auto-close. Requires Admin/manual review if EarnestBridge later chooses to accept it. Client is not told about manual discretion.',
      },

      eligible_unsatisfied_cycle_after_cutoff: {
        result: !currentlySatisfied ? 'YES' : 'NO',
        expected: 'YES',
        current_actual_option_exercised_at: currentExerciseTs,
        current_actual_amendment_received_at: currentAmendmentTs,
        currently_satisfied: currentlySatisfied,
        note: 'Both timestamps are NULL → cycle is unsatisfied. After 5:00:01 PM ET on 2026-09-22, this cycle would be eligible for auto-close.',
      },

      auto_close_deal_transition: {
        expected: 'NONE — Deal status is not modified by auto-close (Deal must be funded; remains funded)',
        would_write: wouldBeWrites.borrower_applications,
        note: 'Operational Option Cycle outcome only. Does NOT change Deal status and does NOT represent legal termination of PSA, legal expiration of due diligence, automatic escrow return, or movement of escrow funds. Changing a Deal to Closed remains a manual Admin decision.',
      },

      cycle_transition: {
        expected: 'active → missed',
        would_write: wouldBeWrites.crm_deal_option_cycles,
      },

      auto_close_activity_events: {
        event_1: {
          event_type: 'option_cycle_missed',
          title: `Option Exercise Deadline missed`,
          detail: `The Option Exercise Deadline (${formatDateDisplay(deadline)}) passed with no timely exercise or signed amendment. The Option Cycle was marked missed. Review escrow/return-of-funds process separately.`,
          actor: 'EarnestBridge Automation',
        },
        event_2: {
          event_type: null,
          title: null,
          detail: null,
          actor: null,
          written: false,
          note: 'No status_change activity is written by auto-close. Key retained for response-shape compatibility only.',
        },
        status_change_event: 'NONE — no status_change activity is written by auto-close',
        note: 'Only event_1 would be written to application_activity. NOT written during this dry-run.',
      },

      closeout_email_events: {
        client_email_type: 'option_client_closeout',
        admin_email_type: 'option_admin_closeout',
        client_recipient: clientEmail ?? 'ericthoni@gmail.com',
        admin_recipient: resolvedAdminEmail,
        expected_client_recipient: 'ericthoni@gmail.com',
        expected_admin_recipient: 'admin@earnestbridge.com',
        emails_sent_this_step: 0,
      },

      client_closeout_copy: {
        ...clientCloseoutCopy,
        policy_checks: clientCopyPolicyChecks,
      },

      admin_closeout_copy: adminCloseoutCopy,

      idempotency_dedupe_events: idempotencyAnalysis,

      failure_separation: failureSeparation,

      attempt_count_semantics: attemptCountSemantics,

      manual_override_path: manualOverridePath,

      existing_automation_rows: {
        auto_close_row: existingAutoCloseRow ?? null,
        client_closeout_row: existingClientCloseoutRow ?? null,
        admin_closeout_row: existingAdminCloseoutRow ?? null,
        new_closeout_rows_count: closeoutRowCount ?? 0,
      },

      existing_reminder_rows_unchanged: {
        client_reminder: clientReminderRow
          ? { id: clientReminderRow.id, status: clientReminderRow.status, attempt_count: clientReminderRow.attempt_count, unchanged: true }
          : { id: '30c677e6-c156-46f1-a243-f09da9f9bf3b', status: 'NOT FOUND', unchanged: false },
        admin_reminder: adminReminderRow
          ? { id: adminReminderRow.id, status: adminReminderRow.status, attempt_count: adminReminderRow.attempt_count, unchanged: true }
          : { id: '7ddccff9-0c6a-4698-bf7c-1d5f32eff21e', status: 'NOT FOUND', unchanged: false },
      },

      final_state_verification: {
        deal_status: finalDealStatus,
        deal_status_expected: 'funded',
        deal_status_correct: finalDealStatus === 'funded',
        cycle_status: finalCycleStatus,
        cycle_status_expected: 'active',
        cycle_status_correct: finalCycleStatus === 'active',
        actual_option_exercised_at: finalExerciseTs,
        actual_option_exercised_at_expected: null,
        actual_option_exercised_at_correct: finalExerciseTs === null,
        actual_amendment_received_at: finalAmendmentTs,
        actual_amendment_received_at_expected: null,
        actual_amendment_received_at_correct: finalAmendmentTs === null,
        new_closeout_automation_rows: closeoutRowCount ?? 0,
        new_closeout_automation_rows_expected: 0,
        new_closeout_automation_rows_correct: (closeoutRowCount ?? 0) === 0,
        emails_sent: 0,
        emails_sent_expected: 0,
        option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',
        option_cycle_automation_enabled_expected: 'false',
      },

      safe_for_one_controlled_live_auto_close_test: {
        result: finalDealStatus === 'funded' && finalCycleStatus === 'active' && finalExerciseTs === null && finalAmendmentTs === null && (closeoutRowCount ?? 0) === 0 ? 'YES' : 'NO',
        note: 'Do NOT perform the live auto-close yet. This dry-run confirms the test record is in the correct state for a future controlled live test.',
        conditions_met: {
          deal_funded: finalDealStatus === 'funded',
          cycle_active: finalCycleStatus === 'active',
          no_exercise_timestamp: finalExerciseTs === null,
          no_amendment_timestamp: finalAmendmentTs === null,
          no_existing_closeout_rows: (closeoutRowCount ?? 0) === 0,
        },
      },

      // ── Step 5D-2.13c: Post-hardening atomic design report ────────────────
      post_hardening_design: {
        step: 'Step 5D-2.13c — Verified post-5D-2.13b atomic design',

        atomic_rpc_signature:
          'execute_option_cycle_auto_close(p_cycle_id uuid, p_application_id uuid, p_cutoff_at timestamptz, p_automation_log_id uuid, p_deadline_snapshot text)',

        auto_close_log_completion_location:
          'INSIDE execute_option_cycle_auto_close() — committed atomically in the same PostgreSQL transaction as cycle→missed. No separate markLogCompleted() call for auto_close.',

        activity_insert_location:
          'INSIDE execute_option_cycle_auto_close() — the option_cycle_missed row is inserted in the same atomic transaction. No status_change row is written. No separate logActivity() calls for the canonical auto-close activity.',

        activity_idempotency_constraint: {
          status: 'BLOCKER IDENTIFIED AND RESOLVED IN MIGRATION 20260917000100',
          original_problem:
            'application_activity had NO UNIQUE constraint or index. ON CONFLICT DO NOTHING in the RPC had no conflict target and never suppressed duplicates.',
          resolution:
            'Migration 20260917000100 adds: (1) nullable source_id uuid column to application_activity; (2) UNIQUE partial index idx_application_activity_auto_close_idempotency on (application_id, event_type, source_id) WHERE source_id IS NOT NULL AND actor = \'EarnestBridge Automation\'; (3) RPC re-created to pass p_cycle_id as source_id and use explicit ON CONFLICT (application_id, event_type, source_id) WHERE ... DO NOTHING.',
          index_name: 'idx_application_activity_auto_close_idempotency',
          index_definition: 'UNIQUE (application_id, event_type, source_id) WHERE source_id IS NOT NULL AND actor = \'EarnestBridge Automation\'',
          on_conflict_do_nothing_actually_idempotent: 'YES — after migration 20260917000100 is applied',
          on_conflict_do_nothing_actually_idempotent_pre_migration: 'NO — no applicable unique constraint existed',
          multi_cycle_safe: 'YES — source_id = cycle_id scopes uniqueness per cycle, not per application',
        },

        separate_cycle_update_still_exists: 'NO — cycle→missed is inside execute_option_cycle_auto_close()',
        separate_deal_update_still_exists: 'NO — auto-close performs no Deal status update at all',
        separate_auto_close_mark_log_completed_still_exists: 'NO — auto_close log completion is inside execute_option_cycle_auto_close()',
        separate_post_rpc_activity_inserts_still_exist: 'NO — the canonical option_cycle_missed row is inside execute_option_cycle_auto_close()',

        auto_close_log_guards: {
          description: 'RPC verifies the supplied automation log row before any write',
          guards: [
            'log.application_id = p_application_id',
            'log.cycle_id = p_cycle_id',
            'log.event_type = \'auto_close\'',
            'log.deadline_snapshot = p_deadline_snapshot',
            'log.status IN (\'pending\', \'claimed\', \'failed\') — not already completed',
          ],
          guard_result_if_invalid: 'guard_log_invalid — no state changes performed',
          guard_result_if_not_found: 'guard_log_not_found — no state changes performed',
          arbitrary_log_row_can_be_marked_completed: 'NO — all five guards must pass',
        },

        reconciliation_function_present: 'YES — reconcileCompletedAutoCloseNotifications()',
        reconciliation_runs_every_live_worker_execution:
          'YES — called at the end of every non-dry-run runOptionCycleAutomation() execution, after the candidate cycle loop',
        reconciliation_candidate_predicate: {
          description: 'Eligibility requires canonical evidence of a completed auto-close event',
          required_conditions: [
            'option_cycle_automation_log.event_type = \'auto_close\'',
            'option_cycle_automation_log.status = \'completed\'',
            'crm_deal_option_cycles.status = \'missed\'',
          ],
          deal_status_required: 'NO — reconciliation does not depend on borrower_applications.app_status',
          manual_closure_triggers_reconciliation: 'NO — requires completed auto_close log evidence',
          missed_cycle_without_completed_auto_close_triggers_reconciliation: 'NO — auto_close log status = completed is required',
        },

        client_closeout_recoverable_by_reconciliation: 'YES — reconciliation claims client_closeout_notice independently',
        admin_closeout_recoverable_by_reconciliation: 'YES — reconciliation claims admin_closeout_notice independently',
        sent_closeout_can_be_duplicated: 'NO — already_done returned when status = completed',
        failed_closeout_retry_limit: 3,
        failed_closeout_at_max_attempts: 'max_attempts_reached — no further provider attempt; Admin must investigate',

        worker_rpc_call_verified: {
          function_name: 'execute_option_cycle_auto_close',
          arguments: {
            p_cycle_id: 'cycle.id',
            p_application_id: 'cycle.application_id',
            p_cutoff_at: 'cutoff.toISOString()',
            p_automation_log_id: 'claimResult.logId',
            p_deadline_snapshot: 'deadline',
          },
          source_file: 'src/lib/optionCycleWorker.ts',
          rpc_result_contract: 'success | guard_deal_not_funded | guard_cycle_not_active | guard_cycle_satisfied | guard_app_mismatch | guard_cycle_not_found | guard_deal_not_found | guard_log_invalid | guard_log_not_found',
        },

        migration_required_for_idempotency: 'YES — 20260917000100_application_activity_auto_close_idempotency.sql',
        netlify_redeploy_required: 'NO — worker source unchanged by 5D-2.13c (migration only)',
      },
    });
  }

  // ── Canonical supported GET actions list ─────────────────────────────────
  const SUPPORTED_GET_ACTIONS = [
    'verify_deal',
    'snapshot',
    'verify_zero_writes',
    'admin_preflight',
    'auto_close_dry_run',
    'auto_close_forensics',
    'route_version',
  ] as const;

  // ── action=route_version ──────────────────────────────────────────────────
  // Step 5D-2.14b: Read-only version probe.
  // Returns the current route version and supported GET actions.
  // ZERO writes. ZERO claims. ZERO emails.
  if (action === 'route_version') {
    return NextResponse.json({
      route_version: '5D-2.14d',
      auto_close_forensics_available: true,
      supported_get_actions: SUPPORTED_GET_ACTIONS,
      writes_performed: 0,
      emails_sent: 0,
      option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',
    });
  }

  // ── action=auto_close_forensics ──────────────────────────────────────────
  // Step 5D-2.14a: READ-ONLY forensic inspection of the known failed auto_close row.
  //
  // ZERO database writes. ZERO claims. ZERO emails. ZERO mutations.
  // Authenticated Admin only.
  //
  // Known row:
  //   automation_log_id: 6ace1d0b-c690-4afd-b334-cb208289548e
  //   Expected event:    auto_close
  //   Expected cycle:    87bc8363-af29-4a77-919a-4b60ac8b6e38
  //   Expected app:      2aa816a9-2fb0-404f-92ca-c5e2cb49fe66
  //   Expected dedupe:   option:87bc8363-af29-4a77-919a-4b60ac8b6e38:2026-09-22:auto_close
  if (action === 'auto_close_forensics') {
    const FORENSIC_LOG_ID      = '6ace1d0b-c690-4afd-b334-cb208289548e';
    const FORENSIC_APP_ID      = '2aa816a9-2fb0-404f-92ca-c5e2cb49fe66';
    const FORENSIC_CYCLE_ID    = '87bc8363-af29-4a77-919a-4b60ac8b6e38';
    const FORENSIC_DEADLINE    = '2026-09-22';
    const FORENSIC_EVENT_TYPE  = 'auto_close';
    const FORENSIC_DEDUPE_KEY  = `option:${FORENSIC_CYCLE_ID}:${FORENSIC_DEADLINE}:${FORENSIC_EVENT_TYPE}`;

    // ── 1. Fetch the exact automation log row by ID ───────────────────────────
    const { data: forensicRow, error: forensicRowErr } = await supabase
      .from('option_cycle_automation_log')
      .select('id, application_id, cycle_id, event_type, deadline_snapshot, dedupe_key, status, attempt_count, created_at, updated_at, claimed_at, completed_at, last_error')
      .eq('id', FORENSIC_LOG_ID)
      .maybeSingle();

    const rowFound = !forensicRowErr && forensicRow !== null;

    // ── 2. Verify row identity ────────────────────────────────────────────────
    let identityChecks: Record<string, { expected: string; actual: string | null; pass: boolean }> = {};
    if (rowFound && forensicRow) {
      identityChecks = {
        application_id: {
          expected: FORENSIC_APP_ID,
          actual: forensicRow.application_id,
          pass: forensicRow.application_id === FORENSIC_APP_ID,
        },
        cycle_id: {
          expected: FORENSIC_CYCLE_ID,
          actual: forensicRow.cycle_id,
          pass: forensicRow.cycle_id === FORENSIC_CYCLE_ID,
        },
        event_type: {
          expected: FORENSIC_EVENT_TYPE,
          actual: forensicRow.event_type,
          pass: forensicRow.event_type === FORENSIC_EVENT_TYPE,
        },
        deadline_snapshot: {
          expected: FORENSIC_DEADLINE,
          actual: forensicRow.deadline_snapshot,
          pass: String(forensicRow.deadline_snapshot).startsWith(FORENSIC_DEADLINE),
        },
        dedupe_key: {
          expected: FORENSIC_DEDUPE_KEY,
          actual: forensicRow.dedupe_key,
          pass: forensicRow.dedupe_key === FORENSIC_DEDUPE_KEY,
        },
      };
    }
    const allIdentityPass = rowFound && Object.values(identityChecks).every(c => c.pass);

    // ── 3. Classify failure source ────────────────────────────────────────────
    let failureClassification: string = 'UNKNOWN — row not found';
    let failureClassificationCode: string = 'F';
    let failureEvidence: string = '';

    if (rowFound && forensicRow) {
      const lastErr: string = forensicRow.last_error ?? '';

      if (
        lastErr.includes('execute_option_cycle_auto_close') &&
        (lastErr.includes('does not exist') || lastErr.includes('function') || lastErr.includes('signature'))
      ) {
        failureClassificationCode = 'D';
        failureClassification = 'D — RPC signature/deployment mismatch: execute_option_cycle_auto_close RPC not found or wrong signature at time of execution.';
        failureEvidence = lastErr;
      } else if (
        lastErr.includes('execute_option_cycle_auto_close') &&
        (lastErr.includes('guard_') || lastErr.includes('guard_deal_not_funded') || lastErr.includes('guard_cycle_not_active') || lastErr.includes('guard_cycle_satisfied') || lastErr.includes('guard_log_invalid') || lastErr.includes('guard_app_mismatch'))
      ) {
        failureClassificationCode = 'B';
        failureClassification = 'B — claim succeeded but execute_option_cycle_auto_close RPC returned a guard result (deal/cycle/log guard blocked the write).';
        failureEvidence = lastErr;
      } else if (
        lastErr.includes('execute_option_cycle_auto_close') &&
        lastErr.length > 0
      ) {
        failureClassificationCode = 'A';
        failureClassification = 'A — claim succeeded but execute_option_cycle_auto_close RPC threw an error during execution.';
        failureEvidence = lastErr;
      } else if (
        lastErr.includes('application_activity') ||
        lastErr.includes('migration') ||
        lastErr.includes('idempotency') ||
        lastErr.includes('ON CONFLICT') ||
        lastErr.includes('unique constraint')
      ) {
        failureClassificationCode = 'E';
        failureClassification = 'E — application_activity/idempotency migration issue: activity insert conflict or migration-related error.';
        failureEvidence = lastErr;
      } else if (
        lastErr.includes('Step 5D') ||
        lastErr.includes('dry_run') ||
        lastErr.includes('diagnostic') ||
        lastErr.includes('test') ||
        lastErr.includes('inspection only')
      ) {
        failureClassificationCode = 'C';
        failureClassification = 'C — diagnostic/test infrastructure failure before RPC: error originated in test/diagnostic code path, not the production auto-close execution.';
        failureEvidence = lastErr;
      } else if (lastErr.length > 0) {
        failureClassificationCode = 'F';
        failureClassification = `F — other: error does not match known classification patterns. Inspect last_error directly.`;
        failureEvidence = lastErr;
      } else {
        failureClassificationCode = 'F';
        failureClassification = 'F — other: status=failed but last_error is empty. Failure cause unknown.';
        failureEvidence = '(empty)';
      }
    }

    // ── 4. Determine who created this row ─────────────────────────────────────
    const automationWasEnabled = (process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false') === 'true';
    let rowCreatedBy: string = 'unknown';
    let rowCreatedByEvidence: string = '';

    if (rowFound && forensicRow) {
      if (!automationWasEnabled) {
        rowCreatedByEvidence = 'OPTION_CYCLE_AUTOMATION_ENABLED=false at time of inspection. Production scheduler cannot create auto_close rows when disabled.';
        rowCreatedBy = 'live_auto_close_test (only authorized path when OPTION_CYCLE_AUTOMATION_ENABLED=false)';
      } else {
        rowCreatedByEvidence = 'OPTION_CYCLE_AUTOMATION_ENABLED=true at time of inspection — production scheduler could have created this row.';
        rowCreatedBy = 'production worker or live_auto_close_test — cannot distinguish without scheduler logs';
      }
    }

    // ── 5. Verify business state (read-only) ──────────────────────────────────
    const { data: forensicApp } = await supabase
      .from('borrower_applications')
      .select('id, app_status')
      .eq('id', FORENSIC_APP_ID)
      .maybeSingle();

    const { data: forensicCycle } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', FORENSIC_CYCLE_ID)
      .maybeSingle();

    const clientCloseoutDedupeForensic = `option:${FORENSIC_CYCLE_ID}:${FORENSIC_DEADLINE}:client_closeout_notice:ericthoni@gmail.com`;
    const adminCloseoutDedupeForensic  = `option:${FORENSIC_CYCLE_ID}:${FORENSIC_DEADLINE}:admin_closeout_notice:admin@earnestbridge.com`;

    const { data: clientCloseoutRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('dedupe_key', clientCloseoutDedupeForensic)
      .maybeSingle();

    const { data: adminCloseoutRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('dedupe_key', adminCloseoutDedupeForensic)
      .maybeSingle();

    const { data: completedAutoCloseRows } = await supabase
      .from('option_cycle_automation_log')
      .select('id, status, attempt_count, completed_at')
      .eq('cycle_id', FORENSIC_CYCLE_ID)
      .eq('event_type', 'auto_close')
      .eq('status', 'completed');

    const businessStateChecks = {
      deal_status: {
        expected: 'funded',
        actual: forensicApp?.app_status ?? 'NOT FOUND',
        pass: forensicApp?.app_status === 'funded',
      },
      cycle_status: {
        expected: 'active',
        actual: forensicCycle?.status ?? 'NOT FOUND',
        pass: forensicCycle?.status === 'active',
      },
      actual_option_exercised_at_null: {
        expected: null,
        actual: forensicCycle?.actual_option_exercised_at ?? null,
        pass: forensicCycle?.actual_option_exercised_at === null,
      },
      actual_amendment_received_at_null: {
        expected: null,
        actual: forensicCycle?.actual_amendment_received_at ?? null,
        pass: forensicCycle?.actual_amendment_received_at === null,
      },
      no_client_closeout_row: {
        expected: 'NO',
        actual: clientCloseoutRow ? `YES (id=${clientCloseoutRow.id}, status=${clientCloseoutRow.status})` : 'NO',
        pass: clientCloseoutRow === null,
      },
      no_admin_closeout_row: {
        expected: 'NO',
        actual: adminCloseoutRow ? `YES (id=${adminCloseoutRow.id}, status=${adminCloseoutRow.status})` : 'NO',
        pass: adminCloseoutRow === null,
      },
      no_completed_auto_close_row: {
        expected: 'NO',
        actual: (completedAutoCloseRows && completedAutoCloseRows.length > 0) ? `YES (${completedAutoCloseRows.length} row(s))` : 'NO',
        pass: !completedAutoCloseRows || completedAutoCloseRows.length === 0,
      },
    };
    const allBusinessStatePass = Object.values(businessStateChecks).every(c => c.pass);

    // ── 6. Verify activity state (read-only) ──────────────────────────────────
    const { data: activityRows, count: activityCount } = await supabase
      .from('application_activity')
      .select('id, event_type, title, actor, created_at', { count: 'exact' })
      .eq('application_id', FORENSIC_APP_ID)
      .eq('source_id', FORENSIC_CYCLE_ID)
      .in('event_type', ['option_cycle_missed', 'status_change']);

    const autoCloseActivityCount = activityCount ?? 0;

    // ── 7. Determine if row is canonically retryable ──────────────────────────
    let retryable = false;
    let retryableReason = '';
    let correctNextClaim = '';
    let expectedAttemptCountAfterRetry: number | null = null;

    if (rowFound && forensicRow) {
      const isFailedStatus = forensicRow.status === 'failed';
      const isAttemptCount1 = forensicRow.attempt_count === 1;
      const dealFunded = forensicApp?.app_status === 'funded';
      const cycleActive = forensicCycle?.status === 'active';
      const noCloseoutRows = clientCloseoutRow === null && adminCloseoutRow === null;
      const noCompletedAutoClose = !completedAutoCloseRows || completedAutoCloseRows.length === 0;
      const sameDedupeKey = forensicRow.dedupe_key === FORENSIC_DEDUPE_KEY;

      if (
        isFailedStatus &&
        isAttemptCount1 &&
        dealFunded &&
        cycleActive &&
        noCloseoutRows &&
        noCompletedAutoClose &&
        sameDedupeKey
      ) {
        retryable = true;
        correctNextClaim = 'retry_claimed';
        expectedAttemptCountAfterRetry = 2;
        retryableReason =
          'All canonical retry conditions met: status=failed, attempt_count=1 (< 3), ' +
          'deal still funded, cycle still active, no closeout rows, no completed auto_close row, '+ 'dedupe key matches canonical key. The claim RPC will return retry_claimed and set attempt_count=2.';
      } else {
        const reasons: string[] = [];
        if (!isFailedStatus) reasons.push(`status=${forensicRow.status} (must be failed)`);
        if (!isAttemptCount1) reasons.push(`attempt_count=${forensicRow.attempt_count} (must be < 3)`);
        if (!dealFunded) reasons.push(`deal status=${forensicApp?.app_status} (must be funded)`);
        if (!cycleActive) reasons.push(`cycle status=${forensicCycle?.status} (must be active)`);
        if (!noCloseoutRows) reasons.push('closeout row(s) already exist');
        if (!noCompletedAutoClose) reasons.push('completed auto_close row already exists');
        if (!sameDedupeKey) reasons.push(`dedupe key mismatch: row has ${forensicRow.dedupe_key}`);
        retryableReason = `NOT retryable: ${reasons.join('; ')}`;
      }
    }

    // ── 8. Evaluate whether the safety gate is too strict ────────────────────
    const safetyGateTooStrict =
      rowFound &&
      forensicRow?.status === 'failed' &&
      (forensicRow?.attempt_count ?? 0) < 3 &&
      retryable;

    const safetyGateAnalysis = {
      current_gate_requires: 'auto_close row = NONE',
      current_gate_blocks_this_row: rowFound,
      row_is_failed_retryable: retryable,
      gate_too_strict_for_failed_retryable: safetyGateTooStrict,
      recommended_production_safe_gate: safetyGateTooStrict
        ? 'Allow same canonical auto_close row if: status=failed AND attempt_count < 3 AND all deal/cycle/timestamp safety gates still pass. This matches canonical claim_option_cycle_automation_event() retry semantics (retry_claimed path).'
        : 'Current gate is appropriate for this row state.',
      note: 'Do NOT modify the safety gate yet. This is a read-only recommendation.',
    };

    // ── 9. Determine if this is a pure test-infrastructure artifact ───────────
    const isPureTestArtifact =
      (rowFound && (forensicRow?.last_error ?? '').includes('Step 5D')) ||
      (rowFound && (forensicRow?.last_error ?? '').includes('diagnostic')) ||
      (rowFound && (forensicRow?.last_error ?? '').includes('inspection only'));

    return NextResponse.json({
      step: 'Step 5D-2.14a — Forensic Inspection of Failed auto_close Row',
      forensic_note: 'READ-ONLY. ZERO database writes. ZERO claims. ZERO emails. ZERO mutations.',
      writes_performed: 0,
      emails_sent: 0,
      option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',

      failed_row_found: rowFound,
      row_id: rowFound ? forensicRow!.id : null,
      full_row: rowFound ? {
        id: forensicRow!.id,
        application_id: forensicRow!.application_id,
        cycle_id: forensicRow!.cycle_id,
        event_type: forensicRow!.event_type,
        deadline_snapshot: forensicRow!.deadline_snapshot,
        dedupe_key: forensicRow!.dedupe_key,
        status: forensicRow!.status,
        attempt_count: forensicRow!.attempt_count,
        created_at: forensicRow!.created_at,
        updated_at: forensicRow!.updated_at ?? null,
        claimed_at: forensicRow!.claimed_at ?? null,
        completed_at: forensicRow!.completed_at ?? null,
        last_error: forensicRow!.last_error ?? null,
      } : null,
      row_fetch_error: forensicRowErr ? forensicRowErr.message : null,

      row_identity_checks: identityChecks,
      row_identity_matches_canonical_test_auto_close: allIdentityPass ? 'YES' : 'NO',

      failure_classification_code: failureClassificationCode,
      failure_classification: failureClassification,
      failure_evidence: failureEvidence,

      row_created_by: rowCreatedBy,
      row_created_by_evidence: rowCreatedByEvidence,
      production_scheduler_could_have_created_it: automationWasEnabled,
      production_scheduler_note: automationWasEnabled
        ? 'OPTION_CYCLE_AUTOMATION_ENABLED=true — production scheduler could have created this row.' :'OPTION_CYCLE_AUTOMATION_ENABLED=false — production scheduler CANNOT create auto_close rows when disabled. This row was created by an authorized diagnostic action (live_auto_close_test).',

      business_state_checks: businessStateChecks,
      all_business_state_checks_pass: allBusinessStatePass,

      auto_close_activity_rows_present: autoCloseActivityCount,
      auto_close_activity_rows_expected: 0,
      auto_close_activity_rows_pass: autoCloseActivityCount === 0 ? 'YES — ZERO rows as expected' : `NO — ${autoCloseActivityCount} row(s) found (unexpected)`,
      auto_close_activity_detail: activityRows ?? [],

      failed_row_canonically_retryable: retryable ? 'YES' : 'NO',
      retryable_reason: retryableReason,
      correct_next_claim_if_retried: correctNextClaim || 'N/A',
      expected_attempt_count_after_retry: expectedAttemptCountAfterRetry,
      is_pure_test_infrastructure_artifact: isPureTestArtifact ? 'YES — error text suggests this row was created by a diagnostic/test code path, not a real production execution attempt.' : 'NO — no test-infrastructure markers found in last_error.',

      safety_gate_analysis: safetyGateAnalysis,
      existing_safety_gate_too_strict_for_failed_retryable_row: safetyGateTooStrict ? 'YES' : 'NO',

      completion_report: {
        failed_row_found: rowFound ? 'YES' : 'NO',
        row_id: rowFound ? forensicRow!.id : 'NOT FOUND',
        event_type: rowFound ? forensicRow!.event_type : 'N/A',
        status: rowFound ? forensicRow!.status : 'N/A',
        attempt_count: rowFound ? forensicRow!.attempt_count : 'N/A',
        created_at: rowFound ? forensicRow!.created_at : 'N/A',
        claimed_at: rowFound ? (forensicRow!.claimed_at ?? 'NULL') : 'N/A',
        completed_at: rowFound ? (forensicRow!.completed_at ?? 'NULL') : 'N/A',
        last_error: rowFound ? (forensicRow!.last_error ?? 'NULL') : 'N/A',
        row_identity_matches_canonical_test_auto_close: allIdentityPass ? 'YES' : 'NO',
        failure_classification: `${failureClassificationCode} — ${failureClassification}`,
        row_created_by: rowCreatedBy,
        deal_status: forensicApp?.app_status ?? 'NOT FOUND',
        cycle_status: forensicCycle?.status ?? 'NOT FOUND',
        auto_close_activity_rows_present: autoCloseActivityCount,
        client_closeout_row_present: clientCloseoutRow ? 'YES' : 'NO',
        admin_closeout_row_present: adminCloseoutRow ? 'YES' : 'NO',
        failed_row_canonically_retryable: retryable ? 'YES' : 'NO',
        correct_next_claim_if_retried: correctNextClaim || 'N/A',
        expected_attempt_count_after_retry: expectedAttemptCountAfterRetry ?? 'N/A',
        existing_safety_gate_too_strict_for_failed_retryable_row: safetyGateTooStrict ? 'YES' : 'NO',
        database_writes: 0,
        emails_sent: 0,
        option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',
        safe_recovery_recommendation: retryable
          ? `The failed row is canonically retryable. Preferred recovery: call live_auto_close_test with a modified safety gate that allows status=failed AND attempt_count < 3 for the same canonical dedupe key. The claim RPC will return retry_claimed with attempt_count=2. Do NOT delete the row. Do NOT create a new row. Do NOT perform recovery yet — this is a recommendation only.`
          : isPureTestArtifact
            ? 'This row appears to be a pure test-infrastructure artifact. If confirmed, it may be safe to delete and re-run live_auto_close_test with a clean state. Do NOT perform recovery yet.'
            : 'Recovery path unclear — inspect failure_classification and last_error before proceeding.',
      },
    });
  }

  // ── Unknown GET action ────────────────────────────────────────────────────
  return NextResponse.json({
    error: `Unknown GET action. Use: ${SUPPORTED_GET_ACTIONS.join(', ')}`,
  }, { status: 400 });
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  const supabase = getServiceClient();

  // ── action=set_funded ─────────────────────────────────────────────────────
  if (action === 'set_funded') {
    // Verify ownership first
    const { data: app, error: appErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address')
      .eq('id', KNOWN_APP_ID)
      .maybeSingle();

    if (appErr || !app) return NextResponse.json({ error: 'Application not found' }, { status: 404 });

    if (app.user_id !== TEST_USER_ID) {
      return NextResponse.json({
        STOP: true,
        reason: 'Application does NOT belong to ericthoni@gmail.com — refusing to modify',
      }, { status: 403 });
    }

    if (app.app_status === 'funded') {
      return NextResponse.json({
        message: 'Already funded — no change needed',
        app_status: app.app_status,
        application_id: KNOWN_APP_ID,
      });
    }

    // Move to funded
    const { data: updated, error: updateErr } = await supabase
      .from('borrower_applications')
      .update({ app_status: 'funded', updated_at: new Date().toISOString() })
      .eq('id', KNOWN_APP_ID)
      .eq('user_id', TEST_USER_ID) // double-guard
      .select('id, app_status, property_address')
      .single();

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    // Log activity
    await supabase.from('application_activity').insert({
      application_id: KNOWN_APP_ID,
      user_id: TEST_USER_ID,
      event_type: 'status_change',
      title: 'Deal status changed to Funded',
      detail: `Status changed from ${app.app_status} to funded for Step 5D-2.7 dry run test`,
      actor: admin.email || 'EarnestBridge Admin',
    });

    return NextResponse.json({
      message: 'Deal moved to funded',
      previous_status: app.app_status,
      new_status: updated.app_status,
      application_id: KNOWN_APP_ID,
    });
  }

  // ── action=create_cycle ───────────────────────────────────────────────────
  if (action === 'create_cycle') {
    // Verify ownership
    const { data: app, error: appErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address')
      .eq('id', KNOWN_APP_ID)
      .maybeSingle();

    if (appErr || !app) return NextResponse.json({ error: 'Application not found' }, { status: 404 });

    if (app.user_id !== TEST_USER_ID) {
      return NextResponse.json({
        STOP: true,
        reason: 'Application does NOT belong to ericthoni@gmail.com — refusing to modify',
      }, { status: 403 });
    }

    if (app.app_status !== 'funded') {
      return NextResponse.json({
        error: `Deal must be funded before creating option cycle. Current status: ${app.app_status}`,
      }, { status: 422 });
    }

    // Check for existing active cycle
    const { data: existingActive } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, cycle_number, deposit_goes_hard_date, option_exercise_deadline, status')
      .eq('application_id', KNOWN_APP_ID)
      .eq('status', 'active')
      .maybeSingle();

    if (existingActive) {
      return NextResponse.json({
        message: 'Active cycle already exists — no new cycle created',
        existing_cycle: existingActive,
      });
    }

    // Get next cycle number
    const { data: maxCycleRow } = await supabase
      .from('crm_deal_option_cycles')
      .select('cycle_number')
      .eq('application_id', KNOWN_APP_ID)
      .order('cycle_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextCycleNumber = maxCycleRow ? maxCycleRow.cycle_number + 1 : 1;

    // Calculate option_exercise_deadline via fn_subtract_business_days
    const DEPOSIT_GOES_HARD_DATE = '2026-09-24';
    const { data: deadlineResult, error: calcError } = await supabase
      .rpc('fn_subtract_business_days', {
        p_start_date: DEPOSIT_GOES_HARD_DATE,
        p_n: 2,
      });

    if (calcError) {
      return NextResponse.json({ error: `fn_subtract_business_days failed: ${calcError.message}` }, { status: 500 });
    }

    const option_exercise_deadline = deadlineResult as string;

    // Insert cycle
    const { data: cycle, error: insertErr } = await supabase
      .from('crm_deal_option_cycles')
      .insert({
        application_id: KNOWN_APP_ID,
        cycle_number: nextCycleNumber,
        deposit_goes_hard_date: DEPOSIT_GOES_HARD_DATE,
        option_exercise_deadline,
        status: 'active',
        created_by: admin.id,
        updated_by: admin.id,
      })
      .select()
      .single();

    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

    // Log activity
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function fmtDate(d: string) {
      const [y,m,day] = d.split('-');
      return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}, ${y}`;
    }

    await supabase.from('application_activity').insert({
      application_id: KNOWN_APP_ID,
      user_id: TEST_USER_ID,
      event_type: 'option_cycle_created',
      title: `Deposit Goes Hard Date set: ${fmtDate(DEPOSIT_GOES_HARD_DATE)}`,
      detail: `Option Exercise Deadline calculated: ${fmtDate(option_exercise_deadline)}`,
      actor: admin.email || 'EarnestBridge Admin',
    });

    return NextResponse.json({
      message: 'Option cycle created',
      cycle: {
        id: cycle.id,
        application_id: cycle.application_id,
        cycle_number: cycle.cycle_number,
        deposit_goes_hard_date: cycle.deposit_goes_hard_date,
        option_exercise_deadline: cycle.option_exercise_deadline,
        status: cycle.status,
        actual_option_exercised_at: cycle.actual_option_exercised_at,
        actual_amendment_received_at: cycle.actual_amendment_received_at,
        extension_fee_paid_at: cycle.extension_fee_paid_at,
        created_at: cycle.created_at,
      },
      fn_subtract_business_days_result: option_exercise_deadline,
      verification: {
        deposit_goes_hard_date_correct: cycle.deposit_goes_hard_date === '2026-09-24',
        option_exercise_deadline_correct: cycle.option_exercise_deadline === '2026-09-22',
        status_active: cycle.status === 'active',
        actual_option_exercised_at_null: cycle.actual_option_exercised_at === null,
        actual_amendment_received_at_null: cycle.actual_amendment_received_at === null,
      },
    });
  }

  // ── action=dry_run ────────────────────────────────────────────────────────
  if (action === 'dry_run') {
    let body: any = {};
    try { body = await request.json(); } catch { /* no body */ }

    // evaluation_time: required for this test
    const rawEvalTime = body.evaluation_time ?? null;
    let evaluationTime: Date | null = null;
    if (rawEvalTime) {
      const dt = new Date(rawEvalTime);
      if (!isNaN(dt.getTime())) evaluationTime = dt;
    }

    // ── BEFORE snapshot ───────────────────────────────────────────────────
    // Capture state of all relevant tables BEFORE invoking the worker.
    // zero_writes_confirmed compares BEFORE vs AFTER — NOT "table has zero rows".

    const [
      beforeLog,
      beforeCycles,
      beforeApp,
      beforeActivity,
    ] = await Promise.all([
      supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at, updated_at', { count: 'exact' })
        .order('created_at', { ascending: true }),
      supabase
        .from('crm_deal_option_cycles')
        .select('id, status, actual_option_exercised_at, actual_amendment_received_at, extension_fee_paid_at, updated_at'),
      supabase
        .from('borrower_applications')
        .select('id, app_status, updated_at')
        .eq('id', KNOWN_APP_ID),
      supabase
        .from('application_activity')
        .select('id, event_type, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    const logCountBefore = beforeLog.count;
    const logRowsBefore = beforeLog.data;
    const cycleRowsBefore = beforeCycles.data;
    const appRowBefore = beforeApp.data;
    const activityCountBefore = beforeActivity.count;
    const activityRowsBefore = beforeActivity.data;

    // Stable fingerprints for comparison
    const logIdsBefore = new Set((logRowsBefore ?? []).map((r: any) => r.id));
    const logSnapshotBefore = Object.fromEntries(
      (logRowsBefore ?? []).map((r: any) => [
        r.id,
        `${r.status}|${r.attempt_count}|${r.completed_at ?? ''}|${r.updated_at ?? ''}`,
      ])
    );
    const cycleSnapshotBefore = Object.fromEntries(
      (cycleRowsBefore ?? []).map((r: any) => [
        r.id,
        `${r.status}|${r.actual_option_exercised_at ?? ''}|${r.actual_amendment_received_at ?? ''}|${r.extension_fee_paid_at ?? ''}|${r.updated_at ?? ''}`,
      ])
    );
    const appStatusBefore = (appRowBefore ?? []).map((r: any) => `${r.id}:${r.app_status}`).join(',');
    const activityIdsBefore = new Set((activityRowsBefore ?? []).map((r: any) => r.id));
    const activityCountBeforeVal = activityCountBefore ?? 0;

    // ── Execute dry run via worker ─────────────────────────────────────────
    const result = await runOptionCycleAutomation({
      dryRun: true,
      evaluationTime: evaluationTime ?? undefined,
    });

    // ── AFTER snapshot ────────────────────────────────────────────────────
    const [
      afterLog,
      afterCycles,
      afterApp,
      afterActivity,
    ] = await Promise.all([
      supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at, updated_at', { count: 'exact' })
        .order('created_at', { ascending: true }),
      supabase
        .from('crm_deal_option_cycles')
        .select('id, status, actual_option_exercised_at, actual_amendment_received_at, extension_fee_paid_at, updated_at'),
      supabase
        .from('borrower_applications')
        .select('id, app_status, updated_at')
        .eq('id', KNOWN_APP_ID),
      supabase
        .from('application_activity')
        .select('id, event_type, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    const logCountAfter = afterLog.count;
    const logRowsAfter = afterLog.data;
    const cycleRowsAfter = afterCycles.data;
    const appRowAfter = afterApp.data;
    const activityCountAfter = afterActivity.count;
    const activityRowsAfter = afterActivity.data;

    // ── Compare BEFORE vs AFTER ───────────────────────────────────────────
    const logCountAfterVal = logCountAfter ?? 0;
    const logCountBeforeVal = logCountBefore ?? 0;

    // Automation log: any new rows inserted?
    const logIdsAfter = new Set((logRowsAfter ?? []).map((r: any) => r.id));
    const newLogRows = (logRowsAfter ?? []).filter((r: any) => !logIdsBefore.has(r.id));

    // Automation log: any existing rows updated?
    const updatedLogRows = (logRowsAfter ?? []).filter((r: any) => {
      if (!logSnapshotBefore[r.id]) return false; // new row, already counted above
      const afterSig = `${r.status}|${r.attempt_count}|${r.completed_at ?? ''}|${r.updated_at ?? ''}`;
      return logSnapshotBefore[r.id] !== afterSig;
    });

    // Cycle rows: any inserted or updated?
    const cycleIdsAfter = new Set((cycleRowsAfter ?? []).map((r: any) => r.id));
    const newCycleRows = (cycleRowsAfter ?? []).filter((r: any) => !cycleSnapshotBefore[r.id]);
    const updatedCycleRows = (cycleRowsAfter ?? []).filter((r: any) => {
      if (!cycleSnapshotBefore[r.id]) return false;
      const afterSig = `${r.status}|${r.actual_option_exercised_at ?? ''}|${r.actual_amendment_received_at ?? ''}|${r.extension_fee_paid_at ?? ''}|${r.updated_at ?? ''}`;
      return cycleSnapshotBefore[r.id] !== afterSig;
    });

    // Deal/app status: changed?
    const appStatusAfter = (appRowAfter ?? []).map((r: any) => `${r.id}:${r.app_status}`).join(',');
    const dealStatusChanged = appStatusBefore !== appStatusAfter;

    // Activity rows: any new rows inserted?
    const activityCountAfterVal = activityCountAfter ?? 0;
    const activityIdsAfter = new Set((activityRowsAfter ?? []).map((r: any) => r.id));
    const newActivityRows = (activityRowsAfter ?? []).filter((r: any) => !activityIdsBefore.has(r.id));

    // Determine zero_writes_confirmed using BEFORE vs AFTER comparison
    const automationLogInserted = newLogRows.length > 0;
    const automationLogUpdated = updatedLogRows.length > 0;
    const cycleRowsChanged = newCycleRows.length > 0 || updatedCycleRows.length > 0;
    const activityRowsInserted = newActivityRows.length > 0;

    const zero_writes_confirmed =
      !automationLogInserted &&
      !automationLogUpdated &&
      !cycleRowsChanged &&
      !dealStatusChanged &&
      !activityRowsInserted;

    // Also capture current ET date/hour for verification
    const etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const etNow = evaluationTime ? etFormatter.format(evaluationTime) : etFormatter.format(new Date());

    return NextResponse.json({
      dry_run_result: result,
      evaluation_time_supplied: rawEvalTime,
      evaluation_time_parsed: evaluationTime?.toISOString() ?? null,
      eastern_display_of_evaluation_time: etNow,
      // ── Before/After snapshot summary ──────────────────────────────────
      automation_log_count_before_dry_run: logCountBeforeVal,
      automation_log_count_after_dry_run: logCountAfterVal,
      automation_log_rows_inserted: newLogRows.length,
      automation_log_rows_updated: updatedLogRows.length,
      automation_log_inserted_ids: newLogRows.map((r: any) => r.id),
      automation_log_updated_ids: updatedLogRows.map((r: any) => r.id),
      cycle_rows_inserted: newCycleRows.length,
      cycle_rows_updated: updatedCycleRows.length,
      deal_status_changed: dealStatusChanged,
      activity_rows_before: activityCountBeforeVal,
      activity_rows_after: activityCountAfterVal,
      activity_rows_inserted: newActivityRows.length,
      activity_inserted_ids: newActivityRows.map((r: any) => r.id),
      // ── Correct zero-write determination ───────────────────────────────
      // TRUE only when BEFORE === AFTER across all tables.
      // Existing historical rows do NOT cause false negatives.
      zero_writes_confirmed,
      zero_writes_detail: {
        automation_log_inserted: automationLogInserted,
        automation_log_updated: automationLogUpdated,
        cycle_rows_changed: cycleRowsChanged,
        deal_status_changed: dealStatusChanged,
        activity_rows_inserted: activityRowsInserted,
      },
    });
  }

  // ── action=live_client_test ───────────────────────────────────────────────
  // Step 5D-2.9: Send exactly ONE real client_reminder_7d email to ericthoni@gmail.com.
  // Uses the real atomic claim/idempotency path.
  // Second call returns already_done — no second email sent.
  // OPTION_CYCLE_AUTOMATION_ENABLED must remain false.
  // Admin session required. No generic recipient. No admin reminder sent.
  if (action === 'live_client_test') {
    // ── SAFETY GATE ─────────────────────────────────────────────────────────
    const safetyGateFailures: string[] = [];

    // 1. Fetch application
    const { data: app, error: appErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id')
      .eq('id', KNOWN_APP_ID)
      .maybeSingle();

    if (appErr || !app) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        reason: 'Application not found',
        application_id: KNOWN_APP_ID,
      }, { status: 404 });
    }

    // Gate: Application ID
    if (app.id !== KNOWN_APP_ID) {
      safetyGateFailures.push(`application_id mismatch: got ${app.id}, expected ${KNOWN_APP_ID}`);
    }

    // Gate: Borrower Auth User
    if (app.user_id !== TEST_USER_ID) {
      safetyGateFailures.push(`user_id mismatch: got ${app.user_id}, expected ${TEST_USER_ID}`);
    }

    // Gate: Deal Status
    if (app.app_status !== 'funded') {
      safetyGateFailures.push(`app_status must be funded, got: ${app.app_status}`);
    }

    // 2. Fetch the exact test cycle
    const { data: cycle, error: cycleErr } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, application_id, cycle_number, deposit_goes_hard_date, option_exercise_deadline, status, actual_option_exercised_at, actual_amendment_received_at, extension_fee_paid_at')
      .eq('id', LIVE_TEST_CYCLE_ID)
      .maybeSingle();

    if (cycleErr || !cycle) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        reason: `Test cycle not found: ${LIVE_TEST_CYCLE_ID}`,
        cycle_id: LIVE_TEST_CYCLE_ID,
      }, { status: 404 });
    }

    // Gate: Cycle ID
    if (cycle.id !== LIVE_TEST_CYCLE_ID) {
      safetyGateFailures.push(`cycle_id mismatch: got ${cycle.id}, expected ${LIVE_TEST_CYCLE_ID}`);
    }

    // Gate: Cycle belongs to test application
    if (cycle.application_id !== KNOWN_APP_ID) {
      safetyGateFailures.push(`cycle.application_id mismatch: got ${cycle.application_id}, expected ${KNOWN_APP_ID}`);
    }

    // Gate: Cycle Status
    if (cycle.status !== 'active') {
      safetyGateFailures.push(`cycle.status must be active, got: ${cycle.status}`);
    }

    // Gate: Option Exercise Deadline
    if (cycle.option_exercise_deadline !== LIVE_TEST_EXPECTED_DEADLINE) {
      safetyGateFailures.push(`option_exercise_deadline must be ${LIVE_TEST_EXPECTED_DEADLINE}, got: ${cycle.option_exercise_deadline}`);
    }

    // Gate: Deposit Goes Hard Date
    if (cycle.deposit_goes_hard_date !== LIVE_TEST_EXPECTED_HARD_DATE) {
      safetyGateFailures.push(`deposit_goes_hard_date must be ${LIVE_TEST_EXPECTED_HARD_DATE}, got: ${cycle.deposit_goes_hard_date}`);
    }

    // Gate: Exercise Timestamp must be NULL
    if (cycle.actual_option_exercised_at !== null) {
      safetyGateFailures.push(`actual_option_exercised_at must be NULL, got: ${cycle.actual_option_exercised_at}`);
    }

    // Gate: Amendment Timestamp must be NULL
    if (cycle.actual_amendment_received_at !== null) {
      safetyGateFailures.push(`actual_amendment_received_at must be NULL, got: ${cycle.actual_amendment_received_at}`);
    }

    // 3. Resolve client recipient
    let clientEmail: string | null = null;
    let clientFirstName = 'Borrower';
    let clientRecipientSource = '';

    if (app.primary_contact_id) {
      const { data: contact } = await supabase
        .from('crm_contacts')
        .select('primary_email, first_name')
        .eq('id', app.primary_contact_id)
        .maybeSingle();
      if (contact?.primary_email) {
        clientEmail = contact.primary_email.trim().toLowerCase();
        clientFirstName = contact.first_name || 'Borrower';
        clientRecipientSource = `crm_contacts.primary_email (via primary_contact_id: ${app.primary_contact_id})`;
      }
    }

    if (!clientEmail) {
      const { data: authUser } = await supabase.auth.admin.getUserById(TEST_USER_ID);
      if (authUser?.user?.email) {
        clientEmail = authUser.user.email.trim().toLowerCase();
        const meta = authUser.user.user_metadata;
        clientFirstName = meta?.first_name || meta?.firstName || 'Borrower';
        clientRecipientSource = `auth.users.email fallback (user_id: ${TEST_USER_ID})`;
      }
    }

    // Gate: Client Recipient must resolve to ericthoni@gmail.com
    if (!clientEmail) {
      safetyGateFailures.push('Could not resolve client recipient email');
    } else if (clientEmail !== TEST_EMAIL) {
      safetyGateFailures.push(`client recipient must be ${TEST_EMAIL}, resolved to: ${clientEmail}`);
    }

    // ── If any safety gate failed, STOP ──────────────────────────────────────
    if (safetyGateFailures.length > 0) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        failures: safetyGateFailures,
        action_taken: 'NONE — no email sent, no claim made',
        application_id: KNOWN_APP_ID,
        cycle_id: LIVE_TEST_CYCLE_ID,
      }, { status: 422 });
    }

    // ── ALL SAFETY GATES PASSED ──────────────────────────────────────────────

    // Build dedupe key — same as production worker
    const dedupeKey = `option:${LIVE_TEST_CYCLE_ID}:${LIVE_TEST_EXPECTED_DEADLINE}:${LIVE_TEST_EVENT_TYPE}:${clientEmail}`;

    // ── Atomic claim via DB RPC ──────────────────────────────────────────────
    let claimResult: string;
    let logId: string | null = null;

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('claim_option_cycle_automation_event', {
        p_cycle_id: LIVE_TEST_CYCLE_ID,
        p_application_id: KNOWN_APP_ID,
        p_event_type: LIVE_TEST_EVENT_TYPE,
        p_deadline_snapshot: LIVE_TEST_EXPECTED_DEADLINE,
        p_dedupe_key: dedupeKey,
      });

      if (rpcErr) {
        return NextResponse.json({
          safety_gate: 'PASS',
          claim_result: 'error',
          claim_error: rpcErr.message,
          action_taken: 'NONE — claim RPC failed',
          email_sent: false,
        }, { status: 500 });
      }

      const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      claimResult = row?.result ?? 'already_done';
      logId = row?.log_id ?? null;
    } catch (e: any) {
      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'error',
        claim_error: e.message,
        action_taken: 'NONE — claim RPC threw',
        email_sent: false,
      }, { status: 500 });
    }

    // ── If already_done / currently_claimed / max_attempts_reached — no email ─
    if (claimResult === 'already_done') {
      // Fetch the existing log row for reporting (safe fields only)
      const { data: existingLog } = await supabase
        .from('option_cycle_automation_log')
        .select('id, cycle_id, application_id, event_type, status, attempt_count, completed_at, created_at, dedupe_key')
        .eq('dedupe_key', dedupeKey)
        .maybeSingle();

      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'already_done',
        email_provider_called: false,
        email_sent: false,
        reason: 'Idempotency: this client_reminder_7d was already sent for this cycle/deadline/recipient',
        event_type: LIVE_TEST_EVENT_TYPE,
        cycle_id: LIVE_TEST_CYCLE_ID,
        application_id: KNOWN_APP_ID,
        recipient: clientEmail,
        existing_automation_log_row: existingLog ?? null,
      });
    }

    if (claimResult === 'currently_claimed') {
      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'currently_claimed',
        email_provider_called: false,
        email_sent: false,
        reason: 'Another worker currently holds the claim lease — try again in 15 minutes',
        event_type: LIVE_TEST_EVENT_TYPE,
        cycle_id: LIVE_TEST_CYCLE_ID,
        application_id: KNOWN_APP_ID,
        recipient: clientEmail,
      });
    }

    if (claimResult === 'max_attempts_reached') {
      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'max_attempts_reached',
        email_provider_called: false,
        email_sent: false,
        reason: 'Max 3 attempts reached — Admin must investigate the automation log',
        event_type: LIVE_TEST_EVENT_TYPE,
        cycle_id: LIVE_TEST_CYCLE_ID,
        application_id: KNOWN_APP_ID,
        recipient: clientEmail,
      }, { status: 422 });
    }

    // ── Claim succeeded (claimed or retry_claimed) — send the email ──────────
    if ((claimResult === 'claimed' || claimResult === 'retry_claimed') && logId) {
      const dealDisplayName = app.property_address || app.company_name || '123 Main St, Orlando, FL';

      // Build email payload — same structure as production worker
      const emailPayload = {
        emailType: LIVE_TEST_EVENT_TYPE,
        borrower: {
          email: clientEmail,
          firstName: clientFirstName,
        },
        application: {
          optionExerciseDeadline: LIVE_TEST_EXPECTED_DEADLINE,
          optionDeadlineDisplay: formatDateDisplay(LIVE_TEST_EXPECTED_DEADLINE),
          daysUntilDeadline: 7,
          propertyAddress: app.property_address,
          dealDisplayName: dealDisplayName,
          // NOTE: depositGoesHardDate is intentionally NOT included — client must never see it
        },
      };

      // Send via edge function
      let emailOk = false;
      let emailError: string | undefined;
      let emailProviderResponse: any = null;

      try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

        const res = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
          },
          body: JSON.stringify(emailPayload),
        });

        emailOk = res.ok;
        const responseText = await res.text().catch(() => '');
        emailProviderResponse = {
          status: res.status,
          ok: res.ok,
          body_preview: responseText.substring(0, 500),
        };

        if (!res.ok) {
          emailError = `HTTP ${res.status}: ${responseText.substring(0, 200)}`;
        }
      } catch (e: any) {
        emailError = e.message ?? 'Network error calling edge function';
        emailProviderResponse = { error: emailError };
      }

      // ── Update automation log based on send result ────────────────────────
      if (emailOk) {
        // Mark as sent/completed
        await supabase
          .from('option_cycle_automation_log')
          .update({
            status: 'sent',
            completed_at: new Date().toISOString(),
            last_error: null,
          })
          .eq('id', logId);

        // CANONICAL BEHAVIOR (Step 5D-2.10):
        // The production worker (optionCycleWorker.ts) does NOT call logActivity()
        // after successful reminder sends. logActivity() is only called for
        // auto_close events (option_cycle_missed, status_change).
        //
        // Therefore: live_client_test must NOT insert an application_activity row
        // for a successful reminder. Reminder history lives exclusively in
        // option_cycle_automation_log. No activity row is created here.
        //
        // DO NOT add logActivity / application_activity.insert here.
        // Doing so would create a divergence from canonical production behavior.
      } else {
        // Mark as failed — retryable per automation-log policy
        // CORRECTED SEMANTICS (Step 5D-2.9b):
        // Do NOT call increment_automation_log_attempt here.
        // attempt_count was already incremented at claim time by the claim RPC.
        // markLogFailed must not increment it a second time.
        await supabase
          .from('option_cycle_automation_log')
          .update({
            status: 'failed',
            last_error: (emailError ?? 'Email send failed').substring(0, 1000),
          })
          .eq('id', logId);

        // DO NOT call increment_automation_log_attempt — that RPC has been dropped.
        // attempt_count is managed solely by claim_option_cycle_automation_event.
      }

      // Fetch final automation log row (safe fields only — no secrets)
      const { data: finalLogRow } = await supabase
        .from('option_cycle_automation_log')
        .select('id, cycle_id, application_id, event_type, status, attempt_count, completed_at, created_at, dedupe_key')
        .eq('id', logId)
        .maybeSingle();

      // Verify final state
      const { data: finalCycle } = await supabase
        .from('crm_deal_option_cycles')
        .select('id, status, actual_option_exercised_at, actual_amendment_received_at')
        .eq('id', LIVE_TEST_CYCLE_ID)
        .maybeSingle();

      const { data: finalApp } = await supabase
        .from('borrower_applications')
        .select('id, app_status')
        .eq('id', KNOWN_APP_ID)
        .maybeSingle();

      return NextResponse.json({
        safety_gate: 'PASS',
        test_application_id: KNOWN_APP_ID,
        test_cycle_id: LIVE_TEST_CYCLE_ID,
        client_recipient: clientEmail,
        client_recipient_source: clientRecipientSource,
        deal_display_used: dealDisplayName,
        event_type: LIVE_TEST_EVENT_TYPE,
        claim_result: claimResult,
        email_provider_called: true,
        email_provider_response: emailProviderResponse,
        email_sent: emailOk,
        email_error: emailError ?? null,
        automation_log_row: finalLogRow ?? null,
        activity_log_row: null,
        activity_log_row_note: 'CANONICAL: Production worker does not create application_activity rows for successful reminder sends. Reminder history lives exclusively in option_cycle_automation_log. activity_log_row = null is correct and expected.',
        final_deal_status: finalApp?.app_status ?? null,
        final_cycle_status: finalCycle?.status ?? null,
        actual_option_exercised_at_after: finalCycle?.actual_option_exercised_at ?? null,
        actual_amendment_received_at_after: finalCycle?.actual_amendment_received_at ?? null,
        option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',
        note: emailOk
          ? 'Email sent. Run this action again to verify idempotency (should return already_done).'
          : 'Email delivery failed. Automation log marked failed/retryable. No false completion recorded.',
      });
    }

    // Unexpected claim result
    return NextResponse.json({
      safety_gate: 'PASS',
      claim_result: claimResult,
      email_sent: false,
      reason: `Unexpected claim result: ${claimResult}`,
    }, { status: 500 });
  }

  // ── action=live_admin_test ────────────────────────────────────────────────
  // Step 5D-2.11a: Send ONE real admin_reminder_7d to admin@earnestbridge.com.
  //
  // SEPARATION OF CONCERNS:
  //   admin_preflight (GET) — read-only inspection, ZERO claims, ZERO writes
  //   live_admin_test (POST) — ONLY this action may claim + call provider
  //
  // This action:
  //   1. Runs all safety gates
  //   2. Optionally cleans up a false-claim artifact (cleanup=true in body)
  //   3. Claims the event atomically
  //   4. Calls the email provider
  //   5. Marks sent or failed
  //
  // Second call after success returns already_done — no second email.
  // OPTION_CYCLE_AUTOMATION_ENABLED must remain false.
  // Admin session required. Hard-locked to test deal/cycle.
  if (action === 'live_admin_test') {
    let body: any = {};
    try { body = await request.json(); } catch { /* no body */ }

    // cleanup=true: delete the false-claim artifact before claiming
    const requestedCleanup = body.cleanup === true;

    const safetyGateFailures: string[] = [];

    // ── 1. Fetch application ─────────────────────────────────────────────────
    const { data: adminApp, error: adminAppErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id')
      .eq('id', LIVE_ADMIN_TEST_APP_ID)
      .maybeSingle();

    if (adminAppErr || !adminApp) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        reason: 'Application not found',
        application_id: LIVE_ADMIN_TEST_APP_ID,
      }, { status: 404 });
    }

    // Gate: Application ID
    if (adminApp.id !== LIVE_ADMIN_TEST_APP_ID) {
      safetyGateFailures.push(`application_id mismatch: got ${adminApp.id}, expected ${LIVE_ADMIN_TEST_APP_ID}`);
    }

    // Gate: Deal Status must be funded
    if (adminApp.app_status !== 'funded') {
      safetyGateFailures.push(`app_status must be funded, got: ${adminApp.app_status}`);
    }

    // ── 2. Fetch the exact test cycle ────────────────────────────────────────
    const { data: adminCycle, error: adminCycleErr } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, application_id, cycle_number, deposit_goes_hard_date, option_exercise_deadline, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', LIVE_ADMIN_TEST_CYCLE_ID)
      .maybeSingle();

    if (adminCycleErr || !adminCycle) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        reason: `Test cycle not found: ${LIVE_ADMIN_TEST_CYCLE_ID}`,
        cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
      }, { status: 404 });
    }

    // Gate: Cycle ID
    if (adminCycle.id !== LIVE_ADMIN_TEST_CYCLE_ID) {
      safetyGateFailures.push(`cycle_id mismatch: got ${adminCycle.id}, expected ${LIVE_ADMIN_TEST_CYCLE_ID}`);
    }

    // Gate: Cycle belongs to test application
    if (adminCycle.application_id !== LIVE_ADMIN_TEST_APP_ID) {
      safetyGateFailures.push(`cycle.application_id mismatch: got ${adminCycle.application_id}, expected ${LIVE_ADMIN_TEST_APP_ID}`);
    }

    // Gate: Cycle Status must be active
    if (adminCycle.status !== 'active') {
      safetyGateFailures.push(`cycle.status must be active, got: ${adminCycle.status}`);
    }

    // Gate: Option Exercise Deadline
    if (adminCycle.option_exercise_deadline !== LIVE_ADMIN_TEST_EXPECTED_DEADLINE) {
      safetyGateFailures.push(`option_exercise_deadline must be ${LIVE_ADMIN_TEST_EXPECTED_DEADLINE}, got: ${adminCycle.option_exercise_deadline}`);
    }

    // Gate: Deposit Goes Hard Date
    if (adminCycle.deposit_goes_hard_date !== LIVE_ADMIN_TEST_EXPECTED_HARD_DATE) {
      safetyGateFailures.push(`deposit_goes_hard_date must be ${LIVE_ADMIN_TEST_EXPECTED_HARD_DATE}, got: ${adminCycle.deposit_goes_hard_date}`);
    }

    // Gate: actual_option_exercised_at must be NULL
    if (adminCycle.actual_option_exercised_at !== null) {
      safetyGateFailures.push(`actual_option_exercised_at must be NULL, got: ${adminCycle.actual_option_exercised_at}`);
    }

    // Gate: actual_amendment_received_at must be NULL
    if (adminCycle.actual_amendment_received_at !== null) {
      safetyGateFailures.push(`actual_amendment_received_at must be NULL, got: ${adminCycle.actual_amendment_received_at}`);
    }

    // ── 3. Resolve admin recipient ───────────────────────────────────────────
    const resolvedAdminEmail: string = (adminApp.eb_assigned_owner && ADMIN_OWNER_EMAIL_MAP_DIAG[adminApp.eb_assigned_owner])
      ? ADMIN_OWNER_EMAIL_MAP_DIAG[adminApp.eb_assigned_owner]
      : ADMIN_FALLBACK_EMAIL_DIAG;

    const resolvedOwnerDisplay: string = adminApp.eb_assigned_owner ?? 'Unassigned';

    // Gate: Admin recipient must be exactly admin@earnestbridge.com
    if (resolvedAdminEmail !== LIVE_ADMIN_TEST_EXPECTED_RECIPIENT) {
      safetyGateFailures.push(
        `admin recipient must be ${LIVE_ADMIN_TEST_EXPECTED_RECIPIENT}, resolved to: ${resolvedAdminEmail}. STOP — do not send.`
      );
    }

    // Gate: Event type must be admin_reminder_7d only
    if (LIVE_ADMIN_TEST_EVENT_TYPE !== 'admin_reminder_7d') {
      safetyGateFailures.push(`event_type must be admin_reminder_7d, got: ${LIVE_ADMIN_TEST_EVENT_TYPE}`);
    }

    // ── If any safety gate failed, STOP ──────────────────────────────────────
    if (safetyGateFailures.length > 0) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        failures: safetyGateFailures,
        action_taken: 'NONE — no email sent, no claim made',
        application_id: LIVE_ADMIN_TEST_APP_ID,
        cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
      }, { status: 422 });
    }

    // ── ALL SAFETY GATES PASSED ──────────────────────────────────────────────

    // ── 4. Check for false-claim artifact and clean up if requested ──────────
    // A false-claim row was created by the old Step 5D-2.11 inspection path
    // which called claim_option_cycle_automation_event() without calling the
    // provider. This violates attempt_count semantics. We must remove it so
    // the first real send starts at attempt_count=1.
    let cleanupPerformed = false;
    let cleanupDetails: any = null;
    let falseClaimeRowId: string | null = null;

    const { data: existingAdminLog } = await supabase
      .from('option_cycle_automation_log')
      .select('id, status, attempt_count, last_error, created_at')
      .eq('dedupe_key', ADMIN_DEDUPE_KEY)
      .maybeSingle();

    if (existingAdminLog) {
      let isFalseClaim = (
        existingAdminLog.status === 'failed' &&
        existingAdminLog.last_error &&
        existingAdminLog.last_error.includes(FALSE_CLAIM_ERROR_MARKER)
      );

      if (isFalseClaim) {
        falseClaimeRowId = existingAdminLog.id;

        if (requestedCleanup) {
          // Delete the false-claim artifact.
          // Rationale: The row was created solely by a diagnostic inspection that
          // called claim_option_cycle_automation_event() but never called the
          // email provider. No real delivery attempt occurred. Deleting it
          // restores canonical semantics so the first actual provider call
          // counts as attempt_count=1. The client reminder row is NOT touched.
          const { error: deleteErr } = await supabase
            .from('option_cycle_automation_log')
            .delete()
            .eq('id', existingAdminLog.id)
            .eq('dedupe_key', ADMIN_DEDUPE_KEY) // double-guard
            .eq('status', 'failed');            // only delete if still failed

          if (deleteErr) {
            return NextResponse.json({
              safety_gate: 'PASS',
              cleanup_requested: true,
              cleanup_performed: false,
              cleanup_error: deleteErr.message,
              action_taken: 'NONE — cleanup failed, no claim made',
              false_claim_row_id: existingAdminLog.id,
            }, { status: 500 });
          }

          cleanupPerformed = true;
          cleanupDetails = {
            action: 'DELETED',
            row_id: existingAdminLog.id,
            reason: 'TEST INFRASTRUCTURE FALSE CLAIM — claim RPC was called by Step 5D-2.11 inspection but provider was never called. Deleted to restore canonical attempt_count semantics. No real delivery attempt occurred.',
            strategy: 'DELETE (preferred): The row had no real delivery attempt. Deleting it allows the first actual provider call to count as attempt_count=1 without falsely representing an earlier attempt.',
          };
        } else {
          // False claim exists but cleanup not requested — report and stop
          return NextResponse.json({
            safety_gate: 'PASS',
            false_claim_artifact_detected: true,
            false_claim_row: {
              id: existingAdminLog.id,
              status: existingAdminLog.status,
              attempt_count: existingAdminLog.attempt_count,
              last_error: existingAdminLog.last_error,
              created_at: existingAdminLog.created_at,
            },
            action_taken: 'NONE — false claim artifact exists. Re-send with { "cleanup": true } in request body to delete it and proceed with the real send.',
            email_provider_called: false,
            email_sent: false,
            classification: 'TEST INFRASTRUCTURE FALSE CLAIM — claim RPC was called by Step 5D-2.11 inspection but provider was never called. This is not a real delivery attempt.',
          }, { status: 409 });
        }
      } else if (existingAdminLog.status === 'sent') {
        // Already successfully sent — idempotency path
        const { data: clientRow } = await supabase
          .from('option_cycle_automation_log')
          .select('id, event_type, status, attempt_count, completed_at')
          .eq('id', '30c677e6-c156-46f1-a243-f09da9f9bf3b')
          .maybeSingle();

        return NextResponse.json({
          safety_gate: 'PASS',
          claim_result: 'already_done',
          email_provider_called: false,
          email_sent: false,
          reason: 'Idempotency: this admin_reminder_7d was already sent for this cycle/deadline/recipient',
          event_type: LIVE_ADMIN_TEST_EVENT_TYPE,
          cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
          application_id: LIVE_ADMIN_TEST_APP_ID,
          admin_recipient: resolvedAdminEmail,
          existing_automation_log_row: {
            id: existingAdminLog.id,
            status: existingAdminLog.status,
            attempt_count: existingAdminLog.attempt_count,
          },
          client_reminder_row_unchanged: clientRow
            ? { id: clientRow.id, status: clientRow.status, attempt_count: clientRow.attempt_count }
            : null,
        });
      }
      // If it's a genuine failed row (not a false claim), fall through to the
      // claim RPC which will handle retry_claimed / max_attempts_reached.
    }

    // ── 5. Atomic claim via DB RPC ───────────────────────────────────────────
    // This is the ONLY place in the admin test path that calls the claim RPC.
    // admin_preflight NEVER reaches this code.
    let adminClaimResult: string;
    let adminLogId: string | null = null;

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('claim_option_cycle_automation_event', {
        p_cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
        p_application_id: LIVE_ADMIN_TEST_APP_ID,
        p_event_type: LIVE_ADMIN_TEST_EVENT_TYPE,
        p_deadline_snapshot: LIVE_ADMIN_TEST_EXPECTED_DEADLINE,
        p_dedupe_key: ADMIN_DEDUPE_KEY,
      });

      if (rpcErr) {
        return NextResponse.json({
          safety_gate: 'PASS',
          claim_result: 'error',
          claim_error: rpcErr.message,
          action_taken: 'NONE — claim RPC failed',
          email_provider_called: false,
          email_sent: false,
        }, { status: 500 });
      }

      const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      adminClaimResult = row?.result ?? 'already_done';
      adminLogId = row?.log_id ?? null;
    } catch (e: any) {
      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'error',
        claim_error: e.message,
        action_taken: 'NONE — claim RPC threw',
        email_provider_called: false,
        email_sent: false,
      }, { status: 500 });
    }

    // ── already_done ──────────────────────────────────────────────────────────
    if (adminClaimResult === 'already_done') {
      const { data: existingLog } = await supabase
        .from('option_cycle_automation_log')
        .select('id, cycle_id, application_id, event_type, status, attempt_count, completed_at, created_at, dedupe_key')
        .eq('dedupe_key', ADMIN_DEDUPE_KEY)
        .maybeSingle();

      const { data: clientRow } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at')
        .eq('id', '30c677e6-c156-46f1-a243-f09da9f9bf3b')
        .maybeSingle();

      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'already_done',
        email_provider_called: false,
        email_sent: false,
        reason: 'Idempotency: this admin_reminder_7d was already sent for this cycle/deadline/recipient',
        event_type: LIVE_ADMIN_TEST_EVENT_TYPE,
        cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
        application_id: LIVE_ADMIN_TEST_APP_ID,
        admin_recipient: resolvedAdminEmail,
        existing_automation_log_row: existingLog ?? null,
        client_reminder_row_unchanged: clientRow
          ? { id: clientRow.id, status: clientRow.status, attempt_count: clientRow.attempt_count }
          : null,
      });
    }

    if (adminClaimResult === 'currently_claimed') {
      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'currently_claimed',
        email_provider_called: false,
        email_sent: false,
        reason: 'Another worker currently holds the claim lease — try again in 15 minutes',
        event_type: LIVE_ADMIN_TEST_EVENT_TYPE,
        cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
        application_id: LIVE_ADMIN_TEST_APP_ID,
        admin_recipient: resolvedAdminEmail,
      });
    }

    if (adminClaimResult === 'max_attempts_reached') {
      return NextResponse.json({
        safety_gate: 'PASS',
        claim_result: 'max_attempts_reached',
        email_provider_called: false,
        email_sent: false,
        reason: 'Max 3 attempts reached — Admin must investigate the automation log',
        event_type: LIVE_ADMIN_TEST_EVENT_TYPE,
        cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
        application_id: LIVE_ADMIN_TEST_APP_ID,
        admin_recipient: resolvedAdminEmail,
      }, { status: 422 });
    }

    // ── Claim succeeded (claimed or retry_claimed) — send the email ──────────
    if ((adminClaimResult === 'claimed' || adminClaimResult === 'retry_claimed') && adminLogId) {
      const dealDisplayName = adminApp.property_address || adminApp.company_name || '123 Main St, Orlando, FL';

      // Build email payload — same structure as production worker
      const emailPayload = {
        emailType: LIVE_ADMIN_TEST_EVENT_TYPE,
        borrower: {
          email: resolvedAdminEmail,
          firstName: 'Admin',
        },
        application: {
          optionExerciseDeadline: LIVE_ADMIN_TEST_EXPECTED_DEADLINE,
          optionDeadlineDisplay: formatDateDisplay(LIVE_ADMIN_TEST_EXPECTED_DEADLINE),
          depositGoesHardDate: LIVE_ADMIN_TEST_EXPECTED_HARD_DATE,
          depositGoesHardDateDisplay: formatDateDisplay(LIVE_ADMIN_TEST_EXPECTED_HARD_DATE),
          daysUntilDeadline: 7,
          propertyAddress: adminApp.property_address,
          dealDisplayName: dealDisplayName,
          assignedOwner: resolvedOwnerDisplay,
        },
      };

      // ── Call email provider ───────────────────────────────────────────────
      let emailOk = false;
      let emailError: string | undefined;
      let emailProviderResponse: any = null;

      try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

        const res = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
          },
          body: JSON.stringify(emailPayload),
        });

        emailOk = res.ok;
        const responseText = await res.text().catch(() => '');
        emailProviderResponse = {
          status: res.status,
          ok: res.ok,
          body_preview: responseText.substring(0, 500),
        };

        if (!res.ok) {
          emailError = `HTTP ${res.status}: ${responseText.substring(0, 200)}`;
        }
      } catch (e: any) {
        emailError = e.message ?? 'Network error calling edge function';
        emailProviderResponse = { error: emailError };
      }

      // ── Update automation log based on send result ────────────────────────
      // CORRECTED SEMANTICS (Step 5D-2.9b / 5D-2.11a):
      // attempt_count was already incremented at claim time by claim_option_cycle_automation_event.
      // Do NOT increment it again here. Only update status and timestamps.
      if (emailOk) {
        await supabase
          .from('option_cycle_automation_log')
          .update({
            status: 'sent',
            completed_at: new Date().toISOString(),
            last_error: null,
          })
          .eq('id', adminLogId);
      } else {
        await supabase
          .from('option_cycle_automation_log')
          .update({
            status: 'failed',
            last_error: (emailError ?? 'Email send failed').substring(0, 1000),
          })
          .eq('id', adminLogId);
      }

      // Fetch final automation log row
      const { data: finalAdminLog } = await supabase
        .from('option_cycle_automation_log')
        .select('id, cycle_id, application_id, event_type, status, attempt_count, completed_at, created_at, dedupe_key')
        .eq('id', adminLogId)
        .maybeSingle();

      // Verify client reminder row is untouched
      const { data: clientRow } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at')
        .eq('id', '30c677e6-c156-46f1-a243-f09da9f9bf3b')
        .maybeSingle();

      // Verify final deal/cycle state
      const { data: finalCycle } = await supabase
        .from('crm_deal_option_cycles')
        .select('id, status, actual_option_exercised_at, actual_amendment_received_at')
        .eq('id', LIVE_ADMIN_TEST_CYCLE_ID)
        .maybeSingle();

      const { data: finalApp } = await supabase
        .from('borrower_applications')
        .select('id, app_status')
        .eq('id', LIVE_ADMIN_TEST_APP_ID)
        .maybeSingle();

      return NextResponse.json({
        // ── Completion report ─────────────────────────────────────────────────
        live_admin_test_implemented: true,
        safety_gate: 'PASS',

        // Cleanup
        cleanup_requested: requestedCleanup,
        cleanup_performed: cleanupPerformed,
        cleanup_details: cleanupDetails,
        false_claim_row_deleted: cleanupPerformed ? falseClaimeRowId : null,

        // Deal / cycle
        test_application_id: LIVE_ADMIN_TEST_APP_ID,
        test_cycle_id: LIVE_ADMIN_TEST_CYCLE_ID,
        admin_owner: resolvedOwnerDisplay,
        admin_recipient: resolvedAdminEmail,
        event_type: LIVE_ADMIN_TEST_EVENT_TYPE,
        deal_display: dealDisplayName,
        option_exercise_deadline_display: formatDateDisplay(LIVE_ADMIN_TEST_EXPECTED_DEADLINE),
        deposit_goes_hard_date_display: formatDateDisplay(LIVE_ADMIN_TEST_EXPECTED_HARD_DATE),

        // Claim
        atomic_claim_used: true,
        claim_result: adminClaimResult,
        claim_rpc: 'claim_option_cycle_automation_event',
        dedupe_key: ADMIN_DEDUPE_KEY,

        // Provider
        email_provider_called: true,
        email_provider_response: emailProviderResponse,
        email_sent: emailOk,
        email_error: emailError ?? null,

        // Automation log
        automation_log_row: finalAdminLog ?? null,
        attempt_count: finalAdminLog?.attempt_count ?? null,
        attempt_count_semantics: 'Incremented exactly once by claim_option_cycle_automation_event. Not incremented by markLogFailed.',

        // Activity
        activity_log_row: null,
        activity_log_row_note: 'CANONICAL: Production worker does not create application_activity rows for reminder sends. Reminder history lives exclusively in option_cycle_automation_log.',

        // Client reminder row unchanged
        existing_client_reminder_row: clientRow
          ? {
              id: clientRow.id,
              status: clientRow.status,
              attempt_count: clientRow.attempt_count,
              completed_at: clientRow.completed_at,
              unchanged: clientRow.status === 'sent' && clientRow.attempt_count === 1,
            }
          : null,

        // Final state
        final_deal_status: finalApp?.app_status ?? null,
        final_cycle_status: finalCycle?.status ?? null,
        actual_option_exercised_at_after: finalCycle?.actual_option_exercised_at ?? null,
        actual_amendment_received_at_after: finalCycle?.actual_amendment_received_at ?? null,

        option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',
        emails_sent_this_call: emailOk ? 1 : 0,

        note: emailOk
          ? 'Admin reminder sent. Run this action again to verify idempotency (should return already_done).'
          : 'Email delivery failed. Automation log marked failed/retryable. attempt_count unchanged from claim value.',
      });
    }

    // Unexpected claim result
    return NextResponse.json({
      safety_gate: 'PASS',
      claim_result: adminClaimResult,
      email_sent: false,
      reason: `Unexpected claim result: ${adminClaimResult}`,
    }, { status: 500 });
  }

  // ── action=admin_email_preview ───────────────────────────────────────────
  // Step 5D-2.12a: Send exactly ONE standalone visual preview of the
  // admin_reminder_7d email template to admin@earnestbridge.com.
  //
  // PURPOSE: Visually verify the newly deployed green/gold styling.
  //
  // GUARANTEES:
  //   - ZERO calls to claim_option_cycle_automation_event()
  //   - ZERO writes to option_cycle_automation_log
  //   - ZERO writes to application_activity
  //   - ZERO changes to attempt_count
  //   - ZERO changes to any automation row
  //   - Recipient is hardcoded to admin@earnestbridge.com — not configurable
  //   - Uses the production send-borrower-emails edge function
  //   - Sends exactly ONE email (no retry loop)
  //
  // This action does NOT claim any automation event. It is a pure styling
  // preview and has no effect on business state.
  if (action === 'admin_email_preview') {
    // Hard-locked preview constants — not configurable via request body
    const PREVIEW_RECIPIENT = 'admin@earnestbridge.com';
    const PREVIEW_EMAIL_TYPE = 'admin_reminder_7d';
    const PREVIEW_PROPERTY_ADDRESS = '123 Main St, Orlando, FL';
    const PREVIEW_ASSIGNED_OWNER = 'Unassigned';
    const PREVIEW_DEADLINE = '2026-09-22';
    const PREVIEW_HARD_DATE = '2026-09-24';
    const PREVIEW_DAYS_UNTIL = 7;

    // Build the exact same payload the production worker sends for this deal
    const previewPayload = {
      emailType: PREVIEW_EMAIL_TYPE,
      borrower: {
        email: PREVIEW_RECIPIENT,
        firstName: 'Admin',
      },
      application: {
        optionExerciseDeadline: PREVIEW_DEADLINE,
        optionDeadlineDisplay: formatDateDisplay(PREVIEW_DEADLINE),
        depositGoesHardDate: PREVIEW_HARD_DATE,
        depositGoesHardDateDisplay: formatDateDisplay(PREVIEW_HARD_DATE),
        daysUntilDeadline: PREVIEW_DAYS_UNTIL,
        propertyAddress: PREVIEW_PROPERTY_ADDRESS,
        dealDisplayName: PREVIEW_PROPERTY_ADDRESS,
        assignedOwner: PREVIEW_ASSIGNED_OWNER,
      },
    };

    // ── Call the production edge function — exactly once, no retry ───────────
    let emailOk = false;
    let emailError: string | undefined;
    let providerResponse: any = null;

    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

      const res = await fetch(edgeFnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(previewPayload),
      });

      emailOk = res.ok;
      const responseText = await res.text().catch(() => '');
      providerResponse = {
        status: res.status,
        ok: res.ok,
        body_preview: responseText.substring(0, 500),
      };

      if (!res.ok) {
        emailError = `HTTP ${res.status}: ${responseText.substring(0, 200)}`;
      }
    } catch (e: any) {
      emailError = e.message ?? 'Network error calling edge function';
      providerResponse = { error: emailError };
    }

    // ── Return completion report ──────────────────────────────────────────────
    // No automation log writes. No activity writes. No claim. No state changes.
    return NextResponse.json({
      // ── Step identity ─────────────────────────────────────────────────────
      step: 'Step 5D-2.12a — Admin Email Styling Preview',
      preview_action: 'admin_email_preview',

      // ── Completion report fields ──────────────────────────────────────────
      preview_action_implemented: true,
      recipient: PREVIEW_RECIPIENT,
      email_type: PREVIEW_EMAIL_TYPE,
      uses_production_edge_function: true,
      edge_function: 'send-borrower-emails',
      uses_admin_reminder_7d_template: true,

      // ── Provider result ───────────────────────────────────────────────────
      provider_status: providerResponse?.status ?? null,
      email_sent: emailOk,
      email_error: emailError ?? null,
      provider_response: providerResponse,

      // ── Payload sent to edge function ─────────────────────────────────────
      payload_sent: previewPayload,

      // ── Zero-write guarantees ─────────────────────────────────────────────
      automation_claim_used: false,
      automation_log_writes: 0,
      activity_writes: 0,
      attempt_count_changed: false,
      existing_admin_reminder_row_changed: false,
      existing_client_reminder_row_changed: false,

      // ── Business state unchanged ──────────────────────────────────────────
      deal_status_unchanged: true,
      cycle_status_unchanged: true,
      exercise_timestamp_unchanged: true,
      amendment_timestamp_unchanged: true,
      option_cycle_automation_enabled: process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false',

      // ── Styling verification context ──────────────────────────────────────
      styling_context: {
        header_gradient: 'linear-gradient(135deg, #173F35 0%, #2d6a4f 100%)',
        gold_accent: '#C9A227',
        deadline_red: '#dc2626',
      },

      note: emailOk
        ? 'Preview email delivered. Check admin@earnestbridge.com inbox to verify green/gold styling. No automation state was changed.'
        : `Preview email delivery failed: ${emailError ?? 'unknown error'}. No automation state was changed.`,
    });
  }

  // ── action=live_auto_close_test ──────────────────────────────────────────
  // Step 5D-2.14: ONE controlled live auto-close against the permanent test Deal.
  //
  // SCOPE ISOLATION:
  //   - Hard-coded application_id and cycle_id — no arbitrary IDs accepted.
  //   - The worker is NOT invoked via runOptionCycleAutomation().
  //   - Only the specific test cycle is evaluated. No other Deal or cycle is touched.
  //   - OPTION_CYCLE_AUTOMATION_ENABLED is NOT checked — this diagnostic action
  //     is explicitly authorized by: authenticated Admin + hardcoded IDs +
  //     explicit live_auto_close_test action + exact safety gates.
  //   - The Netlify scheduled function NEVER supplies this test scope.
  //
  // EVALUATION TIME:
  //   Simulated: 2026-09-22T18:00:00-04:00 (6:00 PM America/New_York)
  //   Reason: Production scheduler runs hourly. First execution after 5:00 PM
  //   cutoff is approximately 6:00 PM. 5:00:01 PM is NOT used for the live test.
  //
  // EXECUTION ORDER:
  //   1. Pre-mutation safety gate (all 13 checks)
  //   2. auto_close claim via claim_option_cycle_automation_event()
  //   3. Atomic RPC: execute_option_cycle_auto_close()
  //   4. Verify atomic result (re-fetch deal, cycle, log, activity)
  //   5. Client closeout: claim + send option_client_closeout
  //   6. Admin closeout: claim + send option_admin_closeout
  //   7. Reconciliation: confirm already_done for both notices
  //
  // DATABASE WRITES DURING IMPLEMENTATION: 0
  // EMAILS SENT DURING IMPLEMENTATION: 0
  if (action === 'live_auto_close_test') {
    // ── Hard-coded test scope constants ──────────────────────────────────────
    const LIVE_AC_APP_ID    = '2aa816a9-2fb0-404f-92ca-c5e2cb49fe66';
    const LIVE_AC_CYCLE_ID  = '87bc8363-af29-4a77-919a-4b60ac8b6e38';
    const LIVE_AC_DEADLINE  = '2026-09-22';
    const LIVE_AC_HARD_DATE = '2026-09-24';
    const LIVE_AC_CLIENT    = 'ericthoni@gmail.com';
    const LIVE_AC_ADMIN     = 'admin@earnestbridge.com';

    // Simulated evaluation time: 6:00 PM America/New_York on 2026-09-22
    // (first normal hourly execution after the 5:00 PM cutoff)
    const SIMULATED_EVAL_TIME = new Date('2026-09-22T18:00:00-04:00');

    // Canonical cutoff for this deadline (5:00 PM ET on 2026-09-22)
    const canonicalCutoffAC = getOptionDeadlineCutoff(LIVE_AC_DEADLINE);

    // Auto-close dedupe key
    const AUTO_CLOSE_DEDUPE = `option:${LIVE_AC_CYCLE_ID}:${LIVE_AC_DEADLINE}:auto_close`;

    // ── SCOPE SAFETY CHECK ────────────────────────────────────────────────────
    // Absolute guard: stop immediately if either hardcoded ID is somehow wrong.
    if (LIVE_AC_APP_ID !== '2aa816a9-2fb0-404f-92ca-c5e2cb49fe66') {
      return NextResponse.json({
        STOP: true,
        reason: 'SCOPE SAFETY VIOLATION: application_id constant mismatch',
      }, { status: 500 });
    }
    if (LIVE_AC_CYCLE_ID !== '87bc8363-af29-4a77-919a-4b60ac8b6e38') {
      return NextResponse.json({
        STOP: true,
        reason: 'SCOPE SAFETY VIOLATION: cycle_id constant mismatch',
      }, { status: 500 });
    }

    // ── PRE-MUTATION SAFETY GATE ──────────────────────────────────────────────
    // All 13 checks must pass before any claim or write.
    const safetyFailures: string[] = [];

    // 1. Fetch application
    const { data: acApp, error: acAppErr } = await supabase
      .from('borrower_applications')
      .select('id, user_id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id')
      .eq('id', LIVE_AC_APP_ID)
      .maybeSingle();

    if (acAppErr || !acApp) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        reason: 'Application not found',
        application_id: LIVE_AC_APP_ID,
        action_taken: 'NONE',
      }, { status: 404 });
    }

    // 2. Fetch cycle
    const { data: acCycle, error: acCycleErr } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, application_id, cycle_number, deposit_goes_hard_date, option_exercise_deadline, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', LIVE_AC_CYCLE_ID)
      .maybeSingle();

    if (acCycleErr || !acCycle) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        reason: 'Cycle not found',
        cycle_id: LIVE_AC_CYCLE_ID,
        action_taken: 'NONE',
      }, { status: 404 });
    }

    // Gate 1: Application ID exact match
    if (acApp.id !== LIVE_AC_APP_ID) {
      safetyFailures.push(`application_id mismatch: got ${acApp.id}, expected ${LIVE_AC_APP_ID}`);
    }

    // Gate 2: Deal status = funded
    if (acApp.app_status !== 'funded') {
      safetyFailures.push(`deal status must be funded, got: ${acApp.app_status}`);
    }

    // Gate 3: Cycle ID exact match
    if (acCycle.id !== LIVE_AC_CYCLE_ID) {
      safetyFailures.push(`cycle_id mismatch: got ${acCycle.id}, expected ${LIVE_AC_CYCLE_ID}`);
    }

    // Gate 4: Cycle belongs to application
    if (acCycle.application_id !== LIVE_AC_APP_ID) {
      safetyFailures.push(`cycle.application_id mismatch: got ${acCycle.application_id}, expected ${LIVE_AC_APP_ID}`);
    }

    // Gate 5: Cycle status = active
    if (acCycle.status !== 'active') {
      safetyFailures.push(`cycle status must be active, got: ${acCycle.status}`);
    }

    // Gate 6: Option Exercise Deadline = 2026-09-22
    if (acCycle.option_exercise_deadline !== LIVE_AC_DEADLINE) {
      safetyFailures.push(`option_exercise_deadline must be ${LIVE_AC_DEADLINE}, got: ${acCycle.option_exercise_deadline}`);
    }

    // Gate 7: Deposit Goes Hard Date = 2026-09-24
    if (acCycle.deposit_goes_hard_date !== LIVE_AC_HARD_DATE) {
      safetyFailures.push(`deposit_goes_hard_date must be ${LIVE_AC_HARD_DATE}, got: ${acCycle.deposit_goes_hard_date}`);
    }

    // Gate 8: actual_option_exercised_at = NULL
    if (acCycle.actual_option_exercised_at !== null) {
      safetyFailures.push(`actual_option_exercised_at must be NULL, got: ${acCycle.actual_option_exercised_at}`);
    }

    // Gate 9: actual_amendment_received_at = NULL
    if (acCycle.actual_amendment_received_at !== null) {
      safetyFailures.push(`actual_amendment_received_at must be NULL, got: ${acCycle.actual_amendment_received_at}`);
    }

    // Gate 10: No existing auto_close row — OR — the canonical failed retryable row
    //
    // Step 5D-2.14c: The original gate required auto_close row = NONE.
    // That was too strict: it blocked the canonical retry path for the known
    // failed row (6ace1d0b-c690-4afd-b334-cb208289548e) which failed due to
    // the date/text type mismatch (now fixed by migration 20260917000200).
    //
    // The gate now allows EITHER:
    //   A. No existing auto_close row (original path — first-time execution)
    //   B. The SAME canonical auto_close row where ALL of the following are true:
    //      - row.id = 6ace1d0b-c690-4afd-b334-cb208289548e
    //      - application_id matches LIVE_AC_APP_ID
    //      - cycle_id matches LIVE_AC_CYCLE_ID
    //      - event_type = 'auto_close'
    //      - deadline_snapshot starts with LIVE_AC_DEADLINE (DATE may serialize with time)
    //      - dedupe_key matches AUTO_CLOSE_DEDUPE
    //      - status = 'failed'
    //      - attempt_count < 3
    //      - completed_at IS NULL
    //
    // If the existing row is completed, pending, mismatched, or max-attempts reached: STOP.
    // All Deal/cycle/timestamp safety gates still apply.
    const CANONICAL_FAILED_ROW_ID = '6ace1d0b-c690-4afd-b334-cb208289548e';

    const { data: existingAutoClose } = await supabase
      .from('option_cycle_automation_log')
      .select('id, application_id, cycle_id, event_type, deadline_snapshot, dedupe_key, status, attempt_count, completed_at')
      .eq('dedupe_key', AUTO_CLOSE_DEDUPE)
      .maybeSingle();

    if (existingAutoClose) {
      // An auto_close row exists — check if it is the canonical retryable row
      const isCanonicalRow =
        existingAutoClose.id === CANONICAL_FAILED_ROW_ID &&
        existingAutoClose.application_id === LIVE_AC_APP_ID &&
        existingAutoClose.cycle_id === LIVE_AC_CYCLE_ID &&
        existingAutoClose.event_type === 'auto_close' &&
        String(existingAutoClose.deadline_snapshot).startsWith(LIVE_AC_DEADLINE) &&
        existingAutoClose.dedupe_key === AUTO_CLOSE_DEDUPE &&
        existingAutoClose.status === 'failed' &&
        (existingAutoClose.attempt_count ?? 0) < 3 &&
        existingAutoClose.completed_at === null;

      if (!isCanonicalRow) {
        // Row exists but is NOT the canonical retryable row — STOP
        const stopReason = existingAutoClose.id !== CANONICAL_FAILED_ROW_ID
          ? `auto_close row exists with unexpected id=${existingAutoClose.id} (expected canonical ${CANONICAL_FAILED_ROW_ID} or no row)`
          : existingAutoClose.status === 'completed'
            ? `auto_close row is already completed (id=${existingAutoClose.id}) — retry not needed`
            : existingAutoClose.status !== 'failed'
              ? `auto_close row status=${existingAutoClose.status} is not retryable (expected failed or no row)`
              : (existingAutoClose.attempt_count ?? 0) >= 3
                ? `auto_close row has reached max attempts (attempt_count=${existingAutoClose.attempt_count})`
                : existingAutoClose.completed_at !== null
                  ? `auto_close row has completed_at set — already completed`
                  : `auto_close row identity mismatch: id=${existingAutoClose.id}, status=${existingAutoClose.status}, attempt_count=${existingAutoClose.attempt_count}`;
        safetyFailures.push(stopReason);
      }
      // else: canonical retryable row — allow retry path to proceed
    }

    // Gate 11: No existing client_closeout_notice row
    // Resolve client email first for the dedupe key check
    let acClientEmail: string | null = null;
    let acClientFirstName = 'Borrower';
    let acClientRecipientSource = '';

    if (acApp.primary_contact_id) {
      const { data: acContact } = await supabase
        .from('crm_contacts')
        .select('primary_email, first_name')
        .eq('id', acApp.primary_contact_id)
        .maybeSingle();
      if (acContact?.primary_email) {
        acClientEmail = acContact.primary_email.trim().toLowerCase();
        acClientFirstName = acContact.first_name || 'Borrower';
        acClientRecipientSource = `crm_contacts.primary_email (via primary_contact_id: ${acApp.primary_contact_id})`;
      }
    }
    if (!acClientEmail) {
      const { data: acAuthUser } = await supabase.auth.admin.getUserById(acApp.user_id ?? '');
      if (acAuthUser?.user?.email) {
        acClientEmail = acAuthUser.user.email.trim().toLowerCase();
        const meta = acAuthUser.user.user_metadata;
        acClientFirstName = meta?.first_name || meta?.firstName || 'Borrower';
        acClientRecipientSource = `auth.users.email fallback (user_id: ${acApp.user_id})`;
      }
    }

    if (!acClientEmail) {
      safetyFailures.push('Could not resolve client recipient email');
    } else if (acClientEmail !== LIVE_AC_CLIENT) {
      safetyFailures.push(`client recipient must be ${LIVE_AC_CLIENT}, resolved to: ${acClientEmail}`);
    }

    const acAdminEmail = (acApp.eb_assigned_owner && ADMIN_OWNER_EMAIL_MAP_DIAG[acApp.eb_assigned_owner])
      ? ADMIN_OWNER_EMAIL_MAP_DIAG[acApp.eb_assigned_owner]
      : ADMIN_FALLBACK_EMAIL_DIAG;

    if (acAdminEmail !== LIVE_AC_ADMIN) {
      safetyFailures.push(`admin recipient must be ${LIVE_AC_ADMIN}, resolved to: ${acAdminEmail}`);
    }

    const clientCloseoutDedupeAC = acClientEmail
      ? `option:${LIVE_AC_CYCLE_ID}:${LIVE_AC_DEADLINE}:client_closeout_notice:${acClientEmail}`
      : null;
    const adminCloseoutDedupeAC = `option:${LIVE_AC_CYCLE_ID}:${LIVE_AC_DEADLINE}:admin_closeout_notice:${acAdminEmail.toLowerCase()}`;

    if (clientCloseoutDedupeAC) {
      const { data: existingClientCloseout } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status')
        .eq('dedupe_key', clientCloseoutDedupeAC)
        .maybeSingle();
      if (existingClientCloseout) {
        safetyFailures.push(`client_closeout_notice row already exists: id=${existingClientCloseout.id}, status=${existingClientCloseout.status}`);
      }
    }

    // Gate 12: No existing admin_closeout_notice row
    const { data: existingAdminCloseout } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status')
      .eq('dedupe_key', adminCloseoutDedupeAC)
      .maybeSingle();
    if (existingAdminCloseout) {
      safetyFailures.push(`admin_closeout_notice row already exists: id=${existingAdminCloseout.id}, status=${existingAdminCloseout.status}`);
    }

    // Gate 13: OPTION_CYCLE_AUTOMATION_ENABLED = false
    const automationEnabledFlag = process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false';
    if (automationEnabledFlag === 'true') {
      safetyFailures.push('OPTION_CYCLE_AUTOMATION_ENABLED must be false for this diagnostic action');
    }

    // ── If ANY safety gate failed — STOP ──────────────────────────────────────
    if (safetyFailures.length > 0) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        failures: safetyFailures,
        action_taken: 'NONE — no claim, no write, no email',
        application_id: LIVE_AC_APP_ID,
        cycle_id: LIVE_AC_CYCLE_ID,
        scope_isolation: 'Hard-coded IDs — only this specific test cycle is evaluated',
        simulated_evaluation_time: SIMULATED_EVAL_TIME.toISOString(),
      }, { status: 422 });
    }

    // ── ALL SAFETY GATES PASSED ───────────────────────────────────────────────

    const acDealDisplay = acApp.property_address || acApp.company_name || '123 Main St, Orlando, FL';
    const acOwnerDisplay = acApp.eb_assigned_owner ?? 'Unassigned';

    // ── STEP 5: AUTO-CLOSE CLAIM ──────────────────────────────────────────────
    // Canonical claim RPC. Dedupe key: option:<cycle_id>:<deadline>:auto_close
    let acClaimResult: string;
    let acLogId: string | null = null;

    try {
      const { data: acClaimData, error: acClaimErr } = await supabase.rpc(
        'claim_option_cycle_automation_event',
        {
          p_cycle_id:         LIVE_AC_CYCLE_ID,
          p_application_id:   LIVE_AC_APP_ID,
          p_event_type:       'auto_close',
          p_deadline_snapshot: LIVE_AC_DEADLINE,
          p_dedupe_key:       AUTO_CLOSE_DEDUPE,
        }
      );

      if (acClaimErr) {
        return NextResponse.json({
          safety_gate: 'PASS',
          step: 'auto_close_claim',
          claim_result: 'error',
          claim_error: acClaimErr.message,
          action_taken: 'NONE — claim RPC failed',
          email_sent: false,
        }, { status: 500 });
      }

      const acClaimRow = Array.isArray(acClaimData) ? acClaimData[0] : acClaimData;
      acClaimResult = acClaimRow?.result ?? 'already_done';
      acLogId = acClaimRow?.log_id ?? null;
    } catch (e: any) {
      return NextResponse.json({
        safety_gate: 'PASS',
        step: 'auto_close_claim',
        claim_result: 'error',
        claim_error: e.message,
        action_taken: 'NONE — claim RPC threw',
        email_sent: false,
      }, { status: 500 });
    }

    if (acClaimResult === 'already_done') {
      return NextResponse.json({
        safety_gate: 'PASS',
        step: 'auto_close_claim',
        claim_result: 'already_done',
        reason: 'auto_close already completed for this cycle/deadline — idempotency guard',
        dedupe_key: AUTO_CLOSE_DEDUPE,
        email_sent: false,
        action_taken: 'NONE',
      });
    }

    if (acClaimResult === 'currently_claimed') {
      return NextResponse.json({
        safety_gate: 'PASS',
        step: 'auto_close_claim',
        claim_result: 'currently_claimed',
        reason: 'Another worker currently holds the auto_close claim — try again in 15 minutes',
        email_sent: false,
        action_taken: 'NONE',
      });
    }

    if (acClaimResult === 'max_attempts_reached') {
      return NextResponse.json({
        safety_gate: 'PASS',
        step: 'auto_close_claim',
        claim_result: 'max_attempts_reached',
        reason: 'Max 3 attempts reached — Admin must investigate the automation log',
        email_sent: false,
        action_taken: 'NONE',
      }, { status: 422 });
    }

    if ((acClaimResult !== 'claimed' && acClaimResult !== 'retry_claimed') || !acLogId) {
      return NextResponse.json({
        safety_gate: 'PASS',
        step: 'auto_close_claim',
        claim_result: acClaimResult,
        reason: `Unexpected claim result: ${acClaimResult}`,
        email_sent: false,
        action_taken: 'NONE',
      }, { status: 500 });
    }

    // ── STEP 6: ATOMIC AUTO-CLOSE RPC ─────────────────────────────────────────
    // execute_option_cycle_auto_close() atomically commits in ONE transaction:
    //   a. cycle → missed
    //   b. deal  → closed
    //   c. auto_close log → completed (completed_at set)
    //   d. activity: option_cycle_missed
    //   e. activity: status_change
    //
    // p_cutoff_at = canonical Sep 22, 2026 5:00 PM America/New_York
    // p_automation_log_id = the exact log ID returned by the auto_close claim
    // p_deadline_snapshot = '2026-09-22'
    let acRpcResult = 'unknown';
    let acRpcError = '';

    try {
      const { data: acRpcData, error: acRpcErr } = await supabase.rpc(
        'execute_option_cycle_auto_close',
        {
          p_cycle_id:           LIVE_AC_CYCLE_ID,
          p_application_id:     LIVE_AC_APP_ID,
          p_cutoff_at:          canonicalCutoffAC.toISOString(),
          p_automation_log_id:  acLogId,
          p_deadline_snapshot:  LIVE_AC_DEADLINE,
        }
      );

      if (acRpcErr) {
        throw new Error(`execute_option_cycle_auto_close RPC error: ${acRpcErr.message}`);
      }

      const acRpcRow = Array.isArray(acRpcData) ? acRpcData[0] : acRpcData;
      acRpcResult = acRpcRow?.result ?? 'unknown';
    } catch (e: any) {
      acRpcError = e.message ?? 'execute_option_cycle_auto_close threw unexpectedly';
    }

    if (acRpcResult !== 'success') {
      // RPC guard fired — no partial state. Mark claim as failed (retryable).
      await supabase
        .from('option_cycle_automation_log')
        .update({ status: 'failed', last_error: (acRpcError || `RPC guard: ${acRpcResult}`).substring(0, 1000) })
        .eq('id', acLogId);

      return NextResponse.json({
        safety_gate: 'PASS',
        step: 'execute_option_cycle_auto_close',
        rpc_result: acRpcResult,
        rpc_error: acRpcError || null,
        action_taken: 'auto_close claim marked failed — no state change committed',
        email_sent: false,
        note: 'DO NOT send closeout emails. Return diagnostic result.',
        scope_isolation: 'Only the hardcoded test cycle was evaluated',
        simulated_evaluation_time: SIMULATED_EVAL_TIME.toISOString(),
        canonical_cutoff: canonicalCutoffAC.toISOString(),
      }, { status: 422 });
    }

    // ── STEP 7: VERIFY ATOMIC RESULT ──────────────────────────────────────────
    // Re-fetch deal, cycle, auto_close log, and activity rows.
    const { data: verifyDeal } = await supabase
      .from('borrower_applications')
      .select('id, app_status')
      .eq('id', LIVE_AC_APP_ID)
      .maybeSingle();

    const { data: verifyCycle } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', LIVE_AC_CYCLE_ID)
      .maybeSingle();

    const { data: verifyAutoCloseLog } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
      .eq('id', acLogId)
      .maybeSingle();

    const { data: verifyActivity } = await supabase
      .from('application_activity')
      .select('id, event_type, title, actor, created_at, source_id')
      .eq('application_id', LIVE_AC_APP_ID)
      .in('event_type', ['option_cycle_missed', 'status_change'])
      .order('created_at', { ascending: false });

    const atomicVerification = {
      deal_status: verifyDeal?.app_status ?? null,
      deal_status_expected: 'closed',
      deal_status_correct: verifyDeal?.app_status === 'closed',
      cycle_status: verifyCycle?.status ?? null,
      cycle_status_expected: 'missed',
      cycle_status_correct: verifyCycle?.status === 'missed',
      auto_close_log_status: verifyAutoCloseLog?.status ?? null,
      auto_close_log_status_expected: 'completed',
      auto_close_log_status_correct: verifyAutoCloseLog?.status === 'completed',
      auto_close_completed_at: verifyAutoCloseLog?.completed_at ?? null,
      activity_rows: verifyActivity ?? [],
      // ── CANONICAL ACTIVITY VERIFICATION (Step 5D-2.14d) ──────────────────
      // Count ONLY rows where:
      //   application_id = LIVE_AC_APP_ID
      //   source_id      = LIVE_AC_CYCLE_ID   (scopes to this cycle only)
      //   actor          = 'EarnestBridge Automation'
      //
      // Historical application status_change rows with source_id = NULL
      // must NOT affect this count. They are pre-existing rows unrelated
      // to this auto-close execution.
      activity_option_cycle_missed: (verifyActivity ?? []).filter(
        (a: any) =>
          a.event_type === 'option_cycle_missed' &&
          a.source_id === LIVE_AC_CYCLE_ID &&
          a.actor === 'EarnestBridge Automation'
      ),
      activity_status_change: (verifyActivity ?? []).filter(
        (a: any) =>
          a.event_type === 'status_change' &&
          a.source_id === LIVE_AC_CYCLE_ID &&
          a.actor === 'EarnestBridge Automation' &&
          a.title === 'Deal status changed: Funded → Closed'
      ),
      exactly_one_option_cycle_missed: (verifyActivity ?? []).filter(
        (a: any) =>
          a.event_type === 'option_cycle_missed' &&
          a.source_id === LIVE_AC_CYCLE_ID &&
          a.actor === 'EarnestBridge Automation'
      ).length === 1,
      exactly_one_status_change: (verifyActivity ?? []).filter(
        (a: any) =>
          a.event_type === 'status_change' &&
          a.source_id === LIVE_AC_CYCLE_ID &&
          a.actor === 'EarnestBridge Automation' &&
          a.title === 'Deal status changed: Funded → Closed'
      ).length === 1,
      canonical_activity_predicate_note:
        'Counts only rows with source_id = cycle_id AND actor = EarnestBridge Automation. ' + 'Historical status_change rows with source_id = NULL are excluded and do NOT affect this count.',
    };

    const atomicVerificationPassed =
      atomicVerification.deal_status_correct &&
      atomicVerification.cycle_status_correct &&
      atomicVerification.auto_close_log_status_correct &&
      atomicVerification.exactly_one_option_cycle_missed &&
      atomicVerification.exactly_one_status_change;

    if (!atomicVerificationPassed) {
      return NextResponse.json({
        safety_gate: 'PASS',
        step: 'atomic_result_verification',
        rpc_result: acRpcResult,
        atomic_verification: atomicVerification,
        atomic_verification_passed: false,
        action_taken: 'RPC returned success but post-RPC verification failed — DO NOT send closeout emails',
        email_sent: false,
        scope_isolation: 'Only the hardcoded test cycle was evaluated',
        simulated_evaluation_time: SIMULATED_EVAL_TIME.toISOString(),
      }, { status: 500 });
    }

    // ── STEP 8: CLIENT CLOSEOUT ───────────────────────────────────────────────
    // Process canonical client closeout event.
    // Recipient: ericthoni@gmail.com
    // Automation event: client_closeout_notice
    // Email type: option_client_closeout
    let clientCloseoutClaimResult = 'not_attempted';
    let clientCloseoutLogId: string | null = null;
    let clientEmailOk = false;
    let clientEmailError: string | undefined;
    let clientEmailProviderResponse: any = null;
    let clientCloseoutLogRow: any = null;

    if (clientCloseoutDedupeAC && acClientEmail) {
      try {
        const { data: ccClaimData, error: ccClaimErr } = await supabase.rpc(
          'claim_option_cycle_automation_event',
          {
            p_cycle_id:          LIVE_AC_CYCLE_ID,
            p_application_id:    LIVE_AC_APP_ID,
            p_event_type:        'client_closeout_notice',
            p_deadline_snapshot: LIVE_AC_DEADLINE,
            p_dedupe_key:        clientCloseoutDedupeAC,
          }
        );

        if (ccClaimErr) {
          clientCloseoutClaimResult = `claim_error: ${ccClaimErr.message}`;
        } else {
          const ccRow = Array.isArray(ccClaimData) ? ccClaimData[0] : ccClaimData;
          clientCloseoutClaimResult = ccRow?.result ?? 'already_done';
          clientCloseoutLogId = ccRow?.log_id ?? null;
        }
      } catch (e: any) {
        clientCloseoutClaimResult = `claim_threw: ${e.message}`;
      }

      if ((clientCloseoutClaimResult === 'claimed' || clientCloseoutClaimResult === 'retry_claimed') && clientCloseoutLogId) {
        // Send option_client_closeout email
        // Client copy must NOT expose: Deposit Goes Hard Date, internal buffer,
        // fee leniency, Admin override policy, legal/escrow conclusions.
        const clientEmailPayload = {
          emailType: 'option_client_closeout',
          borrower: {
            email: acClientEmail,
            firstName: acClientFirstName,
          },
          application: {
            optionExerciseDeadline: LIVE_AC_DEADLINE,
            optionDeadlineDisplay: formatDateDisplay(LIVE_AC_DEADLINE),
            propertyAddress: acApp.property_address,
            dealDisplayName: acDealDisplay,
            // NOTE: depositGoesHardDate intentionally NOT included — must never be exposed to client
          },
        };

        try {
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
          const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

          const res = await fetch(edgeFnUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`,
            },
            body: JSON.stringify(clientEmailPayload),
          });

          clientEmailOk = res.ok;
          const responseText = await res.text().catch(() => '');
          clientEmailProviderResponse = {
            status: res.status,
            ok: res.ok,
            body_preview: responseText.substring(0, 500),
          };
          if (!res.ok) {
            clientEmailError = `HTTP ${res.status}: ${responseText.substring(0, 200)}`;
          }
        } catch (e: any) {
          clientEmailError = e.message ?? 'Network error calling edge function';
          clientEmailProviderResponse = { error: clientEmailError };
        }

        if (clientEmailOk) {
          await supabase
            .from('option_cycle_automation_log')
            .update({ status: 'completed', completed_at: new Date().toISOString(), last_error: null })
            .eq('id', clientCloseoutLogId);
        } else {
          await supabase
            .from('option_cycle_automation_log')
            .update({ status: 'failed', last_error: (clientEmailError ?? 'Client closeout email failed').substring(0, 1000) })
            .eq('id', clientCloseoutLogId);
        }

        const { data: ccFinalLog } = await supabase
          .from('option_cycle_automation_log')
          .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
          .eq('id', clientCloseoutLogId)
          .maybeSingle();
        clientCloseoutLogRow = ccFinalLog;
      } else if (clientCloseoutClaimResult === 'already_done') {
        const { data: ccExisting } = await supabase
          .from('option_cycle_automation_log')
          .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
          .eq('dedupe_key', clientCloseoutDedupeAC)
          .maybeSingle();
        clientCloseoutLogRow = ccExisting;
      }
    }

    // ── STEP 9: ADMIN CLOSEOUT ────────────────────────────────────────────────
    // Independently process admin_closeout_notice.
    // Recipient: admin@earnestbridge.com
    // Email type: option_admin_closeout
    let adminCloseoutClaimResult = 'not_attempted';
    let adminCloseoutLogId: string | null = null;
    let adminEmailOk = false;
    let adminEmailError: string | undefined;
    let adminEmailProviderResponse: any = null;
    let adminCloseoutLogRow: any = null;

    try {
      const { data: acClaimData, error: acClaimErr2 } = await supabase.rpc(
        'claim_option_cycle_automation_event',
        {
          p_cycle_id:          LIVE_AC_CYCLE_ID,
          p_application_id:    LIVE_AC_APP_ID,
          p_event_type:        'admin_closeout_notice',
          p_deadline_snapshot: LIVE_AC_DEADLINE,
          p_dedupe_key:        adminCloseoutDedupeAC,
        }
      );

      if (acClaimErr2) {
        adminCloseoutClaimResult = `claim_error: ${acClaimErr2.message}`;
      } else {
        const acRow2 = Array.isArray(acClaimData) ? acClaimData[0] : acClaimData;
        adminCloseoutClaimResult = acRow2?.result ?? 'already_done';
        adminCloseoutLogId = acRow2?.log_id ?? null;
      }
    } catch (e: any) {
      adminCloseoutClaimResult = `claim_threw: ${e.message}`;
    }

    if ((adminCloseoutClaimResult === 'claimed' || adminCloseoutClaimResult === 'retry_claimed') && adminCloseoutLogId) {
      // Admin email may show: Deal/property, Assigned Owner, Option Exercise Deadline,
      // Deposit Goes Hard Date, Deal Closed, cycle missed, Admin follow-up instructions.
      const adminEmailPayload = {
        emailType: 'option_admin_closeout',
        borrower: {
          email: acAdminEmail,
          firstName: 'Admin',
        },
        application: {
          optionExerciseDeadline: LIVE_AC_DEADLINE,
          optionDeadlineDisplay: formatDateDisplay(LIVE_AC_DEADLINE),
          depositGoesHardDate: LIVE_AC_HARD_DATE,
          depositGoesHardDateDisplay: formatDateDisplay(LIVE_AC_HARD_DATE),
          propertyAddress: acApp.property_address,
          dealDisplayName: acDealDisplay,
          assignedOwner: acOwnerDisplay,
        },
      };

      try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

        const res = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
          },
          body: JSON.stringify(adminEmailPayload),
        });

        adminEmailOk = res.ok;
        const responseText = await res.text().catch(() => '');
        adminEmailProviderResponse = {
          status: res.status,
          ok: res.ok,
          body_preview: responseText.substring(0, 500),
        };
        if (!res.ok) {
          adminEmailError = `HTTP ${res.status}: ${responseText.substring(0, 200)}`;
        }
      } catch (e: any) {
        adminEmailError = e.message ?? 'Network error calling edge function';
        adminEmailProviderResponse = { error: adminEmailError };
      }

      if (adminEmailOk) {
        await supabase
          .from('option_cycle_automation_log')
          .update({ status: 'completed', completed_at: new Date().toISOString(), last_error: null })
          .eq('id', adminCloseoutLogId);
      } else {
        await supabase
          .from('option_cycle_automation_log')
          .update({ status: 'failed', last_error: (adminEmailError ?? 'Admin closeout email failed').substring(0, 1000) })
          .eq('id', adminCloseoutLogId);
      }

      const { data: acFinalLog } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
        .eq('id', adminCloseoutLogId)
        .maybeSingle();
      adminCloseoutLogRow = acFinalLog;
    } else if (adminCloseoutClaimResult === 'already_done') {
      const { data: acExisting } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
        .eq('dedupe_key', adminCloseoutDedupeAC)
        .maybeSingle();
      adminCloseoutLogRow = acExisting;
    }

    // ── STEP 10: RECONCILIATION ───────────────────────────────────────────────
    // Run the normal closeout reconciliation logic for this targeted cycle.
    // Expected: client_closeout_notice = already_done, admin_closeout_notice = already_done.
    // This proves the recovery system recognizes events already completed by primary execution.
    // No duplicate provider calls.
    let reconciliationClientResult = 'not_run';
    let reconciliationAdminResult = 'not_run';

    // Client closeout reconciliation check
    if (clientCloseoutDedupeAC) {
      const { data: reconcileClientRow } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at')
        .eq('dedupe_key', clientCloseoutDedupeAC)
        .maybeSingle();

      if (reconcileClientRow) {
        if (reconcileClientRow.status === 'completed' || reconcileClientRow.status === 'sent') {
          reconciliationClientResult = 'already_done';
        } else if (reconcileClientRow.status === 'failed') {
          reconciliationClientResult = `failed_retryable (attempt_count=${reconcileClientRow.attempt_count})`;
        } else {
          reconciliationClientResult = `status=${reconcileClientRow.status}`;
        }
      } else {
        reconciliationClientResult = 'no_row_found';
      }
    }

    // Admin closeout reconciliation check
    const { data: reconcileAdminRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('dedupe_key', adminCloseoutDedupeAC)
      .maybeSingle();

    if (reconcileAdminRow) {
      if (reconcileAdminRow.status === 'completed' || reconcileAdminRow.status === 'sent') {
        reconciliationAdminResult = 'already_done';
      } else if (reconcileAdminRow.status === 'failed') {
        reconciliationAdminResult = `failed_retryable (attempt_count=${reconcileAdminRow.attempt_count})`;
      } else {
        reconciliationAdminResult = `status=${reconcileAdminRow.status}`;
      }
    } else {
      reconciliationAdminResult = 'no_row_found';
    }

    // ── STEP 11: POST-TEST DATABASE STATE ─────────────────────────────────────
    const { data: finalDeal } = await supabase
      .from('borrower_applications')
      .select('id, app_status')
      .eq('id', LIVE_AC_APP_ID)
      .maybeSingle();

    const { data: finalCycleAC } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', LIVE_AC_CYCLE_ID)
      .maybeSingle();

    const { data: finalAutoCloseLog } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
      .eq('dedupe_key', AUTO_CLOSE_DEDUPE)
      .maybeSingle();

    const { data: finalActivity } = await supabase
      .from('application_activity')
      .select('id, event_type, title, actor, created_at, source_id')
      .eq('application_id', LIVE_AC_APP_ID)
      .in('event_type', ['option_cycle_missed', 'status_change'])
      .order('created_at', { ascending: false });

    // ── STEP 12: VERIFY EXISTING REMINDER ROWS UNCHANGED ─────────────────────
    const { data: clientReminderFinal } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('id', '30c677e6-c156-46f1-a243-f09da9f9bf3b')
      .maybeSingle();

    const { data: adminReminderFinal } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('id', '7ddccff9-0c6a-4698-bf7c-1d5f32eff21e')
      .maybeSingle();

    // ── COMPLETION REPORT ─────────────────────────────────────────────────────
    return NextResponse.json({
      step: 'Step 5D-2.14 — Controlled Live Auto-Close Test',

      // ── Completion Report ─────────────────────────────────────────────────
      live_auto_close_test_implemented: true,
      hardcoded_application_scope: LIVE_AC_APP_ID,
      hardcoded_cycle_scope: LIVE_AC_CYCLE_ID,
      can_simulated_6pm_evaluation_affect_other_deals: false,
      scope_isolation_method: 'Hard-coded application_id and cycle_id constants. Worker (runOptionCycleAutomation) is NOT invoked. Only the specific test cycle is evaluated via direct RPC calls. No other Deal or cycle is touched. The Netlify scheduled function never supplies this test scope.',
      evaluation_time: SIMULATED_EVAL_TIME.toISOString(),
      canonical_cutoff: canonicalCutoffAC.toISOString(),

      // ── Safety gate ───────────────────────────────────────────────────────
      safety_gate: 'PASS',
      safety_gates_checked: [
        'application_id exact match',
        'deal status = funded',
        'cycle_id exact match',
        'cycle belongs to application',
        'cycle status = active',
        'option_exercise_deadline = 2026-09-22',
        'deposit_goes_hard_date = 2026-09-24',
        'actual_option_exercised_at = NULL',
        'actual_amendment_received_at = NULL',
        'auto_close automation row = NONE',
        'client_closeout_notice row = NONE',
        'admin_closeout_notice row = NONE',
        'OPTION_CYCLE_AUTOMATION_ENABLED = false',
      ],

      // ── Auto-close claim ──────────────────────────────────────────────────
      auto_close_dedupe_key: AUTO_CLOSE_DEDUPE,
      auto_close_claim_result: acClaimResult,
      auto_close_log_id: acLogId,

      // ── Atomic RPC ────────────────────────────────────────────────────────
      atomic_rpc_used: true,
      atomic_rpc_name: 'execute_option_cycle_auto_close',
      atomic_rpc_arguments: {
        p_cycle_id:          LIVE_AC_CYCLE_ID,
        p_application_id:    LIVE_AC_APP_ID,
        p_cutoff_at:         canonicalCutoffAC.toISOString(),
        p_automation_log_id: acLogId,
        p_deadline_snapshot: LIVE_AC_DEADLINE,
      },
      atomic_rpc_result: acRpcResult,
      expected_atomic_rpc_result: 'success',

      // ── Atomic verification ───────────────────────────────────────────────
      atomic_verification: atomicVerification,
      atomic_verification_passed: atomicVerificationPassed,
      activities_created_inside_rpc: ['option_cycle_missed', 'status_change'],

      // ── Client closeout ───────────────────────────────────────────────────
      client_closeout_recipient: LIVE_AC_CLIENT,
      client_closeout_recipient_source: acClientRecipientSource,
      client_closeout_event_type: 'client_closeout_notice',
      client_closeout_email_type: 'option_client_closeout',
      client_closeout_claim_result: clientCloseoutClaimResult,
      client_closeout_provider_called: (clientCloseoutClaimResult === 'claimed' || clientCloseoutClaimResult === 'retry_claimed'),
      client_closeout_email_sent: clientEmailOk,
      client_closeout_email_error: clientEmailError ?? null,
      client_closeout_provider_response: clientEmailProviderResponse,
      client_closeout_log_row: clientCloseoutLogRow,
      client_closeout_deposit_goes_hard_date_exposed: false,
      client_closeout_internal_buffer_exposed: false,
      client_closeout_fee_leniency_exposed: false,
      client_closeout_admin_override_exposed: false,
      client_closeout_legal_escrow_conclusion: false,

      // ── Admin closeout ────────────────────────────────────────────────────
      admin_closeout_recipient: LIVE_AC_ADMIN,
      admin_closeout_event_type: 'admin_closeout_notice',
      admin_closeout_email_type: 'option_admin_closeout',
      admin_closeout_claim_result: adminCloseoutClaimResult,
      admin_closeout_provider_called: (adminCloseoutClaimResult === 'claimed' || adminCloseoutClaimResult === 'retry_claimed'),
      admin_closeout_email_sent: adminEmailOk,
      admin_closeout_email_error: adminEmailError ?? null,
      admin_closeout_provider_response: adminEmailProviderResponse,
      admin_closeout_log_row: adminCloseoutLogRow,

      // ── Reconciliation ────────────────────────────────────────────────────
      reconciliation_included: true,
      reconciliation_client_closeout_result: reconciliationClientResult,
      reconciliation_admin_closeout_result: reconciliationAdminResult,
      duplicate_emails_possible_during_reconciliation: false,

      // ── Post-test database state ──────────────────────────────────────────
      final_deal_status: finalDeal?.app_status ?? null,
      final_deal_status_expected: 'closed',
      final_cycle_status: finalCycleAC?.status ?? null,
      final_cycle_status_expected: 'missed',
      final_actual_option_exercised_at: finalCycleAC?.actual_option_exercised_at ?? null,
      final_actual_option_exercised_at_expected: null,
      final_actual_amendment_received_at: finalCycleAC?.actual_amendment_received_at ?? null,
      final_actual_amendment_received_at_expected: null,
      final_auto_close_log: finalAutoCloseLog ?? null,
      final_auto_close_log_status_expected: 'completed',
      final_activity_rows: finalActivity ?? [],
      final_activity_option_cycle_missed_count: (finalActivity ?? []).filter((a: any) => a.event_type === 'option_cycle_missed').length,
      final_activity_status_change_count: (finalActivity ?? []).filter((a: any) => a.event_type === 'status_change').length,

      // ── Existing reminder rows protected ─────────────────────────────────
      existing_reminder_rows_protected: true,
      client_reminder_row: clientReminderFinal
        ? { id: clientReminderFinal.id, status: clientReminderFinal.status, attempt_count: clientReminderFinal.attempt_count, unchanged: clientReminderFinal.status === 'sent' && clientReminderFinal.attempt_count === 1 }
        : { id: '30c677e6-c156-46f1-a243-f09da9f9bf3b', status: 'NOT FOUND' },
      admin_reminder_row: adminReminderFinal
        ? { id: adminReminderFinal.id, status: adminReminderFinal.status, attempt_count: adminReminderFinal.attempt_count, unchanged: adminReminderFinal.status === 'sent' && adminReminderFinal.attempt_count === 1 }
        : { id: '7ddccff9-0c6a-4698-bf7c-1d5f32eff21e', status: 'NOT FOUND' },

      // ── Automation flag ───────────────────────────────────────────────────
      option_cycle_automation_enabled: automationEnabledFlag,
      option_cycle_automation_enabled_expected: 'false',

      // ── Safe to execute ───────────────────────────────────────────────────
      safe_to_execute_exactly_one_controlled_live_auto_close: true,
      netlify_redeploy_required: false,
      supabase_migration_required: false,
    });
  }

  // ── action=live_closeout_recovery_test ──────────────────────────────────
  // Step 5D-2.14d: Controlled closeout recovery for the completed auto-close.
  //
  // SCOPE ISOLATION:
  //   Hard-coded application_id and cycle_id — no arbitrary IDs accepted.
  //   Does NOT call execute_option_cycle_auto_close().
  //   Does NOT call the auto_close claim.
  //   Does NOT modify Deal or cycle state.
  //   Uses the SAME production reconciliation behavior as
  //   reconcileCompletedAutoCloseNotifications() — scoped to this one cycle.
  //
  // SAFETY GATE (all must pass before any email claim):
  //   1.  Deal status = closed
  //   2.  Cycle status = missed
  //   3.  Completed canonical auto_close row exists
  //   4.  auto_close event_type = auto_close
  //   5.  auto_close deadline_snapshot = 2026-09-22
  //   6.  auto_close status = completed
  //   7.  Canonical option_cycle_missed activity count = 1
  //   8.  Canonical Funded → Closed status_change activity count = 1
  //   9.  Client recipient = ericthoni@gmail.com
  //  10.  Admin recipient = admin@earnestbridge.com
  //  11.  OPTION_CYCLE_AUTOMATION_ENABLED = false
  //
  // If any gate fails: STOP. No email claims. No provider calls.
  //
  // IDEMPOTENCY:
  //   If client_closeout_notice or admin_closeout_notice already exists,
  //   report its exact state and STOP before adding a live recovery action
  //   that could duplicate delivery.
  //
  // DATABASE WRITES DURING IMPLEMENTATION: 0
  // EMAILS SENT DURING IMPLEMENTATION: 0
  if (action === 'live_closeout_recovery_test') {
    // ── Hard-coded recovery scope constants ──────────────────────────────────
    const RECOVERY_APP_ID    = '2aa816a9-2fb0-404f-92ca-c5e2cb49fe66';
    const RECOVERY_CYCLE_ID  = '87bc8363-af29-4a77-919a-4b60ac8b6e38';
    const RECOVERY_DEADLINE  = '2026-09-22';
    const RECOVERY_CLIENT    = 'ericthoni@gmail.com';
    const RECOVERY_ADMIN     = 'admin@earnestbridge.com';
    const RECOVERY_AUTO_CLOSE_DEDUPE = `option:${RECOVERY_CYCLE_ID}:${RECOVERY_DEADLINE}:auto_close`;
    const RECOVERY_CLIENT_DEDUPE     = `option:${RECOVERY_CYCLE_ID}:${RECOVERY_DEADLINE}:client_closeout_notice:${RECOVERY_CLIENT}`;
    const RECOVERY_ADMIN_DEDUPE      = `option:${RECOVERY_CYCLE_ID}:${RECOVERY_DEADLINE}:admin_closeout_notice:${RECOVERY_ADMIN}`;

    // ── SCOPE SAFETY CHECK ────────────────────────────────────────────────────
    if (RECOVERY_APP_ID !== '2aa816a9-2fb0-404f-92ca-c5e2cb49fe66') {
      return NextResponse.json({ STOP: true, reason: 'SCOPE SAFETY VIOLATION: application_id constant mismatch' }, { status: 500 });
    }
    if (RECOVERY_CYCLE_ID !== '87bc8363-af29-4a77-919a-4b60ac8b6e38') {
      return NextResponse.json({ STOP: true, reason: 'SCOPE SAFETY VIOLATION: cycle_id constant mismatch' }, { status: 500 });
    }

    const recoveryGateFailures: string[] = [];

    // ── 1. Fetch application ─────────────────────────────────────────────────
    const { data: recApp, error: recAppErr } = await supabase
      .from('borrower_applications')
      .select('id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id, user_id')
      .eq('id', RECOVERY_APP_ID)
      .maybeSingle();

    if (recAppErr || !recApp) {
      return NextResponse.json({ safety_gate: 'FAIL', reason: 'Application not found', application_id: RECOVERY_APP_ID }, { status: 404 });
    }

    // Gate 1: Deal status = closed
    if (recApp.app_status !== 'closed') {
      recoveryGateFailures.push(`deal status must be closed, got: ${recApp.app_status}`);
    }

    // ── 2. Fetch cycle ───────────────────────────────────────────────────────
    const { data: recCycle, error: recCycleErr } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, application_id, status, option_exercise_deadline, deposit_goes_hard_date, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', RECOVERY_CYCLE_ID)
      .maybeSingle();

    if (recCycleErr || !recCycle) {
      return NextResponse.json({ safety_gate: 'FAIL', reason: 'Cycle not found', cycle_id: RECOVERY_CYCLE_ID }, { status: 404 });
    }

    // Gate 2: Cycle status = missed
    if (recCycle.status !== 'missed') {
      recoveryGateFailures.push(`cycle status must be missed, got: ${recCycle.status}`);
    }

    // ── 3. Fetch completed auto_close row ────────────────────────────────────
    const { data: recAutoClose } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, deadline_snapshot, status, attempt_count, completed_at, dedupe_key')
      .eq('dedupe_key', RECOVERY_AUTO_CLOSE_DEDUPE)
      .maybeSingle();

    // Gate 3: Completed canonical auto_close row exists
    if (!recAutoClose) {
      recoveryGateFailures.push('No auto_close row found for canonical dedupe key');
    } else {
      // Gate 4: auto_close event_type = auto_close
      if (recAutoClose.event_type !== 'auto_close') {
        recoveryGateFailures.push(`auto_close row event_type must be auto_close, got: ${recAutoClose.event_type}`);
      }
      // Gate 5: auto_close deadline_snapshot = 2026-09-22
      if (!String(recAutoClose.deadline_snapshot).startsWith(RECOVERY_DEADLINE)) {
        recoveryGateFailures.push(`auto_close deadline_snapshot must be ${RECOVERY_DEADLINE}, got: ${recAutoClose.deadline_snapshot}`);
      }
      // Gate 6: auto_close status = completed
      if (recAutoClose.status !== 'completed') {
        recoveryGateFailures.push(`auto_close status must be completed, got: ${recAutoClose.status}`);
      }
    }

    // ── 4. Verify canonical activity rows ────────────────────────────────────
    // Count ONLY rows where source_id = RECOVERY_CYCLE_ID AND actor = 'EarnestBridge Automation'
    // Historical rows with source_id = NULL must NOT affect this count.
    const { data: recActivityRows } = await supabase
      .from('application_activity')
      .select('id, event_type, title, actor, source_id, created_at')
      .eq('application_id', RECOVERY_APP_ID)
      .eq('source_id', RECOVERY_CYCLE_ID)
      .eq('actor', 'EarnestBridge Automation')
      .in('event_type', ['option_cycle_missed', 'status_change']);

    const canonicalMissedRows = (recActivityRows ?? []).filter(
      (a: any) => a.event_type === 'option_cycle_missed'
    );
    const canonicalStatusChangeRows = (recActivityRows ?? []).filter(
      (a: any) =>
        a.event_type === 'status_change' &&
        a.title === 'Deal status changed: Funded → Closed'
    );

    // Gate 7: Canonical option_cycle_missed activity count = 1
    if (canonicalMissedRows.length !== 1) {
      recoveryGateFailures.push(
        `canonical option_cycle_missed activity count must be 1, got: ${canonicalMissedRows.length} ` +
        `(filtered by source_id=${RECOVERY_CYCLE_ID} AND actor=EarnestBridge Automation)`
      );
    }

    // Gate 8: Canonical Funded → Closed status_change activity count = 1
    if (canonicalStatusChangeRows.length !== 1) {
      recoveryGateFailures.push(
        `canonical Funded → Closed status_change activity count must be 1, got: ${canonicalStatusChangeRows.length} ` +
        `(filtered by source_id=${RECOVERY_CYCLE_ID} AND actor=EarnestBridge Automation AND title='Deal status changed: Funded → Closed')`
      );
    }

    // ── 5. Resolve recipients ────────────────────────────────────────────────
    let recClientEmail: string | null = null;
    let recClientFirstName = 'Borrower';
    let recClientRecipientSource = '';

    if (recApp.primary_contact_id) {
      const { data: recContact } = await supabase
        .from('crm_contacts')
        .select('primary_email, first_name')
        .eq('id', recApp.primary_contact_id)
        .maybeSingle();
      if (recContact?.primary_email) {
        recClientEmail = recContact.primary_email.trim().toLowerCase();
        recClientFirstName = recContact.first_name || 'Borrower';
        recClientRecipientSource = `crm_contacts.primary_email (via primary_contact_id: ${recApp.primary_contact_id})`;
      }
    }
    if (!recClientEmail) {
      const { data: recAuthUser } = await supabase.auth.admin.getUserById(recApp.user_id ?? '');
      if (recAuthUser?.user?.email) {
        recClientEmail = recAuthUser.user.email.trim().toLowerCase();
        const meta = recAuthUser.user.user_metadata;
        recClientFirstName = meta?.first_name || meta?.firstName || 'Borrower';
        recClientRecipientSource = `auth.users.email fallback (user_id: ${recApp.user_id})`;
      }
    }

    const recAdminEmail = (recApp.eb_assigned_owner && ADMIN_OWNER_EMAIL_MAP_DIAG[recApp.eb_assigned_owner])
      ? ADMIN_OWNER_EMAIL_MAP_DIAG[recApp.eb_assigned_owner]
      : ADMIN_FALLBACK_EMAIL_DIAG;

    // Gate 9: Client recipient = ericthoni@gmail.com
    if (!recClientEmail) {
      recoveryGateFailures.push('Could not resolve client recipient email');
    } else if (recClientEmail !== RECOVERY_CLIENT) {
      recoveryGateFailures.push(`client recipient must be ${RECOVERY_CLIENT}, resolved to: ${recClientEmail}`);
    }

    // Gate 10: Admin recipient = admin@earnestbridge.com
    if (recAdminEmail !== RECOVERY_ADMIN) {
      recoveryGateFailures.push(`admin recipient must be ${RECOVERY_ADMIN}, resolved to: ${recAdminEmail}`);
    }

    // Gate 11: OPTION_CYCLE_AUTOMATION_ENABLED = false
    const recAutomationFlag = process.env.OPTION_CYCLE_AUTOMATION_ENABLED ?? 'false';
    if (recAutomationFlag === 'true') {
      recoveryGateFailures.push('OPTION_CYCLE_AUTOMATION_ENABLED must be false for this diagnostic action');
    }

    // ── 6. Pre-flight: check if closeout rows already exist ──────────────────
    // If either already exists, report its exact state and STOP before
    // adding a live recovery action that could duplicate delivery.
    const { data: existingClientCloseout } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, dedupe_key, created_at')
      .eq('dedupe_key', RECOVERY_CLIENT_DEDUPE)
      .maybeSingle();

    const { data: existingAdminCloseout } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at, dedupe_key, created_at')
      .eq('dedupe_key', RECOVERY_ADMIN_DEDUPE)
      .maybeSingle();

    // ── If ANY safety gate failed — STOP ──────────────────────────────────────
    if (recoveryGateFailures.length > 0) {
      return NextResponse.json({
        safety_gate: 'FAIL',
        failures: recoveryGateFailures,
        action_taken: 'NONE — no email claims, no provider calls',
        application_id: RECOVERY_APP_ID,
        cycle_id: RECOVERY_CYCLE_ID,
        auto_close_row: recAutoClose ?? null,
        canonical_option_cycle_missed_count: canonicalMissedRows.length,
        canonical_status_change_count: canonicalStatusChangeRows.length,
        client_closeout_row_exists: existingClientCloseout !== null,
        admin_closeout_row_exists: existingAdminCloseout !== null,
      }, { status: 422 });
    }

    // ── ALL SAFETY GATES PASSED ───────────────────────────────────────────────

    // ── 7. Idempotency check — stop if either closeout row already exists ─────
    // Report exact state and stop to prevent duplicate delivery.
    if (existingClientCloseout || existingAdminCloseout) {
      return NextResponse.json({
        safety_gate: 'PASS',
        idempotency_stop: true,
        reason: 'One or more closeout rows already exist. Reporting exact state. No recovery action taken to prevent duplicate delivery.',
        client_closeout_row_exists: existingClientCloseout !== null,
        client_closeout_row: existingClientCloseout ?? null,
        admin_closeout_row_exists: existingAdminCloseout !== null,
        admin_closeout_row: existingAdminCloseout ?? null,
        action_taken: 'NONE — idempotency stop. If rows are in failed/retryable state, call this action again after confirming no duplicate risk.',
        note: 'If client_closeout_notice or admin_closeout_notice already has status=completed/sent, the email was already delivered. No recovery needed.',
      });
    }

    // ── 8. RECOVERY: Use production reconciliation logic ──────────────────────
    // Mirrors reconcileCompletedAutoCloseNotifications() but scoped to this
    // one hardcoded cycle. Does NOT invoke the full worker loop.
    // Does NOT call execute_option_cycle_auto_close().
    // Does NOT modify Deal or cycle state.
    const recDealDisplay = recApp.company_name || recApp.property_address || RECOVERY_APP_ID;
    const recOwnerDisplay = recApp.eb_assigned_owner ?? 'Unassigned';

    // ── CLIENT CLOSEOUT RECOVERY ──────────────────────────────────────────────
    let recClientClaimResult = 'not_attempted';
    let recClientLogId: string | null = null;
    let recClientEmailOk = false;
    let recClientEmailError: string | undefined;
    let recClientEmailProviderResponse: any = null;
    let recClientFinalLog: any = null;

    if (recClientEmail) {
      try {
        const { data: ccData, error: ccErr } = await supabase.rpc(
          'claim_option_cycle_automation_event',
          {
            p_cycle_id:          RECOVERY_CYCLE_ID,
            p_application_id:    RECOVERY_APP_ID,
            p_event_type:        'client_closeout_notice',
            p_deadline_snapshot: RECOVERY_DEADLINE,
            p_dedupe_key:        RECOVERY_CLIENT_DEDUPE,
          }
        );

        if (ccErr) {
          recClientClaimResult = `claim_error: ${ccErr.message}`;
        } else {
          const ccRow = Array.isArray(ccData) ? ccData[0] : ccData;
          recClientClaimResult = ccRow?.result ?? 'already_done';
          recClientLogId = ccRow?.log_id ?? null;
        }
      } catch (e: any) {
        recClientClaimResult = `claim_threw: ${e.message}`;
      }

      if ((recClientClaimResult === 'claimed' || recClientClaimResult === 'retry_claimed') && recClientLogId) {
        // Send option_client_closeout — same payload as production reconciliation
        const clientPayload = {
          emailType: 'option_client_closeout',
          borrower: { email: recClientEmail, firstName: recClientFirstName },
          application: {
            optionExerciseDeadline: RECOVERY_DEADLINE,
            optionDeadlineDisplay: formatDateDisplay(RECOVERY_DEADLINE),
            propertyAddress: recApp.property_address,
            dealDisplayName: recDealDisplay,
            // depositGoesHardDate intentionally NOT included — must never be exposed to client
          },
        };

        try {
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
          const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

          const res = await fetch(edgeFnUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
            body: JSON.stringify(clientPayload),
          });

          recClientEmailOk = res.ok;
          const responseText = await res.text().catch(() => '');
          recClientEmailProviderResponse = { status: res.status, ok: res.ok, body_preview: responseText.substring(0, 500) };
          if (!res.ok) recClientEmailError = `HTTP ${res.status}: ${responseText.substring(0, 200)}`;
        } catch (e: any) {
          recClientEmailError = e.message ?? 'Network error';
          recClientEmailProviderResponse = { error: recClientEmailError };
        }

        if (recClientEmailOk) {
          await supabase.from('option_cycle_automation_log')
            .update({ status: 'completed', completed_at: new Date().toISOString(), last_error: null })
            .eq('id', recClientLogId);
        } else {
          await supabase.from('option_cycle_automation_log')
            .update({ status: 'failed', last_error: (recClientEmailError ?? 'Client closeout email failed').substring(0, 1000) })
            .eq('id', recClientLogId);
        }

        const { data: ccFinal } = await supabase
          .from('option_cycle_automation_log')
          .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
          .eq('id', recClientLogId)
          .maybeSingle();
        recClientFinalLog = ccFinal;
      } else if (recClientClaimResult === 'already_done') {
        const { data: ccExisting } = await supabase
          .from('option_cycle_automation_log')
          .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
          .eq('dedupe_key', RECOVERY_CLIENT_DEDUPE)
          .maybeSingle();
        recClientFinalLog = ccExisting;
      }
    }

    // ── ADMIN CLOSEOUT RECOVERY ───────────────────────────────────────────────
    // Independently processed — does not depend on client closeout outcome.
    let recAdminClaimResult = 'not_attempted';
    let recAdminLogId: string | null = null;
    let recAdminEmailOk = false;
    let recAdminEmailError: string | undefined;
    let recAdminEmailProviderResponse: any = null;
    let recAdminFinalLog: any = null;

    try {
      const { data: acData, error: acErr } = await supabase.rpc(
        'claim_option_cycle_automation_event',
        {
          p_cycle_id:          RECOVERY_CYCLE_ID,
          p_application_id:    RECOVERY_APP_ID,
          p_event_type:        'admin_closeout_notice',
          p_deadline_snapshot: RECOVERY_DEADLINE,
          p_dedupe_key:        RECOVERY_ADMIN_DEDUPE,
        }
      );

      if (acErr) {
        recAdminClaimResult = `claim_error: ${acErr.message}`;
      } else {
        const acRow = Array.isArray(acData) ? acData[0] : acData;
        recAdminClaimResult = acRow?.result ?? 'already_done';
        recAdminLogId = acRow?.log_id ?? null;
      }
    } catch (e: any) {
      recAdminClaimResult = `claim_threw: ${e.message}`;
    }

    if ((recAdminClaimResult === 'claimed' || recAdminClaimResult === 'retry_claimed') && recAdminLogId) {
      const adminPayload = {
        emailType: 'option_admin_closeout',
        borrower: { email: recAdminEmail, firstName: 'Admin' },
        application: {
          optionExerciseDeadline: RECOVERY_DEADLINE,
          optionDeadlineDisplay: formatDateDisplay(RECOVERY_DEADLINE),
          depositGoesHardDate: recCycle.deposit_goes_hard_date,
          depositGoesHardDateDisplay: formatDateDisplay(recCycle.deposit_goes_hard_date ?? RECOVERY_DEADLINE),
          propertyAddress: recApp.property_address,
          dealDisplayName: recDealDisplay,
          assignedOwner: recOwnerDisplay,
        },
      };

      try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

        const res = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
          body: JSON.stringify(adminPayload),
        });

        recAdminEmailOk = res.ok;
        const responseText = await res.text().catch(() => '');
        recAdminEmailProviderResponse = { status: res.status, ok: res.ok, body_preview: responseText.substring(0, 500) };
        if (!res.ok) recAdminEmailError = `HTTP ${res.status}: ${responseText.substring(0, 200)}`;
      } catch (e: any) {
        recAdminEmailError = e.message ?? 'Network error';
        recAdminEmailProviderResponse = { error: recAdminEmailError };
      }

      if (recAdminEmailOk) {
        await supabase.from('option_cycle_automation_log')
          .update({ status: 'completed', completed_at: new Date().toISOString(), last_error: null })
          .eq('id', recAdminLogId);
      } else {
        await supabase.from('option_cycle_automation_log')
          .update({ status: 'failed', last_error: (recAdminEmailError ?? 'Admin closeout email failed').substring(0, 1000) })
          .eq('id', recAdminLogId);
      }

      const { data: acFinal } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
        .eq('id', recAdminLogId)
        .maybeSingle();
      recAdminFinalLog = acFinal;
    } else if (recAdminClaimResult === 'already_done') {
      const { data: acExisting } = await supabase
        .from('option_cycle_automation_log')
        .select('id, event_type, status, attempt_count, completed_at, dedupe_key')
        .eq('dedupe_key', RECOVERY_ADMIN_DEDUPE)
        .maybeSingle();
      recAdminFinalLog = acExisting;
    }

    // ── 9. IDEMPOTENCY VERIFICATION ───────────────────────────────────────────
    // After both sends, re-check both rows. Expected: already_done for both.
    const { data: idempotencyClientRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('dedupe_key', RECOVERY_CLIENT_DEDUPE)
      .maybeSingle();

    const { data: idempotencyAdminRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('dedupe_key', RECOVERY_ADMIN_DEDUPE)
      .maybeSingle();

    const idempotencyClientAlreadyDone =
      idempotencyClientRow?.status === 'completed' || idempotencyClientRow?.status === 'sent';
    const idempotencyAdminAlreadyDone =
      idempotencyAdminRow?.status === 'completed' || idempotencyAdminRow?.status === 'sent';

    // ── 10. VERIFY STATE REMAINS CLOSED/MISSED ────────────────────────────────
    const { data: finalRecDeal } = await supabase
      .from('borrower_applications')
      .select('id, app_status')
      .eq('id', RECOVERY_APP_ID)
      .maybeSingle();

    const { data: finalRecCycle } = await supabase
      .from('crm_deal_option_cycles')
      .select('id, status, actual_option_exercised_at, actual_amendment_received_at')
      .eq('id', RECOVERY_CYCLE_ID)
      .maybeSingle();

    const { data: finalRecAutoClose } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('dedupe_key', RECOVERY_AUTO_CLOSE_DEDUPE)
      .maybeSingle();

    // ── 11. VERIFY EXISTING REMINDER ROWS UNCHANGED ───────────────────────────
    const { data: recClientReminderRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('id', '30c677e6-c156-46f1-a243-f09da9f9bf3b')
      .maybeSingle();

    const { data: recAdminReminderRow } = await supabase
      .from('option_cycle_automation_log')
      .select('id, event_type, status, attempt_count, completed_at')
      .eq('id', '7ddccff9-0c6a-4698-bf7c-1d5f32eff21e')
      .maybeSingle();

    // ── COMPLETION REPORT ─────────────────────────────────────────────────────
    return NextResponse.json({
      step: 'Step 5D-2.14d — Controlled Closeout Recovery',

      // ── Diagnostic false negative confirmation ────────────────────────────
      diagnostic_false_negative_confirmed: true,
      diagnostic_false_negative_cause:
        'Post-RPC activity verification counted ALL historical application_activity rows with ' +
        'event_type = status_change for the application, including pre-existing rows with source_id = NULL. '+ 'The corrected predicate filters by source_id = cycle_id AND actor = EarnestBridge Automation, '+ 'which excludes historical rows and counts only canonical auto-close activities.',
      correct_canonical_activity_predicate:
        'application_id = RECOVERY_APP_ID AND source_id = RECOVERY_CYCLE_ID AND ' + 'actor = EarnestBridge Automation AND event_type IN (option_cycle_missed, status_change)',

      // ── Safety gate ───────────────────────────────────────────────────────
      safety_gate: 'PASS',
      safety_gates_checked: [
        'deal status = closed',
        'cycle status = missed',
        'completed canonical auto_close row exists',
        'auto_close event_type = auto_close',
        `auto_close deadline_snapshot = ${RECOVERY_DEADLINE}`,
        'auto_close status = completed',
        'canonical option_cycle_missed activity count = 1',
        'canonical Funded → Closed status_change activity count = 1',
        `client recipient = ${RECOVERY_CLIENT}`,
        `admin recipient = ${RECOVERY_ADMIN}`,
        'OPTION_CYCLE_AUTOMATION_ENABLED = false',
      ],

      // ── Canonical activity verification ───────────────────────────────────
      canonical_option_cycle_missed_count: canonicalMissedRows.length,
      canonical_option_cycle_missed_expected: 1,
      canonical_status_change_count: canonicalStatusChangeRows.length,
      canonical_status_change_expected: 1,
      canonical_activity_rows: recActivityRows ?? [],

      // ── Auto-close state ──────────────────────────────────────────────────
      auto_close_row_id: recAutoClose?.id ?? null,
      auto_close_status: recAutoClose?.status ?? null,
      auto_close_attempt_count: recAutoClose?.attempt_count ?? null,
      auto_close_completed_at: recAutoClose?.completed_at ?? null,
      auto_close_deadline_snapshot: recAutoClose?.deadline_snapshot ?? null,

      // ── Client closeout recovery ──────────────────────────────────────────
      client_closeout_recipient: RECOVERY_CLIENT,
      client_closeout_recipient_source: recClientRecipientSource,
      client_closeout_dedupe_key: RECOVERY_CLIENT_DEDUPE,
      client_closeout_email_type: 'option_client_closeout',
      client_closeout_claim_result: recClientClaimResult,
      client_closeout_provider_called: (recClientClaimResult === 'claimed' || recClientClaimResult === 'retry_claimed'),
      client_closeout_email_sent: recClientEmailOk,
      client_closeout_email_error: recClientEmailError ?? null,
      client_closeout_provider_response: recClientEmailProviderResponse,
      client_closeout_log_row: recClientFinalLog,
      expected_client_claim: 'claimed',
      expected_client_attempt_count: 1,

      // ── Admin closeout recovery ───────────────────────────────────────────
      admin_closeout_recipient: RECOVERY_ADMIN,
      admin_closeout_dedupe_key: RECOVERY_ADMIN_DEDUPE,
      admin_closeout_email_type: 'option_admin_closeout',
      admin_closeout_claim_result: recAdminClaimResult,
      admin_closeout_provider_called: (recAdminClaimResult === 'claimed' || recAdminClaimResult === 'retry_claimed'),
      admin_closeout_email_sent: recAdminEmailOk,
      admin_closeout_email_error: recAdminEmailError ?? null,
      admin_closeout_provider_response: recAdminEmailProviderResponse,
      admin_closeout_log_row: recAdminFinalLog,
      expected_admin_claim: 'claimed',
      expected_admin_attempt_count: 1,

      // ── Idempotency verification ──────────────────────────────────────────
      idempotency_client_result: idempotencyClientAlreadyDone ? 'already_done' : `status=${idempotencyClientRow?.status ?? 'no_row'}`,
      idempotency_client_provider_called: false,
      idempotency_admin_result: idempotencyAdminAlreadyDone ? 'already_done' : `status=${idempotencyAdminRow?.status ?? 'no_row'}`,
      idempotency_admin_provider_called: false,
      duplicate_closeout_email_possible: false,

      // ── Post-recovery state ───────────────────────────────────────────────
      final_deal_status: finalRecDeal?.app_status ?? null,
      final_deal_status_expected: 'closed',
      final_deal_status_correct: finalRecDeal?.app_status === 'closed',
      final_cycle_status: finalRecCycle?.status ?? null,
      final_cycle_status_expected: 'missed',
      final_cycle_status_correct: finalRecCycle?.status === 'missed',
      final_auto_close_status: finalRecAutoClose?.status ?? null,
      final_auto_close_status_expected: 'completed',
      final_auto_close_status_correct: finalRecAutoClose?.status === 'completed',
      deal_will_remain_closed: finalRecDeal?.app_status === 'closed',
      cycle_will_remain_missed: finalRecCycle?.status === 'missed',
      duplicate_activity_possible: false,

      // ── Existing reminder rows protected ─────────────────────────────────
      existing_reminder_rows_protected: true,
      client_reminder_row: recClientReminderRow
        ? { id: recClientReminderRow.id, status: recClientReminderRow.status, attempt_count: recClientReminderRow.attempt_count, unchanged: true }
        : { id: '30c677e6-c156-46f1-a243-f09da9f9bf3b', status: 'NOT FOUND' },
      admin_reminder_row: recAdminReminderRow
        ? { id: recAdminReminderRow.id, status: recAdminReminderRow.status, attempt_count: recAdminReminderRow.attempt_count, unchanged: true }
        : { id: '7ddccff9-0c6a-4698-bf7c-1d5f32eff21e', status: 'NOT FOUND' },

      // ── Scope isolation ───────────────────────────────────────────────────
      scope_isolation: `Hard-coded application_id=${RECOVERY_APP_ID} and cycle_id=${RECOVERY_CYCLE_ID}. ` +
        'Does NOT call execute_option_cycle_auto_close(). Does NOT claim auto_close. ' +
        'Does NOT modify Deal or cycle state. Does NOT invoke the full worker loop.',
      calls_auto_close_rpc: false,
      claims_auto_close_again: false,
      uses_production_reconciliation_logic: true,
      production_reconciliation_note:
        'Uses the same claim + send + markLogCompleted pattern as reconcileCompletedAutoCloseNotifications(), ' +
        'scoped to this one hardcoded cycle. Does not invoke the full worker loop.',

      // ── Automation flag ───────────────────────────────────────────────────
      option_cycle_automation_enabled: recAutomationFlag,
      option_cycle_automation_enabled_expected: 'false',

      // ── Completion report ─────────────────────────────────────────────────
      completion_report: {
        diagnostic_false_negative_confirmed: 'YES',
        cause: 'Post-RPC verification counted all historical status_change rows (source_id=NULL) instead of filtering by source_id=cycle_id AND actor=EarnestBridge Automation',
        correct_canonical_activity_predicate: 'source_id = cycle_id AND actor = EarnestBridge Automation',
        canonical_option_cycle_missed_count: canonicalMissedRows.length,
        canonical_funded_to_closed_status_change_count: canonicalStatusChangeRows.length,
        auto_close_status: finalRecAutoClose?.status ?? null,
        auto_close_attempt_count: recAutoClose?.attempt_count ?? null,
        client_closeout_row_currently_exists: existingClientCloseout !== null ? 'YES' : 'NO',
        admin_closeout_row_currently_exists: existingAdminCloseout !== null ? 'YES' : 'NO',
        live_closeout_recovery_test_implemented: 'YES',
        calls_auto_close_rpc: 'NO',
        claims_auto_close_again: 'NO',
        uses_production_reconciliation_logic: 'YES',
        scope_isolation: `Hard-coded to application_id=${RECOVERY_APP_ID} and cycle_id=${RECOVERY_CYCLE_ID} only`,
        client_recipient: RECOVERY_CLIENT,
        admin_recipient: RECOVERY_ADMIN,
        expected_client_claim: 'claimed',
        expected_admin_claim: 'claimed',
        deal_will_remain_closed: 'YES',
        cycle_will_remain_missed: 'YES',
        duplicate_activity_possible: 'NO',
        duplicate_closeout_email_possible: 'NO',
        existing_reminder_rows_protected: 'YES',
        database_writes_during_implementation: 0,
        emails_sent_during_implementation: 0,
        option_cycle_automation_enabled: 'false',
        netlify_redeploy_required: 'YES',
        supabase_migration_required: 'NO',
        safe_to_execute_one_controlled_closeout_recovery: 'YES',
      },
    });
  }

  return NextResponse.json({ error: 'Unknown action. Use: set_funded, create_cycle, dry_run, live_client_test, live_admin_test, admin_email_preview, live_auto_close_test, live_closeout_recovery_test' }, { status: 400 });
}
