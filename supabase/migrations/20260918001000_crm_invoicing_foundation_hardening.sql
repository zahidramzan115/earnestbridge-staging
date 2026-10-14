-- ============================================================
-- Migration: 20260918001000_crm_invoicing_foundation_hardening
--
-- Step 6A-2c — Additive Production Invoicing Hardening
--
-- PURPOSE
-- -------
-- Additive hardening pass on the already-deployed
-- 20260918000000_crm_invoicing_foundation migration.
--
-- The original migration (20260918000000) is NOT modified.
-- This migration is purely additive and safe to apply to the
-- live schema with zero business rows in all invoice tables.
--
-- PRE-CONDITION VERIFIED
-- ----------------------
-- crm_invoices            = 0 rows
-- crm_invoice_line_items  = 0 rows
-- crm_payments            = 0 rows
-- crm_invoice_settings    = 0 rows
-- invoice-pdfs objects    = 0 objects
--
-- CHANGES IN THIS MIGRATION
-- -------------------------
-- 1.  Remove portal_clients_read_own_invoices policy from crm_invoices
-- 2.  Remove portal_clients_read_own_invoice_line_items policy from crm_invoice_line_items
--     → crm_invoices and crm_invoice_line_items are Admin/server only for this phase.
--       Future client access will use a secure server API or carefully limited view.
-- 3.  Remove admins_all_invoice_pdfs storage policy from storage.objects
--     → invoice-pdfs remains private with NO authenticated direct access.
--       Future PDF access via server-side signed URLs only.
-- 4.  Replace protect_issued_invoice_line_items() to fix the UPDATE reparenting loophole.
--     INSERT: validates NEW parent exists and is 'draft'.
--     DELETE: validates OLD parent exists and is 'draft'.
--     UPDATE: validates BOTH OLD and NEW parents exist and are 'draft'.
--             Rejects if either parent is non-draft.
--             Fails closed if either parent cannot be found.
--             NULL parent status is NOT treated as safe.
-- 5.  Replace protect_issued_invoice_fields() to add due_date to the
--     immutable snapshot comparison. due_date is editable while draft;
--     immutable once OLD.status != 'draft'.
-- 6.  Rename crm_invoices.notes → invoice_notes (safe: 0 invoice rows).
--     Add crm_invoices.internal_notes TEXT NULL (Admin-only CRM notes).
--     Update protect_issued_invoice_fields() so invoice_notes is immutable
--     after draft; internal_notes remains editable.
-- 7.  Replace admins_all_crm_invoice_settings with three separate policies:
--     admins_select_crm_invoice_settings (SELECT)
--     admins_insert_crm_invoice_settings (INSERT)
--     admins_update_crm_invoice_settings (UPDATE)
--     No DELETE policy. crm_invoice_settings is a singleton; update, not delete.
-- 8.  Add CHECK constraint on borrower_applications.emd_funded_cents:
--     emd_funded_cents IS NULL OR emd_funded_cents > 0
-- 9.  Add CHECK constraints on crm_invoice_line_items for arithmetic consistency:
--     line_amount_cents = quantity::BIGINT * unit_amount_cents
--     For discount lines: unit_amount_cents <= 0 AND line_amount_cents <= 0
--     For non-discount lines: unit_amount_cents >= 0 AND line_amount_cents >= 0
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - create invoices, payments, or activities
--   - alter Deal or Option Cycle statuses
--   - populate funded_date or emd_funded_cents
--   - enable credit card on any Deal
--   - send emails or generate PDFs
--   - seed bank account / routing numbers
--   - delete any business rows
--   - reset the invoice number sequence
--   - recreate invoice or payment tables
--
-- ORIGINAL MIGRATION
-- ------------------
-- 20260918000000_crm_invoicing_foundation.sql is NOT modified.
-- ============================================================


