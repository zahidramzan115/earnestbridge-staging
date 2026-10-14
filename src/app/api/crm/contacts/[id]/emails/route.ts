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

// POST /api/crm/contacts/[id]/emails — add alternate email
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { email, label = 'alternate' } = await request.json();
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  const supabase = getServiceClient();
  const normalizedEmail = email.toLowerCase().trim();

  // Check if email already belongs to another contact
  const { data: existing } = await supabase
    .from('crm_contacts')
    .select('id, first_name, last_name')
    .ilike('primary_email', normalizedEmail)
    .eq('is_merged', false)
    .neq('id', id)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      error: `This email is already the primary email of another contact: ${existing.first_name} ${existing.last_name}`,
      conflict_contact_id: existing.id,
    }, { status: 409 });
  }

  // Check alternate emails table
  const { data: existingAlt } = await supabase
    .from('crm_contact_emails')
    .select('id, contact_id')
    .ilike('email', normalizedEmail)
    .maybeSingle();

  if (existingAlt && existingAlt.contact_id !== id) {
    return NextResponse.json({
      error: 'This email is already associated with another contact',
      conflict_contact_id: existingAlt.contact_id,
    }, { status: 409 });
  }

  const { data, error } = await supabase
    .from('crm_contact_emails')
    .insert({ contact_id: id, email: normalizedEmail, label, is_primary: false })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log activity
  await supabase.from('crm_activities').insert({
    contact_id: id,
    event_type: 'alternate_email_added',
    title: `Alternate email added: ${normalizedEmail}`,
    actor: admin.email || 'Admin',
    actor_user_id: admin.id,
  });

  return NextResponse.json({ email: data });
}

// DELETE /api/crm/contacts/[id]/emails?email_id=xxx
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const emailId = searchParams.get('email_id');
  if (!emailId) return NextResponse.json({ error: 'email_id is required' }, { status: 400 });

  const supabase = getServiceClient();

  const { data: emailRecord } = await supabase
    .from('crm_contact_emails')
    .select('email')
    .eq('id', emailId)
    .eq('contact_id', id)
    .single();

  const { error } = await supabase
    .from('crm_contact_emails')
    .delete()
    .eq('id', emailId)
    .eq('contact_id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (emailRecord) {
    await supabase.from('crm_activities').insert({
      contact_id: id,
      event_type: 'alternate_email_removed',
      title: `Alternate email removed: ${emailRecord.email}`,
      actor: admin.email || 'Admin',
      actor_user_id: admin.id,
    });
  }

  return NextResponse.json({ success: true });
}

// PATCH /api/crm/contacts/[id]/emails — set primary
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { email_id } = await request.json();
  if (!email_id) return NextResponse.json({ error: 'email_id is required' }, { status: 400 });

  const supabase = getServiceClient();

  // Reset all to non-primary
  await supabase.from('crm_contact_emails').update({ is_primary: false }).eq('contact_id', id);
  // Set the selected one as primary
  const { error } = await supabase.from('crm_contact_emails').update({ is_primary: true }).eq('id', email_id).eq('contact_id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
