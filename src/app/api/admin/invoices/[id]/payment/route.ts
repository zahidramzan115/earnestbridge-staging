import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/server/adminAuth';

// ============================================================
// POST /api/admin/invoices/[id]/payment
//
// Records a bank-wire payment against an invoice by invoking the
// record_invoice_payment SECURITY DEFINER RPC via service_role.
//
// SECURITY MODEL:
//   1. requireAdmin() from centralized adminAuth — no local duplicate
//   2. Invoice ID taken ONLY from the URL — never from the request body
//   3. Admin identity taken ONLY from the authenticated session
//   4. Strict body allowlist — unexpected fields are rejected
//   5. Service-role client used for the financial RPC call
//   6. RPC is the sole financial mutation — no direct INSERT/UPDATE
//   7. Cache-Control: no-store on all responses
// ============================================================

// UUID v4 regex
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Strict ISO-8601 / RFC 3339 full-timestamp validator.
//
// Required format: YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)
// Timezone is REQUIRED — date-only and timezone-less timestamps are rejected.
//
// Validation steps:
//   1. Regex format check — ensures the string matches the expected shape
//   2. Date.parse() finiteness check — ensures the string is parseable
//   3. Calendar component check — rejects invalid dates such as 2026-02-30
//      by comparing the parsed year/month/day back against the input values
//   4. Time component check — rejects out-of-range hour/minute/second values
//
// The future-date business rule is NOT enforced here.
// The deployed RPC (received_at_cannot_be_future) remains authoritative.
function isValidISO8601Timestamp(value: string): boolean {
  // Step 1: Format check.
  // Accepts:
  //   2026-09-30T19:45:00Z
  //   2026-09-30T19:45:00.123Z
  //   2026-09-30T19:45:00-04:00
  //   2026-09-30T19:45:00.123+04:00
  // Rejects:
  //   2026-09-30                  (date-only — no T, no time, no timezone)
  //   2026-09-30T19:45            (no seconds, no timezone)
  //   2026-09-30T19:45:00         (no timezone)
  //   September 30, 2026          (non-ISO)
  //   09/30/2026                  (non-ISO)
  //   2026/09/30                  (non-ISO)
  const STRICT_ISO_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

  if (!STRICT_ISO_RE.test(value.trim())) {
    return false;
  }

  // Step 2: Parseability check.
  const ts = Date.parse(value);
  if (!isFinite(ts)) {
    return false;
  }

  // Step 3: Calendar component validation.
  // Extract year, month (1-based), day directly from the string to avoid
  // JavaScript silently normalising invalid dates (e.g. Feb 30 → Mar 2).
  const datePart = value.substring(0, 10); // "YYYY-MM-DD"
  const [yearStr, monthStr, dayStr] = datePart.split('-');
  const year  = parseInt(yearStr,  10);
  const month = parseInt(monthStr, 10); // 1–12
  const day   = parseInt(dayStr,   10); // 1–31

  // Month must be 1–12.
  if (month < 1 || month > 12) {
    return false;
  }

  // Day must be valid for the given year/month.
  // new Date(year, month - 1, day) uses local time but we only care about
  // whether the calendar date itself is valid — the UTC offset in the
  // original string does not affect this check.
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth()    !== month - 1 ||
    probe.getDate()     !== day
  ) {
    // JavaScript normalised the date (e.g. Feb 30 → Mar 2) — reject it.
    return false;
  }

  // Step 4: Time component validation.
  // Extract HH:mm:ss from the string (positions 11–18).
  const timePart = value.substring(11, 19); // "HH:mm:ss"
  const [hourStr, minuteStr, secondStr] = timePart.split(':');
  const hour   = parseInt(hourStr,   10);
  const minute = parseInt(minuteStr, 10);
  const second = parseInt(secondStr, 10);

  if (hour   < 0 || hour   > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;

  return true;
}

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Known RPC error codes → safe HTTP responses
const RPC_ERROR_MAP: Record<string, { status: number; message: string }> = {
  admin_not_authorized: {
    status: 403,
    message: 'Admin access required.',
  },
  idempotency_key_required: {
    status: 400,
    message: 'Idempotency key is required.',
  },
  amount_must_be_positive: {
    status: 422,
    message: 'Payment amount must be greater than zero.',
  },
  received_at_cannot_be_future: {
    status: 422,
    message: 'Payment received date cannot be in the future.',
  },
  invoice_not_found: {
    status: 404,
    message: 'Invoice not found.',
  },
  invoice_not_payable: {
    status: 409,
    message: 'This invoice is not available for payment.',
  },
  overpayment_rejected: {
    status: 422,
    message: 'Payment amount exceeds the remaining invoice balance.',
  },
  idempotency_key_conflict: {
    status: 409,
    message:
      'This payment request conflicts with an earlier submission. Refresh the invoice and try again.',
  },
};