-- ============================================================
-- SECTION 1: REMOVE PORTAL SELECT POLICIES FROM BASE INVOICE TABLES
--
-- Reason: RLS limits rows, not columns.
-- crm_invoices contains internal fields that should not be
-- directly browser-queryable:
--   wire_instructions_snapshot, pdf_storage_path, pdf_hash,
--   pdf_generation_status, pdf_generation_error, created_by,
--   voided_by, internal_notes, and workflow metadata.
-- It can also contain draft/issuing invoices that should never
-- appear in the Client portal.
--
-- Future client invoice access will use:
--   - secure server API, OR
--   - carefully limited client-facing view
-- with explicit crm_deal_contacts authorization, safe column
-- selection, appropriate invoice status filtering, and
-- server-generated signed PDF URLs.
--
-- Company membership alone still grants nothing.
-- ============================================================

-- Remove portal client SELECT policy from crm_invoices
DROP POLICY IF EXISTS "portal_clients_read_own_invoices"
  ON public.crm_invoices;

-- Remove portal client SELECT policy from crm_invoice_line_items
DROP POLICY IF EXISTS "portal_clients_read_own_invoice_line_items"
  ON public.crm_invoice_line_items;

-- Confirm: crm_invoices = Admin/server only for this phase
-- Confirm: crm_invoice_line_items = Admin/server only for this phase
-- Confirm: crm_payments = Admin/server only (no portal policy was created)
-- Confirm: crm_invoice_settings = Admin/server only (no portal policy was created)


-- ============================================================
-- SECTION 2: REMOVE AUTHENTICATED ADMIN STORAGE POLICY
--
-- The deployed migration created admins_all_invoice_pdfs on
-- storage.objects FOR ALL. This is removed.
--
-- invoice-pdfs remains:
--   private (public = false)
--   application/pdf only
--   NO anonymous direct access
--   NO portal client direct access
--   NO authenticated Admin direct INSERT
--   NO authenticated Admin direct UPDATE
--   NO authenticated Admin direct DELETE
--   NO authenticated Admin direct SELECT
--
-- Future PDF generation will occur server-side using trusted
-- credentials (service_role / Edge Function).
-- Future Admin/client PDF access will occur through:
--   secure server authorization
--   → explicit permission check
--   → short-lived signed URL
--
-- Issued invoice PDFs are immutable financial documents.
-- ============================================================

DROP POLICY IF EXISTS "admins_all_invoice_pdfs"
  ON storage.objects;

-- No replacement storage policy is created in this migration.
-- The invoice-pdfs bucket remains private with no RLS policies.
-- All PDF access must go through server-side signed URL generation.


-- ============================================================
-- SECTION 3: FIX LINE ITEM REPARENTING LOOPHOLE
--
-- The deployed protect_issued_invoice_line_items() uses:
--   COALESCE(NEW.invoice_id, OLD.invoice_id)
-- This is insufficient for UPDATE operations because it does not
-- validate BOTH the old and new parent invoice statuses.
--
-- A line item from an issued invoice could be moved to a draft
-- invoice (reparenting), or a draft line item could be moved
-- into an issued invoice.
--
-- This replacement enforces:
--
-- INSERT:
--   - resolve NEW.invoice_id
--   - parent must exist (fail closed if not found)
--   - parent status must equal 'draft'
--   - NULL parent status is NOT treated as safe
--
-- DELETE:
--   - resolve OLD.invoice_id
--   - parent must exist (fail closed if not found)
--   - parent status must equal 'draft'
--
-- UPDATE:
--   - resolve OLD.invoice_id → OLD parent must exist and be 'draft'
--   - resolve NEW.invoice_id → NEW parent must exist and be 'draft'
--   - if either parent is non-draft: REJECT
--   - if either expected parent cannot be found: FAIL CLOSED
--
-- This applies to everyone including Admin and service_role.
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_issued_invoice_line_items()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_old_invoice_status TEXT;
  v_new_invoice_status TEXT;
