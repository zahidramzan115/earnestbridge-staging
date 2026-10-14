import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Invoice Detail API
// GET   /api/admin/invoices/[id]   — Load full draft invoice
// PATCH /api/admin/invoices/[id]   — Save draft invoice fields
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client
//   2. Verifies app_metadata.role === 'admin'
//   3. All DB operations use service_role
//   4. PATCH only accepts draft invoices (server re-checks status)
//   5. PATCH only accepts permitted fields (billing snapshot, due_date,
//      invoice_notes, internal_notes, discount line operations)
//   6. Server recalculates totals — never trusts browser-submitted totals
//
// Phase 7B-4 additions to GET:
//   - payment_history: safe crm_payments fields (no idempotency_key)
//   - payment_summary: received-only amount_paid_cents + balance_remaining_cents
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

// ── GET /api/admin/invoices/[id] ──────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Invoice ID is required.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const supabase = getServiceClient();

  // Load invoice (excluding wire_instructions_snapshot — not needed for draft)
  const { data: invoice, error: invoiceError } = await supabase
    .from('crm_invoices')
    .select(
      'id, invoice_number, invoice_type, status, currency, ' + 'application_id, company_id, contact_id, option_cycle_id, '+ 'billing_name, billing_contact_name, billing_email, '+ 'billing_address_line1, billing_address_line2, billing_city, '+ 'billing_state, billing_postal_code, billing_country, '+ 'emd_funded_cents, funding_date, period_start_date, period_end_date, billable_days, '+ 'subtotal_cents, discount_cents, tax_cents, total_cents, '+ 'due_date, invoice_notes, internal_notes, '+ 'replaces_invoice_id, revision_source_invoice_id, created_at, updated_at, created_by, '+ 'pdf_generation_status, issued_at, '+ 'void_reason, voided_at'
    )
    .eq('id', id)
    .single();

  if (invoiceError || !invoice) {
    return NextResponse.json({ error: 'Invoice not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  // Load line items
  const { data: lineItems, error: lineItemError } = await supabase
    .from('crm_invoice_line_items')
    .select(
      'id, line_type, description, quantity, unit_amount_cents, line_amount_cents, ' + 'sort_order, calc_emd_funded_cents, calc_daily_rate_per_100k_cents, '+ 'calc_billable_days, calc_period_start_date, calc_period_end_date, '+ 'created_at, updated_at'
    )
    .eq('invoice_id', id)
    .order('sort_order', { ascending: true });

  if (lineItemError) {
    console.error('[invoices GET id] line items error:', lineItemError.message);
    return NextResponse.json({ error: 'Failed to load invoice line items.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  // Check invoice settings completeness (non-blocking warning)
  const { data: settingsRow } = await supabase
    .from('crm_invoice_settings')
    .select('id')
    .eq('id', 1)
    .not('issuer_legal_name', 'is', null)
    .neq('issuer_legal_name', '')
    .not('wire_bank_name', 'is', null)
    .neq('wire_bank_name', '')
    .not('wire_account_name', 'is', null)
    .neq('wire_account_name', '')
    .not('wire_routing_number', 'is', null)
    .neq('wire_routing_number', '')
    .not('wire_account_number', 'is', null)
    .neq('wire_account_number', '')
    .maybeSingle();

  const settingsComplete = settingsRow !== null;

  // ── Safe revision context ─────────────────────────────────────────────────
  let sourceInvoiceNumber: string | null = null;
  if (invoice.revision_source_invoice_id) {
    const { data: sourceRow } = await supabase
      .from('crm_invoices')
      .select('invoice_number')
      .eq('id', invoice.revision_source_invoice_id)
      .maybeSingle();
    sourceInvoiceNumber = sourceRow?.invoice_number ?? null;
  }

  const ACTIVE_CHILD_STATUSES = ['draft', 'issuing', 'open', 'partially_paid', 'paid'];
  let activeRevisionChild: { id: string; status: string } | null = null;
  if (invoice.status === 'open' && invoice.invoice_type === 'initial') {
    const { data: childRow } = await supabase
      .from('crm_invoices')
      .select('id, status')
      .eq('revision_source_invoice_id', id)
      .in('status', ACTIVE_CHILD_STATUSES)
      .maybeSingle();
    if (childRow) {
      activeRevisionChild = { id: childRow.id, status: childRow.status };
    }
  }

  // ── Email delivery status ─────────────────────────────────────────────────
  const { data: deliveryRow, error: deliveryError } = await supabase
    .from('crm_invoice_email_deliveries')
    .select('delivery_status, attempt_count, last_attempt_at, sent_at, last_error_code')
    .eq('invoice_id', id)
    .maybeSingle();

  if (deliveryError) {
    console.error('[invoices GET id] email delivery lookup failed:', {
      invoiceId: id,
      code: deliveryError.code ?? null,
    });
    return NextResponse.json({ error: 'Failed to load invoice.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  const emailDelivery = deliveryRow
    ? {
        status: deliveryRow.delivery_status as string,
        attempt_count: deliveryRow.attempt_count as number,
        last_attempt_at: deliveryRow.last_attempt_at as string | null,
        sent_at: deliveryRow.sent_at as string | null,
        last_error_code: deliveryRow.last_error_code as string | null,
      }
    : {
        status: 'not_sent' as const,
        attempt_count: 0,
        last_attempt_at: null,
        sent_at: null,
        last_error_code: null,
      };

  // ── Phase 7B-4: Payment history + payment summary ─────────────────────────
  // Safe projection only — idempotency_key is NEVER returned.
  // Order: received_at ASC NULLS LAST, then created_at ASC (deterministic).
  const { data: paymentRows, error: paymentError } = await supabase
    .from('crm_payments')
    .select(
      'id, invoice_id, payment_method, status, amount_cents, currency, ' + 'received_at, reference_number, notes, recorded_by, created_at'
    )
    .eq('invoice_id', id)
    .order('received_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });

  if (paymentError) {
    console.error('[invoices GET id] payment history lookup failed:', {
      invoiceId: id,
      code: paymentError.code ?? null,
    });
    return NextResponse.json({ error: 'Failed to load invoice.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  const paymentHistory = paymentRows ?? [];

  // Compute payment summary server-side.
  // Only status='received' payments count toward Amount Paid.
  // Defensive floor at 0 to prevent negative display from any legacy data.
  const amountPaidCents = paymentHistory.reduce(
    (sum, p) => (p.status === 'received' ? sum + (p.amount_cents as number) : sum),
    0
  );
  const totalCents = (invoice.total_cents as number) ?? 0;
  const balanceRemainingCents = Math.max(totalCents - amountPaidCents, 0);

  const paymentSummary = {
    amount_paid_cents: amountPaidCents,
    balance_remaining_cents: balanceRemainingCents,
  };

  return NextResponse.json(
    {
      invoice,
      line_items: lineItems ?? [],
      settings_complete: settingsComplete,
      // Safe revision context — display/navigation only
      revision_source_invoice_id: invoice.revision_source_invoice_id ?? null,
      source_invoice_number: sourceInvoiceNumber,
      active_revision_child: activeRevisionChild,
      // Email delivery status — safe fields only
      email_delivery: emailDelivery,
      // Phase 7B-4: Payment read model (Admin-only; idempotency_key excluded)
      payment_history: paymentHistory,
      payment_summary: paymentSummary,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// ── PATCH /api/admin/invoices/[id] ────────────────────────────────────────────
// Saves draft invoice. Server re-checks status = 'draft' before any mutation.
// Permitted fields: billing snapshot, due_date, invoice_notes, internal_notes,
//                   discount line operations (add/update/delete).
// Server recalculates totals from line items — never trusts submitted totals.

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Invoice ID is required.' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const supabase = getServiceClient();

  // ── Re-check status server-side ───────────────────────────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from('crm_invoices')
    .select('id, status, application_id')
    .eq('id', id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
  }

  if (existing.status !== 'draft') {
    return NextResponse.json({
      error: 'This invoice is no longer a draft and cannot be edited.',
    }, { status: 422 });
  }

  // ── Build permitted update payload ────────────────────────────────────────
  const BILLING_FIELDS = [
    'billing_name', 'billing_contact_name', 'billing_email',
    'billing_address_line1', 'billing_address_line2',
    'billing_city', 'billing_state', 'billing_postal_code', 'billing_country',
  ] as const;

  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  for (const field of BILLING_FIELDS) {
    if (field in body) {
      const val = body[field];
      updatePayload[field] = (val === '' || val === undefined) ? null : String(val).trim();
    }
  }

  if ('due_date' in body) {
    const dd = body.due_date;
    if (dd === null || dd === '' || dd === undefined) {
      updatePayload.due_date = null;
    } else if (typeof dd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dd)) {
      updatePayload.due_date = dd;
    } else {
      return NextResponse.json({ error: 'due_date must be a YYYY-MM-DD date string or null.' }, { status: 422 });
    }
  }

  if ('invoice_notes' in body) {
    const n = body.invoice_notes;
    updatePayload.invoice_notes = (n === '' || n === null || n === undefined) ? null : String(n).trim();
  }

  if ('internal_notes' in body) {
    const n = body.internal_notes;
    updatePayload.internal_notes = (n === '' || n === null || n === undefined) ? null : String(n).trim();
  }

  // ── Handle discount line operations ──────────────────────────────────────
  // discount_ops: Array of { op: 'add'|'update'|'delete', id?, description?, amount_cents? }
  const discountOps = body.discount_ops as Array<{
    op: 'add' | 'update' | 'delete';
    id?: string;
    description?: string;
    amount_cents?: number; // positive value from UI; server negates it
  }> | undefined;

  if (discountOps && Array.isArray(discountOps)) {
    for (const op of discountOps) {
      if (op.op === 'add') {
        // Validate
        if (!op.description || typeof op.description !== 'string' || !op.description.trim()) {
          return NextResponse.json({ error: 'Discount description must not be blank.' }, { status: 422 });
        }
        if (typeof op.amount_cents !== 'number' || !Number.isInteger(op.amount_cents) || op.amount_cents <= 0) {
          return NextResponse.json({ error: 'Discount amount must be a positive integer (cents).' }, { status: 422 });
        }
        const negativeAmount = -Math.abs(op.amount_cents);
        await supabase.from('crm_invoice_line_items').insert({
          invoice_id: id,
          line_type: 'discount',
          description: op.description.trim(),
          quantity: 1,
          unit_amount_cents: negativeAmount,
          line_amount_cents: negativeAmount,
          sort_order: 100,
        });
      } else if (op.op === 'update') {
        if (!op.id) continue;
        if (!op.description || typeof op.description !== 'string' || !op.description.trim()) {
          return NextResponse.json({ error: 'Discount description must not be blank.' }, { status: 422 });
        }
        if (typeof op.amount_cents !== 'number' || !Number.isInteger(op.amount_cents) || op.amount_cents <= 0) {
          return NextResponse.json({ error: 'Discount amount must be a positive integer (cents).' }, { status: 422 });
        }

        // Validate ownership: line must belong to this invoice AND be a discount line
        const { data: lineCheck, error: lineCheckError } = await supabase
          .from('crm_invoice_line_items')
          .select('id, line_type, invoice_id')
          .eq('id', op.id)
          .maybeSingle();

        if (lineCheckError || !lineCheck) {
          return NextResponse.json({ error: 'Discount line not found.' }, { status: 404 });
        }
        if (lineCheck.invoice_id !== id) {
          return NextResponse.json({ error: 'Line item does not belong to this invoice.' }, { status: 403 });
        }
        if (lineCheck.line_type !== 'discount') {
          return NextResponse.json({ error: 'Only discount lines may be edited through this workflow.' }, { status: 403 });
        }

        const negativeAmount = -Math.abs(op.amount_cents);
        await supabase.from('crm_invoice_line_items')
          .update({
            description: op.description.trim(),
            unit_amount_cents: negativeAmount,
            line_amount_cents: negativeAmount,
          })
          .eq('id', op.id)
          .eq('invoice_id', id)
          .eq('line_type', 'discount');
      } else if (op.op === 'delete') {
        if (!op.id) continue;

        // Validate ownership: line must belong to this invoice AND be a discount line
        const { data: lineCheck, error: lineCheckError } = await supabase
          .from('crm_invoice_line_items')
          .select('id, line_type, invoice_id')
          .eq('id', op.id)
          .maybeSingle();

        if (lineCheckError || !lineCheck) {
          return NextResponse.json({ error: 'Discount line not found.' }, { status: 404 });
        }
        if (lineCheck.invoice_id !== id) {
          return NextResponse.json({ error: 'Line item does not belong to this invoice.' }, { status: 403 });
        }
        if (lineCheck.line_type !== 'discount') {
          return NextResponse.json({ error: 'Only discount lines may be deleted through this workflow.' }, { status: 403 });
        }

        await supabase.from('crm_invoice_line_items')
          .delete()
          .eq('id', op.id)
          .eq('invoice_id', id)
          .eq('line_type', 'discount'); // only allow deleting discount lines
      }
    }
  }

  // ── Recalculate totals from line items (server-authoritative) ─────────────
  const { data: allLines } = await supabase
    .from('crm_invoice_line_items')
    .select('line_type, line_amount_cents')
    .eq('invoice_id', id);

  let subtotalCents = 0;
  let discountCents = 0;

  for (const line of allLines ?? []) {
    if (line.line_type === 'discount') {
      discountCents += Math.abs(line.line_amount_cents as number);
    } else {
      subtotalCents += (line.line_amount_cents as number);
    }
  }

  const totalCents = Math.max(0, subtotalCents - discountCents);

  // Validate: discount must not exceed subtotal
  if (discountCents > subtotalCents) {
    return NextResponse.json({
      error: 'Total discounts cannot exceed the invoice subtotal.',
    }, { status: 422 });
  }

  updatePayload.subtotal_cents = subtotalCents;
  updatePayload.discount_cents = discountCents;
  updatePayload.tax_cents = 0;
  updatePayload.total_cents = totalCents;

  // ── Persist the update ────────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from('crm_invoices')
    .update(updatePayload)
    .eq('id', id);

  if (updateError) {
    console.error('[invoices PATCH] update error:', updateError.message);
    return NextResponse.json({ error: 'Failed to save invoice.' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    subtotal_cents: subtotalCents,
    discount_cents: discountCents,
    tax_cents: 0,
    total_cents: totalCents,
  });
}
