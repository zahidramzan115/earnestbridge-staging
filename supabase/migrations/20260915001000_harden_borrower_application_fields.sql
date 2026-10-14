-- ============================================================
-- Migration: harden_borrower_application_fields
-- Timestamp: 20260915001000
--
-- PURPOSE
-- -------
-- Extend the existing eb_assigned_owner protection to cover all
-- clearly Admin-controlled fields on borrower_applications, and
-- block borrower read access to admin_notes via column-level
-- privilege revocation.
--
-- SCOPE
-- -----
-- 1. Consolidated BEFORE UPDATE trigger:
--    protect_borrower_application_admin_fields()
--    Guards the following Admin-only columns:
--      app_status (with a narrow borrower-submission exception)
--      admin_notes
--      admin_created
--      deal_workflow_stage
--      primary_contact_id
--      crm_company_id
--      w9_signed, mou_signed, option_agreement_signed,
--      psa_signed, llc_formed, escrow_funded, option_exercised
--
-- 2. Replaces the previous single-field protect_eb_assigned_owner()
--    trigger with this consolidated guard.  The old trigger is
--    dropped; eb_assigned_owner protection is included here.
--
-- 3. Column-level privilege revocation for admin_notes so that
--    authenticated borrower sessions cannot SELECT that column
--    directly even though RLS grants row-level access.
--
-- 4. CHECK constraint on eb_assigned_owner to enforce canonical
--    owner values at the database level.
--
-- 5. Adds a SET search_path = public, pg_catalog clause to every
--    SECURITY DEFINER function created or updated in this migration
--    (and patches is_admin_user() for the same reason).
--
-- WHAT IS NOT CHANGED
-- -------------------
-- - users_manage_own_borrower_applications (FOR ALL) is preserved.
--   Borrowers still need INSERT + SELECT + UPDATE on their own rows.
-- - admins_update_all_borrower_applications is preserved.
-- - admins_read_all_borrower_applications is preserved.
-- - No historical migrations are modified.
-- - No application code is changed by this migration.
-- ============================================================


-- ─── 1. Patch is_admin_user() with explicit search_path ──────────────────────
-- The existing function has no SET search_path, which is a SECURITY DEFINER
-- vulnerability.  Recreate it with the same logic but a safe search_path.

CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
  SELECT EXISTS (
    SELECT 1 FROM auth.users au
    WHERE au.id = auth.uid()
      AND (
        au.raw_user_meta_data->>'role' = 'admin'
        OR au.raw_app_meta_data->>'role' = 'admin'
      )
  )
$func$;


-- ─── 2. Patch protect_eb_assigned_owner() with explicit search_path ──────────
-- The previous migration created this function without SET search_path.
-- We recreate it here with a safe search_path so it is no longer vulnerable.
-- The consolidated trigger below will supersede it, but we patch it first
-- so the old trigger remains safe until it is dropped in step 4.

CREATE OR REPLACE FUNCTION public.protect_eb_assigned_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_role TEXT;
BEGIN
  IF NEW.eb_assigned_owner IS NOT DISTINCT FROM OLD.eb_assigned_owner THEN
    RETURN NEW;
  END IF;

  v_role := current_setting('role', true);

  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF public.is_admin_user() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Permission denied: eb_assigned_owner may only be changed by an EarnestBridge Admin.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;


-- ─── 3. Consolidated Admin-field guard function ───────────────────────────────
--
-- Logic summary
-- -------------
-- A. If no protected field changed → pass through immediately (zero overhead).
-- B. If caller is service_role → allow (trusted server-side API).
-- C. If caller is is_admin_user() → allow (authenticated Admin JWT).
-- D. Special borrower-submission exception for app_status:
--      A borrower may transition ONLY from ('draft','application') → 'submitted'.
--      Any other borrower-initiated status change is rejected.
-- E. All other protected-field changes by non-Admin, non-service-role → reject.
--
-- Protected fields
-- ----------------
-- eb_assigned_owner, app_status, admin_notes, admin_created,
-- deal_workflow_stage, primary_contact_id, crm_company_id,
-- w9_signed, mou_signed, option_agreement_signed, psa_signed,
-- llc_formed, escrow_funded, option_exercised

CREATE OR REPLACE FUNCTION public.protect_borrower_application_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_role          TEXT;
  v_any_protected BOOLEAN;