BEGIN

  -- ── INSERT ────────────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN

    -- Fetch the NEW parent invoice status
    SELECT status INTO v_new_invoice_status
    FROM public.crm_invoices
    WHERE id = NEW.invoice_id;

    -- Fail closed: parent invoice must exist
    IF v_new_invoice_status IS NULL THEN
      RAISE EXCEPTION
        'protect_issued_invoice_line_items (INSERT): parent invoice % does not exist. '
        'Cannot insert a line item for a non-existent invoice.',
        NEW.invoice_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Parent must be in draft status
    IF v_new_invoice_status != 'draft' THEN
      RAISE EXCEPTION
        'protect_issued_invoice_line_items (INSERT): parent invoice % has status ''%''. '
        'Line items may only be inserted into a draft invoice. '
        'Use Void + Replacement Invoice to correct an issued invoice.',
        NEW.invoice_id, v_new_invoice_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
  END IF;

  -- ── DELETE ────────────────────────────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN

    -- Fetch the OLD parent invoice status
    SELECT status INTO v_old_invoice_status
    FROM public.crm_invoices
    WHERE id = OLD.invoice_id;

    -- Fail closed: parent invoice must exist
    IF v_old_invoice_status IS NULL THEN
      RAISE EXCEPTION
        'protect_issued_invoice_line_items (DELETE): parent invoice % does not exist. '
        'Cannot delete a line item for a non-existent invoice.',
        OLD.invoice_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Parent must be in draft status
    IF v_old_invoice_status != 'draft' THEN
      RAISE EXCEPTION
        'protect_issued_invoice_line_items (DELETE): parent invoice % has status ''%''. '
        'Line items may only be deleted from a draft invoice. '
        'Use Void + Replacement Invoice to correct an issued invoice.',
        OLD.invoice_id, v_old_invoice_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN OLD;
  END IF;

  -- ── UPDATE ────────────────────────────────────────────────────────────────
  IF TG_OP = 'UPDATE' THEN

    -- Fetch OLD parent invoice status
    SELECT status INTO v_old_invoice_status
    FROM public.crm_invoices
    WHERE id = OLD.invoice_id;

    -- Fail closed: OLD parent must exist
    IF v_old_invoice_status IS NULL THEN
      RAISE EXCEPTION
        'protect_issued_invoice_line_items (UPDATE): OLD parent invoice % does not exist. '
        'Cannot update a line item whose original parent invoice cannot be found.',
        OLD.invoice_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- OLD parent must be draft
    IF v_old_invoice_status != 'draft' THEN
      RAISE EXCEPTION
        'protect_issued_invoice_line_items (UPDATE): OLD parent invoice % has status ''%''. '
        'A line item from a non-draft invoice cannot be updated or reparented. '
        'Use Void + Replacement Invoice to correct an issued invoice.',
        OLD.invoice_id, v_old_invoice_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- If invoice_id is changing (reparenting), also validate the NEW parent
    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN

      -- Fetch NEW parent invoice status
      SELECT status INTO v_new_invoice_status
      FROM public.crm_invoices
      WHERE id = NEW.invoice_id;

      -- Fail closed: NEW parent must exist
      IF v_new_invoice_status IS NULL THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE reparent): NEW parent invoice % does not exist. '
          'Cannot reparent a line item to a non-existent invoice.',
          NEW.invoice_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;

      -- NEW parent must also be draft
      IF v_new_invoice_status != 'draft' THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE reparent): NEW parent invoice % has status ''%''. '
          'A line item cannot be moved into a non-draft invoice. '
          'Use Void + Replacement Invoice to correct an issued invoice.',
          NEW.invoice_id, v_new_invoice_status
          USING ERRCODE = 'insufficient_privilege';
      END IF;

    END IF;

    RETURN NEW;
  END IF;

  -- Fallback (should never reach here)
  RETURN COALESCE(NEW, OLD);

END;
$func$;

-- Re-attach trigger (DROP + CREATE is idempotent)
DROP TRIGGER IF EXISTS guard_issued_invoice_line_items ON public.crm_invoice_line_items;
CREATE TRIGGER guard_issued_invoice_line_items
  BEFORE INSERT OR UPDATE OR DELETE ON public.crm_invoice_line_items
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_issued_invoice_line_items();


