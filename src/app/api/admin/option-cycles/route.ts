import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

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
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

/**
 * requireAdmin — SECURITY CRITICAL
 * Authorization relies ONLY on app_metadata.role === 'admin'.
 * app_metadata is server-controlled. user_metadata is user-controlled
 * and MUST NOT be used for privilege decisions.
 */
async function requireAdmin() {
  const supabase = await getAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// ── CANONICAL DEADLINE CUTOFF ─────────────────────────────────────────────────
//
// The Option Exercise Deadline expires at 5:00:00 PM America/New_York
// on the option_exercise_deadline DATE.
//
// IANA timezone: America/New_York (automatically respects DST).
// Do NOT use hardcoded UTC offsets (EST/EDT/UTC-5/UTC-4).
//
// This is the SINGLE canonical server-side utility for deriving the cutoff.
// Step 5D-2 reminder and closeout automation MUST reuse this function.
// Do NOT duplicate timezone/cutoff logic in React components.
//
// Returns a Date object representing 5:00:00 PM America/New_York on the given date.
//
// TIMELINESS RULE:
//   event_timestamp <= cutoff → TIMELY (exactly 5:00:00 PM ET is TIMELY)
//   event_timestamp > cutoff  → LATE   (5:00:01 PM ET is LATE)

export function getOptionDeadlineCutoff(deadlineDateStr: string): Date {
  const [year, month, day] = deadlineDateStr.split('-').map(Number);

  // Create a reference point at noon UTC on the deadline date to determine DST
  const noonUTC = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  // Get the UTC offset for America/New_York at this date using Intl
  const nyFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = nyFormatter.formatToParts(noonUTC);
  const nyHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '12', 10);
  // noonUTC is 12:00 UTC. nyHour is what New York shows for that UTC time.
  // offset = 12 - nyHour (in hours). e.g. EST: nyHour=7, offset=5; EDT: nyHour=8, offset=4
  const offsetHours = 12 - nyHour;

  // 5:00 PM New York = 17:00 local = 17:00 + offsetHours UTC
  const cutoffUTCHours = 17 + offsetHours;
  return new Date(Date.UTC(year, month - 1, day, cutoffUTCHours, 0, 0));
}

/**
 * Derive whether a given timestamp is timely (at or before the 5 PM ET cutoff).
 *
 * CANONICAL TIMELINESS RULE:
 *   actual_amendment_received_at  → canonical field for amendment timeliness
 *   actual_option_exercised_at    → canonical field for exercise timeliness
 *   extension_psa_amendment_received_at / option_exercised_at are CRM/system
 *   timestamps retained for backward compatibility only.
 *
 * TIMELY: timestamp <= cutoff (exactly 5:00:00 PM ET is timely)
 * LATE:   timestamp > cutoff
 *
 * Server ALWAYS derives timeliness. Never trust browser-supplied is_timely.
 */
export function isTimely(eventTimestamp: Date | string, deadlineDateStr: string): boolean {
  const event = typeof eventTimestamp === 'string' ? new Date(eventTimestamp) : eventTimestamp;
  const cutoff = getOptionDeadlineCutoff(deadlineDateStr);
  return event.getTime() <= cutoff.getTime();
}

// ── Activity logger ───────────────────────────────────────────────────────────

async function logActivity(
  applicationId: string,
  userId: string | null,
  eventType: string,
  title: string,
  detail: string,
  actor: string
) {
  const supabase = getServiceClient();
  try {
    await supabase.from('application_activity').insert({
      application_id: applicationId,
      user_id: userId,
      event_type: eventType,
      title,
      detail,
      actor,
    });
  } catch (_) {
    // Activity logging is best-effort; never fail the main operation
  }
}

// ── Date/time formatters ──────────────────────────────────────────────────────

