import { NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { getOptionDeadlineCutoff } from '@/app/api/admin/option-cycles/route';

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
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── Safe response fields ──────────────────────────────────────────────────────
// These are the ONLY fields returned to the client.
// 'notes', 'created_by', 'completed_by', and all internal fields are excluded.

export interface ClientDeadlineItem {
  id: string;
  application_id: string;
  title: string;
  deadline_type: string;
  due_date: string;
  responsible_party: 'client' | 'earnestbridge' | 'third_party';
  status: 'open' | 'completed' | 'cancelled';
  property_address: string | null;
  deal_display_name: string | null;
}

export interface ClosingDateItem {
  type: 'closing';
  application_id: string;
  title: string;
  due_date: string;
  responsible_party: 'system';
  status: 'open' | 'completed';
  property_address: string | null;
  deal_display_name: string | null;
}

// ── Safe Option Cycle fields for client ──────────────────────────────────────
// SECURITY: Borrower has NO direct SELECT on crm_deal_option_cycles.
// These fields are safe to expose. Internal fields are excluded.
//
// CRITICAL OMISSIONS (must never be returned to client):
//   - created_by, updated_by: Admin identity metadata
//   - internal notes, admin metadata
//   - internal fee-leniency language
//   - manual override policy details
//   - actual_amendment_received_at / actual_option_exercised_at: raw timestamps
//     that could reveal internal buffer or late-amendment review policy

export interface ClientOptionCycleItem {
  type: 'option_cycle';
  id: string;
  application_id: string;
  cycle_number: number;
  // Client-facing deal date (DATE, YYYY-MM-DD). Secondary/informational only.
  deposit_goes_hard_date: string | null;
  option_exercise_deadline: string;
  // Canonical cutoff display string: "Sep 24, 2026 at 5:00 PM ET"
  option_deadline_cutoff_display: string;
  // Option status for client display (never expose 'missed' yet — Step 5D-2)
  option_status: 'active' | 'exercised' | 'extended';
  // Whether a timely amendment has been received (affects client status display)
  // Do NOT expose whether amendment was late or internal leniency details
  has_timely_amendment: boolean;
  // Whether extension fee has been recorded paid (for client status only)
  extension_fee_paid: boolean;
  // option_exercised_at only if exercised (confirms completed action)
  option_exercised_at: string | null;
  // Safe deal context
  property_address: string | null;
  deal_display_name: string | null;
}

export type NormalizedDeadline = ClientDeadlineItem | ClosingDateItem;

// ── Format option deadline cutoff for client display ─────────────────────────

function formatOptionCutoffDisplay(deadlineDateStr: string): string {
  const [y, m, d] = deadlineDateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y} at 5:00 PM ET`;
}

// ── GET /api/client/deadlines ─────────────────────────────────────────────────
//
// SECURITY MODEL (aligned with /api/portal/deals/[dealId]):
// 1. Authenticate session — derive authenticatedUser.id server-side
// 2. Build the authorized application ID set server-side:
//      A. borrower_applications.user_id = authenticated user.id (owner), OR
//      B. approved crm_contacts (portal_user_id = user.id,
//         portal_link_status = 'approved') linked via
//         crm_deal_contacts (contact_id -> deal_id = application id)
//    IDs are deduplicated. Client-supplied IDs are never used.
// 3. Query borrower_applications, crm_deal_deadlines and crm_deal_option_cycles
//    strictly within that authorized ID set.
// 4. Return ONLY safe projection — never notes, created_by, completed_by,
//    internal admin metadata, or internal leniency language
//
// Never accepts user_id, borrower email, or contact id from the browser.
// Service role is used AFTER authentication is verified.
// Borrower has NO direct SELECT on crm_deal_option_cycles.

export async function GET() {
  // Step 1: Authenticate — derive user server-side
  const authClient = await getAuthClient();
  const { data: { user }, error: authError } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authenticatedUserId = user.id; // server-derived, never from browser

  // Step 2: Use service role AFTER authentication is confirmed
  const supabase = getServiceClient();

  // Step 3a: Owned deal IDs (PATH A)
  const { data: ownedRows, error: ownedError } = await supabase
    .from('borrower_applications')
    .select('id')
    .eq('user_id', authenticatedUserId);

  if (ownedError) {
    return NextResponse.json({ error: 'Failed to fetch deals' }, { status: 500 });
  }

  // Step 3b: Approved-contact linked deal IDs (PATH B)
  const { data: approvedContacts, error: contactError } = await supabase
    .from('crm_contacts')
    .select('id')
    .eq('portal_user_id', authenticatedUserId)
    .eq('portal_link_status', 'approved');

  if (contactError) {
    return NextResponse.json({ error: 'Failed to fetch deals' }, { status: 500 });
  }

  let linkedDealIds: string[] = [];
  const approvedContactIds = (approvedContacts || []).map((c: any) => c.id);
  if (approvedContactIds.length > 0) {
    const { data: dealContacts, error: dealContactError } = await supabase
      .from('crm_deal_contacts')
      .select('deal_id')
      .in('contact_id', approvedContactIds);

    if (dealContactError) {
      return NextResponse.json({ error: 'Failed to fetch deals' }, { status: 500 });
    }
    linkedDealIds = (dealContacts || []).map((r: any) => r.deal_id).filter(Boolean);
  }

  // Deduplicated authorized ID set — the boundary for all queries below
  const dealIds: string[] = Array.from(
    new Set<string>([...(ownedRows || []).map((r: any) => r.id), ...linkedDealIds])
  );

  if (dealIds.length === 0) {
    return NextResponse.json({ deadlines: [], closingDates: [], optionCycles: [] });
  }

  // Step 3c: Fetch deal display context, scoped to authorized IDs only
  const { data: deals, error: dealsError } = await supabase
    .from('borrower_applications')
    .select('id, property_address, company_name, closing_date, app_status')
    .in('id', dealIds);

  if (dealsError) {
    return NextResponse.json({ error: 'Failed to fetch deals' }, { status: 500 });
  }

  if (!deals || deals.length === 0) {
    return NextResponse.json({ deadlines: [], closingDates: [], optionCycles: [] });
  }

  // Build deal lookup for display context
  const dealMap: Record<string, { property_address: string | null; display_name: string | null }> = {};
  deals.forEach((d: any) => {
    dealMap[d.id] = {
      property_address: d.property_address || null,
      display_name: d.company_name || d.property_address || null,
    };
  });

  // Step 4: Query client-visible deadlines for this user's deals only
  const { data: rawDeadlines, error: deadlinesError } = await supabase
    .from('crm_deal_deadlines')
    .select('id, application_id, title, deadline_type, due_date, responsible_party, status, client_visible')
    .in('application_id', dealIds)
    .eq('client_visible', true)
    .neq('status', 'cancelled')
    .order('due_date', { ascending: true });

  if (deadlinesError) {
    return NextResponse.json({ error: 'Failed to fetch deadlines' }, { status: 500 });
  }

  // Step 5: Build safe deadline response — explicit projection, never spread raw rows
  const deadlines: ClientDeadlineItem[] = (rawDeadlines || []).map((row: any) => ({
    id: row.id,
    application_id: row.application_id,
    title: row.title,
    deadline_type: row.deadline_type,
    due_date: row.due_date,
    responsible_party: row.responsible_party,
    status: row.status,
    property_address: dealMap[row.application_id]?.property_address ?? null,
    deal_display_name: dealMap[row.application_id]?.display_name ?? null,
  }));

  // Step 6: Normalize closing dates — only for this user's deals
  const closingDates: ClosingDateItem[] = deals
    .filter((d: any) => d.closing_date)
    .map((d: any) => ({
      type: 'closing' as const,
      application_id: d.id,
      title: 'Target Closing',
      due_date: d.closing_date,
      responsible_party: 'system' as const,
      status: (['closed', 'funded'].includes(d.app_status) ? 'completed' : 'open') as 'open' | 'completed',
      property_address: d.property_address || null,
      deal_display_name: d.company_name || d.property_address || null,
    }));

  // Step 7: Query ACTIVE option cycles for authorized deals only
  // SECURITY: Borrower has NO direct SELECT on crm_deal_option_cycles.
  // This server-side query uses service role scoped to the authorized deal IDs.
  // Only active cycles are returned (not historical extended/exercised/missed cycles).
  // Only safe fields are included in the response — no internal admin metadata.
  const { data: rawOptionCycles, error: optionError } = await supabase
    .from('crm_deal_option_cycles')
    .select(
      'id, application_id, cycle_number, deposit_goes_hard_date, option_exercise_deadline, status, option_exercised_at, actual_option_exercised_at, extension_psa_amendment_received_at, actual_amendment_received_at, extension_fee_paid_at'
    )
    .in('application_id', dealIds)
    .eq('status', 'active');

  // Option cycles are optional — don't fail the whole response if this errors
  const optionCycles: ClientOptionCycleItem[] = [];

  if (!optionError && rawOptionCycles) {
    for (const row of rawOptionCycles) {
      // Derive timeliness server-side — never trust browser
      // Use actual_amendment_received_at as canonical field; fall back to
      // extension_psa_amendment_received_at for backward compatibility only
      const amendmentTs = row.actual_amendment_received_at ?? row.extension_psa_amendment_received_at;
      let hasTimelyAmendment = false;
      if (amendmentTs) {
        const cutoff = getOptionDeadlineCutoff(row.option_exercise_deadline);
        const amendmentDate = new Date(amendmentTs);
        hasTimelyAmendment = amendmentDate.getTime() <= cutoff.getTime();
      }

      // Determine client-facing option status
      // Do NOT expose 'missed' to client yet (Step 5D-2)
      // Do NOT expose internal leniency language
      let clientStatus: 'active' | 'exercised' | 'extended' = 'active';
      if (row.status === 'exercised') clientStatus = 'exercised';
      else if (row.status === 'extended') clientStatus = 'extended';

      // Only include option_exercised_at if exercised (confirms completed action)
      // Use actual_option_exercised_at as canonical field
      const exercisedAt = (row.status === 'exercised')
        ? (row.actual_option_exercised_at ?? row.option_exercised_at ?? null)
        : null;

      // Safe explicit mapping — no spread of raw row
      optionCycles.push({
        type: 'option_cycle',
        id: row.id,
        application_id: row.application_id,
        cycle_number: row.cycle_number,
        deposit_goes_hard_date: row.deposit_goes_hard_date ?? null,
        option_exercise_deadline: row.option_exercise_deadline,
        option_deadline_cutoff_display: formatOptionCutoffDisplay(row.option_exercise_deadline),
        option_status: clientStatus,
        has_timely_amendment: hasTimelyAmendment,
        extension_fee_paid: !!row.extension_fee_paid_at,
        option_exercised_at: exercisedAt,
        property_address: dealMap[row.application_id]?.property_address ?? null,
        deal_display_name: dealMap[row.application_id]?.display_name ?? null,
      });
    }
  }

  return NextResponse.json({ deadlines, closingDates, optionCycles });
}