-- ============================================================
-- SECTION 4: ADD due_date TO ISSUED INVOICE SNAPSHOT IMMUTABILITY
--
-- The deployed protect_issued_invoice_fields() does NOT protect
-- due_date. This replacement adds due_date to the immutable
-- snapshot comparison.
--
-- Behavior:
--   While OLD.status = 'draft': Admin/server may edit due_date freely.
--   During draft → issuing: future Issue Invoice logic may preserve
--     the Admin-selected due_date OR set due_date = issuance date
--     for Due Upon Receipt.
--   Once OLD.status != 'draft': due_date is immutable.
--   Correction after issue: Void + Replacement Invoice.
--
-- Also adds invoice_notes to the immutable snapshot (see Section 5).
-- internal_notes is NOT protected (remains editable after issuance).
-- ============================================================

-- NOTE: The full function replacement is in Section 5 below,
-- which handles both due_date and invoice_notes together.
-- This section documents the intent; Section 5 is the implementation.


-- ============================================================
-- SECTION 5: RENAME notes → invoice_notes, ADD internal_notes
--
-- The deployed table has crm_invoices.notes TEXT NULL.
-- This migration renames it to invoice_notes and adds internal_notes.
--
-- Definitions:
--   invoice_notes:
--     Client-facing invoice notes.
--     May eventually appear on invoice/PDF.
--     IMMUTABLE after invoice leaves draft.
--
--   internal_notes:
--     Admin-only CRM notes.
--     Never appear on client invoice/PDF.
--     May remain editable after issuance.
--     Must NOT be exposed through any future client policy.
--
-- Safe to rename because crm_invoices has 0 rows (verified above).
-- ============================================================

-- Rename notes → invoice_notes
ALTER TABLE public.crm_invoices
  RENAME COLUMN notes TO invoice_notes;

-- Add internal_notes (Admin-only CRM notes; never client-facing)
ALTER TABLE public.crm_invoices
  ADD COLUMN IF NOT EXISTS internal_notes TEXT NULL;

-- ── Replace protect_issued_invoice_fields() ──────────────────────────────
-- This replacement adds BOTH due_date AND invoice_notes to the immutable
-- snapshot comparison. internal_notes is intentionally NOT protected.
--
-- Protected immutable fields (once OLD.status != 'draft'):
--   application_id, company_id, contact_id, option_cycle_id,
--   invoice_type, currency,
--   billing_name, billing_contact_name, billing_email,
--   billing_address_line1/2, billing_city, billing_state,
--   billing_postal_code, billing_country,
--   emd_funded_cents, funding_date, period_start_date,
--   period_end_date, billable_days,
--   subtotal_cents, discount_cents, tax_cents, total_cents,
--   credit_card_payment_enabled_snapshot, wire_instructions_snapshot,
--   invoice_number,
--   due_date,          ← NEW in this hardening migration
--   invoice_notes      ← NEW in this hardening migration (renamed from notes)
--
-- Workflow fields that remain mutable through trusted server paths:
--   status, issued_at, issuing_started_at, paid_at,
--   voided_at, voided_by, void_reason,
--   pdf_storage_path, pdf_generated_at, pdf_hash,
--   pdf_generation_status, pdf_generation_error,
--   internal_notes,    ← Admin-only CRM notes; always editable
--   updated_at

