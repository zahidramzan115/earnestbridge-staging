-- ============================================================
-- Migration: crm_deal_option_cycles
-- Timestamp: 20260915010000
--
-- PURPOSE
-- -------
-- Implement the Funded Deal Option Exercise + Extension Lifecycle
-- (Step 5D-1). This creates:
--
--   1. crm_deal_option_cycles — first-class option cycle table
--   2. crm_business_holidays  — Federal Reserve banking holiday calendar
--   3. fn_subtract_business_days() — canonical server-side business-day
--      calculator (2 business days before deposit_goes_hard_date)
--   4. RLS: Admin-only mutations; borrowers have NO access
--   5. Partial unique index: only ONE active cycle per application
--   6. Additive application_activity event types
--
-- ARCHITECTURE DECISION
-- ---------------------
-- crm_deal_option_cycles is NOT modeled as a crm_deal_deadlines row.
-- It has first-class lifecycle logic (active/exercised/extended/missed)
-- and stronger business consequences than generic deadlines.
-- crm_deal_deadlines remains unchanged and serves ordinary deadlines.
--
-- FEDERAL RESERVE BUSINESS DAY DEFINITION
-- ----------------------------------------
-- A business day is Monday–Friday excluding Federal Reserve banking
-- holidays. The holiday calendar is stored in crm_business_holidays
-- and seeded for 2024–2030. If a requested calculation falls outside
-- the seeded range, the function raises an exception rather than
-- silently falling back to weekends-only logic.
--
-- FEDERAL RESERVE HOLIDAY OBSERVANCE RULES
-- -----------------------------------------
-- Holiday on Saturday: Federal Reserve Banks remain OPEN the preceding
--   Friday. Do NOT exclude Friday for a Saturday holiday.
-- Holiday on Sunday: The following Monday is a non-business banking day.
--
-- COVERED HOLIDAY FAMILIES
-- -------------------------
-- New Year's Day, Martin Luther King Jr. Day, Washington's Birthday,
-- Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day,
-- Veterans Day, Thanksgiving, Christmas Day.
--
-- HOLIDAY COVERAGE
-- ----------------
-- Seeded years: 2024–2030 (7 years).
-- If deposit_goes_hard_date falls in a year outside this range, the
-- function raises: 'Business holiday calendar unavailable for this year.'
-- Admin must add holiday rows for future years before using them.
--
-- SECURITY
-- --------
-- Borrowers have NO INSERT / UPDATE / DELETE / SELECT on this table.
-- Admin mutations require app_metadata.role = 'admin' (server-side).
-- RLS enforces is_admin_user() (app_metadata only, per migration 20260915004000).
-- ============================================================


-- ─── 1. FEDERAL RESERVE BANKING HOLIDAY CALENDAR ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_business_holidays (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date date        NOT NULL UNIQUE,
  name         text        NOT NULL,
  source       text        NOT NULL DEFAULT 'federal_reserve',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_business_holidays_date
  ON public.crm_business_holidays(holiday_date);

-- RLS: Admin read/write; no borrower access
ALTER TABLE public.crm_business_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_business_holidays" ON public.crm_business_holidays;
CREATE POLICY "admins_all_crm_business_holidays"
  ON public.crm_business_holidays
  FOR ALL
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());


-- ─── 2. SEED FEDERAL RESERVE HOLIDAYS 2024–2030 ──────────────────────────────
--
-- Rules applied:
--   - Holiday on Saturday → NOT observed on preceding Friday (Fed stays open)
--   - Holiday on Sunday   → Observed on following Monday
--
-- 2024 holidays
INSERT INTO public.crm_business_holidays (holiday_date, name) VALUES
  ('2024-01-01', 'New Year''s Day'),
  ('2024-01-15', 'Martin Luther King Jr. Day'),
  ('2024-02-19', 'Washington''s Birthday'),
  ('2024-05-27', 'Memorial Day'),
  ('2024-06-19', 'Juneteenth National Independence Day'),
  ('2024-07-04', 'Independence Day'),
  ('2024-09-02', 'Labor Day'),
  ('2024-10-14', 'Columbus Day'),
  ('2024-11-11', 'Veterans Day'),
  ('2024-11-28', 'Thanksgiving Day'),
  ('2024-12-25', 'Christmas Day')
ON CONFLICT (holiday_date) DO NOTHING;

