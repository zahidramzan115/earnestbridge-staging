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

  // 2. Validate contact id
  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Contact not found.' }, { status: 404 });
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

  // 4. Service-role client — fail closed (no anon fallback)
  let serviceClient;
  try {
    const env = validateServerEnv();
    serviceClient = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  } catch {
    return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 });
  }

  // 5. Load contact (including purged rows, for idempotency)
  const { data: contact, error: loadError } = await serviceClient
    .from('crm_contacts')
    .select('id, is_merged, purged_at')
    .eq('id', id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: 'Failed to load contact.' }, { status: 500 });
  }
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found.' }, { status: 404 });
  }

  // 6. Merged Contacts are historical merge state, not an active purge target
  if (contact.is_merged) {
    return NextResponse.json({ error: 'contact_already_merged' }, { status: 409 });
  }

  // 7. Idempotent replay — preserve original metadata, no audit
  if (contact.purged_at) {
    return NextResponse.json({ success: true, already_purged: true, id });
  }

  // 8. Purge mutation — only the three purge fields; guarded on purged_at IS NULL
  const purgedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await serviceClient
    .from('crm_contacts')
    .update({
      purged_at: purgedAt,
      purged_by: caller.id,
      purge_reason: purgeReason,
    })
    .eq('id', id)
    .eq('is_merged', false)
    .is('purged_at', null)
    .select('id')
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to purge contact.' }, { status: 500 });
  }
  if (!updated) {
    // Lost a race with a concurrent purge/merge — idempotent success, no audit
    return NextResponse.json({ success: true, already_purged: true, id });
  }

  // 9. Audit (non-fatal)
  await writeAuditLog(serviceClient, {
    adminId: caller.id,
    adminEmail: caller.email ?? '',
    eventType: 'edit',
    resourceType: 'crm_contact',
    resourceId: id,
    description: `Contact purged (hidden from Admin CRM): ${purgeReason}`,
    oldValue: { purged_at: null },
    newValue: {
      action: 'CONTACT_PURGED',
      contact_id: id,
      actor_user_id: caller.id,
      actor_email: caller.email ?? '',
      purge_reason: purgeReason,
      purged_at: purgedAt,
    },
  });

  return NextResponse.json({ success: true, already_purged: false, id, purged_at: purgedAt });
}
