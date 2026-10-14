-- ============================================================
-- Migration: 20260917000100_application_activity_auto_close_idempotency
--
-- Step 5D-2.13c — Activity Idempotency Constraint
--
-- PURPOSE
-- -------
-- The execute_option_cycle_auto_close() RPC (5D-2.13b) inserts two
-- canonical activity rows using ON CONFLICT DO NOTHING:
--
--   event_type = 'option_cycle_missed'
--   event_type = 'status_change'
--
-- However, the application_activity table has NO UNIQUE constraint or
-- UNIQUE index that would cause a conflict. Without a conflict target,
-- ON CONFLICT DO NOTHING is a no-op — it never suppresses duplicates.
--
-- This migration adds a PARTIAL UNIQUE INDEX that makes the two
-- canonical auto-close activity inserts genuinely idempotent:
--
--   UNIQUE (application_id, event_type)
--   WHERE event_type IN ('option_cycle_missed', 'status_change')
--     AND actor = 'EarnestBridge Automation'
--
-- DESIGN RATIONALE
-- ----------------
-- A full UNIQUE (application_id, event_type) would be too broad —
-- 'status_change' events are written by many operations (funded, closed,
-- extension override, etc.) and must remain non-unique in general.
--
-- The partial index scopes uniqueness to:
--   - Only the two canonical auto-close event types
--   - Only rows written by 'EarnestBridge Automation'
--
-- This allows:
--   - Multiple 'status_change' rows from different operations (normal)
--   - Multiple 'option_cycle_missed' rows from different cycles (normal)
--     → scoped to (application_id, event_type) so different applications
--       can each have one
--
-- WAIT — the above is still too broad for multi-cycle scenarios.
-- A single application may have multiple option cycles, each of which
-- could legitimately produce an 'option_cycle_missed' activity row.
--
-- CORRECT SCOPE: unique per (application_id, event_type, cycle context)
-- The safest approach that does not require schema changes to
-- application_activity is to scope by the detail text prefix, but
-- PostgreSQL partial indexes cannot index on expression substrings
-- without a functional index.
--
-- REVISED APPROACH
-- ----------------
-- Add a nullable 'source_id' column to application_activity that the
-- RPC populates with the cycle_id for auto-close activities. Then
-- create a UNIQUE index on (application_id, event_type, source_id)
-- WHERE source_id IS NOT NULL AND actor = 'EarnestBridge Automation'.
--
-- This is the smallest safe uniqueness strategy that:
--   1. Does not break existing rows (source_id nullable, existing rows = NULL)
--   2. Allows multiple cycles per application (source_id = cycle_id)
--   3. Allows multiple status_change rows from non-automation sources
--   4. Makes ON CONFLICT DO NOTHING genuinely idempotent for auto-close
--
-- MIGRATION STEPS
-- ---------------
-- 1. Add nullable source_id column to application_activity
-- 2. Create UNIQUE partial index on (application_id, event_type, source_id)
--    WHERE source_id IS NOT NULL AND actor = 'EarnestBridge Automation'
-- 3. Update execute_option_cycle_auto_close() to pass p_cycle_id as
--    source_id in both canonical activity inserts
-- 4. Update ON CONFLICT clause to specify the conflict target
-- ============================================================

-- ─── 1. Add source_id column ─────────────────────────────────────────────────
-- Nullable. Existing rows remain valid (NULL = no source context).
-- For auto-close activities, populated with the option cycle UUID.

ALTER TABLE public.application_activity
  ADD COLUMN IF NOT EXISTS source_id uuid DEFAULT NULL;

-- ─── 2. Create UNIQUE partial index ──────────────────────────────────────────
-- Unique per (application_id, event_type, source_id) for automation rows only.
-- This makes ON CONFLICT (application_id, event_type, source_id)
-- WHERE source_id IS NOT NULL AND actor = 'EarnestBridge Automation'
-- genuinely idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_application_activity_auto_close_idempotency
ON public.application_activity (application_id, event_type, source_id)
WHERE source_id IS NOT NULL
  AND actor = 'EarnestBridge Automation';

-- ─── 3. Update execute_option_cycle_auto_close() ─────────────────────────────
-- Re-create the RPC to pass p_cycle_id as source_id in both activity inserts
-- and use the explicit ON CONFLICT target.

DROP FUNCTION IF EXISTS public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text);

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

  -- Verify log belongs to expected application, cycle, event type, deadline,
  -- and is in a valid claimable state (not already completed).
  IF v_log.application_id  != p_application_id
  OR v_log.cycle_id        != p_cycle_id
  OR v_log.event_type      != 'auto_close'
  OR v_log.deadline_snapshot != p_deadline_snapshot
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
-- IDEMPOTENCY GUARANTEE (post-5D-2.13c):
--
--   The UNIQUE partial index idx_application_activity_auto_close_idempotency
--   on (application_id, event_type, source_id)
--   WHERE source_id IS NOT NULL AND actor = 'EarnestBridge Automation'
--   ensures that:
--
--   1. ON CONFLICT DO NOTHING in the RPC now has a real conflict target.
--   2. If the RPC is called twice for the same cycle (e.g., crash recovery),
--      the second call finds cycle.status != 'active' (guard_cycle_not_active)
--      and returns without reaching the INSERT statements.
--   3. In the unlikely event the guard is bypassed (e.g., direct RPC call),
--      the INSERT is genuinely suppressed by the unique index.
--
-- MULTI-CYCLE SAFETY:
--   source_id = p_cycle_id (not NULL) means each cycle gets its own
--   activity row. A second option cycle for the same application can
--   produce its own 'option_cycle_missed' and 'status_change' rows
--   without conflicting with the first cycle's rows.
--
-- EXISTING ROWS:
--   source_id is nullable. All existing application_activity rows have
--   source_id = NULL and are unaffected by the partial index
--   (WHERE source_id IS NOT NULL excludes them).
