import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { assertPortalAccess } from '@/lib/server/portalAccess';

// ── Constants ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

// Eligible invoice statuses for portal display.
// Draft, issuing, and void/superseded invoices must NEVER appear.
const ELIGIBLE_STATUSES = ['open', 'partially_paid', 'paid'] as const;

// ── Auth helpers ──────────────────────────────────────────────────────────────

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
// SUPABASE_SERVICE_ROLE_KEY must never be returned, logged, or sent client-side.
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

// ── Safe response shape ───────────────────────────────────────────────────────
//
// Fields returned to the client:
//   id, invoice_number, status, issued_at, due_date, total_cents, currency,
//   is_revision (server-computed boolean),
//   amount_paid_cents (server-aggregated from received payments only),
//   balance_remaining_cents (server-computed: max(total_cents - amount_paid_cents, 0))
//
// Fields that must NEVER be returned:
//   application_id, company_id, contact_id, option_cycle_id,
//   revision_source_invoice_id, replaces_invoice_id,
//   pdf_storage_path, pdf_hash, pdf_generation_status, pdf_generation_error,
//   wire_instructions_snapshot, credit_card_payment_enabled_snapshot,
//   billing snapshot fields, internal_notes, invoice_notes,
//   created_by, voided_by, void_reason, issuing_started_at,
//   service role information, raw Supabase errors.
//
// Payment fields that must NEVER be returned:
//   idempotency_key, recorded_by, reference_number, notes,
//   provider, provider_payment_id, bank/wire fields,
//   timestamps, Admin identity, receipt_issued_at, receipt_pdf_storage_path,
//   receipt_pdf_hash, email delivery fields.
//   Only aggregate cents values plus the narrow `receipts` projection
//   { payment_id, receipt_number, receipt_pdf_generated_at } are added.
//   A receipt is included ONLY when status='received' AND all five receipt
//   completion fields are non-null (verified server-side).

interface SafeReceipt {
  payment_id: string;
  receipt_number: string;
  receipt_pdf_generated_at: string;
}

interface SafeInvoice {
  id: string;
  invoice_number: string;
  status: string;
  issued_at: string;
  due_date: string | null;
  total_cents: number;
  currency: string;
  is_revision: boolean;
  // Payment aggregate fields — server-computed from received payments only.
  amount_paid_cents: number;
  balance_remaining_cents: number;
  // Minimal, complete-receipt-only metadata for the Download Receipt link.
  receipts: SafeReceipt[];
}

