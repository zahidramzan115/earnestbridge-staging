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

// GET /api/crm/deals/[id]/contacts — list contacts for a deal
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('crm_deal_contacts')
    .select(`
      id,
      role,
      created_at,
      crm_contacts(
        id, first_name, last_name, primary_email, phone,
        lead_status, portal_link_status, assigned_owner,
        crm_companies(id, company_name)
      )
    `)
    .eq('deal_id', id)
    .order('role', { ascending: true }); // primary first

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ contacts: data || [] });
}

// POST /api/crm/deals/[id]/contacts — associate a contact with a deal
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: dealId } = await params;
  const body = await request.json();
  const { contact_id, role = 'additional' } = body;

  if (!contact_id) {
    return NextResponse.json({ error: 'contact_id is required' }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Use the DB function to safely associate (handles primary demotion)
  const { data, error } = await supabase.rpc('associate_deal_with_contact', {
    p_deal_id: dealId,
    p_contact_id: contact_id,
    p_role: role,
    p_admin_actor: admin.email || 'Admin',
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (data && !data.success) return NextResponse.json({ error: data.error }, { status: 400 });

  return NextResponse.json({ success: true });
}

// DELETE /api/crm/deals/[id]/contacts — remove a contact from a deal
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: dealId } = await params;
  const { searchParams } = new URL(request.url);
  const contactId = searchParams.get('contact_id');

  if (!contactId) {
    return NextResponse.json({ error: 'contact_id query param required' }, { status: 400 });
  }

  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('remove_deal_contact', {
    p_deal_id: dealId,
    p_contact_id: contactId,
    p_admin_actor: admin.email || 'Admin',
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (data && !data.success) return NextResponse.json({ error: data.error }, { status: 400 });

  return NextResponse.json({ success: true });
}
