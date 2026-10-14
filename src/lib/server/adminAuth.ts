import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';

/**
 * Build a server-side Supabase client using the caller's session cookie.
 * Uses the anon key only — no service-role key is ever used here.
 */
async function buildServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );
}

/**
 * Require an authenticated Admin user.
 *
 * Authorization is based SOLELY on app_metadata.role — never on
 * user_metadata, email address, or any caller-supplied value.
 *
 * Returns the authenticated User object when:
 *   user.app_metadata?.role === 'admin'
 *
 * Returns null when:
 *   - No authenticated session exists
 *   - The authenticated user is not an Admin
 */
export async function requireAdmin(): Promise<User | null> {
  const supabase = await buildServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

/**
 * Require an authenticated SuperAdmin user.
 *
 * SuperAdmin is an ADDITIONAL privilege on top of Admin.
 * BOTH conditions must be true — neither alone is sufficient:
 *   user.app_metadata?.role === 'admin'
 *   user.app_metadata?.is_superadmin === true
 *
 * Authorization is based SOLELY on app_metadata — never on
 * user_metadata, email address, or any caller-supplied value.
 *
 * Returns the authenticated User object only when both conditions are met.
 * Returns null in all other cases.
 */
export async function requireSuperAdmin(): Promise<User | null> {
  const user = await requireAdmin();

  if (!user) return null;

  const isSuperAdmin = user.app_metadata?.is_superadmin === true;
  return isSuperAdmin ? user : null;
}
