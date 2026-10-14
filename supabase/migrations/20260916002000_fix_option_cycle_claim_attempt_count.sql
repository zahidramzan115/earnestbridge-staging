-- ============================================================
-- Migration: 20260916002000_fix_option_cycle_claim_attempt_count
--
-- PURPOSE
-- -------
-- Step 5D-2.9b / Step 5D-2.9c Fix: Correct attempt_count semantics
-- and replace claim_option_cycle_automation_event() with a version
-- that increments attempt_count exactly once per provider delivery
-- attempt, at claim authorization time.
--
-- PROBLEM (old behavior — double-increment bug)
-- ---------------------------------------------
-- The previous version of claim_option_cycle_automation_event()
-- inserted with attempt_count = 0 on initial claim, then a separate
-- increment_automation_log_attempt RPC was called from markLogFailed()
-- after each provider failure. The claim RPC also incremented on
-- retry_claimed. This caused double-incrementing:
--
--   Attempt 1: initial claim → attempt_count = 0
--              provider fails → markLogFailed increments → attempt_count = 1
--   Attempt 2: retry_claimed → claim RPC increments → attempt_count = 2
--              provider fails → markLogFailed increments → attempt_count = 3
--   Attempt 3: attempt_count >= 3 → max_attempts_reached
--
-- Result: only 2 actual provider delivery attempts allowed when max is 3.
--
-- CORRECT SEMANTICS
-- -----------------
-- attempt_count = number of actual email delivery attempts initiated.
-- It must increase exactly ONCE per provider delivery attempt.
--
-- The canonical increment point is the claim authorization:
--   - claimed (initial):  INSERT with attempt_count = 1
--   - retry_claimed:      UPDATE attempt_count = attempt_count + 1
--
-- markLogFailed() in the worker must NOT call any increment RPC.
-- The increment_automation_log_attempt helper RPC is no longer needed.
--
-- CORRECT STATE MACHINE
-- ---------------------
-- Attempt 1:
--   claim → attempt_count = 1, status = pending
--   provider called
--   provider fails → markLogFailed → status = failed, attempt_count = 1 (unchanged)
--
-- Attempt 2:
--   retry_claimed → attempt_count = 2, status = pending
--   provider called
--   provider fails → markLogFailed → status = failed, attempt_count = 2 (unchanged)
--
-- Attempt 3:
--   retry_claimed → attempt_count = 3, status = pending
--   provider called
--   provider fails → markLogFailed → status = failed, attempt_count = 3 (unchanged)
--
-- Attempt 4:
--   attempt_count >= 3 → max_attempts_reached → provider NOT called
--
-- Success (any attempt):
--   claim → attempt_count incremented
--   provider called
--   provider succeeds → markLogSent → status = sent, completed_at = now()
--   Subsequent claim → already_done → provider NOT called
--
-- LEGACY ROW HANDLING
-- -------------------
-- Existing row 30c677e6-c156-46f1-a243-f09da9f9bf3b:
--   status = failed, attempt_count = 0
-- This row was created before corrected counting semantics.
-- Under the new claim RPC, retry_claimed will increment 0 → 1.
-- The next actual provider attempt will count as attempt 1.
-- This is acceptable — do not fabricate historical counts.
-- Do NOT delete or replace this row.
--
-- MIGRATION ACTIONS
-- -----------------
-- 1. Replace claim_option_cycle_automation_event() with corrected version
--    that increments attempt_count on BOTH claimed (INSERT with 1) AND
--    retry_claimed (UPDATE attempt_count + 1).
-- 2. DROP FUNCTION IF EXISTS increment_automation_log_attempt(uuid) —
--    this helper is no longer needed and its existence would encourage
--    re-introducing the double-increment bug. Safe DROP IF EXISTS used
--    because this function may never have existed in production.
-- ============================================================

-- ─── 1. REPLACE claim_option_cycle_automation_event ──────────────────────────
--
-- KEY CHANGE: attempt_count is now incremented on initial INSERT (claimed)
-- as well as on retry (retry_claimed). This means attempt_count always equals
-- the number of provider delivery attempts that have been authorized.
--
-- SECURITY: SECURITY DEFINER + SET search_path = public, pg_catalog
-- CONCURRENCY: SELECT ... FOR UPDATE prevents concurrent reclaim race
-- STALE LEASE: 15 minutes
-- MAX ATTEMPTS: 3
--
-- SIGNATURE (preserved — callers must not change):
--   claim_option_cycle_automation_event(
--     p_cycle_id         uuid,
--     p_application_id   uuid,
--     p_event_type       text,
--     p_deadline_snapshot date,
--     p_dedupe_key       text
--   )
--   RETURNS TABLE(result text, log_id uuid)
--
-- RESULT CONTRACT (preserved):
--   claimed            — new row inserted, attempt_count = 1
--   already_done       — existing sent/completed row; skip
--   currently_claimed  — active pending (fresh lease < 15 min); skip
--   retry_claimed      — stale pending reclaimed OR failed retried; attempt_count incremented
--   max_attempts_reached — attempt_count >= 3; skip, Admin must investigate

