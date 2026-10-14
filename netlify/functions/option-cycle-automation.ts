/**
 * Netlify Scheduled Function — Option Cycle Automation
 *
 * Schedule: hourly  (0 * * * *)
 *
 * This function is the PRODUCTION scheduler for the Option Exercise
 * automation. It calls the shared worker directly — it does NOT bounce
 * through the public /api/option-cycle-automation HTTP endpoint.
 *
 * ACTIVATION GATE:
 *   OPTION_CYCLE_AUTOMATION_ENABLED=true  → live sends + auto-close
 *   absent / false / any other value      → no sends, no closes
 *
 * FAIL CLOSED:
 *   Missing or placeholder SUPABASE_SERVICE_ROLE_KEY → worker refuses to run.
 *   No anon-key fallback.
 *
 * BUSINESS LOGIC:
 *   All reminder cadence, cutoff, idempotency, and closeout rules live in
 *   src/lib/optionCycleWorker.ts — do NOT duplicate them here.
 *
 * SECURITY:
 *   Netlify Scheduled Functions execute server-side internally.
 *   No public HTTP authentication is required for the scheduler itself.
 *   The CRON_SECRET is only needed for the manual Admin HTTP endpoint
 *   (POST /api/option-cycle-automation).
 */

import type { Config, Context } from '@netlify/functions';
import { runOptionCycleAutomation } from '../../src/lib/optionCycleWorker';

// ── Known placeholder values treated as MISSING ───────────────────────────────

const KNOWN_PLACEHOLDERS = [
  'your-supabase-service-role-key-here',
  'placeholder',
  'changeme',
  'todo',
];

function isServiceRolePlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return KNOWN_PLACEHOLDERS.some(p => lower === p || lower.startsWith('your-'));
}

// ── Netlify Scheduled Function handler ───────────────────────────────────────

export default async function handler(req: Request, context: Context) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Fail closed: service role key must be present, non-empty, and not a placeholder
  if (!serviceRoleKey || serviceRoleKey.trim() === '' || isServiceRolePlaceholder(serviceRoleKey)) {
    console.error('[option-cycle-automation] FATAL: SUPABASE_SERVICE_ROLE_KEY is missing or not configured. Worker will not run.');
    return new Response(
      JSON.stringify({ error: 'Required server environment variable is not configured.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Automation gate: only live when exact string 'true'
  const automationEnabled = process.env.OPTION_CYCLE_AUTOMATION_ENABLED === 'true';

  console.log(`[option-cycle-automation] Netlify scheduled execution. automationEnabled=${automationEnabled}`);

  try {
    // Call the shared worker directly — no HTTP round-trip
    // When automationEnabled=false, the worker runs in dry-run mode:
    //   no emails sent, no Deals closed, no cycles marked missed
    const result = await runOptionCycleAutomation({ dryRun: !automationEnabled });

    console.log('[option-cycle-automation] Worker completed.', JSON.stringify(result, null, 2));

    return new Response(
      JSON.stringify({ success: true, automationEnabled, ...result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[option-cycle-automation] Worker threw an unhandled error:', err?.message ?? err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Netlify schedule configuration ───────────────────────────────────────────
// Runs every hour at minute 0.

export const config: Config = {
  schedule: '0 * * * *',
};