BEGIN
  -- ── Fast path: check whether any protected field actually changed ──────────
  v_any_protected :=
       NEW.eb_assigned_owner          IS DISTINCT FROM OLD.eb_assigned_owner
    OR NEW.app_status                 IS DISTINCT FROM OLD.app_status
    OR NEW.admin_notes                IS DISTINCT FROM OLD.admin_notes
    OR NEW.admin_created              IS DISTINCT FROM OLD.admin_created
    OR NEW.deal_workflow_stage        IS DISTINCT FROM OLD.deal_workflow_stage
    OR NEW.primary_contact_id         IS DISTINCT FROM OLD.primary_contact_id
    OR NEW.crm_company_id             IS DISTINCT FROM OLD.crm_company_id
    OR NEW.w9_signed                  IS DISTINCT FROM OLD.w9_signed
    OR NEW.mou_signed                 IS DISTINCT FROM OLD.mou_signed
    OR NEW.option_agreement_signed    IS DISTINCT FROM OLD.option_agreement_signed
    OR NEW.psa_signed                 IS DISTINCT FROM OLD.psa_signed
    OR NEW.llc_formed                 IS DISTINCT FROM OLD.llc_formed
    OR NEW.escrow_funded              IS DISTINCT FROM OLD.escrow_funded
    OR NEW.option_exercised           IS DISTINCT FROM OLD.option_exercised;

  -- Nothing protected changed → allow immediately
  IF NOT v_any_protected THEN
    RETURN NEW;
  END IF;

  -- ── Determine effective database role ─────────────────────────────────────
  v_role := current_setting('role', true);

  -- service_role bypasses this guard (trusted server-side API)
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Authenticated Admin sessions are permitted for all protected fields
  IF public.is_admin_user() THEN
    RETURN NEW;
  END IF;

  -- ── Borrower-submission exception ─────────────────────────────────────────
  -- A borrower may set app_status = 'submitted' when transitioning from
  -- 'draft' or 'application'.  This is the ONLY protected-field change a
  -- borrower is permitted to make.  All other protected fields must remain
  -- unchanged in the same UPDATE for this exception to apply.
  IF
    -- Only app_status changed among protected fields
    NEW.app_status                 IS DISTINCT FROM OLD.app_status
    AND NEW.eb_assigned_owner          IS NOT DISTINCT FROM OLD.eb_assigned_owner
    AND NEW.admin_notes                IS NOT DISTINCT FROM OLD.admin_notes
    AND NEW.admin_created              IS NOT DISTINCT FROM OLD.admin_created
    AND NEW.deal_workflow_stage        IS NOT DISTINCT FROM OLD.deal_workflow_stage
    AND NEW.primary_contact_id         IS NOT DISTINCT FROM OLD.primary_contact_id
    AND NEW.crm_company_id             IS NOT DISTINCT FROM OLD.crm_company_id
    AND NEW.w9_signed                  IS NOT DISTINCT FROM OLD.w9_signed
    AND NEW.mou_signed                 IS NOT DISTINCT FROM OLD.mou_signed
    AND NEW.option_agreement_signed    IS NOT DISTINCT FROM OLD.option_agreement_signed
    AND NEW.psa_signed                 IS NOT DISTINCT FROM OLD.psa_signed
    AND NEW.llc_formed                 IS NOT DISTINCT FROM OLD.llc_formed
    AND NEW.escrow_funded              IS NOT DISTINCT FROM OLD.escrow_funded
    AND NEW.option_exercised           IS NOT DISTINCT FROM OLD.option_exercised
    -- Transition is exactly: (draft|application) → submitted
    AND NEW.app_status::TEXT = 'submitted'
    AND OLD.app_status::TEXT IN ('draft', 'application')
  THEN
    -- Legitimate borrower submission — allow
    RETURN NEW;
  END IF;

  -- ── All other cases: reject ────────────────────────────────────────────────
  RAISE EXCEPTION
    'Permission denied: one or more Admin-controlled fields on borrower_applications '
    'may only be changed by an EarnestBridge Admin or trusted server process.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;


-- ─── 4. Drop old single-field trigger and attach consolidated trigger ─────────

DROP TRIGGER IF EXISTS guard_eb_assigned_owner ON public.borrower_applications;

DROP TRIGGER IF EXISTS guard_borrower_application_admin_fields ON public.borrower_applications;
CREATE TRIGGER guard_borrower_application_admin_fields
  BEFORE UPDATE ON public.borrower_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_borrower_application_admin_fields();


-- ─── 5. CHECK constraint: canonical eb_assigned_owner values ─────────────────
-- Prevents arbitrary strings from being stored even through Admin or
-- service-role paths.  Canonical values: Eric, Dan, Tucker, NULL.
--
-- IMPORTANT: The column was originally created with DEFAULT 'Unassigned'.
-- Existing rows may have 'Unassigned' stored as a literal string.
-- We must normalize those to NULL before adding the constraint, and also
-- change the column default to NULL so future rows do not violate it.

