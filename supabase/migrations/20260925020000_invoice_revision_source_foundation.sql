-- ============================================================
-- Migration: 20260925020000_invoice_revision_source_foundation
--
-- Step 6A-5R2A — Invoice Revision Schema Foundation
--
-- PURPOSE
-- -------
-- Additive schema foundation for the invoice revision workflow.
-- This migration creates the DB-level structures needed to link
-- a Revision Draft to the currently-open invoice it intends to
-- replace, while the source invoice remains OPEN.
--
-- This is NOT the revision issuance RPC.
-- This is NOT the Create Revision API.
-- This is NOT the Admin UI for revisions.
--
-- CHANGES IN THIS MIGRATION
-- -------------------------
-- 1.  Add crm_invoices.revision_source_invoice_id (UUID NULL FK)
--     Identifies the open invoice being revised while the new
--     revision is still a Draft. Distinct from replaces_invoice_id.
--     Preserved after issuance for audit history.
--
-- 2.  Create partial UNIQUE index idx_crm_invoices_revision_source_active
--     Prevents more than one active revision from the same source invoice.
--     Predicate: revision_source_invoice_id IS NOT NULL
--                AND status IN ('draft','issuing','open','partially_paid','paid')
--     Does NOT include 'void' — a voided revision does not block future
--     revisions from the same source.
--
-- 3.  Create validate_invoice_revision_source_integrity() trigger function
--     Enforces on BEFORE INSERT OR UPDATE OF revision_source_invoice_id,
--     application_id, invoice_type:
--       A. No self-reference
--       B. Source invoice must exist
--       C. Same Deal (source.application_id = NEW.application_id)
--       D. Same invoice_type (source.invoice_type = NEW.invoice_type)
--     Does NOT enforce source status — source is OPEN during Draft creation
--     but intentionally becomes VOID while revision_source_invoice_id remains.
--
-- 4.  Update protect_issued_invoice_fields() to add
--     revision_source_invoice_id to the immutable snapshot comparison.
--     While OLD.status = 'draft': field may be set freely.
--     Once OLD.status != 'draft': field is immutable.
--     replaces_invoice_id behavior is NOT changed — it must remain
--     settable during revision completion (when OLD.status = 'issuing').
--
-- LIFECYCLE
-- ---------
--   A = OPEN
--   ↓
--   B DRAFT:
--     revision_source_invoice_id = A.id
--     replaces_invoice_id = NULL
--
--   After successful B issuance:
--     A = VOID
--     B = OPEN
--       revision_source_invoice_id = A.id   ← preserved for audit history
--       replaces_invoice_id = A.id          ← set atomically at completion
--
-- EXISTING DATA
-- -------------
-- All existing invoice rows receive revision_source_invoice_id = NULL.
-- No backfill. No status changes. No invoice_number changes.
-- No replaces_invoice_id changes. No PDF changes. No payments changes.
-- No activities changes. No line items changes.
--
-- MIGRATION SAFETY
-- ----------------
-- - Additive only: new column, new index, new trigger function, updated trigger
-- - Existing invoice rows remain valid (NULL is the default)
-- - No production business rows are modified
-- - Existing original issuance remains unchanged
-- - Existing replaces_invoice_id constraint/index remains unchanged
-- - Existing PDF immutability remains unchanged
-- - Existing invoice-number sequence remains unchanged
-- - API routes: NOT modified
-- - Admin UI: NOT modified
-- - begin_invoice_issuance(): NOT modified
-- - complete_invoice_issuance(): NOT modified
-- - refresh_initial_draft_invoice_snapshot(): NOT modified
--
-- SECURITY
-- --------
-- All new trigger functions:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
-- No RLS changes required for this column.
-- No direct client access created.
-- ============================================================


-- ============================================================
-- SECTION 1: ADD revision_source_invoice_id COLUMN
--
-- Self-referencing FK to crm_invoices(id).
-- ON DELETE SET NULL: if the source invoice is hard-deleted
-- (blocked for issued invoices by protect_issued_invoice_delete,
-- but safe fallback for edge cases), the link becomes NULL
-- rather than blocking the deletion or orphaning the revision.
--
-- NULL default: all existing rows receive NULL automatically.
-- No backfill required.
-- ============================================================

