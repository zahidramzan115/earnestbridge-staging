-- Adds Operating Agreement and Written Consent to deal_documents,
-- plus the LLC fields used to fill the Operating Agreement.

ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS llc_formation_date DATE,
  ADD COLUMN IF NOT EXISTS llc_act            TEXT,
  ADD COLUMN IF NOT EXISTS registered_agent   TEXT;

ALTER TABLE public.deal_documents
  DROP CONSTRAINT IF EXISTS deal_documents_document_type_check;

ALTER TABLE public.deal_documents
  ADD CONSTRAINT deal_documents_document_type_check
  CHECK (document_type IN (
    'mou',
    'option_agreement',
    'affidavit',
    'operating_agreement',
    'written_consent'
  ));

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
    OR NEW.option_effective_date         IS DISTINCT FROM OLD.option_effective_date
    OR NEW.llc_formation_date            IS DISTINCT FROM OLD.llc_formation_date
    OR NEW.llc_act                       IS DISTINCT FROM OLD.llc_act
    OR NEW.registered_agent              IS DISTINCT FROM OLD.registered_agent;

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
    AND NEW.llc_formation_date            IS NOT DISTINCT FROM OLD.llc_formation_date
    AND NEW.llc_act                       IS NOT DISTINCT FROM OLD.llc_act
    AND NEW.registered_agent              IS NOT DISTINCT FROM OLD.registered_agent
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
