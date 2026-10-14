import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/server/adminAuth';
import {
  validateServerEnv,
  createServiceRoleClient,
  writeAuditLog,
} from '@/lib/server/adminUsers';

// UUID v4 validation regex
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/admin-users/revoke
// SuperAdmin-only. Accepts userId only. Sets role=null, is_superadmin=false.
// Does NOT delete the Auth account. Blocks self-revocation server-side.
export async function POST(request: NextRequest) {
  // 1. Require SuperAdmin — get caller for self-revocation check
  const caller = await requireSuperAdmin();
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Validate server environment
  let supabaseUrl: string = '';
  let serviceRoleKey: string = '';
  try {
    ({ supabaseUrl, serviceRoleKey } = validateServerEnv());
  } catch {
    return NextResponse.json(
      { error: 'Required server environment variable is not configured.' },
      { status: 503 }
    );
  }

  // 3. Parse and validate JSON body — accept userId only
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const rawBody = body as Record<string, unknown>;

  // Enforce exact allowed keys: only 'userId' is permitted.
  const allowedKeys = new Set(['userId']);
  const extraKeys = Object.keys(rawBody).filter((k) => !allowedKeys.has(k));
  if (extraKeys.length > 0) {
    return NextResponse.json(
      { error: 'Unexpected fields in request body.' },
      { status: 400 }
    );
  }

  // 4. Validate userId as UUID
  const userId = rawBody.userId;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return NextResponse.json(
      { error: 'A valid userId (UUID) is required.' },
      { status: 422 }
    );
  }

  // 5. MANDATORY server-side self-revocation block
  if (userId === caller.id) {
    return NextResponse.json(
      { error: 'Cannot revoke your own Admin access.' },
      { status: 403 }
    );
  }

  // 6. Create service-role client
  const adminClient = createServiceRoleClient(supabaseUrl, serviceRoleKey);

  // 7. Get target user by ID
  const { data: getUserData, error: getUserError } =
    await adminClient.auth.admin.getUserById(userId);

  if (getUserError || !getUserData?.user) {
    return NextResponse.json(
      { error: 'User not found.' },
      { status: 404 }
    );
  }

  const targetUser = getUserData.user;

  // 8. Verify target currently has Admin access
  if (targetUser.app_metadata?.role !== 'admin') {
    return NextResponse.json(
      { error: 'User does not have Admin access.' },
      { status: 409 }
    );
  }

  // 9. Read current app_metadata — preserve all unrelated keys
  const currentMeta = targetUser.app_metadata ?? {};
  const previousRole = currentMeta.role ?? null;
  const previousIsSuperAdmin = currentMeta.is_superadmin ?? false;
  const targetEmail = targetUser.email ?? userId;

  // 10. Build next metadata: set role=null and is_superadmin=false,
  //     preserve provider/providers and all other unrelated app_metadata keys
  const nextMeta = {
    ...currentMeta,
    role: null,
    is_superadmin: false,
  };

  // 11. Update the user server-side — do NOT deleteUser()
  const { data: updateData, error: updateError } =
    await adminClient.auth.admin.updateUserById(userId, {
      app_metadata: nextMeta,
    });

  if (updateError || !updateData?.user) {
    console.error('[admin-users revoke] updateUserById failed');
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }

  // 12. Verify returned metadata: role must not be 'admin', is_superadmin must not be true
  const returnedMeta = updateData.user.app_metadata ?? {};
  if (returnedMeta.role === 'admin' || returnedMeta.is_superadmin === true) {
    console.error('[admin-users revoke] metadata verification failed');
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }

  // 13. Write audit log — only after Auth operation succeeded and was verified
  const auditLogged = await writeAuditLog(adminClient, {
    adminId: caller.id,
    adminEmail: caller.email ?? '',
    eventType: 'edit',
    resourceType: 'admin_user',
    resourceId: userId,
    description: `Admin access revoked from ${targetEmail}`,
    oldValue: { role: previousRole, is_superadmin: previousIsSuperAdmin },
    newValue: { role: null, is_superadmin: false },
  });

  // 14. Return success
  return NextResponse.json({
    success: true,
    audit_logged: auditLogged,
  });
}
