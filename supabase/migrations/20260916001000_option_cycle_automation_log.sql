-- ============================================================
-- Migration: 20260916001000_option_cycle_automation_log
--
-- PURPOSE
-- -------
-- Step 5D-2 / Step 5D-2.1 Hardening:
-- Create the option_cycle_automation_log table for durable
-- idempotency tracking of Option Exercise automation events,
-- with a fully retryable claim model and atomic DB claim RPC.
--
-- HARDENING CHANGES (5D-2.1)
-- ---------------------------
-- • Added claimed_at timestamptz for stale-claim lease (15 min)
-- • Retry indexes for efficient worker queries
-- • claim_option_cycle_automation_event() atomic RPC — prevents
--   SELECT→decide→UPDATE race conditions between concurrent workers
-- • Claim result contract: claimed | already_done | currently_claimed
--   | retry_claimed | max_attempts_reached
-- • Failed events are retryable (attempt_count < 3)
-- • Stale pending (claimed_at > 15 min ago) may be reclaimed atomically
-- • Dry-run NEVER touches this table
--
-- IDEMPOTENCY MODEL
-- -----------------
-- Before performing any automation action (send reminder, auto-close),
-- the worker calls claim_option_cycle_automation_event() which atomically:
--   1. Checks for existing completed/sent row → already_done
--   2. Checks for active pending (fresh lease) → currently_claimed
--   3. Reclaims stale pending (lease expired, attempt_count < 3) → retry_claimed
--   4. Retries failed row (attempt_count < 3) → retry_claimed
--   5. Blocks permanently failed (attempt_count >= 3) → max_attempts_reached
--   6. Inserts new row → claimed
--
-- DRY-RUN CONTRACT
-- ----------------
-- Dry-run MUST NOT write to this table.
-- The worker inspects existing rows (read-only) to determine
-- would_send / would_skip / would_close, but never INSERTs or UPDATEs.
--
-- DEDUPE KEY FORMAT
-- -----------------
-- Reminders:
--   option:{cycle_id}:{deadline_date}:{event_type}:{normalized_email}
--   Example: option:abc123:2026-09-24:client_reminder_7d:borrower@example.com
--
-- Auto-close:
--   option:{cycle_id}:{deadline_date}:auto_close
--
-- EVENT TYPES
-- -----------
-- client_reminder_7d, admin_reminder_7d
-- client_reminder_5d, admin_reminder_5d
-- client_reminder_3d, admin_reminder_3d
-- client_reminder_1d, admin_reminder_1d
-- auto_close
-- client_closeout_notice
-- admin_closeout_notice
--
-- STATUS VALUES
-- -------------
-- pending   — claimed but not yet completed (has claimed_at lease)
-- sent      — email successfully sent
-- failed    — action failed (retryable if attempt_count < 3)
-- completed — non-email action completed (e.g., auto_close)
--
-- CLAIM LEASE
-- -----------
-- 15 minutes. A pending row older than 15 minutes is considered stale
-- and may be atomically reclaimed by another worker.
--
-- MAX ATTEMPTS
-- ------------
-- 3. After 3 failed attempts, the event is permanently skipped by
-- automation. Admin can investigate via last_error.
--
-- SECURITY
-- --------
-- Borrowers have NO access to this table.
-- Admin may read for audit/debugging.
-- Service role used for all automation writes.
-- ============================================================

-- ─── 1. CREATE option_cycle_automation_log ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.option_cycle_automation_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id         uuid        NOT NULL
                               REFERENCES public.crm_deal_option_cycles(id)
                               ON DELETE CASCADE,
  application_id   uuid        NOT NULL
                               REFERENCES public.borrower_applications(id)
                               ON DELETE CASCADE,
  event_type       text        NOT NULL,
  deadline_snapshot date       NOT NULL,
  dedupe_key       text        NOT NULL UNIQUE,
  status           text        NOT NULL DEFAULT 'pending',
  attempt_count    integer     NOT NULL DEFAULT 0,
  claimed_at       timestamptz,
  last_error       text,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT option_cycle_automation_log_event_type_check
    CHECK (event_type = ANY (ARRAY[
      'client_reminder_7d',
      'admin_reminder_7d',
      'client_reminder_5d',
      'admin_reminder_5d',
      'client_reminder_3d',
      'admin_reminder_3d',
      'client_reminder_1d',
      'admin_reminder_1d',
      'auto_close',
      'client_closeout_notice',
      'admin_closeout_notice'
    ])),

  CONSTRAINT option_cycle_automation_log_status_check
    CHECK (status = ANY (ARRAY[
      'pending',
      'sent',
      'failed',
      'completed'
    ]))
);

-- ─── 2. INDEXES ───────────────────────────────────────────────────────────────

-- Fast lookup by cycle for worker queries
CREATE INDEX IF NOT EXISTS idx_option_cycle_automation_log_cycle_id
  ON public.option_cycle_automation_log(cycle_id);

-- Fast lookup by application
CREATE INDEX IF NOT EXISTS idx_option_cycle_automation_log_application_id
  ON public.option_cycle_automation_log(application_id);

-- Fast lookup by event_type + status for worker queries
CREATE INDEX IF NOT EXISTS idx_option_cycle_automation_log_event_status
  ON public.option_cycle_automation_log(event_type, status);

