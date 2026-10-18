import 'server-only';

import { NextResponse } from 'next/server';
import { validateServerEnv, createServiceRoleClient } from '@/lib/server/adminUsers';

export const PORTAL_ACCESS_DISABLED_ERROR = 'portal_access_disabled';

export type PortalAccessResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'error' };

/**
 * Account-wide Client Portal access check.
 *
 * Reads public.borrower_access with the REQUIRED server-only service-role
 * client (no anon fallback). Fails closed: if the check cannot be completed,
 * access is NOT granted.
 *
 * - No borrower_access row  -> active
 * - is_disabled = false     -> active
 * - is_disabled = true      -> disabled
 */
export async function checkPortalAccess(userId: string): Promise<PortalAccessResult> {
  if (!userId) return { ok: false, reason: 'error' };
  try {
    const env = validateServerEnv();
    const client = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
    const { data, error } = await client
      .from('borrower_access')
      .select('is_disabled')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) return { ok: false, reason: 'error' };
    if (data?.is_disabled === true) return { ok: false, reason: 'disabled' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Route-level guard. Call AFTER authenticating the Client user and BEFORE any
 * resource-specific authorization.
 *
 * Returns a NextResponse to return immediately when access is not allowed
 * (403 portal_access_disabled, or 500 if the check itself failed), or null
 * when the account is active.
 */
export async function assertPortalAccess(userId: string): Promise<NextResponse | null> {
  const result = await checkPortalAccess(userId);
  if (result.ok) return null;
  if (result.reason === 'disabled') {
    return NextResponse.json({ error: PORTAL_ACCESS_DISABLED_ERROR }, { status: 403 });
  }
  return NextResponse.json({ error: 'Server error.' }, { status: 500 });
}