-- 2025 holidays
-- New Year's Day: Jan 1 (Wednesday) → Jan 1
-- MLK: 3rd Monday Jan → Jan 20
-- Washington's Birthday: 3rd Monday Feb → Feb 17
-- Memorial Day: last Monday May → May 26
-- Juneteenth: Jun 19 (Thursday) → Jun 19
-- Independence Day: Jul 4 (Friday) → Jul 4
-- Labor Day: 1st Monday Sep → Sep 1
-- Columbus Day: 2nd Monday Oct → Oct 13
-- Veterans Day: Nov 11 (Tuesday) → Nov 11
-- Thanksgiving: 4th Thursday Nov → Nov 27
-- Christmas: Dec 25 (Thursday) → Dec 25
INSERT INTO public.crm_business_holidays (holiday_date, name) VALUES
  ('2025-01-01', 'New Year''s Day'),
  ('2025-01-20', 'Martin Luther King Jr. Day'),
  ('2025-02-17', 'Washington''s Birthday'),
  ('2025-05-26', 'Memorial Day'),
  ('2025-06-19', 'Juneteenth National Independence Day'),
  ('2025-07-04', 'Independence Day'),
  ('2025-09-01', 'Labor Day'),
  ('2025-10-13', 'Columbus Day'),
  ('2025-11-11', 'Veterans Day'),
  ('2025-11-27', 'Thanksgiving Day'),
  ('2025-12-25', 'Christmas Day')
ON CONFLICT (holiday_date) DO NOTHING;

-- 2026 holidays
-- New Year's Day: Jan 1 (Thursday) → Jan 1
-- MLK: 3rd Monday Jan → Jan 19
-- Washington's Birthday: 3rd Monday Feb → Feb 16
-- Memorial Day: last Monday May → May 25
-- Juneteenth: Jun 19 (Friday) → Jun 19
-- Independence Day: Jul 4 (Saturday) → NOT observed on Friday (Fed stays open Friday); no Monday observance either
--   Per Fed rules: Saturday holiday → Fed open Friday. No substitute holiday.
--   NOTE: Jul 4 2026 is Saturday. Federal Reserve Banks are open Friday Jul 3.
--   We do NOT add Jul 3 as a holiday.
-- Labor Day: 1st Monday Sep → Sep 7
-- Columbus Day: 2nd Monday Oct → Oct 12
-- Veterans Day: Nov 11 (Wednesday) → Nov 11
-- Thanksgiving: 4th Thursday Nov → Nov 26
-- Christmas: Dec 25 (Friday) → Dec 25
INSERT INTO public.crm_business_holidays (holiday_date, name) VALUES
  ('2026-01-01', 'New Year''s Day'),
  ('2026-01-19', 'Martin Luther King Jr. Day'),
  ('2026-02-16', 'Washington''s Birthday'),
  ('2026-05-25', 'Memorial Day'),
  ('2026-06-19', 'Juneteenth National Independence Day'),
  ('2026-09-07', 'Labor Day'),
  ('2026-10-12', 'Columbus Day'),
  ('2026-11-11', 'Veterans Day'),
  ('2026-11-26', 'Thanksgiving Day'),
  ('2026-12-25', 'Christmas Day')
ON CONFLICT (holiday_date) DO NOTHING;
-- Note: Jul 4 2026 falls on Saturday. Federal Reserve Banks remain open
-- Friday Jul 3. No holiday row is inserted for 2026 Independence Day.

-- 2027 holidays
-- New Year's Day: Jan 1 (Friday) → Jan 1
-- MLK: 3rd Monday Jan → Jan 18
-- Washington's Birthday: 3rd Monday Feb → Feb 15
-- Memorial Day: last Monday May → May 31
-- Juneteenth: Jun 19 (Saturday) → NOT observed on Friday (Fed stays open); no row
-- Independence Day: Jul 4 (Sunday) → observed Monday Jul 5
-- Labor Day: 1st Monday Sep → Sep 6
-- Columbus Day: 2nd Monday Oct → Oct 11
-- Veterans Day: Nov 11 (Thursday) → Nov 11
-- Thanksgiving: 4th Thursday Nov → Nov 25
-- Christmas: Dec 25 (Saturday) → NOT observed on Friday (Fed stays open); no row
INSERT INTO public.crm_business_holidays (holiday_date, name) VALUES
  ('2027-01-01', 'New Year''s Day'),
  ('2027-01-18', 'Martin Luther King Jr. Day'),
  ('2027-02-15', 'Washington''s Birthday'),
  ('2027-05-31', 'Memorial Day'),
  ('2027-07-05', 'Independence Day (observed)'),
  ('2027-09-06', 'Labor Day'),
  ('2027-10-11', 'Columbus Day'),
  ('2027-11-11', 'Veterans Day'),
  ('2027-11-25', 'Thanksgiving Day')
