-- ============================================================
-- Migration: due_diligence_days_schema
-- Timestamp: 20261005000000
--
-- PHASE 7F-2 — DUE DILIGENCE SCHEMA + TEST-DATA BACKFILL
--
-- PURPOSE
-- -------
-- Introduce the contractual Due Diligence Period (calendar days) as
-- intake/estimating/analytics data.
--
--   1. public.borrower_applications.due_diligence_days  INTEGER NULL
--      + named CHECK (NULL OR 1..999)
--   2. public.crm_contact_submissions.due_diligence_days INTEGER NULL
--      + named CHECK (NULL OR 1..999)
--   3. Deterministic test-data backfill of EXISTING
--      borrower_applications rows only (alternating 30 / 45).
--   4. Concise column comments.
--
-- BUSINESS RULES
-- --------------
-- - due_diligence_days is informational / estimating only.
--   It must NEVER drive Deposit Goes Hard, Option Exercise Deadline,
--   option reminders, auto-close, or extension logic.
-- - closing_date (borrower_applications) and closing_date /
--   target_closing_date (crm_contact_submissions) are NOT touched:
--   not dropped, renamed, updated, nulled, or used for derivation.
-- - Columns are nullable-first for a safe staged rollout. NOT NULL is
--   intentionally NOT added here.
--
-- PROTECTED-FIELDS / RLS
-- ----------------------
-- No trigger or RLS change. due_diligence_days is NOT in
-- protect_borrower_application_admin_fields() (same as closing_date and
-- deposit_amount), and borrower INSERT/UPDATE policies are row-scoped
-- (user_id = auth.uid()) with no column allow-list. The column is
-- therefore borrower-writable intake data via the same path as
-- closing_date / deposit_amount. crm_contact_submissions keeps its
-- existing admin ALL + public INSERT policies.
--
-- NOT TOUCHED
-- -----------
-- crm_deal_option_cycles, fn_subtract_business_days, option-cycle
-- automation, reminders, auto-close, extension logic, email triggers.
--
-- ANALYTICS MODEL NOTE (future; not implemented here)
-- ---------------------------------------------------
-- REQUESTED EMD PIPELINE : Deals where emd_funded_cents IS NULL
--                          -> measure deposit_amount (dollars)
-- FUNDED EMD             : Deals where emd_funded_cents > 0
--                          -> measure emd_funded_cents (cents)
-- A funded Deal must NOT remain in the Requested EMD pipeline bucket.
-- Both fields remain available for requested-vs-funded variance.
--
-- FUTURE NOT NULL
-- ---------------
-- Once /apply, Admin Create Deal, contact-form and BPCON/event forms
-- all require Due Diligence Period, a later migration may consider
-- NOT NULL on borrower_applications.due_diligence_days.
-- crm_contact_submissions may remain nullable (lead payloads evolve).
-- ============================================================


-- ─── 1. borrower_applications.due_diligence_days ─────────────────────────────

ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS due_diligence_days INTEGER NULL;

ALTER TABLE public.borrower_applications
  DROP CONSTRAINT IF EXISTS chk_borrower_applications_due_diligence_days_range;

ALTER TABLE public.borrower_applications
  ADD CONSTRAINT chk_borrower_applications_due_diligence_days_range
  CHECK (due_diligence_days IS NULL OR due_diligence_days BETWEEN 1 AND 999);


-- ─── 2. crm_contact_submissions.due_diligence_days ───────────────────────────

ALTER TABLE public.crm_contact_submissions
  ADD COLUMN IF NOT EXISTS due_diligence_days INTEGER NULL;

ALTER TABLE public.crm_contact_submissions
  DROP CONSTRAINT IF EXISTS chk_crm_contact_submissions_due_diligence_days_range;

ALTER TABLE public.crm_contact_submissions
  ADD CONSTRAINT chk_crm_contact_submissions_due_diligence_days_range
  CHECK (due_diligence_days IS NULL OR due_diligence_days BETWEEN 1 AND 999);


-- ─── 3. Test-data backfill (borrower_applications ONLY) ──────────────────────
-- Existing borrower_applications rows are confirmed test data.
-- Deterministic alternating 30 / 45 ordered by (created_at, id).
-- Only rows where due_diligence_days IS NULL are touched, so re-running
-- the migration never overwrites a value that was set afterwards.
-- No random(). crm_contact_submissions is intentionally NOT backfilled.
-- closing_date is neither read nor written.
--
-- due_diligence_days is not a guarded column, so the
-- guard_borrower_application_admin_fields trigger passes through; the
-- generic updated_at trigger will bump updated_at on backfilled rows.

WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM public.borrower_applications
  WHERE due_diligence_days IS NULL
)
UPDATE public.borrower_applications AS ba
SET due_diligence_days = CASE WHEN numbered.rn % 2 = 1 THEN 30 ELSE 45 END
FROM numbered
WHERE ba.id = numbered.id
  AND ba.due_diligence_days IS NULL;


-- ─── 4. Column comments ──────────────────────────────────────────────────────

COMMENT ON COLUMN public.borrower_applications.due_diligence_days IS
  'Client/Admin supplied contractual due diligence period in calendar days. '
  'Informational/estimating field only; does not drive option-cycle deadlines.';

COMMENT ON COLUMN public.crm_contact_submissions.due_diligence_days IS
  'Lead-submitted due diligence period in calendar days.';


-- ============================================================
-- POST-MIGRATION VERIFICATION SQL (READ-ONLY — run manually after Push)
-- ============================================================
--
-- A. Column exists on borrower_applications
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name   = 'borrower_applications'
--     AND column_name  = 'due_diligence_days';
--
-- B. Column exists on crm_contact_submissions
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name   = 'crm_contact_submissions'
--     AND column_name  = 'due_diligence_days';
--
-- B2. Constraints present
--   SELECT conrelid::regclass AS table_name, conname,
--          pg_get_constraintdef(oid) AS definition
--   FROM pg_constraint
--   WHERE conname IN (
--     'chk_borrower_applications_due_diligence_days_range',
--     'chk_crm_contact_submissions_due_diligence_days_range'
--   );
--
-- C. borrower_applications contain only NULL or 1..999 (expect 0 rows)
--   SELECT id, due_diligence_days
--   FROM public.borrower_applications
--   WHERE due_diligence_days IS NOT NULL
--     AND due_diligence_days NOT BETWEEN 1 AND 999;
--
-- D. Existing borrower applications backfilled to 30/45
--   SELECT due_diligence_days, COUNT(*) AS rows
--   FROM public.borrower_applications
--   GROUP BY due_diligence_days
--   ORDER BY due_diligence_days;
--
--   -- Deterministic alternation check (expect pattern 30,45,30,45,...
--   -- for rows backfilled by this migration)
--   SELECT id, created_at, due_diligence_days,
--          ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
--   FROM public.borrower_applications
--   ORDER BY created_at, id;
--
-- E. crm_contact_submissions remain NULL unless explicitly populated
--   SELECT COUNT(*) FILTER (WHERE due_diligence_days IS NULL)     AS null_rows,
--          COUNT(*) FILTER (WHERE due_diligence_days IS NOT NULL) AS populated_rows
--   FROM public.crm_contact_submissions;
--
-- F. closing_date still exists and was not changed
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name   = 'borrower_applications'
--     AND column_name  = 'closing_date';
--
--   SELECT COUNT(*) AS total_rows,
--          COUNT(closing_date) AS rows_with_closing_date
--   FROM public.borrower_applications;
--   -- Compare these counts to values recorded before the Push.
-- ============================================================
