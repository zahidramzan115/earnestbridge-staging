import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Invoices API
// POST /api/admin/invoices          — Create initial draft invoice
// GET  /api/admin/invoices?application_id=xxx — List invoices for a deal
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client
//   2. Verifies app_metadata.role === 'admin'
//   3. All DB operations use service_role (never exposed to browser)
//   4. crm_invoices and crm_invoice_line_items are NEVER queried
//      directly from browser Supabase clients
// ============================================================

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

// ── GET /api/admin/invoices?application_id=xxx ────────────────────────────────
// Returns all invoices for a deal (safe summary — no wire snapshots)

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const applicationId = searchParams.get('application_id');
  if (!applicationId) {
    return NextResponse.json({ error: 'application_id is required.' }, { status: 400 });
  }

  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('crm_invoices')
    .select(
      'id, invoice_number, invoice_type, status, total_cents, subtotal_cents, discount_cents, ' + 'tax_cents, created_at, issued_at, billing_name, billing_email, due_date, '+ 'replaces_invoice_id, revision_source_invoice_id, option_cycle_id, emd_funded_cents, funding_date, billable_days'
    )
    .eq('application_id', applicationId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[invoices GET] query error:', error.message);
    return NextResponse.json({ error: 'Failed to load invoices.' }, { status: 500 });
  }

  return NextResponse.json({ invoices: data ?? [] });
}

