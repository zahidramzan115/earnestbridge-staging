import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── Required service-role client (NO anon fallback) ─────────────────────────

const PLACEHOLDER_PATTERNS = ['your-', 'your_', 'placeholder', 'changeme'];

/**
 * Create a service-role Supabase client. Throws if the URL or service-role key
 * is missing or a placeholder. Never falls back to the anon key.
 */
export function requireServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const bad = (v: string) =>
    !v.trim() || PLACEHOLDER_PATTERNS.some((p) => v.toLowerCase().startsWith(p));
  if (bad(url)) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured.');
  if (bad(key)) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Normalized-email matcher ────────────────────────────────────────────────

/** trim + lowercase — mirrors the DB lower(trim()) uniqueness semantics. */
export function normalizeContactEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * Find a non-merged CRM Contact id by normalized email using the deployed
 * find_crm_contact_id_by_normalized_email RPC. INCLUDES purged Contacts and
 * EXCLUDES merged Contacts. Checks primary email first, then alternate emails.
 *
 * Throws on RPC error (fail closed) so callers never create duplicates after a
 * lookup failure.
 */
export async function findContactIdByNormalizedEmail(
  supabase: SupabaseClient,
  email: unknown
): Promise<string | null> {
  const normalized = normalizeContactEmail(email);
  if (!normalized) return null;

  const { data, error } = await supabase.rpc('find_crm_contact_id_by_normalized_email', {
    p_email: normalized,
  });
  if (error) {
    throw new Error(`Contact email lookup failed: ${error.message}`);
  }
  return typeof data === 'string' && data ? data : null;
}

// ─── Restore helper ──────────────────────────────────────────────────────────

export interface RestoreContext {
  /** Short source label, e.g. 'contact_form', 'bpcon26_claim', 'apply_link_deal'. */
  source: string;
  /** Human-readable detail for the activity row. */
  detail?: string;
}

export interface RestoreResult {
  found: boolean;
  merged: boolean;
  restored: boolean;
}

/**
 * Restore a purged Contact (clears ONLY purged_at / purged_by / purge_reason,
 * plus updated_at). No-op for active Contacts. Refuses merged Contacts.
 *
 * Does NOT touch is_merged, merged_into_id, portal_user_id, portal_link_status,
 * borrower_access, auth metadata, Deals or Contact Submissions.
 *
 * Audit: writes a CONTACT_AUTO_RESTORED row to crm_activities (system action —
 * no fake Admin identity is used, so audit_logs, which requires a real admin_id,
 * is intentionally not written).
 */
export async function restorePurgedContactIfNeeded(
  supabase: SupabaseClient,
  contactId: string,
  context: RestoreContext
): Promise<RestoreResult> {
  const { data: contact, error: loadError } = await supabase
    .from('crm_contacts')
    .select('id, is_merged, purged_at, purged_by, purge_reason')
    .eq('id', contactId)
    .maybeSingle();

  if (loadError) {
    throw new Error(`Failed to load Contact for restore: ${loadError.message}`);
  }
  if (!contact) return { found: false, merged: false, restored: false };
  if (contact.is_merged) return { found: true, merged: true, restored: false };
  if (!contact.purged_at) return { found: true, merged: false, restored: false };

  const previousPurgedAt = contact.purged_at as string;
  const previousReason = (contact.purge_reason as string | null) ?? null;

  const { data: updated, error: updateError } = await supabase
    .from('crm_contacts')
    .update({
      purged_at: null,
      purged_by: null,
      purge_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .eq('is_merged', false)
    .not('purged_at', 'is', null)
    .select('id')
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to restore Contact: ${updateError.message}`);
  }
  if (!updated) {
    // Concurrent restore already happened — no duplicate activity.
    return { found: true, merged: false, restored: false };
  }

  const { error: activityError } = await supabase.from('crm_activities').insert({
    contact_id: contactId,
    event_type: 'contact_auto_restored',
    title: 'Contact automatically restored to Admin CRM',
    detail:
      context.detail ??
      'A previously purged Contact was restored after new inbound activity.',
    actor: 'System',
    metadata: {
      action: 'CONTACT_AUTO_RESTORED',
      source: context.source,
      previous_purged_at: previousPurgedAt,
      previous_purge_reason: previousReason,
      restored_at: new Date().toISOString(),
    },
  });
  if (activityError) {
    console.error('[crmContactMatch] CONTACT_AUTO_RESTORED activity insert failed (non-fatal):', activityError.message);
  }

  return { found: true, merged: false, restored: true };
}

// ─── Find + restore convenience ──────────────────────────────────────────────

/**
 * Locate an existing Contact by normalized email (including purged) and restore
 * it if purged. Returns null when no non-merged Contact exists.
 */
export async function findAndRestoreContactByEmail(
  supabase: SupabaseClient,
  email: unknown,
  context: RestoreContext
): Promise<{ id: string; restored: boolean } | null> {
  const id = await findContactIdByNormalizedEmail(supabase, email);
  if (!id) return null;
  const result = await restorePurgedContactIfNeeded(supabase, id, context);
  if (!result.found || result.merged) return null;
  return { id, restored: result.restored };
}

/** PostgreSQL unique violation. */
export function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return !!error && error.code === '23505';
}
