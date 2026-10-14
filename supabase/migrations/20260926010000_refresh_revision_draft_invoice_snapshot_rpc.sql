-- ============================================================
-- Migration: 20260926010000_refresh_revision_draft_invoice_snapshot_rpc
--
-- Step 6A-5R2C1 — Revision Draft Financial Refresh RPC
--
-- PURPOSE
-- -------
-- Creates the atomic database RPC that refreshes the financial snapshot
-- of an existing Revision Draft invoice when authoritative Deal facts
-- change after the Revision Draft was created.
--
-- Authoritative facts that may change:
--   A. emd_funded_cents              (borrower_applications)
--   B. funded_date                   (borrower_applications)
--   C. deposit_goes_hard_date        (crm_deal_option_cycles, cycle 1)
--
-- This RPC is the revision-specific counterpart to:
--   public.refresh_initial_draft_invoice_snapshot()
--
-- REVISION DRAFT DEFINITION
-- -------------------------
-- A Revision Draft satisfies ALL of:
--   invoice_type               = 'initial'
--   status                     = 'draft'
--   revision_source_invoice_id IS NOT NULL
--   replaces_invoice_id        IS NULL
--
-- A normal initial Draft satisfies:
--   invoice_type               = 'initial'
--   status                     = 'draft'
--   revision_source_invoice_id IS NULL
--   replaces_invoice_id        IS NULL
--
-- This RPC must NEVER refresh a normal initial Draft.
-- refresh_initial_draft_invoice_snapshot() must NEVER refresh a Revision Draft.
-- Both functions are mutually exclusive by design.
--
-- WHAT THIS RPC DOES
-- ------------------
--   1.  Requires non-null p_admin_user_id
--   2.  Verifies Admin identity via raw_app_meta_data (server-controlled)
--   3.  Locks the Revision Draft invoice FOR UPDATE by p_invoice_id
--   4.  Validates the locked invoice is a Revision Draft (all four criteria)
--   5.  Loads and locks the source invoice FOR UPDATE
--   6.  Validates source invoice eligibility (same Deal, initial type, open, numbered)
--   7.  Checks source invoice has no blocking payments (pending/received/refunded)
--   8.  Loads and locks authoritative Deal facts FOR SHARE
--   9.  Validates authoritative facts (emd > 0, funded_date, hard_date > funded_date)
--  10.  Calculates canonical deal fee via public.calculate_deal_fee_cents()
--  11.  Validates Revision Draft line-item structure
--  12.  Validates admin_fee line is unchanged at $2,500.00
--  13.  Updates ONLY the existing deal_fee line in place (no delete/reinsert)
--  14.  Preserves all discount/waiver lines unchanged
--  15.  Recalculates totals from the final line-item set
--  16.  Updates only the financial snapshot fields on crm_invoices
--  17.  Returns a safe payload (no billing, wire, notes, PDF data)
--
-- WHAT THIS RPC DOES NOT DO
-- -------------------------
--   - Does NOT refresh a normal initial Draft
--   - Does NOT modify billing snapshot fields
--   - Does NOT modify due_date
--   - Does NOT modify invoice_notes or internal_notes
--   - Does NOT modify invoice_number
--   - Does NOT modify wire_instructions_snapshot
--   - Does NOT modify credit_card_payment_enabled_snapshot
--   - Does NOT modify status
--   - Does NOT modify issued_at / issuing_started_at
--   - Does NOT modify PDF fields
--   - Does NOT modify created_by
--   - Does NOT modify revision_source_invoice_id
--   - Does NOT modify replaces_invoice_id
--   - Does NOT delete or recreate discount lines
--   - Does NOT modify payment rows
--   - Does NOT create an application_activity event
--   - Does NOT consume an invoice number
--   - Does NOT call begin_invoice_issuance
--   - Does NOT call begin_revision_invoice_issuance (does not exist yet)
--
-- INTENTIONAL REVISION BEHAVIOR
-- ------------------------------
-- This refresh uses CURRENT authoritative Deal facts.
-- It does NOT copy the old issued invoice's emd_funded_cents, funding_date,
-- period dates, billable_days, or deal fee.
-- The purpose of the Revision Draft is to reflect corrected/current Deal facts.
-- However, billing snapshot edits, invoice notes, due-date override, and
-- discount/waiver lines must remain untouched.
--
-- ATOMICITY
-- ---------
-- The following succeed or roll back together in a single transaction:
--   - deal_fee line financial fields refresh
--   - deal_fee line audit fields refresh
--   - crm_invoices financial snapshot refresh
--   - invoice totals refresh
--
-- CONCURRENCY
-- -----------
-- The RPC acquires FOR UPDATE on both the Revision Draft and its source
-- invoice before any mutation. This prevents concurrent issuance of the
-- source invoice from racing with a refresh.
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
-- EXISTING FUNCTIONS UNCHANGED
-- ----------------------------
-- refresh_initial_draft_invoice_snapshot()  — NOT modified
-- begin_invoice_issuance()                  — NOT modified
-- complete_invoice_issuance()               — NOT modified
-- mark_invoice_pdf_failed()                 — NOT modified
-- protect_issued_invoice_fields()           — NOT modified
-- validate_invoice_revision_source_integrity() — NOT modified
-- validate_invoice_replacement_integrity()  — NOT modified
-- calculate_deal_fee_cents()                — NOT modified
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call refresh_revision_draft_invoice_snapshot on any real invoice
--   - call begin_invoice_issuance on any real invoice
--   - consume any invoice number from crm_invoice_number_seq
--   - transition any invoice from draft to issuing
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
-- SECTION 1: refresh_revision_draft_invoice_snapshot RPC
--
-- Signature:
--   public.refresh_revision_draft_invoice_snapshot(
--     p_invoice_id      uuid,
--     p_admin_user_id   uuid
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
--   revision_draft_not_found          — no invoice row found for p_invoice_id
--   revision_draft_not_eligible       — invoice exists but is not a Revision Draft
--   revision_source_ineligible        — source invoice is not open/numbered/same-deal,
--                                       or has blocking payments
--   revision_refresh_source_invalid   — authoritative Deal facts are missing or invalid
--   revision_refresh_line_items_invalid — Revision Draft line-item structure is invalid,
--                                         admin_fee is wrong, or discount exceeds subtotal
-- ============================================================

CREATE OR REPLACE FUNCTION public.refresh_revision_draft_invoice_snapshot(
  p_invoice_id      UUID,
  p_admin_user_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  -- Admin verification
  v_admin_role                TEXT;

  -- Revision Draft invoice row (locked FOR UPDATE)
  v_invoice                   public.crm_invoices%ROWTYPE;

  -- Source invoice row (locked FOR UPDATE)
  v_source_invoice            public.crm_invoices%ROWTYPE;

  -- Blocking payment count on source invoice
  v_blocking_payment_count    INTEGER;

  -- Authoritative source data
  v_app                       RECORD;   -- borrower_applications row
  v_cycle1                    RECORD;   -- crm_deal_option_cycles cycle 1 row

  -- Calculated values
  v_billable_days             INTEGER;
  v_canonical_deal_fee_cents  BIGINT;

  -- Line item validation
  v_admin_fee_count           INTEGER;
  v_deal_fee_count            INTEGER;
  v_invalid_type_count        INTEGER;
  v_admin_fee_line            RECORD;

  -- Expected constants (consistent with begin_invoice_issuance and Draft creation)
  v_expected_admin_fee_cents  CONSTANT BIGINT := 250000;
  v_expected_daily_rate_cents CONSTANT BIGINT := 10000;

  -- Recalculated totals
  v_subtotal_cents            BIGINT;
  v_discount_cents            BIGINT;
  v_total_cents               BIGINT;

  -- Return payload
  v_result                    JSONB;

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
  -- STEP 3: LOCK THE REVISION DRAFT INVOICE FOR UPDATE
  --
  -- Acquire an exclusive row lock on the specific invoice before any
  -- validation or mutation.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_draft_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'No invoice row found for the supplied p_invoice_id.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: VALIDATE THE LOCKED INVOICE IS A REVISION DRAFT
  --
  -- A Revision Draft must satisfy ALL of:
  --   status                     = 'draft'
  --   invoice_type               = 'initial'
  --   revision_source_invoice_id IS NOT NULL
  --   replaces_invoice_id        IS NULL
  --
  -- Reject:
  --   - Normal initial Drafts (revision_source_invoice_id IS NULL)
  --   - Issued/open/paid/void invoices (status != 'draft')
  --   - Replacement invoices (replaces_invoice_id IS NOT NULL)
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.status                       IS DISTINCT FROM 'draft'
  OR v_invoice.invoice_type                 IS DISTINCT FROM 'initial'
  OR v_invoice.revision_source_invoice_id   IS NULL
  OR v_invoice.replaces_invoice_id          IS NOT NULL
  THEN
    RAISE EXCEPTION 'revision_draft_not_eligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The invoice does not qualify as a Revision Draft. '
                      'A Revision Draft must have status=draft, invoice_type=initial, '
                      'revision_source_invoice_id IS NOT NULL, and replaces_invoice_id IS NULL.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: LOCK AND VALIDATE THE SOURCE INVOICE
  --
  -- Load the source invoice identified by revision_source_invoice_id.
  -- Acquire FOR UPDATE to prevent concurrent status changes on the source.
  --
  -- The source must:
  --   - exist
  --   - belong to the same application_id
  --   - have invoice_type = 'initial'
  --   - have status = 'open'
  --   - have invoice_number IS NOT NULL
  --
  -- The DB integrity trigger already protects same Deal/type, but we
  -- revalidate defensively inside this business workflow.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_source_invoice
  FROM public.crm_invoices
  WHERE id = v_invoice.revision_source_invoice_id
  FOR UPDATE;

  IF NOT FOUND
  OR v_source_invoice.application_id IS DISTINCT FROM v_invoice.application_id
  OR v_source_invoice.invoice_type   IS DISTINCT FROM 'initial'
  OR v_source_invoice.status         IS DISTINCT FROM 'open'
  OR v_source_invoice.invoice_number IS NULL
  THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The revision source invoice does not meet eligibility requirements. '
                      'The source must exist, belong to the same Deal, have invoice_type=initial, '
                      'status=open, and a non-null invoice_number.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: CHECK SOURCE INVOICE FOR BLOCKING PAYMENTS
  --
  -- While holding the source invoice lock, check crm_payments for rows
  -- where invoice_id = revision_source_invoice_id AND status IN
  -- ('pending', 'received', 'refunded').
  --
  -- There must be ZERO such rows.
  -- Rows with status = 'failed' do NOT block refresh.
  -- Do not modify payment rows.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COUNT(*)
  INTO v_blocking_payment_count
  FROM public.crm_payments
  WHERE invoice_id = v_invoice.revision_source_invoice_id
    AND status IN ('pending', 'received', 'refunded');

  IF v_blocking_payment_count > 0 THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The revision source invoice has one or more blocking payments '
                      '(pending, received, or refunded). Refresh is not permitted while '
                      'blocking payments exist on the source invoice.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: LOAD AND LOCK AUTHORITATIVE DEAL FACTS
  --
  -- Load current authoritative data from borrower_applications and
  -- crm_deal_option_cycles using the Revision Draft's application_id.
  --
  -- Use FOR SHARE to prevent concurrent modification of authoritative facts
  -- while we are refreshing the Revision Draft.
  --
  -- Do NOT use borrower_applications.deposit_amount.
  -- Do NOT snapshot credit_card_payment_enabled during refresh.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    ba.emd_funded_cents,
    ba.funded_date
  INTO v_app
  FROM public.borrower_applications ba
  WHERE ba.id = v_invoice.application_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'borrower_applications row for this Deal could not be found.';
  END IF;

  SELECT
    doc.deposit_goes_hard_date
  INTO v_cycle1
  FROM public.crm_deal_option_cycles doc
  WHERE doc.application_id = v_invoice.application_id
    AND doc.cycle_number   = 1
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 option cycle row for this Deal could not be found.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: VALIDATE AUTHORITATIVE DEAL FACTS
  --
  -- Require all three authoritative facts to be present and logically valid.
  -- Use stable safe token: revision_refresh_source_invalid
  -- Do not put raw row contents into the exception message.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_app.emd_funded_cents IS NULL OR v_app.emd_funded_cents <= 0 THEN
    RAISE EXCEPTION 'revision_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'emd_funded_cents must be present and greater than zero.';
  END IF;

  IF v_app.funded_date IS NULL THEN
    RAISE EXCEPTION 'revision_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'funded_date is missing on the borrower application.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date IS NULL THEN
    RAISE EXCEPTION 'revision_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 deposit_goes_hard_date is missing.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date <= v_app.funded_date THEN
    RAISE EXCEPTION 'revision_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'deposit_goes_hard_date must be after funded_date.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: CALCULATE CANONICAL VALUES IN DATABASE
  --
  -- v_billable_days: PostgreSQL DATE subtraction
  -- v_canonical_deal_fee_cents: via public.calculate_deal_fee_cents()
  --   — do NOT duplicate the fee formula manually.
  --
  -- Expected constants:
  --   Administrative Fee: 250000 cents ($2,500.00)
  --   Daily rate audit:   10000 cents per $100k
  -- ══════════════════════════════════════════════════════════════════════════

  v_billable_days := (v_cycle1.deposit_goes_hard_date - v_app.funded_date);

  v_canonical_deal_fee_cents := public.calculate_deal_fee_cents(
    v_app.emd_funded_cents,
    v_app.funded_date,
    v_cycle1.deposit_goes_hard_date
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: VALIDATE REVISION DRAFT LINE-ITEM STRUCTURE
  --
  -- Before changing anything, validate the Revision Draft line-item
  -- composition.
  --
  -- Require:
  --   exactly 1 admin_fee line
  --   exactly 1 deal_fee line
  --   zero or more discount lines
  --
  -- Reject any other line_type:
  --   other, extension_admin_fee, extension_deal_fee, or any unknown type
  --
  -- NOTE: Plain SELECT (no FOR SHARE) is safe here because the parent
  -- invoice FOR UPDATE lock acquired in STEP 3 serializes all concurrent
  -- line-item mutations via the protect_issued_invoice_line_items() trigger
  -- which acquires FOR SHARE on the parent invoice row.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    COUNT(*) FILTER (WHERE li.line_type = 'admin_fee'),
    COUNT(*) FILTER (WHERE li.line_type = 'deal_fee'),
    COUNT(*) FILTER (WHERE li.line_type NOT IN ('admin_fee', 'deal_fee', 'discount'))
  INTO
    v_admin_fee_count,
    v_deal_fee_count,
    v_invalid_type_count
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_invoice_id;

  -- Reject any line type outside the permitted set
  IF v_invalid_type_count > 0 THEN
    RAISE EXCEPTION 'revision_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft invoice contains line type(s) not permitted for refresh. '
                      'Only admin_fee, deal_fee, and discount lines are allowed.';
  END IF;

  -- Require exactly 1 admin_fee line
  IF v_admin_fee_count != 1 THEN
    RAISE EXCEPTION 'revision_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft invoice must have exactly 1 admin_fee line item.';
  END IF;

  -- Require exactly 1 deal_fee line
  IF v_deal_fee_count != 1 THEN
    RAISE EXCEPTION 'revision_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft invoice must have exactly 1 deal_fee line item.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: VALIDATE ADMIN FEE LINE IS UNCHANGED
  --
  -- The base Administrative Fee must remain at $2,500.00 (250000 cents).
  -- Do NOT silently rewrite the admin_fee line.
  -- Waivers or reductions remain separate discount lines.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    li.quantity,
    li.unit_amount_cents,
    li.line_amount_cents
  INTO v_admin_fee_line
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_invoice_id
    AND li.line_type  = 'admin_fee';

  IF v_admin_fee_line.quantity          IS DISTINCT FROM 1
  OR v_admin_fee_line.unit_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  OR v_admin_fee_line.line_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  THEN
    RAISE EXCEPTION 'revision_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Admin fee line does not match the expected base Administrative Fee '
                      '(quantity=1, $2,500.00). The Revision Draft line items are invalid.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: UPDATE ONLY THE EXISTING DEAL_FEE LINE IN PLACE
  --
  -- Do NOT delete and reinsert the deal_fee row.
  -- Update the EXISTING row so its row ID remains unchanged.
  --
  -- Set:
  --   quantity                       = 1
  --   unit_amount_cents              = canonical deal fee
  --   line_amount_cents              = canonical deal fee
  --   calc_emd_funded_cents          = current authoritative emd_funded_cents
  --   calc_daily_rate_per_100k_cents = 10000
  --   calc_billable_days             = calculated billable days
  --   calc_period_start_date         = current authoritative funded_date
  --   calc_period_end_date           = current Cycle 1 deposit_goes_hard_date
  --   updated_at                     = now()
  --
  -- Even if the deal fee dollar amount is numerically unchanged, ALL calc
  -- audit fields must still be refreshed to match the new authoritative dates.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoice_line_items
  SET
    quantity                       = 1,
    unit_amount_cents              = v_canonical_deal_fee_cents,
    line_amount_cents              = v_canonical_deal_fee_cents,
    calc_emd_funded_cents          = v_app.emd_funded_cents,
    calc_daily_rate_per_100k_cents = v_expected_daily_rate_cents,
    calc_billable_days             = v_billable_days,
    calc_period_start_date         = v_app.funded_date,
    calc_period_end_date           = v_cycle1.deposit_goes_hard_date,
    updated_at                     = now()
  WHERE invoice_id = p_invoice_id
    AND line_type  = 'deal_fee';

  -- Guard: the deal_fee row must have been updated
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'deal_fee line item could not be updated. '
                      'The line item may have been removed concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: DISCOUNT ROWS ARE PRESERVED
  --
  -- Discount lines (including Admin Fee Waiver and all other discount/waiver
  -- rows) are NOT touched by this RPC. Their row IDs, descriptions, and all
  -- other fields remain exactly as they were.
  --
  -- This is enforced by the UPDATE in STEP 12 targeting only
  -- line_type = 'deal_fee'. No DELETE or INSERT on discount rows occurs
  -- anywhere in this function.
  -- ══════════════════════════════════════════════════════════════════════════


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: RECALCULATE TOTALS FROM THE FINAL LINE ITEMS
  --
  -- Calculate totals AFTER updating the deal_fee line so the totals reflect
  -- the refreshed deal_fee amount.
  --
  -- subtotal_cents: sum of line_amount_cents for all NON-discount lines
  -- discount_cents: absolute total of discount line amounts
  -- tax_cents:      0
  -- total_cents:    subtotal_cents - discount_cents
  --
  -- Require: discount_cents <= subtotal_cents
  -- Require: total_cents >= 0
  -- Do not silently clamp a negative total.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    COALESCE(SUM(li.line_amount_cents) FILTER (WHERE li.line_type != 'discount'), 0),
    COALESCE(ABS(SUM(li.line_amount_cents) FILTER (WHERE li.line_type = 'discount')), 0)
  INTO
    v_subtotal_cents,
    v_discount_cents
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_invoice_id;

  -- Discount must not exceed subtotal
  IF v_discount_cents > v_subtotal_cents THEN
    RAISE EXCEPTION 'revision_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Total discount exceeds subtotal; invoice total would be negative. '
                      'Review discount lines before refreshing.';
  END IF;

  v_total_cents := v_subtotal_cents - v_discount_cents;

  -- Require non-negative total (belt-and-suspenders after the check above)
  IF v_total_cents < 0 THEN
    RAISE EXCEPTION 'revision_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Calculated total_cents is negative. Review discount lines before refreshing.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 15: UPDATE ONLY THE FINANCIAL SNAPSHOT FIELDS ON crm_invoices
  --
  -- Update ONLY:
  --   emd_funded_cents    — current authoritative emd_funded_cents
  --   funding_date        — current authoritative funded_date
  --   period_start_date   — current authoritative funded_date
  --   period_end_date     — current Cycle 1 deposit_goes_hard_date
  --   billable_days       — v_billable_days
  --   subtotal_cents      — recalculated subtotal
  --   discount_cents      — recalculated discounts
  --   tax_cents           — 0
  --   total_cents         — recalculated total
  --   updated_at          — now()
  --
  -- Do NOT modify:
  --   revision_source_invoice_id
  --   replaces_invoice_id
  --   invoice_number
  --   status
  --   due_date
  --   billing_name, billing_contact_name, billing_email
  --   billing_address_line1/2, billing_city, billing_state
  --   billing_postal_code, billing_country
  --   invoice_notes, internal_notes
  --   wire_instructions_snapshot
  --   credit_card_payment_enabled_snapshot
  --   issued_at, issuing_started_at
  --   pdf_storage_path, pdf_generated_at, pdf_hash, pdf_generation_status
  --   created_by
  --
  -- The final UPDATE must fail closed and require:
  --   id                           = p_invoice_id
  --   status                       = 'draft'
  --   invoice_type                 = 'initial'
  --   revision_source_invoice_id   IS NOT NULL
  --   replaces_invoice_id          IS NULL
  --
  -- The existing DB triggers (protect_issued_invoice_fields,
  -- protect_issued_invoice_line_items, validate_invoice_status_transition)
  -- remain fully in place and are NOT weakened or bypassed.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    emd_funded_cents  = v_app.emd_funded_cents,
    funding_date      = v_app.funded_date,
    period_start_date = v_app.funded_date,
    period_end_date   = v_cycle1.deposit_goes_hard_date,
    billable_days     = v_billable_days,
    subtotal_cents    = v_subtotal_cents,
    discount_cents    = v_discount_cents,
    tax_cents         = 0,
    total_cents       = v_total_cents,
    updated_at        = now()
  WHERE id                           = p_invoice_id
    AND status                       = 'draft'
    AND invoice_type                 = 'initial'
    AND revision_source_invoice_id   IS NOT NULL
    AND replaces_invoice_id          IS NULL;

  -- Guard: the invoice row must have been updated.
  -- If status changed between the re-check and this UPDATE, or if the
  -- invoice no longer satisfies the Revision Draft criteria, the WHERE
  -- clause will not match — fail closed.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_draft_not_eligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The Revision Draft invoice could not be updated. '
                      'It may have changed state concurrently or no longer satisfies '
                      'Revision Draft criteria.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 16: BUILD SAFE RETURN PAYLOAD
  --
  -- Return only safe financial snapshot fields.
  -- Do NOT return:
  --   wire instructions
  --   routing/account numbers
  --   PDF storage path
  --   PDF hash
  --   internal notes
  --   sensitive settings
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'status',                     'refreshed',
    'invoice_id',                 p_invoice_id,
    'revision_source_invoice_id', v_invoice.revision_source_invoice_id,
    'application_id',             v_invoice.application_id,
    'emd_funded_cents',           v_app.emd_funded_cents,
    'funding_date',               v_app.funded_date,
    'period_start_date',          v_app.funded_date,
    'period_end_date',            v_cycle1.deposit_goes_hard_date,
    'billable_days',              v_billable_days,
    'subtotal_cents',             v_subtotal_cents,
    'discount_cents',             v_discount_cents,
    'tax_cents',                  0,
    'total_cents',                v_total_cents
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 2: GRANT / REVOKE EXECUTE ON refresh_revision_draft_invoice_snapshot
--
-- CREATE OR REPLACE resets privileges; apply grants explicitly.
-- The browser must never call this RPC directly.
-- Only the trusted server-side API (using service_role) may call it.
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.refresh_revision_draft_invoice_snapshot(UUID, UUID)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders: anon is a named role in Supabase)
REVOKE EXECUTE ON FUNCTION public.refresh_revision_draft_invoice_snapshot(UUID, UUID)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders: authenticated is a named role)
REVOKE EXECUTE ON FUNCTION public.refresh_revision_draft_invoice_snapshot(UUID, UUID)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.refresh_revision_draft_invoice_snapshot(UUID, UUID)
  TO service_role;
