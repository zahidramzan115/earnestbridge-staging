import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';

// ─── Environment validation ───────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = ['your-', 'your_', 'placeholder', 'changeme', 'example'];

function isPlaceholder(val: string): boolean {
  const lower = val.toLowerCase();
  return PLACEHOLDER_PATTERNS.some((p) => lower.startsWith(p)) || val.trim() === '';
}

/**
 * Validate and return the required server environment variables.
 * Throws a safe error (no secret values) if any are missing or placeholder.
 */
export function validateServerEnv(requireSiteUrl = false): {
  supabaseUrl: string;
  serviceRoleKey: string;
  siteUrl?: string;
} {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl || isPlaceholder(supabaseUrl)) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured.');
  }
  if (!serviceRoleKey || isPlaceholder(serviceRoleKey)) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  }

  if (requireSiteUrl) {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';
    if (!siteUrl || isPlaceholder(siteUrl)) {
      throw new Error('NEXT_PUBLIC_SITE_URL is not configured.');
    }
    return { supabaseUrl, serviceRoleKey, siteUrl };
  }

  return { supabaseUrl, serviceRoleKey };
}

// ─── Service-role client ──────────────────────────────────────────────────────

/**
 * Create a service-role Supabase client.
 * MUST only be called after the caller has been authenticated as SuperAdmin.
 * Never expose the returned client or its credentials to the browser.
 */
export function createServiceRoleClient(supabaseUrl: string, serviceRoleKey: string): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Email validation ─────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize and validate an email address.
 * Returns the normalized email or null if invalid.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized || !EMAIL_RE.test(normalized)) return null;
  return normalized;
}

// ─── Paginated user lookup ────────────────────────────────────────────────────

/**
 * Find an Auth user by exact normalized email via paginated listUsers().
 * Scans ALL pages before returning — never returns early on a single-page match.
 * Returns the matching User, null if not found, or throws on API error.
 * Throws a safe error if more than one exact match is found across all pages.
 */
export async function findUserByEmail(
  adminClient: SupabaseClient,
  email: string
): Promise<User | null> {
  const perPage = 1000;
  let page = 1;
  const allMatches: User[] = [];

  while (true) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error('Failed to query Auth users.');

    const users = data?.users ?? [];
    const pageMatches = users.filter((u) => u.email?.toLowerCase() === email);
    allMatches.push(...pageMatches);

    if (users.length < perPage) break;
    page++;
  }

  if (allMatches.length > 1) {
    throw new Error('Multiple Auth users found with the same email address.');
  }
  if (allMatches.length === 1) {
    return allMatches[0];
  }

  return null;
}

// ─── Audit log writer ─────────────────────────────────────────────────────────

export interface AuditEntry {
  adminId: string;
  adminEmail: string;
  eventType: 'create' | 'edit';
  resourceType: string;
  resourceId: string;
  description: string;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}

/**
 * Write an audit log entry using the service-role client.
 * Uses the service-role client because the caller's session cookie may not
 * satisfy the RLS policy after a privilege change.
 *
 * Returns true if the insert succeeded, false if it failed.
 * Never throws — audit failures must not roll back completed Auth operations.
 */
export async function writeAuditLog(
  adminClient: SupabaseClient,
  entry: AuditEntry
): Promise<boolean> {
  try {
    const { error } = await adminClient.from('audit_logs').insert({
      admin_id: entry.adminId,
      admin_email: entry.adminEmail,
      event_type: entry.eventType,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId,
      description: entry.description,
      old_value: entry.oldValue ?? null,
      new_value: entry.newValue ?? null,
    });

    if (error) {
      console.error('[adminUsers] audit_log insert failed (non-fatal):', error.message);
      return false;
    }
    return true;
  } catch {
    console.error('[adminUsers] audit_log insert threw unexpectedly (non-fatal)');
    return false;
  }
}
