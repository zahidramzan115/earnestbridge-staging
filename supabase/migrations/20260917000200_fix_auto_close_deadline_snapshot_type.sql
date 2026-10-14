-- ============================================================
-- Migration: 20260917000200_fix_auto_close_deadline_snapshot_type
--
-- Step 5D-2.14c — Fix auto_close RPC date/text type mismatch
--
-- ROOT CAUSE
-- ----------
-- The deployed execute_option_cycle_auto_close() RPC (from migration
-- 20260917000100) contains the following comparison inside the
-- automation log verification block:
--
--   v_log.deadline_snapshot != p_deadline_snapshot
--
-- The column option_cycle_automation_log.deadline_snapshot is type DATE.
-- The parameter p_deadline_snapshot is type TEXT.
--
-- PostgreSQL does not have an implicit cast from TEXT to DATE for the
-- <> operator, so the comparison raises:
--
--   operator does not exist: date <> text
--
-- This caused the known failed auto_close row:
--   id: 6ace1d0b-c690-4afd-b334-cb208289548e
--   status: failed
--   attempt_count: 1
--   last_error: execute_option_cycle_auto_close RPC error:
--               operator does not exist: date <> text
--
-- FIX
-- ---
-- Keep the existing RPC signature unchanged:
--   p_deadline_snapshot text
--
-- The worker and diagnostic route already pass the canonical ISO date
-- string '2026-09-22'. No worker contract change is needed.
--
-- Inside the RPC, explicitly cast p_deadline_snapshot to DATE wherever
-- it is compared against a DATE column:
--
--   v_log.deadline_snapshot != p_deadline_snapshot::date
--
-- The to_date() call in step 8 (display formatting) already handles
-- the TEXT → DATE conversion correctly and is unchanged.
--
-- COLUMN TYPES VERIFIED
-- ---------------------
-- option_cycle_automation_log.deadline_snapshot  : DATE
-- p_deadline_snapshot parameter                  : TEXT
-- Fix: p_deadline_snapshot::date in all DATE comparisons
--
-- SIGNATURE UNCHANGED
-- -------------------
-- execute_option_cycle_auto_close(
--   p_cycle_id            uuid,
--   p_application_id      uuid,
--   p_cutoff_at           timestamptz,
--   p_automation_log_id   uuid,
--   p_deadline_snapshot   text        ← unchanged
-- )
--
-- ALL EXISTING HARDENING PRESERVED
-- ---------------------------------
-- - automation log row lock/guards (5 checks)
-- - cycle FOR UPDATE
-- - Deal FOR UPDATE
-- - write-time timeliness recheck
-- - cycle active → missed
-- - Deal funded → closed
-- - auto_close log → completed
-- - completed_at set
-- - both application_activity inserts with source_id
-- - source_id idempotency (idx_application_activity_auto_close_idempotency)
-- - explicit ON CONFLICT (application_id, event_type, source_id) DO NOTHING
--
-- RETRYABLE ROW
-- -------------
-- The existing failed row (6ace1d0b-c690-4afd-b334-cb208289548e) is
-- canonical and retryable. It must NOT be deleted or modified.
-- After this migration is applied, the next retry claim will return
-- retry_claimed with attempt_count=2, and the corrected RPC will
-- succeed.
--
-- DATABASE WRITES DURING IMPLEMENTATION: 0
-- EMAILS SENT DURING IMPLEMENTATION: 0
-- ============================================================

-- ─── Drop current deployed version ───────────────────────────────────────────
-- Drop the 5-argument version deployed by 20260917000100 to replace it.
-- No overload ambiguity: only one 5-argument signature exists.

DROP FUNCTION IF EXISTS public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text);

-- ─── CREATE execute_option_cycle_auto_close (5D-2.14c — date cast fix) ───────

