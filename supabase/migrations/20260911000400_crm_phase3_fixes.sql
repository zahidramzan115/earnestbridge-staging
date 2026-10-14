-- ============================================================
-- CRM Phase 3 Fixes
-- Migration: 20260911000400_crm_phase3_fixes.sql
--
-- Fixes:
-- 1. Alternate email portal matching (trigger extension)
-- 2. crm_company_id column on borrower_applications
-- 3. notifications table crm_contact_id column (safe add)
-- 4. Contact form idempotency table
-- 5. RLS hardening: portal users cannot read internal CRM data
-- 6. Active deal contacts metric support
-- 7. Deal → CRM contact association on admin-created deals
-- 8. Ensure one primary contact per deal constraint
-- ============================================================

-- ─── 1. SAFE: Add crm_company_id to borrower_applications ────────────────────
-- Allows deals to be explicitly linked to a CRM company record

ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS crm_company_id UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ba_crm_company ON public.borrower_applications(crm_company_id);

-- ─── 2. SAFE: Add crm_contact_id to notifications ────────────────────────────
-- Migration 000200 inserts with crm_contact_id; ensure column exists

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS crm_contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_crm_contact ON public.notifications(crm_contact_id);

-- ─── 3. CONTACT FORM IDEMPOTENCY TABLE ───────────────────────────────────────
-- Prevents duplicate submissions from rapid double-clicks.
-- Key = hash of (email + message + timestamp-window).
-- Expires after 30 seconds.

CREATE TABLE IF NOT EXISTS public.crm_submission_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  contact_id      UUID REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 seconds')
);

CREATE INDEX IF NOT EXISTS idx_crm_idempotency_expires ON public.crm_submission_idempotency(expires_at);

ALTER TABLE public.crm_submission_idempotency ENABLE ROW LEVEL SECURITY;

-- Public can insert (needed for anon contact form)
DROP POLICY IF EXISTS "public_insert_idempotency" ON public.crm_submission_idempotency;
CREATE POLICY "public_insert_idempotency"
  ON public.crm_submission_idempotency FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- Public can select their own key (to check for duplicates)
DROP POLICY IF EXISTS "public_select_idempotency" ON public.crm_submission_idempotency;
CREATE POLICY "public_select_idempotency"
  ON public.crm_submission_idempotency FOR SELECT TO anon, authenticated
  USING (true);

-- Admins can manage
DROP POLICY IF EXISTS "admins_all_idempotency" ON public.crm_submission_idempotency;
CREATE POLICY "admins_all_idempotency"
  ON public.crm_submission_idempotency FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- ─── 4. EXTEND PORTAL CLAIMING TRIGGER: ALTERNATE EMAIL MATCHING ─────────────
-- When a user verifies their email, also check crm_contact_emails (alternate emails)

CREATE OR REPLACE FUNCTION public.crm_check_portal_user_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  matched_contact_id UUID;
  contact_name TEXT;
  match_source TEXT;
BEGIN
  -- Only fire when email_confirmed_at transitions from NULL to a value
  IF (TG_OP = 'UPDATE') THEN
    IF (OLD.email_confirmed_at IS NOT NULL) THEN
      RETURN NEW; -- Already confirmed, skip
    END IF;
    IF (NEW.email_confirmed_at IS NULL) THEN
      RETURN NEW; -- Not yet confirmed, skip
    END IF;
  END IF;

  -- Skip admin users
  IF (NEW.raw_user_meta_data->>'role' = 'admin' OR NEW.raw_app_meta_data->>'role' = 'admin') THEN
    RETURN NEW;
  END IF;

  -- 1. Look for a matching CRM contact by PRIMARY email
  SELECT id, (first_name || ' ' || last_name), 'primary_email'
  INTO matched_contact_id, contact_name, match_source
  FROM public.crm_contacts
  WHERE lower(trim(primary_email)) = lower(trim(NEW.email))
    AND is_merged = false
    AND portal_user_id IS NULL  -- Not already linked
  LIMIT 1;

  -- 2. If not found by primary, check ALTERNATE emails
  IF matched_contact_id IS NULL THEN
    SELECT c.id, (c.first_name || ' ' || c.last_name), 'alternate_email'
    INTO matched_contact_id, contact_name, match_source
    FROM public.crm_contact_emails ce
    JOIN public.crm_contacts c ON c.id = ce.contact_id
    WHERE lower(trim(ce.email)) = lower(trim(NEW.email))
      AND c.is_merged = false
      AND c.portal_user_id IS NULL
    LIMIT 1;
  END IF;

  IF matched_contact_id IS NOT NULL THEN
    -- Link the user to the contact with pending status
    UPDATE public.crm_contacts
    SET
      portal_user_id = NEW.id,
      portal_link_status = 'pending',
      portal_linked_at = now(),
      updated_at = now()
    WHERE id = matched_contact_id;

    -- Log activity
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
      'User registered with email ' || NEW.email || ' (matched via ' || match_source || '). Portal access pending Admin review.',
      'System',
      NEW.id
    );

    -- Create in-app notification for admin
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
      NEW.email || ' registered and matches existing CRM Contact (via ' || match_source || '). Review and approve portal access.',
      matched_contact_id
    FROM auth.users au
    WHERE au.raw_app_meta_data->>'role' = 'admin'
       OR au.raw_user_meta_data->>'role' = 'admin'
    LIMIT 5;

  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN

    RETURN NEW;
