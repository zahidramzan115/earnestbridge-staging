import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { qboGet, qboPost, QboError } from '@/lib/server/qbo/client';
import { getInvoiceById } from '@/lib/server/qbo/invoices';

// Records a settled Coinflow payment against its QuickBooks invoice.
// Safe to call repeatedly: QuickBooks deduplicates by requestid (the checkout id),
// and a checkout that is already synced is skipped.

const MAX_AUTO_ATTEMPTS = 5;
const SYNC_LEASE_MS = 2 * 60 * 1000;

export function paymentDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export async function logPaymentEvent(
  db: SupabaseClient,
  entry: {
    checkoutId: string;
    action: 'qbo_payment_create' | 'qbo_invoice_check' | 'receipt_email' | 'status_change' | 'admin_retry' | 'refund_flag';
    result: 'success' | 'error' | 'skipped';
    attempt?: number;
    error?: string | null;
    details?: Record<string, unknown>;
    triggeredBy?: 'system' | 'webhook' | 'admin';
    userId?: string | null;
  },
): Promise<void> {
  const { error } = await db.from('payment_sync_log').insert({
    checkout_id: entry.checkoutId,
    action: entry.action,
    result: entry.result,
    attempt_number: entry.attempt ?? 1,
    error_message: entry.error ?? null,
    details: entry.details ?? null,
    triggered_by: entry.triggeredBy ?? 'system',
    triggered_by_user_id: entry.userId ?? null,
  });
  if (error) console.error('[payment] failed to write sync log', error.message);
}

function backoffMinutes(attempt: number): number {
  return Math.min(5 * 2 ** (attempt - 1), 6 * 60);
}

/**
 * A previous attempt may have created the QuickBooks payment even though we
 * never recorded the result (e.g. a timeout). Look for a payment linked to the
 * invoice whose note carries this checkout id.
 */
async function findExistingQboPayment(invoiceId: string, checkoutId: string): Promise<string | null> {
  const { invoice } = await getInvoiceById(invoiceId);
  const linked = (invoice?.LinkedTxn ?? []).filter((t) => t.TxnType === 'Payment' && t.TxnId);
  for (const txn of linked) {
    const { data } = await qboGet<{ Payment?: { Id?: string; PrivateNote?: string } }>(
      `/payment/${encodeURIComponent(txn.TxnId)}`,
    );
    if (data.Payment?.Id && data.Payment.PrivateNote?.includes(checkoutId)) return data.Payment.Id;
  }
  return null;
}

