-- Document source of truth fields and the three generated deal documents.
--
-- Adds the missing values used to fill the MOU, Option Agreement, and Affidavit.
-- Existing deal columns are reused and are not created again:
--   property_address, deposit_amount, llc_name, first_name, last_name, email, phone.
--
-- deal_documents stores the current file for each document. Replacing a file
-- deletes the previous object and increases version_number. Old files are not kept.
--
-- Run this in the Supabase SQL editor on main / production while the app
-- points at that project. The statements are safe to run once.

-- ─── 1. Source-of-truth fields on the deal ───────────────────────────────────

ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS client_legal_name          TEXT,
  ADD COLUMN IF NOT EXISTS escrow_agent               TEXT,
  ADD COLUMN IF NOT EXISTS admin_fee                  NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS deal_fee                   NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS option_term                TEXT,
  ADD COLUMN IF NOT EXISTS client_notice_address      TEXT,
  ADD COLUMN IF NOT EXISTS client_representative_name TEXT,
  ADD COLUMN IF NOT EXISTS client_notice_email        TEXT,
  ADD COLUMN IF NOT EXISTS client_signatory_name      TEXT,
  ADD COLUMN IF NOT EXISTS client_signatory_title     TEXT,
  ADD COLUMN IF NOT EXISTS psa_title                  TEXT,
  ADD COLUMN IF NOT EXISTS mou_effective_date         DATE,
  ADD COLUMN IF NOT EXISTS option_effective_date      DATE;

COMMENT ON COLUMN public.borrower_applications.client_legal_name IS
  'Full legal name of the client entity, including jurisdiction and entity type.';
COMMENT ON COLUMN public.borrower_applications.escrow_agent IS
  'Escrow agent as one line: company, email, and contact person.';
COMMENT ON COLUMN public.borrower_applications.option_term IS
  'Purchased option term printed in the MOU and Option Agreement.';

