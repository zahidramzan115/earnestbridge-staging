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

// GET /api/crm/tasks
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const view = searchParams.get('view') || 'all';
  const assignedTo = searchParams.get('assigned_to') || '';

  const supabase = getServiceClient();
  const today = new Date().toISOString().split('T')[0];

  let query = supabase
    .from('crm_tasks')
    .select(`
      *,
      crm_contacts(id, first_name, last_name, primary_email),
      crm_companies(id, company_name)
    `)
    .order('due_date', { ascending: true, nullsFirst: false });

  if (assignedTo) query = query.eq('assigned_to', assignedTo);

  switch (view) {
    case 'due_today':
      query = query.eq('due_date', today).eq('task_status', 'Open');
      break;
    case 'overdue':
      query = query.lt('due_date', today).eq('task_status', 'Open');
      break;
    case 'upcoming':
      query = query.gte('due_date', today).eq('task_status', 'Open');
      break;
    case 'completed':
      query = query.eq('task_status', 'Completed');
      break;
    case 'unassigned':
      query = query.eq('assigned_to', 'Unassigned').eq('task_status', 'Open');
      break;
    default:
      query = query.neq('task_status', 'Cancelled');
  }

  const { data, error } = await query.limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ tasks: data });
}

// POST /api/crm/tasks
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('crm_tasks')
    .insert({ ...body, created_by: admin.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log activity on contact if linked
  if (data.contact_id) {
    await supabase.from('crm_activities').insert({
      contact_id: data.contact_id,
      event_type: 'task_created',
      title: `Task created: ${data.title}`,
      detail: data.due_date ? `Due: ${data.due_date}` : undefined,
      actor: admin.email || 'Admin',
      actor_user_id: admin.id,
    });
  }

  return NextResponse.json({ task: data });
}

// PATCH /api/crm/tasks/[id] — handled inline via query param for simplicity
export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const body = await request.json();
  const supabase = getServiceClient();

  const updates: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() };
  if (body.task_status === 'Completed' && !body.completed_at) {
    updates.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('crm_tasks')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ task: data });
}
