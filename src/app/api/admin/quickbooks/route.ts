import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireSuperAdmin } from '@/lib/server/adminAuth';
import {
  disconnect,
  getConnectionStatus,
  QboError,
  testConnection,
} from '@/lib/server/qbo/client';

// GET  /api/admin/quickbooks           Admin: connection status (no tokens)
// POST /api/admin/quickbooks {action}  "test": Admin. "disconnect": SuperAdmin.

export const dynamic = 'force-dynamic';

async function lookupEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data } = await db.auth.admin.getUserById(userId);
  return data.user?.email ?? null;
}

function errorResponse(err: unknown) {
  if (err instanceof QboError) {
    const status = err.code === 'not_configured' ? 500 : err.code === 'not_connected' ? 409 : 502;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[admin/quickbooks]', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    const status = await getConnectionStatus();
    const connectedByEmail = await lookupEmail(status.connected_by);
    return NextResponse.json({ ...status, connected_by_email: connectedByEmail });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { action?: string };

  if (body.action === 'test') {
    const user = await requireAdmin();
    if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    try {
      const result = await testConnection();
      return NextResponse.json({ ok: true, company_name: result.companyName });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (body.action === 'disconnect') {
    const user = await requireSuperAdmin();
    if (!user) return NextResponse.json({ error: 'Only SuperAdmin can disconnect QuickBooks' }, { status: 403 });
    try {
      await disconnect();
      return NextResponse.json({ ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