-- ─── 2. Keep these fields Admin-only ─────────────────────────────────────────
-- Extends the existing guard. A borrower still cannot change Admin fields.
-- service_role and is_admin_user() can change them.

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
  v_any_protected :=
       NEW.eb_assigned_owner             IS DISTINCT FROM OLD.eb_assigned_owner
    OR NEW.app_status                    IS DISTINCT FROM OLD.app_status
    OR NEW.admin_notes                   IS DISTINCT FROM OLD.admin_notes
    OR NEW.admin_created                 IS DISTINCT FROM OLD.admin_created
    OR NEW.deal_workflow_stage           IS DISTINCT FROM OLD.deal_workflow_stage
    OR NEW.primary_contact_id            IS DISTINCT FROM OLD.primary_contact_id
    OR NEW.crm_company_id                IS DISTINCT FROM OLD.crm_company_id
    OR NEW.w9_signed                     IS DISTINCT FROM OLD.w9_signed
    OR NEW.mou_signed                    IS DISTINCT FROM OLD.mou_signed
    OR NEW.option_agreement_signed       IS DISTINCT FROM OLD.option_agreement_signed
    OR NEW.psa_signed                    IS DISTINCT FROM OLD.psa_signed
    OR NEW.llc_formed                    IS DISTINCT FROM OLD.llc_formed
    OR NEW.escrow_funded                 IS DISTINCT FROM OLD.escrow_funded
    OR NEW.option_exercised              IS DISTINCT FROM OLD.option_exercised
    OR NEW.funded_date                   IS DISTINCT FROM OLD.funded_date
    OR NEW.emd_funded_cents              IS DISTINCT FROM OLD.emd_funded_cents
    OR NEW.credit_card_payment_enabled   IS DISTINCT FROM OLD.credit_card_payment_enabled
    OR NEW.client_legal_name             IS DISTINCT FROM OLD.client_legal_name
    OR NEW.escrow_agent                  IS DISTINCT FROM OLD.escrow_agent
    OR NEW.admin_fee                     IS DISTINCT FROM OLD.admin_fee
    OR NEW.deal_fee                      IS DISTINCT FROM OLD.deal_fee
    OR NEW.option_term                   IS DISTINCT FROM OLD.option_term
    OR NEW.client_notice_address         IS DISTINCT FROM OLD.client_notice_address
    OR NEW.client_representative_name    IS DISTINCT FROM OLD.client_representative_name
    OR NEW.client_notice_email           IS DISTINCT FROM OLD.client_notice_email
    OR NEW.client_signatory_name         IS DISTINCT FROM OLD.client_signatory_name
    OR NEW.client_signatory_title        IS DISTINCT FROM OLD.client_signatory_title
    OR NEW.psa_title                     IS DISTINCT FROM OLD.psa_title
    OR NEW.mou_effective_date            IS DISTINCT FROM OLD.mou_effective_date
    OR NEW.option_effective_date         IS DISTINCT FROM OLD.option_effective_date;

  IF NOT v_any_protected THEN
    RETURN NEW;
  END IF;

  v_role := current_setting('role', true);

  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF public.is_admin_user() THEN
    RETURN NEW;
  END IF;

  IF
    NEW.app_status                    IS DISTINCT FROM OLD.app_status
    AND NEW.eb_assigned_owner             IS NOT DISTINCT FROM OLD.eb_assigned_owner
    AND NEW.admin_notes                   IS NOT DISTINCT FROM OLD.admin_notes
    AND NEW.admin_created                 IS NOT DISTINCT FROM OLD.admin_created
    AND NEW.deal_workflow_stage           IS NOT DISTINCT FROM OLD.deal_workflow_stage
    AND NEW.primary_contact_id            IS NOT DISTINCT FROM OLD.primary_contact_id
    AND NEW.crm_company_id                IS NOT DISTINCT FROM OLD.crm_company_id
    AND NEW.w9_signed                     IS NOT DISTINCT FROM OLD.w9_signed
    AND NEW.mou_signed                    IS NOT DISTINCT FROM OLD.mou_signed
    AND NEW.option_agreement_signed       IS NOT DISTINCT FROM OLD.option_agreement_signed
    AND NEW.psa_signed                    IS NOT DISTINCT FROM OLD.psa_signed
    AND NEW.llc_formed                    IS NOT DISTINCT FROM OLD.llc_formed
    AND NEW.escrow_funded                 IS NOT DISTINCT FROM OLD.escrow_funded
    AND NEW.option_exercised              IS NOT DISTINCT FROM OLD.option_exercised
    AND NEW.funded_date                   IS NOT DISTINCT FROM OLD.funded_date
    AND NEW.emd_funded_cents              IS NOT DISTINCT FROM OLD.emd_funded_cents
    AND NEW.credit_card_payment_enabled   IS NOT DISTINCT FROM OLD.credit_card_payment_enabled
    AND NEW.client_legal_name             IS NOT DISTINCT FROM OLD.client_legal_name
    AND NEW.escrow_agent                  IS NOT DISTINCT FROM OLD.escrow_agent
    AND NEW.admin_fee                     IS NOT DISTINCT FROM OLD.admin_fee
    AND NEW.deal_fee                      IS NOT DISTINCT FROM OLD.deal_fee
    AND NEW.option_term                   IS NOT DISTINCT FROM OLD.option_term
    AND NEW.client_notice_address         IS NOT DISTINCT FROM OLD.client_notice_address
    AND NEW.client_representative_name    IS NOT DISTINCT FROM OLD.client_representative_name
    AND NEW.client_notice_email           IS NOT DISTINCT FROM OLD.client_notice_email
    AND NEW.client_signatory_name         IS NOT DISTINCT FROM OLD.client_signatory_name
    AND NEW.client_signatory_title        IS NOT DISTINCT FROM OLD.client_signatory_title
    AND NEW.psa_title                     IS NOT DISTINCT FROM OLD.psa_title
    AND NEW.mou_effective_date            IS NOT DISTINCT FROM OLD.mou_effective_date
    AND NEW.option_effective_date         IS NOT DISTINCT FROM OLD.option_effective_date
    AND NEW.app_status::TEXT = 'submitted'
    AND OLD.app_status::TEXT IN ('draft', 'application')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Permission denied: one or more Admin-controlled fields on borrower_applications '
    'may only be changed by an EarnestBridge Admin or trusted server process.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

-- ─── 3. Current generated document for each deal ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.deal_documents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        UUID NOT NULL REFERENCES public.borrower_applications(id) ON DELETE CASCADE,
  document_type         TEXT NOT NULL CHECK (document_type IN ('mou', 'option_agreement', 'affidavit')),
  status                TEXT NOT NULL DEFAULT 'pending_review'
                        CHECK (status IN (
                          'pending_review',
                          'approved',
                          'sent_to_client',
                          'client_approved',
                          'sent_for_signature',
                          'signed'
                        )),
  version_number        INTEGER NOT NULL DEFAULT 1,
  storage_path          TEXT,
  file_name             TEXT,
  approved_by           UUID REFERENCES auth.users(id),
  approved_at           TIMESTAMPTZ,
  sent_to_email         TEXT,
  sent_at               TIMESTAMPTZ,
  client_approved_by    UUID REFERENCES auth.users(id),
  client_approved_at    TIMESTAMPTZ,
  docusign_envelope_id  TEXT,
  signed_file_path      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_deal_documents_application_id
  ON public.deal_documents(application_id);

DROP TRIGGER IF EXISTS deal_documents_updated_at ON public.deal_documents;
CREATE TRIGGER deal_documents_updated_at
  BEFORE UPDATE ON public.deal_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.deal_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_deal_documents" ON public.deal_documents;
CREATE POLICY "admins_all_deal_documents"
  ON public.deal_documents
  FOR ALL
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.deal_documents TO authenticated, service_role;