CREATE OR REPLACE FUNCTION public.protect_issued_invoice_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_any_immutable BOOLEAN;
BEGIN
  -- ── ONLY enforce once the invoice has left draft status ───────────────────
  -- While OLD.status = 'draft', ALL fields are freely editable.
  -- This includes the draft → issuing transition, which is the intended
  -- window for the issuance action to finalize all snapshot fields,
  -- assign the invoice number, snapshot wire instructions / CC availability,
  -- set due_date, and finalize invoice_notes.
  -- No bypass is needed for service_role or Admin — the OLD.status guard
  -- is sufficient and correct.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- ── Check whether any immutable snapshot field changed ────────────────────
  v_any_immutable :=
       NEW.application_id                       IS DISTINCT FROM OLD.application_id
    OR NEW.company_id                           IS DISTINCT FROM OLD.company_id
    OR NEW.contact_id                           IS DISTINCT FROM OLD.contact_id
    OR NEW.option_cycle_id                      IS DISTINCT FROM OLD.option_cycle_id
    OR NEW.invoice_type                         IS DISTINCT FROM OLD.invoice_type
    OR NEW.currency                             IS DISTINCT FROM OLD.currency
    OR NEW.billing_name                         IS DISTINCT FROM OLD.billing_name
    OR NEW.billing_contact_name                 IS DISTINCT FROM OLD.billing_contact_name
    OR NEW.billing_email                        IS DISTINCT FROM OLD.billing_email
    OR NEW.billing_address_line1                IS DISTINCT FROM OLD.billing_address_line1
    OR NEW.billing_address_line2                IS DISTINCT FROM OLD.billing_address_line2
    OR NEW.billing_city                         IS DISTINCT FROM OLD.billing_city
    OR NEW.billing_state                        IS DISTINCT FROM OLD.billing_state
    OR NEW.billing_postal_code                  IS DISTINCT FROM OLD.billing_postal_code
    OR NEW.billing_country                      IS DISTINCT FROM OLD.billing_country
    OR NEW.emd_funded_cents                     IS DISTINCT FROM OLD.emd_funded_cents
    OR NEW.funding_date                         IS DISTINCT FROM OLD.funding_date
    OR NEW.period_start_date                    IS DISTINCT FROM OLD.period_start_date
    OR NEW.period_end_date                      IS DISTINCT FROM OLD.period_end_date
    OR NEW.billable_days                        IS DISTINCT FROM OLD.billable_days
    OR NEW.subtotal_cents                       IS DISTINCT FROM OLD.subtotal_cents
    OR NEW.discount_cents                       IS DISTINCT FROM OLD.discount_cents
    OR NEW.tax_cents                            IS DISTINCT FROM OLD.tax_cents
    OR NEW.total_cents                          IS DISTINCT FROM OLD.total_cents
    OR NEW.credit_card_payment_enabled_snapshot IS DISTINCT FROM OLD.credit_card_payment_enabled_snapshot
    OR NEW.wire_instructions_snapshot           IS DISTINCT FROM OLD.wire_instructions_snapshot
    OR NEW.invoice_number                       IS DISTINCT FROM OLD.invoice_number
    -- Added in hardening migration 20260918001000:
    OR NEW.due_date                             IS DISTINCT FROM OLD.due_date
    OR NEW.invoice_notes                        IS DISTINCT FROM OLD.invoice_notes;

  -- No immutable field changed → allow (workflow fields like status, pdf_*, voided_*,
  -- internal_notes, updated_at are fine)
  IF NOT v_any_immutable THEN
    RETURN NEW;
  END IF;

  -- ── Reject for EVERYONE — no Admin or service_role bypass ─────────────────
  -- Once an invoice has left draft, its financial/document snapshot is
  -- immutable. The correction model is: Void + Replacement Invoice.
  -- Admin and service_role must use that model, not direct field edits.
  RAISE EXCEPTION
    'Permission denied: financial, billing, and document snapshot fields on an issued '
    'invoice are immutable and cannot be changed once the invoice has left draft status. '
    'Immutable fields include: application_id, company_id, contact_id, option_cycle_id, '
    'invoice_type, currency, billing_*, emd_funded_cents, funding_date, period_*_date, '
    'billable_days, *_cents totals, credit_card_payment_enabled_snapshot, '
    'wire_instructions_snapshot, invoice_number, due_date, invoice_notes. '
    'Use Void + Replacement Invoice to correct an issued invoice.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

-- Re-attach trigger (DROP + CREATE is idempotent)
DROP TRIGGER IF EXISTS guard_issued_invoice_immutability ON public.crm_invoices;
CREATE TRIGGER guard_issued_invoice_immutability
  BEFORE UPDATE ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_issued_invoice_fields();


