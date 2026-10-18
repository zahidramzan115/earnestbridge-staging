import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSuperAdmin } from '@/lib/server/adminAuth';
import {
  validateServerEnv,
  createServiceRoleClient,
  writeAuditLog,
} from '@/lib/server/adminUsers';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 1000;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // 1. Authenticate (401) then authorize SuperAdmin (403)
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const caller = await requireSuperAdmin();
  if (!caller) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }

  // 2. Validate deal id
  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  // 3. Validate body — only purge_reason is allowed
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((k) => k !== 'purge_reason')) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const rawReason = (body as Record<string, unknown>).purge_reason;
  if (typeof rawReason !== 'string') {
    return NextResponse.json({ error: 'A purge reason is required.' }, { status: 400 });
  }
  const purgeReason = rawReason.trim();
  if (!purgeReason) {
    return NextResponse.json({ error: 'A purge reason is required.' }, { status: 400 });
  }
  if (purgeReason.length > MAX_REASON_LENGTH) {
    return NextResponse.json(
      { error: `Purge reason must be ${MAX_REASON_LENGTH} characters or fewer.` },
      { status: 400 }
    );
  }

  // 4. Service-role client
  let serviceClient;
  try {
    const env = validateServerEnv();
    serviceClient = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  } catch {
    return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 });
  }

  // 5. Load deal (including purged rows, for idempotency)
  const { data: deal, error: loadError } = await serviceClient
    .from('borrower_applications')
    .select('id, purged_at')
    .eq('id', id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: 'Failed to load deal.' }, { status: 500 });
  }
  if (!deal) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  // 6. Idempotent replay — do not alter metadata, no audit
  if (deal.purged_at) {
    return NextResponse.json({ success: true, already_purged: true, id });
  }

  // 7. Purge mutation — only the three purge fields; guarded on purged_at IS NULL
  const purgedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await serviceClient
    .from('borrower_applications')
    .update({
      purged_at: purgedAt,
      purged_by: caller.id,
      purge_reason: purgeReason,
    })
    .eq('id', id)
    .is('purged_at', null)
    .select('id')
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to purge deal.' }, { status: 500 });
  }
  if (!updated) {
    // Lost a race with a concurrent purge — treat as idempotent success, no audit
    return NextResponse.json({ success: true, already_purged: true, id });
  }

  // 8. Audit (non-fatal)
  await writeAuditLog(serviceClient, {
    adminId: caller.id,
    adminEmail: caller.email ?? '',
    eventType: 'edit',
    resourceType: 'borrower_application',
    resourceId: id,
    description: `Deal purged (hidden from Admin and Client views): ${purgeReason}`,
    oldValue: { purged_at: null },
    newValue: {
      action: 'DEAL_PURGED',
      application_id: id,
      actor_user_id: caller.id,
      actor_email: caller.email ?? '',
      purge_reason: purgeReason,
      purged_at: purgedAt,
    },
  });

  return NextResponse.json({ success: true, already_purged: false, id, purged_at: purgedAt });
}