END;
$$;

-- Trigger already exists from migration 000200; function replacement is sufficient.
-- Re-create trigger to ensure it's attached to the updated function.
DROP TRIGGER IF EXISTS crm_portal_user_match_trigger ON auth.users;
CREATE TRIGGER crm_portal_user_match_trigger
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_check_portal_user_match();

-- ─── 5. RLS: PORTAL USERS CANNOT READ CRM INTERNAL DATA ──────────────────────

-- crm_activities: portal users must NOT see any activities
-- (admins_all policy already covers admin reads; portal users have no policy = no access)
-- Verify no accidental portal read policy exists:
DROP POLICY IF EXISTS "portal_users_read_activities" ON public.crm_activities;
DROP POLICY IF EXISTS "portal_read_activities" ON public.crm_activities;

-- crm_tasks: portal users must NOT see tasks
DROP POLICY IF EXISTS "portal_users_read_tasks" ON public.crm_tasks;
DROP POLICY IF EXISTS "portal_read_tasks" ON public.crm_tasks;

-- crm_contact_submissions: portal users must NOT see submissions
DROP POLICY IF EXISTS "portal_users_read_submissions" ON public.crm_contact_submissions;
DROP POLICY IF EXISTS "portal_read_submissions" ON public.crm_contact_submissions;

-- crm_email_log: portal users must NOT see email logs
DROP POLICY IF EXISTS "portal_users_read_email_log" ON public.crm_email_log;
DROP POLICY IF EXISTS "portal_read_email_log" ON public.crm_email_log;

-- crm_companies: portal users must NOT see company records
DROP POLICY IF EXISTS "portal_users_read_companies" ON public.crm_companies;
DROP POLICY IF EXISTS "portal_read_companies" ON public.crm_companies;

-- crm_contacts: portal users can ONLY read their own linked contact (already set in 000000)
-- Ensure no policy accidentally exposes other contacts:
DROP POLICY IF EXISTS "portal_users_read_all_contacts" ON public.crm_contacts;
DROP POLICY IF EXISTS "portal_read_all_contacts" ON public.crm_contacts;

-- ─── 6. PORTAL DEAL VISIBILITY: STRICT CONTACT-LEVEL RLS ─────────────────────
-- Portal users may ONLY see deals where their approved contact is in crm_deal_contacts.
-- This replaces any looser policy that might exist.

-- First ensure borrower_applications has RLS enabled (should already be true)
ALTER TABLE public.borrower_applications ENABLE ROW LEVEL SECURITY;

-- Drop any existing portal deal visibility policy
DROP POLICY IF EXISTS "portal_users_see_own_deals" ON public.borrower_applications;
DROP POLICY IF EXISTS "borrower_see_own_applications" ON public.borrower_applications;
DROP POLICY IF EXISTS "users_see_own_applications" ON public.borrower_applications;

-- Recreate: portal users see deals where:
--   (a) their user_id is directly on the deal (legacy), OR
--   (b) their approved CRM contact is in crm_deal_contacts for that deal
CREATE POLICY "portal_users_see_own_deals"
  ON public.borrower_applications FOR SELECT TO authenticated
  USING (
    -- Legacy: direct user_id match
    user_id = auth.uid()
    OR
    -- CRM contact-level: user has an approved contact linked to this deal
    EXISTS (
      SELECT 1
      FROM public.crm_deal_contacts dc
      JOIN public.crm_contacts c ON c.id = dc.contact_id
      WHERE dc.deal_id = borrower_applications.id
        AND c.portal_user_id = auth.uid()
        AND c.portal_link_status = 'approved'
    )
  );

-- Admin can see all deals
DROP POLICY IF EXISTS "admins_see_all_applications" ON public.borrower_applications;
CREATE POLICY "admins_see_all_applications"
  ON public.borrower_applications FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- ─── 7. ENSURE crm_deal_contacts HAS UNIQUE PRIMARY CONSTRAINT ───────────────
-- Only one primary contact per deal

DO $$
BEGIN
  -- Add unique partial index: only one 'primary' role per deal
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'crm_deal_contacts'
      AND indexname = 'idx_crm_deal_contacts_one_primary'
  ) THEN
    CREATE UNIQUE INDEX idx_crm_deal_contacts_one_primary
      ON public.crm_deal_contacts(deal_id)
      WHERE role = 'primary';
  END IF;
END $$;

