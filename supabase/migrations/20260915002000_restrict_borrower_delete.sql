-- ============================================================
-- Migration: restrict_borrower_delete
-- Timestamp: 20260915002000
--
-- PURPOSE
-- -------
-- The existing borrower RLS policy:
--   users_manage_own_borrower_applications  (FOR ALL, user_id = auth.uid())
-- includes DELETE because FOR ALL covers SELECT, INSERT, UPDATE, and DELETE.
--
-- No legitimate borrower DELETE workflow exists.  This migration replaces
-- the broad FOR ALL policy with three explicit policies covering only the
-- operations borrowers actually require:
--   SELECT  — borrower may read their own application row
--   INSERT  — borrower may create a row with user_id = auth.uid()
--   UPDATE  — borrower may update their own row (Admin-controlled fields
--              remain protected by the guard_borrower_application_admin_fields
--              trigger from migration 20260915001000)
--
-- DELETE is intentionally omitted.  Borrowers cannot delete their own
-- application rows.  Admins and service-role retain full capability via
-- the existing admins_update_all_borrower_applications policy and
-- service-role bypass.
--
-- WHAT IS NOT CHANGED
-- -------------------
-- - admins_read_all_borrower_applications  — preserved
-- - admins_update_all_borrower_applications — preserved
-- - guard_borrower_application_admin_fields trigger — preserved
-- - protect_borrower_application_admin_fields() function — preserved
-- - is_admin_user() function — preserved
-- - chk_eb_assigned_owner_canonical CHECK constraint — preserved
-- - admin_notes column-level REVOKE — preserved
-- - No historical migrations are modified.
-- - No application code is changed.
-- ============================================================


-- ─── 1. Drop the broad FOR ALL policy ────────────────────────────────────────
-- This policy granted SELECT + INSERT + UPDATE + DELETE to borrowers.
-- We replace it with three explicit, narrowly scoped policies below.

DROP POLICY IF EXISTS users_manage_own_borrower_applications
  ON public.borrower_applications;


-- ─── 2. Borrower SELECT policy ───────────────────────────────────────────────
-- Borrower may read their own application row.

CREATE POLICY borrowers_select_own_application
  ON public.borrower_applications
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());


-- ─── 3. Borrower INSERT policy ───────────────────────────────────────────────
-- Borrower may create a new application row where user_id = auth.uid().
-- WITH CHECK ensures they cannot insert a row belonging to another user.

CREATE POLICY borrowers_insert_own_application
  ON public.borrower_applications
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());


-- ─── 4. Borrower UPDATE policy ───────────────────────────────────────────────
-- Borrower may update their own application row.
-- Admin-controlled field protection is enforced by the
-- guard_borrower_application_admin_fields BEFORE UPDATE trigger
-- (migration 20260915001000), which is independent of this policy.

CREATE POLICY borrowers_update_own_application
  ON public.borrower_applications
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ─── 5. No borrower DELETE policy ────────────────────────────────────────────
-- Intentionally omitted.  No DELETE policy for the authenticated role means
-- borrowers cannot delete their own application rows.
-- Admins retain DELETE capability via the service-role bypass and the
-- admins_update_all_borrower_applications policy (which covers all operations
-- for admin-role users).
-- ============================================================
