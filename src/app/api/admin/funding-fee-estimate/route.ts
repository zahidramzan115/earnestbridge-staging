import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Pre-Funding Deal Fee Estimate API
// GET /api/admin/funding-fee-estimate?application_id=xxx
//
// READ-ONLY. Admin-only. No database writes. No invoice. Nothing stored.
//
// Inputs (read server-side from borrower_applications):
//   deposit_amount      -> DOLLARS
//   due_diligence_days  -> INTEGER calendar days
//
// Formula (rate = $100 per calendar day per $100,000 of EMD):
//   estimated_deal_fee_cents = ROUND(deposit_amount_dollars * 100 * days / 1000)
//   (dollars -> cents conversion happens exactly once, via the "* 100")
//
// Result unit: CENTS.
// The authoritative funded calculation (calculate_deal_fee_cents) is untouched.
// ============================================================

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
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const applicationId = searchParams.get('application_id');
  if (!applicationId || !UUID_RE.test(applicationId)) {
    return NextResponse.json({ error: 'A valid application_id is required.' }, { status: 400 });
  }

  const supabase = getServiceClient();
  const { data: app, error } = await supabase
    .from('borrower_applications')
    .select('id, deposit_amount, due_diligence_days')
    .eq('id', applicationId)
    .is('purged_at', null)
    .single();

  if (error || !app) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  // deposit_amount = DOLLARS
  const depositRaw = app.deposit_amount;
  const requestedEmdDollars =
    depositRaw === null || depositRaw === undefined || depositRaw === ''
      ? null
      : Number(depositRaw);
  const ddDays = app.due_diligence_days as number | null;

  if (requestedEmdDollars === null || !Number.isFinite(requestedEmdDollars) || requestedEmdDollars < 0) {
    return NextResponse.json(
      { error: 'Requested EMD is required to estimate the Deal Fee.', code: 'missing_requested_emd' },
      { status: 422 }
    );
  }

  if (ddDays === null || ddDays === undefined || !Number.isInteger(ddDays) || ddDays < 1 || ddDays > 999) {
    return NextResponse.json(
      { error: 'Due Diligence Period is required to estimate the Deal Fee.', code: 'missing_due_diligence_days' },
      { status: 422 }
    );
  }

  // Dollars -> cents exactly once. Result is CENTS.
  const estimatedDealFeeCents = Math.round((requestedEmdDollars * 100 * ddDays) / 1000);

  return NextResponse.json({
    requested_emd_dollars: requestedEmdDollars,
    due_diligence_days: ddDays,
    estimated_deal_fee_cents: estimatedDealFeeCents,
  });
}
