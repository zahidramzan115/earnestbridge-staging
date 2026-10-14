-- ============================================================
-- Migration: 20260917000000_atomic_auto_close_rpc
--
-- Step 5D-2.13b HARDENED (replaces 5D-2.13a version)
--
-- PURPOSE
-- -------
-- Extend execute_option_cycle_auto_close() so that:
--   1. The auto_close automation log row is marked completed
--      INSIDE the same PostgreSQL transaction as the Deal/cycle
--      state transition.
--   2. Both canonical activity rows are inserted INSIDE the same
--      transaction.
--
-- This eliminates all crash windows between:
--   - state transition commit
--   - auto_close log completion
--   - activity history creation
--
-- CRASH RECOVERY GUARANTEE
-- ------------------------
-- After this migration, a single committed transaction produces:
--   crm_deal_option_cycles.status  = 'missed'
--   borrower_applications.app_status = 'closed'
--   option_cycle_automation_log.status = 'completed'
--   application_activity row: option_cycle_missed
--   application_activity row: status_change
--
-- Either ALL five writes commit or NONE do.
--
-- CLOSEOUT EMAILS (client_closeout_notice / admin_closeout_notice)
-- ----------------------------------------------------------------
-- These remain OUTSIDE the transaction (email delivery cannot be
-- inside a DB transaction). They are recovered by the independent
-- reconcileCompletedAutoCloseNotifications() phase in the worker,
-- which runs on every enabled worker execution and inspects
-- completed auto_close log rows whose closeout notices have not
-- yet been processed.
--
-- IDEMPOTENCY / DUPLICATE ACTIVITY PREVENTION
-- --------------------------------------------
-- The RPC inserts activity rows only when it performs the state
-- transition (i.e., only on 'success'). If the RPC is called again
-- for the same cycle (e.g., after a crash that prevented the caller
-- from receiving the 'success' response), the cycle guard
-- (status != 'active') fires first and returns guard_cycle_not_active
-- without inserting duplicate rows.
--
-- AUTOMATION LOG VERIFICATION
-- ---------------------------
-- The RPC accepts p_automation_log_id. Before committing it verifies:
--   - log row belongs to p_application_id
--   - log row belongs to p_cycle_id
--   - log row event_type = 'auto_close'
--   - log row deadline_snapshot = p_deadline_snapshot
--   - log row status IN ('pending', 'claimed', 'failed')
--     (i.e., not already completed — prevents double-completion)
-- If verification fails, the RPC returns guard_log_invalid and
-- performs NO state changes.
--
-- RESULT CONTRACT
-- ---------------
-- success                — all five writes committed
-- guard_deal_not_funded  — deal.app_status != 'funded' at write time
-- guard_cycle_not_active — cycle.status != 'active' at write time
-- guard_cycle_satisfied  — timely exercise or amendment found at write time
-- guard_app_mismatch     — cycle.application_id != p_application_id
-- guard_cycle_not_found  — cycle row not found
-- guard_deal_not_found   — deal row not found
-- guard_log_invalid      — automation log row failed verification
-- guard_log_not_found    — automation log row not found
--
-- CONCURRENCY SAFETY
-- ------------------
-- SELECT ... FOR UPDATE on both rows + automation log row prevents
-- concurrent double-close. Combined with claim_option_cycle_automation_event,
-- this provides two independent concurrency barriers.
--
-- SECURITY
-- --------
-- SECURITY DEFINER + SET search_path = public, pg_catalog
-- GRANT EXECUTE to service_role only.
-- ============================================================

-- ─── Drop old signature (5D-2.13a) ───────────────────────────────────────────
-- The old 3-argument version is replaced by the new 5-argument version.
-- Drop it first to avoid overload ambiguity.

DROP FUNCTION IF EXISTS public.execute_option_cycle_auto_close(uuid, uuid, timestamptz);

