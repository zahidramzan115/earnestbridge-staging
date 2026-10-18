import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import {
  findContactIdByNormalizedEmail,
  restorePurgedContactIfNeeded,
} from '@/lib/server/crmContactMatch';
import { assertPortalAccess } from '@/lib/server/portalAccess';

/**
 * POST /api/admin/link-deal-crm-contact
 *
 * Repairs or establishes the CRM contact linkage for a specific deal.
 * Called by the borrower application form after a new Deal is submitted.
 *
 * Security:
 *   - Requires a valid authenticated borrower session (cookie-based).
 *   - Verifies borrower_applications.user_id = authenticatedUser.id before
 *     making ANY CRM or Deal update.
 *   - Never trusts client-supplied user IDs or emails for authorization.
 *   - Does NOT create new CRM Contacts — only links existing ones.
 *
 * Body: { applicationId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // ── 1. Authenticate the caller via session cookie ──────────────────────
    // Build a response object so the SSR client can set refreshed cookies.
    let response = NextResponse.next();

    const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    const {
      data: { user: authedUser },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !authedUser) {
      return NextResponse.json(
        { error: 'Unauthorized. A valid authenticated session is required.' },
        { status: 401 }
      );
    }

    // ── 1b. Account-wide Client Portal access guard ────────────────────────
    // Borrower-accessible despite the /api/admin path. A disabled Client must
    // not restore a Contact or mutate any CRM link. Runs BEFORE any mutation.
    const portalDenied = await assertPortalAccess(authedUser.id);
    if (portalDenied) return portalDenied;

    // ── 2. Parse and validate the request body ─────────────────────────────
    let applicationId: string | undefined;
    try {
      const body = await req.json();
      applicationId = body?.applicationId;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (!applicationId || typeof applicationId !== 'string') {
      return NextResponse.json({ error: 'applicationId is required' }, { status: 400 });
    }

    // ── 3. Service-role client for privileged reads/writes ─────────────────
    const supabase = createServiceClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── 4. Fetch the application and enforce ownership ─────────────────────
    // CRITICAL: verify borrower_applications.user_id = authenticatedUser.id
    // before making ANY CRM or Deal update.
    const { data: app, error: appError } = await supabase
      .from('borrower_applications')
      .select('id, user_id, email, primary_contact_id')
      .eq('id', applicationId)
      .is('purged_at', null)
      .single();

    if (appError || !app) {
      return NextResponse.json(
        { error: 'Application not found', detail: appError?.message },
        { status: 404 }
      );
    }

    // Ownership check — borrower must own this application
    if (app.user_id !== authedUser.id) {
      console.warn(
        `[link-deal-crm-contact] Ownership violation: user ${authedUser.id} attempted to link application ${applicationId} owned by ${app.user_id}`
      );
      return NextResponse.json(
        { error: 'Forbidden. This application does not belong to the authenticated user.' },
        { status: 403 }
      );
    }

    // ── 5. Find existing CRM contact ───────────────────────────────────────
    // Prefer portal_user_id match (most reliable), fall back to email match.
    // NEVER create a new CRM Contact inside this endpoint.
    let existingContact: { id: string; primary_email: string; portal_user_id: string | null } | null = null;

    // Primary lookup: portal_user_id = authenticated user's ID (server-derived).
    // NOTE: purged_at is intentionally NOT filtered — a purged Contact with
    // active portal access must be locatable so it can be auto-restored.
    const { data: byUserId } = await supabase
      .from('crm_contacts')
      .select('id, primary_email, portal_user_id')
      .eq('portal_user_id', authedUser.id)
      .eq('is_merged', false)
      .limit(1)
      .maybeSingle();

    if (byUserId) {
      existingContact = byUserId;
    }

    // Email fallback: exact normalized-email RPC (includes purged, excludes
    // merged) using the authenticated user's session email, NOT a client value.
    if (!existingContact && authedUser.email) {
      let matchedId: string | null = null;
      try {
        matchedId = await findContactIdByNormalizedEmail(supabase, authedUser.email);
      } catch (matchErr) {
        console.error('[link-deal-crm-contact] normalized email lookup failed:', matchErr);
        return NextResponse.json({ error: 'Failed to look up CRM contact' }, { status: 500 });
      }

      if (matchedId) {
        const { data: byEmail } = await supabase
          .from('crm_contacts')
          .select('id, primary_email, portal_user_id')
          .eq('id', matchedId)
          .eq('is_merged', false)
          .maybeSingle();

        if (byEmail) existingContact = byEmail;
      }
    }

    if (!existingContact) {
      return NextResponse.json({
        status: 'no_contact_found',
        message: 'No existing CRM contact found for this user. No changes made.',
        applicationId,
      });
    }

    const contactId = existingContact.id;

    // Restore the Contact to the active Admin CRM if it was purged (new Deal =
    // new inbound activity). Clears only purge fields; never touches portal
    // state, borrower_access, Deals or merge state.
    try {
      await restorePurgedContactIfNeeded(supabase, contactId, {
        source: 'apply_link_deal',
        detail: `A new Deal (${applicationId}) was submitted through /apply.`,
      });
    } catch (restoreErr) {
      console.error('[link-deal-crm-contact] Contact auto-restore failed:', restoreErr);
      return NextResponse.json({ error: 'Failed to restore CRM contact' }, { status: 500 });
    }

    const alreadyLinked = app.primary_contact_id === contactId;

    // ── 6. Check if crm_deal_contacts row already exists (idempotency) ─────
    const { data: existingDealContact } = await supabase
      .from('crm_deal_contacts')
      .select('id, role')
      .eq('deal_id', applicationId)
      .eq('contact_id', contactId)
      .limit(1)
      .single();

    const dealContactExists = !!existingDealContact;

    if (alreadyLinked && dealContactExists) {
      return NextResponse.json({
        status: 'already_linked',
        message: 'Deal is already correctly linked to the CRM contact. No changes made.',
        applicationId,
        contactId,
      });
    }

    // ── 7. Update primary_contact_id if not already set ────────────────────
    if (!alreadyLinked) {
      const { error: updateError } = await supabase
        .from('borrower_applications')
        .update({ primary_contact_id: contactId })
        .eq('id', applicationId)
        .eq('user_id', authedUser.id); // double-guard ownership on write

      if (updateError) {
        return NextResponse.json(
          { error: 'Failed to update primary_contact_id', detail: updateError.message },
          { status: 500 }
        );
      }
    }

    // ── 8. Insert crm_deal_contacts if not already present ─────────────────
    if (!dealContactExists) {
      const { error: dcError } = await supabase
        .from('crm_deal_contacts')
        .insert({ deal_id: applicationId, contact_id: contactId, role: 'primary' });

      if (dcError) {
        // Unique constraint violation means it already exists — that's fine
        if (!dcError.message?.includes('duplicate') && !dcError.message?.includes('unique')) {
          return NextResponse.json(
            { error: 'Failed to create crm_deal_contacts row', detail: dcError.message },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json({
      status: 'linked',
      message: 'Deal successfully linked to existing CRM contact.',
      applicationId,
      contactId,
      primaryContactIdUpdated: !alreadyLinked,
      dealContactCreated: !dealContactExists,
    });
  } catch (err: any) {
    console.error('[link-deal-crm-contact] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Internal server error', detail: err?.message },
      { status: 500 }
    );
  }
}