CREATE OR REPLACE FUNCTION public.execute_option_cycle_auto_close(
  p_cycle_id            uuid,
  p_application_id      uuid,
  p_cutoff_at           timestamptz,
  p_automation_log_id   uuid,
  p_deadline_snapshot   text
)
RETURNS TABLE(result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cycle      public.crm_deal_option_cycles%ROWTYPE;
  v_deal       public.borrower_applications%ROWTYPE;
  v_log        public.option_cycle_automation_log%ROWTYPE;
  v_exercise_ts   timestamptz;
  v_amendment_ts  timestamptz;
  v_deadline_display text;
BEGIN
  -- ── 1. Lock and verify automation log row ────────────────────────────────
  SELECT * INTO v_log
  FROM public.option_cycle_automation_log
  WHERE id = p_automation_log_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'guard_log_not_found'::text;
    RETURN;
  END IF;

  -- Verify log belongs to expected application, cycle, event type, and deadline.
  --
  -- FIX (5D-2.14c): deadline_snapshot column is type DATE.
  -- p_deadline_snapshot is type TEXT.
  -- Cast p_deadline_snapshot::date to match the column type.
  -- This resolves: operator does not exist: date <> text
  --
  IF v_log.application_id  != p_application_id
  OR v_log.cycle_id        != p_cycle_id
  OR v_log.event_type      != 'auto_close'
  OR v_log.deadline_snapshot != p_deadline_snapshot::date
  OR v_log.status NOT IN ('pending', 'claimed', 'failed')
  THEN
    RETURN QUERY SELECT 'guard_log_invalid'::text;
    RETURN;
  END IF;

  -- ── 2. Lock cycle row (prevents concurrent double-close) ─────────────────
  SELECT * INTO v_cycle
  FROM public.crm_deal_option_cycles
  WHERE id = p_cycle_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'guard_cycle_not_found'::text;
    RETURN;
  END IF;

  -- ── 3. Verify cycle belongs to the expected application ──────────────────
  IF v_cycle.application_id != p_application_id THEN
    RETURN QUERY SELECT 'guard_app_mismatch'::text;
    RETURN;
  END IF;

  -- ── 4. Verify cycle is still active ──────────────────────────────────────
  IF v_cycle.status != 'active' THEN
    RETURN QUERY SELECT 'guard_cycle_not_active'::text;
    RETURN;
  END IF;

  -- ── 5. Re-verify timeliness at write time ────────────────────────────────
  -- Use canonical fields first; fall back to legacy fields.
  -- Timely = timestamp IS NOT NULL AND timestamp <= p_cutoff_at
  -- (exactly at cutoff is still timely — not eligible for auto-close)
  v_exercise_ts  := COALESCE(v_cycle.actual_option_exercised_at,  v_cycle.option_exercised_at);
  v_amendment_ts := COALESCE(v_cycle.actual_amendment_received_at, v_cycle.extension_psa_amendment_received_at);

  IF (v_exercise_ts IS NOT NULL AND v_exercise_ts <= p_cutoff_at)
     OR (v_amendment_ts IS NOT NULL AND v_amendment_ts <= p_cutoff_at)
  THEN
    RETURN QUERY SELECT 'guard_cycle_satisfied'::text;
    RETURN;
  END IF;

  -- ── 6. Lock deal row ─────────────────────────────────────────────────────
  SELECT * INTO v_deal
  FROM public.borrower_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'guard_deal_not_found'::text;
    RETURN;
  END IF;

  -- ── 7. Verify deal is still funded ───────────────────────────────────────
  IF v_deal.app_status != 'funded' THEN
    RETURN QUERY SELECT 'guard_deal_not_funded'::text;
    RETURN;
  END IF;

  -- ── 8. Build display date for activity messages ───────────────────────────
  -- Format: Mon DD, YYYY (e.g. "Sep 22, 2026")
  -- to_date() already handles TEXT → DATE correctly — no change needed here.
  v_deadline_display := to_char(
    to_date(p_deadline_snapshot, 'YYYY-MM-DD'),
    'Mon DD, YYYY'
  );

  -- ── 9. ATOMIC STATE TRANSITION + LOG COMPLETION + ACTIVITY INSERTS ───────
  -- All five writes happen inside this single PL/pgSQL function body.
  -- PostgreSQL executes the entire function as one transaction.
  -- Either ALL commit or NONE commit.

  -- 9a. Mark cycle missed
  UPDATE public.crm_deal_option_cycles
  SET
    status     = 'missed',
    updated_at = now()
  WHERE id = p_cycle_id
    AND status = 'active';

  -- 9b. Close the deal
  UPDATE public.borrower_applications
  SET
    app_status = 'closed',
    updated_at = now()
  WHERE id = p_application_id
    AND app_status = 'funded';

  -- 9c. Mark auto_close log completed (same transaction)
  UPDATE public.option_cycle_automation_log
  SET
    status       = 'completed',
    completed_at = now(),
    last_error   = NULL
  WHERE id = p_automation_log_id;

  -- 9d. Insert canonical activity: option_cycle_missed
  -- ON CONFLICT target: (application_id, event_type, source_id)
  -- WHERE source_id IS NOT NULL AND actor = 'EarnestBridge Automation'
  -- source_id = p_cycle_id ensures one row per cycle, not one per application.
  INSERT INTO public.application_activity (
    application_id,
    user_id,
    event_type,
    title,
    detail,
    actor,
    source_id
  ) VALUES (
    p_application_id,
    NULL,
    'option_cycle_missed',
    'Option Exercise Deadline missed — Deal auto-closed',
    'Option Exercise Deadline ' || v_deadline_display ||
      ' passed with no timely exercise or signed amendment. CRM Deal auto-closed. Review escrow/return-of-funds process separately.',
    'EarnestBridge Automation',
    p_cycle_id
  )
  ON CONFLICT (application_id, event_type, source_id)
  WHERE source_id IS NOT NULL AND actor = 'EarnestBridge Automation'
  DO NOTHING;

  -- 9e. Insert canonical activity: status_change
  INSERT INTO public.application_activity (
    application_id,
    user_id,
    event_type,
    title,
    detail,
    actor,
    source_id
  ) VALUES (
    p_application_id,
    NULL,
    'status_change',
    'Deal status changed: Funded → Closed',
    'Automatic CRM closeout triggered by missed Option Exercise Deadline (' ||
      v_deadline_display || ').',
    'EarnestBridge Automation',
    p_cycle_id
  )
  ON CONFLICT (application_id, event_type, source_id)
  WHERE source_id IS NOT NULL AND actor = 'EarnestBridge Automation'
  DO NOTHING;

  -- ── 10. Return success ───────────────────────────────────────────────────
  RETURN QUERY SELECT 'success'::text;
END;
$$;

-- ─── GRANT EXECUTE ────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text)
  FROM PUBLIC;

-- ─── DOCUMENTATION ───────────────────────────────────────────────────────────
--
-- TYPE SAFETY SUMMARY (post-5D-2.14c):
--
--   option_cycle_automation_log.deadline_snapshot  : DATE
--   p_deadline_snapshot parameter                  : TEXT
--
--   All comparisons now use p_deadline_snapshot::date, which is
--   type-safe and equivalent to the previous intent.
--
--   The ISO date string '2026-09-22' passed by the worker and
--   diagnostic route casts cleanly to DATE '2026-09-22'.
--
-- RETRYABLE ROW (6ace1d0b-c690-4afd-b334-cb208289548e):
--
--   This row was created by live_auto_close_test when the RPC failed
--   with the date/text mismatch. It is canonical and retryable.
--   After this migration is applied:
--     - claim_option_cycle_automation_event() will return retry_claimed
--     - attempt_count will increment to 2
--     - execute_option_cycle_auto_close() will succeed
--     - cycle → missed, deal → closed, log → completed
--
-- NO WORKER CONTRACT CHANGE:
--   The worker continues to pass p_deadline_snapshot as a TEXT ISO
--   date string. No changes to optionCycleWorker.ts are required.