// Allowed body fields — any other key is rejected
const ALLOWED_BODY_KEYS = new Set([
  'amount_cents',
  'received_at',
  'reference_number',
  'notes',
  'idempotency_key',
]);

// Forbidden body fields that must never be accepted
const FORBIDDEN_BODY_KEYS = [
  'invoice_id',
  'admin_user_id',
  'recorded_by',
  'payment_method',
  'status',
  'currency',
  'provider',
  'provider_payment_id',
  'receipt_pdf_storage_path',
  'receipt_pdf_generated_at',
  'receipt_pdf_hash',
  'paid_at',
  'amount_paid',
  'balance_remaining',
];

const NO_STORE = { 'Cache-Control': 'no-store' };

const MAX_REFERENCE_NUMBER_LENGTH = 255;
const MAX_NOTES_LENGTH = 2000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // ── 1. Authenticate ───────────────────────────────────────────────────────
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Unauthorized.' },
      { status: 401, headers: NO_STORE }
    );
  }

  // ── 2. Validate URL invoice ID ────────────────────────────────────────────
  const { id: invoiceId } = await params;
  if (!isValidUUID(invoiceId)) {
    return NextResponse.json(
      { error: 'Invalid invoice ID.' },
      { status: 400, headers: NO_STORE }
    );
  }

  // ── 3. Parse and validate request body ───────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body.' },
      { status: 400, headers: NO_STORE }
    );
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Request body must be a JSON object.' },
      { status: 400, headers: NO_STORE }
    );
  }

  // Reject forbidden fields
  for (const key of FORBIDDEN_BODY_KEYS) {
    if (key in body) {
      return NextResponse.json(
        { error: `Unexpected field: "${key}".` },
        { status: 400, headers: NO_STORE }
      );
    }
  }

  // Reject unexpected fields
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) {
      return NextResponse.json(
        { error: `Unexpected field: "${key}".` },
        { status: 400, headers: NO_STORE }
      );
    }
  }

  // ── amount_cents ──────────────────────────────────────────────────────────
  const rawAmountCents = body.amount_cents;
  if (rawAmountCents === undefined || rawAmountCents === null) {
    return NextResponse.json(
      { error: 'amount_cents is required.' },
      { status: 400, headers: NO_STORE }
    );
  }
  if (typeof rawAmountCents !== 'number') {
    return NextResponse.json(
      { error: 'amount_cents must be a number.' },
      { status: 400, headers: NO_STORE }
    );
  }
  if (!Number.isInteger(rawAmountCents)) {
    return NextResponse.json(
      { error: 'amount_cents must be an integer (no decimal dollars).' },
      { status: 400, headers: NO_STORE }
    );
  }
  if (!Number.isSafeInteger(rawAmountCents)) {
    return NextResponse.json(
      { error: 'amount_cents is out of safe integer range.' },
      { status: 400, headers: NO_STORE }
    );
  }
  if (rawAmountCents <= 0) {
    return NextResponse.json(
      { error: 'amount_cents must be greater than zero.' },
      { status: 422, headers: NO_STORE }
    );
  }
  const amountCents: number = rawAmountCents;

  // ── idempotency_key ───────────────────────────────────────────────────────
  const rawIdempotencyKey = body.idempotency_key;
  if (rawIdempotencyKey === undefined || rawIdempotencyKey === null) {
    return NextResponse.json(
      { error: 'idempotency_key is required.' },
      { status: 400, headers: NO_STORE }
    );
  }
  if (!isValidUUID(rawIdempotencyKey)) {
    return NextResponse.json(
      { error: 'idempotency_key must be a valid UUID.' },
      { status: 400, headers: NO_STORE }
    );
  }
  const idempotencyKey: string = rawIdempotencyKey;

  // ── received_at ───────────────────────────────────────────────────────────
  let receivedAt: string | null = null;
  if ('received_at' in body) {
    const raw = body.received_at;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string') {
        return NextResponse.json(
          { error: 'received_at must be an ISO-8601 string or null.' },
          { status: 400, headers: NO_STORE }
        );
      }
      if (!isValidISO8601Timestamp(raw)) {
        return NextResponse.json(
          { error: 'received_at must be a valid ISO-8601 timestamp with timezone.' },
          { status: 400, headers: NO_STORE }
        );
      }
      receivedAt = raw;
    }
  }

  // ── reference_number ─────────────────────────────────────────────────────
  let referenceNumber: string | null = null;
  if ('reference_number' in body) {
    const raw = body.reference_number;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string') {
        return NextResponse.json(
          { error: 'reference_number must be a string or null.' },
          { status: 400, headers: NO_STORE }
        );
      }
      const trimmed = raw.trim();
      if (trimmed.length > MAX_REFERENCE_NUMBER_LENGTH) {
        return NextResponse.json(
          {
            error: `reference_number must not exceed ${MAX_REFERENCE_NUMBER_LENGTH} characters.`,
          },
          { status: 400, headers: NO_STORE }
        );
      }
      referenceNumber = trimmed.length > 0 ? trimmed : null;
    }
  }

  // ── notes ─────────────────────────────────────────────────────────────────
  let notes: string | null = null;
  if ('notes' in body) {
    const raw = body.notes;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string') {
        return NextResponse.json(
          { error: 'notes must be a string or null.' },
          { status: 400, headers: NO_STORE }
        );
      }
      const trimmed = raw.trim();
      if (trimmed.length > MAX_NOTES_LENGTH) {
        return NextResponse.json(
          { error: `notes must not exceed ${MAX_NOTES_LENGTH} characters.` },
          { status: 400, headers: NO_STORE }
        );
      }
      notes = trimmed.length > 0 ? trimmed : null;
    }
  }

  // ── 4. Invoke the RPC via service-role client ─────────────────────────────
  const supabase = getServiceClient();

  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'record_invoice_payment',
    {
      p_invoice_id: invoiceId,
      p_admin_user_id: admin.id,
      p_amount_cents: amountCents,
      p_received_at: receivedAt,
      p_reference_number: referenceNumber,
      p_notes: notes,
      p_idempotency_key: idempotencyKey,
    }
  );

  // ── 5. Map RPC errors to safe HTTP responses ──────────────────────────────
  if (rpcError) {
    // Extract machine-readable error code from the PostgreSQL message
    const rawMessage: string = rpcError.message ?? '';
    const errorCode = rawMessage.split(/[\s:]/)[0] ?? '';

    const mapped = RPC_ERROR_MAP[errorCode];
    if (mapped) {
      return NextResponse.json(
        { error: mapped.message },
        { status: mapped.status, headers: NO_STORE }
      );
    }

    // Unknown RPC failure — log a safe diagnostic, return generic 500
    console.error('[payment POST] RPC error:', {
      invoiceId,
      code: rpcError.code ?? null,
      hint: rpcError.hint ?? null,
      // Never log: SQL, stack trace, service-role info, financial secrets
    });

    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500, headers: NO_STORE }
    );
  }

  // ── 6. Return authoritative RPC result ───────────────────────────────────
  // idempotent_replay = true is still HTTP 200 — successful retry
  return NextResponse.json(rpcResult, { status: 200, headers: NO_STORE });
}