ALTER TABLE public.crm_invoices
  ADD COLUMN IF NOT EXISTS revision_source_invoice_id UUID NULL
    REFERENCES public.crm_invoices(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.crm_invoices.revision_source_invoice_id IS
  'Draft-time revision source: identifies the currently-OPEN invoice that this '
  'Revision Draft intends to replace. Set at Revision Draft creation; the source '
  'invoice remains OPEN while this revision is a Draft. Preserved permanently after '
  'issuance for audit history. '
  'DISTINCT from replaces_invoice_id: replaces_invoice_id is set atomically at '
  'revision issuance completion (when the source is voided and this invoice becomes '
  'OPEN). revision_source_invoice_id is the Draft-time link; replaces_invoice_id is '
  'the permanent canonical replacement record.';


-- ============================================================
-- SECTION 2: ACTIVE REVISION UNIQUENESS INDEX
--
-- Prevents more than one active revision from the same source invoice.
--
-- Predicate includes statuses where the revision is "active":
--   draft        — revision in progress, not yet issued
--   issuing      — revision issuance in flight
--   open         — revision successfully issued and current
--   partially_paid — revision is current and has partial payment
--   paid         — revision is fully paid (still the canonical replacement)
--
-- 'void' is intentionally EXCLUDED:
--   A voided revision (e.g., B was later superseded by C) should NOT
--   block a new revision from the same source. The chain A → B → C
--   requires B to be void before C can be issued, and B's
--   revision_source_invoice_id = A.id must not block C.
--   (C's revision_source_invoice_id = B.id, not A.id, so there is
--   no conflict in practice — but the exclusion is correct regardless.)
--
-- The existing partial UNIQUE index on replaces_invoice_id remains
-- the permanent canonical replacement protection and is NOT modified.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_invoices_revision_source_active
  ON public.crm_invoices (revision_source_invoice_id)
  WHERE revision_source_invoice_id IS NOT NULL
    AND status IN ('draft', 'issuing', 'open', 'partially_paid', 'paid');


-- ============================================================
-- SECTION 3: REVISION SOURCE INTEGRITY TRIGGER
--
-- Validates revision_source_invoice_id on INSERT or UPDATE.
-- Fires BEFORE INSERT OR UPDATE OF revision_source_invoice_id,
-- application_id, invoice_type.
--
-- When revision_source_invoice_id IS NULL: passes through unchanged.
--
-- When non-null, enforces:
--   A. No self-reference (stable error token: revision_source_self_reference)
--   B. Source invoice must exist (stable error token: revision_source_not_found)
--   C. Same Deal: source.application_id = NEW.application_id
--      (stable error token: revision_source_wrong_application)
--   D. Same invoice_type: source.invoice_type = NEW.invoice_type
--      (stable error token: revision_source_type_mismatch)
--
-- Source STATUS is intentionally NOT enforced here.
-- Reason: The source is OPEN during Draft creation but later
-- intentionally becomes VOID while revision_source_invoice_id
-- remains populated. Source status/payment eligibility will be
-- enforced in the revision API/RPCs.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_invoice_revision_source_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_source_application_id UUID;
  v_source_invoice_type   TEXT;
BEGIN

  -- When revision_source_invoice_id is NULL: nothing to validate.
  IF NEW.revision_source_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- On UPDATE: skip re-validation if neither revision_source_invoice_id
  -- nor application_id nor invoice_type actually changed.
  IF TG_OP = 'UPDATE'
     AND NEW.revision_source_invoice_id IS NOT DISTINCT FROM OLD.revision_source_invoice_id
     AND NEW.application_id             IS NOT DISTINCT FROM OLD.application_id
     AND NEW.invoice_type               IS NOT DISTINCT FROM OLD.invoice_type
  THEN
    RETURN NEW;
  END IF;

  -- ── A. No self-reference ─────────────────────────────────────────────────
  IF NEW.revision_source_invoice_id = NEW.id THEN
    RAISE EXCEPTION 'revision_source_self_reference: invoice % cannot reference itself as revision_source_invoice_id.',
      NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- ── B. Source invoice must exist ─────────────────────────────────────────
  SELECT application_id, invoice_type
    INTO v_source_application_id, v_source_invoice_type
  FROM public.crm_invoices
  WHERE id = NEW.revision_source_invoice_id;

  IF v_source_application_id IS NULL THEN
    RAISE EXCEPTION 'revision_source_not_found: revision_source_invoice_id % does not exist.',
      NEW.revision_source_invoice_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- ── C. Same Deal ─────────────────────────────────────────────────────────
  IF v_source_application_id IS DISTINCT FROM NEW.application_id THEN
    RAISE EXCEPTION 'revision_source_wrong_application: revision_source_invoice_id % belongs to a different Deal (application_id). '
      'A revision must belong to the same Deal as its source invoice.',
      NEW.revision_source_invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- ── D. Same invoice_type ─────────────────────────────────────────────────
  -- Both source and revision will be invoice_type = ''initial'' for the current
  -- implementation, but enforcing same type makes the relationship safe for
  -- future extension invoice support.
  IF v_source_invoice_type IS DISTINCT FROM NEW.invoice_type THEN
    RAISE EXCEPTION 'revision_source_type_mismatch: revision_source_invoice_id % has invoice_type ''%'' '
      'but this invoice has invoice_type ''%''. '
      'A revision must have the same invoice_type as its source invoice.',
      NEW.revision_source_invoice_id, v_source_invoice_type, NEW.invoice_type
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;

END;
$func$;

-- Attach trigger
DROP TRIGGER IF EXISTS guard_invoice_revision_source_integrity ON public.crm_invoices;
CREATE TRIGGER guard_invoice_revision_source_integrity
  BEFORE INSERT OR UPDATE OF revision_source_invoice_id, application_id, invoice_type
  ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invoice_revision_source_integrity();


-- ============================================================
-- SECTION 4: ADD revision_source_invoice_id TO IMMUTABILITY TRIGGER
--
-- Updates protect_issued_invoice_fields() to include
-- revision_source_invoice_id in the immutable snapshot comparison.
--
-- Behavior:
--   While OLD.status = 'draft':
--     revision_source_invoice_id may be set freely (the existing
--     IF OLD.status = 'draft' THEN RETURN NEW guard allows this).
--   Once OLD.status != 'draft':
--     revision_source_invoice_id is immutable.
--
-- replaces_invoice_id is intentionally NOT added to the immutable
-- list in this step. It must remain settable during revision
-- completion (when OLD.status = 'issuing'), which is after the
-- invoice has left draft. replaces_invoice_id immutability will
-- be addressed in a later revision step once the issuance RPCs
-- are in place.
--
-- All existing protected fields are preserved exactly.
-- All existing workflow exceptions are preserved exactly.
-- ============================================================

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
    OR NEW.invoice_notes                        IS DISTINCT FROM OLD.invoice_notes
    -- Added in revision foundation migration 20260925020000:
    -- revision_source_invoice_id is immutable once the invoice leaves draft.
    -- It may be set freely while OLD.status = 'draft' (guarded above).
    -- replaces_invoice_id is intentionally NOT included here — it must remain
    -- settable during revision completion (OLD.status = 'issuing').
    OR NEW.revision_source_invoice_id           IS DISTINCT FROM OLD.revision_source_invoice_id;

  -- No immutable field changed → allow (workflow fields like status, pdf_*, voided_*,
  -- replaces_invoice_id, internal_notes, updated_at are fine)
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
    'wire_instructions_snapshot, invoice_number, due_date, invoice_notes, '
    'revision_source_invoice_id. '
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
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION SUMMARY (6A-5R2A — Invoice Revision Schema Foundation)
-- -----------------------------------------------------------------
-- Migration file: 20260925020000_invoice_revision_source_foundation.sql
-- Historical migration files modified: NO
-- Supabase deployment performed: NO
--
-- ── COLUMN ────────────────────────────────────────────────────────────────
-- revision_source_invoice_id added:                    YES
-- Data type:                                           UUID NULL
-- FK target:                                           public.crm_invoices(id)
-- ON DELETE behavior:                                  SET NULL
-- Column comment added:                                YES
-- Existing rows backfilled:                            NO (NULL default)
-- Existing invoice data modified:                      NO
--
-- ── INDEX ─────────────────────────────────────────────────────────────────
-- idx_crm_invoices_revision_source_active created:     YES
-- Index type:                                          PARTIAL UNIQUE
-- Predicate:
--   revision_source_invoice_id IS NOT NULL
--   AND status IN ('draft','issuing','open','partially_paid','paid')
-- 'void' excluded from predicate:                      YES
-- Existing replaces_invoice_id index changed:          NO
--
-- ── INTEGRITY TRIGGER ─────────────────────────────────────────────────────
-- validate_invoice_revision_source_integrity() created: YES
-- SECURITY DEFINER:                                    YES
-- SET search_path = public, pg_catalog:                YES
-- Fires on:
--   BEFORE INSERT OR UPDATE OF
--     revision_source_invoice_id, application_id, invoice_type
-- Self-reference protected:                            YES (revision_source_self_reference)
-- Source must exist:                                   YES (revision_source_not_found)
-- Same Deal enforced:                                  YES (revision_source_wrong_application)
-- Same invoice_type enforced:                          YES (revision_source_type_mismatch)
-- Source status enforced in trigger:                   NO (intentional — source is OPEN
--                                                         during Draft creation but later
--                                                         becomes VOID; status enforced
--                                                         in revision API/RPCs)
--
-- ── IMMUTABILITY ──────────────────────────────────────────────────────────
-- revision_source_invoice_id immutable after draft:    YES
-- Existing immutable fields preserved:                 YES (all fields from
--                                                         20260918001000 preserved exactly)
-- replaces_invoice_id behavior changed:                NO (still mutable after draft,
--                                                         required for revision completion)
-- protect_issued_invoice_fields() re-attached:         YES
--
-- ── SAFETY REVIEW ─────────────────────────────────────────────────────────
-- Migration is additive:                               YES
-- Existing invoice rows remain valid:                  YES
-- No production business rows modified:                YES
-- Existing original issuance unchanged:                YES
-- Existing replaces_invoice_id constraint/index:       UNCHANGED
-- Existing PDF immutability:                           UNCHANGED
-- Existing invoice-number sequence:                    UNCHANGED
-- API modified:                                        NO
-- UI modified:                                         NO
-- begin_invoice_issuance() modified:                   NO
-- complete_invoice_issuance() modified:                NO
-- refresh_initial_draft_invoice_snapshot() modified:   NO
-- Supabase deployment performed:                       NO
-- Safe to review migration:                            YES
-- ============================================================
