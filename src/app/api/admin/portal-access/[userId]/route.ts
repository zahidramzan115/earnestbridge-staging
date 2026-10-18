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
  context: { params: Promise<{ userId: string }> }
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

  // 2. Validate target user id
  const { userId } = await context.params;
  if (!userId || !UUID_RE.test(userId)) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  // 3. Validate body — only { disabled, reason } allowed
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
  if (Object.keys(record).some((k) => k !== 'disabled' && k !== 'reason')) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (typeof record.disabled !== 'boolean') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const disabled = record.disabled;

  let reason = '';
  if (record.reason !== undefined && record.reason !== null) {
    if (typeof record.reason !== 'string') {
      return NextResponse.json({ error: 'Invalid reason.' }, { status: 400 });
    }
    reason = record.reason.trim();
    if (reason.length > MAX_REASON_LENGTH) {
      return NextResponse.json(
        { error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer.` },
        { status: 400 }
      );
    }
  }
  if (disabled && !reason) {
    return NextResponse.json({ error: 'A reason is required to disable portal access.' }, { status: 400 });
  }

  // 4. Service-role client — fail closed (no anon fallback)
  let serviceClient;
  try {
    const env = validateServerEnv();
    serviceClient = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  } catch {
    return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 });
  }

  // 5. Load current state for idempotency
  const { data: existing, error: loadError } = await serviceClient
    .from('borrower_access')
    .select('user_id, is_disabled')
    .eq('user_id', userId)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: 'Failed to load portal access.' }, { status: 500 });
  }

  const currentlyDisabled = existing?.is_disabled === true;
  const nowIso = new Date().toISOString();

  if (disabled) {
    // DISABLE — idempotent: preserve original disable metadata, no audit
    if (currentlyDisabled) {
      return NextResponse.json({ success: true, already_disabled: true, user_id: userId, is_disabled: true });
    }

    const { error: upsertError } = await serviceClient.from('borrower_access').upsert(
      {
        user_id: userId,
        is_disabled: true,
        disabled_at: nowIso,
        disabled_by: caller.id,
        disabled_reason: reason,
      },
      { onConflict: 'user_id' }
    );
    if (upsertError) {
      return NextResponse.json({ error: 'Failed to update portal access.' }, { status: 500 });
    }

    await writeAuditLog(serviceClient, {
      adminId: caller.id,
      adminEmail: caller.email ?? '',
      eventType: 'edit',
      resourceType: 'borrower_access',
      resourceId: userId,
      description: `Client Portal access revoked: ${reason}`,
      oldValue: { is_disabled: false },
      newValue: {
        action: 'PORTAL_ACCESS_REVOKED',
        user_id: userId,
        actor_user_id: caller.id,
        actor_email: caller.email ?? '',
        reason,
        timestamp: nowIso,
      },
    });

    return NextResponse.json({ success: true, already_disabled: false, user_id: userId, is_disabled: true });
  }

  // REINSTATE — idempotent: no row or already active => safe success, no audit
  if (!currentlyDisabled) {
    return NextResponse.json({ success: true, already_active: true, user_id: userId, is_disabled: false });
  }

  const { error: reinstateError } = await serviceClient
    .from('borrower_access')
    .update({
      is_disabled: false,
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
    })
    .eq('user_id', userId);
  if (reinstateError) {
    return NextResponse.json({ error: 'Failed to update portal access.' }, { status: 500 });
  }

  await writeAuditLog(serviceClient, {
    adminId: caller.id,
    adminEmail: caller.email ?? '',
    eventType: 'edit',
    resourceType: 'borrower_access',
    resourceId: userId,
    description: `Client Portal access reinstated${reason ? `: ${reason}` : ''}`,
    oldValue: { is_disabled: true },
    newValue: {
      action: 'PORTAL_ACCESS_REINSTATED',
      user_id: userId,
      actor_user_id: caller.id,
      actor_email: caller.email ?? '',
      reason: reason || null,
      timestamp: nowIso,
    },
  });

  return NextResponse.json({ success: true, already_active: false, user_id: userId, is_disabled: false });
}
