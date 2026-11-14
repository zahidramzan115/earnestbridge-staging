import { NextRequest, NextResponse } from 'next/server';
import { parseWebhook, verifyWebhook, type ParsedWebhook } from '@/lib/server/payment/coinflow';
import { logPaymentEvent, paymentDb, syncCheckoutToQbo } from '@/lib/server/payment/qboSync';
import { sendCheckoutReceipt } from '@/lib/server/payment/receipt';

// POST /api/payment/webhook
// Coinflow checkout webhooks. Authenticated by signature (or Authorization
// header), deduplicated by event id, matched to a checkout, then applied.
// "Settled" is the only event that marks a checkout paid and syncs QuickBooks.

export const dynamic = 'force-dynamic';

type Db = ReturnType<typeof paymentDb>;

interface CheckoutRow {
  id: string;
  status: string;
  amount_due_cents: number;
  currency: string;
  coinflow_payment_id: string | null;
  qbo_sync_status: string;
  receipt_status: string;
}

async function findCheckout(db: Db, event: ParsedWebhook): Promise<CheckoutRow | null> {
  const columns = 'id, status, amount_due_cents, currency, coinflow_payment_id, qbo_sync_status, receipt_status';
  if (event.checkoutId && /^[0-9a-f-]{36}$/i.test(event.checkoutId)) {
    const { data } = await db.from('payment_checkouts').select(columns).eq('id', event.checkoutId).maybeSingle();
    if (data) return data as CheckoutRow;
  }
  if (event.paymentId) {
    const { data } = await db.from('payment_checkouts').select(columns).eq('coinflow_payment_id', event.paymentId).maybeSingle();
    if (data) return data as CheckoutRow;
  }
  return null;
}

