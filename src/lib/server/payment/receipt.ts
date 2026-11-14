import 'server-only';

import { sendOutboundEmail } from '@/lib/server/outboundEmail';
import { logPaymentEvent, paymentDb } from './qboSync';

// EarnestBridge-branded payment receipt for a settled checkout.
// Sent at most once: the row is claimed (not_sent/failed -> sending) before
// sending, so concurrent or repeated webhooks cannot send a second copy.

const CARD_BRANDS: Record<string, string> = {
  VISA: 'Visa',
  MSTR: 'Mastercard',
  MASTERCARD: 'Mastercard',
  AMEX: 'American Express',
  DISC: 'Discover',
  DISCOVER: 'Discover',
};

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

export async function sendCheckoutReceipt(checkoutId: string): Promise<void> {
  const db = paymentDb();

  const { data: c, error } = await db
    .from('payment_checkouts')
    .update({ receipt_status: 'sending', receipt_error: null })
    .eq('id', checkoutId)
    .eq('status', 'settled')
    .in('receipt_status', ['not_sent', 'failed'])
    .select('payer_first_name, payer_last_name, payer_email, qbo_customer_name, qbo_invoice_number, amount_due_cents, currency, settled_at, card_brand, card_last4, coinflow_payment_id')
    .maybeSingle();

  if (error) {
    console.error('[payment/receipt] claim failed', error.message);
    return;
  }
  if (!c) return; // already sent, being sent, or not settled
  if (!c.payer_email) {
    await db.from('payment_checkouts').update({ receipt_status: 'failed', receipt_error: 'No payer email' }).eq('id', checkoutId);
    return;
  }

  const brand = c.card_brand ? CARD_BRANDS[c.card_brand.toUpperCase()] ?? c.card_brand : 'Card';
  const method = c.card_last4 ? `${brand} ending in ${c.card_last4}` : brand;
  const payerName = [c.payer_first_name, c.payer_last_name].filter(Boolean).join(' ');

  const lines = [
    `Hi ${c.payer_first_name || 'there'},`,
    '',
    'Thank you for your payment. This email confirms we have received it.',
    '',
    `Customer: ${c.qbo_customer_name || payerName}`,
    `Invoice: ${c.qbo_invoice_number}`,
    `Amount paid: ${formatMoney(c.amount_due_cents, c.currency)}`,
    `Payment date: ${formatDate(c.settled_at ?? new Date().toISOString())}`,
    `Payment method: ${method}`,
    `Confirmation number: ${c.coinflow_payment_id ?? checkoutId}`,
    '',
    'Please keep this email for your records.',
  ];

  try {
    const result = await sendOutboundEmail({
      emailType: 'admin_direct_message',
      to: c.payer_email,
      subject: `Payment Receipt — Invoice ${c.qbo_invoice_number}`,
      body: lines.join('\n'),
    });

    await db
      .from('payment_checkouts')
      .update({
        receipt_status: 'sent',
        receipt_sent_at: new Date().toISOString(),
        receipt_provider_id: result.messageId,
      })
      .eq('id', checkoutId);
    await logPaymentEvent(db, { checkoutId, action: 'receipt_email', result: 'success' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Receipt email failed';
    console.error('[payment/receipt] send failed', checkoutId, message);
    await db
      .from('payment_checkouts')
      .update({ receipt_status: 'failed', receipt_error: message.slice(0, 1000) })
      .eq('id', checkoutId);
    await logPaymentEvent(db, { checkoutId, action: 'receipt_email', result: 'error', error: message.slice(0, 1000) });
  }
}