CREATE OR REPLACE FUNCTION public.claim_option_cycle_automation_event(
  p_cycle_id         uuid,
  p_application_id   uuid,
  p_event_type       text,
  p_deadline_snapshot date,
  p_dedupe_key       text
)
RETURNS TABLE(result text, log_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row   public.option_cycle_automation_log%ROWTYPE;
  v_now   timestamptz    := now();
  v_lease interval       := interval '15 minutes';
  v_max_attempts integer := 3;
  v_new_id uuid;
BEGIN
  -- Lock the existing row if it exists (prevents concurrent reclaim race)
  SELECT * INTO v_row
  FROM public.option_cycle_automation_log
  WHERE dedupe_key = p_dedupe_key
  FOR UPDATE;

  IF NOT FOUND THEN
    -- No existing row → insert new claim.
    -- attempt_count starts at 1 because we are authorizing the first
    -- actual provider delivery attempt right now.
    INSERT INTO public.option_cycle_automation_log (
      cycle_id, application_id, event_type, deadline_snapshot,
      dedupe_key, status, attempt_count, claimed_at
    ) VALUES (
      p_cycle_id, p_application_id, p_event_type, p_deadline_snapshot,
      p_dedupe_key, 'pending', 1, v_now
    )
    RETURNING id INTO v_new_id;

    RETURN QUERY SELECT 'claimed'::text, v_new_id;
    RETURN;
  END IF;

  -- Row exists — determine outcome based on current state

  IF v_row.status IN ('sent', 'completed') THEN
    -- Successfully completed event → skip
    RETURN QUERY SELECT 'already_done'::text, v_row.id;
    RETURN;
  END IF;

  IF v_row.status = 'pending' THEN
    IF v_row.claimed_at IS NOT NULL AND (v_now - v_row.claimed_at) < v_lease THEN
      -- Active pending with fresh lease → another worker owns it
      RETURN QUERY SELECT 'currently_claimed'::text, v_row.id;
      RETURN;
    ELSE
      -- Stale pending (lease expired or claimed_at NULL) → reclaim if under max attempts
      IF v_row.attempt_count >= v_max_attempts THEN
        RETURN QUERY SELECT 'max_attempts_reached'::text, v_row.id;
        RETURN;
      END IF;
      -- Atomically reclaim and increment attempt_count for the new provider attempt
      UPDATE public.option_cycle_automation_log
      SET
        claimed_at    = v_now,
        attempt_count = attempt_count + 1,
        last_error    = NULL,
        updated_at    = v_now
      WHERE id = v_row.id;
      RETURN QUERY SELECT 'retry_claimed'::text, v_row.id;
      RETURN;
    END IF;
  END IF;

  IF v_row.status = 'failed' THEN
    IF v_row.attempt_count >= v_max_attempts THEN
      -- Permanently failed → skip, Admin must investigate
      RETURN QUERY SELECT 'max_attempts_reached'::text, v_row.id;
      RETURN;
    END IF;
    -- Retryable failed event → reclaim and increment attempt_count for the new provider attempt
    UPDATE public.option_cycle_automation_log
    SET
      status        = 'pending',
      claimed_at    = v_now,
      attempt_count = attempt_count + 1,
      last_error    = NULL,
      updated_at    = v_now
    WHERE id = v_row.id;
    RETURN QUERY SELECT 'retry_claimed'::text, v_row.id;
    RETURN;
  END IF;

  -- Fallback (should not reach here under normal operation)
  RETURN QUERY SELECT 'already_done'::text, v_row.id;
END;
$$;

-- Grant execute to service_role (preserves existing execution permissions)
GRANT EXECUTE ON FUNCTION public.claim_option_cycle_automation_event(uuid, uuid, text, date, text)
  TO service_role;

-- ─── 2. SAFE DROP OF OBSOLETE HELPER ─────────────────────────────────────────
--
-- increment_automation_log_attempt(uuid) was used by markLogFailed() to
-- increment attempt_count after a provider failure. Under the corrected
-- semantics, attempt_count is incremented only at claim time (above).
-- markLogFailed() must NOT call any increment RPC.
--
-- DROP FUNCTION IF EXISTS is used because this function may never have
-- existed in production (it was added in a migration that was discarded
-- before being pushed). Using IF EXISTS prevents failure when absent.

DROP FUNCTION IF EXISTS public.increment_automation_log_attempt(uuid);

-- ─── 3. CANONICAL CLAIM MODEL DOCUMENTATION ──────────────────────────────────
--
-- attempt_count SEMANTICS (canonical, post-fix):
--   attempt_count = number of actual email delivery attempts authorized.
--   Incremented exactly once per provider attempt, at claim time.
--
-- CLAIM FLOW (corrected):
--   1. Call claim_option_cycle_automation_event(...) → (result, log_id)
--   2. If result = 'claimed':       attempt_count = 1  (first attempt authorized)
--      If result = 'retry_claimed': attempt_count = N+1 (Nth retry authorized)
--   3. Perform the provider call (send email)
--   4. On success: UPDATE status = 'sent', completed_at = now()
--                  attempt_count unchanged (already reflects this attempt)
--   5. On failure: UPDATE status = 'failed', last_error = message
--                  attempt_count unchanged (already reflects this attempt)
--                  DO NOT call any increment RPC
--   6. If result = 'already_done' / 'currently_claimed' / 'max_attempts_reached'
--      → skip, do not perform provider call
--
-- RETRY GATE:
--   failed + attempt_count < 3  → retry_claimed allowed
--   failed + attempt_count >= 3 → max_attempts_reached
--
-- CONCURRENT SAFETY:
--   SELECT ... FOR UPDATE inside the RPC prevents two workers from
--   simultaneously reclaiming the same stale/failed row.
--   One row per dedupe key enforced by UNIQUE constraint on dedupe_key.
--
-- EXISTING FAILED ROW (30c677e6-c156-46f1-a243-f09da9f9bf3b):
--   status = failed, attempt_count = 0 (pre-fix legacy row)
--   Next retry_claimed will increment 0 → 1.
--   Row is retryable. Do NOT delete or replace it.
