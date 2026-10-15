import 'server-only';

import { NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/server/adminAuth';
import {
  validateServerEnv,
  createServiceRoleClient,
} from '@/lib/server/adminUsers';
import type { User } from '@supabase/supabase-js';

// GET /api/admin/admin-users
// SuperAdmin-only. Returns only Admin/SuperAdmin users with safe fields.
export async function GET() {
  // 1. Require SuperAdmin
  const caller = await requireSuperAdmin();
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Validate server environment
  let supabaseUrl: string;
  let serviceRoleKey: string;
  try {
    ({ supabaseUrl, serviceRoleKey } = validateServerEnv());
  } catch {
    return NextResponse.json(
      { error: 'Required server environment variable is not configured.' },
      { status: 503 }
    );
  }

  // 3. Create service-role client
  const adminClient = createServiceRoleClient(supabaseUrl!, serviceRoleKey!);

  // 4. Paginate auth.admin.listUsers() and filter server-side to Admin users only
  try {
    const allAdminUsers: User[] = [];
    let page = 1;
    const perPage = 1000;

    while (true) {
      const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
      if (error) throw error;

      const users = data?.users ?? [];
      const adminUsers = users.filter(
        (u) => u.app_metadata?.role === 'admin'
      );
      allAdminUsers.push(...adminUsers);

      if (users.length < perPage) break;
      page++;
    }

    // 5. Return only safe fields — never return full app_metadata, tokens, identities, etc.
    const safeUsers = allAdminUsers.map((u) => ({
      id: u.id,
      email: u.email ?? '',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      role: 'admin' as const,
      is_superadmin: u.app_metadata?.is_superadmin === true,
    }));

    // 6. Sort: SuperAdmin first, then by email alphabetically
    safeUsers.sort((a, b) => {
      if (a.is_superadmin && !b.is_superadmin) return -1;
      if (!a.is_superadmin && b.is_superadmin) return 1;
      return (a.email ?? '').localeCompare(b.email ?? '');
    });

    return NextResponse.json({ users: safeUsers });
  } catch (err: unknown) {
    console.error('[admin-users GET] service-role operation failed');
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }
}
