import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import {
  requireAdmin,
  requireSuperAdmin,
} from '@/lib/server/adminAuth';

// ============================================================
// Admin Invoice Settings API
// GET  /api/admin/invoice-settings
// PATCH /api/admin/invoice-settings
//
// SECURITY MODEL:
//   1. Authenticates the session via SSR Supabase client
//   2. GET: Verifies the caller is an EarnestBridge Admin
//      (app_metadata.role === 'admin')
//   3. PATCH: Verifies the caller is a SuperAdmin
//      (app_metadata.role === 'admin' AND app_metadata.is_superadmin === true)
//   4. Reads/updates ONLY crm_invoice_settings WHERE id = 1
//   5. Rejects unauthorized callers with 401
//   6. Service-role credentials are NEVER exposed to the browser
//
// SENSITIVE DATA:
//   - wire_routing_number and wire_account_number are NEVER
//     returned in the normal GET response.
//   - The GET returns only: has_wire_routing_number (bool),
//     wire_routing_last4 (string|null), has_wire_account_number (bool),
//     wire_account_last4 (string|null).
//   - Full secrets are only available via the separate
//     GET /api/admin/invoice-settings/secret endpoint.
//   - Sensitive values are NEVER logged to console, error messages,
//     or activity logs. Errors use generic messages only.
//
// PATCH CONTRACT:
//   - Use wire_routing_number_replacement / wire_account_number_replacement
//     to replace secrets. Omission means "preserve existing value".
//   - Do NOT send the full secret in wire_routing_number or
//     wire_account_number fields — those are ignored on PATCH.
//
// SINGLETON:
//   - crm_invoice_settings.id = 1 always.
//   - PATCH inserts id=1 if no row exists, updates id=1 if it does.
//   - updated_by stores the Admin's auth.users UUID (not email).
// ============================================================

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ── GET /api/admin/invoice-settings ──────────────────────────────────────────
// Returns safe metadata only. Full routing/account numbers are NOT returned.
// Cache-Control: no-store prevents browser/proxy caching of this response.

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('crm_invoice_settings')
    .select(
      'issuer_legal_name, issuer_address_line1, issuer_address_line2, ' + 'issuer_city, issuer_state, issuer_postal_code, issuer_country, '+ 'wire_bank_name, wire_account_name, wire_routing_number, wire_account_number, '+ 'wire_bank_address, wire_memo_instructions, '+ 'invoice_tagline, invoice_footer_text, updated_at, updated_by'
    )
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    // Do not log sensitive data
    return NextResponse.json(
      { error: 'Unable to load invoice settings.' },
      {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }

  if (!data) {
    // No singleton row yet — return empty defaults with safe metadata
    return NextResponse.json(
      {
        exists: false,
        issuer_legal_name: '',
        issuer_address_line1: '',
        issuer_address_line2: '',
        issuer_city: '',
        issuer_state: '',
        issuer_postal_code: '',
        issuer_country: 'US',
        wire_bank_name: '',
        wire_account_name: '',
        // Safe metadata only — no full secrets
        has_wire_routing_number: false,
        wire_routing_last4: null,
        has_wire_account_number: false,
        wire_account_last4: null,
        wire_bank_address: '',
        wire_memo_instructions: '',
        invoice_tagline: '',
        invoice_footer_text: '',
        updated_at: null,
        updated_by: null,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // Derive safe metadata from secrets — never return the full values
  const routingRaw: string = data.wire_routing_number ?? '';
  const accountRaw: string = data.wire_account_number ?? '';

  const hasRouting = routingRaw.length > 0;
  const hasAccount = accountRaw.length > 0;
  const routingLast4 = hasRouting ? routingRaw.slice(-4) : null;
  const accountLast4 = hasAccount ? accountRaw.slice(-4) : null;

  return NextResponse.json(
    {
      exists: true,
      issuer_legal_name: data.issuer_legal_name ?? '',
      issuer_address_line1: data.issuer_address_line1 ?? '',
      issuer_address_line2: data.issuer_address_line2 ?? '',
      issuer_city: data.issuer_city ?? '',
      issuer_state: data.issuer_state ?? '',
      issuer_postal_code: data.issuer_postal_code ?? '',
      issuer_country: data.issuer_country ?? 'US',
      wire_bank_name: data.wire_bank_name ?? '',
      wire_account_name: data.wire_account_name ?? '',
      // Safe metadata only — full secrets are NOT included
      has_wire_routing_number: hasRouting,
      wire_routing_last4: routingLast4,
      has_wire_account_number: hasAccount,
      wire_account_last4: accountLast4,
      wire_bank_address: data.wire_bank_address ?? '',
      wire_memo_instructions: data.wire_memo_instructions ?? '',
      invoice_tagline: data.invoice_tagline ?? '',
      invoice_footer_text: data.invoice_footer_text ?? '',
      updated_at: data.updated_at ?? null,
      updated_by: data.updated_by ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// ── PATCH /api/admin/invoice-settings ────────────────────────────────────────
// SuperAdmin only. Use wire_routing_number_replacement / wire_account_number_replacement
// to replace secrets. Omission means "preserve existing value in DB".
//
// FIX: updated_by stores admin.id (UUID), NOT admin.email (string).
//      The crm_invoice_settings.updated_by column is UUID FK → auth.users.
//      Passing an email string caused a type error and silent save failure.

export async function PATCH(request: NextRequest) {
  const admin = await requireSuperAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Non-secret allowed fields — all are optional (address fields are NOT required)
  const NON_SECRET_FIELDS = [
    'issuer_legal_name',
    'issuer_address_line1',
    'issuer_address_line2',
    'issuer_city',
    'issuer_state',
    'issuer_postal_code',
    'issuer_country',
    'wire_bank_name',
    'wire_account_name',
    'wire_bank_address',
    'wire_memo_instructions',
    'invoice_tagline',
    'invoice_footer_text',
  ] as const;

  // Build a clean payload from only allowed non-secret fields
  const payload: Record<string, string | null> = {};
  for (const field of NON_SECRET_FIELDS) {
    if (field in body) {
      const val = body[field];
      if (val === null || val === undefined || val === '') {
        // Optional fields may be stored as NULL — address fields are optional
        payload[field] = null;
      } else if (typeof val === 'string') {
        payload[field] = val.trim();
      } else {
        return NextResponse.json({ error: 'Invalid request.' }, { status: 422 });
      }
    }
  }

  // Handle explicit secret replacement fields
  // Absence = preserve existing DB value (do NOT set to null)
  const hasRoutingReplacement = 'wire_routing_number_replacement' in body;
  const hasAccountReplacement = 'wire_account_number_replacement' in body;

  if (hasRoutingReplacement) {
    const rn = body['wire_routing_number_replacement'];
    if (typeof rn !== 'string' || rn.trim() === '') {
      return NextResponse.json(
        { error: 'Routing number replacement must be a non-empty string.' },
        { status: 422 }
      );
    }
    const rnClean = rn.trim();
    if (!/^\d+$/.test(rnClean)) {
      return NextResponse.json(
        { error: 'Routing number must contain digits only.' },
        { status: 422 }
      );
    }
    if (rnClean.length !== 9) {
      return NextResponse.json(
        { error: 'U.S. routing numbers must be exactly 9 digits.' },
        { status: 422 }
      );
    }
    // Map replacement field → actual DB column name
    payload['wire_routing_number'] = rnClean;
  }

  if (hasAccountReplacement) {
    const an = body['wire_account_number_replacement'];
    if (typeof an !== 'string' || (an as string).trim() === '') {
      return NextResponse.json(
        { error: 'Account number replacement must be a non-empty string.' },
        { status: 422 }
      );
    }
    const anClean = (an as string).trim();
    if (!/^[0-9a-zA-Z\-]+$/.test(anClean)) {
      return NextResponse.json(
        { error: 'Account number contains invalid characters.' },
        { status: 422 }
      );
    }
    if (anClean.length > 34) {
      return NextResponse.json(
        { error: 'Account number is too long.' },
        { status: 422 }
      );
    }
    // Map replacement field → actual DB column name
    payload['wire_account_number'] = anClean;
  }

  // Reject attempts to send raw wire_routing_number / wire_account_number directly
  // (they must use the _replacement fields)
  if ('wire_routing_number' in body && !hasRoutingReplacement) {
    return NextResponse.json(
      { error: 'Use wire_routing_number_replacement to update the routing number.' },
      { status: 422 }
    );
  }
  if ('wire_account_number' in body && !hasAccountReplacement) {
    return NextResponse.json(
      { error: 'Use wire_account_number_replacement to update the account number.' },
      { status: 422 }
    );
  }

  if (Object.keys(payload).length === 0) {
    return NextResponse.json({ error: 'No valid fields provided.' }, { status: 422 });
  }

  const supabase = getServiceClient();

  // Check if singleton row exists
  const { data: existing } = await supabase
    .from('crm_invoice_settings')
    .select('id')
    .eq('id', 1)
    .maybeSingle();

  const now = new Date().toISOString();
  // CRITICAL FIX: updated_by is a UUID FK → auth.users.
  // Must use admin.id (UUID string), NOT admin.email (text).
  // Passing admin.email caused a PostgreSQL type error and silent 500 failure.
  const adminUserId = admin.id;

  if (!existing) {
    // INSERT singleton row — first-ever save
    const { error: insertError } = await supabase
      .from('crm_invoice_settings')
      .insert({
        id: 1,
        ...payload,
        updated_at: now,
        updated_by: adminUserId,
      });

    if (insertError) {
      // Never log sensitive fields — log only safe metadata
      console.error('[invoice-settings] insert failed:', insertError.code, insertError.message);
      return NextResponse.json(
        { error: 'Unable to save invoice settings.' },
        { status: 500 }
      );
    }
  } else {
    // UPDATE singleton row — only the fields in payload are changed
    // Fields NOT in payload are untouched (secrets are preserved)
    const { error: updateError } = await supabase
      .from('crm_invoice_settings')
      .update({
        ...payload,
        updated_at: now,
        updated_by: adminUserId,
      })
      .eq('id', 1);

    if (updateError) {
      // Never log sensitive fields — log only safe metadata
      console.error('[invoice-settings] update failed:', updateError.code, updateError.message);
      return NextResponse.json(
        { error: 'Unable to save invoice settings.' },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ success: true });
}
