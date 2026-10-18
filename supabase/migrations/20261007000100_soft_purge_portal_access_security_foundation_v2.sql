-- ============================================================
-- Migration: soft_purge_portal_access_security_foundation_v2
-- Timestamp: 20261007000100
-- Phase: 7G-2B (corrected; supersedes the discarded, never-pushed
--        20261007000000_soft_purge_portal_access_security_foundation.sql,
--        which is now a no-op)
--
-- PURPOSE
-- -------
--   1. Reversible SuperAdmin soft-purge metadata on Deals, CRM Contacts
--      and Contact Submissions (columns only; no mutation APIs yet).
--   2. borrower_access.disabled_reason for account-wide portal revocation.
--   3. borrower_access RLS hardening (borrower own-read, Admin read,
--      SuperAdmin-only INSERT/UPDATE, no user_metadata trust, no DELETE).
--   4. is_portal_access_revoked() helper.
--   5. RESTRICTIVE borrower_applications guard (purged Deals + revoked users
--      blocked for non-Admin Client sessions).
--   6. DATABASE-LEVEL protection of purge metadata: only SuperAdmin or
--      service_role may set/clear purged_at / purged_by / purge_reason.
--   7. Block authenticated hard DELETE on the three soft-purgeable tables.
--
-- POLICY INSPECTION (from migration history)
-- ------------------------------------------
-- borrower_access (20260425000001, 20260808230000):
--   "Admins can manage borrower access"   FOR ALL  (app_metadata admin)
--   "Borrowers can read own access row"   SELECT   (auth.uid() = user_id)
--
-- borrower_applications:
--   borrowers_select_own_application        SELECT  (20260915002000)
--   borrowers_insert_own_application        INSERT  (20260915002000)
--   borrowers_update_own_application        UPDATE  (20260915002000)
--   portal_users_see_own_deals              SELECT  (20260911000400) owner OR approved contact
--   admins_see_all_applications             ALL     is_admin_user()  (20260911000400)
--   admins_read_all_borrower_applications   SELECT  (20260411040000)
--   admins_update_all_borrower_applications UPDATE  (20260411040000)
--   admin_full_access_borrower_applications ALL     is_admin()       (20260414002325)
--   => Regular Admins currently have UPDATE **and DELETE** through the broad
--      FOR ALL policies. No borrower DELETE policy exists.
--   Existing triggers: guard_borrower_application_admin_fields (BEFORE UPDATE),
--      borrower_applications_updated_at, email triggers. Not modified here.
--
-- crm_contacts (20260911000000):
--   admins_all_crm_contacts        ALL     is_admin_user()  => Admin UPDATE + DELETE
--   portal_users_read_own_contact  SELECT  portal_user_id = auth.uid() AND approved
--
-- crm_contact_submissions (20260911000000):
--   admins_all_crm_submissions     ALL     is_admin_user()  => Admin UPDATE + DELETE
--   public_insert_crm_submissions  INSERT  anon, authenticated  WITH CHECK (true)
--   (public INSERT stays allowed; purge-metadata trigger still rejects
--    non-NULL purge fields from non-SuperAdmin/non-service_role callers.)
--
-- SUPERADMIN / SERVICE ROLE PATTERN
-- ---------------------------------
-- Existing project patterns reused:
--   * service_role: current_setting('role', true) = 'service_role'
--     (protect_borrower_application_admin_fields, 20260915001000)
--   * Admin: JWT app_metadata role = 'admin' (borrower_access policies)
-- SuperAdmin = app_metadata.role = 'admin' AND app_metadata.is_superadmin = true,
-- read from the verified JWT (auth.jwt()). user_metadata is never read.
-- Regular Admins are NOT SuperAdmins.
--
-- HARD DELETE FINDINGS
-- --------------------
-- * borrower_applications: Admin Deals UI performs a browser-side hard
--   DELETE (AdminDealsContent.tsx). Replaced by soft purge in a later phase.
-- * crm_contacts: no physical DELETE in browser or API. The
--   DELETE /api/crm/contacts/[id] route is a service-role soft delete
--   (is_merged = true), unaffected by this migration.
-- * crm_contact_submissions: no physical DELETE anywhere in the app.
-- => No active workflow requires authenticated physical DELETE on any of
--    the three tables, so all three are blocked. service_role bypasses RLS
--    and retains DB-level capability.
--
-- NOT CHANGED
-- -----------
-- Existing permissive policies, Admin policies, existing triggers,
-- audit_logs enum, crm_contacts.is_merged, app_status, DD, EMD, closing_date,
-- option cycles, fees, invoices, payments, receipts, existing data.
-- crm_contacts.purged_at does NOT affect portal authorization.
-- No indexes added (purged_at columns are mostly NULL; borrower_access
-- lookup is by primary key user_id).
-- ============================================================