-- ============================================================
-- SECTION 6: SPLIT crm_invoice_settings POLICY — REMOVE DELETE
--
-- The deployed migration has:
--   admins_all_crm_invoice_settings FOR ALL
--
-- This is replaced with three separate policies:
--   admins_select_crm_invoice_settings (SELECT)
--   admins_insert_crm_invoice_settings (INSERT)
--   admins_update_crm_invoice_settings (UPDATE)
--
-- No DELETE policy is created.
-- crm_invoice_settings is a singleton containing critical
-- issuer/banking configuration. It should be updated, not deleted.
--
-- Client access: NONE
-- Anonymous access: NONE
-- ============================================================

-- Remove the broad FOR ALL policy
DROP POLICY IF EXISTS "admins_all_crm_invoice_settings"
  ON public.crm_invoice_settings;

-- Admin SELECT
DROP POLICY IF EXISTS "admins_select_crm_invoice_settings"
  ON public.crm_invoice_settings;
CREATE POLICY "admins_select_crm_invoice_settings"
  ON public.crm_invoice_settings
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- Admin INSERT
DROP POLICY IF EXISTS "admins_insert_crm_invoice_settings"
  ON public.crm_invoice_settings;
CREATE POLICY "admins_insert_crm_invoice_settings"
  ON public.crm_invoice_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin_user());

-- Admin UPDATE
DROP POLICY IF EXISTS "admins_update_crm_invoice_settings"
  ON public.crm_invoice_settings;
CREATE POLICY "admins_update_crm_invoice_settings"
  ON public.crm_invoice_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- No DELETE policy created for crm_invoice_settings.
-- The singleton settings row should be updated, not deleted.
-- If deletion is ever required, it must be performed via a
-- trusted server process with explicit business justification.


-- ============================================================
-- SECTION 7: ADD POSITIVE FUNDED AMOUNT CONSTRAINT
--
-- borrower_applications.emd_funded_cents must be:
--   NULL (not yet funded)
--   OR > 0 (positive funded amount)
--
-- Zero or negative funded amounts are not valid.
-- This does not modify any existing values.
-- deposit_amount remains unchanged.
-- ============================================================

ALTER TABLE public.borrower_applications
  ADD CONSTRAINT chk_emd_funded_cents_positive
  CHECK (
    emd_funded_cents IS NULL
    OR emd_funded_cents > 0
  );


-- ============================================================
-- SECTION 8: ADD LINE ITEM ARITHMETIC CONSISTENCY CONSTRAINTS
--
-- Enforces that line_amount_cents = quantity::BIGINT * unit_amount_cents
-- so no browser/UI can store inconsistent quantity/unit/line math.
--
-- Also enforces sign consistency:
--   For line_type = 'discount':
--     unit_amount_cents <= 0
--     line_amount_cents <= 0
--   For line_type != 'discount':
--     unit_amount_cents >= 0
--     line_amount_cents >= 0
--
-- The existing quantity > 0 constraint remains.
-- The existing chk_line_amount_discount constraint is replaced by
-- the stronger sign consistency constraint below.
--
-- Examples:
--   Admin Fee:
--     quantity=1, unit_amount_cents=250000, line_amount_cents=250000 ✓
--   BPCON26 Discount:
--     quantity=1, unit_amount_cents=-125000, line_amount_cents=-125000 ✓
--   Deal Fee:
--     quantity=1, unit_amount_cents=750000, line_amount_cents=750000 ✓
-- ============================================================

-- Remove the existing weaker discount constraint (replaced below)
ALTER TABLE public.crm_invoice_line_items
  DROP CONSTRAINT IF EXISTS chk_line_amount_discount;

-- Add arithmetic consistency constraint:
-- line_amount_cents must equal quantity * unit_amount_cents
ALTER TABLE public.crm_invoice_line_items
  ADD CONSTRAINT chk_line_item_arithmetic
  CHECK (
    line_amount_cents = quantity::BIGINT * unit_amount_cents
  );

