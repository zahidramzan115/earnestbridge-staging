/**
 * Option Cycle Automation Worker — Step 5D-2 / Step 5D-2.6a Hardened
 *
 * PRODUCTION ACTIVATION GATE:
 *   OPTION_CYCLE_AUTOMATION_ENABLED=true  → live sends + auto-close
 *   absent / false                        → dry-run only (no sends, no closes)
 *
 * SCHEDULER: Runs HOURLY via Netlify Scheduled Function
 *   (netlify/functions/option-cycle-automation.ts)
 *   The Netlify function calls runOptionCycleAutomation() directly —
 *   it does NOT call this HTTP endpoint.
 *
 * REMINDER DELIVERY WINDOW:
 *   Reminders are sent during the first worker execution at or after
 *   9:00 AM America/New_York on the applicable reminder day.
 *   Database idempotency (option_cycle_automation_log) ensures only
 *   one reminder per recipient/window is sent even across retries.
 *
 * CLOSEOUT WINDOW:
 *   At the first worker execution AFTER 5:00 PM America/New_York on
 *   the Option Exercise Deadline, unresolved cycles are evaluated.
 *   Exactly 5:00:00 PM is still timely — closeout only after cutoff.
 *
 * DRY-RUN CONTRACT (5D-2.1 HARDENED):
 *   When dryRun = true, the worker MUST NOT write to option_cycle_automation_log.
 *   It reads existing rows only to determine would_send/would_skip/would_close.
 *   No INSERT, no UPDATE, no claimed_at written.
 *   Dry-run CANNOT poison the live dedupe key.
 *
 * EVALUATION TIME OVERRIDE (5D-2.6a):
 *   evaluationTime?: Date — optional, in-memory only, NEVER stored.
 *   When supplied, all Eastern date/hour/reminder/closeout decisions use
 *   this instant instead of the real current time.
 *   SAFETY: this parameter is only accepted by the HTTP route when ALL are true:
 *     - method = POST
 *     - dry_run=true
 *     - authenticated Admin session
 *   The Netlify Scheduled Function NEVER passes evaluationTime.
 *   Live automation (dryRun=false) NEVER uses evaluationTime.
 *   Business timezone remains America/New_York regardless.
 *
 * CLAIM MODEL (5D-2.1 HARDENED):
 *   All live claims go through the atomic DB RPC:
 *     claim_option_cycle_automation_event(...)
 *   Result contract: claimed | already_done | currently_claimed |
 *                    retry_claimed | max_attempts_reached
 *   Claim lease: 15 minutes (stale pending may be reclaimed)
 *   Max attempts: 3 (after 3 failures, max_attempts_reached)
 *   Failed events are retryable (attempt_count < 3)
 *
 * BUSINESS RULES:
 *   - Reminders: 7 / 5 / 3 / 1 calendar days before Option Exercise Deadline
 *   - Cutoff: 5:00 PM America/New_York (DST-safe via IANA timezone)
 *   - Satisfied cycle: timely exercise OR timely amendment (fee NOT required)
 *   - Late exercise / late amendment → NOT satisfied automatically
 *   - Client reminders: NEVER expose Deposit Goes Hard Date
 *   - Admin reminders: may reference internal operational info
 *   - Only funded deals with active option cycles are candidates
 *   - Closed/missed cycles do NOT receive future reminders
 *
 * CRM CONTACT RECIPIENT FIELD (5D-2.1 VERIFIED):
 *   crm_contacts.primary_email  (NOT .email — confirmed from live schema)
 *
 * ADMIN RECIPIENT LOGIC:
 *   1. Deal eb_assigned_owner → ADMIN_OWNER_EMAIL_MAP
 *   2. Fallback: ADMIN_FALLBACK_EMAIL (admin@earnestbridge.com)
 *
 * CLIENT RECIPIENT LOGIC:
 *   1. Deal primary_contact_id → crm_contacts.primary_email (trim+lowercase)
 *   2. Fallback: borrower_applications user → auth.users email
 *
 * ESCROW: NOT TOUCHED. CRM-only closeout.
 */

import { createClient } from '@supabase/supabase-js';
import { getOptionDeadlineCutoff, isTimely } from '@/app/api/admin/option-cycles/route';

// ── Admin owner email mapping (canonical) ─────────────────────────────────────
const ADMIN_OWNER_EMAIL_MAP: Record<string, string> = {
  'Eric': 'admin@earnestbridge.com',
  'Dan': 'deals@earnestbridge.com',
  'Tucker': 'legal@earnestbridge.com',
};
const ADMIN_FALLBACK_EMAIL = 'admin@earnestbridge.com';

// ── Reminder cadence (calendar days before Option Exercise Deadline) ──────────
const REMINDER_OFFSETS = [7, 5, 3, 1] as const;
type ReminderOffset = typeof REMINDER_OFFSETS[number];

// ── Claim result contract ─────────────────────────────────────────────────────
type ClaimResult =
  | 'claimed' |'already_done' |'currently_claimed' |'retry_claimed' |'max_attempts_reached';

// ── ET timezone helpers ───────────────────────────────────────────────────────
//
// All helpers accept an optional `at` Date parameter.
// When supplied (evaluation_time override), that instant is used.
// When absent, the real current time (new Date()) is used.
// Business timezone is always America/New_York.
// No hardcoded UTC-4 or UTC-5 offsets anywhere.

function getCurrentETHour(at?: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  });
  return parseInt(formatter.format(at ?? new Date()), 10);
}