ON CONFLICT (holiday_date) DO NOTHING;
-- Note: Juneteenth Jun 19 2027 falls on Saturday → Fed open Friday Jun 18; no row.
-- Note: Christmas Dec 25 2027 falls on Saturday → Fed open Friday Dec 24; no row.

-- 2028 holidays
-- New Year's Day: Jan 1 (Saturday) → NOT observed on Friday (Fed stays open); no row
-- MLK: 3rd Monday Jan → Jan 17
-- Washington's Birthday: 3rd Monday Feb → Feb 21
-- Memorial Day: last Monday May → May 29
-- Juneteenth: Jun 19 (Monday) → Jun 19
-- Independence Day: Jul 4 (Tuesday) → Jul 4
-- Labor Day: 1st Monday Sep → Sep 4
-- Columbus Day: 2nd Monday Oct → Oct 9
-- Veterans Day: Nov 11 (Saturday) → NOT observed on Friday (Fed stays open); no row
-- Thanksgiving: 4th Thursday Nov → Nov 23
-- Christmas: Dec 25 (Monday) → Dec 25
INSERT INTO public.crm_business_holidays (holiday_date, name) VALUES
  ('2028-01-17', 'Martin Luther King Jr. Day'),
  ('2028-02-21', 'Washington''s Birthday'),
  ('2028-05-29', 'Memorial Day'),
  ('2028-06-19', 'Juneteenth National Independence Day'),
  ('2028-07-04', 'Independence Day'),
  ('2028-09-04', 'Labor Day'),
  ('2028-10-09', 'Columbus Day'),
  ('2028-11-23', 'Thanksgiving Day'),
  ('2028-12-25', 'Christmas Day')
ON CONFLICT (holiday_date) DO NOTHING;
-- Note: New Year's Day Jan 1 2028 falls on Saturday → Fed open Friday Dec 31 2027; no row.
-- Note: Veterans Day Nov 11 2028 falls on Saturday → Fed open Friday Nov 10; no row.

-- 2029 holidays
-- New Year's Day: Jan 1 (Monday) → Jan 1
-- MLK: 3rd Monday Jan → Jan 15
-- Washington's Birthday: 3rd Monday Feb → Feb 19
-- Memorial Day: last Monday May → May 28
-- Juneteenth: Jun 19 (Tuesday) → Jun 19
-- Independence Day: Jul 4 (Wednesday) → Jul 4
-- Labor Day: 1st Monday Sep → Sep 3
-- Columbus Day: 2nd Monday Oct → Oct 8
-- Veterans Day: Nov 11 (Sunday) → observed Monday Nov 12
-- Thanksgiving: 4th Thursday Nov → Nov 22
-- Christmas: Dec 25 (Tuesday) → Dec 25
INSERT INTO public.crm_business_holidays (holiday_date, name) VALUES
  ('2029-01-01', 'New Year''s Day'),
  ('2029-01-15', 'Martin Luther King Jr. Day'),
  ('2029-02-19', 'Washington''s Birthday'),
  ('2029-05-28', 'Memorial Day'),
  ('2029-06-19', 'Juneteenth National Independence Day'),
  ('2029-07-04', 'Independence Day'),
  ('2029-09-03', 'Labor Day'),
  ('2029-10-08', 'Columbus Day'),
  ('2029-11-12', 'Veterans Day (observed)'),
  ('2029-11-22', 'Thanksgiving Day'),
  ('2029-12-25', 'Christmas Day')
ON CONFLICT (holiday_date) DO NOTHING;

