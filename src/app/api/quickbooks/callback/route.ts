import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { requireSuperAdmin } from '@/lib/server/adminAuth';
import { completeAuthorization, QboError } from '@/lib/server/qbo/client';

// GET /api/quickbooks/callback?code=...&realmId=...&state=...
// Intuit redirects here after the SuperAdmin approves the connection.
// Must match QBO_REDIRECT_URI and the Redirect URI registered with Intuit.

export const dynamic = 'force-dynamic';

const QBO_STATE_COOKIE = 'qbo_oauth_state';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(request: NextRequest) {
  const settingsUrl = new URL('/admin/settings', request.url);

  const finish = (outcome: 'connected' | 'error', reason?: string) => {
    settingsUrl.searchParams.set('qbo', outcome);
    if (reason) settingsUrl.searchParams.set('reason', reason);
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.set(QBO_STATE_COOKIE, '', { path: '/api/quickbooks', maxAge: 0 });
    return res;
  };

  const user = await requireSuperAdmin();
  if (!user) return finish('error', 'not_authorized');

  const params = request.nextUrl.searchParams;
  const intuitError = params.get('error');
  if (intuitError) return finish('error', intuitError === 'access_denied' ? 'access_denied' : 'intuit_error');

  const state = params.get('state') ?? '';
  const expectedState = request.cookies.get(QBO_STATE_COOKIE)?.value ?? '';
  if (!state || !expectedState || !safeEqual(state, expectedState)) {
    return finish('error', 'invalid_state');
  }

  const code = params.get('code');
  const realmId = params.get('realmId');
  if (!code || !realmId || !/^\d{1,32}$/.test(realmId)) {
    return finish('error', 'missing_code');
  }

  try {
    await completeAuthorization({ code, realmId, adminUserId: user.id });
    return finish('connected');
  } catch (err) {
    console.error('[qbo/callback]', err instanceof Error ? err.message : err);
    return finish('error', err instanceof QboError ? err.code : 'save_failed');
  }
}