function getTodayETDateStr(at?: Date): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(at ?? new Date());
  const y = parts.find(p => p.type === 'year')?.value ?? '';
  const m = parts.find(p => p.type === 'month')?.value ?? '';
  const d = parts.find(p => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${d}`;
}

function addCalendarDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split('T')[0];
}

function subtractCalendarDays(dateStr: string, days: number): string {
  return addCalendarDays(dateStr, -days);
}

function formatDateDisplay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

// ── Known placeholder values that must be treated as MISSING ─────────────────

const SERVICE_ROLE_PLACEHOLDERS = [
  'your-supabase-service-role-key-here',
  'placeholder',
  'changeme',
  'todo',
];

function isServiceRolePlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return SERVICE_ROLE_PLACEHOLDERS.some(p => lower === p) ||
    lower.startsWith('your-') ||
    lower.startsWith('change-');
}

// ── Validate SUPABASE_SERVICE_ROLE_KEY is present, non-empty, non-placeholder ─

function validateServiceRoleKey(): { valid: boolean; key: string | null } {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.trim() === '' || isServiceRolePlaceholder(key)) {
    return { valid: false, key: null };
  }
  return { valid: true, key };
}

// ── Supabase service client ───────────────────────────────────────────────────
//
// 5D-2.3 HARDENED: Requires SUPABASE_SERVICE_ROLE_KEY.
// NO fallback to NEXT_PUBLIC_SUPABASE_ANON_KEY.
// Missing, empty, or placeholder → throws configuration error.
// Worker must not run with anon-key privileges.

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error('Required server environment variable is not configured.');
  }

  const { valid, key } = validateServiceRoleKey();
  if (!valid || !key) {
    throw new Error('Required server environment variable is not configured.');
  }

  return createClient(url, key);
}

// ── Edge function URL ─────────────────────────────────────────────────────────

function getEdgeFnUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('Required server environment variable is not configured.');
  return `${url}/functions/v1/send-borrower-emails`;
}

// 5D-2.3 HARDENED: Edge function headers use SUPABASE_SERVICE_ROLE_KEY only.
// NO fallback to NEXT_PUBLIC_SUPABASE_ANON_KEY.

function getEdgeHeaders(): Record<string, string> {
  const { valid, key } = validateServiceRoleKey();
  if (!valid || !key) {
    throw new Error('Required server environment variable is not configured.');
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  };
}

// ── Resolve admin recipient ───────────────────────────────────────────────────

function resolveAdminEmail(ebAssignedOwner: string | null): string {
  if (ebAssignedOwner && ADMIN_OWNER_EMAIL_MAP[ebAssignedOwner]) {
    return ADMIN_OWNER_EMAIL_MAP[ebAssignedOwner];
  }
  return ADMIN_FALLBACK_EMAIL;
}

// ── Resolve client recipient ──────────────────────────────────────────────────
// CRM CONTACT FIELD: crm_contacts.primary_email (verified from live schema)
// Normalized: trim + lowercase for dedupe keys

async function resolveClientEmail(
  supabase: ReturnType<typeof getServiceClient>,
  applicationId: string,
  primaryContactId: string | null
): Promise<{ email: string; firstName: string } | null> {
  // 1. Try primary_contact_id → crm_contacts.primary_email
  if (primaryContactId) {
    const { data: contact } = await supabase
      .from('crm_contacts')
      .select('primary_email, first_name')
      .eq('id', primaryContactId)
      .maybeSingle();
    if (contact?.primary_email) {
      return {
        email: contact.primary_email.trim().toLowerCase(),
        firstName: contact.first_name || 'Borrower',
      };
    }
  }

  // 2. Fallback: borrower_applications.user_id → auth user email
  const { data: app } = await supabase
    .from('borrower_applications')
    .select('user_id')
    .eq('id', applicationId)
    .is('purged_at', null)
    .maybeSingle();

  if (app?.user_id) {
    const { data: authUser } = await supabase.auth.admin.getUserById(app.user_id);
    if (authUser?.user?.email) {
      const meta = authUser.user.user_metadata;
      const firstName = meta?.first_name || meta?.firstName || 'Borrower';
      return {
        email: authUser.user.email.trim().toLowerCase(),
        firstName,
      };
    }
  }

  return null;
}

// ── Atomic claim via DB RPC ───────────────────────────────────────────────────
//
// Calls the claim_option_cycle_automation_event() PostgreSQL function which
// atomically determines the correct claim outcome using SELECT FOR UPDATE.
// This prevents two concurrent workers from racing on the same event.
//
// NEVER call this during dry-run. Dry-run must not write to the log table.

async function atomicClaim(
  supabase: ReturnType<typeof getServiceClient>,
  cycleId: string,
  applicationId: string,
  eventType: string,
  deadlineSnapshot: string,
  dedupeKey: string
): Promise<{ result: ClaimResult; logId: string | null }> {
  const { data, error } = await supabase.rpc('claim_option_cycle_automation_event', {
    p_cycle_id: cycleId,
    p_application_id: applicationId,
    p_event_type: eventType,
    p_deadline_snapshot: deadlineSnapshot,
    p_dedupe_key: dedupeKey,
  });

  if (error) {
    throw new Error(`Claim RPC failed: ${error.message}`);
  }

  // RPC returns TABLE(result text, log_id uuid) — data is an array of rows
  const row = Array.isArray(data) ? data[0] : data;
  return {
    result: (row?.result ?? 'already_done') as ClaimResult,
    logId: row?.log_id ?? null,
  };
}

// ── Dry-run: check existing log row (read-only, no writes) ───────────────────
//
// Returns the existing row status if found, or null if no row exists.
// Used by dry-run to report would_send / would_skip without touching the table.

async function dryRunCheckExisting(
  supabase: ReturnType<typeof getServiceClient>,
  dedupeKey: string
): Promise<{ status: string; attemptCount: number } | null> {
  const { data } = await supabase
    .from('option_cycle_automation_log')
    .select('status, attempt_count')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();

  if (!data) return null;
  return { status: data.status, attemptCount: data.attempt_count };
}

// ── Update log row after successful action ────────────────────────────────────

async function markLogSent(
  supabase: ReturnType<typeof getServiceClient>,
  logId: string
) {
  await supabase
    .from('option_cycle_automation_log')
    .update({
      status: 'sent',
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', logId);
}

async function markLogCompleted(
  supabase: ReturnType<typeof getServiceClient>,
  logId: string
) {
  await supabase
    .from('option_cycle_automation_log')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', logId);
}

async function markLogFailed(
  supabase: ReturnType<typeof getServiceClient>,
  logId: string,
  errorMsg: string
) {
  // CORRECTED SEMANTICS (Step 5D-2.9b):
  // attempt_count is incremented exactly once per provider delivery attempt,
  // at claim time (inside claim_option_cycle_automation_event RPC).
  //
  // markLogFailed must NOT increment attempt_count.
  // The count was already incremented when the claim was authorized.
  //
  // State machine:
  //   claimed        → attempt_count = 1  (first attempt authorized)
  //   provider fails → markLogFailed sets status = failed, attempt_count unchanged = 1
  //   retry_claimed  → attempt_count = 2  (second attempt authorized by claim RPC)
  //   provider fails → markLogFailed sets status = failed, attempt_count unchanged = 2
  //   retry_claimed  → attempt_count = 3  (third attempt authorized by claim RPC)
  //   provider fails → markLogFailed sets status = failed, attempt_count unchanged = 3
  //   next claim     → max_attempts_reached (attempt_count >= 3)
  await supabase
    .from('option_cycle_automation_log')
    .update({
      status: 'failed',
      last_error: errorMsg.substring(0, 1000), // cap length; never store tokens/keys
    })
    .eq('id', logId);

  // DO NOT call increment_automation_log_attempt here.
  // That RPC has been dropped. attempt_count is managed solely by the claim RPC.
}

// ── Send email via edge function ──────────────────────────────────────────────

async function sendEmail(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(getEdgeFnUrl(), {
      method: 'POST',
      headers: getEdgeHeaders(),
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${body.substring(0, 200)}` };
  } catch (e: any) {
    return { ok: false, error: e.message ?? 'Network error' };
  }
}

