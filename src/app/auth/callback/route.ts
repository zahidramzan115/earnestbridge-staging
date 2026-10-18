import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { ensurePortalSignupCrmContact } from '@/lib/server/portalSignupCrm';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = requestUrl.searchParams.get('next') ?? '/dashboard-home';

  if (code) {
    const cookieStore = cookies();
    const supabase = createRouteHandlerClient({
      cookies: () => cookieStore,
    });

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data?.user) {
      // Verified portal signup -> CRM Contact (non-admin only, best-effort).
      // A CRM failure must NEVER block verification/login.
      // Skipped for password-reset flows and Admin accounts.
      if (next !== '/reset-password' && data.user.app_metadata?.role !== 'admin') {
        try {
          const result = await ensurePortalSignupCrmContact(data.user, 'signup');
          console.log(`[auth/callback] portal signup CRM sync: ${result.outcome}`);
        } catch (crmErr) {
          console.error('[auth/callback] portal signup CRM sync failed (non-fatal):', crmErr);
        }
      }

      // Allow ONLY the exact internal value '/reset-password' from next.
      // Do NOT implement a general open redirect — only this exact equality check is permitted.
      // The redirect destination is always constructed from requestUrl.origin, never from next directly.
      if (next === '/reset-password') {
        return NextResponse.redirect(`${requestUrl.origin}/reset-password`);
      }

      // Redirect admins to admin panel, borrowers to dashboard
      // Trust ONLY app_metadata.role — user_metadata is user-editable and must not grant Admin routing
      const role = data.user.app_metadata?.role;
      const redirectTo =
        role === 'admin'
          ? `${requestUrl.origin}/admin`
          : `${requestUrl.origin}/dashboard-home`;
      return NextResponse.redirect(redirectTo);
    }
  }

  // If no code or error, redirect to login with error param
  return NextResponse.redirect(`${requestUrl.origin}/login?error=auth_callback_failed`);
}
