-- ============================================================
-- Migration: soft_purge_portal_access_security_foundation
-- Timestamp: 20261007000000
-- Phase: 7G-2
--
-- PURPOSE
-- -------
-- Database/security foundation for:
--   1. Reversible SuperAdmin soft purge of Deals, CRM Contacts and
--      Contact Submissions (columns only; no mutation APIs yet).
--   2. Reason field for the existing borrower_access account-disable
--      mechanism (account-wide Client Portal revocation).
--   3. borrower_access RLS hardening (borrower own-read, Admin read,
--      SuperAdmin-only writes, no user_metadata trust).
--   4. A RESTRICTIVE borrower_applications guard so purged Deals and
--      revoked users are blocked for non-Admin Client operations.
--
-- EXISTING POLICIES IDENTIFIED FROM MIGRATION HISTORY
-- ---------------------------------------------------
-- borrower_access (20260425000001, 20260808230000):
--   "Admins can manage borrower access"   FOR ALL, app_metadata role=admin
--   "Borrowers can read own access row"   FOR SELECT, auth.uid() = user_id
--
-- borrower_applications:
--   borrowers_select_own_application      (20260915002000) SELECT
--   borrowers_insert_own_application      (20260915002000) INSERT
--   borrowers_update_own_application      (20260915002000) UPDATE
--   portal_users_see_own_deals            (20260911000400) SELECT
--                                         owner OR approved CRM contact
--   admins_see_all_applications           (20260911000400) ALL, is_admin_user()
--   admins_read_all_borrower_applications (20260411040000) SELECT
--   admins_update_all_borrower_applications (20260411040000) UPDATE
--   admin_full_access_borrower_applications (20260414002325) ALL, is_admin()
--   (No borrower DELETE policy exists.)
--
-- WHAT IS NOT CHANGED
-- -------------------
-- - All permissive borrower_applications policies above are preserved.
-- - Admin policies are preserved (Admins are exempt from the guard).
-- - No data is backfilled, purged, deleted or modified.
-- - audit_logs event enum is NOT modified.
-- - crm_contacts.is_merged keeps its merge semantics.
-- - crm_contacts.purged_at does NOT affect portal authorization.
-- - service_role bypasses RLS and is unaffected.
-- - No speculative indexes (purged_at is mostly NULL; the
--   borrower_access lookup is by primary key user_id).
-- ============================================================


-- ─── 1. DEAL SOFT-PURGE COLUMNS ──────────────────────────────────────────────

ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS purged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_by    UUID,
  ADD COLUMN IF NOT EXISTS purge_reason TEXT;

COMMENT ON COLUMN public.borrower_applications.purged_at IS
  'Reversible SuperAdmin soft purge timestamp. NULL = active Deal. A non-NULL value hides the Deal from Client Portal and active Admin views; it does NOT delete the Deal or its invoices, payments, receipts or history.';
COMMENT ON COLUMN public.borrower_applications.purged_by IS
  'auth.users id of the SuperAdmin who soft purged this Deal. Reversible soft purge only; the Deal is not deleted.';
COMMENT ON COLUMN public.borrower_applications.purge_reason IS
  'Optional reason recorded with a reversible SuperAdmin soft purge. The underlying Deal is not deleted.';


-- ─── 2. CRM CONTACT SOFT-PURGE COLUMNS ───────────────────────────────────────
-- Independent of is_merged (merge semantics unchanged) and independent of
-- Client Portal access.

ALTER TABLE public.crm_contacts
  ADD COLUMN IF NOT EXISTS purged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_by    UUID,
  ADD COLUMN IF NOT EXISTS purge_reason TEXT;

COMMENT ON COLUMN public.crm_contacts.purged_at IS
  'Reversible SuperAdmin soft purge timestamp. NULL = active Contact. Hides the Contact from Admin CRM views only; does NOT delete the Contact, purge its Deals, or revoke Client Portal access. Separate from is_merged.';
COMMENT ON COLUMN public.crm_contacts.purged_by IS
  'auth.users id of the SuperAdmin who soft purged this Contact. Reversible soft purge only.';