// ── Log activity ──────────────────────────────────────────────────────────────

async function logActivity(
  supabase: ReturnType<typeof getServiceClient>,
  applicationId: string,
  userId: string | null,
  eventType: string,
  title: string,
  detail: string
) {
  try {
    await supabase.from('application_activity').insert({
      application_id: applicationId,
      user_id: userId,
      event_type: eventType,
      title,
      detail,
      actor: 'EarnestBridge Automation',
    });
  } catch {
    // Best-effort
  }
}

// ── Reconcile completed auto-close notifications ──────────────────────────────
//
// Step 5D-2.13b: Durable closeout recovery phase.
//
// Runs on every enabled worker execution, INDEPENDENTLY of the candidate
// query that selects active/funded cycles.
//
// Eligibility predicate (canonical evidence required):
//   option_cycle_automation_log.event_type = 'auto_close'
//   option_cycle_automation_log.status     = 'completed'
//   crm_deal_option_cycles.status          = 'missed'
//
// Deal app_status is intentionally NOT part of the predicate: a missed
// Option Cycle is independent of the Deal's status (historical records may be
// missed + closed; newer records may be missed + funded).
//
// The completed auto_close log + missed cycle are the authoritative evidence
// that an automated Option Exercise Deadline miss occurred. A manual Deal
// closure never produces a completed auto_close log row.
//
// For each qualifying record, independently processes:
//   client_closeout_notice  — dedupe key: option:<cycle_id>:<deadline>:client_closeout_notice:<client_email>
//   admin_closeout_notice   — dedupe key: option:<cycle_id>:<deadline>:admin_closeout_notice:<admin_email>
//
// Each notice is independently recoverable:
//   - No row:              claim and send
//   - Failed/retryable:    retry per canonical attempt rules (max 3)
//   - Sent/completed:      already_done → do nothing
//   - Max attempts:        log and skip
//
// Neither notice depends on the other. A crash between them is fully
// recoverable on the next run.

interface ReconcileResult {
  cycleId: string;
  applicationId: string;
  dealDisplay: string;
  action: string;
  outcome: WorkerCycleResult['outcome'];
  reason?: string;
}

