/**
 * POST /api/option-cycle-automation
 *
 * Hourly Option Exercise Automation Worker — Step 5D-2 / Step 5D-2.6a Hardened
 *
 * PRODUCTION ACTIVATION GATE:
 *   OPTION_CYCLE_AUTOMATION_ENABLED=true  → live sends + auto-close
 *   absent / false                        → dry-run only
 *
 * SCHEDULER: Runs HOURLY via Netlify Scheduled Function
 *   (netlify/functions/option-cycle-automation.ts)
 *   The Netlify function calls runOptionCycleAutomation() directly —
 *   it does NOT call this HTTP endpoint.
 *
 * SECURITY (5D-2.6a HARDENED):
 *   GET  — requires exact: Authorization: Bearer {CRON_SECRET}
 *          x-vercel-cron-signature is NOT accepted as authentication.
 *          Missing or placeholder CRON_SECRET → 503 (fail closed, worker not called).
 *          Wrong secret → 401.
 *          No header → 401.
 *          GET never accepts evaluation_time override.
 *
 *   POST — AUTH ORDER (5D-2.6a):
 *          1. Check authenticated Admin session FIRST.
 *             If valid Admin → AUTHORIZED immediately.
 *             CRON_SECRET is NOT required and NOT checked for Admin sessions.
 *          2. Only if no valid Admin session: attempt Bearer CRON_SECRET.
 *             If CRON_SECRET is missing/placeholder and no Admin session → 503.
 *             If wrong Bearer and no Admin session → 401.
 *          Anonymous requests → 401.
 *
 *   evaluation_time (5D-2.6a):
 *          ONLY accepted when ALL are true:
 *            - method = POST
 *            - dry_run=true
 *            - authenticated Admin session
 *          Rejected/ignored in all other cases.
 *          Never stored. In-memory only.
 *
 * SERVICE ROLE (5D-2.3 HARDENED):
 *   Worker requires SUPABASE_SERVICE_ROLE_KEY.
 *   Missing, empty, or placeholder → worker fails closed (503).
 *   NO fallback to NEXT_PUBLIC_SUPABASE_ANON_KEY.
 *
 * DRY RUN:
 *   POST /api/option-cycle-automation?dry_run=true
 *   Requires: authenticated Admin session OR exact Bearer CRON_SECRET.
 *   Reports would-send / would-close without performing any action.
 *   Zero writes to option_cycle_automation_log.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { runOptionCycleAutomation } from '@/lib/optionCycleWorker';

// ── Known placeholder values that must be treated as MISSING ─────────────────

const KNOWN_PLACEHOLDERS = [
  'your-cron-secret-here',
  'your-supabase-service-role-key-here',
  'placeholder',
  'changeme',
  'todo',
];

function isPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return KNOWN_PLACEHOLDERS.some(p => lower === p || lower.startsWith('your-') || lower.startsWith('change-'));
}

// ── Validate CRON_SECRET is present, non-empty, and not a placeholder ─────────

function validateCronSecret(): { valid: boolean; secret: string | null } {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() === '' || isPlaceholder(secret)) {
    return { valid: false, secret: null };
  }
  return { valid: true, secret };
}

// ── Exact Bearer comparison — no other auth method accepted ──────────────────

function hasExactBearerSecret(request: Request, secret: string): boolean {
  const authHeader = request.headers.get('authorization');
  // Exact string comparison only. x-vercel-cron-signature is NOT checked here.
  return authHeader === `Bearer ${secret}`;
}

// ── Admin session check ───────────────────────────────────────────────────────

async function isAdminSession(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          },
        },
      }
    );
    const { data: { user } } = await supabase.auth.getUser();
    return user?.app_metadata?.role === 'admin';
  } catch {
    return false;
  }
}

// ── Parse evaluation_time safely ──────────────────────────────────────────────
// Returns a Date if the string is a valid ISO-8601 instant, otherwise null.
// NEVER throws — invalid values are silently ignored.

function parseEvaluationTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  try {
    const dt = new Date(raw);
    if (isNaN(dt.getTime())) return null;
    return dt;
  } catch {
    return null;
  }
}

// ── GET — Manual HTTP trigger (trusted server, no Admin dry-run override) ─────
//
// NOTE: The production hourly scheduler is the Netlify Scheduled Function at
//   netlify/functions/option-cycle-automation.ts
//   which calls runOptionCycleAutomation() directly without hitting this endpoint.
//
// This GET handler remains available for trusted server-side invocation.
// Accepted authentication: Authorization: Bearer {CRON_SECRET} ONLY.
// x-vercel-cron-signature is NOT accepted as authentication.
// If CRON_SECRET is missing/placeholder → 503 (fail closed, worker not called).
// Wrong secret → 401. No header → 401.
// evaluation_time is NEVER accepted on GET.

export async function GET(request: Request) {
  // 1. Validate CRON_SECRET is configured (fail closed if not)
  const { valid, secret } = validateCronSecret();
  if (!valid || !secret) {
    return NextResponse.json(
      { error: 'Required server environment variable is not configured.' },
      { status: 503 }
    );
  }

  // 2. Require exact Bearer CRON_SECRET — no other method accepted
  if (!hasExactBearerSecret(request, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 3. evaluation_time is NEVER accepted on GET — always use real current time
  try {
    const result = await runOptionCycleAutomation({ dryRun: false });
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    // Never expose secret values in error responses
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST — Manual trigger / dry-run ──────────────────────────────────────────
//
// AUTH ORDER (5D-2.6a):
//   1. Check Admin session FIRST. If valid Admin → AUTHORIZED immediately.
//      CRON_SECRET is NOT required for Admin sessions.
//   2. Only if no Admin session: attempt Bearer CRON_SECRET.
//      If CRON_SECRET is missing/placeholder → 503.
//      If wrong Bearer → 401.
//   Anonymous requests → 401.
//
// evaluation_time:
//   ONLY accepted when: POST + dry_run=true + authenticated Admin session.
//   Rejected/ignored for Bearer-only auth, live runs, and GET.

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const isDryRunParam = searchParams.get('dry_run') === 'true';

  // ── Step 1: Check Admin session FIRST ────────────────────────────────────
  // Admin session is checked before CRON_SECRET validation.
  // A valid Admin session authorizes the request immediately.
  // CRON_SECRET is NOT required and NOT checked when Admin session is valid.
  const adminAuthorized = await isAdminSession();

  if (adminAuthorized) {
    // Admin session is valid — authorized immediately, no CRON_SECRET needed.
    try {
      let body: any = {};
      try { body = await request.json(); } catch { /* no body */ }

      const dryRun = isDryRunParam || body.dry_run === true;

      // evaluation_time: ONLY for Admin-session POST dry-run
      // Rejected/ignored for live runs even with Admin session
      let evaluationTime: Date | null = null;
      if (dryRun) {
        const rawEvalTime = searchParams.get('evaluation_time') ?? body.evaluation_time ?? null;
        evaluationTime = parseEvaluationTime(rawEvalTime);
      }
      // If not dry_run, evaluationTime remains null — live runs always use real time

      const result = await runOptionCycleAutomation({
        dryRun,
        evaluationTime: evaluationTime ?? undefined,
      });
      return NextResponse.json({ success: true, ...result });
    } catch (e: any) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  }

  // ── Step 2: No Admin session — attempt Bearer CRON_SECRET ────────────────
  // Only reached when there is no valid Admin session.
  const { valid, secret } = validateCronSecret();
  if (!valid || !secret) {
    // No Admin session AND CRON_SECRET is missing/placeholder → fail closed
    return NextResponse.json(
      { error: 'Required server environment variable is not configured.' },
      { status: 503 }
    );
  }

  if (!hasExactBearerSecret(request, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Bearer CRON_SECRET authorized — but evaluation_time is NOT allowed
  // (evaluation_time is an Admin-session-only testing tool)
  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* no body */ }

    const dryRun = isDryRunParam || body.dry_run === true;

    // evaluation_time is intentionally NOT passed for Bearer-only auth
    const result = await runOptionCycleAutomation({ dryRun });
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    // Never expose secret values in error responses
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