COMMENT ON COLUMN public.crm_contacts.purge_reason IS
  'Optional reason recorded with a reversible SuperAdmin soft purge of a Contact.';


-- ─── 3. CONTACT SUBMISSION SOFT-PURGE COLUMNS ────────────────────────────────

ALTER TABLE public.crm_contact_submissions
  ADD COLUMN IF NOT EXISTS purged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_by    UUID,
  ADD COLUMN IF NOT EXISTS purge_reason TEXT;

COMMENT ON COLUMN public.crm_contact_submissions.purged_at IS
  'Reversible SuperAdmin soft purge timestamp. NULL = active submission. Hides the submission from Admin lead views only; does NOT delete the record and has no portal or Deal effect.';
COMMENT ON COLUMN public.crm_contact_submissions.purged_by IS
  'auth.users id of the SuperAdmin who soft purged this submission. Reversible soft purge only.';
COMMENT ON COLUMN public.crm_contact_submissions.purge_reason IS
  'Optional reason recorded with a reversible SuperAdmin soft purge of a Contact Submission.';


-- ─── 4. BORROWER ACCESS REASON ───────────────────────────────────────────────
-- Existing columns kept: user_id, is_disabled, disabled_at, disabled_by.

ALTER TABLE public.borrower_access
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

COMMENT ON COLUMN public.borrower_access.disabled_reason IS
  'Optional reason recorded when a SuperAdmin disables (revokes) account-wide Client Portal access. Reinstating access sets is_disabled = false.';


-- ─── 5. FUNCTIONS (before policies that reference them) ──────────────────────

-- True when the current auth user has a borrower_access row with
-- is_disabled = true. SECURITY DEFINER so the check does not depend on the
-- caller's own RLS visibility of borrower_access. Reads by primary key only.
CREATE OR REPLACE FUNCTION public.is_portal_access_revoked()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
  SELECT EXISTS (
    SELECT 1
    FROM public.borrower_access ba
    WHERE ba.user_id = auth.uid()
      AND ba.is_disabled = true
  )
$func$;

REVOKE ALL ON FUNCTION public.is_portal_access_revoked() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_portal_access_revoked() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_portal_access_revoked() TO service_role;


-- ─── 6. BORROWER_ACCESS RLS HARDENING ────────────────────────────────────────

ALTER TABLE public.borrower_access ENABLE ROW LEVEL SECURITY;

-- Replace the broad Admin FOR ALL policy (allowed any Admin to mutate).
DROP POLICY IF EXISTS "Admins can manage borrower access" ON public.borrower_access;

-- Keep the existing borrower own-read policy unchanged
-- ("Borrowers can read own access row": SELECT, auth.uid() = user_id).

-- Admin SELECT (operational display). app_metadata only.
DROP POLICY IF EXISTS "borrower_access_admin_select" ON public.borrower_access;
CREATE POLICY "borrower_access_admin_select"
  ON public.borrower_access
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- SuperAdmin INSERT only. app_metadata only.
DROP POLICY IF EXISTS "borrower_access_superadmin_insert" ON public.borrower_access;
CREATE POLICY "borrower_access_superadmin_insert"
  ON public.borrower_access
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    AND (auth.jwt() -> 'app_metadata' ->> 'is_superadmin') = 'true'
  );

-- SuperAdmin UPDATE only. app_metadata only.
DROP POLICY IF EXISTS "borrower_access_superadmin_update" ON public.borrower_access;
CREATE POLICY "borrower_access_superadmin_update"
  ON public.borrower_access
  FOR UPDATE
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    AND (auth.jwt() -> 'app_metadata' ->> 'is_superadmin') = 'true'
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    AND (auth.jwt() -> 'app_metadata' ->> 'is_superadmin') = 'true'
  );

-- No DELETE policy: access is reinstated by UPDATE is_disabled = false.
-- service_role bypasses RLS and keeps full access.