async function reconcileCompletedAutoCloseNotifications(
  supabase: ReturnType<typeof getServiceClient>
): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];

  // ── Fetch all completed auto_close log rows ─────────────────────────────
  // Join to cycle and deal to verify canonical evidence.
  // We only process rows where the cycle is missed (Deal status is not required).
  // A completed auto_close log row is the evidence of an automated miss.
  const { data: completedLogs, error: logsError } = await supabase
    .from('option_cycle_automation_log')
    .select(`
      id,
      cycle_id,
      application_id,
      deadline_snapshot,
      completed_at
    `)
    .eq('event_type', 'auto_close')
    .eq('status', 'completed');

  if (logsError || !completedLogs || completedLogs.length === 0) {
    return results;
  }

  // Fetch cycle and deal state for all qualifying log rows
  const cycleIds = completedLogs.map((l: any) => l.cycle_id);
  const appIds   = completedLogs.map((l: any) => l.application_id);

  const [{ data: cycles }, { data: deals }] = await Promise.all([
    supabase
      .from('crm_deal_option_cycles')
      .select('id, application_id, status, option_exercise_deadline, deposit_goes_hard_date')
      .in('id', cycleIds),
    supabase
      .from('borrower_applications')
      .select('id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id, user_id')
      .is('purged_at', null)
      .in('id', appIds),
  ]);

  const cycleMap: Record<string, any> = {};
  (cycles ?? []).forEach((c: any) => { cycleMap[c.id] = c; });
  const dealMap: Record<string, any> = {};
  (deals ?? []).forEach((d: any) => { dealMap[d.id] = d; });

  for (const log of completedLogs) {
    const cycle = cycleMap[log.cycle_id];
    const deal  = dealMap[log.application_id];

    // ── Canonical evidence check ──────────────────────────────────────────
    // Must have: completed auto_close log (selected above) AND cycle = missed.
    // Deal app_status is NOT checked — works for historical missed + closed
    // and future missed + funded records. Missing/purged records are skipped.
    if (!cycle || !deal) continue;
    if (cycle.status !== 'missed') continue;

    const deadline    = log.deadline_snapshot ?? cycle.option_exercise_deadline;
    const dealDisplay = deal.company_name || deal.property_address || log.application_id;

    // ── Client closeout notice ────────────────────────────────────────────
    const clientRecipient = await resolveClientEmail(supabase, log.application_id, deal.primary_contact_id);
    if (clientRecipient) {
      const clientDedupeKey = `option:${log.cycle_id}:${deadline}:client_closeout_notice:${clientRecipient.email}`;
      let clientClaimResult: { result: ClaimResult; logId: string | null };
      try {
        clientClaimResult = await atomicClaim(
          supabase, log.cycle_id, log.application_id,
          'client_closeout_notice', deadline, clientDedupeKey
        );
      } catch (e: any) {
        results.push({
          cycleId: log.cycle_id, applicationId: log.application_id,
          dealDisplay, action: 'client_closeout_notice (reconcile)',
          outcome: 'failed', reason: `Claim error: ${e.message}`,
        });
        continue;
      }

      if (clientClaimResult.result === 'already_done') {
        results.push({
          cycleId: log.cycle_id, applicationId: log.application_id,
          dealDisplay, action: 'client_closeout_notice (reconcile)',
          outcome: 'already_done', reason: 'Already sent',
        });
      } else if (clientClaimResult.result === 'currently_claimed') {
        results.push({
          cycleId: log.cycle_id, applicationId: log.application_id,
          dealDisplay, action: 'client_closeout_notice (reconcile)',
          outcome: 'currently_claimed', reason: 'Another worker owns this claim',
        });
      } else if (clientClaimResult.result === 'max_attempts_reached') {
        results.push({
          cycleId: log.cycle_id, applicationId: log.application_id,
          dealDisplay, action: 'client_closeout_notice (reconcile)',
          outcome: 'max_attempts_reached', reason: 'Max 3 attempts reached — Admin must investigate',
        });
      } else if ((clientClaimResult.result === 'claimed' || clientClaimResult.result === 'retry_claimed') && clientClaimResult.logId) {
        const emailResult = await sendEmail({
          emailType: 'option_client_closeout',
          borrower: { email: clientRecipient.email, firstName: clientRecipient.firstName },
          application: {
            optionExerciseDeadline: deadline,
            optionDeadlineDisplay: formatDateDisplay(deadline),
            propertyAddress: deal.property_address,
            dealDisplayName: deal.company_name || deal.property_address,
          },
        });
        if (emailResult.ok) {
          await markLogCompleted(supabase, clientClaimResult.logId);
          results.push({
            cycleId: log.cycle_id, applicationId: log.application_id,
            dealDisplay, action: 'client_closeout_notice (reconcile)',
            outcome: 'sent',
            reason: clientClaimResult.result === 'retry_claimed' ? 'Retry succeeded' : undefined,
          });
        } else {
          await markLogFailed(supabase, clientClaimResult.logId, emailResult.error ?? 'Client closeout email failed');
          results.push({
            cycleId: log.cycle_id, applicationId: log.application_id,
            dealDisplay, action: 'client_closeout_notice (reconcile)',
            outcome: 'failed', reason: emailResult.error ?? 'Client closeout email failed',
          });
        }
      }
    }

    // ── Admin closeout notice ─────────────────────────────────────────────
    // Independently processed — does not depend on client closeout outcome.
    const adminEmail = resolveAdminEmail(deal.eb_assigned_owner);
    const adminDedupeKey = `option:${log.cycle_id}:${deadline}:admin_closeout_notice:${adminEmail.toLowerCase()}`;
    let adminClaimResult: { result: ClaimResult; logId: string | null };
    try {
      adminClaimResult = await atomicClaim(
        supabase, log.cycle_id, log.application_id,
        'admin_closeout_notice', deadline, adminDedupeKey
      );
    } catch (e: any) {
      results.push({
        cycleId: log.cycle_id, applicationId: log.application_id,
        dealDisplay, action: 'admin_closeout_notice (reconcile)',
        outcome: 'failed', reason: `Claim error: ${e.message}`,
      });
      continue;
    }

    if (adminClaimResult.result === 'already_done') {
      results.push({
        cycleId: log.cycle_id, applicationId: log.application_id,
        dealDisplay, action: 'admin_closeout_notice (reconcile)',
        outcome: 'already_done', reason: 'Already sent',
      });
    } else if (adminClaimResult.result === 'currently_claimed') {
      results.push({
        cycleId: log.cycle_id, applicationId: log.application_id,
        dealDisplay, action: 'admin_closeout_notice (reconcile)',
        outcome: 'currently_claimed', reason: 'Another worker owns this claim',
      });
    } else if (adminClaimResult.result === 'max_attempts_reached') {
      results.push({
        cycleId: log.cycle_id, applicationId: log.application_id,
        dealDisplay, action: 'admin_closeout_notice (reconcile)',
        outcome: 'max_attempts_reached', reason: 'Max 3 attempts reached — Admin must investigate',
      });
    } else if ((adminClaimResult.result === 'claimed' || adminClaimResult.result === 'retry_claimed') && adminClaimResult.logId) {
      const emailResult = await sendEmail({
        emailType: 'option_admin_closeout',
        borrower: { email: adminEmail, firstName: 'Admin' },
        application: {
          optionExerciseDeadline: deadline,
          optionDeadlineDisplay: formatDateDisplay(deadline),
          depositGoesHardDate: cycle.deposit_goes_hard_date,
          propertyAddress: deal.property_address,
          dealDisplayName: deal.company_name || deal.property_address,
          assignedOwner: deal.eb_assigned_owner,
        },
      });
      if (emailResult.ok) {
        await markLogCompleted(supabase, adminClaimResult.logId);
        results.push({
          cycleId: log.cycle_id, applicationId: log.application_id,
          dealDisplay, action: 'admin_closeout_notice (reconcile)',
          outcome: 'sent',
          reason: adminClaimResult.result === 'retry_claimed' ? 'Retry succeeded' : undefined,
        });
      } else {
        await markLogFailed(supabase, adminClaimResult.logId, emailResult.error ?? 'Admin closeout email failed');
        results.push({
          cycleId: log.cycle_id, applicationId: log.application_id,
          dealDisplay, action: 'admin_closeout_notice (reconcile)',
          outcome: 'failed', reason: emailResult.error ?? 'Admin closeout email failed',
        });
      }
    }
  }

  return results;
}

