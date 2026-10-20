import { NextRequest, NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/server/adminAuth';
import {
  validateServerEnv,
  createServiceRoleClient,
  writeAuditLog,
} from '@/lib/server/adminUsers';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 2000;

// Canonical TARGET statuses. Legacy values (submitted, in_progress, draft,
// in_review, conditionally_approved, expired) may be a PREVIOUS status but
// can never be requested as a new target.
const CANONICAL_STATUSES = [
  'application',
  'under_review',
  'approved',
  'rejected',
  'dead',
  'funded',
  'closed',
] as const;
type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

const STATUS_LABELS: Record<CanonicalStatus, string> = {
  application: 'Application Submitted',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  dead: 'Dead',
  funded: 'Funded',
  closed: 'Closed',
};

function labelFor(status: string): string {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // 1. Authenticate (401) and authorize Admin (403) BEFORE any service-role use
  const auth = await checkAdmin();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'Unauthorized.' : 'Forbidden.' },
      { status: auth.status }
    );
  }
  const caller = auth.user;

  // 2. Validate deal id
  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  // 3. Validate body — only { status, note? } allowed
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((k) => k !== 'status' && k !== 'note')) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const rawStatus = record.status;
  if (
    typeof rawStatus !== 'string' ||
    !(CANONICAL_STATUSES as readonly string[]).includes(rawStatus)
  ) {
    return NextResponse.json(
      {
        error: `Invalid status. Allowed values: ${CANONICAL_STATUSES.join(', ')}.`,
      },
      { status: 400 }
    );
  }
  const newStatus = rawStatus as CanonicalStatus;

  let note: string | null = null;
  if (record.note !== undefined && record.note !== null) {
    if (typeof record.note !== 'string') {
      return NextResponse.json({ error: 'Invalid note.' }, { status: 400 });
    }
    const trimmed = record.note.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) {
      return NextResponse.json(
        { error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` },
        { status: 400 }
      );
    }
    note = trimmed.length > 0 ? trimmed : null;
  }

  // 4. Service-role client (server-only, fail closed — no anon fallback)
  let serviceClient;
  try {
    const env = validateServerEnv();
    serviceClient = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  } catch {
    return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 });
  }

  // 5. Load deal
  const { data: deal, error: loadError } = await serviceClient
    .from('borrower_applications')
    .select('id, user_id, app_status, deal_workflow_stage, purged_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: 'Failed to load deal.' }, { status: 500 });
  }
  if (!deal || deal.purged_at) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  const previousStatus = String(deal.app_status);

  // 6. Idempotent same-status no-op — no update, no activity, no audit
  if (previousStatus === newStatus) {
    return NextResponse.json({
      success: true,
      id,
      status: previousStatus,
      previousStatus,
      updatedAt: deal.updated_at ?? null,
      changed: false,
    });
  }

  // 7. Conditional update with concurrency protection.
  // Only app_status is written; updated_at is maintained by the existing
  // borrower_applications_updated_at BEFORE UPDATE trigger.
  const { data: updated, error: updateError } = await serviceClient
    .from('borrower_applications')
    .update({ app_status: newStatus })
    .eq('id', id)
    .eq('app_status', previousStatus)
    .is('purged_at', null)
    .select('id, app_status, updated_at')
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update deal status.' }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      {
        error:
          'Deal status was changed concurrently by another update. Please refresh and try again.',
        code: 'STATUS_CONFLICT',
      },
      { status: 409 }
    );
  }

  const updatedAt: string | null = updated.updated_at ?? null;
  const changedAt = updatedAt ?? new Date().toISOString();
  const adminEmail = caller.email ?? '';
  const actorLabel = adminEmail || caller.id;

  // 8. Application activity (one entry; best-effort, does not roll back status)
  try {
    const { error: activityError } = await serviceClient.from('application_activity').insert({
      application_id: id,
      user_id: deal.user_id ?? null,
      event_type: 'status_change',
      title: `Status changed to ${labelFor(newStatus)}`,
      detail:
        note ??
        `Status changed from ${labelFor(previousStatus)} to ${labelFor(newStatus)} by ${actorLabel}.`,
      actor: actorLabel,
      metadata: {
        previous_status: previousStatus,
        new_status: newStatus,
        admin_id: caller.id,
        admin_email: adminEmail,
        note,
        changed_at: changedAt,
      },
    });
    if (activityError) {
      console.error('[deal-status] application_activity insert failed (non-fatal):', activityError.message);
    }
  } catch {
    console.error('[deal-status] application_activity insert threw (non-fatal)');
  }

  // 9. Audit log (one entry; non-fatal). Helper supports 'create' | 'edit' only.
  await writeAuditLog(serviceClient, {
    adminId: caller.id,
    adminEmail,
    eventType: 'edit',
    resourceType: 'borrower_application',
    resourceId: id,
    description: `Deal status changed from ${labelFor(previousStatus)} to ${labelFor(newStatus)}`,
    oldValue: { app_status: previousStatus },
    newValue: { app_status: newStatus, note },
  });

  return NextResponse.json({
    success: true,
    id,
    status: newStatus,
    previousStatus,
    updatedAt,
    changed: true,
  });
}