export async function syncCheckoutToQbo(
  checkoutId: string,
  opts: { triggeredBy: 'system' | 'webhook' | 'admin'; userId?: string | null } = { triggeredBy: 'system' },
): Promise<{ ok: boolean; qboPaymentId?: string; error?: string }> {
  const db = paymentDb();

  const { data: c, error } = await db
    .from('payment_checkouts')
    .select('id, status, qbo_realm_id, qbo_invoice_id, qbo_customer_id, qbo_invoice_number, amount_due_cents, coinflow_payment_id, settled_at, qbo_sync_status, qbo_payment_id, qbo_sync_attempts')
    .eq('id', checkoutId)
    .single();
  if (error || !c) return { ok: false, error: 'Checkout not found' };

  if (c.qbo_sync_status === 'synced' && c.qbo_payment_id) return { ok: true, qboPaymentId: c.qbo_payment_id };
  if (c.status !== 'settled') return { ok: false, error: `Checkout is ${c.status}, not settled` };

  // Claim this attempt. The lease (qbo_next_retry_at) stops a concurrent caller,
  // e.g. a repeated webhook, from creating a second QuickBooks payment.
  const previousAttempts = c.qbo_sync_attempts ?? 0;
  const attempt = previousAttempts + 1;
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await db
    .from('payment_checkouts')
    .update({
      qbo_sync_status: 'pending',
      qbo_sync_attempts: attempt,
      qbo_next_retry_at: new Date(Date.now() + SYNC_LEASE_MS).toISOString(),
    })
    .eq('id', checkoutId)
    .eq('qbo_sync_attempts', previousAttempts)
    .in('qbo_sync_status', ['not_started', 'pending', 'failed'])
    .or(`qbo_next_retry_at.is.null,qbo_next_retry_at.lte."${now}"`)
    .select('id');
  if (claimError) return { ok: false, error: claimError.message };
  if (!claimed || claimed.length === 0) return { ok: false, error: 'Sync already in progress or not due yet' };

  const amount = Number((c.amount_due_cents / 100).toFixed(2));
  const txnDate = (c.settled_at ?? new Date().toISOString()).slice(0, 10);
  const depositAccountId = process.env.QBO_DEPOSIT_ACCOUNT_ID?.trim();

  const body: Record<string, unknown> = {
    CustomerRef: { value: c.qbo_customer_id },
    TotalAmt: amount,
    TxnDate: txnDate,
    // QuickBooks limits PaymentRefNum to 21 characters.
    PaymentRefNum: (c.coinflow_payment_id ?? checkoutId).slice(0, 21),
    PrivateNote: `Coinflow card payment ${c.coinflow_payment_id ?? ''} (EarnestBridge checkout ${checkoutId})`.slice(0, 4000),
    Line: [
      {
        Amount: amount,
        LinkedTxn: [{ TxnId: c.qbo_invoice_id, TxnType: 'Invoice' }],
      },
    ],
  };
  if (depositAccountId) body.DepositToAccountRef = { value: depositAccountId };

  try {
    let qboPaymentId = attempt > 1 ? await findExistingQboPayment(c.qbo_invoice_id, checkoutId) : null;
    if (!qboPaymentId) {
      // requestid is unique per attempt: QuickBooks replays the stored response
      // (including errors) for a repeated id, which would block real retries.
      const { data } = await qboPost<{ Payment?: { Id?: string } }>('/payment', body, `${checkoutId}:${attempt}`);
      qboPaymentId = data.Payment?.Id ?? null;
    }
    if (!qboPaymentId) throw new QboError('api_error', 'QuickBooks did not return a payment id');

    await db
      .from('payment_checkouts')
      .update({
        qbo_sync_status: 'synced',
        qbo_payment_id: qboPaymentId,
        qbo_synced_at: new Date().toISOString(),
        qbo_last_error: null,
        qbo_next_retry_at: null,
      })
      .eq('id', checkoutId);

    await logPaymentEvent(db, {
      checkoutId,
      action: opts.triggeredBy === 'admin' ? 'admin_retry' : 'qbo_payment_create',
      result: 'success',
      attempt,
      details: { qbo_payment_id: qboPaymentId, amount },
      triggeredBy: opts.triggeredBy,
      userId: opts.userId,
    });
    return { ok: true, qboPaymentId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'QuickBooks sync failed';
    // A 400 from QuickBooks (e.g. invoice balance already changed) will not fix itself.
    const permanent = err instanceof QboError && err.status === 400;
    const giveUp = permanent || attempt >= MAX_AUTO_ATTEMPTS;

    await db
      .from('payment_checkouts')
      .update({
        qbo_sync_status: giveUp ? 'needs_review' : 'failed',
        qbo_last_error: message.slice(0, 1000),
        qbo_next_retry_at: giveUp ? null : new Date(Date.now() + backoffMinutes(attempt) * 60_000).toISOString(),
      })
      .eq('id', checkoutId);

    await logPaymentEvent(db, {
      checkoutId,
      action: opts.triggeredBy === 'admin' ? 'admin_retry' : 'qbo_payment_create',
      result: 'error',
      attempt,
      error: message.slice(0, 1000),
      triggeredBy: opts.triggeredBy,
      userId: opts.userId,
    });
    console.error('[payment] QuickBooks sync failed', checkoutId, message);
    return { ok: false, error: message };
  }
}