-- Add sign consistency constraint:
-- Discount lines: both unit and line amounts must be <= 0
-- Non-discount lines: both unit and line amounts must be >= 0
ALTER TABLE public.crm_invoice_line_items
  ADD CONSTRAINT chk_line_item_sign_consistency
  CHECK (
    (
      line_type = 'discount'
      AND unit_amount_cents <= 0
      AND line_amount_cents <= 0
    )
    OR (
      line_type != 'discount'
      AND unit_amount_cents >= 0
      AND line_amount_cents >= 0
    )
  );


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION SUMMARY (6A-2c Hardening)
-- -------------------------------------
-- Migration file: 20260918001000_crm_invoicing_foundation_hardening.sql
-- Original 20260918000000 migration modified: NO
-- New additive migration created: YES
--
-- ── PRE-CONDITION VERIFICATION ────────────────────────────────────────────
-- crm_invoices row count:           0
-- crm_invoice_line_items row count: 0
-- crm_payments row count:           0
-- crm_invoice_settings row count:   0
-- invoice-pdfs objects:             0
-- Safe to apply empty-schema hardening: YES
--
-- ── POLICY CHANGES ────────────────────────────────────────────────────────
-- portal_clients_read_own_invoices removed:            YES
-- portal_clients_read_own_invoice_line_items removed:  YES
-- Client direct base-table invoice access:             NONE
-- admins_all_invoice_pdfs removed:                     YES
-- Authenticated direct storage INSERT:                 NO
-- Authenticated direct storage UPDATE:                 NO
-- Authenticated direct storage DELETE:                 NO
-- invoice-pdfs still private:                          YES
-- admins_all_crm_invoice_settings removed:             YES
-- admins_select_crm_invoice_settings created:          YES
-- admins_insert_crm_invoice_settings created:          YES
-- admins_update_crm_invoice_settings created:          YES
-- crm_invoice_settings DELETE policy:                  NONE
--
-- ── LINE ITEM REPARENTING FIX ─────────────────────────────────────────────
-- Line item INSERT parent validation:
--   Resolves NEW.invoice_id; parent must exist and be 'draft'.
--   Fails closed if parent not found. NULL status not treated as safe.
-- Line item DELETE parent validation:
--   Resolves OLD.invoice_id; parent must exist and be 'draft'.
--   Fails closed if parent not found.
-- Line item UPDATE OLD parent validation:
--   Resolves OLD.invoice_id; OLD parent must exist and be 'draft'.
--   Fails closed if OLD parent not found.
-- Line item UPDATE NEW parent validation:
--   Resolves NEW.invoice_id (only when invoice_id changes / reparenting).
--   NEW parent must exist and be 'draft'.
--   Fails closed if NEW parent not found.
-- Missing parent fails closed:                         YES
-- Issued line item reparenting possible:               NO
--
-- ── SNAPSHOT IMMUTABILITY ─────────────────────────────────────────────────
-- due_date immutable after draft:                      YES
-- invoice_notes immutable after draft:                 YES
-- internal_notes direct client access:                 NO (never exposed)
-- notes renamed to invoice_notes:                      YES
-- internal_notes added:                                YES
--
-- ── CONSTRAINTS ───────────────────────────────────────────────────────────
-- emd_funded_cents positive constraint:
--   CHECK (emd_funded_cents IS NULL OR emd_funded_cents > 0)
--   Named: chk_emd_funded_cents_positive
-- Line amount arithmetic constraint:
--   CHECK (line_amount_cents = quantity::BIGINT * unit_amount_cents)
--   Named: chk_line_item_arithmetic
-- Discount sign constraint:
--   discount lines: unit_amount_cents <= 0 AND line_amount_cents <= 0
--   non-discount lines: unit_amount_cents >= 0 AND line_amount_cents >= 0
--   Named: chk_line_item_sign_consistency
-- Original fee calculation function preserved:         YES (unchanged)
-- Original status transition guards preserved:         YES (unchanged)
--
-- ── ZERO MUTATION CONFIRMATION ────────────────────────────────────────────
-- Business rows changed during implementation:         0
-- PDFs generated:                                      0
-- Emails sent:                                         0
-- Coinflow added:                                      NO
--
-- Supabase migration required:                         YES
-- Safe to push new hardening migration after review:   YES (pending review)
-- DO NOT PUSH YET.
-- ============================================================
