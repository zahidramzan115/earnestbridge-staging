-- ============================================================
-- CRM Core Schema
-- Extends EarnestBridge into a full CRM platform.
-- CONTACT ≠ USER — contacts are CRM relationships,
-- users are authenticated portal identities.
-- ============================================================

-- ─── ENUMS ───────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_lead_status') THEN
    CREATE TYPE public.crm_lead_status AS ENUM (
      'New Lead',
      'Contacted',
      'Qualified',
      'Deal Submitted',
      'Client',
      'Nurture',
      'Lost',
      'Not Qualified'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_portal_link_status') THEN
    CREATE TYPE public.crm_portal_link_status AS ENUM (
      'none',
      'pending',
      'approved',
      'rejected'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_task_status') THEN
    CREATE TYPE public.crm_task_status AS ENUM (
      'Open',
      'Completed',
      'Cancelled'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_task_priority') THEN
    CREATE TYPE public.crm_task_priority AS ENUM (
      'Low',
      'Normal',
      'High'
    );
  END IF;
END $$;

-- ─── COMPANIES ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_companies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name     TEXT NOT NULL,
  website          TEXT,
  phone            TEXT,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  country          TEXT DEFAULT 'US',
  company_type     TEXT,
  notes            TEXT,
  assigned_owner   TEXT DEFAULT 'Unassigned',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_companies_name ON public.crm_companies(company_name);
CREATE INDEX IF NOT EXISTS idx_crm_companies_owner ON public.crm_companies(assigned_owner);

ALTER TABLE public.crm_companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_companies" ON public.crm_companies;
CREATE POLICY "admins_all_crm_companies"
  ON public.crm_companies FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

DROP TRIGGER IF EXISTS crm_companies_updated_at ON public.crm_companies;
CREATE TRIGGER crm_companies_updated_at
  BEFORE UPDATE ON public.crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── CONTACTS ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_contacts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name              TEXT NOT NULL DEFAULT '',
  last_name               TEXT NOT NULL DEFAULT '',
  primary_email           TEXT NOT NULL,
  phone                   TEXT,
  company_id              UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
  job_title               TEXT,
  website                 TEXT,
  lead_status             public.crm_lead_status NOT NULL DEFAULT 'New Lead',
  assigned_owner          TEXT NOT NULL DEFAULT 'Unassigned',
  lead_source             TEXT,
  referral_source         TEXT,
  estimated_deal_volume   NUMERIC(15,2),
  estimated_emd_need      NUMERIC(15,2),
  client_type             TEXT,
  last_contacted_at       TIMESTAMPTZ,
  next_follow_up_at       TIMESTAMPTZ,
  notes                   TEXT,
  tags                    TEXT[] DEFAULT ARRAY[]::TEXT[],
  -- Portal linking
  portal_user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  portal_link_status      public.crm_portal_link_status NOT NULL DEFAULT 'none',
  portal_linked_at        TIMESTAMPTZ,
  portal_approved_at      TIMESTAMPTZ,
  portal_approved_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Attribution (first-touch preserved)
  original_lead_source    TEXT,
  original_campaign       TEXT,
  latest_lead_source      TEXT,
  latest_campaign         TEXT,
  -- Merge tracking
  merged_into_id          UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  is_merged               BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Normalize email: lowercase, trimmed
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email_unique
  ON public.crm_contacts(lower(trim(primary_email)))
  WHERE is_merged = false;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_company ON public.crm_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON public.crm_contacts(lead_status);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_owner ON public.crm_contacts(assigned_owner);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_portal_user ON public.crm_contacts(portal_user_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_portal_status ON public.crm_contacts(portal_link_status);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_follow_up ON public.crm_contacts(next_follow_up_at);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_created ON public.crm_contacts(created_at DESC);

ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_contacts" ON public.crm_contacts;
CREATE POLICY "admins_all_crm_contacts"
  ON public.crm_contacts FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- Portal users can read their own linked contact
DROP POLICY IF EXISTS "portal_users_read_own_contact" ON public.crm_contacts;
CREATE POLICY "portal_users_read_own_contact"
  ON public.crm_contacts FOR SELECT TO authenticated
  USING (portal_user_id = auth.uid() AND portal_link_status = 'approved');

DROP TRIGGER IF EXISTS crm_contacts_updated_at ON public.crm_contacts;
CREATE TRIGGER crm_contacts_updated_at
  BEFORE UPDATE ON public.crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── CONTACT ALTERNATE EMAILS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_contact_emails (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   UUID NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  label        TEXT DEFAULT 'alternate',
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contact_emails_unique
  ON public.crm_contact_emails(lower(trim(email)));

CREATE INDEX IF NOT EXISTS idx_crm_contact_emails_contact ON public.crm_contact_emails(contact_id);

ALTER TABLE public.crm_contact_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_contact_emails" ON public.crm_contact_emails;
CREATE POLICY "admins_all_crm_contact_emails"
  ON public.crm_contact_emails FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- ─── CONTACT FORM SUBMISSIONS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_contact_submissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  -- Submission data
  first_name       TEXT,
  last_name        TEXT,
  email            TEXT NOT NULL,
  phone            TEXT,
  company_name     TEXT,
  message          TEXT,
  inquiry_type     TEXT,
  -- Deal-related fields from form
  property_address TEXT,
  property_type    TEXT,
  purchase_price   NUMERIC(15,2),
  deposit_amount   NUMERIC(15,2),
  closing_date     DATE,
  -- Attribution
  lead_source      TEXT DEFAULT 'Website Contact Form',
  landing_page     TEXT,
  referrer         TEXT,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  utm_content      TEXT,
  utm_term         TEXT,
  promo_code       TEXT,
  -- Meta
  is_new_contact   BOOLEAN NOT NULL DEFAULT true,
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_submissions_contact ON public.crm_contact_submissions(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_submissions_email ON public.crm_contact_submissions(lower(email));
CREATE INDEX IF NOT EXISTS idx_crm_submissions_submitted ON public.crm_contact_submissions(submitted_at DESC);

ALTER TABLE public.crm_contact_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_submissions" ON public.crm_contact_submissions;
CREATE POLICY "admins_all_crm_submissions"
  ON public.crm_contact_submissions FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- Public insert for contact form (no auth required)
DROP POLICY IF EXISTS "public_insert_crm_submissions" ON public.crm_contact_submissions;
CREATE POLICY "public_insert_crm_submissions"
  ON public.crm_contact_submissions FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- ─── CONTACT ACTIVITIES (CRM Timeline) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_activities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    UUID REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  company_id    UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
  deal_id       TEXT,
  event_type    TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  actor         TEXT NOT NULL DEFAULT 'System',
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON public.crm_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_company ON public.crm_activities(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_created ON public.crm_activities(created_at DESC);

ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_activities" ON public.crm_activities;
CREATE POLICY "admins_all_crm_activities"
  ON public.crm_activities FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- ─── CRM TASKS ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT,
  contact_id    UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  company_id    UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
  deal_id       TEXT,
  assigned_to   TEXT NOT NULL DEFAULT 'Unassigned',
  due_date      DATE,
  due_time      TIME,
  priority      public.crm_task_priority NOT NULL DEFAULT 'Normal',
  task_status   public.crm_task_status NOT NULL DEFAULT 'Open',
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_contact ON public.crm_tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_assigned ON public.crm_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_due ON public.crm_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_status ON public.crm_tasks(task_status);

ALTER TABLE public.crm_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_tasks" ON public.crm_tasks;
CREATE POLICY "admins_all_crm_tasks"
  ON public.crm_tasks FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

DROP TRIGGER IF EXISTS crm_tasks_updated_at ON public.crm_tasks;
CREATE TRIGGER crm_tasks_updated_at
  BEFORE UPDATE ON public.crm_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── DEAL ↔ CONTACT ASSOCIATIONS ─────────────────────────────────────────────
-- Links CRM contacts to deals (borrower_applications).
-- This is the explicit relationship that drives portal visibility.

CREATE TABLE IF NOT EXISTS public.crm_deal_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       UUID NOT NULL REFERENCES public.borrower_applications(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'primary',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_deal_contacts_unique
  ON public.crm_deal_contacts(deal_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_crm_deal_contacts_deal ON public.crm_deal_contacts(deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_deal_contacts_contact ON public.crm_deal_contacts(contact_id);

ALTER TABLE public.crm_deal_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_deal_contacts" ON public.crm_deal_contacts;
CREATE POLICY "admins_all_crm_deal_contacts"
  ON public.crm_deal_contacts FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- Portal users can see deal associations for their approved contact
DROP POLICY IF EXISTS "portal_users_read_own_deal_contacts" ON public.crm_deal_contacts;
CREATE POLICY "portal_users_read_own_deal_contacts"
  ON public.crm_deal_contacts FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.crm_contacts cc
      WHERE cc.id = contact_id
        AND cc.portal_user_id = auth.uid()
        AND cc.portal_link_status = 'approved'
    )
  );

-- ─── ADD CRM COLUMNS TO borrower_applications ────────────────────────────────
-- Extend existing deals table to support CRM relationships

ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS primary_contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS crm_company_id UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eb_assigned_owner TEXT DEFAULT 'Unassigned';

CREATE INDEX IF NOT EXISTS idx_borrower_apps_primary_contact
  ON public.borrower_applications(primary_contact_id);

CREATE INDEX IF NOT EXISTS idx_borrower_apps_crm_company
  ON public.borrower_applications(crm_company_id);

-- ─── IN-APP NOTIFICATIONS for CRM ────────────────────────────────────────────
-- Reuse existing notifications table pattern; add crm_contact_id column

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS crm_contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL;