-- ─── 1. SOFT-PURGE COLUMNS ───────────────────────────────────────────────────
-- Existing rows remain active (all NULL). Nothing is backfilled.

ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS purged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_by    UUID,
  ADD COLUMN IF NOT EXISTS purge_reason TEXT;

COMMENT ON COLUMN public.borrower_applications.purged_at IS
  'Reversible SuperAdmin soft purge timestamp. NULL = active Deal. Non-NULL hides the Deal from the Client Portal and active Admin views; it does NOT delete the Deal or its invoices, payments, receipts or history. Only SuperAdmin or service_role may change it (enforced by trigger).';
COMMENT ON COLUMN public.borrower_applications.purged_by IS
  'auth.users id of the SuperAdmin who soft purged this Deal. Reversible soft purge only; the Deal is not deleted.';
COMMENT ON COLUMN public.borrower_applications.purge_reason IS
  'Optional reason recorded with a reversible SuperAdmin soft purge. The underlying Deal is not deleted.';

ALTER TABLE public.crm_contacts
  ADD COLUMN IF NOT EXISTS purged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_by    UUID,
  ADD COLUMN IF NOT EXISTS purge_reason TEXT;

COMMENT ON COLUMN public.crm_contacts.purged_at IS
  'Reversible SuperAdmin soft purge timestamp. NULL = active Contact. Hides the Contact from Admin CRM views only; does NOT delete the Contact, purge its Deals, or revoke Client Portal access. Independent of is_merged.';
COMMENT ON COLUMN public.crm_contacts.purged_by IS
  'auth.users id of the SuperAdmin who soft purged this Contact. Reversible soft purge only.';
COMMENT ON COLUMN public.crm_contacts.purge_reason IS
  'Optional reason recorded with a reversible SuperAdmin soft purge of a Contact.';

ALTER TABLE public.crm_contact_submissions
  ADD COLUMN IF NOT EXISTS purged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_by    UUID,
  ADD COLUMN IF NOT EXISTS purge_reason TEXT;

COMMENT ON COLUMN public.crm_contact_submissions.purged_at IS
  'Reversible SuperAdmin soft purge timestamp. NULL = active submission. Hides it from Admin lead views only; does NOT delete the record and has no portal or Deal effect.';
COMMENT ON COLUMN public.crm_contact_submissions.purged_by IS
  'auth.users id of the SuperAdmin who soft purged this submission. Reversible soft purge only.';
COMMENT ON COLUMN public.crm_contact_submissions.purge_reason IS
  'Optional reason recorded with a reversible SuperAdmin soft purge of a Contact Submission.';


-- ─── 2. BORROWER ACCESS REASON ───────────────────────────────────────────────
-- Reuses existing public.borrower_access (user_id, is_disabled, disabled_at,
-- disabled_by). No second access table is created.

ALTER TABLE public.borrower_access
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

COMMENT ON COLUMN public.borrower_access.disabled_reason IS
  'Optional reason recorded when a SuperAdmin disables (revokes) account-wide Client Portal access. Reinstating access sets is_disabled = false.';


-- ─── 3. HELPER FUNCTIONS ─────────────────────────────────────────────────────

-- SuperAdmin: verified JWT app_metadata only (never user_metadata).
-- SECURITY INVOKER (default) so auth.jwt() reflects the real caller.
CREATE OR REPLACE FUNCTION public.is_superadmin_jwt()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $func$
  SELECT
    COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    AND COALESCE(auth.jwt() -> 'app_metadata' ->> 'is_superadmin', '') = 'true'
$func$;

-- service_role: same detection pattern already used by
-- protect_borrower_application_admin_fields() (current_setting('role')).
CREATE OR REPLACE FUNCTION public.is_service_role_caller()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $func$
  SELECT COALESCE(current_setting('role', true), '') = 'service_role'
$func$;

-- Portal revocation: true when the current auth user has a borrower_access
-- row with is_disabled = true. SECURITY DEFINER so the check does not depend
-- on the caller's own RLS visibility of borrower_access. Read-only, fixed
-- search_path, primary-key lookup.
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

REVOKE ALL ON FUNCTION public.is_superadmin_jwt()        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_service_role_caller()   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_portal_access_revoked() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_superadmin_jwt()        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_service_role_caller()   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_portal_access_revoked() TO authenticated, service_role;


-- ─── 4. BORROWER_ACCESS RLS HARDENING ────────────────────────────────────────
-- Final behavior:
--   Borrower:     SELECT own row only
--   Regular Admin: SELECT only
--   SuperAdmin:   SELECT, INSERT, UPDATE
--   DELETE:       none (reinstate via UPDATE is_disabled = false)
--   service_role: bypasses RLS (unchanged)

