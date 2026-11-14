import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { QboError } from '@/lib/server/qbo/client';
import {
  findInvoicesByNumber,
  getCustomer,
  identityMatches,
  invoiceDescription,
  isEmailIdentifier,
  isVoided,
  toCents,
  type QboInvoice,
} from '@/lib/server/qbo/invoices';
import { getClientIp, hashIp, verifyHcaptcha } from '@/lib/server/payment/security';

// POST /api/payment/verify
// Public. Body: { invoiceNumber, identifier (email or name), captchaToken }
// Verifies a QuickBooks invoice for the generic /payment page and records a
// payment_checkouts row with status "verified". Card data is never handled here.

export const dynamic = 'force-dynamic';

const MSG_UNABLE = 'Unable to verify invoice. Please check your information and try again.';
const MSG_PAID = 'This invoice has already been paid. Thank you!';
const MSG_PROCESSING = 'A payment for this invoice is already being processed. Please check your email for a confirmation.';
const MSG_INELIGIBLE = 'This invoice cannot be paid online. Please contact EarnestBridge.';
const MSG_UNAVAILABLE = 'We are unable to verify invoices right now. Please try again in a few minutes.';
const MSG_RATE_LIMITED = 'Too many attempts. Please wait a few minutes and try again.';
const MSG_CAPTCHA = 'Please complete the verification check and try again.';

const IP_LIMIT = 10;              // attempts per IP
const IP_WINDOW_MIN = 15;
const INVOICE_FAIL_LIMIT = 10;    // failed attempts per invoice number
const INVOICE_WINDOW_MIN = 60;
const VERIFICATION_TTL_MIN = 30;

