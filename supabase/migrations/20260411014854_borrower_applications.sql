-- Migration: borrower_applications
-- Covers Steps 1.2–1.7 of the EarnestBridge user flow

-- ─── ENUMS ───────────────────────────────────────────────────────────────────
DROP TYPE IF EXISTS public.application_status CASCADE;
CREATE TYPE public.application_status AS ENUM (
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected'
);

DROP TYPE IF EXISTS public.identity_verification_method CASCADE;
CREATE TYPE public.identity_verification_method AS ENUM (
  'questions',
  'text_code',
  'id_selfie'
);

-- ─── CORE TABLE ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.borrower_applications (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Step 1.2 – Contact Info
  first_name              TEXT NOT NULL DEFAULT '',
  last_name               TEXT NOT NULL DEFAULT '',
  email                   TEXT NOT NULL DEFAULT '',
  phone                   TEXT NOT NULL DEFAULT '',
  agreed_to_terms         BOOLEAN NOT NULL DEFAULT false,

  -- Step 1.3 – Deposit / Company / Property
  deposit_amount          NUMERIC(15,2),
  company_name            TEXT,
  company_type            TEXT,
  property_address        TEXT,
  property_type           TEXT,
  purchase_price          NUMERIC(15,2),
  closing_date            DATE,

  -- Step 1.4 – PSA Upload
  psa_file_url            TEXT,
  psa_file_name           TEXT,

  -- Step 1.5 – Transaction / LLC / Attorney
  transaction_description TEXT,
  llc_name                TEXT,
  llc_state               TEXT,
  llc_ein                 TEXT,
  attorney_name           TEXT,
  attorney_email          TEXT,
  attorney_phone          TEXT,
  attorney_firm           TEXT,

  -- Step 1.6 – Identity Verification
  identity_method         public.identity_verification_method,
  identity_verified       BOOLEAN NOT NULL DEFAULT false,

  -- Step 1.7 – Submission
  app_status              public.application_status NOT NULL DEFAULT 'draft',
  submitted_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_borrower_applications_user_id
  ON public.borrower_applications(user_id);

CREATE INDEX IF NOT EXISTS idx_borrower_applications_status
  ON public.borrower_applications(app_status);

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS borrower_applications_updated_at ON public.borrower_applications;
CREATE TRIGGER borrower_applications_updated_at
  BEFORE UPDATE ON public.borrower_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.borrower_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_manage_own_borrower_applications" ON public.borrower_applications;
CREATE POLICY "users_manage_own_borrower_applications"
  ON public.borrower_applications
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