function formatDateForActivity(dateStr: string): string {
  if (!dateStr) return dateStr;
  const [y, m, d] = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

/**
 * Format a timestamptz as "Sep 24 at 3:42 PM ET" for activity log entries.
 * Uses America/New_York for display.
 */
function formatTimestampET(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return formatter.format(d) + ' ET';
}

// ── Parse admin-supplied datetime string as America/New_York ──────────────────
//
// Admin enters date + time in the UI (interpreted as America/New_York).
// We receive them as separate fields: date_str (YYYY-MM-DD) + time_str (HH:MM).
// We construct the correct UTC timestamptz.

function parseAdminTimestampET(dateStr: string, timeStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);

  // Find NY offset at noon on that date
  const noonUTC = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const nyFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  });
  const nyHour = parseInt(nyFormatter.format(noonUTC), 10);
  const offsetHours = 12 - nyHour;

  return new Date(Date.UTC(year, month - 1, day, hours + offsetHours, minutes, 0));
}

// ── GET /api/admin/option-cycles?application_id=xxx ──────────────────────────

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const applicationId = searchParams.get('application_id');
  if (!applicationId) return NextResponse.json({ error: 'application_id required' }, { status: 400 });

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('crm_deal_option_cycles')
    .select('*')
    .eq('application_id', applicationId)
    .order('cycle_number', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Enrich each cycle with derived timeliness fields (server-derived, never stored)
  const enriched = (data ?? []).map((cycle: any) => enrichCycle(cycle));

  return NextResponse.json({ cycles: enriched });
}

// ── Enrich cycle with derived timeliness fields ───────────────────────────────
//
// These fields are DERIVED server-side and never stored in the DB.
// They are safe to send to Admin UI.
//
// CANONICAL TIMELINESS FIELDS:
//   actual_amendment_received_at  → canonical amendment timeliness
//   actual_option_exercised_at    → canonical exercise timeliness
//   extension_psa_amendment_received_at / option_exercised_at → CRM timestamps only

function enrichCycle(cycle: any) {
  const deadline = cycle.option_exercise_deadline;
  const cutoff = getOptionDeadlineCutoff(deadline);

  // Amendment timeliness — use actual_amendment_received_at as canonical field
  const amendmentTs = cycle.actual_amendment_received_at ?? cycle.extension_psa_amendment_received_at;
  let amendmentTimely: boolean | null = null;
  if (amendmentTs) {
    amendmentTimely = isTimely(amendmentTs, deadline);
  }

  // Exercise timeliness — use actual_option_exercised_at as canonical field
  const exerciseTs = cycle.actual_option_exercised_at ?? cycle.option_exercised_at;
  let exerciseTimely: boolean | null = null;
  if (exerciseTs) {
    exerciseTimely = isTimely(exerciseTs, deadline);
  }

  return {
    ...cycle,
    // Canonical cutoff as ISO string for display
    option_deadline_cutoff_iso: cutoff.toISOString(),
    // Derived timeliness (server-calculated, never trust browser)
    amendment_is_timely: amendmentTimely,
    exercise_is_timely: exerciseTimely,
    // Canonical timestamps (prefer actual_* if set)
    effective_amendment_received_at: amendmentTs ?? null,
    effective_option_exercised_at: exerciseTs ?? null,
  };
}

