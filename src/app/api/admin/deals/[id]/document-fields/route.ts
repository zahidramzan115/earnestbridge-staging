import { NextRequest, NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/server/adminAuth';
import { createServiceRoleClient, validateServerEnv } from '@/lib/server/adminUsers';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TEXT_FIELDS = [
  'client_legal_name',
  'escrow_agent',
  'option_term',
  'client_notice_address',
  'client_representative_name',
  'client_signatory_name',
  'client_signatory_title',
  'psa_title',
  'property_address',
  'llc_name',
  'llc_state',
  'llc_act',
  'registered_agent',
] as const;

const DATE_FIELDS = ['mou_effective_date', 'option_effective_date', 'llc_formation_date'] as const;
const MONEY_FIELDS = ['admin_fee', 'deal_fee', 'deposit_amount'] as const;

const ALLOWED = new Set<string>([...TEXT_FIELDS, ...DATE_FIELDS, ...MONEY_FIELDS, 'client_notice_email']);

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await checkAdmin();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'Unauthorized.' : 'Forbidden.' },
      { status: auth.status }
    );
  }

  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !ALLOWED.has(key));
  if (unknownKey) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const update: Record<string, string | number | null> = {};

  for (const field of TEXT_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value !== null && typeof value !== 'string') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    update[field] = value === null ? null : blankToNull(value);
  }

  if ('client_notice_email' in record) {
    const value = record.client_notice_email;
    if (value !== null && typeof value !== 'string') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const email = value === null ? null : blankToNull(value)?.toLowerCase() ?? null;
    if (email && !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'Notice email is not a valid email address.' }, { status: 400 });
    }
    update.client_notice_email = email;
  }

  for (const field of DATE_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value !== null && typeof value !== 'string') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const date = value === null ? null : blankToNull(value);
    if (date && !DATE_RE.test(date)) {
      return NextResponse.json({ error: 'Enter dates as YYYY-MM-DD.' }, { status: 400 });
    }
    update[field] = date;
  }

  for (const field of MONEY_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value === null || value === '') {
      update[field] = null;
      continue;
    }
    const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: 'Amounts must be zero or greater.' }, { status: 400 });
    }
    update[field] = Math.round(amount * 100) / 100;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to save.' }, { status: 400 });
  }

  let env: ReturnType<typeof validateServerEnv>;
  try {
    env = validateServerEnv();
  } catch {
    return NextResponse.json({ error: 'Server is not configured.' }, { status: 500 });
  }

  const supabase = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  const { data, error } = await supabase
    .from('borrower_applications')
    .update(update)
    .eq('id', id)
    .is('purged_at', null)
    .select(
      'id, property_address, deposit_amount, llc_name, llc_state, llc_act, llc_formation_date, registered_agent, client_legal_name, escrow_agent, admin_fee, deal_fee, option_term, client_notice_address, client_representative_name, client_notice_email, client_signatory_name, client_signatory_title, psa_title, mou_effective_date, option_effective_date'
    )
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'Could not save document fields.' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  return NextResponse.json({ deal: data });
}
