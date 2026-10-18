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
    .eq('is_merged', false)
    .is('purged_at', null)
    .is('crm_deal_contacts.borrower_applications.purged_at', null)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Missing, merged or purged Contacts are all a plain 404 (no purge disclosure)
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

// Fields the active Contact UI sends through PATCH /api/crm/contacts/[id].
// Callers (ContactDetailContent): handleStatusChange -> { lead_status },
// handleOwnerChange -> { assigned_owner }. Everything else is rejected.
const PATCH_ALLOWED_FIELDS = ['lead_status', 'assigned_owner'] as const;
type PatchAllowedField = (typeof PATCH_ALLOWED_FIELDS)[number];

// PATCH /api/crm/contacts/[id]
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request_body' }, { status: 400 });
  }
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return NextResponse.json({ error: 'invalid_request_body' }, { status: 400 });
  }

  const incoming = rawBody as Record<string, unknown>;
  const keys = Object.keys(incoming);
  if (keys.length === 0) {
    return NextResponse.json({ error: 'no_fields_provided' }, { status: 400 });
  }
  const hasDisallowed = keys.some(
    (k) => !(PATCH_ALLOWED_FIELDS as readonly string[]).includes(k)
  );
  if (hasDisallowed) {
    return NextResponse.json({ error: 'field_not_allowed' }, { status: 400 });
  }

  const body: Partial<Record<PatchAllowedField, string>> = {};
  for (const key of PATCH_ALLOWED_FIELDS) {
    if (key in incoming) {
      const value = incoming[key];
      if (typeof value !== 'string') {
        return NextResponse.json({ error: 'invalid_field_value' }, { status: 400 });
      }
      body[key] = value;
    }
  }

  const supabase = getServiceClient();

  // Get current contact for activity logging
  const { data: current } = await supabase
    .from('crm_contacts')
    .select('lead_status, assigned_owner')
    .eq('id', id)
    .eq('is_merged', false)
    .is('purged_at', null)
    .single();

  const { data, error } = await supabase
    .from('crm_contacts')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('is_merged', false)
    .is('purged_at', null)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Missing, merged or purged Contacts are a plain 404
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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

  return NextResponse.json({ contact: data });
}

// DELETE /api/crm/contacts/[id] — retired. Performs no database mutation.
// Contact merging is handled exclusively by POST /api/crm/contacts/merge.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return NextResponse.json({ error: 'contact_delete_retired' }, { status: 410 });
}