type LookupResult =
  | 'verified' | 'not_found' | 'mismatch' | 'already_paid' | 'ineligible'
  | 'rate_limited' | 'captcha_failed' | 'error';

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    invoiceNumber?: unknown;
    identifier?: unknown;
    captchaToken?: unknown;
  };

  const invoiceNumber = typeof body.invoiceNumber === 'string' ? body.invoiceNumber.trim() : '';
  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
  const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken : '';

  // QuickBooks DocNumber is at most 21 characters.
  if (!invoiceNumber || invoiceNumber.length > 21 || !identifier || identifier.length > 254) {
    return NextResponse.json({ ok: false, message: MSG_UNABLE }, { status: 400 });
  }

  const supabase = db();
  const ip = getClientIp(request);
  let ipHash: string;
  try {
    ipHash = hashIp(ip);
  } catch (err) {
    console.error('[payment/verify] config', err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status: 503 });
  }

  const record = async (result: LookupResult) => {
    const { error } = await supabase
      .from('payment_lookup_attempts')
      .insert({ ip_hash: ipHash, invoice_number: invoiceNumber, result });
    if (error) console.error('[payment/verify] failed to record attempt', error.message);
  };

  // ── Rate limits ──────────────────────────────────────────────────────────
  const [{ count: ipCount }, { count: invoiceFailCount }] = await Promise.all([
    supabase
      .from('payment_lookup_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', minutesAgo(IP_WINDOW_MIN)),
    supabase
      .from('payment_lookup_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_number', invoiceNumber)
      .in('result', ['not_found', 'mismatch', 'captcha_failed', 'rate_limited'])
      .gte('created_at', minutesAgo(INVOICE_WINDOW_MIN)),
  ]);

  if ((ipCount ?? 0) >= IP_LIMIT || (invoiceFailCount ?? 0) >= INVOICE_FAIL_LIMIT) {
    await record('rate_limited');
    return NextResponse.json({ ok: false, message: MSG_RATE_LIMITED }, { status: 429 });
  }

  // ── hCaptcha ─────────────────────────────────────────────────────────────
  let captchaOk: boolean;
  try {
    captchaOk = await verifyHcaptcha(captchaToken, ip);
  } catch (err) {
    console.error('[payment/verify] captcha config', err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status: 503 });
  }
  if (!captchaOk) {
    await record('captcha_failed');
    return NextResponse.json({ ok: false, message: MSG_CAPTCHA, code: 'captcha' }, { status: 400 });
  }

  // ── QuickBooks lookup ────────────────────────────────────────────────────
  let invoices: QboInvoice[];
  let realmId: string;
  let environment: 'sandbox' | 'production';
  try {
    ({ invoices, realmId, environment } = await findInvoicesByNumber(invoiceNumber));
  } catch (err) {
    console.error('[payment/verify] QuickBooks lookup failed', err instanceof Error ? err.message : err);
    await record('error');
    const status = err instanceof QboError && err.code === 'not_connected' ? 503 : 502;
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status });
  }

  if (invoices.length === 0) {
    await record('not_found');
    return NextResponse.json({ ok: false, message: MSG_UNABLE }, { status: 404 });
  }

  // Invoice numbers can repeat in QuickBooks. Keep only invoices whose
  // customer matches the payer; exactly one must remain.
  const matches: QboInvoice[] = [];
  for (const invoice of invoices) {
    const customer = await getCustomer(invoice.CustomerRef.value);
    if (identityMatches(identifier, invoice, customer)) matches.push(invoice);
  }

  if (matches.length === 0) {
    await record('mismatch');
    return NextResponse.json({ ok: false, message: MSG_UNABLE }, { status: 404 });
  }
  if (matches.length > 1) {
    console.warn('[payment/verify] ambiguous invoice number for one customer', invoiceNumber);
    await record('ineligible');
    return NextResponse.json({ ok: false, message: MSG_INELIGIBLE }, { status: 409 });
  }

  const invoice = matches[0];
  const currency = (invoice.CurrencyRef?.value ?? 'USD').toUpperCase();
  const amountDueCents = toCents(invoice.Balance);
  const totalCents = toCents(invoice.TotalAmt);

  if (isVoided(invoice) || currency !== 'USD') {
    await record('ineligible');
    return NextResponse.json({ ok: false, message: MSG_INELIGIBLE }, { status: 409 });
  }
  if (amountDueCents <= 0) {
    await record('already_paid');
    return NextResponse.json({ ok: false, message: MSG_PAID, code: 'already_paid' }, { status: 409 });
  }

  // A payment we already took may not have reached QuickBooks yet.
  const { data: active, error: activeError } = await supabase
    .from('payment_checkouts')
    .select('id, status, coinflow_payment_id, coinflow_status, amount_due_cents')
    .eq('qbo_realm_id', realmId)
    .eq('qbo_invoice_id', invoice.Id)
    .in('status', ['processing', 'settled'])
    .limit(1)
    .maybeSingle();
  if (activeError) {
    console.error('[payment/verify] checkout lookup failed', activeError.message);
    await record('error');
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status: 503 });
  }

  const description = invoiceDescription(invoice);
  const customerName = invoice.CustomerRef.name ?? null;
  const invoiceSummary = {
    number: invoice.DocNumber ?? invoiceNumber,
    customerName,
    description,
    currency,
    totalCents,
    amountDueCents,
  };

  if (active) {
    // An open attempt that never reached Coinflow (e.g. the page was reloaded):
    // the payer has just re-proved identity, so resume it instead of blocking.
    const resumable =
      active.status === 'processing' &&
      !active.coinflow_payment_id &&
      !active.coinflow_status &&
      active.amount_due_cents === amountDueCents;

    if (resumable) {
      const { error: resumeError } = await supabase
        .from('payment_checkouts')
        .update({ verification_expires_at: new Date(Date.now() + VERIFICATION_TTL_MIN * 60_000).toISOString() })
        .eq('id', active.id);
      if (!resumeError) {
        await record('verified');
        return NextResponse.json({
          ok: true,
          checkoutId: active.id,
          invoice: invoiceSummary,
          expiresInMinutes: VERIFICATION_TTL_MIN,
        });
      }
    }

    await record('already_paid');
    const message = active.status === 'settled' ? MSG_PAID : MSG_PROCESSING;
    return NextResponse.json({ ok: false, message, code: 'already_paid' }, { status: 409 });
  }

  // ── Record the verified checkout ─────────────────────────────────────────

  const { data: checkout, error: insertError } = await supabase
    .from('payment_checkouts')
    .insert({
      status: 'verified',
      qbo_environment: environment,
      qbo_realm_id: realmId,
      qbo_invoice_id: invoice.Id,
      qbo_invoice_number: invoice.DocNumber ?? invoiceNumber,
      qbo_customer_id: invoice.CustomerRef.value,
      qbo_customer_name: customerName,
      invoice_description: description,
      currency,
      invoice_total_cents: totalCents,
      amount_due_cents: amountDueCents,
      verified_by: isEmailIdentifier(identifier) ? 'email' : 'name',
      verification_expires_at: new Date(Date.now() + VERIFICATION_TTL_MIN * 60_000).toISOString(),
      payer_email: isEmailIdentifier(identifier) ? identifier.toLowerCase() : null,
      ip_hash: ipHash,
      user_agent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
    })
    .select('id')
    .single();

  if (insertError || !checkout) {
    console.error('[payment/verify] failed to create checkout', insertError?.message);
    await record('error');
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status: 503 });
  }

  await record('verified');

  return NextResponse.json({
    ok: true,
    checkoutId: checkout.id,
    invoice: invoiceSummary,
    expiresInMinutes: VERIFICATION_TTL_MIN,
  });
}
