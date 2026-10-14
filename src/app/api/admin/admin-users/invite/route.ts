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

// POST /api/admin/admin-users/invite
// SuperAdmin-only. Accepts email only. Hardcodes role=admin, is_superadmin=false.
// Fail-closed: if metadata update fails after invite, returns partial-failure response.
export async function POST(request: NextRequest) {
  // 1. Require SuperAdmin
  const caller = await requireSuperAdmin();
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Validate server environment (invite also requires NEXT_PUBLIC_SITE_URL)
  let supabaseUrl: string;
  let serviceRoleKey: string;
  let siteUrl: string;
  try {
    const env = validateServerEnv(true);
    supabaseUrl = env.supabaseUrl;
    serviceRoleKey = env.serviceRoleKey;
    siteUrl = env.siteUrl!;
  } catch {
    return NextResponse.json(
      { error: 'Required server environment variable is not configured.' },
      { status: 503 }
    );
  }

  // 3. Parse and validate JSON body — accept email only, reject unexpected privilege fields
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
  const adminClient = createServiceRoleClient(supabaseUrl, serviceRoleKey);

  // 6. Check for existing Auth user with this exact email
  let existingUser;
  try {
    existingUser = await findUserByEmail(adminClient, email);
  } catch {
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }

  if (existingUser) {
    return NextResponse.json(
      {
        error: 'User already exists. Use Grant Admin Access instead.',
        action: 'grant',
      },
      { status: 409 }
    );
  }

  // 7. Construct trusted invite redirect URL — never accept redirectTo from the browser
  // Safely handle a trailing slash in NEXT_PUBLIC_SITE_URL
  const baseUrl = siteUrl.replace(/\/$/, '');
  const redirectTo = `${baseUrl}/auth/callback?next=/reset-password`;

  // 8. Send invitation — do NOT use the data option to set role (it sets user_metadata, not app_metadata)
  const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    { redirectTo }
  );

  if (inviteError || !inviteData?.user?.id) {
    console.error('[admin-users invite] inviteUserByEmail failed');
    return NextResponse.json({ error: 'An error occurred.' }, { status: 500 });
  }

  const invitedUser = inviteData.user;

  // 9. Read the invited user's CURRENT app_metadata and build next metadata
  const currentMeta = invitedUser.app_metadata ?? {};
  const nextMeta = {
    ...currentMeta,
    role: 'admin',
    is_superadmin: false,
  };

  // 10. Assign trusted Admin metadata via updateUserById
  const { data: updateData, error: updateError } = await adminClient.auth.admin.updateUserById(
    invitedUser.id,
    { app_metadata: nextMeta }
  );

  // 11. FAIL-CLOSED: if metadata update fails, do NOT delete the invited user.
  // The invited user has no Admin metadata and cannot access /admin.
  // SuperAdmin can use Grant Admin Access to complete setup.
  if (updateError || !updateData?.user) {
    console.error('[admin-users invite] updateUserById failed after invite — partial failure');
    return NextResponse.json(
      {
        success: false,
        partialFailure: true,
        email,
        error:
          'Invitation sent but Admin access could not be assigned. Use Grant Admin Access to complete setup.',
        action: 'grant',
      },
      { status: 500 }
    );
  }

  // 12. Verify returned metadata
  const returnedMeta = updateData.user.app_metadata ?? {};
  if (returnedMeta.role !== 'admin' || returnedMeta.is_superadmin !== false) {
    console.error('[admin-users invite] metadata verification failed after update');
    return NextResponse.json(
      {
        success: false,
        partialFailure: true,
        email,
        error:
          'Invitation sent but Admin access could not be verified. Use Grant Admin Access to complete setup.',
        action: 'grant',
      },
      { status: 500 }
    );
  }

  // 13. Write audit log — only after Auth operation succeeded and was verified
  const auditLogged = await writeAuditLog(adminClient, {
    adminId: caller.id,
    adminEmail: caller.email ?? '',
    eventType: 'create',
    resourceType: 'admin_user',
    resourceId: invitedUser.id,
    description: `Admin invitation sent to ${email}`,
    oldValue: null,
    newValue: { role: 'admin', is_superadmin: false },
  });

  // 14. Return success
  return NextResponse.json({
    success: true,
    userId: invitedUser.id,
    audit_logged: auditLogged,
  });
}