-- Retry index: find retryable failed events efficiently
CREATE INDEX IF NOT EXISTS idx_option_cycle_automation_log_retry
  ON public.option_cycle_automation_log(status, attempt_count)
  WHERE status = 'failed';

-- Stale-claim index: find stale pending events efficiently
CREATE INDEX IF NOT EXISTS idx_option_cycle_automation_log_stale_pending
  ON public.option_cycle_automation_log(status, claimed_at)
  WHERE status = 'pending';

-- ─── 3. UPDATED_AT TRIGGER ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_option_cycle_automation_log_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_option_cycle_automation_log_updated_at
  ON public.option_cycle_automation_log;

CREATE TRIGGER trg_option_cycle_automation_log_updated_at
  BEFORE UPDATE ON public.option_cycle_automation_log
  FOR EACH ROW
  EXECUTE FUNCTION public.set_option_cycle_automation_log_updated_at();

-- ─── 4. ATOMIC CLAIM RPC ──────────────────────────────────────────────────────
--
-- claim_option_cycle_automation_event(...)
--
-- Atomically determines the correct claim outcome for a given dedupe_key.
-- All logic runs inside a single transaction with FOR UPDATE locking to
-- prevent two concurrent workers from racing on the same event.
--
-- CLAIM RESULT CONTRACT
-- ---------------------
-- claimed            — new row inserted, worker owns the action
-- already_done       — existing sent/completed row; skip
-- currently_claimed  — active pending (fresh lease < 15 min); skip
-- retry_claimed      — stale pending reclaimed OR failed retried; worker owns
-- max_attempts_reached — failed >= 3 attempts; skip, Admin must investigate
--
-- RETURNS: TABLE(result text, log_id uuid)
--   result  — one of the claim result values above
--   log_id  — the automation log row id (NULL if skipped)
--
-- STALE LEASE: 15 minutes
-- MAX ATTEMPTS: 3

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
  v_now   timestamptz := now();
  v_lease interval    := interval '15 minutes';
  v_max_attempts integer := 3;
BEGIN
  -- Lock the existing row if it exists (prevents concurrent reclaim race)
  SELECT * INTO v_row
  FROM public.option_cycle_automation_log
  WHERE dedupe_key = p_dedupe_key
  FOR UPDATE;

  IF NOT FOUND THEN
    -- No existing row → insert new claim
    INSERT INTO public.option_cycle_automation_log (
      cycle_id, application_id, event_type, deadline_snapshot,
      dedupe_key, status, attempt_count, claimed_at
    ) VALUES (
      p_cycle_id, p_application_id, p_event_type, p_deadline_snapshot,
      p_dedupe_key, 'pending', 0, v_now
    )
    RETURNING id INTO v_row.id;

    RETURN QUERY SELECT 'claimed'::text, v_row.id;
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
      -- Atomically reclaim
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
    -- Retryable failed event → reclaim
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

  -- Fallback (should not reach here)
  RETURN QUERY SELECT 'already_done'::text, v_row.id;
END;
$$;

-- ─── 5. RLS ───────────────────────────────────────────────────────────────────
-- INTERNAL TABLE ONLY. Borrowers have NO access.
-- Admin may read for audit/debugging.
-- Service role bypasses RLS for all automation writes.

ALTER TABLE public.option_cycle_automation_log ENABLE ROW LEVEL SECURITY;

-- Admin read-only (for audit/debugging in Admin UI if needed)
DROP POLICY IF EXISTS "admins_read_option_cycle_automation_log" ON public.option_cycle_automation_log;
CREATE POLICY "admins_read_option_cycle_automation_log"
  ON public.option_cycle_automation_log
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- No borrower policies — borrowers have zero access to this table.
-- Service role (used by automation worker) bypasses RLS entirely.

-- ─── 6. DOCUMENT: HARDENED CLAIM MODEL ───────────────────────────────────────
--
-- DRY-RUN CONTRACT:
--   When dry_run = true, the worker MUST NOT call this function.
--   The worker reads existing rows only to determine would_send/would_skip.
--   No INSERT, no UPDATE, no claimed_at written.
--   Dry-run cannot poison the live dedupe key.
--
-- LIVE CLAIM FLOW:
--   1. Call claim_option_cycle_automation_event(...) → get (result, log_id)
--   2. If result = 'claimed' or 'retry_claimed' → worker owns the action
--   3. Perform the action (send email / close deal)
--   4. On success: UPDATE status = 'sent'/'completed', completed_at = now()
--   5. On failure: UPDATE status = 'failed', last_error = message
--      (attempt_count was already incremented by the claim RPC)
--   6. If result = 'already_done' / 'currently_claimed' / 'max_attempts_reached'
--      → skip, do not perform action
--
-- RETRY BEHAVIOR:
--   failed + attempt_count < 3  → next worker run may retry_claimed
--   failed + attempt_count >= 3 → max_attempts_reached, Admin investigates
--   pending + fresh lease        → currently_claimed, skip
--   pending + stale lease        → retry_claimed (reclaim)
--
-- CONCURRENT SAFETY:
--   SELECT ... FOR UPDATE inside the RPC prevents two workers from
--   simultaneously reclaiming the same stale/failed row.
