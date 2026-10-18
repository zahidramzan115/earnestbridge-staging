import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  requireServiceRoleClient,
  findContactIdByNormalizedEmail,
  restorePurgedContactIfNeeded,
  normalizeContactEmail,
  isUniqueViolation,
} from '@/lib/server/crmContactMatch';

export type EnsureCrmContactMode = 'signup' | 'backfill';

export type EnsureCrmContactOutcome =
  | 'skipped_admin' |'skipped_unverified' |'skipped_no_email' |'created' |'linked' |'restored_and_linked' |'unchanged' |'conflict_different_user' |'skipped_purged' |'skipped_merged';

export interface EnsureCrmContactResult {
  outcome: EnsureCrmContactOutcome;
  contactId: string | null;
}

interface ContactRow {
  id: string;
  is_merged: boolean;
  purged_at: string | null;
  portal_user_id: string | null;
}

function splitFullName(raw: unknown, fallbackEmail: string): { first: string; last: string } {
  const full = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!full) {
    return { first: fallbackEmail.split('@')[0] || '', last: '' };
  }
  const idx = full.indexOf(' ');
  if (idx === -1) return { first: full, last: '' };
  return { first: full.slice(0, idx), last: full.slice(idx + 1) };
}

async function loadContact(supabase: SupabaseClient, id: string): Promise<ContactRow | null> {
  const { data, error } = await supabase
    .from('crm_contacts')
    .select('id, is_merged, purged_at, portal_user_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load Contact: ${error.message}`);
  return (data as ContactRow | null) ?? null;
}

/**
 * Link an unlinked Contact to the portal user as 'pending'. Conditional on
 * portal_user_id IS NULL so a concurrent link (e.g. the DB verification
 * trigger) is never overwritten. Returns true only if THIS call changed it.
 */
async function linkContactPending(
  supabase: SupabaseClient,
  contactId: string,
  userId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('crm_contacts')
    .update({
      portal_user_id: userId,
      portal_link_status: 'pending',
      portal_linked_at: now,
      updated_at: now,
    })
    .eq('id', contactId)
    .eq('is_merged', false)
    .is('portal_user_id', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Failed to link Contact: ${error.message}`);
  return !!data;
}

async function writeRegistrationActivityAndNotification(
  supabase: SupabaseClient,
  params: {
    contactId: string;
    userId: string;
    email: string;
    displayName: string;
    created: boolean;
  }
): Promise<void> {
  const { contactId, userId, email, displayName, created } = params;

  try {
    const { error } = await supabase.from('crm_activities').insert({
      contact_id: contactId,
      event_type: 'portal_account_registered',
      title: created
        ? 'Portal account registered — new Contact created, pending Admin approval' :'Portal account registered — pending Admin approval',
      detail: `User registered with email ${email}. Portal access pending Admin review.`,
      actor: 'System',
      actor_user_id: userId,
    });
    if (error) {
      console.error('[portalSignupCrm] activity insert failed (non-fatal):', error.message);
    }
  } catch (err) {
    console.error('[portalSignupCrm] activity insert threw (non-fatal):', err);
  }

  try {
    const admins: string[] = [];
    const { data: usersPage, error: listError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (listError) {
      console.error('[portalSignupCrm] admin lookup failed (non-fatal):', listError.message);
    } else {
      for (const u of usersPage?.users ?? []) {
        if (u.app_metadata?.role === 'admin') admins.push(u.id);
        if (admins.length >= 5) break;
      }
    }
    if (admins.length > 0) {
      const { error: notifError } = await supabase.from('notifications').insert(
        admins.map((adminId) => ({
          user_id: adminId,
          type: 'system_message',
          title: `Portal Account Match: ${displayName}`,
          message: created
            ? `${email} registered a portal account. A new CRM Contact was created. Review and approve portal access.`
            : `${email} registered and matches existing CRM Contact. Review and approve portal access.`,
          crm_contact_id: contactId,
        }))
      );
      if (notifError) {
        console.error('[portalSignupCrm] notification insert failed (non-fatal):', notifError.message);
      }
    }
  } catch (err) {
    console.error('[portalSignupCrm] notification step threw (non-fatal):', err);
  }
}

/**
 * Ensure a VERIFIED, non-admin portal user has a CRM Contact.
 *
 * Identity comes ONLY from the authenticated Supabase `user` object.
 * Uses the REQUIRED service-role client (no anon fallback).
 *
 * mode 'signup'   : reuse active / restore purged / create new, link as pending. * mode'backfill' : reuse active / create new, link as pending. A PURGED
 *                   Contact is NEVER restored by an ordinary login.
 *
 * Never overwrites a different portal_user_id. Never touches borrower_access,
 * Deals, Contact Submissions or portal_link_status of an already-linked Contact.
 */
export async function ensurePortalSignupCrmContact(
  user: User,
  mode: EnsureCrmContactMode,
  client?: SupabaseClient
): Promise<EnsureCrmContactResult> {
  if (user.app_metadata?.role === 'admin') {
    return { outcome: 'skipped_admin', contactId: null };
  }
  if (!user.email_confirmed_at) {
    return { outcome: 'skipped_unverified', contactId: null };
  }
  const email = normalizeContactEmail(user.email);
  if (!email) {
    return { outcome: 'skipped_no_email', contactId: null };
  }

  const supabase = client ?? requireServiceRoleClient();
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const { first, last } = splitFullName(meta.full_name, email);
  const displayName = `${first} ${last}`.trim() || email;

  const resolveExisting = async (): Promise<EnsureCrmContactResult | null> => {
    const existingId = await findContactIdByNormalizedEmail(supabase, email);
    if (!existingId) return null;

    const contact = await loadContact(supabase, existingId);
    if (!contact) return null;
    if (contact.is_merged) return { outcome: 'skipped_merged', contactId: contact.id };

    let restored = false;
    if (contact.purged_at) {
      if (mode !== 'signup') {
        // Ordinary login must never undo a purge.
        return { outcome: 'skipped_purged', contactId: contact.id };
      }
      const restore = await restorePurgedContactIfNeeded(supabase, contact.id, {
        source: 'portal_signup',
        detail: `${email} created a verified Client Portal account.`,
      });
      if (!restore.found || restore.merged) {
        return { outcome: 'skipped_merged', contactId: contact.id };
      }
      restored = restore.restored;
    }

    if (contact.portal_user_id === user.id) {
      return { outcome: restored ? 'restored_and_linked' : 'unchanged', contactId: contact.id };
    }
    if (contact.portal_user_id && contact.portal_user_id !== user.id) {
      console.error(
        `[portalSignupCrm] portal_user_id conflict on contact ${contact.id}: ` +
          `already linked to a different auth user. Not overwriting.`
      );
      return { outcome: 'conflict_different_user', contactId: contact.id };
    }

    const linked = await linkContactPending(supabase, contact.id, user.id);
    if (!linked) {
      // Lost a race (trigger or concurrent call linked it). Re-read to classify.
      const fresh = await loadContact(supabase, contact.id);
      if (fresh?.portal_user_id === user.id) {
        return { outcome: restored ? 'restored_and_linked' : 'unchanged', contactId: contact.id };
      }
      console.error(`[portalSignupCrm] portal_user_id conflict after race on contact ${contact.id}.`);
      return { outcome: 'conflict_different_user', contactId: contact.id };
    }

    await writeRegistrationActivityAndNotification(supabase, {
      contactId: contact.id,
      userId: user.id,
      email,
      displayName,
      created: false,
    });
    return { outcome: restored ? 'restored_and_linked' : 'linked', contactId: contact.id };
  };

  const existingResult = await resolveExisting();
  if (existingResult) return existingResult;

  // ── No matching Contact: create one ──────────────────────────────────────
  const now = new Date().toISOString();
  const { data: created, error: insertError } = await supabase
    .from('crm_contacts')
    .insert({
      first_name: first,
      last_name: last,
      primary_email: email,
      lead_status: 'New Lead',
      assigned_owner: 'Unassigned',
      lead_source: 'Portal Signup',
      original_lead_source: 'Portal Signup',
      latest_lead_source: 'Portal Signup',
      portal_user_id: user.id,
      portal_link_status: 'pending',
      portal_linked_at: now,
    })
    .select('id')
    .single();

  if (insertError) {
    if (isUniqueViolation(insertError)) {
      // Race: re-run exact matching once and reuse the resulting Contact.
      const recovered = await resolveExisting();
      if (recovered) return recovered;
    }
    throw new Error(`Failed to create Contact: ${insertError.message}`);
  }
  if (!created) throw new Error('Failed to create Contact: no row returned.');

  const contactId = created.id as string;

  try {
    const { error: createdActivityError } = await supabase.from('crm_activities').insert({
      contact_id: contactId,
      event_type: 'contact_created',
      title: 'New lead created from Client Portal signup',
      detail: `${displayName} (${email}) created a verified Client Portal account.`,
      actor: 'System',
      actor_user_id: user.id,
    });
    if (createdActivityError) {
      console.error('[portalSignupCrm] contact_created activity failed (non-fatal):', createdActivityError.message);
    }
  } catch (err) {
    console.error('[portalSignupCrm] contact_created activity threw (non-fatal):', err);
  }

  await writeRegistrationActivityAndNotification(supabase, {
    contactId,
    userId: user.id,
    email,
    displayName,
    created: true,
  });

  return { outcome: 'created', contactId };
}