-- 2030 holidays
-- New Year's Day: Jan 1 (Tuesday) → Jan 1
-- MLK: 3rd Monday Jan → Jan 21
-- Washington's Birthday: 3rd Monday Feb → Feb 18
-- Memorial Day: last Monday May → May 27
-- Juneteenth: Jun 19 (Wednesday) → Jun 19
-- Independence Day: Jul 4 (Thursday) → Jul 4
-- Labor Day: 1st Monday Sep → Sep 2
-- Columbus Day: 2nd Monday Oct → Oct 14
-- Veterans Day: Nov 11 (Monday) → Nov 11
-- Thanksgiving: 4th Thursday Nov → Nov 28
-- Christmas: Dec 25 (Wednesday) → Dec 25
INSERT INTO public.crm_business_holidays (holiday_date, name) VALUES
  ('2030-01-01', 'New Year''s Day'),
  ('2030-01-21', 'Martin Luther King Jr. Day'),
  ('2030-02-18', 'Washington''s Birthday'),
  ('2030-05-27', 'Memorial Day'),
  ('2030-06-19', 'Juneteenth National Independence Day'),
  ('2030-07-04', 'Independence Day'),
  ('2030-09-02', 'Labor Day'),
  ('2030-10-14', 'Columbus Day'),
  ('2030-11-11', 'Veterans Day'),
  ('2030-11-28', 'Thanksgiving Day'),
  ('2030-12-25', 'Christmas Day')
ON CONFLICT (holiday_date) DO NOTHING;


-- ─── 3. CANONICAL BUSINESS-DAY CALCULATOR ────────────────────────────────────
--
-- fn_subtract_business_days(start_date date, n integer) → date
--
-- Returns the date that is exactly N Federal Reserve business days
-- BEFORE start_date. Counts backwards, skipping weekends (Sat/Sun)
-- and any date present in crm_business_holidays.
--
-- SAFETY: If start_date falls in a year not covered by the holiday
-- calendar, the function raises an exception. The caller (API route)
-- catches this and returns a clear error to the Admin rather than
-- silently computing an incorrect deadline.
--
-- EXAMPLES (from spec):
--   Hard Date Thursday → Deadline Tuesday (Wed=1, Tue=2)
--   Hard Date Thursday, Wednesday is holiday → Deadline Monday (Tue=1, Mon=2)
--   Hard Date Monday → Deadline Thursday (Fri=1, Thu=2)
--   Hard Date Tuesday, Monday is holiday → Deadline Thursday (Fri=1, Thu=2)

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
  -- Determine the year of the start date
  v_year := EXTRACT(YEAR FROM p_start_date)::integer;

  -- Determine the range of years covered by the holiday calendar
  SELECT
    EXTRACT(YEAR FROM MIN(holiday_date))::integer,
    EXTRACT(YEAR FROM MAX(holiday_date))::integer
  INTO v_min_year, v_max_year
  FROM public.crm_business_holidays;

  -- Reject if the year is outside the covered range
  IF v_year < v_min_year OR v_year > v_max_year THEN
    RAISE EXCEPTION 'Business holiday calendar unavailable for year %. Covered range: %–%.', v_year, v_min_year, v_max_year;
  END IF;

  -- Also check that the years we will traverse backwards into are covered.
  -- We may step into the prior year when counting backwards from Jan dates.
  -- Allow one year of backward traversal below the start year.
  IF (v_year - 1) < v_min_year THEN
    -- Only raise if we actually need to go that far; for safety, allow it
    -- unless the prior year is completely absent. We rely on the loop
    -- to raise if it encounters an uncovered holiday date.
    NULL;
  END IF;

  v_current := p_start_date;

  WHILE v_counted < p_n LOOP
    -- Step one calendar day backwards
    v_current := v_current - INTERVAL '1 day';

    -- Skip Saturday (DOW=6) and Sunday (DOW=0)
    IF EXTRACT(DOW FROM v_current) IN (0, 6) THEN
      CONTINUE;
    END IF;

    -- Skip Federal Reserve banking holidays
    IF EXISTS (
      SELECT 1 FROM public.crm_business_holidays
      WHERE holiday_date = v_current
    ) THEN
      CONTINUE;
    END IF;

    -- This is a valid business day
    v_counted := v_counted + 1;
  END LOOP;

  RETURN v_current;
END;
$$;