-- ─── 8. FUNCTION: associate_deal_with_contact ─────────────────────────────────
-- Used by API to safely set/change primary contact on a deal.
-- Demotes any existing primary before inserting new one.

CREATE OR REPLACE FUNCTION public.associate_deal_with_contact(
  p_deal_id UUID,
  p_contact_id UUID,
  p_role TEXT DEFAULT 'primary',
  p_admin_actor TEXT DEFAULT 'Admin'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  old_primary_id UUID;
  contact_name TEXT;
  deal_address TEXT;
BEGIN
  -- Get contact name for activity log
  SELECT (first_name || ' ' || last_name) INTO contact_name
  FROM public.crm_contacts WHERE id = p_contact_id;

  -- Get deal address for activity log
  SELECT property_address INTO deal_address
  FROM public.borrower_applications WHERE id = p_deal_id;

  IF p_role = 'primary' THEN
    -- Find existing primary
    SELECT contact_id INTO old_primary_id
    FROM public.crm_deal_contacts
    WHERE deal_id = p_deal_id AND role = 'primary'
    LIMIT 1;

    IF old_primary_id IS NOT NULL AND old_primary_id != p_contact_id THEN
      -- Demote old primary to 'additional'
      UPDATE public.crm_deal_contacts
      SET role = 'additional'
      WHERE deal_id = p_deal_id AND contact_id = old_primary_id AND role = 'primary';
    END IF;

    -- Update borrower_applications.primary_contact_id
    UPDATE public.borrower_applications
    SET primary_contact_id = p_contact_id
    WHERE id = p_deal_id;
  END IF;

  -- Upsert the association
  INSERT INTO public.crm_deal_contacts (deal_id, contact_id, role)
  VALUES (p_deal_id, p_contact_id, p_role)
  ON CONFLICT (deal_id, contact_id) DO UPDATE SET role = EXCLUDED.role;

  -- Log activity on contact
  INSERT INTO public.crm_activities (
    contact_id,
    deal_id,
    event_type,
    title,
    detail,
    actor
  ) VALUES (
    p_contact_id,
    p_deal_id::TEXT,
    'deal_associated',
    'Deal associated: ' || COALESCE(deal_address, 'Deal ' || p_deal_id),
    'Contact linked to deal as ' || p_role || '. Action by: ' || p_admin_actor,
    p_admin_actor
  );

  RETURN jsonb_build_object('success', true, 'deal_id', p_deal_id, 'contact_id', p_contact_id, 'role', p_role);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ─── 9. FUNCTION: remove_deal_contact ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.remove_deal_contact(
  p_deal_id UUID,
  p_contact_id UUID,
  p_admin_actor TEXT DEFAULT 'Admin'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  contact_name TEXT;
  deal_address TEXT;
  removed_role TEXT;
BEGIN
  SELECT role INTO removed_role
  FROM public.crm_deal_contacts
  WHERE deal_id = p_deal_id AND contact_id = p_contact_id;

  IF removed_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Association not found');
  END IF;

  DELETE FROM public.crm_deal_contacts
  WHERE deal_id = p_deal_id AND contact_id = p_contact_id;

  -- If we removed the primary, clear primary_contact_id on deal
  IF removed_role = 'primary' THEN
    UPDATE public.borrower_applications
    SET primary_contact_id = NULL
    WHERE id = p_deal_id AND primary_contact_id = p_contact_id;
  END IF;

  SELECT (first_name || ' ' || last_name) INTO contact_name
  FROM public.crm_contacts WHERE id = p_contact_id;

  SELECT property_address INTO deal_address
  FROM public.borrower_applications WHERE id = p_deal_id;

  INSERT INTO public.crm_activities (
    contact_id,
    deal_id,
    event_type,
    title,
    detail,
    actor
  ) VALUES (
    p_contact_id,
    p_deal_id::TEXT,
    'deal_removed',
    'Deal association removed: ' || COALESCE(deal_address, 'Deal ' || p_deal_id),
    'Contact removed from deal (was ' || removed_role || '). Action by: ' || p_admin_actor,
    p_admin_actor
  );

  RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ─── 10. INDEX: active deal contacts count ────────────────────────────────────
-- Support efficient "active deal contacts" dashboard metric

CREATE INDEX IF NOT EXISTS idx_ba_active_status
  ON public.borrower_applications(app_status)
  WHERE app_status IN ('approved', 'in_progress', 'funded');

CREATE INDEX IF NOT EXISTS idx_crm_deal_contacts_deal ON public.crm_deal_contacts(deal_id);

-- ─── 11. CLEANUP: expired idempotency keys ───────────────────────────────────
-- Simple cleanup function (call periodically or from cron)

CREATE OR REPLACE FUNCTION public.cleanup_expired_idempotency_keys()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.crm_submission_idempotency WHERE expires_at < now();
END;
$$;

DO $$
BEGIN
  RAISE NOTICE 'CRM Phase 3 migration completed successfully.';
END;
$$;