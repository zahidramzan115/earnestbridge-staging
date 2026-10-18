import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

// ============================================================
// Admin Deal Owner Update API
// PATCH /api/admin/update-deal-owner
//
// SECURITY MODEL:
//   1. Authenticates the session via SSR Supabase client
//   2. Verifies the caller is an EarnestBridge Admin
//      (raw_app_meta_data->>'role' = 'admin')
//   3. Validates the new owner value against the canonical list
//   4. Updates borrower_applications.eb_assigned_owner using
//      the service-role client (bypasses RLS safely because
//      authorization is already enforced above)
//   5. Logs an owner_assigned activity entry with previous
//      owner context — identical to Deal Detail behavior
//
// UI visibility is NOT authorization.
// ============================================================

// ─── Canonical owner values ───────────────────────────────────────────────────
const VALID_OWNERS = ['Eric', 'Dan', 'Tucker'] as const;
type ValidOwner = (typeof VALID_OWNERS)[number];

// ─── Admin email → display name mapping ──────────────────────────────────────
const ADMIN_EMAIL_MAP: Record<string, string> = {
  'admin@earnestbridge.com': 'Eric',
  'deals@earnestbridge.com': 'Dan',
  'legal@earnestbridge.com': 'Tucker',
};
const ADMIN_EMAILS = new Set(Object.keys(ADMIN_EMAIL_MAP));

export async function PATCH(req: NextRequest) {
  // ── 1. Parse request body ──────────────────────────────────────────────────
  let body: { applicationId?: string; newOwner?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { applicationId, newOwner } = body;

  if (!applicationId || typeof applicationId !== 'string') {
    return NextResponse.json({ error: 'applicationId is required.' }, { status: 400 });
  }

  // newOwner must be one of the canonical values or null / 'Unassigned'
  const ownerValue: string | null =
    newOwner === null || newOwner === 'Unassigned' || newOwner === undefined
      ? null
      : newOwner;

  if (ownerValue !== null && !(VALID_OWNERS as readonly string[]).includes(ownerValue)) {
    return NextResponse.json(
      { error: `Invalid owner value. Accepted values: ${VALID_OWNERS.join(', ')}, or null/Unassigned.` },
      { status: 422 }
    );
  }

  // ── 2. Authenticate session ────────────────────────────────────────────────
  const cookieStore = await cookies();
  const ssrClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );

  const { data: { user }, error: authError } = await ssrClient.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // ── 3. Verify Admin role ───────────────────────────────────────────────────
  // ONLY trust app_metadata — user_metadata is user-controlled and must not grant Admin access
  const appMeta = (user as any).app_metadata ?? {};
  const isAdmin = appMeta?.role === 'admin';

  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden. Admin access required.' }, { status: 403 });
  }

  // ── 4. Service-role client for authorized writes ───────────────────────────
  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // ── 5. Fetch current owner for activity log ────────────────────────────────
  const { data: current, error: fetchError } = await serviceClient
    .from('borrower_applications')
    .select('id, user_id, eb_assigned_owner')
    .eq('id', applicationId)
    .is('purged_at', null)
    .single();

  if (fetchError || !current) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  const previousOwner: string | null = current.eb_assigned_owner ?? null;

  // No-op if value is unchanged
  if (previousOwner === ownerValue) {
    return NextResponse.json({ success: true, eb_assigned_owner: ownerValue });
  }

  // ── 6. Update eb_assigned_owner ────────────────────────────────────────────
  const { error: updateError } = await serviceClient
    .from('borrower_applications')
    .update({ eb_assigned_owner: ownerValue, updated_at: new Date().toISOString() })
    .eq('id', applicationId);

  if (updateError) {
    console.error('[update-deal-owner] update error:', updateError);
    return NextResponse.json({ error: 'Failed to update owner.' }, { status: 500 });
  }

  // ── 7. Log owner_assigned activity ────────────────────────────────────────
  // Identical event structure to Deal Detail owner change
  const actorName = ADMIN_EMAIL_MAP[user.email ?? ''] ?? 'EarnestBridge Admin';
  const newOwnerLabel = ownerValue ?? 'Unassigned';
  const prevOwnerLabel = previousOwner ?? 'Unassigned';

  const { error: activityError } = await serviceClient
    .from('application_activity')
    .insert({
      application_id: applicationId,
      user_id: current.user_id,
      event_type: 'owner_assigned',
      title: `Owner changed to ${newOwnerLabel}`,
      detail: `Deal ownership updated from ${prevOwnerLabel} to ${newOwnerLabel}.`,
      actor: actorName,
      metadata: {
        previous_owner: previousOwner,
        new_owner: ownerValue,
        changed_by_email: user.email,
      },
    });

  if (activityError) {
    // Non-fatal: owner was updated; log the error but don't fail the request
    console.error('[update-deal-owner] activity log error:', activityError);
  }

  return NextResponse.json({ success: true, eb_assigned_owner: ownerValue });
}
