-- ============================================================
-- Migration: 20260915011000_option_cycle_cutoff_hardening
--
-- PURPOSE
-- -------
-- Step 5D-1.1 hardening pass:
--
-- 1. Verify / harden SECURITY DEFINER search_path on all functions
--    created in 20260915010000. The functions already have
--    SET search_path = public, pg_catalog but we recreate them
--    here to be explicit and safe.
--
-- 2. Add actual_received_at / actual_exercised_at columns so Admin
--    can record the real receipt/exercise timestamp rather than
--    always using now(). These are stored as timestamptz.
--    The canonical option_exercise_deadline DATE remains unchanged.
--
-- 3. The 5:00 PM America/New_York cutoff is a server-side utility
--    (TypeScript helper fn_option_deadline_cutoff). No stored column
--    is needed — the cutoff is always derived from the deadline date.
--    We document the canonical rule here for reference.
--
-- CANONICAL CUTOFF RULE
-- ---------------------
-- The Option Exercise Deadline expires at 5:00:00 PM America/New_York
-- on the option_exercise_deadline DATE.
-- IANA timezone: America/New_York (automatically respects DST).
-- Do NOT use hardcoded UTC offsets (EST/EDT/UTC-5/UTC-4).
--
-- TIMELINESS RULE
-- ---------------
-- An event is TIMELY when:
--   event_timestamp <= deadline_cutoff (i.e., at or before 5:00 PM ET)
-- An event is LATE when:
--   event_timestamp > deadline_cutoff (i.e., after 5:00 PM ET)
-- Exactly 5:00:00 PM ET is TIMELY.
-- 5:00:01 PM ET is LATE.
--
-- NEW COLUMNS
-- -----------
-- crm_deal_option_cycles.actual_amendment_received_at  timestamptz
--   Admin-recorded actual receipt time for the signed PSA amendment.
--   Replaces the previous behavior of always using now().
--   Default: NULL (populated when Admin records the amendment).
--   Timeliness is derived server-side by comparing this value to the
--   5:00 PM ET cutoff. Do NOT trust a browser-supplied is_timely flag.
--
-- crm_deal_option_cycles.actual_option_exercised_at  timestamptz
--   Admin-recorded actual exercise receipt time.
--   Replaces the previous behavior of always using now().
--   Timeliness is derived server-side.
--
-- NOTE: The existing extension_psa_amendment_received_at and
-- option_exercised_at columns are RETAINED for backward compatibility.
-- The new actual_* columns are the authoritative timestamps going
-- forward. The API will populate both for a transition period.
-- ============================================================

-- ─── 1. HARDEN fn_subtract_business_days SEARCH PATH ─────────────────────────
-- Already has SET search_path = public, pg_catalog in the original migration.
-- Recreate here to confirm and document the hardened state.

CREATE OR REPLACE FUNCTION public.fn_subtract_business_days(
  p_start_date date,
  p_n          integer
)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_year     integer;
  v_min_year integer;
  v_max_year integer;
  v_current  date;
  v_counted  integer := 0;
BEGIN
  v_year := EXTRACT(YEAR FROM p_start_date)::integer;

  SELECT
    EXTRACT(YEAR FROM MIN(holiday_date))::integer,
    EXTRACT(YEAR FROM MAX(holiday_date))::integer
  INTO v_min_year, v_max_year
  FROM public.crm_business_holidays;

  IF v_year < v_min_year OR v_year > v_max_year THEN
    RAISE EXCEPTION 'Business holiday calendar unavailable for year %. Covered range: %–%.', v_year, v_min_year, v_max_year;
  END IF;

  v_current := p_start_date;

  WHILE v_counted < p_n LOOP
    v_current := v_current - INTERVAL '1 day';

    IF EXTRACT(DOW FROM v_current) IN (0, 6) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.crm_business_holidays
      WHERE holiday_date = v_current
    ) THEN
      CONTINUE;
    END IF;

    v_counted := v_counted + 1;
  END LOOP;

  RETURN v_current;
END;
$$;

-- ─── 2. HARDEN set_crm_deal_option_cycles_updated_at SEARCH PATH ─────────────

CREATE OR REPLACE FUNCTION public.set_crm_deal_option_cycles_updated_at()
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

-- ─── 3. ADD actual_amendment_received_at COLUMN ──────────────────────────────
-- Admin-recorded actual receipt timestamp for the signed PSA amendment.
-- Stored as timestamptz. Interpreted as America/New_York by the server.
-- Timeliness derived server-side: actual_amendment_received_at <= cutoff.

ALTER TABLE public.crm_deal_option_cycles
  ADD COLUMN IF NOT EXISTS actual_amendment_received_at timestamptz;

-- ─── 4. ADD actual_option_exercised_at COLUMN ────────────────────────────────
-- Admin-recorded actual exercise receipt timestamp.
-- Stored as timestamptz. Interpreted as America/New_York by the server.
-- Timeliness derived server-side: actual_option_exercised_at <= cutoff.

ALTER TABLE public.crm_deal_option_cycles
  ADD COLUMN IF NOT EXISTS actual_option_exercised_at timestamptz;

-- ─── 5. EXTEND application_activity event_type CHECK ─────────────────────────
-- Add late-recording activity types additively.

ALTER TABLE public.application_activity
  DROP CONSTRAINT IF EXISTS application_activity_event_type_check;

ALTER TABLE public.application_activity
  ADD CONSTRAINT application_activity_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'status_change',
    'document_upload',
    'admin_note',
    'deadline_shift',
    'system',
    'document_revision_uploaded',
    'revision_requested',
    'document_approved',
    'owner_assigned',
    'task_created',
    'email_sent',
    'call_logged',
    'deadline_created',
    'deadline_updated',
    'deadline_completed',
    'deadline_cancelled',
    'deadline_reopened',
    'option_cycle_created',
    'option_exercised',
    'extension_amendment_received',
    'extension_fee_paid',
    'option_cycle_extended'
  ]));