-- ─── 7. BORROWER_APPLICATIONS RESTRICTIVE GUARD ──────────────────────────────
-- Restrictive policies are AND-ed with the existing permissive policies, so
-- owner / approved-contact / user_id checks are NOT weakened or replaced.
--
-- Non-Admin authenticated users must satisfy BOTH:
--   A. the Deal is active (purged_at IS NULL)
--   B. the user is not revoked (no borrower_access.is_disabled = true row)
--
-- Admins (app_metadata role = admin via is_admin_user()) are exempt so
-- Admin tools can inspect/restore purged Deals.
--
-- FOR ALL covers SELECT, INSERT, UPDATE (USING for existing rows, WITH CHECK
-- for new/modified rows, so a Client cannot insert or update a row with
-- purged_at set) and DELETE (no permissive borrower DELETE policy exists, so
-- DELETE stays blocked for Clients).

DROP POLICY IF EXISTS "borrower_applications_active_unrevoked_guard" ON public.borrower_applications;
CREATE POLICY "borrower_applications_active_unrevoked_guard"
  ON public.borrower_applications
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    public.is_admin_user()
    OR (
      purged_at IS NULL
      AND NOT public.is_portal_access_revoked()
    )
  )
  WITH CHECK (
    public.is_admin_user()
    OR (
      purged_at IS NULL
      AND NOT public.is_portal_access_revoked()
    )
  );


-- ============================================================
-- MANUAL VERIFICATION SQL (commented; run manually for review)
-- ============================================================
--
-- A. New columns exist and all existing rows remain active
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name IN ('borrower_applications','crm_contacts','crm_contact_submissions')
--     AND column_name IN ('purged_at','purged_by','purge_reason')
--   ORDER BY table_name, column_name;
--
--   SELECT count(*) FROM public.borrower_applications       WHERE purged_at IS NOT NULL; -- expect 0
--   SELECT count(*) FROM public.crm_contacts                WHERE purged_at IS NOT NULL; -- expect 0
--   SELECT count(*) FROM public.crm_contact_submissions     WHERE purged_at IS NOT NULL; -- expect 0
--
-- B. borrower_access.disabled_reason exists
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='borrower_access'
--     AND column_name='disabled_reason';
--
-- C. borrower_access policies (expect: Borrowers can read own access row,
--    borrower_access_admin_select, borrower_access_superadmin_insert,
--    borrower_access_superadmin_update; no DELETE; no user_metadata)
--   SELECT policyname, cmd, permissive, qual, with_check
--   FROM pg_policies
--   WHERE schemaname='public' AND tablename='borrower_access';
--
-- D. borrower_applications policies (expect existing permissive policies
--    plus RESTRICTIVE borrower_applications_active_unrevoked_guard)
--   SELECT policyname, cmd, permissive
--   FROM pg_policies
--   WHERE schemaname='public' AND tablename='borrower_applications'
--   ORDER BY permissive, policyname;
--
-- E. Behavior checks (run as the relevant role / JWT):
--   CASE A normal borrower, no revoked row, active own Deal  -> SELECT/INSERT/UPDATE still allowed
--   CASE B revoked borrower (borrower_access.is_disabled=true) -> SELECT/INSERT/UPDATE blocked
--   CASE C purged Deal, owner                                 -> hidden
--   CASE D purged Deal, approved portal contact               -> hidden
--   CASE E admin (app_metadata.role='admin')                  -> existing Admin access preserved
--   CASE F regular admin (is_superadmin != true)              -> can SELECT borrower_access, cannot INSERT/UPDATE
--   CASE G superadmin (role='admin', is_superadmin=true)      -> can SELECT, INSERT, UPDATE borrower_access
--   CASE H crm_contacts.purged_at set, portal user active     -> portal access unchanged
--         (no policy in this migration reads crm_contacts.purged_at)
--
--   -- Example: revoked-user check helper (as the user)
--   -- SELECT public.is_portal_access_revoked();
-- ============================================================

-- DISCARDED (Phase 7G-2). This migration was NEVER pushed to Supabase and is intentionally a no-op.
-- It is superseded by 20261007000100_soft_purge_portal_access_security_foundation_v2.sql.
-- This file contains no statements and can be safely deleted from the repository.
SELECT 1;
