import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// GET /api/admin/list-users
// Returns all auth users using the service role key (admin only, server-side)
// Also enriches each user with profile data from borrower_applications
export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const isPlaceholder = (val: string) =>
    val.startsWith('your-') || val === '' || val.includes('your-supabase-service-role-key');

  if (!supabaseUrl || !serviceRoleKey || isPlaceholder(serviceRoleKey)) {
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

    // Fetch all auth users — paginate if needed (max 1000 per page)
    const allUsers: { id: string; email: string; created_at: string }[] = [];
    let page = 1;
    const perPage = 1000;

    while (true) {
      const { data, error } = await adminClient.auth.admin.listUsers({
        page,
        perPage,
      });
      if (error) throw error;
      const users = data?.users ?? [];
      allUsers.push(
        ...users.map((u) => ({
          id: u.id,
          email: u.email ?? '',
          created_at: u.created_at,
        }))
      );
      if (users.length < perPage) break;
      page++;
    }

    // Fetch borrower profile data from borrower_applications
    // Get the most recent application per user_id to extract contact info
    const { data: borrowerProfiles } = await adminClient
      .from('borrower_applications')
      .select('user_id, first_name, last_name, phone, email')
      .not('user_id', 'is', null)
      .order('created_at', { ascending: false });

    // Build a map of user_id -> profile (first/most recent record wins)
    const profileMap = new Map<string, { first_name: string; last_name: string; phone: string }>();
    if (borrowerProfiles) {
      for (const profile of borrowerProfiles) {
        if (profile.user_id && !profileMap.has(profile.user_id)) {
          profileMap.set(profile.user_id, {
            first_name: profile.first_name || '',
            last_name: profile.last_name || '',
            phone: profile.phone || '',
          });
        }
      }
    }

    // Merge auth users with profile data
    const enrichedUsers = allUsers.map((u) => {
      const profile = profileMap.get(u.id);
      return {
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        first_name: profile?.first_name || '',
        last_name: profile?.last_name || '',
        phone: profile?.phone || '',
      };
    });

    return NextResponse.json({ users: enrichedUsers });
  } catch (err: unknown) {
    console.error('list-users error: service-role operation failed');
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }
}
