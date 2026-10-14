-- ============================================================
-- Migration: 20260926020000_create_revision_draft_invoice_rpc
--
-- Step 6A-5R3A — Atomic Create Revision Draft RPC
--
-- PURPOSE
-- -------
-- Creates the atomic database RPC that creates a new editable
-- Revision Draft invoice from an eligible currently-OPEN invoice.
--
-- Example:
--   A = EB-2026-000001 OPEN
--   create_revision_draft_invoice(A) creates:
--     B Draft
--       invoice_number             = NULL
--       revision_source_invoice_id = A.id
--       replaces_invoice_id        = NULL
--   A remains OPEN.
--
-- REVISION DRAFT DEFINITION
-- -------------------------
-- A Revision Draft satisfies ALL of:
--   invoice_type               = 'initial'
--   status                     = 'draft'
--   revision_source_invoice_id IS NOT NULL
--   replaces_invoice_id        IS NULL
--   invoice_number             IS NULL
--
-- A normal initial Draft satisfies:
--   invoice_type               = 'initial'
--   status                     = 'draft'
--   revision_source_invoice_id IS NULL
--   replaces_invoice_id        IS NULL
--
-- WHAT THIS RPC DOES
-- ------------------
--   1.  Requires non-null p_admin_user_id
--   2.  Verifies Admin identity via raw_app_meta_data (server-controlled)
--   3.  Locks the source invoice FOR UPDATE by p_source_invoice_id
--   4.  Validates source invoice eligibility:
--         status = 'open'
--         invoice_type = 'initial'
--         invoice_number IS NOT NULL
--         issued_at IS NOT NULL
--         pdf_generation_status = 'generated'
--       Does NOT require revision_source_invoice_id IS NULL on the source
--       (a later revision C may use B as its source, where B itself has
--       revision_source_invoice_id = A.id).
--   5.  Checks source invoice has no blocking payments
--         (pending, received, refunded)
--       failed payments do NOT block creation
--   6.  Idempotency / active revision check:
--         A. Existing child status = 'draft':
--              Verify ALL Revision Draft invariants:
--                invoice_type = 'initial'
--                revision_source_invoice_id = p_source_invoice_id
--                replaces_invoice_id IS NULL
--                invoice_number IS NULL
--                application_id = source.application_id
--              All invariants satisfied → return existing_draft (idempotent)
--              Any invariant fails → fail closed with revision_already_in_progress
--         B. Existing issuing/open/partially_paid/paid revision → fail closed
--         C. Prior void revision → does NOT block creation
--   7.  Loads and locks current authoritative Deal facts FOR SHARE
--         borrower_applications: emd_funded_cents, funded_date
--         crm_deal_option_cycles cycle 1: deposit_goes_hard_date
--   8.  Validates authoritative facts
--   9.  Calculates canonical deal fee via public.calculate_deal_fee_cents()
--  10.  Validates source invoice line-item structure:
--         exactly 1 admin_fee, exactly 1 deal_fee, zero or more discount
--         no other/extension_admin_fee/extension_deal_fee/unknown types
--         admin_fee: quantity=1, unit_amount_cents=250000, line_amount_cents=250000
--       Does NOT require source deal_fee to match current authoritative facts
--  11.  Inserts new crm_invoices row (Revision Draft parent)
--         Copies: application_id, company_id, contact_id, option_cycle_id,
--                 invoice_type, currency, billing snapshot fields, invoice_notes
--         Sets:   status='draft', revision_source_invoice_id=source.id,
--                 replaces_invoice_id=NULL, invoice_number=NULL,
--                 due_date=NULL, internal_notes=NULL,
--                 wire_instructions_snapshot=NULL,
--                 pdf_generation_status='not_started', created_by=p_admin_user_id
--         Uses:   current authoritative financial facts (NOT source snapshot)
--  12.  Creates new admin_fee line item
--         Uses source admin_fee description/sort_order for presentation
--         Financial: quantity=1, unit_amount_cents=250000, line_amount_cents=250000
--         New UUID — does NOT reuse source line-item ID
--  13.  Creates new deal_fee line item
--         Uses source deal_fee description/sort_order for presentation
--         Financial: current authoritative facts via calculate_deal_fee_cents()
--         New UUID — does NOT reuse source line-item ID
--  14.  Copies all source discount lines as new rows
--         Preserves: description, quantity, unit_amount_cents, line_amount_cents,
--                    sort_order, calc audit fields
--         New UUIDs — does NOT reuse source line-item IDs
--  15.  Recalculates totals from the new Revision Draft's DB rows
--  16.  Updates the new parent invoice with final totals
--  17.  Returns a safe payload (no billing, wire, notes, PDF data)
--
-- WHAT THIS RPC DOES NOT DO
-- -------------------------
--   - Does NOT modify the source invoice in any way
--   - Does NOT assign an invoice number (crm_invoice_number_seq not consumed)
--   - Does NOT copy wire_instructions_snapshot
--   - Does NOT copy credit_card_payment_enabled_snapshot
--   - Does NOT copy due_date (set to NULL)
--   - Does NOT copy internal_notes (set to NULL)
--   - Does NOT copy financial snapshot from source (uses current authoritative)
--   - Does NOT create an application_activity event
--   - Does NOT call begin_invoice_issuance or begin_revision_invoice_issuance
--   - Does NOT generate a PDF
--   - Does NOT send an email
--   - Does NOT modify payment rows
--   - Does NOT modify any existing invoice row
--
-- IDEMPOTENCY
-- -----------
-- If a Revision Draft already exists for the source invoice (status='draft'),
-- the RPC returns it safely rather than creating another one.
-- This makes double-click/retry behavior safe.
--
-- ATOMICITY
-- ---------
-- The following succeed or roll back together in a single transaction:
--   - crm_invoices INSERT (Revision Draft parent)
--   - crm_invoice_line_items INSERT (admin_fee, deal_fee, discount copies)
--   - crm_invoices UPDATE (final totals)
-- If any step fails, the entire transaction rolls back.
-- No partial invoice or partial line items may remain.
--
-- CONCURRENCY
-- -----------
-- The RPC acquires FOR UPDATE on the source invoice before any mutation.
-- This prevents concurrent issuance of the source invoice from racing
-- with Revision Draft creation.
--
-- SECURITY
-- --------
-- SECURITY DEFINER with hardened SET search_path = public, pg_catalog
-- Admin authorization uses ONLY raw_app_meta_data->>'role' = 'admin'
-- (server-controlled, never user-editable metadata)
-- EXECUTE is REVOKED from PUBLIC, anon, and authenticated.
-- EXECUTE is GRANTED only to service_role.
-- The browser must never call this RPC directly.
--
-- EXISTING PROTECTIONS UNCHANGED
-- --------------------------------
-- idx_crm_invoices_revision_source_active        — NOT modified
-- idx_crm_invoices_replaces_invoice_id_unique    — NOT modified
-- validate_invoice_revision_source_integrity()   — NOT modified
-- validate_invoice_replacement_integrity()       — NOT modified
-- protect_issued_invoice_fields()                — NOT modified
-- protect_issued_invoice_line_items()            — NOT modified
-- validate_invoice_status_transition()           — NOT modified
-- refresh_initial_draft_invoice_snapshot()       — NOT modified
-- refresh_revision_draft_invoice_snapshot()      — NOT modified
-- begin_invoice_issuance()                       — NOT modified
-- complete_invoice_issuance()                    — NOT modified
-- mark_invoice_pdf_failed()                      — NOT modified
-- calculate_deal_fee_cents()                     — NOT modified
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call create_revision_draft_invoice on any real invoice
--   - modify EB-2026-000001 or any other invoice row
--   - consume any invoice number from crm_invoice_number_seq
--   - create any activity records
--   - send any emails
--   - generate any PDFs
--   - upload any storage objects
--   - UPDATE / INSERT / DELETE any business row
--
-- Expected invoice numbers consumed: 0
-- Expected invoices modified: 0
-- ============================================================


