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

// GET /api/crm/contacts/[id]
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supabase = getServiceClient();

  const { data: contact, error } = await supabase
    .from('crm_contacts')
    .select(`
      *,
      crm_companies(id, company_name, website, phone, city, state),
      crm_contact_emails(id, email, label, is_primary, source),
      crm_deal_contacts(
        id, role,
        borrower_applications(
          id, first_name, last_name, email, property_address, property_type,
          purchase_price, deposit_amount, due_diligence_days, app_status, created_at, submitted_at
        )
      )
    `)
    .eq('id', id)
    .is('crm_deal_contacts.borrower_applications.purged_at', null)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Drop deal-link rows whose Deal is purged (embedded filter nulls the Deal)
  if (Array.isArray((contact as any).crm_deal_contacts)) {
    (contact as any).crm_deal_contacts = (contact as any).crm_deal_contacts.filter(
      (dc: any) => dc.borrower_applications
    );
  }

  // Fetch activities
  const { data: activities } = await supabase
    .from('crm_activities')
    .select('*')
    .eq('contact_id', id)
    .order('created_at', { ascending: false })
    .limit(100);

  // Fetch tasks
  const { data: tasks } = await supabase
    .from('crm_tasks')
    .select('*')
    .eq('contact_id', id)
    .order('due_date', { ascending: true });

  // Fetch submissions
  const { data: submissions } = await supabase
    .from('crm_contact_submissions')
    .select('*')
    .eq('contact_id', id)
    .order('submitted_at', { ascending: false });

  return NextResponse.json({ contact, activities, tasks, submissions });
}

// PATCH /api/crm/contacts/[id]
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const supabase = getServiceClient();

  // Get current contact for activity logging
  const { data: current } = await supabase
    .from('crm_contacts')
    .select('lead_status, assigned_owner, portal_link_status')
    .eq('id', id)
    .single();

  const { data, error } = await supabase
    .from('crm_contacts')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log status change
  if (current && body.lead_status && body.lead_status !== current.lead_status) {
    await supabase.from('crm_activities').insert({
      contact_id: id,
      event_type: 'status_changed',
      title: `Status changed: ${current.lead_status} → ${body.lead_status}`,
      actor: admin.email || 'Admin',
      actor_user_id: admin.id,
    });
  }

  // Log owner change
  if (current && body.assigned_owner && body.assigned_owner !== current.assigned_owner) {
    await supabase.from('crm_activities').insert({
      contact_id: id,
      event_type: 'owner_assigned',
      title: `Owner changed: ${current.assigned_owner} → ${body.assigned_owner}`,
      actor: admin.email || 'Admin',
      actor_user_id: admin.id,
    });
  }

  // Log portal approval
  if (current && body.portal_link_status === 'approved' && current.portal_link_status !== 'approved') {
    await supabase.from('crm_activities').insert({
      contact_id: id,
      event_type: 'portal_access_approved',
      title: 'Portal access approved by Admin',
      actor: admin.email || 'Admin',
      actor_user_id: admin.id,
    });
    // Update portal_approved_at
    await supabase
      .from('crm_contacts')
      .update({ portal_approved_at: new Date().toISOString(), portal_approved_by: admin.id })
      .eq('id', id);
  }

  return NextResponse.json({ contact: data });
}

// DELETE /api/crm/contacts/[id] — soft delete via merge flag
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supabase = getServiceClient();

  const { error } = await supabase
    .from('crm_contacts')
    .update({ is_merged: true, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
