import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function requireAdmin() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// POST /api/crm/contacts/merge
// Body: { target_id, source_id }
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { target_id, source_id } = await request.json();
  if (!target_id || !source_id) {
    return NextResponse.json({ error: 'target_id and source_id are required' }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Call the DB merge function
  const { data, error } = await supabase.rpc('merge_crm_contacts', {
    p_target_id: target_id,
    p_source_id: source_id,
    p_admin_actor: admin.email || 'Admin',
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result = data as { success: boolean; error?: string; target_id?: string };
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Merge failed' }, { status: 400 });
  }

  return NextResponse.json({ success: true, target_id: result.target_id });
}
