import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ── Auth helpers ──────────────────────────────────────────────────────────────

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

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

/**
 * requireAdmin — SECURITY CRITICAL
 *
 * Authorization relies ONLY on app_metadata.role === 'admin'.
 * app_metadata is server-controlled (service role / Supabase dashboard only).
 *
 * user_metadata is user-controlled and MUST NOT be used for privilege decisions.
 * Do NOT add user_metadata.role, query parameter role, or request body role here.
 */
async function requireAdmin() {
  const supabase = await getAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  // ONLY trust app_metadata — never user_metadata
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// ── Enum validation ───────────────────────────────────────────────────────────

const VALID_DEADLINE_TYPES = ['emd_due', 'document_due', 'funding', 'option', 'inspection', 'custom'] as const;
const VALID_RESPONSIBLE_PARTIES = ['client', 'earnestbridge', 'third_party'] as const;
const VALID_STATUSES = ['open', 'completed', 'cancelled'] as const;
const VALID_ACTIONS = ['complete', 'cancel', 'reopen'] as const;

type DeadlineType = typeof VALID_DEADLINE_TYPES[number];
type ResponsibleParty = typeof VALID_RESPONSIBLE_PARTIES[number];

function isValidDeadlineType(v: unknown): v is DeadlineType {
  return VALID_DEADLINE_TYPES.includes(v as DeadlineType);
}
function isValidResponsibleParty(v: unknown): v is ResponsibleParty {
  return VALID_RESPONSIBLE_PARTIES.includes(v as ResponsibleParty);
}

// ── Activity logger ───────────────────────────────────────────────────────────

async function logActivity(
  applicationId: string,
  userId: string | null,
  eventType: string,
  title: string,
  detail: string,
  actor: string
) {
  const supabase = getServiceClient();
  try {
    await supabase.from('application_activity').insert({
      application_id: applicationId,
      user_id: userId,
      event_type: eventType,
      title,
      detail,
      actor,
    });
  } catch (_) {
    // Activity logging is best-effort; never fail the main operation
  }
}

// ── GET /api/admin/deadlines?application_id=xxx ───────────────────────────────

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const applicationId = searchParams.get('application_id');
  if (!applicationId) return NextResponse.json({ error: 'application_id required' }, { status: 400 });

  const supabase = getServiceClient();

  // Purged Deals are not active — return no deadlines
  const { data: parentDeal } = await supabase
    .from('borrower_applications')
    .select('id')
    .eq('id', applicationId)
    .is('purged_at', null)
    .maybeSingle();
  if (!parentDeal) return NextResponse.json({ deadlines: [] });

  const { data, error } = await supabase
    .from('crm_deal_deadlines')
    .select('*')
    .eq('application_id', applicationId)
    .order('due_date', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deadlines: data });
}

// ── POST /api/admin/deadlines — create ────────────────────────────────────────