async function applyEvent(db: Db, event: ParsedWebhook, checkout: CheckoutRow): Promise<'processed' | 'ignored'> {
  const base: Record<string, unknown> = { coinflow_status: event.eventType };
  if (event.paymentId) base.coinflow_payment_id = event.paymentId;
  if (event.last4) base.card_last4 = event.last4;
  if (event.cardBrand) base.card_brand = event.cardBrand.slice(0, 20);

  const setStatus = async (to: string, extra: Record<string, unknown> = {}, onlyFrom?: string[]) => {
    let q = db.from('payment_checkouts').update({ ...base, status: to, ...extra }).eq('id', checkout.id);
    if (onlyFrom) q = q.in('status', onlyFrom);
    const { error } = await q;
    if (error) throw new Error(`Failed to update checkout: ${error.message}`);
    await logPaymentEvent(db, {
      checkoutId: checkout.id,
      action: 'status_change',
      result: 'success',
      triggeredBy: 'webhook',
      details: { event: event.eventType, from: checkout.status, to },
    });
  };

  switch (event.eventType) {
    case 'Card Payment Authorized':
    case 'Payment Pending Review': {
      const { error } = await db.from('payment_checkouts').update(base).eq('id', checkout.id);
      if (error) throw new Error(`Failed to update checkout: ${error.message}`);
      return 'processed';
    }

    case 'Settled': {
      if (checkout.status === 'settled') {
        // A different Coinflow payment settling on an already-paid checkout
        // means the customer was charged twice. Flag it for a refund.
        if (event.paymentId && checkout.coinflow_payment_id && event.paymentId !== checkout.coinflow_payment_id) {
          await logPaymentEvent(db, {
            checkoutId: checkout.id,
            action: 'refund_flag',
            result: 'error',
            triggeredBy: 'webhook',
            error: `Duplicate settled payment ${event.paymentId}; refund required`,
            details: { duplicate_payment_id: event.paymentId, subtotal_cents: event.subtotalCents },
          });
          return 'processed';
        }
        // Same payment delivered again: finish any step the first delivery did not complete.
        let finished = false;
        if (checkout.qbo_sync_status === 'pending' || checkout.qbo_sync_status === 'failed') {
          await syncCheckoutToQbo(checkout.id, { triggeredBy: 'webhook' });
          finished = true;
        }
        if (checkout.receipt_status === 'not_sent' || checkout.receipt_status === 'failed') {
          await sendCheckoutReceipt(checkout.id);
          finished = true;
        }
        return finished ? 'processed' : 'ignored';
      }

      const amountOk =
        event.subtotalCents === checkout.amount_due_cents &&
        (event.currency ?? 'USD').toUpperCase() === checkout.currency;

      await setStatus('settled', {
        settled_at: event.created ?? new Date().toISOString(),
        coinflow_subtotal_cents: event.subtotalCents,
        coinflow_fees_cents: event.feesCents,
        coinflow_total_cents: event.totalCents,
        qbo_sync_status: amountOk ? 'pending' : 'needs_review',
        qbo_last_error: amountOk
          ? null
          : `Settled amount ${event.subtotalCents} ${event.currency} does not match invoice amount ${checkout.amount_due_cents} ${checkout.currency}`,
      });

      // Money was taken: record it in QuickBooks and send the receipt. QuickBooks
      // failures are retried later, never by charging the customer again.
      // A mismatched amount is left for review, with no automatic receipt.
      if (amountOk) {
        await syncCheckoutToQbo(checkout.id, { triggeredBy: 'webhook' });
        await sendCheckoutReceipt(checkout.id);
      }
      return 'processed';
    }

    case 'Card Payment Declined':
    case 'Card Payment Suspected Fraud':
    case 'Card Payment Voided': {
      if (checkout.status === 'settled') return 'ignored';
      const to = event.eventType === 'Card Payment Declined' ? 'declined' : 'failed';
      const message =
        event.eventType === 'Card Payment Declined'
          ? 'Your card was declined. Please try a different card.'
          : 'This payment could not be completed. Please contact EarnestBridge.';
      await setStatus(to, { failure_code: event.eventType, failure_message: message }, ['verified', 'processing']);
      return 'processed';
    }

    case 'Card Payment Chargeback Opened':
    case 'Card Payment Chargeback Lost': {
      await setStatus('disputed');
      await logPaymentEvent(db, {
        checkoutId: checkout.id,
        action: 'refund_flag',
        result: 'skipped',
        triggeredBy: 'webhook',
        details: { event: event.eventType, note: 'Reconcile in QuickBooks' },
      });
      return 'processed';
    }

    case 'Card Payment Chargeback Won': {
      await setStatus('settled', {}, ['disputed']);
      return 'processed';
    }

    case 'Refund':
    case 'Refund Complete': {
      if (checkout.status === 'refunded') return 'ignored';
      await setStatus('refunded');
      await logPaymentEvent(db, {
        checkoutId: checkout.id,
        action: 'refund_flag',
        result: 'skipped',
        triggeredBy: 'webhook',
        details: { event: event.eventType, note: 'Reverse the QuickBooks payment manually' },
      });
      return 'processed';
    }

    default: {
      const { error } = await db.from('payment_checkouts').update(base).eq('id', checkout.id);
      if (error) throw new Error(`Failed to update checkout: ${error.message}`);
      return 'ignored';
    }
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let authentic: boolean;
  try {
    authentic = verifyWebhook(request.headers, rawBody);
  } catch (err) {
    console.error('[payment/webhook] config', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }
  if (!authentic) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: ParsedWebhook;
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
    event = parseWebhook(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const db = paymentDb();

  // ── Deduplicate ──────────────────────────────────────────────────────────
  const { data: inserted, error: insertError } = await db
    .from('payment_webhook_events')
    .insert({
      provider: 'coinflow',
      event_id: event.eventId,
      event_type: event.eventType,
      coinflow_payment_id: event.paymentId,
      signature_valid: true,
      payload,
      processing_attempts: 1,
    })
    .select('id')
    .single();

  let eventRowId: string;
  if (insertError) {
    if (insertError.code !== '23505') {
      console.error('[payment/webhook] failed to store event', insertError.message);
      return NextResponse.json({ error: 'Storage failed' }, { status: 500 });
    }
    const { data: existing } = await db
      .from('payment_webhook_events')
      .select('id, processing_status, processing_attempts')
      .eq('provider', 'coinflow')
      .eq('event_id', event.eventId)
      .single();
    if (!existing || existing.processing_status === 'processed' || existing.processing_status === 'ignored') {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    eventRowId = existing.id;
    await db
      .from('payment_webhook_events')
      .update({ processing_attempts: (existing.processing_attempts ?? 0) + 1 })
      .eq('id', eventRowId);
  } else {
    eventRowId = inserted.id;
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  try {
    const checkout = await findCheckout(db, event);
    if (!checkout) {
      await db
        .from('payment_webhook_events')
        .update({ processing_status: 'ignored', processed_at: new Date().toISOString(), error_message: 'No matching checkout' })
        .eq('id', eventRowId);
      return NextResponse.json({ ok: true, matched: false });
    }

    const result = await applyEvent(db, event, checkout);
    await db
      .from('payment_webhook_events')
      .update({ processing_status: result, processed_at: new Date().toISOString(), checkout_id: checkout.id, error_message: null })
      .eq('id', eventRowId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Processing failed';
    console.error('[payment/webhook] processing failed', message);
    await db
      .from('payment_webhook_events')
      .update({ processing_status: 'failed', error_message: message.slice(0, 1000) })
      .eq('id', eventRowId);
    // Non-2xx so Coinflow retries; the retry is reprocessed because status is "failed".
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