ALTER TABLE public.borrower_access ENABLE ROW LEVEL SECURITY;

-- Drop only the exact old broad Admin FOR ALL policy (20260425000001 /
-- 20260808230000) which let any Admin mutate access.
DROP POLICY IF EXISTS "Admins can manage borrower access" ON public.borrower_access;

-- "Borrowers can read own access row" (SELECT, auth.uid() = user_id) is kept.

DROP POLICY IF EXISTS "borrower_access_admin_select" ON public.borrower_access;
CREATE POLICY "borrower_access_admin_select"
  ON public.borrower_access
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "borrower_access_superadmin_insert" ON public.borrower_access;
CREATE POLICY "borrower_access_superadmin_insert"
  ON public.borrower_access
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_superadmin_jwt());

DROP POLICY IF EXISTS "borrower_access_superadmin_update" ON public.borrower_access;
CREATE POLICY "borrower_access_superadmin_update"
  ON public.borrower_access
  FOR UPDATE
  TO authenticated
  USING (public.is_superadmin_jwt())
  WITH CHECK (public.is_superadmin_jwt());


-- ─── 5. BORROWER_APPLICATIONS RESTRICTIVE CLIENT GUARD ───────────────────────
-- RESTRICTIVE policies are AND-ed with the existing permissive policies, so
-- owner / approved-contact / user_id checks are not weakened or replaced.
-- Admins (is_admin_user(): app_metadata role = admin) are exempt so Admin
-- tools can inspect/restore purged Deals.
-- Split per command (not FOR ALL) so the DELETE block in section 7 stays
-- independent and clearly named.

DROP POLICY IF EXISTS "borrower_applications_active_unrevoked_guard" ON public.borrower_applications;

DROP POLICY IF EXISTS "borrower_applications_active_unrevoked_guard_select" ON public.borrower_applications;
CREATE POLICY "borrower_applications_active_unrevoked_guard_select"
  ON public.borrower_applications
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin_user()
    OR (purged_at IS NULL AND NOT public.is_portal_access_revoked())
  );

DROP POLICY IF EXISTS "borrower_applications_active_unrevoked_guard_insert" ON public.borrower_applications;
CREATE POLICY "borrower_applications_active_unrevoked_guard_insert"
  ON public.borrower_applications
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin_user()
    OR (purged_at IS NULL AND NOT public.is_portal_access_revoked())
  );

DROP POLICY IF EXISTS "borrower_applications_active_unrevoked_guard_update" ON public.borrower_applications;
CREATE POLICY "borrower_applications_active_unrevoked_guard_update"
  ON public.borrower_applications
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (
    public.is_admin_user()
    OR (purged_at IS NULL AND NOT public.is_portal_access_revoked())
  )
  WITH CHECK (
    public.is_admin_user()
    OR (purged_at IS NULL AND NOT public.is_portal_access_revoked())
  );


-- ─── 6. PURGE METADATA DATABASE GUARD ────────────────────────────────────────
-- RLS cannot restrict individual columns, and regular Admins legitimately
-- edit other columns. A BEFORE INSERT OR UPDATE trigger therefore rejects any
-- set/change/clear of purged_at, purged_by or purge_reason unless the caller
-- is SuperAdmin (verified JWT app_metadata) or service_role.
--
-- SECURITY INVOKER (default): auth.jwt() and current_setting('role') reflect
-- the real caller. user_metadata is never read. Regular Admins are NOT
-- SuperAdmins. Normal writes with all three purge fields NULL/unchanged pass
-- through immediately.

CREATE OR REPLACE FUNCTION public.guard_purge_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $func$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.purged_at IS NULL
       AND NEW.purged_by IS NULL
       AND NEW.purge_reason IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.purged_at    IS NOT DISTINCT FROM OLD.purged_at
       AND NEW.purged_by    IS NOT DISTINCT FROM OLD.purged_by
       AND NEW.purge_reason IS NOT DISTINCT FROM OLD.purge_reason THEN
      RETURN NEW;
    END IF;
  END IF;

  IF public.is_service_role_caller() OR public.is_superadmin_jwt() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Permission denied: purge metadata (purged_at, purged_by, purge_reason) may only be changed by a SuperAdmin or service_role.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

REVOKE ALL ON FUNCTION public.guard_purge_metadata() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_purge_metadata_borrower_applications ON public.borrower_applications;
CREATE TRIGGER guard_purge_metadata_borrower_applications
  BEFORE INSERT OR UPDATE ON public.borrower_applications
  FOR EACH ROW EXECUTE FUNCTION public.guard_purge_metadata();

DROP TRIGGER IF EXISTS guard_purge_metadata_crm_contacts ON public.crm_contacts;
CREATE TRIGGER guard_purge_metadata_crm_contacts
  BEFORE INSERT OR UPDATE ON public.crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_purge_metadata();