// ── POST /api/admin/option-cycles — create initial cycle ─────────────────────

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { application_id, deposit_goes_hard_date } = body;

  if (!application_id || !deposit_goes_hard_date) {
    return NextResponse.json({ error: 'application_id and deposit_goes_hard_date are required' }, { status: 400 });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(deposit_goes_hard_date)) {
    return NextResponse.json({ error: 'deposit_goes_hard_date must be in YYYY-MM-DD format' }, { status: 422 });
  }

  const supabase = getServiceClient();

  const { data: app, error: appError } = await supabase
    .from('borrower_applications')
    .select('id, user_id, app_status, property_address')
    .eq('id', application_id)
    .is('purged_at', null)
    .single();

  if (appError || !app) {
    return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
  }

  // STATUS GATE (restored Step 6A-4.3):
  // The general option-cycle creation workflow requires the Deal to be funded.
  // Pre-funding hard-date entry uses the narrow POST /api/admin/option-cycles/hard-date
  // route instead, which handles both create-if-missing and update-if-exists safely
  // without requiring app_status = 'funded'.
  if (app.app_status !== 'funded') {
    return NextResponse.json(
      { error: 'Option cycles can only be created for funded Deals. To set the Original Deposit Goes Hard Date before funding, use the hard-date endpoint.' },
      { status: 409 }
    );
  }

  const { data: existingActive } = await supabase
    .from('crm_deal_option_cycles')
    .select('id, cycle_number')
    .eq('application_id', application_id)
    .eq('status', 'active')
    .maybeSingle();

  if (existingActive) {
    return NextResponse.json(
      { error: 'An active option cycle already exists for this Deal. Use the extension workflow to create a new cycle.' },
      { status: 409 }
    );
  }

  const { data: maxCycleRow } = await supabase
    .from('crm_deal_option_cycles')
    .select('cycle_number')
    .eq('application_id', application_id)
    .order('cycle_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextCycleNumber = maxCycleRow ? maxCycleRow.cycle_number + 1 : 1;

  const { data: deadlineResult, error: calcError } = await supabase
    .rpc('fn_subtract_business_days', {
      p_start_date: deposit_goes_hard_date,
      p_n: 2,
    });

  if (calcError) {
    if (calcError.message?.includes('Business holiday calendar unavailable')) {
      return NextResponse.json({ error: calcError.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'Failed to calculate Option Exercise Deadline: ' + calcError.message }, { status: 500 });
  }

  const option_exercise_deadline = deadlineResult as string;

  const { data: cycle, error: insertError } = await supabase
    .from('crm_deal_option_cycles')
    .insert({
      application_id,
      cycle_number: nextCycleNumber,
      deposit_goes_hard_date,
      option_exercise_deadline,
      status: 'active',
      created_by: admin.id,
      updated_by: admin.id,
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await logActivity(
    application_id,
    app.user_id ?? null,
    'option_cycle_created',
    `Deposit Goes Hard Date set: ${formatDateForActivity(deposit_goes_hard_date)}`,
    `Option Exercise Deadline calculated: ${formatDateForActivity(option_exercise_deadline)}`,
    admin.email || 'EarnestBridge Admin'
  );

  return NextResponse.json({ cycle: enrichCycle(cycle) });
}

// ── PATCH /api/admin/option-cycles?id=xxx — lifecycle actions ────────────────
//
// Actions:
//   exercise          — mark option exercised (with optional actual timestamp)
//   amendment_received — record signed PSA amendment (with actual timestamp)
//   fee_paid          — record extension fee paid
//   new_extension     — create new extension cycle (requires TIMELY amendment)
//
// BLOCKED ACTIONS:
//   new_extension on status = 'missed' — BLOCKED with explicit error.
//   Missed cycles may only be extended via the explicit Admin override action
//   (to be built in Step 5D-2). This separation ensures:
//     - Normal extension (timely amendment on active cycle) uses 'new_extension'
//     - Exception override (missed cycle) uses a distinct override action
//     - History is never silently rewritten
//
// For exercise and amendment_received, Admin may supply:
//   actual_date: "YYYY-MM-DD"
//   actual_time: "HH:MM"  (interpreted as America/New_York)
// If not supplied, defaults to now().
//
// Server derives timeliness. Never trust browser-supplied is_timely.
//
// CANONICAL TIMELINESS FIELDS:
//   actual_amendment_received_at  → canonical amendment timeliness
//   actual_option_exercised_at    → canonical exercise timeliness

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const body = await request.json();
  const {
    action,
    deposit_goes_hard_date: newHardDate,
    actual_date,
    actual_time,
  } = body;

  const VALID_ACTIONS = ['exercise', 'amendment_received', 'fee_paid', 'new_extension', 'extension_override'] as const;
  type ValidAction = typeof VALID_ACTIONS[number];

  if (!action || !VALID_ACTIONS.includes(action as ValidAction)) {
    return NextResponse.json(
      { error: `Invalid action. Allowed: ${VALID_ACTIONS.join(', ')}` },
      { status: 422 }
    );
  }

  const supabase = getServiceClient();

  const { data: current, error: fetchError } = await supabase
    .from('crm_deal_option_cycles')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !current) {
    return NextResponse.json({ error: 'Option cycle not found' }, { status: 404 });
  }

  // Derive application_id from the row — never trust browser-supplied value
  const applicationId: string = current.application_id;

  const { data: app } = await supabase
    .from('borrower_applications')
    .select('user_id')
    .eq('id', applicationId)
    .single();

  const userId = app?.user_id ?? null;

  // ── Resolve actual timestamp ──────────────────────────────────────────────
  // If Admin supplied actual_date + actual_time, parse as America/New_York.
  // Otherwise default to now().

  function resolveActualTimestamp(): Date {
    if (actual_date && actual_time) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(actual_date)) {
        throw new Error('actual_date must be in YYYY-MM-DD format');
      }
      if (!/^\d{2}:\d{2}$/.test(actual_time)) {
        throw new Error('actual_time must be in HH:MM format');
      }
      return parseAdminTimestampET(actual_date, actual_time);
    }
    return new Date();
  }

  // ── Action: exercise ────────────────────────────────────────────────────────
  if (action === 'exercise') {
    if (current.status !== 'active') {
      return NextResponse.json(
        { error: `Cannot exercise an option cycle with status '${current.status}'. Only active cycles can be exercised.` },
        { status: 409 }
      );
    }
    if (current.option_exercised_at || current.actual_option_exercised_at) {
      return NextResponse.json({ error: 'Option has already been exercised.' }, { status: 409 });
    }

    let actualTs: Date;
    try {
      actualTs = resolveActualTimestamp();
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }

    const actualTsISO = actualTs.toISOString();
    // Server derives timeliness using actual_option_exercised_at (canonical field)
    const timely = isTimely(actualTs, current.option_exercise_deadline);

    const { data: updated, error: updateError } = await supabase
      .from('crm_deal_option_cycles')
      .update({
        status: 'exercised',
        // actual_option_exercised_at is the CANONICAL timeliness field
        actual_option_exercised_at: actualTsISO,
        // option_exercised_at retained for backward compatibility (CRM timestamp)
        option_exercised_at: actualTsISO,
        updated_by: admin.id,
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    const tsDisplay = formatTimestampET(actualTs);
    const lateNote = timely ? '' : ' — Recorded after Option Exercise Deadline';

    await logActivity(
      applicationId, userId,
      'option_exercised',
      `Option exercised ${tsDisplay}${lateNote}`,
      `Option exercised on cycle ${current.cycle_number}. ${timely ? 'Timely.' : 'Recorded after Option Exercise Deadline.'}`,
      admin.email || 'EarnestBridge Admin'
    );

    return NextResponse.json({ cycle: enrichCycle(updated), timely });
  }

  // ── Action: amendment_received ──────────────────────────────────────────────
  if (action === 'amendment_received') {
    // Allow on active OR missed cycles (Step 5D-2: late amendment on missed cycle)
    if (!['active', 'missed'].includes(current.status)) {
      return NextResponse.json(
        { error: `Cannot record amendment on a cycle with status '${current.status}'.` },
        { status: 409 }
      );
    }
    if (current.extension_psa_amendment_received_at || current.actual_amendment_received_at) {
      return NextResponse.json({ error: 'Signed PSA amendment has already been recorded.' }, { status: 409 });
    }

    let actualTs: Date;
    try {
      actualTs = resolveActualTimestamp();
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }

    const actualTsISO = actualTs.toISOString();
    // Server derives timeliness using actual_amendment_received_at (canonical field)
    const timely = isTimely(actualTs, current.option_exercise_deadline);

    const { data: updated, error: updateError } = await supabase
      .from('crm_deal_option_cycles')
      .update({
        // actual_amendment_received_at is the CANONICAL timeliness field
        actual_amendment_received_at: actualTsISO,
        // extension_psa_amendment_received_at retained for backward compatibility (CRM timestamp)
        extension_psa_amendment_received_at: actualTsISO,
        updated_by: admin.id,
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    const tsDisplay = formatTimestampET(actualTs);
    const lateNote = timely ? '' : ' — Recorded after Option Exercise Deadline';
    const missedNote = current.status === 'missed' ? ' (cycle status: missed — manual review required)' : '';

    await logActivity(
      applicationId, userId,
      'extension_amendment_received',
      `Signed extension amendment received ${tsDisplay}${lateNote}`,
      timely
        ? 'Signed PSA amendment received before Option Exercise Deadline. Deal is protected.'
        : `Signed PSA amendment received AFTER Option Exercise Deadline. Deal is NOT protected from future closeout. Manual review may be required.${missedNote}`,
      admin.email || 'EarnestBridge Admin'
    );

    return NextResponse.json({ cycle: enrichCycle(updated), timely });
  }

  // ── Action: fee_paid ────────────────────────────────────────────────────────
  if (action === 'fee_paid') {
    // Allow on active, extended, OR missed cycles (Step 5D-2 requirement)
    if (!['active', 'extended', 'missed'].includes(current.status)) {
      return NextResponse.json(
        { error: `Cannot record extension fee on a cycle with status '${current.status}'.` },
        { status: 409 }
      );
    }
    if (current.extension_fee_paid_at) {
      return NextResponse.json({ error: 'Extension fee has already been recorded as paid.' }, { status: 409 });
    }

    const { data: updated, error: updateError } = await supabase
      .from('crm_deal_option_cycles')
      .update({
        extension_fee_paid_at: new Date().toISOString(),
        updated_by: admin.id,
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    await logActivity(
      applicationId, userId,
      'extension_fee_paid',
      'Extension fee paid',
      `Extension deal fee recorded as paid on cycle ${current.cycle_number}`,
      admin.email || 'EarnestBridge Admin'
    );

    return NextResponse.json({ cycle: enrichCycle(updated) });
  }

  // ── Action: new_extension ───────────────────────────────────────────────────
  //
  // NORMAL EXTENSION FLOW — for active cycles with a TIMELY signed PSA amendment.
  //
  // BLOCKED on missed cycles:
  //   status = 'missed' → returns 422 with explicit message directing Admin to
  //   the manual override workflow (Step 5D-2). This separation ensures:
  //     - Normal extension uses 'new_extension' (active cycle + timely amendment)
  //     - Exception override uses a distinct override action (Step 5D-2)
  //     - Prior missed cycle is preserved as 'missed' — never rewritten
  //     - History is never silently altered
  //
  // REQUIREMENT: current cycle must have a TIMELY signed PSA amendment:
  //   actual_amendment_received_at <= option_deadline_cutoff
  //
  // A late amendment does NOT qualify the previous cycle for extension protection.
  // Fee may still be pending — this does NOT block the new cycle.

  if (action === 'new_extension') {
    // EXPLICIT BLOCK: missed cycles cannot use the generic new_extension action.
    // They require the Admin override workflow (Step 5D-2).
    if (current.status === 'missed') {
      return NextResponse.json(
        {
          error: 'This option cycle has status "missed" and cannot be extended using the normal extension workflow. A missed cycle requires an explicit Admin override action (available in Step 5D-2). The prior missed cycle will be preserved as-is — it will not be rewritten.',
        },
        { status: 422 }
      );
    }

    if (current.status !== 'active') {
      return NextResponse.json(
        { error: `Cannot create extension cycle from a cycle with status '${current.status}'. Only active cycles can be extended using this action.` },
        { status: 409 }
      );
    }

    // Check amendment exists — use actual_amendment_received_at as canonical field
    const amendmentTs = current.actual_amendment_received_at ?? current.extension_psa_amendment_received_at;
    if (!amendmentTs) {
      return NextResponse.json(
        { error: 'A signed PSA amendment must be received before creating a new extension cycle.' },
        { status: 422 }
      );
    }

    // CRITICAL: Check amendment was TIMELY (server-derived using canonical field)
    let amendmentTimely = isTimely(amendmentTs, current.option_exercise_deadline);
    if (!amendmentTimely) {
      return NextResponse.json(
        {
          error: 'The signed PSA amendment was received after the Option Exercise Deadline and does not qualify this cycle for extension. A late amendment cannot be used to create a new extension cycle via the normal workflow.',
        },
        { status: 422 }
      );
    }

    if (!newHardDate) {
      return NextResponse.json({ error: 'deposit_goes_hard_date is required for new_extension action' }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newHardDate)) {
      return NextResponse.json({ error: 'deposit_goes_hard_date must be in YYYY-MM-DD format' }, { status: 422 });
    }

    const { data: deadlineResult, error: calcError } = await supabase
      .rpc('fn_subtract_business_days', {
        p_start_date: newHardDate,
        p_n: 2,
      });

    if (calcError) {
      if (calcError.message?.includes('Business holiday calendar unavailable')) {
        return NextResponse.json({ error: calcError.message }, { status: 422 });
      }
      return NextResponse.json({ error: 'Failed to calculate Option Exercise Deadline: ' + calcError.message }, { status: 500 });
    }

    const newOptionDeadline = deadlineResult as string;

    const { error: extendError } = await supabase
      .from('crm_deal_option_cycles')
      .update({
        status: 'extended',
        extended_at: new Date().toISOString(),
        updated_by: admin.id,
      })
      .eq('id', id);

    if (extendError) return NextResponse.json({ error: extendError.message }, { status: 500 });

    const { data: newCycle, error: insertError } = await supabase
      .from('crm_deal_option_cycles')
      .insert({
        application_id: applicationId,
        cycle_number: current.cycle_number + 1,
        deposit_goes_hard_date: newHardDate,
        option_exercise_deadline: newOptionDeadline,
        status: 'active',
        created_by: admin.id,
        updated_by: admin.id,
      })
      .select()
      .single();

    if (insertError) {
      // Attempt rollback
      await supabase
        .from('crm_deal_option_cycles')
        .update({ status: 'active', extended_at: null, updated_by: admin.id })
        .eq('id', id);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    await logActivity(
      applicationId, userId,
      'option_cycle_extended',
      `New extension hard date set: ${formatDateForActivity(newHardDate)}`,
      `Option cycle ${current.cycle_number} extended. New cycle ${newCycle.cycle_number} created. New Option Exercise Deadline: ${formatDateForActivity(newOptionDeadline)}`,
      admin.email || 'EarnestBridge Admin'
    );

    return NextResponse.json({ cycle: enrichCycle(newCycle), previousCycleId: id });
  }

  // ── Action: extension_override ──────────────────────────────────────────────
  //
  // MANUAL EXTENSION OVERRIDE — for missed cycles.
  //
  // This is SEPARATE from the normal 'new_extension' workflow.
  // Only available when:
  //   - current/prior cycle status = 'missed'
  //   - Deal is not purged and currently 'funded'
  //   - actual_amendment_received_at IS NOT NULL
  //   - Admin provides explicit attestation
  //   - Admin provides new Deposit Goes Hard Date
  //
  // Server behavior:
  //   1. Validates Admin
  //   2. Verifies missed cycle
  //   3. Verifies actual amendment timestamp exists
  //   4. Requires Admin attestation
  //   5. Requires Deal to already be 'funded' (never changes Deal status)
  //   6. Calculates NEW Option Exercise Deadline
  //   7. Leaves prior cycle: status = missed (NEVER rewritten)
  //   8. Creates new cycle: cycle_number = previous + 1, status = active
  //   9. Logs extension_override_accepted (Option Cycle only)
  //
  // Deal status is NOT changed by this action. Deal status changes are manual
  // Admin decisions through the canonical Deal Status API.
  //
  // Extension fee may still be pending — does NOT block override.
  // Admin UI shows "Extension Fee Outstanding" until recorded paid.
  //
  // Do NOT expose this internal override policy to clients.

  if (action === 'extension_override') {
    // Must be a missed cycle
    if (current.status !== 'missed') {
      return NextResponse.json(
        { error: `Extension override is only available for cycles with status 'missed'. Current status: '${current.status}'.` },
        { status: 422 }
      );
    }

    // Must have actual amendment timestamp
    const amendmentTs = current.actual_amendment_received_at ?? current.extension_psa_amendment_received_at;
    if (!amendmentTs) {
      return NextResponse.json(
        { error: 'A signed PSA amendment must be recorded on the missed cycle before accepting an extension override.' },
        { status: 422 }
      );
    }

    // Require Admin attestation
    const { admin_attestation, deposit_goes_hard_date: overrideHardDate } = body;
    if (!admin_attestation) {
      return NextResponse.json(
        { error: 'Admin attestation is required: "I have verified that the signed PSA amendment was received before the applicable due-diligence period expired."' },
        { status: 422 }
      );
    }

    if (!overrideHardDate) {
      return NextResponse.json({ error: 'deposit_goes_hard_date is required for extension_override action' }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(overrideHardDate)) {
      return NextResponse.json({ error: 'deposit_goes_hard_date must be in YYYY-MM-DD format' }, { status: 422 });
    }

    // Verify Deal exists, is not purged, and is currently funded
    const { data: dealForOverride } = await supabase
      .from('borrower_applications')
      .select('app_status, user_id')
      .eq('id', applicationId)
      .is('purged_at', null)
      .single();

    if (!dealForOverride) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
    }

    if (dealForOverride.app_status !== 'funded') {
      return NextResponse.json(
        {
          error: 'deal_not_funded',
          message: 'Set the Deal status to Funded before creating an extension.',
        },
        { status: 422 }
      );
    }

    // Calculate new Option Exercise Deadline
    const { data: deadlineResult, error: calcError } = await supabase
      .rpc('fn_subtract_business_days', {
        p_start_date: overrideHardDate,
        p_n: 2,
      });

    if (calcError) {
      if (calcError.message?.includes('Business holiday calendar unavailable')) {
        return NextResponse.json({ error: calcError.message }, { status: 422 });
      }
      return NextResponse.json({ error: 'Failed to calculate Option Exercise Deadline: ' + calcError.message }, { status: 500 });
    }

    const newOptionDeadline = deadlineResult as string;

    // Create new active cycle (prior missed cycle is PRESERVED as-is)
    const { data: newCycle, error: insertError } = await supabase
      .from('crm_deal_option_cycles')
      .insert({
        application_id: applicationId,
        cycle_number: current.cycle_number + 1,
        deposit_goes_hard_date: overrideHardDate,
        option_exercise_deadline: newOptionDeadline,
        status: 'active',
        created_by: admin.id,
        updated_by: admin.id,
      })
      .select()
      .single();

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // Log extension_override_accepted (Option Cycle action only — Deal status untouched)
    await logActivity(
      applicationId, dealForOverride.user_id ?? null,
      'extension_override_accepted',
      `Extension override accepted — new Option Cycle created (hard date: ${formatDateForActivity(overrideHardDate)})`,
      `Admin verified signed PSA amendment was received before DD period expired. Prior cycle ${current.cycle_number} remains 'missed'. New cycle ${newCycle.cycle_number} created. New Option Exercise Deadline: ${formatDateForActivity(newOptionDeadline)}.`,
      admin.email || 'EarnestBridge Admin'
    );

    return NextResponse.json({
      cycle: enrichCycle(newCycle),
      previousCycleId: id,
      overrideAccepted: true,
      feeOutstanding: !current.extension_fee_paid_at,
    });
  }

  return NextResponse.json({ error: 'Unhandled action' }, { status: 500 });
}