-- ─── CREATE execute_option_cycle_auto_close (hardened 5D-2.13b) ──────────────

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

  -- Verify log belongs to expected application, cycle, event type, and deadline
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
  -- Format: Mon DD, YYYY (e.g. "Sep 22, 2026")
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
  INSERT INTO public.application_activity (
    application_id,
    user_id,
    event_type,
    title,
    detail,
    actor
  ) VALUES (
    p_application_id,
    NULL,
    'option_cycle_missed',
    'Option Exercise Deadline missed — Deal auto-closed',
    'Option Exercise Deadline ' || v_deadline_display ||
      ' passed with no timely exercise or signed amendment. CRM Deal auto-closed. Review escrow/return-of-funds process separately.',
    'EarnestBridge Automation'
  )
  ON CONFLICT DO NOTHING;

  -- 9e. Insert canonical activity: status_change
  INSERT INTO public.application_activity (
    application_id,
    user_id,
    event_type,
    title,
    detail,
    actor
  ) VALUES (
    p_application_id,
    NULL,
    'status_change',
    'Deal status changed: Funded → Closed',
    'Automatic CRM closeout triggered by missed Option Exercise Deadline (' ||
      v_deadline_display || ').',
    'EarnestBridge Automation'
  )
  ON CONFLICT DO NOTHING;

  -- ── 10. Return success ───────────────────────────────────────────────────
  RETURN QUERY SELECT 'success'::text;
END;
$$;

-- ─── GRANT EXECUTE ────────────────────────────────────────────────────────────
-- Only service_role may call this function.

GRANT EXECUTE ON FUNCTION public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.execute_option_cycle_auto_close(uuid, uuid, timestamptz, uuid, text)
  FROM PUBLIC;

-- ─── DOCUMENTATION ───────────────────────────────────────────────────────────
--
-- WORKER CALL PATTERN (post-5D-2.13b hardening):
--
--   const { data, error } = await supabase.rpc('execute_option_cycle_auto_close', {
--     p_cycle_id:           cycle.id,
--     p_application_id:     cycle.application_id,
--     p_cutoff_at:          cutoff.toISOString(),
--     p_automation_log_id:  claimResult.logId,
--     p_deadline_snapshot:  deadline,
--   });
--   const rpcResult = Array.isArray(data) ? data[0]?.result : data?.result;
--   if (rpcResult !== 'success') { /* handle guard failure */ }
--
-- CANONICAL EXECUTION ORDER (post-5D-2.13b hardening):
--   1. Worker loads candidate cycles (funded deals, active cycles)
--   2. Worker re-fetches fresh cycle data
--   3. Worker re-evaluates timeliness with fresh data
--   4. Worker calls claim_option_cycle_automation_event() → owns the claim
--      (returns logId)
--   5. Worker calls execute_option_cycle_auto_close() → ONE atomic transaction:
--        a. cycle → missed
--        b. deal  → closed
--        c. auto_close log → completed
--        d. activity: option_cycle_missed inserted
--        e. activity: status_change inserted
--   6. Worker calls reconcileCompletedAutoCloseNotifications() which
--      independently processes client_closeout_notice and admin_closeout_notice
--      for all completed auto_close events.
--
-- CRASH RECOVERY MATRIX:
--   Crash after RPC call but before worker receives 'success' response:
--     → RPC already committed all 5 writes atomically.
--     → Next reconciliation run finds auto_close = completed, cycle = missed,
--       deal = closed → processes closeout notices.
--     → No duplicate state transition (cycle guard fires: not active).
--     → No duplicate activity rows (ON CONFLICT DO NOTHING).
--
--   Crash after RPC 'success' before closeout notices:
--     → reconcileCompletedAutoCloseNotifications() recovers both.
--
--   Crash between client and admin closeout:
--     → reconcileCompletedAutoCloseNotifications() recovers admin only.
--     → Client returns already_done.
--
-- INVARIANTS GUARANTEED:
--   - INVALID STATE A (cycle=missed, deal=funded) is impossible
--   - INVALID STATE B (cycle=active, deal=closed) is impossible
--   - auto_close log row is completed atomically with state transition
--   - Activity rows are committed atomically with state transition
--   - No duplicate activity rows (ON CONFLICT DO NOTHING)
--   - Email failure cannot undo or repeat the close
--   - Concurrent double-close is prevented by FOR UPDATE + claim model