DROP TRIGGER IF EXISTS guard_purge_metadata_crm_contact_submissions ON public.crm_contact_submissions;
CREATE TRIGGER guard_purge_metadata_crm_contact_submissions
  BEFORE INSERT OR UPDATE ON public.crm_contact_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_purge_metadata();


-- ─── 7. HARD DELETE PROTECTION ───────────────────────────────────────────────
-- A RESTRICTIVE DELETE policy with USING (false) is AND-ed with the existing
-- permissive Admin FOR ALL policies, so authenticated Admin, SuperAdmin and
-- Client browser sessions can no longer physically DELETE. service_role
-- bypasses RLS and keeps DB-level capability. Soft purge replaces deletion.

DROP POLICY IF EXISTS "borrower_applications_block_authenticated_delete" ON public.borrower_applications;
CREATE POLICY "borrower_applications_block_authenticated_delete"
  ON public.borrower_applications
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (false);

DROP POLICY IF EXISTS "crm_contacts_block_authenticated_delete" ON public.crm_contacts;
CREATE POLICY "crm_contacts_block_authenticated_delete"
  ON public.crm_contacts
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (false);

DROP POLICY IF EXISTS "crm_contact_submissions_block_authenticated_delete" ON public.crm_contact_submissions;
CREATE POLICY "crm_contact_submissions_block_authenticated_delete"
  ON public.crm_contact_submissions
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (false);


-- ============================================================
-- MANUAL VERIFICATION SQL (commented; run manually for review)
-- ============================================================
--
-- A. Columns exist; all existing rows remain active
--   SELECT table_name, column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name IN ('borrower_applications','crm_contacts','crm_contact_submissions')
--     AND column_name IN ('purged_at','purged_by','purge_reason')
--   ORDER BY table_name, column_name;
--   SELECT count(*) FROM public.borrower_applications   WHERE purged_at IS NOT NULL; -- 0
--   SELECT count(*) FROM public.crm_contacts            WHERE purged_at IS NOT NULL; -- 0
--   SELECT count(*) FROM public.crm_contact_submissions WHERE purged_at IS NOT NULL; -- 0
--
-- B. borrower_access.disabled_reason
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='borrower_access' AND column_name='disabled_reason';
--
-- C. Policies (expect: borrower_access = own-read, admin_select, superadmin_insert,
--    superadmin_update only; borrower_applications = existing permissive +
--    RESTRICTIVE guard_select/insert/update + RESTRICTIVE block_authenticated_delete;
--    crm_contacts / crm_contact_submissions = existing + RESTRICTIVE block delete)
--   SELECT tablename, policyname, cmd, permissive, qual, with_check
--   FROM pg_policies
--   WHERE schemaname='public'
--     AND tablename IN ('borrower_access','borrower_applications','crm_contacts','crm_contact_submissions')
--   ORDER BY tablename, permissive, policyname;
--
-- D. Triggers
--   SELECT event_object_table, trigger_name, event_manipulation
--   FROM information_schema.triggers
--   WHERE trigger_name LIKE 'guard_purge_metadata_%'
--   ORDER BY event_object_table, event_manipulation;
--
-- E. Behavior checks (run under the relevant role / JWT):
--   CASE A  normal Client, no revoked row, active Deal      -> SELECT/INSERT/UPDATE allowed
--   CASE B  revoked Client (is_disabled=true)               -> SELECT/INSERT/UPDATE blocked
--   CASE C  purged Deal, owner                              -> not returned
--   CASE D  purged Deal, approved contact                   -> not returned
--   CASE E  regular Admin edits non-purge Deal/Contact field-> allowed
--   CASE F  regular Admin sets purged_at/by/reason          -> ERROR insufficient_privilege
--   CASE G  regular Admin clears purge metadata             -> ERROR insufficient_privilege
--   CASE H  SuperAdmin changes purge metadata               -> allowed
--   CASE I  service_role changes purge metadata             -> allowed
--   CASE J  Client sets purge metadata on own application   -> ERROR (trigger) / blocked (RLS)
--   CASE K  Admin/SuperAdmin/Client DELETE borrower_applications -> 0 rows deleted (blocked)
--   CASE L  crm_contacts.purged_at set, portal user active  -> portal access unchanged
--           (no policy or helper in this migration reads crm_contacts.purged_at)
--   CASE M  regular Admin on borrower_access                -> SELECT ok; INSERT/UPDATE/DELETE blocked
--   CASE N  SuperAdmin on borrower_access                   -> SELECT/INSERT/UPDATE ok
--
--   -- As a user:  SELECT public.is_portal_access_revoked();
--   -- As a user:  SELECT public.is_superadmin_jwt(), public.is_service_role_caller();
-- ============================================================
