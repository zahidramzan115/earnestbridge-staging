import { NextRequest, NextResponse } from 'next/server';
import { getInvoiceById, isVoided, toCents } from '@/lib/server/qbo/invoices';
import {
  buildChargebackProtectionData,
  createCheckoutJwt,
  createSessionKey,
  getCoinflowConfig,
} from '@/lib/server/payment/coinflow';
import { logPaymentEvent, paymentDb } from '@/lib/server/payment/qboSync';
import { PAYMENT_TERMS_VERSION } from '@/lib/paymentTerms';

// POST /api/payment/checkout
// Public. Body: { checkoutId, firstName, lastName, email, phone, termsAccepted }
// Re-checks the QuickBooks balance, locks the invoice for this checkout and
// returns the Coinflow session key + signed checkout JWT for the card form.

export const dynamic = 'force-dynamic';

const STALE_PROCESSING_MIN = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MSG_EXPIRED = 'Your session has expired. Please verify your invoice again.';
const MSG_CHANGED = 'The balance on this invoice has changed. Please verify your invoice again.';
const MSG_PROCESSING = 'A payment for this invoice is already being processed. Please check your email for a confirmation.';
const MSG_UNAVAILABLE = 'We are unable to start the payment right now. Please try again in a few minutes.';

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const checkoutId = clean(body.checkoutId, 64);
  const firstName = clean(body.firstName, 100);
  const lastName = clean(body.lastName, 100);
  const email = clean(body.email, 254).toLowerCase();
  const phone = clean(body.phone, 30);
  const termsAccepted = body.termsAccepted === true;

  if (!/^[0-9a-f-]{36}$/i.test(checkoutId)) {
    return NextResponse.json({ ok: false, message: MSG_EXPIRED }, { status: 400 });
  }
  if (!firstName || !lastName || !EMAIL_RE.test(email) || !/^[0-9+()\-.\s]{7,30}$/.test(phone)) {
    return NextResponse.json({ ok: false, message: 'Please complete all fields with valid information.' }, { status: 400 });
  }
  if (!termsAccepted) {
    return NextResponse.json({ ok: false, message: 'Please accept the Terms & Conditions to continue.' }, { status: 400 });
  }

  const db = paymentDb();
  const { data: checkout, error } = await db
    .from('payment_checkouts')
    .select('id, status, verification_expires_at, qbo_realm_id, qbo_invoice_id, qbo_invoice_number, qbo_customer_id, invoice_description, amount_due_cents, currency, coinflow_payment_id')
    .eq('id', checkoutId)
    .maybeSingle();

  if (error || !checkout) {
    return NextResponse.json({ ok: false, message: MSG_EXPIRED }, { status: 404 });
  }

  // Allow resuming our own checkout (e.g. after a page refresh) until Coinflow has a payment.
  const resumable = checkout.status === 'processing' && !checkout.coinflow_payment_id;
  if (checkout.status !== 'verified' && !resumable) {
    const message = checkout.status === 'settled' ? 'This invoice has already been paid. Thank you!' : MSG_EXPIRED;
    return NextResponse.json({ ok: false, message }, { status: 409 });
  }
  if (new Date(checkout.verification_expires_at).getTime() < Date.now()) {
    await db.from('payment_checkouts').update({ status: 'expired' }).eq('id', checkoutId).eq('status', checkout.status);
    return NextResponse.json({ ok: false, message: MSG_EXPIRED, code: 'expired' }, { status: 409 });
  }

  // ── Re-check the balance in QuickBooks right before charging ────────────
  try {
    const { invoice } = await getInvoiceById(checkout.qbo_invoice_id);
    if (!invoice || isVoided(invoice) || toCents(invoice.Balance) !== checkout.amount_due_cents) {
      await db.from('payment_checkouts').update({ status: 'cancelled', failure_message: 'Invoice balance changed before payment' }).eq('id', checkoutId);
      return NextResponse.json({ ok: false, message: MSG_CHANGED, code: 'balance_changed' }, { status: 409 });
    }
  } catch (err) {
    console.error('[payment/checkout] QuickBooks re-check failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status: 503 });
  }

  // ── Lock the invoice for this checkout ──────────────────────────────────
  if (checkout.status === 'verified') {
    // Release abandoned attempts on the same invoice that never reached Coinflow.
    await db
      .from('payment_checkouts')
      .update({ status: 'expired', failure_message: 'Abandoned before payment' })
      .eq('qbo_realm_id', checkout.qbo_realm_id)
      .eq('qbo_invoice_id', checkout.qbo_invoice_id)
      .eq('status', 'processing')
      .is('coinflow_payment_id', null)
      .lt('processing_started_at', new Date(Date.now() - STALE_PROCESSING_MIN * 60_000).toISOString());
  }

  const { error: lockError } = await db
    .from('payment_checkouts')
    .update({
      status: 'processing',
      processing_started_at: new Date().toISOString(),
      payer_first_name: firstName,
      payer_last_name: lastName,
      payer_email: email,
      payer_phone: phone,
      terms_accepted_at: new Date().toISOString(),
      terms_version: PAYMENT_TERMS_VERSION,
    })
    .eq('id', checkoutId)
    .in('status', ['verified', 'processing']);

  if (lockError) {
    // 23505: another checkout for this invoice is processing or settled.
    if (lockError.code === '23505') {
      return NextResponse.json({ ok: false, message: MSG_PROCESSING }, { status: 409 });
    }
    console.error('[payment/checkout] lock failed', lockError.message);
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status: 503 });
  }

  if (checkout.status === 'verified') {
    await logPaymentEvent(db, {
      checkoutId,
      action: 'status_change',
      result: 'success',
      details: { from: 'verified', to: 'processing' },
    });
  }

  // ── Coinflow session key + signed checkout parameters ───────────────────
  try {
    const cfg = getCoinflowConfig();
    const customerId = `eb-qbo-${checkout.qbo_realm_id}-${checkout.qbo_customer_id}`;
    const webhookInfo = {
      checkoutId,
      invoiceNumber: checkout.qbo_invoice_number,
      qboInvoiceId: checkout.qbo_invoice_id,
    };
    const chargebackProtectionData = buildChargebackProtectionData({
      invoiceNumber: checkout.qbo_invoice_number,
      description: checkout.invoice_description,
      amountCents: checkout.amount_due_cents,
    });
    const [sessionKey, jwtToken] = await Promise.all([
      createSessionKey(cfg, customerId),
      createCheckoutJwt(cfg, {
        subtotalCents: checkout.amount_due_cents,
        currency: 'USD',
        email,
        webhookInfo,
        chargebackProtectionData,
      }),
    ]);

    return NextResponse.json({
      ok: true,
      coinflow: {
        merchantId: cfg.merchantId,
        env: cfg.env,
        sessionKey,
        jwtToken,
      },
      subtotalCents: checkout.amount_due_cents,
      currency: 'USD',
      email,
      customerInfo: { firstName, lastName, email },
      webhookInfo,
      chargebackProtectionData,
    });
  } catch (err) {
    console.error('[payment/checkout] Coinflow setup failed', err instanceof Error ? err.message : err);
    // Release the lock so the customer can try again.
    await db.from('payment_checkouts').update({ status: 'verified', processing_started_at: null }).eq('id', checkoutId).eq('status', 'processing').is('coinflow_payment_id', null);
    return NextResponse.json({ ok: false, message: MSG_UNAVAILABLE }, { status: 502 });
  }
}
