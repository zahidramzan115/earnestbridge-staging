-- ============================================================================
-- Phase 7H-5G1C — Calendar-Day Option Exercise Deadline
-- ============================================================================
--
-- APPROVED BUSINESS RULE
--   Option Exercise Deadline = Deposit Goes Hard Date minus exactly 2 CALENDAR DAYS.
--   Cutoff = 5:00 PM America/New_York on the calculated date.
--   Saturdays, Sundays and holidays count as calendar days. The deadline is
--   NOT shifted to another business day.
--
-- This migration:
--   * Adds public.fn_option_deadline_from_hard_date(date) → date
--   * Does NOT modify or drop public.fn_subtract_business_days (retained for
--     compatibility with unrelated business-day calculations).
--   * Does NOT recalculate or update any existing crm_deal_option_cycles rows.
--     Historical deadlines remain as stored.
--
-- Uses PostgreSQL DATE arithmetic (date - integer), which is timezone- and
-- DST-independent.
--
-- NOT YET APPLIED TO PRODUCTION. Apply only after independent review.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_option_deadline_from_hard_date(
  p_hard_date date
)
RETURNS date
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_catalog
AS $$
  SELECT (p_hard_date - 2)::date;
$$;

COMMENT ON FUNCTION public.fn_option_deadline_from_hard_date(date) IS
  'Canonical Option Exercise Deadline: Deposit Goes Hard Date minus exactly 2 calendar days (weekends and holidays count; no business-day shifting). Cutoff is 5:00 PM America/New_York on the returned date. Supersedes fn_subtract_business_days(hard_date, 2) for Option Cycle deadlines (Phase 7H-5G1C).';

-- Match the service-role-only execution posture used for option cycle RPCs.
REVOKE ALL ON FUNCTION public.fn_option_deadline_from_hard_date(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_option_deadline_from_hard_date(date) FROM anon;
REVOKE ALL ON FUNCTION public.fn_option_deadline_from_hard_date(date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_option_deadline_from_hard_date(date) TO service_role;
