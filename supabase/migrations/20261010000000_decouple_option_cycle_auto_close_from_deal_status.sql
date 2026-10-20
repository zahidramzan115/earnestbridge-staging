-- ============================================================
-- Migration: 20261010000000_decouple_option_cycle_auto_close_from_deal_status
--
-- Phase 7H-5C — Decouple Option Cycle auto-close from Deal status
--
-- BUSINESS RULE
-- -------------
-- A missed Option Exercise Deadline means:
--     Option Cycle = missed
-- It does NOT mean:
--     Deal = closed
--
-- Canonical Deal status "closed" now means EarnestBridge's involvement
-- with the Deal is completed. Closed remains a MANUAL Admin Deal status.
--
-- SOURCE
-- ------
-- Latest effective definition replaced:
--   20260917000200_fix_auto_close_deadline_snapshot_type.sql
--
-- BEHAVIORAL CHANGES (ONLY)
-- -------------------------
-- 1. REMOVED: UPDATE borrower_applications SET app_status = 'closed'
--    (step 9b in the previous version).
-- 2. REMOVED: application_activity insert for
--    'status_change' ("Deal status changed: Funded -> Closed").
-- 3. CHANGED: option_cycle_missed activity title/detail no longer claims
--    the Deal was auto-closed. Wording is Option Cycle only.
--
-- PRESERVED (UNCHANGED)
-- ---------------------
-- - Function signature, parameter names/types, return type
-- - SECURITY DEFINER + SET search_path = public, pg_catalog
-- - Automation log row lock + 5 validation guards
-- - Deadline snapshot comparison (p_deadline_snapshot::date)
-- - Cycle FOR UPDATE lock, app-ownership check, active check
-- - Write-time timeliness recheck
-- - Deal FOR UPDATE lock, deal-not-found guard
-- - guard_deal_not_funded (defense-in-depth: worker automates Funded Deals)
-- - Cycle active -> missed with updated_at = now()
-- - auto_close log -> completed, completed_at = now(), last_error = NULL
-- - option_cycle_missed activity with source_id = p_cycle_id and
--   ON CONFLICT (application_id, event_type, source_id) DO NOTHING
-- - Return value 'success' and all guard_* result strings
-- - GRANT EXECUTE to service_role, REVOKE from PUBLIC
--
-- NOT TOUCHED
-- -----------
-- borrower_applications.app_status, deal_workflow_stage, or any other
-- Deal-status field. After a successful run the expected state is:
--     Deal app_status = funded (unless manually changed by an Admin)
--     Option Cycle status = missed
--
-- DATA WRITES DURING MIGRATION: 0 (function replacement only)
-- ============================================================

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
  -- deadline_snapshot column is type DATE; p_deadline_snapshot is TEXT.
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
  -- The Deal row is locked and validated only. It is NOT modified below.
  SELECT * INTO v_deal
  FROM public.borrower_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'guard_deal_not_found'::text;
    RETURN;
  END IF;

  -- ── 7. Verify deal is still funded ───────────────────────────────────────
  -- Defense-in-depth: the worker intentionally automates active Option
  -- Cycles only for Funded Deals.
  IF v_deal.app_status != 'funded' THEN
    RETURN QUERY SELECT 'guard_deal_not_funded'::text;
    RETURN;
  END IF;

  -- ── 8. Build display date for activity messages ───────────────────────────
  -- Format: Mon DD, YYYY (e.g. "Sep 22, 2026")
  v_deadline_display := to_char(
    to_date(p_deadline_snapshot, 'YYYY-MM-DD'),
    'Mon DD, YYYY'
  );

  -- ── 9. ATOMIC STATE TRANSITION + LOG COMPLETION + ACTIVITY INSERT ────────
  -- All writes happen inside this single PL/pgSQL function body.
  -- PostgreSQL executes the entire function as one transaction.
  -- Either ALL commit or NONE commit.
  --
  -- NOTE: Deal status (app_status / deal_workflow_stage) is intentionally
  -- NOT modified. A missed Option Cycle does not close the Deal.

  -- 9a. Mark cycle missed
  UPDATE public.crm_deal_option_cycles
  SET
    status     = 'missed',
    updated_at = now()
  WHERE id = p_cycle_id
    AND status = 'active';

  -- 9b. Mark auto_close log completed (same transaction)
  UPDATE public.option_cycle_automation_log
  SET
    status       = 'completed',
    completed_at = now(),
    last_error   = NULL
  WHERE id = p_automation_log_id;

  -- 9c. Insert canonical activity: option_cycle_missed
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
    'Option Exercise Deadline missed',
    'The Option Exercise Deadline (' || v_deadline_display ||
      ') passed with no timely exercise or signed amendment. The Option Cycle was marked missed. Review escrow/return-of-funds process separately.',
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

-- ─── GRANT EXECUTE (unchanged) ────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text)
  FROM PUBLIC;
