import { NextRequest, NextResponse } from 'next/server';
import { paymentDb } from '@/lib/server/payment/qboSync';

// GET  /api/payment/status?checkoutId=...   Public. Minimal status for the payment page.
// POST /api/payment/status {checkoutId, paymentId}
//      Public. Records the Coinflow payment id reported by the card form so the
//      webhook can be matched. Never changes status: only the verified webhook does.

export const dynamic = 'force-dynamic';

const ID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(request: NextRequest) {
  const checkoutId = request.nextUrl.searchParams.get('checkoutId') ?? '';
  if (!ID_RE.test(checkoutId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data } = await paymentDb()
    .from('payment_checkouts')
    .select('status, card_last4, failure_message')
    .eq('id', checkoutId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    status: data.status,
    cardLast4: data.card_last4,
    message: data.status === 'declined' || data.status === 'failed' ? data.failure_message : null,
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { checkoutId?: unknown; paymentId?: unknown };
  const checkoutId = typeof body.checkoutId === 'string' ? body.checkoutId : '';
  const paymentId = typeof body.paymentId === 'string' ? body.paymentId.trim() : '';
  if (!ID_RE.test(checkoutId) || !ID_RE.test(paymentId)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  await paymentDb()
    .from('payment_checkouts')
    .update({ coinflow_payment_id: paymentId })
    .eq('id', checkoutId)
    .eq('status', 'processing')
    .is('coinflow_payment_id', null);

  return NextResponse.json({ ok: true });
}