// ── GET /api/portal/deals/[dealId]/invoices ───────────────────────────────────
//
// SECURITY MODEL:
//   1. Authenticate via SSR cookie session → derive user.id server-side only.
//      User ID is NEVER accepted from query params, request body, headers,
//      or deal data.
//   2. Validate dealId as UUID before any DB query.
//   3. Using service_role, find an approved CRM Contact:
//        crm_contacts WHERE portal_user_id = user.id
//                        AND portal_link_status = 'approved'
//      Fail closed (403) if none found.
//   4. Verify explicit crm_deal_contacts row:
//        crm_deal_contacts WHERE contact_id = contact.id AND deal_id = dealId
//      Fail closed (403) if not found.
//      DO NOT fall back to borrower_applications.user_id, company membership,
//      email matching, contact.company_id, or legacy portal ownership.
//   5. Query crm_invoices via service_role with all eligibility filters.
//   6. Batch-query crm_payments for authorized invoice IDs only.
//      Invoice IDs are server-derived — never accepted from the request.
//      Only status='received' payments are counted.
//      Fail closed (500) on payment query error — never return misleading $0.
//   7. Return only safe fields. Compute is_revision, amount_paid_cents,
//      and balance_remaining_cents server-side.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ dealId: string }> }
) {
  // ── Step 1: Authenticate — derive user server-side ────────────────────────
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

  // Account-wide portal access guard (before resource-specific authorization)
  const portalBlock = await assertPortalAccess(user.id);
  if (portalBlock) return portalBlock;

  // User ID is derived ONLY from the authenticated session.
  // It is never accepted from the URL, query params, body, or headers.
  const authenticatedUserId = user.id;

  // ── Step 2: Validate dealId as UUID ──────────────────────────────────────
  const { dealId } = await params;

  if (!dealId || !UUID_RE.test(dealId)) {
    return NextResponse.json(
      { error: 'invalid_deal_id' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // ── Step 3: Service client (server-only) ──────────────────────────────────
  const supabase = getServiceClient();

  // ── Step 4: Require an approved CRM Contact ───────────────────────────────
  // Select only the minimum needed field (id).
  // Do not fetch unnecessary Contact fields.
  const { data: approvedContacts, error: contactError } = await supabase
    .from('crm_contacts')
    .select('id')
    .eq('portal_user_id', authenticatedUserId)
    .eq('portal_link_status', 'approved');

  if (contactError) {
    // DB error — fail closed, do not expose raw Supabase error
    return NextResponse.json(
      { error: 'invoice_request_failed' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  const approvedContactIds = (approvedContacts ?? []).map((c: { id: string }) => c.id);

  if (approvedContactIds.length === 0) {
    // No approved linked Contact — fail closed.
    // Do not reveal whether the Deal exists.
    return NextResponse.json(
      { error: 'deal_access_denied' },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }

  // ── Step 5: Require explicit crm_deal_contacts relationship ──────────────
  // This explicit Deal ↔ Contact relationship is mandatory.
  // DO NOT fall back to borrower_applications.user_id, company membership,
  // email matching, contact.company_id, or legacy portal ownership.
  const { data: dealContacts, error: dealContactError } = await supabase
    .from('crm_deal_contacts')
    .select('deal_id')
    .in('contact_id', approvedContactIds)
    .eq('deal_id', dealId)
    .limit(1);

  if (dealContactError) {
    return NextResponse.json(
      { error: 'invoice_request_failed' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  if (!dealContacts || dealContacts.length === 0) {
    // No explicit Deal ↔ Contact relationship — fail closed.
    // Do not reveal whether the Deal exists.
    return NextResponse.json(
      { error: 'deal_access_denied' },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }

  // ── Step 5b: Parent Deal must be active (not purged) ─────────────────────
  // Service role bypasses RLS, so purge visibility is enforced explicitly.
  // Return the same response as a missing relationship — never reveal a purge.
  const { data: activeDeal, error: activeDealError } = await supabase
    .from('borrower_applications')
    .select('id')
    .eq('id', dealId)
    .is('purged_at', null)
    .maybeSingle();

  if (activeDealError) {
    return NextResponse.json(
      { error: 'invoice_request_failed' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  if (!activeDeal) {
    return NextResponse.json(
      { error: 'deal_access_denied' },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }

  // ── Step 6: Query eligible portal invoices ────────────────────────────────
  // Authorization is confirmed. Now query crm_invoices via service_role.
  //
  // Eligibility filters (ALL must be satisfied):
  //   - application_id = dealId (scoped to the authorized Deal)
  //   - status IN ('open', 'partially_paid', 'paid')
  //     Draft and issuing must NEVER appear.
  //     Void/superseded must NEVER appear.
  //   - invoice_number IS NOT NULL (issued invoices only)
  //   - issued_at IS NOT NULL (issued invoices only)
  //   - pdf_generation_status = 'generated' (PDF must be ready)
  //
  // Select ONLY the fields needed to build the safe response.
  // revision_source_invoice_id is fetched server-side ONLY to compute
  // is_revision — it is NOT returned to the client.
  //
  // Multiple eligible invoices are supported (initial, extension, other types).
  // Do NOT use .single(). Do NOT return only the newest invoice.
  // Sort by issued_at DESC for deterministic display ordering only.
  // Sort order does NOT determine which invoice is valid/current.
  const { data: rawInvoices, error: invoicesError } = await supabase
    .from('crm_invoices')
    .select(
      'id, invoice_number, status, issued_at, due_date, total_cents, currency, revision_source_invoice_id'
    )
    .eq('application_id', dealId)
    .in('status', ELIGIBLE_STATUSES)
    .not('invoice_number', 'is', null)
    .not('issued_at', 'is', null)
    .eq('pdf_generation_status', 'generated')
    .order('issued_at', { ascending: false });

  if (invoicesError) {
    // Do not expose raw Supabase error
    return NextResponse.json(
      { error: 'invoice_request_failed' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  // ── Step 7: Batch payment aggregate query ─────────────────────────────────
  // Invoice IDs are server-derived from the authorized query above.
  // A portal user can never supply arbitrary invoice IDs.
  //
  // If there are no invoices, skip the crm_payments query entirely.
  //
  // Otherwise perform ONE service-role query:
  //   SELECT invoice_id, amount_cents
  //   FROM crm_payments
  //   WHERE invoice_id IN (authorized invoice IDs)
  //     AND status = 'received'
  //
  // Only invoice_id and amount_cents are selected — no payment detail exposed.
  // Fail closed (500) on error — never return misleading $0 payment totals.

  const invoiceIds = (rawInvoices ?? []).map((inv) => inv.id);

  // Build aggregate map: invoice_id → total amount_paid_cents
  const paidMap = new Map<string, number>();
  // Build receipts map: invoice_id → eligible complete receipts
  const receiptsMap = new Map<string, SafeReceipt[]>();

  if (invoiceIds.length > 0) {
    const { data: paymentRows, error: paymentsError } = await supabase
      .from('crm_payments')
      .select(
        'id, invoice_id, amount_cents, receipt_number, receipt_issued_at, receipt_pdf_storage_path, receipt_pdf_generated_at, receipt_pdf_hash'
      )
      .in('invoice_id', invoiceIds)
      .eq('status', 'received')
      .order('receipt_pdf_generated_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });

    if (paymentsError) {
      // Payment query failed — fail closed.
      // Do NOT silently treat amount_paid as $0.
      // Do NOT return partial invoice data with incorrect payment totals.
      // Do NOT expose the raw Supabase/database error.
      console.error('[portal/invoices] payment aggregate query failed:', paymentsError.code);
      return NextResponse.json(
        { error: 'Unable to load invoice payment status.' },
        { status: 500, headers: NO_STORE_HEADERS }
      );
    }

    // Server-side aggregation — safe integer arithmetic.
    // Sum amount_cents per invoice_id for all received payments.
    for (const row of paymentRows ?? []) {
      const prev = paidMap.get(row.invoice_id) ?? 0;
      paidMap.set(row.invoice_id, prev + row.amount_cents);

      // Receipt eligibility: ALL FIVE completion fields must be non-null.
      // Only the three safe fields are projected into the response.
      if (
        row.receipt_number &&
        row.receipt_issued_at &&
        row.receipt_pdf_storage_path &&
        row.receipt_pdf_generated_at &&
        row.receipt_pdf_hash
      ) {
        const list = receiptsMap.get(row.invoice_id) ?? [];
        list.push({
          payment_id: row.id,
          receipt_number: row.receipt_number,
          receipt_pdf_generated_at: row.receipt_pdf_generated_at,
        });
        receiptsMap.set(row.invoice_id, list);
      }
    }
  }

  // ── Step 8: Build safe response — explicit projection only ────────────────
  // revision_source_invoice_id is used server-side to compute is_revision.
  // It is NOT included in the response.
  // amount_paid_cents and balance_remaining_cents are server-computed aggregates.
  // No payment row detail is returned.
  const invoices: SafeInvoice[] = (rawInvoices ?? []).map((inv: {
    id: string;
    invoice_number: string;
    status: string;
    issued_at: string;
    due_date: string | null;
    total_cents: number;
    currency: string;
    revision_source_invoice_id: string | null;
  }) => {
    const amountPaidCents = paidMap.get(inv.id) ?? 0;
    const balanceRemainingCents = Math.max(inv.total_cents - amountPaidCents, 0);

    return {
      id: inv.id,
      invoice_number: inv.invoice_number,
      status: inv.status,
      issued_at: inv.issued_at,
      due_date: inv.due_date,
      total_cents: inv.total_cents,
      currency: inv.currency,
      // is_revision is computed server-side — revision_source_invoice_id is NOT returned
      is_revision: inv.revision_source_invoice_id !== null,
      // Payment aggregates — server-computed, no payment detail exposed
      amount_paid_cents: amountPaidCents,
      balance_remaining_cents: balanceRemainingCents,
      receipts: receiptsMap.get(inv.id) ?? [],
    };
  });

  return NextResponse.json(
    { invoices },
    { status: 200, headers: NO_STORE_HEADERS }
  );
}
