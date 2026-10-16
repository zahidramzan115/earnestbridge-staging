import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { getOptionDeadlineCutoff } from '@/app/api/admin/option-cycles/route';

// ── Constants ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

// Explicit allow-list of borrower_applications columns returned to the browser.
// user_id and any internal/admin fields are intentionally excluded.
const DEAL_SELECT =
  'id, user_id, company_name, property_address, property_type, purchase_price, deposit_amount, closing_date, app_status, llc_name, llc_state, transaction_description, w9_signed, mou_signed, option_agreement_signed, llc_formed, psa_signed';

function notFound() {
  return NextResponse.json(
    { error: 'deal_not_found' },
    { status: 404, headers: NO_STORE_HEADERS }
  );
}

// Client-safe option cycle projection (explicit allow-list; never a raw row).
type ClientOptionStatus =
  | 'action_required' |'extension_in_process' |'extension_requirements_received' |'option_exercised';

interface PortalOptionCycle {
  cycle_number: number;
  deposit_goes_hard_date: string;
  option_exercise_deadline: string;
  option_deadline_cutoff_display: string;
  client_status: ClientOptionStatus;
  has_timely_amendment: boolean;
  extension_fee_paid: boolean;
}

function formatOptionCutoffDisplay(deadlineDateStr: string): string {
  const [y, m, d] = deadlineDateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y} at 5:00 PM ET`;
}

// Runs ONLY after the owner/contact authorization check has succeeded.
// Failures are non-fatal: the option card is optional, so we return null.
async function loadPortalOptionCycle(
  supabase: ReturnType<typeof getServiceClient>,
  dealId: string
): Promise<PortalOptionCycle | null> {
  try {
    const { data: rows, error } = await supabase
      .from('crm_deal_option_cycles')
      .select(
        'cycle_number, deposit_goes_hard_date, option_exercise_deadline, status, actual_option_exercised_at, option_exercised_at, actual_amendment_received_at, extension_psa_amendment_received_at, extension_fee_paid_at'
      )
      .eq('application_id', dealId)
      .eq('status', 'active')
      .order('cycle_number', { ascending: false })
      .limit(1);

    if (error || !rows || rows.length === 0) return null;
    const row = rows[0] as {
      cycle_number: number;
      deposit_goes_hard_date: string | null;
      option_exercise_deadline: string | null;
      actual_option_exercised_at: string | null;
      option_exercised_at: string | null;
      actual_amendment_received_at: string | null;
      extension_psa_amendment_received_at: string | null;
      extension_fee_paid_at: string | null;
    };

    if (!row.option_exercise_deadline || !row.deposit_goes_hard_date) return null;

    // Same cutoff rule as /api/client/deadlines (5:00 PM ET on the deadline date).
    const amendmentTs = row.actual_amendment_received_at ?? row.extension_psa_amendment_received_at;
    let hasTimelyAmendment = false;
    if (amendmentTs) {
      const cutoff = getOptionDeadlineCutoff(row.option_exercise_deadline);
      hasTimelyAmendment = new Date(amendmentTs).getTime() <= cutoff.getTime();
    }

    const feePaid = !!row.extension_fee_paid_at;
    const exercised = !!(row.actual_option_exercised_at ?? row.option_exercised_at);

    let clientStatus: ClientOptionStatus = 'action_required';
    if (exercised) clientStatus = 'option_exercised';
    else if (hasTimelyAmendment && feePaid) clientStatus = 'extension_requirements_received';
    else if (hasTimelyAmendment) clientStatus = 'extension_in_process';

    return {
      cycle_number: row.cycle_number,
      deposit_goes_hard_date: row.deposit_goes_hard_date,
      option_exercise_deadline: row.option_exercise_deadline,
      option_deadline_cutoff_display: formatOptionCutoffDisplay(row.option_exercise_deadline),
      client_status: clientStatus,
      has_timely_amendment: hasTimelyAmendment,
      extension_fee_paid: feePaid,
    };
  } catch {
    return null;
  }
}

// ── Auth helpers (same inline pattern as the other portal routes) ─────────────

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

// Service client — server-only, never exposed to the browser.
function getServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

// ── GET /api/portal/deals/[dealId] ────────────────────────────────────────────
//
// SECURITY MODEL:
//   1. Authenticate via SSR cookie session; user id is derived server-side only.
//   2. Validate dealId as UUID.
//   3. Load the application by id with the service client (server-only).
//   4. Authorize if EITHER:
//        A. application.user_id === authenticated user id (legacy owner), OR
//        B. approved crm_contacts (portal_user_id = user.id,
//           portal_link_status = 'approved') AND an explicit crm_deal_contacts
//           row for (contact_id, deal_id).
//   5. Any failure → generic 404 deal_not_found (never reveals existence).
//   6. Return only allow-listed fields plus access_mode (UI capability hint,
//      NOT authorization).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ dealId: string }> }
) {
  try {
    // ── Step 1: Authenticate ────────────────────────────────────────────────
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

    // ── Step 2: Validate dealId ─────────────────────────────────────────────
    const { dealId } = await params;
    if (!dealId || !UUID_RE.test(dealId)) {
      return NextResponse.json(
        { error: 'invalid_deal_id' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // ── Step 3: Load application (server-only service client) ───────────────
    const supabase = getServiceClient();

    const { data: application, error: appError } = await supabase
      .from('borrower_applications')
      .select(DEAL_SELECT)
      .eq('id', dealId)
      .maybeSingle();

    if (appError) {
      return NextResponse.json(
        { error: 'deal_request_failed' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }

    if (!application) return notFound();

    // ── Step 4: Authorization ───────────────────────────────────────────────
    let accessMode: 'owner' | 'contact' | null = null;

    // PATH A — legacy owner
    if (application.user_id === user.id) {
      accessMode = 'owner';
    }

    // PATH B — approved CRM portal contact with explicit deal relationship
    if (!accessMode) {
      const { data: approvedContact, error: contactError } = await supabase
        .from('crm_contacts')
        .select('id')
        .eq('portal_user_id', user.id)
        .eq('portal_link_status', 'approved')
        .maybeSingle();

      if (contactError) {
        return NextResponse.json(
          { error: 'deal_request_failed' },
          { status: 500, headers: NO_STORE_HEADERS }
        );
      }

      if (approvedContact) {
        const { data: dealContact, error: dealContactError } = await supabase
          .from('crm_deal_contacts')
          .select('deal_id')
          .eq('contact_id', approvedContact.id)
          .eq('deal_id', dealId)
          .maybeSingle();

        if (dealContactError) {
          return NextResponse.json(
            { error: 'deal_request_failed' },
            { status: 500, headers: NO_STORE_HEADERS }
          );
        }

        if (dealContact) accessMode = 'contact';
      }
    }

    if (!accessMode) return notFound();

    // ── Step 4b: Option cycle (only after authorization has succeeded) ──────
    const optionCycle = await loadPortalOptionCycle(supabase, dealId);

    // ── Step 5: Allow-listed response (user_id is never returned) ───────────
    return NextResponse.json(
      {
        deal: {
          id: application.id,
          company_name: application.company_name,
          property_address: application.property_address,
          property_type: application.property_type,
          purchase_price: application.purchase_price,
          deposit_amount: application.deposit_amount,
          closing_date: application.closing_date,
          app_status: application.app_status,
          llc_name: application.llc_name,
          llc_state: application.llc_state,
          transaction_description: application.transaction_description,
          w9_signed: application.w9_signed,
          mou_signed: application.mou_signed,
          option_agreement_signed: application.option_agreement_signed,
          llc_formed: application.llc_formed,
          psa_signed: application.psa_signed,
        },
        option_cycle: optionCycle,
        access_mode: accessMode,
      },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch {
    // Fail closed — never leak raw errors.
    return NextResponse.json(
      { error: 'deal_request_failed' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
