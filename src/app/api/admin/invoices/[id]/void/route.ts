import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/server/adminAuth';

// ============================================================
// POST /api/admin/invoices/[id]/void
//
// SECURITY MODEL:
//   1. Authentication via centralized requireAdmin() — app_metadata.role === 'admin'
//   2. Invoice UUID from route params only — never from request body
//   3. Admin UUID server-derived from requireAdmin() — never from browser
//   4. Request body allowlist: only void_reason accepted
//   5. All financial/lifecycle mutation via void_invoice() RPC only
//   6. Service-role client — no anon key fallback
//   7. No direct crm_invoices INSERT/UPDATE
//   8. No direct activity/audit writes
//   9. No direct payment writes
//  10. Cache-Control: private, no-store, max-age=0 on ALL responses
// ============================================================

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

// UUID v4 validation — same pattern used by existing invoice payment/revision APIs
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Fail closed — never degrade to anon key
  if (!url || !key) {
    throw new Error('Service role client configuration is missing.');
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── RPC error token → safe HTTP response mapping ──────────────────────────────

interface RpcErrorMapping {
  status: number;
  message: string;
}

const RPC_ERROR_MAP: Record<string, RpcErrorMapping> = {
  admin_not_authorized: {
    status: 403,
    message: 'You are not authorized to void this invoice.',
  },
  void_reason_required: {
    status: 400,
    message: 'Void reason is required.',
  },
  invoice_not_found: {
    status: 404,
    message: 'Invoice not found.',
  },
  invoice_not_voidable: {
    status: 409,
    message: 'This invoice cannot be voided.',
  },
  invoice_has_received_payments: {
    status: 409,
    message: 'Invoices with received payments cannot be voided.',
  },
  active_revision_exists: {
    status: 409,
    message: 'This invoice has an active revision and cannot be voided.',
  },
  invoice_already_void: {
    status: 409,
    message: 'This invoice has already been voided.',
  },
};

function mapRpcError(errorMessage: string): RpcErrorMapping {
  for (const [token, mapping] of Object.entries(RPC_ERROR_MAP)) {
    if (errorMessage.includes(token)) {
      return mapping;
    }
  }
  return {
    status: 500,
    message: 'An unexpected error occurred. Please try again.',
  };
}

// ── RPC success contract validation ──────────────────────────────────────────

interface VoidInvoiceRpcResult {
  success: boolean;
  idempotent_replay: boolean;
  invoice: {
    id: string;
    invoice_number: string;
    status: string;
    void_reason: string;
    voided_at: string;
    voided_by: string;
    total_cents: number;
  };
  payment_summary: {
    amount_paid_cents: number;
    balance_remaining_cents: number;
  };
}

function isValidRpcResult(data: unknown): data is VoidInvoiceRpcResult {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;

  if (d.success !== true) return false;
  if (typeof d.idempotent_replay !== 'boolean') return false;

  const inv = d.invoice as Record<string, unknown> | undefined;
  if (!inv || typeof inv !== 'object') return false;
  if (typeof inv.id !== 'string') return false;
  if (typeof inv.invoice_number !== 'string') return false;
  if (inv.status !== 'void') return false;
  if (typeof inv.void_reason !== 'string') return false;
  if (typeof inv.voided_at !== 'string') return false;
  if (typeof inv.total_cents !== 'number') return false;

  const ps = d.payment_summary as Record<string, unknown> | undefined;
  if (!ps || typeof ps !== 'object') return false;
  if (typeof ps.amount_paid_cents !== 'number') return false;
  if (typeof ps.balance_remaining_cents !== 'number') return false;

  return true;
}

// ── POST /api/admin/invoices/[id]/void ───────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // ── 1. Authentication ─────────────────────────────────────────────────────
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Unauthorized.' },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  // ── 2. Invoice UUID from route params only ────────────────────────────────
  const { id: invoiceId } = await params;
  if (!invoiceId || !isValidUUID(invoiceId)) {
    return NextResponse.json(
      { error: 'Invalid invoice ID.' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // ── 3. Parse and validate request body ───────────────────────────────────
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body.' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return NextResponse.json(
      { error: 'Invalid request body.' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // ── 4. Explicit allowlist — only void_reason is accepted ─────────────────
  const ALLOWED_FIELDS = new Set(['void_reason']);
  const suppliedFields = Object.keys(rawBody);
  const unexpectedFields = suppliedFields.filter((f) => !ALLOWED_FIELDS.has(f));
  if (unexpectedFields.length > 0) {
    return NextResponse.json(
      { error: 'Invalid request body.' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // ── 5. void_reason validation ─────────────────────────────────────────────
  const rawVoidReason = rawBody.void_reason;

  if (rawVoidReason === undefined || rawVoidReason === null) {
    return NextResponse.json(
      { error: 'Void reason is required.' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  if (typeof rawVoidReason !== 'string') {
    return NextResponse.json(
      { error: 'Void reason is required.' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const normalizedVoidReason = rawVoidReason.trim();
  if (normalizedVoidReason.length === 0) {
    return NextResponse.json(
      { error: 'Void reason is required.' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // ── 6. Service-role client — fail closed ──────────────────────────────────
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  // ── 7. Call void_invoice RPC — the ONLY mutation path ────────────────────
  // p_admin_user_id comes exclusively from admin.id (server-derived).
  // invoiceId comes exclusively from route params.
  // normalizedVoidReason is trimmed and validated above.
  const { data: rpcData, error: rpcError } = await supabase.rpc('void_invoice', {
    p_invoice_id: invoiceId,
    p_admin_user_id: admin.id,
    p_void_reason: normalizedVoidReason,
  });

  // ── 8. RPC error mapping ──────────────────────────────────────────────────
  if (rpcError) {
    const mapped = mapRpcError(rpcError.message ?? '');
    return NextResponse.json(
      { error: mapped.message },
      { status: mapped.status, headers: NO_STORE_HEADERS }
    );
  }

  // ── 9. Validate RPC success contract ─────────────────────────────────────
  if (!isValidRpcResult(rpcData)) {
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  // ── 10. Build safe browser response — no voided_by, no admin identity ─────
  // Explicitly construct the response — never spread the full RPC result.
  const safeResponse = {
    success: true,
    idempotent_replay: rpcData.idempotent_replay,
    invoice: {
      id: rpcData.invoice.id,
      invoice_number: rpcData.invoice.invoice_number,
      status: rpcData.invoice.status,
      void_reason: rpcData.invoice.void_reason,
      voided_at: rpcData.invoice.voided_at,
      total_cents: rpcData.invoice.total_cents,
      // voided_by is intentionally excluded from the browser response
    },
    payment_summary: {
      amount_paid_cents: rpcData.payment_summary.amount_paid_cents,
      balance_remaining_cents: rpcData.payment_summary.balance_remaining_cents,
    },
  };

  return NextResponse.json(safeResponse, {
    status: 200,
    headers: NO_STORE_HEADERS,
  });
}
