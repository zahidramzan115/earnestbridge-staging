import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/server/adminAuth';
import {
  validateServerEnv,
  createServiceRoleClient,
  normalizeEmail,
  findUserByEmail,
  writeAuditLog,
} from '@/lib/server/adminUsers';

// POST /api/admin/admin-users/grant
// SuperAdmin-only. Accepts email only. Grants Admin access to an existing Auth user.
// Does NOT send an invitation email.
export async function POST(request: NextRequest) {
  // 1. Require SuperAdmin
  const caller = await requireSuperAdmin();
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Validate server environment
  let supabaseUrl: string | undefined;
  let serviceRoleKey: string | undefined;
  try {
    ({ supabaseUrl, serviceRoleKey } = validateServerEnv());
  } catch {
    return NextResponse.json(
      { error: 'Required server environment variable is not configured.' },
      { status: 503 }
    );
  }

  // 3. Parse and validate JSON body — accept email only
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

  // Enforce exact allowed keys: only 'email' is permitted.
  const allowedKeys = new Set(['email']);
  const extraKeys = Object.keys(rawBody).filter((k) => !allowedKeys.has(k));
  if (extraKeys.length > 0) {
    return NextResponse.json(
      { error: 'Unexpected fields in request body.' },
      { status: 400 }
    );
  }

  // 4. Normalize and validate email
  const email = normalizeEmail(rawBody.email);
  if (!email) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 422 });
  }

  // 5. Create service-role client
  const adminClient = createServiceRoleClient(supabaseUrl as string, serviceRoleKey as string);

  // 6. Find exact Auth user by email via paginated listUsers
  let targetUser;
  try {
    targetUser = await findUserByEmail(adminClient, email);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'An error occurred.';
    // Multiple matches is a data integrity issue — fail safely
    if (msg.includes('Multiple')) {
      return NextResponse.json({ error: 'Multiple accounts found. Contact support.' }, { status: 500 });
    }
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }

  // 7. Zero matches → 404
  if (!targetUser) {
    return NextResponse.json(
      { error: 'No Auth user found with this email address.' },
      { status: 404 }
    );
  }

  // 8. Reject if already Admin
  if (targetUser.app_metadata?.role === 'admin') {
    return NextResponse.json(
      { error: 'User is already an Admin.' },
      { status: 409 }
    );
  }

  // 9. Read current app_metadata and build complete desired metadata
  const currentMeta = targetUser.app_metadata ?? {};
  const previousRole = currentMeta.role ?? null;
  const previousIsSuperAdmin = currentMeta.is_superadmin ?? null;

  const nextMeta = {
    ...currentMeta,
    role: 'admin',
    is_superadmin: false,
  };

  // 10. Update the user server-side
  const { data: updateData, error: updateError } = await adminClient.auth.admin.updateUserById(
    targetUser.id,
    { app_metadata: nextMeta }
  );

  if (updateError || !updateData?.user) {
    console.error('[admin-users grant] updateUserById failed');
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }

  // 11. Verify returned metadata
  const returnedMeta = updateData.user.app_metadata ?? {};
  if (returnedMeta.role !== 'admin' || returnedMeta.is_superadmin !== false) {
    console.error('[admin-users grant] metadata verification failed');
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }

  // 12. Write audit log — only after Auth operation succeeded and was verified
  const auditLogged = await writeAuditLog(adminClient, {
    adminId: caller.id,
    adminEmail: caller.email ?? '',
    eventType: 'edit',
    resourceType: 'admin_user',
    resourceId: targetUser.id,
    description: `Admin access granted to ${email}`,
    oldValue: { role: previousRole, is_superadmin: previousIsSuperAdmin },
    newValue: { role: 'admin', is_superadmin: false },
  });

  // 13. Return success — grant MUST NOT send an invitation email (no inviteUserByEmail called)
  return NextResponse.json({
    success: true,
    audit_logged: auditLogged,
  });
}