// ── Worker result types ───────────────────────────────────────────────────────

export interface WorkerCycleResult {
  cycleId: string;
  applicationId: string;
  dealDisplay: string;
  action: string;
  outcome:
    | 'sent' |'skipped' |'would_send' |'would_close' |'would_skip' |'closed' |'failed' |'already_done' |'currently_claimed' |'max_attempts_reached' |'retry_claimed';
  reason?: string;
}

export interface WorkerRunResult {
  dryRun: boolean;
  automationEnabled: boolean;
  etHour: number;
  todayET: string;
  reminderWindowOpen: boolean;
  closeoutWindowOpen: boolean;
  candidatesEvaluated: number;
  results: WorkerCycleResult[];
  errors: string[];
  evaluationTimeUsed?: string; // ISO string of the evaluation instant, only present when override was applied
}

// ── Main worker function ──────────────────────────────────────────────────────
//
// opts.evaluationTime:
//   Optional. When supplied, all Eastern date/hour decisions use this instant.
//   SAFETY CONTRACT (enforced by the HTTP route, not here):
//     - Only accepted for Admin-session POST dry-run requests.
//     - The Netlify Scheduled Function never passes this.
//     - Live automation (dryRun=false) should never pass this.
//   The worker itself does NOT enforce the Admin-session requirement —
//   that enforcement lives in the HTTP route layer.
//   If evaluationTime is supplied but dryRun=false, the worker uses real time
//   as an additional safety measure (live automation always uses real time).