-- Step 5a: Normalize existing 'Unassigned' string values to NULL
ALTER TABLE public.borrower_applications DISABLE TRIGGER guard_borrower_application_admin_fields;
UPDATE public.borrower_applications
  SET eb_assigned_owner = NULL
  WHERE eb_assigned_owner = 'Unassigned';
ALTER TABLE public.borrower_applications ENABLE TRIGGER guard_borrower_application_admin_fields;

-- Step 5b: Change the column default from 'Unassigned' to NULL
ALTER TABLE public.borrower_applications
  ALTER COLUMN eb_assigned_owner SET DEFAULT NULL;

-- Step 5c: Drop any pre-existing version of the constraint (idempotent)
ALTER TABLE public.borrower_applications
  DROP CONSTRAINT IF EXISTS chk_eb_assigned_owner_canonical;

-- Step 5d: Add the constraint (all rows now satisfy it)
ALTER TABLE public.borrower_applications
  ADD CONSTRAINT chk_eb_assigned_owner_canonical
  CHECK (
    eb_assigned_owner IS NULL
    OR eb_assigned_owner IN ('Eric', 'Dan', 'Tucker')
  );


-- ─── 6. Column-level privilege: revoke admin_notes SELECT from public role ────
--
-- PostgreSQL RLS protects rows, not columns.  A borrower whose row passes
-- the users_manage_own_borrower_applications SELECT policy can currently
-- read admin_notes.  Revoking column-level SELECT on admin_notes from the
-- 'authenticated' role (which maps to the anon/authenticated Supabase role)
-- prevents this without touching RLS policies.
--
-- The service_role and postgres superuser are unaffected.
-- Admin reads go through the admins_read_all_borrower_applications policy
-- which uses is_admin_user(); however column-level REVOKE applies to ALL
-- non-superuser roles including admins using the anon key.
--
-- APPROACH CHOSEN: REVOKE column-level SELECT on admin_notes from the
-- 'authenticated' role.  Admin reads of admin_notes must use the
-- service-role client (already the case for all Admin API endpoints).
-- The BorrowerDetailContent component reads the full row via the Admin
-- Supabase client (authenticated JWT) — this will no longer return
-- admin_notes in the column list.  The field is only needed server-side
-- in Admin API routes that already use service_role.
--
-- If this causes issues with existing Admin UI reads, the alternative is
-- to move admin_notes to a separate admin-only table.  The REVOKE approach
-- is the least-destructive option.

REVOKE SELECT (admin_notes) ON public.borrower_applications FROM authenticated;

-- Ensure service_role retains full access (it always does as a superuser
-- equivalent, but we make it explicit for clarity).
GRANT SELECT (admin_notes) ON public.borrower_applications TO service_role;


-- ─── 7. Patch crm_check_portal_user_match() with safe search_path ────────────
-- This SECURITY DEFINER function was created without SET search_path.

CREATE OR REPLACE FUNCTION public.crm_check_portal_user_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  matched_contact_id UUID;
  contact_name TEXT;
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    IF (OLD.email_confirmed_at IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    IF (NEW.email_confirmed_at IS NULL) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF (NEW.raw_user_meta_data->>'role' = 'admin' OR NEW.raw_app_meta_data->>'role' = 'admin') THEN
    RETURN NEW;
  END IF;

  SELECT id, (first_name || ' ' || last_name)
  INTO matched_contact_id, contact_name
  FROM public.crm_contacts
  WHERE lower(trim(primary_email)) = lower(trim(NEW.email))
    AND is_merged = false
    AND portal_user_id IS NULL
  LIMIT 1;

  IF matched_contact_id IS NOT NULL THEN
    UPDATE public.crm_contacts
    SET
      portal_user_id = NEW.id,
      portal_link_status = 'pending',
      portal_linked_at = now(),
      updated_at = now()
    WHERE id = matched_contact_id;

    INSERT INTO public.crm_activities (
      contact_id,
      event_type,
      title,
      detail,
      actor,
      actor_user_id
    ) VALUES (
      matched_contact_id,
      'portal_account_registered',
      'Portal account registered — pending Admin approval',
      'User registered with email ' || NEW.email || '. Portal access pending Admin review.',
      'System',
      NEW.id
    );

    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      message,
      crm_contact_id
    )
    SELECT
      au.id,
      'crm_portal_match',
      'Portal Account Match: ' || contact_name,
      NEW.email || ' registered and matches existing CRM Contact. Review and approve portal access.',
      matched_contact_id
    FROM auth.users au
    WHERE au.raw_app_meta_data->>'role' = 'admin'
       OR au.raw_user_meta_data->>'role' = 'admin'
    LIMIT 5;
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'CRM portal match check failed for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$func$;
