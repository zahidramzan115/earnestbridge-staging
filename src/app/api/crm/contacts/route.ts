import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { findContactIdByNormalizedEmail } from '@/lib/server/crmContactMatch';

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function getAuthClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}

async function requireAdmin() {
  const supabase = await getAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// GET /api/crm/contacts — list contacts with filters
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || '';
  const owner = searchParams.get('owner') || '';
  const portalStatus = searchParams.get('portal_status') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = (page - 1) * limit;

  const supabase = getServiceClient();

  let query = supabase
    .from('crm_contacts')
    .select(`
      *,
      crm_companies(id, company_name),
      crm_deal_contacts(count)
    `, { count: 'exact' })
    .eq('is_merged', false)
    .is('purged_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,primary_email.ilike.%${search}%,phone.ilike.%${search}%`
    );
  }
  if (status) query = query.eq('lead_status', status);
  if (owner) query = query.eq('assigned_owner', owner);
  if (portalStatus) query = query.eq('portal_link_status', portalStatus);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ contacts: data, total: count, page, limit });
}

// POST /api/crm/contacts — create contact
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const supabase = getServiceClient();

  const normalizedEmail = body.primary_email?.toLowerCase().trim();
  if (!normalizedEmail) {
    return NextResponse.json({ error: 'primary_email is required' }, { status: 400 });
  }

  // Check for duplicate — exact normalized-email RPC. Includes PURGED Contacts
  // (so a new active Contact can't duplicate a purged one) and excludes merged.
  // Admin-created Contacts never auto-restore a purged Contact.
  let existingId: string | null = null;
  try {
    existingId = await findContactIdByNormalizedEmail(supabase, normalizedEmail);
  } catch (matchErr) {
    console.error('[CRM] Duplicate email check failed:', matchErr);
    return NextResponse.json({ error: 'Failed to check for existing contact' }, { status: 500 });
  }

  if (existingId) {
    return NextResponse.json({ error: 'A contact with this email already exists', existingId }, { status: 409 });
  }

  const { data, error } = await supabase
    .from('crm_contacts')
    .insert({ ...body, primary_email: normalizedEmail })
    .select()
    .single();

  if (error && error.code === '23505') {
    return NextResponse.json({ error: 'A contact with this email already exists' }, { status: 409 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log activity
  await supabase.from('crm_activities').insert({
    contact_id: data.id,
    event_type: 'contact_created',
    title: 'Contact created by Admin',
    actor: admin.email || 'Admin',
    actor_user_id: admin.id,
  });

  return NextResponse.json({ contact: data });
}
