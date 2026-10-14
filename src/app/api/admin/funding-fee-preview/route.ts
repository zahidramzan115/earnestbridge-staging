import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Deal Fee Preview API
// POST /api/admin/funding-fee-preview
//
// SECURITY MODEL:
//   1. Authenticates the session via SSR Supabase client
//   2. Verifies the caller is an EarnestBridge Admin
//      (app_metadata.role === 'admin')
//   3. Calls the canonical calculate_deal_fee_cents() RPC
//      using the service_role client (function is SECURITY DEFINER,
//      GRANT EXECUTE TO service_role only)
//   4. Returns billable_days and deal_fee_cents
//   5. Does NOT persist any data
//   6. Does NOT create invoices
//
// Service-role credentials are NEVER exposed to the browser.
// The browser MUST NOT call calculate_deal_fee_cents() directly.
// ============================================================

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

// ── POST /api/admin/funding-fee-preview ──────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Verify Admin authorization
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  // 2. Parse and validate request body
  let body: {
    emd_funded_cents?: number;
    funded_date?: string;
    hard_date?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { emd_funded_cents, funded_date, hard_date } = body;

  // Validate emd_funded_cents
  if (typeof emd_funded_cents !== 'number' || !Number.isInteger(emd_funded_cents) || emd_funded_cents <= 0) {
    return NextResponse.json({ error: 'emd_funded_cents must be a positive integer.' }, { status: 422 });
  }

  // Validate funded_date
  if (typeof funded_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(funded_date)) {
    return NextResponse.json({ error: 'funded_date must be a YYYY-MM-DD date string.' }, { status: 422 });
  }

  // Validate hard_date
  if (typeof hard_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(hard_date)) {
    return NextResponse.json({ error: 'hard_date must be a YYYY-MM-DD date string.' }, { status: 422 });
  }

  // Validate date ordering
  const fundedTs = new Date(funded_date + 'T00:00:00');
  const hardTs = new Date(hard_date + 'T00:00:00');
  if (hardTs <= fundedTs) {
    return NextResponse.json({
      error: 'Original Deposit Goes Hard Date must be after the Funding Date.',
    }, { status: 422 });
  }

  // 3. Calculate billable days (calendar days: hard_date - funded_date)
  const billableDays = Math.round(
    (hardTs.getTime() - fundedTs.getTime()) / (1000 * 60 * 60 * 24)
  );

  // 4. Call canonical calculate_deal_fee_cents() via service_role
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('calculate_deal_fee_cents', {
    p_emd_funded_cents: emd_funded_cents,
    p_start_date: funded_date,
    p_end_date: hard_date,
  });

  if (error) {
    console.error('[funding-fee-preview] RPC error:', error);
    return NextResponse.json({ error: 'Failed to calculate Deal Fee.' }, { status: 500 });
  }

  const dealFeeCents = typeof data === 'number' ? data : Number(data);

  // 5. Return preview — nothing is persisted
  return NextResponse.json({
    billable_days: billableDays,
    deal_fee_cents: dealFeeCents,
  });
}
