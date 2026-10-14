import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';


import {
  dispatchInvoiceEmail,
  InvoiceEmailDispatchError,
} from '@/lib/server/invoiceEmail';

// ============================================================
// Admin Invoice Email API
// POST /api/admin/invoices/[id]/email — Manual Send / Retry Invoice Email
//
// SECURITY MODEL:
//   1. Authenticates session via SSR Supabase client
//   2. Verifies app_metadata.role === 'admin'
//   3. Admin UUID sourced exclusively from authenticated session —
//      never from request body
//   4. No delivery data accepted from browser (no recipient, PDF path,
//      idempotency key, provider message ID, amount, due date, etc.)
//
// DISPATCHER:
//   Calls dispatchInvoiceEmail() exactly once per request.
//   The dispatcher and its claim RPC own the full delivery lifecycle.
//
// OUTCOME MAPPING:
//   sent              → 200  { success: true,  outcome: "sent" }
//   already_sent      → 200  { success: true,  outcome: "already_sent" }
//   currently_sending → 409  { success: false, outcome: "currently_sending" }
//   uncertain         → 409  { success: false, outcome: "uncertain" }
//   failed            → 502  { success: false, outcome: "failed" }
//   thrown error      → 500  { success: false, outcome: "error" }
//
// NO RESEND-AFTER-SENT:
//   already_sent returns HTTP 200 with zero provider calls.
//   There is no force/resend/override parameter.
//
// UNCERTAIN IS NON-RETRYABLE:
//   Returns 409 only. Does not reset state, alter delivery row,
//   invoke provider, or create another delivery row.
//
// NO DB WRITES:
//   This route performs no DB writes. All delivery-row changes occur
//   through the dispatcher/RPC pipeline only.
// ============================================================

// ─────────────────────────────────────────────────────────────────────────────
// UUID validation — same pattern as issue/route.ts
// ─────────────────────────────────────────────────────────────────────────────

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSR Supabase client (session-based, for auth only)
// ─────────────────────────────────────────────────────────────────────────────

async function getAuthClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Ignore — read-only context
          }
        },
      },
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/invoices/[id]/email
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // ── 1. AUTHENTICATION ────────────────────────────────────────────────────

  const authClient = await getAuthClient();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized.' },
      { status: 401 }
    );
  }

  if (user.app_metadata?.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Unauthorized.' },
      { status: 401 }
    );
  }

  const adminUserId = user.id;

  // ── 2. VALIDATE INVOICE ID ───────────────────────────────────────────────

  const { id: rawId } = await params;
  const invoiceId = typeof rawId === 'string' ? rawId.trim() : '';

  if (!invoiceId || !isValidUuid(invoiceId)) {
    return NextResponse.json(
      { success: false, error: 'invalid_invoice_id' },
      { status: 400 }
    );
  }

  // ── 3. CALL DISPATCHER (exactly once) ────────────────────────────────────

  try {
    const result = await dispatchInvoiceEmail({ invoiceId, adminUserId });

    // ── 4. OUTCOME MAPPING ─────────────────────────────────────────────────

    switch (result.outcome) {
      // A. sent — delivery completed in this request
      case 'sent':
        return NextResponse.json(
          { success: true, outcome: 'sent' },
          { status: 200 }
        );

      // B. already_sent — no provider call made; idempotent success
      case 'already_sent':
        return NextResponse.json(
          { success: true, outcome: 'already_sent' },
          { status: 200 }
        );

      // C. currently_sending — a claim is in flight; do not retry
      case 'currently_sending':
        return NextResponse.json(
          {
            success: false,
            outcome: 'currently_sending',
            error: 'invoice_email_currently_sending',
          },
          { status: 409 }
        );

      // D. uncertain — non-retryable; Admin must verify manually
      case 'uncertain':
        return NextResponse.json(
          {
            success: false,
            outcome: 'uncertain',
            error: 'invoice_email_delivery_uncertain',
          },
          { status: 409 }
        );

      // E. failed — definite failure; a future request may retry via RPC
      case 'failed':
        return NextResponse.json(
          {
            success: false,
            outcome: 'failed',
            error: 'invoice_email_delivery_failed',
            error_code: result.errorCode ?? null,
          },
          { status: 502 }
        );

      // Exhaustive fallback — should never be reached with a typed outcome
      default: {
        const _exhaustive: never = result.outcome;
        console.error('[invoice-email] Unhandled dispatcher outcome', {
          invoiceId,
          outcome: _exhaustive,
        });
        return NextResponse.json(
          {
            success: false,
            outcome: 'error',
            error: 'invoice_email_dispatch_error',
            error_code: 'INVOICE_EMAIL_DISPATCH_ERROR',
          },
          { status: 500 }
        );
      }
    }
  } catch (err: unknown) {
    // ── 5. THROWN DISPATCH ERRORS ──────────────────────────────────────────

    if (err instanceof InvoiceEmailDispatchError) {
      // Safe log — no recipient, billing data, PDF bytes, secrets, or raw messages
      console.error('[invoice-email] InvoiceEmailDispatchError', {
        invoiceId,
        error_code: err.code,
      });

      return NextResponse.json(
        {
          success: false,
          outcome: 'error',
          error: 'invoice_email_dispatch_error',
          error_code: err.code,
        },
        { status: 500 }
      );
    }

    // Unknown thrown error — safe fallback
    console.error('[invoice-email] Unknown error', {
      invoiceId,
      error_code: 'INVOICE_EMAIL_DISPATCH_ERROR',
    });

    return NextResponse.json(
      {
        success: false,
        outcome: 'error',
        error: 'invoice_email_dispatch_error',
        error_code: 'INVOICE_EMAIL_DISPATCH_ERROR',
      },
      { status: 500 }
    );
  }
}