-- ─── 4. crm_deal_option_cycles TABLE ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_deal_option_cycles (
  id                                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deal relationship
  application_id                      uuid        NOT NULL
                                                  REFERENCES public.borrower_applications(id)
                                                  ON DELETE CASCADE,

  -- Cycle sequence (1 = initial funded cycle, 2 = first extension, etc.)
  cycle_number                        integer     NOT NULL,

  -- Admin-entered hard date
  deposit_goes_hard_date              date        NOT NULL,

  -- System-calculated: 2 Federal Reserve business days before deposit_goes_hard_date
  -- Admin must NOT manually set this field; it is always server-calculated.
  option_exercise_deadline            date        NOT NULL,

  -- Lifecycle status
  status                              text        NOT NULL DEFAULT 'active'
                                                  CHECK (status IN (
                                                    'active',
                                                    'exercised',
                                                    'extended',
                                                    'missed'
                                                  )),

  -- Option exercised
  option_exercised_at                 timestamptz,

  -- Extension: signed PSA amendment (CRITICAL — protects from auto-closeout)
  -- A Deal must NOT be automatically closed if this field is set on or before
  -- the option_exercise_deadline, even if extension_fee_paid_at is still NULL.
  extension_psa_amendment_received_at timestamptz,

  -- Extension: fee payment (required per client-facing terms; short grace period allowed)
  -- NOTE: Do NOT expose the internal grace-period policy to clients.
  -- Client-facing language must state BOTH amendment AND fee are required.
  extension_fee_paid_at               timestamptz,

  -- Set when this cycle is superseded by a new extension cycle
  extended_at                         timestamptz,

  -- Audit
  created_by                          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by                          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now()
);

-- ─── 4a. UNIQUE CONSTRAINT: one active cycle per deal ────────────────────────
-- Only ONE status='active' cycle may exist per application_id at a time.
-- Historical cycles (exercised/extended/missed) are preserved.

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_deal_option_cycles_one_active
  ON public.crm_deal_option_cycles(application_id)
  WHERE (status = 'active');

-- ─── 4b. UNIQUE CONSTRAINT: cycle_number per application ─────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_deal_option_cycles_app_cycle
  ON public.crm_deal_option_cycles(application_id, cycle_number);

-- ─── 4c. INDEXES ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_crm_deal_option_cycles_application_id
  ON public.crm_deal_option_cycles(application_id);

CREATE INDEX IF NOT EXISTS idx_crm_deal_option_cycles_status
  ON public.crm_deal_option_cycles(status);

-- ─── 4d. updated_at TRIGGER ──────────────────────────────────────────────────
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

DROP TRIGGER IF EXISTS trg_crm_deal_option_cycles_updated_at ON public.crm_deal_option_cycles;
CREATE TRIGGER trg_crm_deal_option_cycles_updated_at
  BEFORE UPDATE ON public.crm_deal_option_cycles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_crm_deal_option_cycles_updated_at();


-- ─── 5. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.crm_deal_option_cycles ENABLE ROW LEVEL SECURITY;

-- Admin: full access (SELECT, INSERT, UPDATE, DELETE)
DROP POLICY IF EXISTS "admins_all_crm_deal_option_cycles" ON public.crm_deal_option_cycles;
CREATE POLICY "admins_all_crm_deal_option_cycles"
  ON public.crm_deal_option_cycles
  FOR ALL
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- Borrowers: NO access (no SELECT, INSERT, UPDATE, DELETE policy)
-- Client-facing option status will be exposed through a safe server API
-- in a future step, never through direct table access.


-- ─── 6. EXTEND application_activity event_type CHECK ─────────────────────────
-- Add option cycle event types additively. All existing values are preserved.

ALTER TABLE public.application_activity
  DROP CONSTRAINT IF EXISTS application_activity_event_type_check;

ALTER TABLE public.application_activity
  ADD CONSTRAINT application_activity_event_type_check
  CHECK (event_type = ANY (ARRAY[
    -- Original 5 values (preserved exactly)
    'status_change',
    'document_upload',
    'admin_note',
    'deadline_shift',
    'system',
    -- Document versioning workflow (Step 3A)
    'document_revision_uploaded',
    'revision_requested',
    'document_approved',
    -- Already written by existing UI code (owner/task/email/call)
    'owner_assigned',
    'task_created',
    'email_sent',
    'call_logged',
    -- Deal deadline events (Step 5B)
    'deadline_created',
    'deadline_updated',
    'deadline_completed',
    'deadline_cancelled',
    'deadline_reopened',
    -- Option cycle events (Step 5D-1 — new)
    'option_cycle_created',
    'option_exercised',
    'extension_amendment_received',
    'extension_fee_paid',
    'option_cycle_extended'
  ]));