-- ============================================================
-- SECTION 1: create_revision_draft_invoice RPC
--
-- Signature:
--   public.create_revision_draft_invoice(
--     p_source_invoice_id   uuid,
--     p_admin_user_id       uuid
--   )
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Returns a safe JSONB payload (no billing, wire, notes, PDF data).
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized              — p_admin_user_id is NULL or not an authorized Admin
--   revision_source_not_found         — no invoice row found for p_source_invoice_id
--   revision_source_ineligible        — source invoice does not meet eligibility requirements,
--                                       or has blocking payments
--   revision_already_in_progress      — an active revision (issuing/open/partially_paid/paid)
--                                       already exists for this source invoice
--   revision_create_source_invalid    — authoritative Deal facts are missing or invalid
--   revision_create_line_items_invalid — source line-item structure is invalid,
--                                        or new Revision Draft totals are invalid
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_revision_draft_invoice(
  p_source_invoice_id   UUID,
  p_admin_user_id       UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  -- Admin verification
  v_admin_role                    TEXT;

  -- Source invoice row (locked FOR UPDATE)
  v_source                        public.crm_invoices%ROWTYPE;

  -- Blocking payment count on source invoice
  v_blocking_payment_count        INTEGER;

  -- Existing active revision check
  v_existing_revision             RECORD;

  -- Authoritative Deal facts
  v_app                           RECORD;   -- borrower_applications row
  v_cycle1                        RECORD;   -- crm_deal_option_cycles cycle 1 row

  -- Calculated values
  v_billable_days                 INTEGER;
  v_canonical_deal_fee_cents      BIGINT;

  -- Source line-item validation
  v_src_admin_fee_count           INTEGER;
  v_src_deal_fee_count            INTEGER;
  v_src_invalid_type_count        INTEGER;
  v_src_admin_fee_line            RECORD;
  v_src_deal_fee_line             RECORD;

  -- Expected constants
  v_expected_admin_fee_cents      CONSTANT BIGINT := 250000;
  v_expected_daily_rate_cents     CONSTANT BIGINT := 10000;

  -- New Revision Draft parent UUID
  v_new_invoice_id                UUID;

  -- Recalculated totals for the new Revision Draft
  v_subtotal_cents                BIGINT;
  v_discount_cents                BIGINT;
  v_total_cents                   BIGINT;

  -- Discount line cursor
  v_discount_line                 RECORD;

  -- Return payload
  v_result                        JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: REQUIRE NON-NULL ADMIN IDENTITY
  -- ══════════════════════════════════════════════════════════════════════════

  IF p_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_admin_user_id must not be NULL.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 2: VERIFY ADMIN IDENTITY
  --
  -- Use raw_app_meta_data (server-controlled) — never user_metadata,
  -- raw_user_meta_data, or email address.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT raw_app_meta_data->>'role'
  INTO v_admin_role
  FROM auth.users
  WHERE id = p_admin_user_id;

  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The supplied Admin identity is not authorized.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: LOCK THE SOURCE INVOICE FOR UPDATE
  --
  -- Acquire an exclusive row lock before any validation or mutation.
  -- This prevents concurrent issuance of the source invoice from racing
  -- with Revision Draft creation.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_source
  FROM public.crm_invoices
  WHERE id = p_source_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_source_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'No invoice row found for the supplied p_source_invoice_id.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: VALIDATE SOURCE INVOICE ELIGIBILITY
  --
  -- The source must satisfy ALL of:
  --   status                 = 'open'
  --   invoice_type           = 'initial'
  --   invoice_number         IS NOT NULL
  --   issued_at              IS NOT NULL
  --   pdf_generation_status  = 'generated'
  --
  -- Do NOT require revision_source_invoice_id IS NULL on the source.
  -- A later revision C may use B as its immediate source, where B itself
  -- has revision_source_invoice_id = A.id.
  --
  -- Do NOT allow revisions from:
  --   draft, issuing, partially_paid, paid, void
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_source.status                IS DISTINCT FROM 'open'
  OR v_source.invoice_type          IS DISTINCT FROM 'initial'
  OR v_source.invoice_number        IS NULL
  OR v_source.issued_at             IS NULL
  OR v_source.pdf_generation_status IS DISTINCT FROM 'generated'
  THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The source invoice does not meet revision eligibility requirements. '
                      'The source must have status=open, invoice_type=initial, '
                      'a non-null invoice_number, a non-null issued_at, '
                      'and pdf_generation_status=generated.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: CHECK SOURCE INVOICE FOR BLOCKING PAYMENTS
  --
  -- While holding the source invoice FOR UPDATE lock, check crm_payments
  -- for rows where:
  --   invoice_id = p_source_invoice_id
  --   AND status IN ('pending', 'received', 'refunded')
  --
  -- There must be ZERO such rows.
  -- Rows with status = 'failed' do NOT block creation.
  -- Do not modify payment rows.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COUNT(*)
  INTO v_blocking_payment_count
  FROM public.crm_payments
  WHERE invoice_id = p_source_invoice_id
    AND status IN ('pending', 'received', 'refunded');

  IF v_blocking_payment_count > 0 THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The source invoice has one or more blocking payments '
                      '(pending, received, or refunded). '
                      'Revision Draft creation is not permitted while blocking payments exist.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: ACTIVE REVISION / IDEMPOTENCY CHECK
  --
  -- While the source invoice is locked, look for an existing invoice where:
  --   revision_source_invoice_id = p_source_invoice_id
  --   AND status IN ('draft', 'issuing', 'open', 'partially_paid', 'paid')
  --
  -- A. If existing child has status = 'draft':
  --    Verify ALL Revision Draft invariants before returning idempotently:
  --      invoice_type               = 'initial'
  --      revision_source_invoice_id = p_source_invoice_id
  --      replaces_invoice_id        IS NULL
  --      invoice_number             IS NULL
  --      application_id             = v_source.application_id
  --    If all invariants hold → return existing_draft (idempotent).
  --    If ANY invariant fails → fail closed with revision_already_in_progress.
  --    We must never idempotently return an abnormal/corrupt Draft.
  --
  -- B. If existing child has status IN ('issuing', 'open', 'partially_paid', 'paid'):
  --    Fail closed with revision_already_in_progress.
  --
  -- C. A prior VOID revision child does NOT block creation.
  --    The existing idx_crm_invoices_revision_source_active index excludes void.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    id,
    status,
    invoice_type,
    invoice_number,
    revision_source_invoice_id,
    replaces_invoice_id,
    application_id
  INTO v_existing_revision
  FROM public.crm_invoices
  WHERE revision_source_invoice_id = p_source_invoice_id
    AND status IN ('draft', 'issuing', 'open', 'partially_paid', 'paid')
  LIMIT 1;

  IF FOUND THEN
    -- A. Existing child has status = 'draft'
    IF v_existing_revision.status = 'draft' THEN

      -- Verify ALL Revision Draft invariants before returning idempotently.
      -- A valid Revision Draft must satisfy ALL of:
      --   invoice_type               = 'initial'
      --   revision_source_invoice_id = p_source_invoice_id
      --   replaces_invoice_id        IS NULL
      --   invoice_number             IS NULL
      --   application_id             = v_source.application_id
      IF v_existing_revision.invoice_type               IS DISTINCT FROM 'initial'
      OR v_existing_revision.revision_source_invoice_id IS DISTINCT FROM p_source_invoice_id
      OR v_existing_revision.replaces_invoice_id        IS NOT NULL
      OR v_existing_revision.invoice_number             IS NOT NULL
      OR v_existing_revision.application_id             IS DISTINCT FROM v_source.application_id
      THEN
        -- Fail closed — do NOT return a malformed/corrupt Draft as idempotent
        RAISE EXCEPTION 'revision_already_in_progress'
          USING ERRCODE = 'P0001',
                DETAIL  = 'An active child invoice exists for this source invoice but does not '
                          'satisfy the expected Revision Draft invariants '
                          '(invoice_type=initial, revision_source_invoice_id matches, '
                          'replaces_invoice_id IS NULL, invoice_number IS NULL, '
                          'application_id matches). The existing record requires review.';
      END IF;

      -- All invariants satisfied — return the existing Revision Draft idempotently
      RETURN jsonb_build_object(
        'status',                     'existing_draft',
        'invoice_id',                 v_existing_revision.id,
        'revision_source_invoice_id', v_existing_revision.revision_source_invoice_id,
        'application_id',             v_existing_revision.application_id
      );
    END IF;

    -- B. Active revision already in progress — fail closed
    RAISE EXCEPTION 'revision_already_in_progress'
      USING ERRCODE = 'P0001',
            DETAIL  = 'An active revision (issuing, open, partially_paid, or paid) '
                      'already exists for this source invoice. '
                      'Only one active revision per source invoice is permitted.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: LOAD CURRENT AUTHORITATIVE DEAL FACTS
  --
  -- Using the source invoice's application_id, load and lock:
  --   borrower_applications FOR SHARE
  --     emd_funded_cents
  --     funded_date
  --   crm_deal_option_cycles cycle 1 FOR SHARE
  --     deposit_goes_hard_date
  --
  -- Do NOT use borrower_applications.deposit_amount.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    ba.emd_funded_cents,
    ba.funded_date
  INTO v_app
  FROM public.borrower_applications ba
  WHERE ba.id = v_source.application_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_create_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'borrower_applications row for this Deal could not be found.';
  END IF;

  SELECT
    doc.deposit_goes_hard_date
  INTO v_cycle1
  FROM public.crm_deal_option_cycles doc
  WHERE doc.application_id = v_source.application_id
    AND doc.cycle_number   = 1
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_create_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 option cycle row for this Deal could not be found.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: VALIDATE AUTHORITATIVE DEAL FACTS
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_app.emd_funded_cents IS NULL OR v_app.emd_funded_cents <= 0 THEN
    RAISE EXCEPTION 'revision_create_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'emd_funded_cents must be present and greater than zero.';
  END IF;

  IF v_app.funded_date IS NULL THEN
    RAISE EXCEPTION 'revision_create_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'funded_date is missing on the borrower application.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date IS NULL THEN
    RAISE EXCEPTION 'revision_create_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 deposit_goes_hard_date is missing.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date <= v_app.funded_date THEN
    RAISE EXCEPTION 'revision_create_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'deposit_goes_hard_date must be after funded_date.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: CALCULATE CURRENT CANONICAL VALUES
  --
  -- v_billable_days: PostgreSQL DATE subtraction
  -- v_canonical_deal_fee_cents: via public.calculate_deal_fee_cents()
  --   — do NOT duplicate the fee formula manually.
  -- ══════════════════════════════════════════════════════════════════════════

  v_billable_days := (v_cycle1.deposit_goes_hard_date - v_app.funded_date);

  v_canonical_deal_fee_cents := public.calculate_deal_fee_cents(
    v_app.emd_funded_cents,
    v_app.funded_date,
    v_cycle1.deposit_goes_hard_date
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: VALIDATE SOURCE LINE-ITEM STRUCTURE
  --
  -- Before creating the Revision Draft, validate the SOURCE issued invoice
  -- has:
  --   exactly 1 admin_fee
  --   exactly 1 deal_fee
  --   zero or more discount lines
  --   NO other line types
  --
  -- Reject: other, extension_admin_fee, extension_deal_fee, unknown types.
  --
  -- Validate source admin_fee:
  --   quantity = 1
  --   unit_amount_cents = 250000
  --   line_amount_cents = 250000
  --
  -- Do NOT require the SOURCE deal_fee amount to match CURRENT authoritative
  -- Deal facts. The source invoice may be getting revised specifically because
  -- financial Deal facts were corrected.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    COUNT(*) FILTER (WHERE li.line_type = 'admin_fee'),
    COUNT(*) FILTER (WHERE li.line_type = 'deal_fee'),
    COUNT(*) FILTER (WHERE li.line_type NOT IN ('admin_fee', 'deal_fee', 'discount'))
  INTO
    v_src_admin_fee_count,
    v_src_deal_fee_count,
    v_src_invalid_type_count
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_source_invoice_id;

  IF v_src_invalid_type_count > 0 THEN
    RAISE EXCEPTION 'revision_create_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice contains line type(s) not permitted for revision. '
                      'Only admin_fee, deal_fee, and discount lines are allowed.';
  END IF;

  IF v_src_admin_fee_count != 1 THEN
    RAISE EXCEPTION 'revision_create_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice must have exactly 1 admin_fee line item.';
  END IF;

  IF v_src_deal_fee_count != 1 THEN
    RAISE EXCEPTION 'revision_create_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice must have exactly 1 deal_fee line item.';
  END IF;

  -- Validate source admin_fee amounts
  SELECT
    li.quantity,
    li.unit_amount_cents,
    li.line_amount_cents
  INTO v_src_admin_fee_line
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_source_invoice_id
    AND li.line_type  = 'admin_fee';

  IF v_src_admin_fee_line.quantity          IS DISTINCT FROM 1
  OR v_src_admin_fee_line.unit_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  OR v_src_admin_fee_line.line_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  THEN
    RAISE EXCEPTION 'revision_create_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source admin_fee line does not match the expected base Administrative Fee '
                      '(quantity=1, unit_amount_cents=250000, line_amount_cents=250000).';
  END IF;

  -- Load source deal_fee line for presentation fields (description, sort_order)
  -- Do NOT validate its financial amounts against current authoritative facts.
  SELECT
    li.description,
    li.sort_order
  INTO v_src_deal_fee_line
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_source_invoice_id
    AND li.line_type  = 'deal_fee';


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: CREATE REVISION DRAFT PARENT ROW
  --
  -- Insert ONE new row into public.crm_invoices.
  -- Generate a new invoice UUID normally via gen_random_uuid().
  --
  -- Copy from source:
  --   application_id, company_id, contact_id, option_cycle_id,
  --   invoice_type, currency
  --   billing snapshot fields (billing_name through billing_country)
  --   invoice_notes
  --
  -- Set from current authoritative Deal facts (NOT source snapshot):
  --   emd_funded_cents, funding_date, period_start_date, period_end_date,
  --   billable_days
  --
  -- Set explicitly:
  --   status                         = 'draft'
  --   revision_source_invoice_id     = source.id
  --   replaces_invoice_id            = NULL
  --   invoice_number                 = NULL
  --   due_date                       = NULL
  --   internal_notes                 = NULL
  --   wire_instructions_snapshot     = NULL
  --   issuing_started_at             = NULL
  --   issued_at                      = NULL
  --   paid_at                        = NULL
  --   voided_at                      = NULL
  --   voided_by                      = NULL
  --   void_reason                    = NULL
  --   pdf_storage_path               = NULL
  --   pdf_generated_at               = NULL
  --   pdf_hash                       = NULL
  --   pdf_generation_status          = 'not_started'
  --   pdf_generation_error           = NULL
  --   created_by                     = p_admin_user_id
  --
  -- Totals (subtotal_cents, discount_cents, tax_cents, total_cents) are set
  -- to 0 initially and updated in STEP 16 after line items are inserted.
  --
  -- Do NOT consume crm_invoice_number_seq.
  -- Do NOT copy credit_card_payment_enabled_snapshot (NOT NULL with Draft default).
  -- ══════════════════════════════════════════════════════════════════════════

  v_new_invoice_id := gen_random_uuid();

  INSERT INTO public.crm_invoices (
    id,
    application_id,
    company_id,
    contact_id,
    option_cycle_id,
    invoice_type,
    currency,
    status,
    revision_source_invoice_id,
    replaces_invoice_id,
    invoice_number,
    -- Billing snapshot (copied from source)
    billing_name,
    billing_contact_name,
    billing_email,
    billing_address_line1,
    billing_address_line2,
    billing_city,
    billing_state,
    billing_postal_code,
    billing_country,
    -- Financial snapshot (current authoritative Deal facts)
    emd_funded_cents,
    funding_date,
    period_start_date,
    period_end_date,
    billable_days,
    -- Totals (placeholder; updated after line items are inserted)
    subtotal_cents,
    discount_cents,
    tax_cents,
    total_cents,
    -- Due date / notes
    due_date,
    invoice_notes,
    internal_notes,
    -- Payment / wire snapshots
    wire_instructions_snapshot,
    -- Workflow / PDF fields (all reset to clean state)
    issuing_started_at,
    issued_at,
    paid_at,
    voided_at,
    voided_by,
    void_reason,
    pdf_storage_path,
    pdf_generated_at,
    pdf_hash,
    pdf_generation_status,
    pdf_generation_error,
    -- Audit
    created_by
  )
  VALUES (
    v_new_invoice_id,
    v_source.application_id,
    v_source.company_id,
    v_source.contact_id,
    v_source.option_cycle_id,
    v_source.invoice_type,
    v_source.currency,
    'draft',
    v_source.id,                          -- revision_source_invoice_id
    NULL,                                 -- replaces_invoice_id
    NULL,                                 -- invoice_number
    -- Billing snapshot from source
    v_source.billing_name,
    v_source.billing_contact_name,
    v_source.billing_email,
    v_source.billing_address_line1,
    v_source.billing_address_line2,
    v_source.billing_city,
    v_source.billing_state,
    v_source.billing_postal_code,
    v_source.billing_country,
    -- Financial snapshot from current authoritative Deal facts
    v_app.emd_funded_cents,
    v_app.funded_date,                    -- funding_date
    v_app.funded_date,                    -- period_start_date
    v_cycle1.deposit_goes_hard_date,      -- period_end_date
    v_billable_days,
    -- Totals placeholder (updated after line items)
    0,                                    -- subtotal_cents
    0,                                    -- discount_cents
    0,                                    -- tax_cents
    0,                                    -- total_cents
    -- Due date / notes
    NULL,                                 -- due_date
    v_source.invoice_notes,
    NULL,                                 -- internal_notes
    -- Payment / wire snapshots
    NULL,                                 -- wire_instructions_snapshot
    -- Workflow / PDF fields
    NULL,                                 -- issuing_started_at
    NULL,                                 -- issued_at
    NULL,                                 -- paid_at
    NULL,                                 -- voided_at
    NULL,                                 -- voided_by
    NULL,                                 -- void_reason
    NULL,                                 -- pdf_storage_path
    NULL,                                 -- pdf_generated_at
    NULL,                                 -- pdf_hash
    'not_started',                        -- pdf_generation_status
    NULL,                                 -- pdf_generation_error
    -- Audit
    p_admin_user_id                       -- created_by
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: CREATE NEW ADMIN FEE LINE ITEM
  --
  -- Use the SOURCE admin_fee line only for presentation fields:
  --   description, sort_order
  --
  -- Financial values on the new line must be:
  --   quantity = 1
  --   unit_amount_cents = 250000
  --   line_amount_cents = 250000
  --
  -- Generate a NEW line-item UUID.
  -- Do NOT reuse the source line-item ID.
  -- Calculation audit fields for admin_fee remain NULL.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.crm_invoice_line_items (
    id,
    invoice_id,
    line_type,
    description,
    quantity,
    unit_amount_cents,
    line_amount_cents,
    sort_order
  )
  SELECT
    gen_random_uuid(),
    v_new_invoice_id,
    'admin_fee',
    li.description,
    1,
    v_expected_admin_fee_cents,
    v_expected_admin_fee_cents,
    li.sort_order
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_source_invoice_id
    AND li.line_type  = 'admin_fee';


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: CREATE NEW DEAL FEE LINE ITEM
  --
  -- Use the SOURCE deal_fee line for presentation fields:
  --   description, sort_order
  --
  -- Use CURRENT authoritative Deal facts for all financial/calculation fields:
  --   quantity = 1
  --   unit_amount_cents = canonical current Deal Fee
  --   line_amount_cents = canonical current Deal Fee
  --   calc_emd_funded_cents = current emd_funded_cents
  --   calc_daily_rate_per_100k_cents = 10000
  --   calc_billable_days = current calculated billable_days
  --   calc_period_start_date = current funded_date
  --   calc_period_end_date = current Cycle 1 deposit_goes_hard_date
  --
  -- Generate a NEW line-item UUID.
  -- Do NOT copy the stale source deal-fee calculation fields.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.crm_invoice_line_items (
    id,
    invoice_id,
    line_type,
    description,
    quantity,
    unit_amount_cents,
    line_amount_cents,
    calc_emd_funded_cents,
    calc_daily_rate_per_100k_cents,
    calc_billable_days,
    calc_period_start_date,
    calc_period_end_date,
    sort_order
  )
  SELECT
    gen_random_uuid(),
    v_new_invoice_id,
    'deal_fee',
    li.description,
    1,
    v_canonical_deal_fee_cents,
    v_canonical_deal_fee_cents,
    v_app.emd_funded_cents,
    v_expected_daily_rate_cents,
    v_billable_days,
    v_app.funded_date,
    v_cycle1.deposit_goes_hard_date,
    li.sort_order
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_source_invoice_id
    AND li.line_type  = 'deal_fee';


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: COPY DISCOUNT / WAIVER LINES
  --
  -- Copy every source line where line_type = 'discount' into NEW line-item
  -- rows belonging to the Revision Draft.
  --
  -- Preserve each discount's:
  --   description, quantity, unit_amount_cents, line_amount_cents,
  --   sort_order, calculation audit fields (if any)
  --
  -- Generate NEW line-item UUIDs.
  -- Do NOT copy IDs or timestamps.
  --
  -- This includes Admin Fee Waiver and other invoice discounts/credits.
  -- These copied discount rows remain editable while the Revision is Draft.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.crm_invoice_line_items (
    id,
    invoice_id,
    line_type,
    description,
    quantity,
    unit_amount_cents,
    line_amount_cents,
    calc_emd_funded_cents,
    calc_daily_rate_per_100k_cents,
    calc_billable_days,
    calc_period_start_date,
    calc_period_end_date,
    sort_order
  )
  SELECT
    gen_random_uuid(),
    v_new_invoice_id,
    li.line_type,
    li.description,
    li.quantity,
    li.unit_amount_cents,
    li.line_amount_cents,
    li.calc_emd_funded_cents,
    li.calc_daily_rate_per_100k_cents,
    li.calc_billable_days,
    li.calc_period_start_date,
    li.calc_period_end_date,
    li.sort_order
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_source_invoice_id
    AND li.line_type  = 'discount';


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 15: RECALCULATE REVISION DRAFT TOTALS
  --
  -- After inserting the new line items, calculate totals from the NEW
  -- Revision Draft's DB rows.
  --
  -- subtotal_cents: sum of non-discount line_amount_cents
  -- discount_cents: absolute total of discount line_amount_cents
  -- tax_cents:      0
  -- total_cents:    subtotal_cents - discount_cents
  --
  -- Require:
  --   discount_cents <= subtotal_cents
  --   total_cents >= 0
  --
  -- If invalid, the entire transaction rolls back (no partial invoice).
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    COALESCE(SUM(li.line_amount_cents) FILTER (WHERE li.line_type != 'discount'), 0),
    COALESCE(ABS(SUM(li.line_amount_cents) FILTER (WHERE li.line_type = 'discount')), 0)
  INTO
    v_subtotal_cents,
    v_discount_cents
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = v_new_invoice_id;

  IF v_discount_cents > v_subtotal_cents THEN
    RAISE EXCEPTION 'revision_create_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Total discount exceeds subtotal; invoice total would be negative. '
                      'Review discount lines on the source invoice before creating a revision.';
  END IF;

  v_total_cents := v_subtotal_cents - v_discount_cents;

  IF v_total_cents < 0 THEN
    RAISE EXCEPTION 'revision_create_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Calculated total_cents is negative. '
                      'Review discount lines on the source invoice before creating a revision.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 16: UPDATE REVISION DRAFT PARENT WITH FINAL TOTALS
  --
  -- Update the new parent invoice with the recalculated totals.
  -- The final UPDATE must fail closed and require:
  --   id                           = v_new_invoice_id
  --   status                       = 'draft'
  --   invoice_type                 = 'initial'
  --   revision_source_invoice_id   IS NOT NULL
  --   replaces_invoice_id          IS NULL
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    subtotal_cents = v_subtotal_cents,
    discount_cents = v_discount_cents,
    tax_cents      = 0,
    total_cents    = v_total_cents,
    updated_at     = now()
  WHERE id                           = v_new_invoice_id
    AND status                       = 'draft'
    AND invoice_type                 = 'initial'
    AND revision_source_invoice_id   IS NOT NULL
    AND replaces_invoice_id          IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_create_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The new Revision Draft invoice could not be updated with final totals. '
                      'The row may have been modified concurrently or no longer satisfies '
                      'Revision Draft criteria.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 17: SOURCE INVOICE MUST REMAIN UNCHANGED
  --
  -- This RPC has not issued any UPDATE, DELETE, or INSERT against the source
  -- invoice row. The source invoice remains OPEN with all its fields intact.
  --
  -- The FOR UPDATE lock on the source invoice is released at transaction end.
  -- ══════════════════════════════════════════════════════════════════════════


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 18: BUILD SAFE RETURN PAYLOAD
  --
  -- Return only safe fields for a newly created Revision Draft.
  -- invoice_number must remain NULL.
  --
  -- Do NOT return:
  --   billing addresses, billing email, invoice notes, internal notes,
  --   wire information, bank data, PDF path/hash, payment details,
  --   sensitive settings.
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'status',                     'created',
    'invoice_id',                 v_new_invoice_id,
    'revision_source_invoice_id', v_source.id,
    'source_invoice_number',      v_source.invoice_number,
    'application_id',             v_source.application_id,
    'invoice_type',               v_source.invoice_type,
    'subtotal_cents',             v_subtotal_cents,
    'discount_cents',             v_discount_cents,
    'tax_cents',                  0,
    'total_cents',                v_total_cents
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 2: GRANT / REVOKE EXECUTE ON create_revision_draft_invoice
--
-- CREATE OR REPLACE resets privileges; apply grants explicitly.
-- The browser must never call this RPC directly.
-- Only the trusted server-side API (using service_role) may call it.
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.create_revision_draft_invoice(UUID, UUID)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders: anon is a named role in Supabase)
REVOKE EXECUTE ON FUNCTION public.create_revision_draft_invoice(UUID, UUID)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders: authenticated is a named role)
REVOKE EXECUTE ON FUNCTION public.create_revision_draft_invoice(UUID, UUID)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.create_revision_draft_invoice(UUID, UUID)
  TO service_role;
