import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

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