// ── POST /api/admin/invoices ──────────────────────────────────────────────────
// Creates an initial draft invoice for a deal.
// Preconditions checked server-side:
//   - emd_funded_cents and funded_date must exist on the deal
//   - original cycle 1 deposit_goes_hard_date must exist and be > funded_date
//   - no duplicate initial draft (invoice_type='initial', status='draft', replaces_invoice_id IS NULL)
//   - no existing non-void initial invoice

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let body: { application_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { application_id } = body;
  if (!application_id || typeof application_id !== 'string') {
    return NextResponse.json({ error: 'application_id is required.' }, { status: 400 });
  }

  const supabase = getServiceClient();

  // ── 1. Load the Deal ──────────────────────────────────────────────────────
  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id, user_id, emd_funded_cents, funded_date, credit_card_payment_enabled, crm_company_id, primary_contact_id')
    .eq('id', application_id)
    .is('purged_at', null)
    .single();

  if (dealError || !deal) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  // ── 2. Require funding details ────────────────────────────────────────────
  if (!deal.emd_funded_cents || !deal.funded_date) {
    return NextResponse.json({
      error: 'Funding details must be completed before creating an invoice.',
    }, { status: 422 });
  }

  // ── 3. Load original Option Cycle (cycle_number = 1) ─────────────────────
  const { data: cycle } = await supabase
    .from('crm_deal_option_cycles')
    .select('id, deposit_goes_hard_date')
    .eq('application_id', application_id)
    .eq('cycle_number', 1)
    .maybeSingle();

  if (!cycle?.deposit_goes_hard_date) {
    return NextResponse.json({
      error: 'Original Deposit Goes Hard Date is required before creating an invoice.',
    }, { status: 422 });
  }

  // Validate date ordering
  const fundedTs = new Date(deal.funded_date + 'T00:00:00');
  const hardTs = new Date(cycle.deposit_goes_hard_date + 'T00:00:00');
  if (hardTs <= fundedTs) {
    return NextResponse.json({
      error: 'Original Deposit Goes Hard Date must be after the Funding Date.',
    }, { status: 422 });
  }

  // ── 4. Duplicate initial draft protection ─────────────────────────────────
  // Query ALL normal initial invoices (replaces_invoice_id IS NULL, revision_source_invoice_id IS NULL)
  // regardless of status. Once ANY normal initial invoice has ever existed, we must not create another.
  // revision_source_invoice_id IS NULL ensures Revision Drafts are never mistaken for normal initial invoices.
  const { data: existingNormalInitials, error: existingError } = await supabase
    .from('crm_invoices')
    .select('id, status, replaces_invoice_id')
    .eq('application_id', application_id)
    .eq('invoice_type', 'initial')
    .is('replaces_invoice_id', null)
    .is('revision_source_invoice_id', null);

  if (existingError) {
    console.error('[invoices POST] existing invoice query error:', existingError.message);
    return NextResponse.json({ error: 'Failed to check existing invoices.' }, { status: 500 });
  }

  if (existingNormalInitials && existingNormalInitials.length > 0) {
    // Integrity check: more than one normal initial invoice is a data error
    if (existingNormalInitials.length > 1) {
      return NextResponse.json({
        error: 'Integrity error: multiple normal initial invoices exist for this deal. Please contact support.',
      }, { status: 409 });
    }

    const existing = existingNormalInitials[0];

    // Existing draft — return it instead of creating another
    if (existing.status === 'draft') {
      return NextResponse.json({
        invoice_id: existing.id,
        existing: true,
        message: 'An existing initial draft invoice was found.',
      });
    }

    // Voided initial invoice — replacement workflow required, do not create a new normal initial
    if (existing.status === 'void') {
      return NextResponse.json({
        error: 'Initial invoice has been voided. A replacement invoice must be created through the replacement workflow.',
      }, { status: 409 });
    }

    // Any other status (issuing, open, partially_paid, paid) — do not create another
    return NextResponse.json({
      error: 'An initial invoice already exists for this deal.',
    }, { status: 409 });
  }

  // ── 5. Calculate canonical Deal Fee via service_role RPC ─────────────────
  const { data: feeData, error: feeError } = await supabase.rpc('calculate_deal_fee_cents', {
    p_emd_funded_cents: deal.emd_funded_cents,
    p_start_date: deal.funded_date,
    p_end_date: cycle.deposit_goes_hard_date,
  });

  if (feeError || feeData == null) {
    console.error('[invoices POST] fee RPC error:', feeError?.message);
    return NextResponse.json({ error: 'Failed to calculate Deal Fee.' }, { status: 500 });
  }

  const dealFeeCents = typeof feeData === 'number' ? feeData : Number(feeData);
  const billableDays = Math.round(
    (hardTs.getTime() - fundedTs.getTime()) / (1000 * 60 * 60 * 24)
  );

  // ── 6. Billing prefill from CRM ───────────────────────────────────────────
  let billingName: string | null = null;
  let billingContactName: string | null = null;
  let billingEmail: string | null = null;
  let billingAddressLine1: string | null = null;
  let billingCity: string | null = null;
  let billingState: string | null = null;
  let billingPostalCode: string | null = null;
  let billingCountry = 'US';

  // Load company if available
  if (deal.crm_company_id) {
    const { data: company } = await supabase
      .from('crm_companies')
      .select('company_name, address, city, state, zip, country')
      .eq('id', deal.crm_company_id)
      .maybeSingle();

    if (company) {
      billingName = company.company_name ?? null;
      billingAddressLine1 = company.address ?? null;
      billingCity = company.city ?? null;
      billingState = company.state ?? null;
      billingPostalCode = company.zip ?? null;
      billingCountry = company.country ?? 'US';
    }
  }

  // Load primary contact if available
  if (deal.primary_contact_id) {
    const { data: contact } = await supabase
      .from('crm_contacts')
      .select('first_name, last_name, primary_email')
      .eq('id', deal.primary_contact_id)
      .maybeSingle();

    if (contact) {
      const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
      billingContactName = fullName || null;
      billingEmail = contact.primary_email ?? null;
      // If no company, use contact name as billing_name
      if (!billingName && fullName) {
        billingName = fullName;
      }
    }
  }

  // ── 7. Create the invoice row ─────────────────────────────────────────────
  const { data: invoice, error: invoiceError } = await supabase
    .from('crm_invoices')
    .insert({
      application_id,
      invoice_type: 'initial',
      status: 'draft',
      invoice_number: null,
      company_id: deal.crm_company_id ?? null,
      contact_id: deal.primary_contact_id ?? null,
      option_cycle_id: cycle.id,
      currency: 'USD',
      emd_funded_cents: deal.emd_funded_cents,
      funding_date: deal.funded_date,
      period_start_date: deal.funded_date,
      period_end_date: cycle.deposit_goes_hard_date,
      billable_days: billableDays,
      billing_name: billingName,
      billing_contact_name: billingContactName,
      billing_email: billingEmail,
      billing_address_line1: billingAddressLine1,
      billing_address_line2: null,
      billing_city: billingCity,
      billing_state: billingState,
      billing_postal_code: billingPostalCode,
      billing_country: billingCountry,
      subtotal_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
      total_cents: 0,
      due_date: null,
      replaces_invoice_id: null,
      created_by: admin.id,
    })
    .select('id')
    .single();

  if (invoiceError || !invoice) {
    console.error('[invoices POST] invoice insert error:', invoiceError?.message);
    return NextResponse.json({ error: 'Failed to create invoice.' }, { status: 500 });
  }

  const invoiceId = invoice.id;

  // ── 8. Create default line items ──────────────────────────────────────────
  const DEFAULT_ADMIN_FEE_CENTS = 250000; // $2,500.00

  const lineItems = [
    {
      invoice_id: invoiceId,
      line_type: 'admin_fee',
      description: 'Administrative Fee',
      quantity: 1,
      unit_amount_cents: DEFAULT_ADMIN_FEE_CENTS,
      line_amount_cents: DEFAULT_ADMIN_FEE_CENTS,
      sort_order: 10,
      calc_emd_funded_cents: null,
      calc_daily_rate_per_100k_cents: null,
      calc_billable_days: null,
      calc_period_start_date: null,
      calc_period_end_date: null,
    },
    {
      invoice_id: invoiceId,
      line_type: 'deal_fee',
      description: 'Deal Fee',
      quantity: 1,
      unit_amount_cents: dealFeeCents,
      line_amount_cents: dealFeeCents,
      sort_order: 20,
      calc_emd_funded_cents: deal.emd_funded_cents,
      calc_daily_rate_per_100k_cents: 10000,
      calc_billable_days: billableDays,
      calc_period_start_date: deal.funded_date,
      calc_period_end_date: cycle.deposit_goes_hard_date,
    },
  ];

  const { error: lineItemError } = await supabase
    .from('crm_invoice_line_items')
    .insert(lineItems);

  if (lineItemError) {
    // Cleanup: delete the orphan invoice (line items first if any exist)
    console.error('[invoices POST] line item insert error:', lineItemError.message);
    try {
      await supabase.from('crm_invoice_line_items').delete().eq('invoice_id', invoiceId);
      await supabase.from('crm_invoices').delete().eq('id', invoiceId);
    } catch (cleanupErr) {
      console.error('[invoices POST] cleanup error:', cleanupErr);
    }
    return NextResponse.json({ error: 'Failed to create invoice line items.' }, { status: 500 });
  }

  // ── 9. Recalculate and update invoice totals ──────────────────────────────
  const subtotalCents = DEFAULT_ADMIN_FEE_CENTS + dealFeeCents;
  const totalCents = subtotalCents; // no discounts yet

  await supabase
    .from('crm_invoices')
    .update({
      subtotal_cents: subtotalCents,
      discount_cents: 0,
      tax_cents: 0,
      total_cents: totalCents,
    })
    .eq('id', invoiceId);

  // ── 10. Activity log (best-effort) ────────────────────────────────────────
  try {
    await supabase.from('application_activity').insert({
      application_id,
      user_id: deal.user_id,
      event_type: 'invoice_created',
      title: 'Invoice Draft Created',
      detail: 'Initial draft invoice created.',
      actor: 'EarnestBridge Admin',
      metadata: {
        invoice_id: invoiceId,
        invoice_type: 'initial',
        status: 'draft',
        total_cents: totalCents,
        created_by_admin_id: admin.id,
      },
    });
  } catch {
    // Activity logging is best-effort; never fail the main operation
  }

  return NextResponse.json({ invoice_id: invoiceId, existing: false }, { status: 201 });
}
