import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { ensurePortalSignupCrmContact } from '@/lib/server/portalSignupCrm';

// Only these OTP types are accepted for token_hash verification callbacks.
// 'email' is the canonical Supabase Confirm Signup type; 'signup' is retained as a legacy alias.
const SUPPORTED_OTP_TYPES = ['email', 'signup'] as const;
type SupportedOtpType = (typeof SUPPORTED_OTP_TYPES)[number];

function isSupportedOtpType(value: string | null): value is SupportedOtpType {
  return !!value && (SUPPORTED_OTP_TYPES as readonly string[]).includes(value);
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const tokenHash = requestUrl.searchParams.get('token_hash');
  const otpType = requestUrl.searchParams.get('type');
  const next = requestUrl.searchParams.get('next') ?? '/dashboard-home';

  const cookieStore = cookies();
  const supabase = createRouteHandlerClient({
    cookies: () => cookieStore,
  });

  let verifiedUser: User | null = null;

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data?.user) {
      verifiedUser = data.user;
    }
  } else if (tokenHash && isSupportedOtpType(otpType)) {
    const { data, error } = await supabase.auth.verifyOtp({
      type: otpType,
      token_hash: tokenHash,
    });
    if (!error && data?.user) {
      verifiedUser = data.user;
    }
  }

  if (verifiedUser) {
    // Verified portal signup -> CRM Contact (non-admin only, best-effort).
    // A CRM failure must NEVER block verification/login.
    // Skipped for password-reset flows and Admin accounts.
    if (next !== '/reset-password' && verifiedUser.app_metadata?.role !== 'admin') {
      try {
        const result = await ensurePortalSignupCrmContact(verifiedUser, 'signup');
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
    const role = verifiedUser.app_metadata?.role;
    const redirectTo =
      role === 'admin'
        ? `${requestUrl.origin}/admin`
        : `${requestUrl.origin}/dashboard-home`;
    return NextResponse.redirect(redirectTo);
  }

  // Missing/invalid/expired code or token -> safe login error experience
  return NextResponse.redirect(`${requestUrl.origin}/login?error=auth_callback_failed`);
}
