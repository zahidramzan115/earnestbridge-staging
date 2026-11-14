import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { requireSuperAdmin } from '@/lib/server/adminAuth';
import { buildAuthorizeUrl, QboError } from '@/lib/server/qbo/client';

// GET /api/quickbooks/connect
// SuperAdmin only. Starts the QuickBooks OAuth flow.
// A random state value is kept in an httpOnly cookie and checked in the callback.

export const dynamic = 'force-dynamic';

const QBO_STATE_COOKIE = 'qbo_oauth_state';

export async function GET(request: Request) {
  const settingsUrl = new URL('/admin/settings', request.url);

  const user = await requireSuperAdmin();
  if (!user) {
    settingsUrl.searchParams.set('qbo', 'error');
    settingsUrl.searchParams.set('reason', 'not_authorized');
    return NextResponse.redirect(settingsUrl);
  }

  const state = randomBytes(24).toString('base64url');

  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(state);
  } catch (err) {
    console.error('[qbo/connect]', err instanceof Error ? err.message : err);
    settingsUrl.searchParams.set('qbo', 'error');
    settingsUrl.searchParams.set('reason', err instanceof QboError ? err.code : 'unexpected');
    return NextResponse.redirect(settingsUrl);
  }

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(QBO_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/quickbooks',
    maxAge: 10 * 60,
  });
  return response;
}
