import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { ensurePortalSignupCrmContact } from '@/lib/server/portalSignupCrm';

/**
 * POST /api/portal/ensure-crm-contact
 *
 * Safety net for legacy verified portal users who signed up before verified
 * signup created a CRM Contact. Called best-effort after a normal Client sign-in.
 *
 * Security:
 *   - Authenticated session required (cookie-based). No request-body identity.
 *   - Non-admin, email-verified Clients only.
 *   - Service-role client required inside the helper (no anon fallback).
 *   - 'backfill' mode: NEVER restores a purged Contact.
 *   - Idempotent; never overwrites a different portal_user_id.
 *   - Independent of borrower_access: CRM Contact visibility does not depend
 *     on account-wide Portal Access. Never reads or modifies borrower_access.
 */
export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only: this route does not refresh or set cookies.
        },
      },
    });

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.app_metadata?.role === 'admin') {
      return NextResponse.json({ ok: true, outcome: 'skipped_admin' });
    }
    if (!user.email_confirmed_at) {
      return NextResponse.json({ ok: true, outcome: 'skipped_unverified' });
    }

    const result = await ensurePortalSignupCrmContact(user, 'backfill');
    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch (err) {
    console.error('[ensure-crm-contact] failed (non-fatal for caller):', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
