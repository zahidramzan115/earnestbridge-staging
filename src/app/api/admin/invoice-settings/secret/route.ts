import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { requireSuperAdmin } from '@/lib/server/adminAuth';

// ============================================================
// Admin Invoice Settings — Secret Reveal Endpoint
// GET /api/admin/invoice-settings/secret?field=routing
// GET /api/admin/invoice-settings/secret?field=account
//
// SECURITY MODEL:
//   1. Authenticates the session via SSR Supabase client
//   2. Verifies the caller is a SuperAdmin
//      (app_metadata.role === 'admin' AND app_metadata.is_superadmin === true)
//   3. Validates the requested field against an explicit allowlist
//      (only 'routing' or 'account' are accepted)
//   4. Fetches ONLY the requested secret from id = 1
//   5. Returns ONLY the requested secret value
//   6. Never logs the secret value
//
// This is NOT a generic secret-fetch endpoint.
// Only the two wire secret fields are accessible here.
// ============================================================

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Explicit allowlist — only these two field aliases are permitted
const ALLOWED_FIELDS = ['routing', 'account'] as const;
type AllowedField = typeof ALLOWED_FIELDS[number];

function isAllowedField(val: unknown): val is AllowedField {
  return ALLOWED_FIELDS.includes(val as AllowedField);
}

export async function GET(request: NextRequest) {
  // 1. Authenticate — SuperAdmin only
  const admin = await requireSuperAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  // 2. Validate field parameter against allowlist
  const { searchParams } = new URL(request.url);
  const field = searchParams.get('field');

  if (!isAllowedField(field)) {
    return NextResponse.json({ error: 'Invalid field.' }, { status: 422 });
  }

  // 3. Fetch only the requested column
  const columnName = field === 'routing' ? 'wire_routing_number' : 'wire_account_number';

  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('crm_invoice_settings')
    .select(columnName)
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    // Generic error — never log the secret or the column name in a way that reveals data
    return NextResponse.json({ error: 'Unable to retrieve the requested value.' }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: 'Settings not found.' }, { status: 404 });
  }

  const secretValue: string = (data as Record<string, string>)[columnName] ?? '';

  if (!secretValue) {
    return NextResponse.json({ error: 'No value is set for this field.' }, { status: 404 });
  }

  // 4. Return ONLY the requested secret — never log it
  // Cache-Control: no-store prevents browser/proxy caching of the full secret
  return NextResponse.json(
    { value: secretValue },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
