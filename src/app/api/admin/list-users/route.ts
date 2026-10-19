import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

interface AuthUserListItem {
  id: string;
  email: string;
  full_name: string;
  created_at: string;
  email_confirmed_at: string | null;
  email_verified: boolean;
}

// GET /api/admin/list-users
// Returns all NON-ADMIN Supabase Auth users using the service role key (admin only, server-side).
// Auth is the authoritative source for registered accounts: a user is returned even when
// email is unverified, no borrower_application exists, no CRM Contact exists, and no
// borrower_access row exists. email_verified is derived from Auth email_confirmed_at.
// If the Auth lookup fails this route returns a server error — never an empty list.
export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const isPlaceholder = (val: string) =>
    val.startsWith('your-') || val === '' || val.includes('your-supabase-service-role-key');

  if (!supabaseUrl || !serviceRoleKey || isPlaceholder(serviceRoleKey)) {
    console.error('list-users error: required server environment variable is not configured');
    return NextResponse.json(
      { error: 'Required server environment variable is not configured.' },
      { status: 503 }
    );
  }

  // ── 1. Authenticate the caller via SSR session ────────────────────────────
  const cookieStore = await cookies();
  const ssrClient = createServerClient(
    supabaseUrl,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await ssrClient.auth.getUser();

  // ── 2. Require authenticated Admin (app_metadata only — never user_metadata) ──
  if (!user || user.app_metadata?.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // ── 3. Only after authentication succeeds may the service-role client be used ──
  try {
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch all Auth users via the Auth Admin API — paginate (max 1000 per page).
    // Any Auth lookup error is thrown so the caller gets a visible server error.
    const allUsers: AuthUserListItem[] = [];
    let page = 1;
    const perPage = 1000;

    while (true) {
      const { data, error } = await adminClient.auth.admin.listUsers({
        page,
        perPage,
      });
      if (error) throw error;
      const users = data?.users ?? [];
      for (const u of users) {
        // Client users only — exclude Admin accounts (app_metadata only, never user_metadata)
        if (u.app_metadata?.role === 'admin') continue;
        const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
        const fullName = typeof meta.full_name === 'string' ? meta.full_name.trim() : '';
        allUsers.push({
          id: u.id,
          email: u.email ?? '',
          full_name: fullName,
          created_at: u.created_at,
          email_confirmed_at: u.email_confirmed_at ?? null,
          email_verified: !!u.email_confirmed_at,
        });
      }
      if (users.length < perPage) break;
      page++;
    }

    // Enrich with borrower profile data from borrower_applications (optional).
    // A failure here must not be hidden as "no profiles" — surface it as an error too.
    const { data: borrowerProfiles, error: profileError } = await adminClient
      .from('borrower_applications')
      .select('user_id, first_name, last_name, phone, email')
      .not('user_id', 'is', null)
      .is('purged_at', null)
      .order('created_at', { ascending: false });

    if (profileError) throw profileError;

    // Build a map of user_id -> profile (first/most recent record wins)
    const profileMap = new Map<string, { first_name: string; last_name: string; phone: string }>();
    for (const profile of borrowerProfiles ?? []) {
      if (profile.user_id && !profileMap.has(profile.user_id)) {
        profileMap.set(profile.user_id, {
          first_name: profile.first_name || '',
          last_name: profile.last_name || '',
          phone: profile.phone || '',
        });
      }
    }

    // Merge auth users with profile data; newest registrations first
    const enrichedUsers = allUsers
      .map((u) => {
        const profile = profileMap.get(u.id);
        return {
          id: u.id,
          email: u.email,
          full_name: u.full_name,
          created_at: u.created_at,
          email_confirmed_at: u.email_confirmed_at,
          email_verified: u.email_verified,
          first_name: profile?.first_name || '',
          last_name: profile?.last_name || '',
          phone: profile?.phone || '',
        };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json({ users: enrichedUsers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('list-users error: Auth user lookup failed:', message);
    return NextResponse.json(
      { error: 'Unable to load registered users. Please try again.' },
      { status: 500 }
    );
  }
}