export async function POST(request: Request) {
  // Step 1: authenticate
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Step 2: parse and validate request
  const body = await request.json();
  const { application_id, title, deadline_type, due_date, responsible_party, client_visible, notes } = body;

  if (!application_id || !title || !deadline_type || !due_date || !responsible_party) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Validate enum values before hitting the database
  if (!isValidDeadlineType(deadline_type)) {
    return NextResponse.json(
      { error: `Invalid deadline_type. Allowed: ${VALID_DEADLINE_TYPES.join(', ')}` },
      { status: 422 }
    );
  }
  if (!isValidResponsibleParty(responsible_party)) {
    return NextResponse.json(
      { error: `Invalid responsible_party. Allowed: ${VALID_RESPONSIBLE_PARTIES.join(', ')}` },
      { status: 422 }
    );
  }

  // Step 3: verify application_id refers to a real Deal (prevent FK errors leaking)
  const supabase = getServiceClient();
  const { data: app, error: appError } = await supabase
    .from('borrower_applications')
    .select('id, user_id')
    .eq('id', application_id)
    .is('purged_at', null)
    .single();

  if (appError || !app) {
    return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
  }

  // Step 4: perform service-role write (after auth + authz + validation)
  const { data, error } = await supabase
    .from('crm_deal_deadlines')
    .insert({
      application_id,
      title,
      deadline_type,
      due_date,
      responsible_party,
      client_visible: client_visible ?? false,
      notes: notes || null,
      created_by: admin.id,
      status: 'open',
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log activity — no internal notes in activity detail
  const dueDateFormatted = formatDateForActivity(due_date);
  await logActivity(
    application_id,
    app.user_id ?? null,
    'deadline_created',
    `Deadline added: ${title}`,
    `${title} — ${dueDateFormatted}`,
    admin.email || 'EarnestBridge Admin'
  );

  return NextResponse.json({ deadline: data });
}

// ── PATCH /api/admin/deadlines?id=xxx — update / complete / cancel / reopen ──

export async function PATCH(request: Request) {
  // Step 1: authenticate
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // Step 2: validate request
  const body = await request.json();
  const { action, ...fields } = body;

  // Reject unknown action strings
  if (action !== undefined && !VALID_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `Invalid action. Allowed: ${VALID_ACTIONS.join(', ')}` },
      { status: 422 }
    );
  }

  // Step 3: fetch current deadline — application_id is ALWAYS derived from the row
  const supabase = getServiceClient();
  const { data: current, error: fetchError } = await supabase
    .from('crm_deal_deadlines')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !current) {
    return NextResponse.json({ error: 'Deadline not found' }, { status: 404 });
  }

  // Derive application_id from the deadline row — never trust browser-supplied value
  const applicationId: string = current.application_id;

  // Fetch application user_id for activity logging (server-derived)
  const { data: app } = await supabase
    .from('borrower_applications')
    .select('user_id')
    .eq('id', applicationId)
    .single();

  let updates: Record<string, unknown> = {};
  let eventType = 'deadline_updated';
  let activityTitle = `Deadline updated: ${current.title}`;
  let activityDetail = current.title;

  if (action === 'complete') {
    // Lifecycle: complete is only allowed from 'open'
    if (current.status !== 'open') {
      return NextResponse.json(
        { error: `Cannot complete a deadline with status '${current.status}'. Only open deadlines can be completed.` },
        { status: 409 }
      );
    }
    updates = {
      status: 'completed',
      completed_at: new Date().toISOString(),
      completed_by: admin.id,
    };
    eventType = 'deadline_completed';
    activityTitle = `Deadline completed: ${current.title}`;
    activityDetail = `${current.title} — marked complete`;

  } else if (action === 'cancel') {
    // Lifecycle: cancel is only allowed from 'open'
    if (current.status !== 'open') {
      return NextResponse.json(
        { error: `Cannot cancel a deadline with status '${current.status}'. Only open deadlines can be cancelled.` },
        { status: 409 }
      );
    }
    updates = { status: 'cancelled' };
    eventType = 'deadline_cancelled';
    activityTitle = `Deadline cancelled: ${current.title}`;
    activityDetail = `${current.title} — cancelled`;

  } else if (action === 'reopen') {
    // Lifecycle: reopen is only allowed from 'completed' or 'cancelled'
    if (current.status !== 'completed' && current.status !== 'cancelled') {
      return NextResponse.json(
        { error: `Cannot reopen a deadline with status '${current.status}'. Only completed or cancelled deadlines can be reopened.` },
        { status: 409 }
      );
    }
    updates = {
      status: 'open',
      completed_at: null,
      completed_by: null,
    };
    eventType = 'deadline_reopened';
    activityTitle = `Deadline reopened: ${current.title}`;
    activityDetail = `${current.title} — reopened`;

  } else {
    // General field edit — only allowed when status is 'open'
    if (current.status !== 'open') {
      return NextResponse.json(
        {
          error: `Cannot edit a deadline with status '${current.status}'. Only open deadlines can be edited. Use the reopen action first.`,
        },
        { status: 409 }
      );
    }

    // Validate enum fields if provided
    if ('deadline_type' in fields && !isValidDeadlineType(fields.deadline_type)) {
      return NextResponse.json(
        { error: `Invalid deadline_type. Allowed: ${VALID_DEADLINE_TYPES.join(', ')}` },
        { status: 422 }
      );
    }
    if ('responsible_party' in fields && !isValidResponsibleParty(fields.responsible_party)) {
      return NextResponse.json(
        { error: `Invalid responsible_party. Allowed: ${VALID_RESPONSIBLE_PARTIES.join(', ')}` },
        { status: 422 }
      );
    }

    const allowedFields = ['title', 'deadline_type', 'due_date', 'responsible_party', 'client_visible', 'notes'];
    for (const key of allowedFields) {
      if (key in fields) {
        updates[key] = fields[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const newTitle = (updates.title as string) || current.title;
    const newDue = (updates.due_date as string) || current.due_date;
    activityTitle = `Deadline updated: ${newTitle}`;
    activityDetail = `${newTitle} — ${formatDateForActivity(newDue)}`;
  }

  // Step 4: perform service-role write (after auth + authz + validation)
  const { data, error } = await supabase
    .from('crm_deal_deadlines')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log activity — application_id is server-derived from the deadline row
  // Internal notes are never included in activity detail
  await logActivity(
    applicationId,
    app?.user_id ?? null,
    eventType,
    activityTitle,
    activityDetail,
    admin.email || 'EarnestBridge Admin'
  );

  return NextResponse.json({ deadline: data });
}

// ── DELETE /api/admin/deadlines?id=xxx — admin cleanup only ──────────────────

export async function DELETE(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = getServiceClient();

  // Fetch deadline first — derive application_id from the row
  const { data: current } = await supabase
    .from('crm_deal_deadlines')
    .select('application_id, title')
    .eq('id', id)
    .single();

  const { error } = await supabase
    .from('crm_deal_deadlines')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (current) {
    const { data: app } = await supabase
      .from('borrower_applications')
      .select('user_id')
      .eq('id', current.application_id)
      .single();

    await logActivity(
      current.application_id,
      app?.user_id ?? null,
      'deadline_cancelled',
      `Deadline deleted: ${current.title}`,
      `${current.title} — permanently deleted by admin`,
      admin.email || 'EarnestBridge Admin'
    );
  }

  return NextResponse.json({ success: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateForActivity(dateStr: string): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('T')[0].split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}