export async function runOptionCycleAutomation(opts: {
  dryRun?: boolean;
  forceDryRun?: boolean;
  evaluationTime?: Date;
}): Promise<WorkerRunResult> {
  const automationEnabled = process.env.OPTION_CYCLE_AUTOMATION_ENABLED === 'true';
  const dryRun = opts.dryRun === true || opts.forceDryRun === true || !automationEnabled;

  // SAFETY: evaluation_time override is only used in dry-run mode.
  // Live automation always uses real current time, regardless of what was passed.
  const effectiveAt: Date | undefined = (dryRun && opts.evaluationTime instanceof Date && !isNaN(opts.evaluationTime.getTime()))
    ? opts.evaluationTime
    : undefined;

  // All Eastern time decisions use effectiveAt when present, real time otherwise.
  // Business timezone is always America/New_York.
  const etHour = getCurrentETHour(effectiveAt);
  const todayET = getTodayETDateStr(effectiveAt);

  // Reminder window: first execution at or after 9:00 AM ET
  const reminderWindowOpen = etHour >= 9;

  // Closeout window: first execution AFTER 5:00 PM ET (17:00)
  // Exactly 5:00 PM is still timely — we close only after 17:00
  const closeoutWindowOpen = etHour >= 17;

  const results: WorkerCycleResult[] = [];
  const errors: string[] = [];

  const supabase = getServiceClient();

  // ── Fetch active option cycles for funded deals ───────────────────────────
  const { data: cycles, error: cyclesError } = await supabase
    .from('crm_deal_option_cycles')
    .select(`
      id,
      application_id,
      cycle_number,
      deposit_goes_hard_date,
      option_exercise_deadline,
      status,
      actual_option_exercised_at,
      option_exercised_at,
      actual_amendment_received_at,
      extension_psa_amendment_received_at,
      extension_fee_paid_at
    `)
    .eq('status', 'active');

  if (cyclesError) {
    errors.push(`Failed to fetch active cycles: ${cyclesError.message}`);
    return {
      dryRun, automationEnabled, etHour, todayET,
      reminderWindowOpen, closeoutWindowOpen,
      candidatesEvaluated: 0, results, errors,
      ...(effectiveAt ? { evaluationTimeUsed: effectiveAt.toISOString() } : {}),
    };
  }

  if (!cycles || cycles.length === 0) {
    return {
      dryRun, automationEnabled, etHour, todayET,
      reminderWindowOpen, closeoutWindowOpen,
      candidatesEvaluated: 0, results, errors,
      ...(effectiveAt ? { evaluationTimeUsed: effectiveAt.toISOString() } : {}),
    };
  }

  // Fetch deal context for all application IDs
  const appIds = cycles.map((c: any) => c.application_id);
  const { data: deals } = await supabase
    .from('borrower_applications')
    .select('id, user_id, app_status, property_address, company_name, eb_assigned_owner, primary_contact_id')
    .is('purged_at', null)
    .in('id', appIds);

  const dealMap: Record<string, any> = {};
  (deals ?? []).forEach((d: any) => { dealMap[d.id] = d; });

  let candidatesEvaluated = 0;

  for (const cycle of cycles) {
    const deal = dealMap[cycle.application_id];
    if (!deal) continue;

    // Only funded deals are valid candidates for active option cycle automation
    if (deal.app_status !== 'funded') continue;

    candidatesEvaluated++;

    const dealDisplay = deal.company_name || deal.property_address || cycle.application_id;
    const deadline = cycle.option_exercise_deadline;
    const cutoff = getOptionDeadlineCutoff(deadline);

    // ── Determine satisfaction ──────────────────────────────────────────────
    // Canonical timeliness fields:
    //   actual_option_exercised_at  → canonical exercise timeliness
    //   actual_amendment_received_at → canonical amendment timeliness
    // Fallback to legacy fields for backward compat.

    const exerciseTs = cycle.actual_option_exercised_at ?? cycle.option_exercised_at;
    const amendmentTs = cycle.actual_amendment_received_at ?? cycle.extension_psa_amendment_received_at;

    const timelyExercise = exerciseTs ? isTimely(exerciseTs, deadline) : false;
    const timelyAmendment = amendmentTs ? isTimely(amendmentTs, deadline) : false;
    const isSatisfied = timelyExercise || timelyAmendment;

    // ── Reminder logic ──────────────────────────────────────────────────────
    if (reminderWindowOpen && !isSatisfied) {
      for (const offset of REMINDER_OFFSETS) {
        const reminderDay = subtractCalendarDays(deadline, offset);

        // Only send reminder if today (Eastern) is the reminder day
        if (todayET !== reminderDay) continue;

        // Resolve recipients
        const adminEmail = resolveAdminEmail(deal.eb_assigned_owner);
        const clientRecipient = await resolveClientEmail(supabase, cycle.application_id, deal.primary_contact_id);

        // ── Client reminder ───────────────────────────────────────────────
        if (clientRecipient) {
          const clientEventType = `client_reminder_${offset}d` as string;
          const clientDedupeKey = `option:${cycle.id}:${deadline}:${clientEventType}:${clientRecipient.email}`;

          if (dryRun) {
            // DRY-RUN: read-only check, NO writes to automation log
            const existing = await dryRunCheckExisting(supabase, clientDedupeKey);
            let dryOutcome: WorkerCycleResult['outcome'] = 'would_send';
            let dryReason = `Would send to ${clientRecipient.email} (${offset}d reminder)`;

            if (existing) {
              if (existing.status === 'sent' || existing.status === 'completed') {
                dryOutcome = 'would_skip';
                dryReason = `Would skip: existing ${existing.status} row`;
              } else if (existing.status === 'failed' && existing.attemptCount >= 3) {
                dryOutcome = 'would_skip';
                dryReason = `Would skip: max_attempts_reached (${existing.attemptCount} failures)`;
              } else {
                dryOutcome = 'would_send';
                dryReason = `Would retry: existing ${existing.status} row (attempt ${existing.attemptCount})`;
              }
            }

            results.push({
              cycleId: cycle.id, applicationId: cycle.application_id,
              dealDisplay, action: clientEventType,
              outcome: dryOutcome, reason: dryReason,
            });
          } else {
            // LIVE: atomic claim via DB RPC
            let claimResult: { result: ClaimResult; logId: string | null };
            try {
              claimResult = await atomicClaim(
                supabase, cycle.id, cycle.application_id,
                clientEventType, deadline, clientDedupeKey
              );
            } catch (e: any) {
              errors.push(`Claim failed for ${clientEventType}: ${e.message}`);
              results.push({
                cycleId: cycle.id, applicationId: cycle.application_id,
                dealDisplay, action: clientEventType, outcome: 'failed',
                reason: `Claim error: ${e.message}`,
              });
              continue;
            }

            if (claimResult.result === 'already_done') {
              results.push({
                cycleId: cycle.id, applicationId: cycle.application_id,
                dealDisplay, action: clientEventType,
                outcome: 'already_done', reason: 'Dedupe: already sent this window',
              });
            } else if (claimResult.result === 'currently_claimed') {
              results.push({
                cycleId: cycle.id, applicationId: cycle.application_id,
                dealDisplay, action: clientEventType,
                outcome: 'currently_claimed', reason: 'Another worker owns this claim (fresh lease)',
              });
            } else if (claimResult.result === 'max_attempts_reached') {
              results.push({
                cycleId: cycle.id, applicationId: cycle.application_id,
                dealDisplay, action: clientEventType,
                outcome: 'max_attempts_reached', reason: 'Max 3 attempts reached — Admin must investigate',
              });
            } else if ((claimResult.result === 'claimed' || claimResult.result === 'retry_claimed') && claimResult.logId) {
              // Worker owns the action — send email
              const emailResult = await sendEmail({
                emailType: clientEventType,
                borrower: { email: clientRecipient.email, firstName: clientRecipient.firstName },
                application: {
                  optionExerciseDeadline: deadline,
                  optionDeadlineDisplay: formatDateDisplay(deadline),
                  daysUntilDeadline: offset,
                  propertyAddress: deal.property_address,
                  dealDisplayName: deal.company_name || deal.property_address,
                },
              });
              if (emailResult.ok) {
                await markLogSent(supabase, claimResult.logId);
                results.push({
                  cycleId: cycle.id, applicationId: cycle.application_id,
                  dealDisplay, action: clientEventType, outcome: 'sent',
                  reason: claimResult.result === 'retry_claimed' ? 'Retry succeeded' : undefined,
                });
              } else {
                await markLogFailed(supabase, claimResult.logId, emailResult.error ?? 'Email send failed');
                results.push({
                  cycleId: cycle.id, applicationId: cycle.application_id,
                  dealDisplay, action: clientEventType, outcome: 'failed',
                  reason: emailResult.error ?? 'Email send failed',
                });
              }
            }
          }
        }

        // ── Admin reminder ────────────────────────────────────────────────
        const adminEventType = `admin_reminder_${offset}d` as string;
        const adminDedupeKey = `option:${cycle.id}:${deadline}:${adminEventType}:${adminEmail.toLowerCase()}`;

        if (dryRun) {
          // DRY-RUN: read-only check, NO writes
          const existing = await dryRunCheckExisting(supabase, adminDedupeKey);
          let dryOutcome: WorkerCycleResult['outcome'] = 'would_send';
          let dryReason = `Would send to ${adminEmail} (${offset}d admin reminder)`;

          if (existing) {
            if (existing.status === 'sent' || existing.status === 'completed') {
              dryOutcome = 'would_skip';
              dryReason = `Would skip: existing ${existing.status} row`;
            } else if (existing.status === 'failed' && existing.attemptCount >= 3) {
              dryOutcome = 'would_skip';
              dryReason = `Would skip: max_attempts_reached (${existing.attemptCount} failures)`;
            } else {
              dryOutcome = 'would_send';
              dryReason = `Would retry: existing ${existing.status} row (attempt ${existing.attemptCount})`;
            }
          }

          results.push({
            cycleId: cycle.id, applicationId: cycle.application_id,
            dealDisplay, action: adminEventType,
            outcome: dryOutcome, reason: dryReason,
          });
        } else {
          // LIVE: atomic claim
          let claimResult: { result: ClaimResult; logId: string | null };
          try {
            claimResult = await atomicClaim(
              supabase, cycle.id, cycle.application_id,
              adminEventType, deadline, adminDedupeKey
            );
          } catch (e: any) {
            errors.push(`Claim failed for ${adminEventType}: ${e.message}`);
            results.push({
              cycleId: cycle.id, applicationId: cycle.application_id,
              dealDisplay, action: adminEventType, outcome: 'failed',
              reason: `Claim error: ${e.message}`,
            });
            continue;
          }

          if (claimResult.result === 'already_done') {
            results.push({
              cycleId: cycle.id, applicationId: cycle.application_id,
              dealDisplay, action: adminEventType,
              outcome: 'already_done', reason: 'Dedupe: already sent this window',
            });
          } else if (claimResult.result === 'currently_claimed') {
            results.push({
              cycleId: cycle.id, applicationId: cycle.application_id,
              dealDisplay, action: adminEventType,
              outcome: 'currently_claimed', reason: 'Another worker owns this claim (fresh lease)',
            });
          } else if (claimResult.result === 'max_attempts_reached') {
            results.push({
              cycleId: cycle.id, applicationId: cycle.application_id,
              dealDisplay, action: adminEventType,
              outcome: 'max_attempts_reached', reason: 'Max 3 attempts reached — Admin must investigate',
            });
          } else if ((claimResult.result === 'claimed' || claimResult.result === 'retry_claimed') && claimResult.logId) {
            const emailResult = await sendEmail({
              emailType: adminEventType,
              borrower: { email: adminEmail, firstName: 'Admin' },
              application: {
                optionExerciseDeadline: deadline,
                optionDeadlineDisplay: formatDateDisplay(deadline),
                depositGoesHardDate: cycle.deposit_goes_hard_date,
                daysUntilDeadline: offset,
                propertyAddress: deal.property_address,
                dealDisplayName: deal.company_name || deal.property_address,
                assignedOwner: deal.eb_assigned_owner,
              },
            });
            if (emailResult.ok) {
              await markLogSent(supabase, claimResult.logId);
              results.push({
                cycleId: cycle.id, applicationId: cycle.application_id,
                dealDisplay, action: adminEventType, outcome: 'sent',
              });
            } else {
              await markLogFailed(supabase, claimResult.logId, emailResult.error ?? 'Email send failed');
              results.push({
                cycleId: cycle.id, applicationId: cycle.application_id,
                dealDisplay, action: adminEventType, outcome: 'failed',
                reason: emailResult.error ?? 'Email send failed',
              });
            }
          }
        }
      }
    }

    // ── Closeout logic ──────────────────────────────────────────────────────
    if (closeoutWindowOpen && todayET >= deadline && !isSatisfied) {
      // Use effectiveAt for the "now" comparison in dry-run; real Date() in live
      const nowForCutoff = effectiveAt ?? new Date();
      if (nowForCutoff.getTime() <= cutoff.getTime()) {
        results.push({
          cycleId: cycle.id, applicationId: cycle.application_id,
          dealDisplay, action: 'auto_close',
          outcome: 'skipped', reason: 'At or before 5:00 PM ET cutoff — not yet eligible',
        });
        continue;
      }

      const closeDedupeKey = `option:${cycle.id}:${deadline}:auto_close`;

      if (dryRun) {
        // DRY-RUN: read-only check, NO writes
        const existing = await dryRunCheckExisting(supabase, closeDedupeKey);
        let dryOutcome: WorkerCycleResult['outcome'] = 'would_close';
        let dryReason = `Would close: no timely exercise or amendment. Deadline: ${deadline}`;

        if (existing) {
          if (existing.status === 'completed') {
            dryOutcome = 'would_skip';
            dryReason = 'Would skip: auto_close already completed';
          } else if (existing.status === 'failed' && existing.attemptCount >= 3) {
            dryOutcome = 'would_skip';
            dryReason = `Would skip: max_attempts_reached (${existing.attemptCount} failures)`;
          }
        }

        results.push({
          cycleId: cycle.id, applicationId: cycle.application_id,
          dealDisplay, action: 'auto_close',
          outcome: dryOutcome, reason: dryReason,
        });
        continue;
      }

      // LIVE: atomic claim
      let claimResult: { result: ClaimResult; logId: string | null };
      try {
        claimResult = await atomicClaim(
          supabase, cycle.id, cycle.application_id,
          'auto_close', deadline, closeDedupeKey
        );
      } catch (e: any) {
        errors.push(`Auto-close claim failed for cycle ${cycle.id}: ${e.message}`);
        results.push({
          cycleId: cycle.id, applicationId: cycle.application_id,
          dealDisplay, action: 'auto_close', outcome: 'failed',
          reason: `Claim error: ${e.message}`,
        });
        continue;
      }

      if (claimResult.result === 'already_done') {
        results.push({
          cycleId: cycle.id, applicationId: cycle.application_id,
          dealDisplay, action: 'auto_close',
          outcome: 'already_done', reason: 'Dedupe: auto-close already processed',
        });
        continue;
      }

      if (claimResult.result === 'currently_claimed') {
        results.push({
          cycleId: cycle.id, applicationId: cycle.application_id,
          dealDisplay, action: 'auto_close',
          outcome: 'currently_claimed', reason: 'Another worker owns this close claim',
        });
        continue;
      }

      if (claimResult.result === 'max_attempts_reached') {
        results.push({
          cycleId: cycle.id, applicationId: cycle.application_id,
          dealDisplay, action: 'auto_close',
          outcome: 'max_attempts_reached', reason: 'Max 3 attempts reached — Admin must investigate',
        });
        continue;
      }

      if ((claimResult.result === 'claimed' || claimResult.result === 'retry_claimed') && claimResult.logId) {
        // ── Live auto-close ─────────────────────────────────────────────────
        // Atomic re-fetch + re-evaluate before closing (never close on stale data)
        const { data: freshCycle } = await supabase
          .from('crm_deal_option_cycles')
          .select('*')
          .eq('id', cycle.id)
          .single();

        if (!freshCycle || freshCycle.status !== 'active') {
          await markLogFailed(supabase, claimResult.logId, 'Cycle no longer active on re-fetch');
          results.push({
            cycleId: cycle.id, applicationId: cycle.application_id,
            dealDisplay, action: 'auto_close',
            outcome: 'skipped', reason: 'Cycle no longer active',
          });
          continue;
        }

        // Re-evaluate timeliness with fresh data (never close on stale candidate data)
        const freshExerciseTs = freshCycle.actual_option_exercised_at ?? freshCycle.option_exercised_at;
        const freshAmendmentTs = freshCycle.actual_amendment_received_at ?? freshCycle.extension_psa_amendment_received_at;
        const freshTimelyExercise = freshExerciseTs ? isTimely(freshExerciseTs, deadline) : false;
        const freshTimelyAmendment = freshAmendmentTs ? isTimely(freshAmendmentTs, deadline) : false;

        if (freshTimelyExercise || freshTimelyAmendment) {
          await markLogFailed(supabase, claimResult.logId, 'Cycle satisfied on re-evaluation — not closing');
          results.push({
            cycleId: cycle.id, applicationId: cycle.application_id,
            dealDisplay, action: 'auto_close',
            outcome: 'skipped', reason: 'Cycle satisfied on re-evaluation',
          });
          continue;
        }

        // ── ATOMIC STATE TRANSITION via RPC (5D-2.13b hardened) ───────────────
        // execute_option_cycle_auto_close() performs ALL of the following
        // inside ONE PostgreSQL transaction:
        //   a. cycle → missed
        //   b. auto_close log → completed
        //   c. activity: option_cycle_missed inserted
        //   (the current RPC may also apply legacy Deal-status side effects;
        //    the worker no longer depends on them)
        //
        // Either ALL RPC writes commit or NONE do.
        // The canonical cutoff timestamp is passed from the worker so that
        // no timezone logic is reproduced in SQL.
        // p_automation_log_id is verified inside the RPC before any write.
        let closeSuccess = false;
        let closeError = '';

        try {
          const { data: rpcData, error: rpcError } = await supabase.rpc(
            'execute_option_cycle_auto_close',
            {
              p_cycle_id:           cycle.id,
              p_application_id:     cycle.application_id,
              p_cutoff_at:          cutoff.toISOString(),
              p_automation_log_id:  claimResult.logId,
              p_deadline_snapshot:  deadline,
            }
          );

          if (rpcError) {
            throw new Error(`Auto-close RPC error: ${rpcError.message}`);
          }

          // RPC returns TABLE(result text) — data is an array of rows
          const rpcResult: string = Array.isArray(rpcData)
            ? (rpcData[0]?.result ?? 'unknown')
            : ((rpcData as any)?.result ?? 'unknown');

          if (rpcResult === 'success') {
            closeSuccess = true;
          } else {
            // Guard fired — transition was not performed (no partial state)
            closeError = `Auto-close guard: ${rpcResult}`;
          }
        } catch (e: any) {
          closeError = e.message ?? 'Auto-close RPC threw unexpectedly';
        }

        if (!closeSuccess) {
          // RPC did not commit — mark the claim as failed so it is retryable.
          // auto_close log was NOT marked completed (guard fired before writes).
          await markLogFailed(supabase, claimResult.logId, closeError);
          errors.push(`Auto-close failed for cycle ${cycle.id}: ${closeError}`);
          results.push({
            cycleId: cycle.id, applicationId: cycle.application_id,
            dealDisplay, action: 'auto_close', outcome: 'failed', reason: closeError,
          });
          continue;
        }

        // ── RPC returned 'success' ─────────────────────────────────────────
        // The following are now committed atomically inside the RPC:
        //   - cycle.status = 'missed'
        //   - auto_close log.status = 'completed'
        //   - activity: option_cycle_missed
        //
        // Closeout emails are processed by reconcileCompletedAutoCloseNotifications()
        // which runs at the end of this worker execution and on every future run.
        // This guarantees recovery even if the process crashes here.

        results.push({
          cycleId: cycle.id, applicationId: cycle.application_id,
          dealDisplay, action: 'auto_close', outcome: 'closed',
          reason: `Option Cycle marked missed (atomic). Deadline: ${deadline}`,
        });
      }
    }
  }

  // ── Step 5D-2.13b: Reconcile completed auto-close notifications ──────────────
  // Runs on every LIVE (non-dry-run) worker execution, independently of the
  // candidate query above. Recovers client and admin closeout emails for any
  // completed auto_close event whose notices have not yet been processed.
  // This guarantees recovery after a crash at any point after the atomic
  // state transition, including crashes between client and admin email sends.
  if (!dryRun) {
    try {
      const reconcileResults = await reconcileCompletedAutoCloseNotifications(supabase);
      results.push(...reconcileResults);
    } catch (e: any) {
      errors.push(`Reconciliation phase error: ${e.message ?? 'unknown'}`);
    }
  }

  return {
    dryRun,
    automationEnabled,
    etHour,
    todayET,
    reminderWindowOpen,
    closeoutWindowOpen,
    candidatesEvaluated,
    results,
    errors,
    ...(effectiveAt ? { evaluationTimeUsed: effectiveAt.toISOString() } : {}),
  };
}
