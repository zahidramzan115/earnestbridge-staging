-- ============================================================
-- Migration: 20260926030000_begin_revision_invoice_issuance_rpc
--
-- Step 6A-5R4A — Begin Revision Invoice Issuance RPC
--
-- PURPOSE
-- -------
-- Creates the atomic database RPC that begins the issuance of a
-- Revision Draft invoice, transitioning it from 'draft' to 'issuing'.
--
-- This is the revision-specific counterpart to:
--   public.begin_invoice_issuance()
--
-- It intentionally differs from begin_invoice_issuance() only where
-- the revision lifecycle requires it:
--   - Locks Revision Draft FIRST, then source invoice SECOND
--   - Validates source invoice is still OPEN with no blocking payments
--   - Derives invoice number from source (base → -B, -B → -C, etc.)
--     instead of consuming the global crm_invoice_number_seq
--   - Does NOT set replaces_invoice_id (remains NULL until completion)
--   - revision_source_invoice_id is preserved permanently
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
-- WHAT THIS RPC DOES
-- ------------------
--   1.  Requires non-null p_admin_user_id
--   2.  Verifies Admin identity via raw_app_meta_data (server-controlled)
--   3.  Locks the Revision Draft invoice FOR UPDATE by p_invoice_id
--   4.  Validates the locked invoice is a Revision Draft (all five criteria)
--   5.  Locks the source invoice FOR UPDATE (consistent lock order: draft first)
--   6.  Validates source invoice is still eligible (open, numbered, issued, PDF generated)
--   7.  Checks source invoice has no blocking payments (pending/received/refunded)
--   8.  Loads and locks current authoritative Deal facts FOR SHARE
--   9.  Validates authoritative facts (emd > 0, funded_date, hard_date > funded_date)
--  10.  Validates Revision Draft snapshot matches current authoritative facts
--  11.  Calculates canonical deal fee via public.calculate_deal_fee_cents()
--  12.  Validates line-item composition (exactly 1 admin_fee, 1 deal_fee, 0+ discount)
--  13.  Validates admin_fee line amounts ($2,500.00)
--  14.  Validates deal_fee line amount and all audit fields
--  15.  Recalculates final totals from DB line items
--  16.  Validates billing_email is present
--  17.  Loads and locks crm_invoice_settings FOR SHARE; validates required fields
--  18.  Builds wire_instructions_snapshot (same structure as normal issuance)
--  19.  Captures v_now; derives America/New_York business date
--  20.  Resolves due_date (preserves Admin override; otherwise uses issuance date)
--  21.  Validates Revision Draft has no stale PDF artifact metadata
--  22.  Derives revision invoice number from source invoice number
--        (base EB-YYYY-NNNNNN → EB-YYYY-NNNNNN-B)
--        (existing -B → -C, ..., -Y → -Z; -Z → revision_suffix_exhausted)
--  23.  Atomically transitions Revision Draft → issuing with all snapshot fields
--  24.  Returns safe payload (no wire/billing/notes/PDF data)
--
-- WHAT THIS RPC DOES NOT DO
-- -------------------------
--   - Does NOT modify the source invoice in any way
--   - Does NOT set replaces_invoice_id (remains NULL until completion)
--   - Does NOT consume the global crm_invoice_number_seq
--   - Does NOT generate a PDF
--   - Does NOT transition issuing → open
--   - Does NOT set issued_at (remains NULL)
--   - Does NOT send an invoice email
--   - Does NOT create an application_activity event
--   - Does NOT modify payment rows
--   - Does NOT call complete_revision_invoice_issuance (does not exist yet)
--
-- LOCK ORDER
-- ----------
-- Consistent lock order to prevent deadlocks:
--   1. Revision Draft (p_invoice_id) — FOR UPDATE
--   2. Source invoice (revision_source_invoice_id) — FOR UPDATE
--
-- INVOICE NUMBER DERIVATION
-- -------------------------
-- Source format A (base):
--   ^EB-[0-9]{4}-[0-9]{6}$
--   Example: EB-2026-000001 → EB-2026-000001-B
--
-- Source format B (existing revision):
--   ^EB-[0-9]{4}-[0-9]{6}-[B-Z]$
--   Example: EB-2026-000001-B → EB-2026-000001-C
--            EB-2026-000001-Y → EB-2026-000001-Z
--            EB-2026-000001-Z → revision_suffix_exhausted
--
-- The original root year is ALWAYS preserved from the source invoice number.
-- Do NOT derive a new year from v_now.
-- Do NOT consume crm_invoice_number_seq.
--
-- ATOMICITY
-- ---------
-- The final UPDATE succeeds or rolls back entirely.
-- No partial transition is possible.
-- The final UPDATE WHERE clause requires:
--   id = p_invoice_id
--   status = 'draft'
--   invoice_type = 'initial'
--   revision_source_invoice_id = locked source.id
--   replaces_invoice_id IS NULL
--   invoice_number IS NULL
--
-- POST-BEGIN STATE
-- ----------------
-- Source invoice:
--   status = 'open'           (UNCHANGED)
--   invoice_number unchanged  (UNCHANGED)
--   PDF unchanged             (UNCHANGED)
--
-- Revision Draft (now Revision Issuing):
--   status = 'issuing'
--   invoice_number = EB-...-B (or -C, etc.)
--   replaces_invoice_id = NULL  (remains NULL until completion)
--   revision_source_invoice_id = source.id  (preserved permanently)
--   pdf_generation_status = 'pending'
--
-- PDF FAILURE SEMANTICS
-- ---------------------
-- If PDF generation later fails:
--   - Revision remains 'issuing' with the SAME assigned invoice number
--   - Retry must reuse that same number/path
--   - Source invoice remains OPEN
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
-- begin_invoice_issuance()                       — NOT modified
-- refresh_initial_draft_invoice_snapshot()       — NOT modified
-- refresh_revision_draft_invoice_snapshot()      — NOT modified
-- create_revision_draft_invoice()                — NOT modified
-- complete_invoice_issuance()                    — NOT modified
-- mark_invoice_pdf_failed()                      — NOT modified
-- calculate_deal_fee_cents()                     — NOT modified
-- protect_issued_invoice_line_items()            — NOT modified
-- protect_issued_invoice_fields()                — NOT modified
-- validate_invoice_status_transition()           — NOT modified
-- validate_invoice_revision_source_integrity()   — NOT modified
-- validate_invoice_replacement_integrity()       — NOT modified
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call begin_revision_invoice_issuance on any real invoice
--   - modify EB-2026-000001 or any other invoice row
--   - consume any invoice number from crm_invoice_number_seq
--   - assign EB-2026-000001-B to the production Revision Draft
--   - transition the production Revision Draft to issuing
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
-- SECTION 1: begin_revision_invoice_issuance RPC
--
-- Signature:
--   public.begin_revision_invoice_issuance(
--     p_invoice_id    uuid,
--     p_admin_user_id uuid
--   )
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Returns a safe JSONB payload (no wire/billing/notes/PDF data).
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized          — p_admin_user_id is NULL or not an authorized Admin
--   revision_invoice_not_found    — no invoice row found for p_invoice_id
--   revision_invoice_not_draft    — invoice is not a valid Revision Draft
--   revision_source_ineligible    — source invoice is not open/numbered/issued/PDF-generated,
--                                   or has blocking payments (pending/received/refunded)
--   revision_draft_stale          — Revision Draft snapshot does not match current
--                                   authoritative Deal facts, or source data is invalid
--   revision_settings_incomplete  — crm_invoice_settings missing or incomplete
--   revision_billing_incomplete   — billing_email missing or empty
--   revision_line_items_invalid   — line composition or amounts wrong, or totals invalid
--   revision_source_number_invalid — source invoice_number does not match supported format
--   revision_suffix_exhausted     — source invoice number already has suffix -Z
-- ============================================================

CREATE OR REPLACE FUNCTION public.begin_revision_invoice_issuance(
  p_invoice_id    UUID,
  p_admin_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  -- Admin verification
  v_admin_role              TEXT;

  -- Revision Draft invoice row (locked FOR UPDATE first)
  v_invoice                 public.crm_invoices%ROWTYPE;

  -- Source invoice row (locked FOR UPDATE second)
  v_source                  public.crm_invoices%ROWTYPE;

  -- Blocking payment count on source invoice
  v_blocking_payment_count  INTEGER;

  -- Authoritative Deal facts
  v_app                     RECORD;   -- borrower_applications row
  v_cycle1                  RECORD;   -- crm_deal_option_cycles cycle 1 row

  -- Invoice settings
  v_settings                public.crm_invoice_settings%ROWTYPE;

  -- Canonical deal fee
  v_canonical_deal_fee_cents BIGINT;

  -- Line item validation
  v_admin_fee_count         INTEGER;
  v_deal_fee_count          INTEGER;
  v_invalid_type_count      INTEGER;
  v_admin_fee_line          RECORD;
  v_deal_fee_line           RECORD;

  -- Expected constants (same as begin_invoice_issuance)
  v_expected_admin_fee_cents  CONSTANT BIGINT := 250000;
  v_expected_daily_rate_cents CONSTANT BIGINT := 10000;

  -- Recalculated totals
  v_subtotal_cents          BIGINT;
  v_discount_cents          BIGINT;
  v_total_cents             BIGINT;

  -- Timestamps and dates
  v_now                     TIMESTAMPTZ;
  v_invoice_date            DATE;

  -- Revision invoice number derivation
  v_source_number           TEXT;
  v_invoice_number          TEXT;
  v_suffix_char             TEXT;
  v_next_suffix             TEXT;
  v_root                    TEXT;

  -- Due date
  v_due_date                DATE;

  -- Wire snapshot
  v_wire_snapshot           JSONB;

  -- Return payload
  v_result                  JSONB;

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
  -- STEP 3: LOCK REVISION DRAFT FIRST (FOR UPDATE)
  --
  -- Acquire an exclusive row lock on the Revision Draft before any validation.
  -- Lock order: Revision Draft first, source invoice second.
  -- This consistent ordering prevents deadlocks with concurrent operations.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft invoice does not exist.';
  END IF;

  -- Validate ALL five Revision Draft criteria:
  --   status = 'draft'
  --   invoice_type = 'initial'
  --   revision_source_invoice_id IS NOT NULL
  --   replaces_invoice_id IS NULL
  --   invoice_number IS NULL
  --
  -- This RPC must reject a normal Initial Draft (revision_source_invoice_id IS NULL).
  IF v_invoice.status != 'draft'
  OR v_invoice.invoice_type != 'initial'
  OR v_invoice.revision_source_invoice_id IS NULL
  OR v_invoice.replaces_invoice_id IS NOT NULL
  OR v_invoice.invoice_number IS NOT NULL
  THEN
    RAISE EXCEPTION 'revision_invoice_not_draft'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice is not a valid Revision Draft. '
                      'A Revision Draft must have: status=draft, invoice_type=initial, '
                      'revision_source_invoice_id IS NOT NULL, replaces_invoice_id IS NULL, '
                      'invoice_number IS NULL.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: LOCK SOURCE INVOICE SECOND (FOR UPDATE)
  --
  -- Consistent lock order: Revision Draft first (STEP 3), source second (here).
  -- This prevents deadlocks with concurrent operations that may also lock
  -- the source invoice.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_source
  FROM public.crm_invoices
  WHERE id = v_invoice.revision_source_invoice_id
  FOR UPDATE;

  -- Validate source invoice eligibility:
  --   id = revision_source_invoice_id
  --   application_id = revision.application_id
  --   invoice_type = 'initial'
  --   status = 'open'
  --   invoice_number IS NOT NULL
  --   issued_at IS NOT NULL
  --   pdf_generation_status = 'generated'
  IF NOT FOUND
  OR v_source.application_id != v_invoice.application_id
  OR v_source.invoice_type != 'initial'
  OR v_source.status != 'open'
  OR v_source.invoice_number IS NULL
  OR v_source.issued_at IS NULL
  OR v_source.pdf_generation_status != 'generated'
  THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice is not eligible for revision issuance. '
                      'Source must be: status=open, invoice_type=initial, '
                      'invoice_number IS NOT NULL, issued_at IS NOT NULL, '
                      'pdf_generation_status=generated, same application_id.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: SOURCE PAYMENT ELIGIBILITY CHECK
  --
  -- While holding the source invoice lock, check for blocking payments.
  -- Blocking statuses: pending, received, refunded
  -- Non-blocking status: failed (does NOT block revision issuance)
  --
  -- Do NOT modify payment rows.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COUNT(*)
  INTO v_blocking_payment_count
  FROM public.crm_payments
  WHERE invoice_id = v_source.id
    AND status IN ('pending', 'received', 'refunded');

  IF v_blocking_payment_count > 0 THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice has blocking payments (pending, received, or refunded). '
                      'Revision issuance cannot proceed while the source invoice has active payments.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: LOAD CURRENT AUTHORITATIVE DEAL FACTS
  --
  -- Mirror the current normal begin_invoice_issuance() logic exactly.
  -- Lock borrower_applications and cycle 1 with FOR SHARE so these source
  -- facts cannot change mid-issuance.
  --
  -- Do NOT use borrower_applications.deposit_amount.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    ba.emd_funded_cents,
    ba.funded_date,
    ba.credit_card_payment_enabled
  INTO v_app
  FROM public.borrower_applications ba
  WHERE ba.id = v_invoice.application_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'borrower_applications row for this invoice could not be found.';
  END IF;

  SELECT
    doc.deposit_goes_hard_date
  INTO v_cycle1
  FROM public.crm_deal_option_cycles doc
  WHERE doc.application_id = v_invoice.application_id
    AND doc.cycle_number = 1
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 option cycle row for this invoice could not be found.';
  END IF;

  -- Validate required authoritative facts
  IF v_app.emd_funded_cents IS NULL OR v_app.emd_funded_cents <= 0 THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'emd_funded_cents must be greater than zero.';
  END IF;

  IF v_app.funded_date IS NULL THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'funded_date is missing on the deal.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date IS NULL THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 deposit_goes_hard_date is missing.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date <= v_app.funded_date THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 deposit_goes_hard_date must be after funded_date.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: STALE REVISION DRAFT CHECK
  --
  -- The Revision Draft snapshot must match CURRENT authoritative Deal facts.
  -- Compare the Revision Draft's financial snapshot to current authoritative
  -- values. If any mismatch, abort — do NOT automatically refresh.
  --
  -- The existing refresh_revision_draft_invoice_snapshot() is the dedicated
  -- refresh path.
  --
  -- Fields compared:
  --   emd_funded_cents   = current authoritative EMD
  --   funding_date       = current funded_date
  --   period_start_date  = current funded_date
  --   period_end_date    = current Cycle 1 hard date
  --   billable_days      = current date difference
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.emd_funded_cents IS DISTINCT FROM v_app.emd_funded_cents THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft snapshot emd_funded_cents does not match current deal value. Refresh the revision draft before issuing.';
  END IF;

  IF v_invoice.funding_date IS DISTINCT FROM v_app.funded_date THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft snapshot funding_date does not match current deal funded_date. Refresh the revision draft before issuing.';
  END IF;

  IF v_invoice.period_start_date IS DISTINCT FROM v_app.funded_date THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft snapshot period_start_date does not match current funded_date. Refresh the revision draft before issuing.';
  END IF;

  IF v_invoice.period_end_date IS DISTINCT FROM v_cycle1.deposit_goes_hard_date THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft snapshot period_end_date does not match current cycle 1 deposit_goes_hard_date. Refresh the revision draft before issuing.';
  END IF;

  IF v_invoice.billable_days IS DISTINCT FROM
     (v_cycle1.deposit_goes_hard_date - v_app.funded_date) THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft snapshot billable_days does not match current (deposit_goes_hard_date - funded_date). Refresh the revision draft before issuing.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: CALCULATE CANONICAL DEAL FEE
  --
  -- Use ONLY public.calculate_deal_fee_cents() with current authoritative facts.
  -- Do NOT duplicate the fee formula manually.
  -- Expected daily rate audit value: 10000 cents ($100 per $100k per day).
  -- ══════════════════════════════════════════════════════════════════════════

  v_canonical_deal_fee_cents := public.calculate_deal_fee_cents(
    v_app.emd_funded_cents,
    v_app.funded_date,
    v_cycle1.deposit_goes_hard_date
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: VALIDATE LINE ITEM COMPOSITION
  --
  -- Mirror the current normal begin_invoice_issuance() line-item validation.
  --
  -- Permitted line types for a Revision Draft:
  --   admin_fee   (exactly 1 required)
  --   deal_fee    (exactly 1 required)
  --   discount    (0 or more)
  --
  -- Rejected types: other, extension_admin_fee, extension_deal_fee, unknown
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
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft contains line type(s) not permitted for issuance. Only admin_fee, deal_fee, and discount lines are allowed.';
  END IF;

  -- Require exactly 1 admin_fee line
  IF v_admin_fee_count != 1 THEN
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft must have exactly 1 admin_fee line item.';
  END IF;

  -- Require exactly 1 deal_fee line
  IF v_deal_fee_count != 1 THEN
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft must have exactly 1 deal_fee line item.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: VALIDATE ADMIN FEE LINE
  --
  -- Admin fee must be exactly:
  --   quantity = 1
  --   unit_amount_cents = 250000
  --   line_amount_cents = 250000
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    li.quantity,
    li.unit_amount_cents,
    li.line_amount_cents
  INTO v_admin_fee_line
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_invoice_id
    AND li.line_type = 'admin_fee';

  IF v_admin_fee_line.quantity IS DISTINCT FROM 1
  OR v_admin_fee_line.unit_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  OR v_admin_fee_line.line_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  THEN
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Admin fee line does not match the expected base Administrative Fee (quantity=1, $2,500.00). The revision draft is invalid and must be corrected before issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: VALIDATE DEAL FEE LINE
  --
  -- Mirror the current normal begin_invoice_issuance() deal fee validation.
  --
  -- Validates:
  --   quantity = 1
  --   line_amount_cents = canonical current Deal Fee
  --   unit_amount_cents = line_amount_cents (quantity=1 invariant)
  --   calc_emd_funded_cents matches current authoritative emd_funded_cents
  --   calc_daily_rate_per_100k_cents = 10000
  --   calc_billable_days matches current (hard_date - funded_date)
  --   calc_period_start_date matches current funded_date
  --   calc_period_end_date matches current deposit_goes_hard_date
  --
  -- Stale deal fee audit fields → revision_draft_stale (consistent with
  -- normal issuance architecture where stale calc fields raise invoice_draft_stale).
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    li.quantity,
    li.unit_amount_cents,
    li.line_amount_cents,
    li.calc_emd_funded_cents,
    li.calc_daily_rate_per_100k_cents,
    li.calc_billable_days,
    li.calc_period_start_date,
    li.calc_period_end_date
  INTO v_deal_fee_line
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_invoice_id
    AND li.line_type = 'deal_fee';

  -- Require quantity = 1
  IF v_deal_fee_line.quantity IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line quantity must be 1. The revision draft is invalid and must be corrected before issuance.';
  END IF;

  -- Validate deal_fee line amount matches canonical calculation
  IF v_deal_fee_line.line_amount_cents IS DISTINCT FROM v_canonical_deal_fee_cents THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line amount does not match the canonical deal fee calculation. The revision draft is stale and must be refreshed before issuance.';
  END IF;

  -- Validate unit_amount_cents is consistent with line_amount_cents (quantity=1)
  IF v_deal_fee_line.unit_amount_cents IS DISTINCT FROM v_deal_fee_line.line_amount_cents THEN
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line unit_amount_cents does not equal line_amount_cents (expected for quantity=1). The revision draft is invalid and must be corrected before issuance.';
  END IF;

  -- Validate daily rate audit field
  IF v_deal_fee_line.calc_daily_rate_per_100k_cents IS DISTINCT FROM v_expected_daily_rate_cents THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line calc_daily_rate_per_100k_cents does not match the current business rate. The revision draft is stale and must be refreshed before issuance.';
  END IF;

  -- Validate calculation audit fields are consistent with current authoritative source data
  IF v_deal_fee_line.calc_emd_funded_cents IS DISTINCT FROM v_app.emd_funded_cents
  OR v_deal_fee_line.calc_billable_days IS DISTINCT FROM
     (v_cycle1.deposit_goes_hard_date - v_app.funded_date)
  OR v_deal_fee_line.calc_period_start_date IS DISTINCT FROM v_app.funded_date
  OR v_deal_fee_line.calc_period_end_date IS DISTINCT FROM v_cycle1.deposit_goes_hard_date
  THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line calculation audit fields are inconsistent with current authoritative source data. The revision draft is stale and must be refreshed before issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: RECALCULATE FINAL TOTALS FROM DATABASE LINE ITEMS
  --
  -- As with normal issuance, recalculate from actual DB rows.
  -- Never trust browser totals.
  -- The parent invoice FOR UPDATE lock guarantees the line-item set is stable.
  --
  -- subtotal_cents = sum of non-discount lines
  -- discount_cents = absolute total of discount lines
  -- tax_cents      = 0
  -- total_cents    = subtotal_cents - discount_cents
  --
  -- Require: discount_cents <= subtotal_cents
  --          total_cents >= 0
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    COALESCE(SUM(li.line_amount_cents) FILTER (WHERE li.line_type != 'discount'), 0),
    COALESCE(ABS(SUM(li.line_amount_cents) FILTER (WHERE li.line_type = 'discount')), 0)
  INTO
    v_subtotal_cents,
    v_discount_cents
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = p_invoice_id;

  -- discount_cents must not exceed subtotal_cents
  IF v_discount_cents > v_subtotal_cents THEN
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Total discount exceeds subtotal; revision invoice total would be negative.';
  END IF;

  v_total_cents := v_subtotal_cents - v_discount_cents;

  -- Sanity check: total must be >= 0
  IF v_total_cents < 0 THEN
    RAISE EXCEPTION 'revision_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Computed total_cents is negative.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: VALIDATE BILLING REQUIREMENTS
  --
  -- Mirror the current begin_invoice_issuance() billing validation exactly.
  -- Require a non-empty billing_email at minimum.
  --
  -- Do NOT replace the Revision Draft billing snapshot from CRM.
  -- The Admin may have edited the billing snapshot specifically for the revision.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.billing_email IS NULL OR trim(v_invoice.billing_email) = '' THEN
    RAISE EXCEPTION 'revision_billing_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'A billing email address is required before revision issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: VALIDATE AND LOCK INVOICE SETTINGS
  --
  -- Load and lock crm_invoice_settings exactly as the current normal
  -- begin_invoice_issuance() does.
  -- Validate the exact same required settings fields.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_settings
  FROM public.crm_invoice_settings
  WHERE id = 1
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_settings_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice settings have not been configured. All required fields must be set before revision issuance.';
  END IF;

  -- Validate all five required fields are non-empty (same as normal issuance)
  IF v_settings.issuer_legal_name IS NULL OR trim(v_settings.issuer_legal_name) = ''
  OR v_settings.wire_bank_name IS NULL OR trim(v_settings.wire_bank_name) = ''
  OR v_settings.wire_account_name IS NULL OR trim(v_settings.wire_account_name) = ''
  OR v_settings.wire_routing_number IS NULL OR trim(v_settings.wire_routing_number) = ''
  OR v_settings.wire_account_number IS NULL OR trim(v_settings.wire_account_number) = ''
  THEN
    RAISE EXCEPTION 'revision_settings_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice settings are incomplete. issuer_legal_name, wire_bank_name, wire_account_name, wire_routing_number, and wire_account_number must all be configured before revision issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 15: CAPTURE TIMESTAMP AND DERIVE BUSINESS DATE
  --
  -- Use ONE v_now for this transaction, consistent with the existing normal
  -- issuance RPC.
  -- Use America/New_York for business-date calculations.
  -- ══════════════════════════════════════════════════════════════════════════

  v_now          := now();
  v_invoice_date := timezone('America/New_York', v_now)::DATE;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 16: RESOLVE DUE DATE
  --
  -- Preserve the existing normal issuance behavior:
  --   If Revision Draft due_date IS NOT NULL: preserve the Admin override.
  --   Otherwise: due_date = current issuance business date (Due Upon Receipt).
  --
  -- Do NOT copy the source invoice due date.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.due_date IS NOT NULL THEN
    v_due_date := v_invoice.due_date;
  ELSE
    v_due_date := v_invoice_date;
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 17: FAIL CLOSED ON STALE REVISION DRAFT PDF METADATA
  --
  -- A Revision Draft must never already have an immutable PDF artifact.
  -- If any of pdf_storage_path, pdf_generated_at, or pdf_hash are non-NULL,
  -- abort before assigning the invoice number.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.pdf_storage_path IS NOT NULL
  OR v_invoice.pdf_generated_at IS NOT NULL
  OR v_invoice.pdf_hash IS NOT NULL
  THEN
    RAISE EXCEPTION 'revision_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision Draft contains unexpected PDF artifact metadata.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 18: DERIVE REVISION INVOICE NUMBER FROM SOURCE
  --
  -- THIS IS THE KEY REVISION-SPECIFIC DIFFERENCE.
  -- Do NOT call nextval('crm_invoice_number_seq').
  -- Do NOT consume the global invoice number sequence.
  --
  -- Supported source formats:
  --
  -- A. Original/base source:
  --      ^EB-[0-9]{4}-[0-9]{6}$
  --      Example: EB-2026-000001 → EB-2026-000001-B
  --
  -- B. Existing revision source:
  --      ^EB-[0-9]{4}-[0-9]{6}-[B-Z]$
  --      Example: EB-2026-000001-B → EB-2026-000001-C
  --               EB-2026-000001-Y → EB-2026-000001-Z
  --               EB-2026-000001-Z → revision_suffix_exhausted
  --
  -- The original root year is ALWAYS preserved from the source invoice number.
  -- Do NOT derive a new year from v_now.
  --
  -- Original unsuffixed invoice is implicitly Revision A.
  -- The first replacement is therefore -B.
  --
  -- We do NOT store revision_letter, revision_number, or root_invoice_id
  -- as separate columns. The invoice number itself is canonical.
  --
  -- The UNIQUE constraint on invoice_number is the final DB defense against
  -- unexpected collisions. If assignment encounters a uniqueness conflict,
  -- fail safely — do not consume the global sequence.
  -- ══════════════════════════════════════════════════════════════════════════

  v_source_number := v_source.invoice_number;

  -- Format A: base source EB-YYYY-NNNNNN
  IF v_source_number ~ '^EB-[0-9]{4}-[0-9]{6}$' THEN
    -- Root is the entire source number; append -B
    v_invoice_number := v_source_number || '-B';

  -- Format B: existing revision source EB-YYYY-NNNNNN-[B-Z]
  ELSIF v_source_number ~ '^EB-[0-9]{4}-[0-9]{6}-[B-Z]$' THEN
    -- Extract the root (everything before the last -X suffix)
    v_root       := substring(v_source_number FROM 1 FOR length(v_source_number) - 2);
    v_suffix_char := right(v_source_number, 1);

    -- Reject if suffix is already Z (no wrap to AA)
    IF v_suffix_char = 'Z' THEN
      RAISE EXCEPTION 'revision_suffix_exhausted'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Source invoice number already has suffix -Z. No further revision suffixes are available.';
    END IF;

    -- Increment suffix: B→C, C→D, ..., Y→Z
    -- chr(ascii(X) + 1) advances exactly one letter in ASCII order
    v_next_suffix    := chr(ascii(v_suffix_char) + 1);
    v_invoice_number := v_root || '-' || v_next_suffix;

  ELSE
    -- Source invoice number does not match either supported format
    RAISE EXCEPTION 'revision_source_number_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice number does not match a supported format. '
                      'Expected: EB-YYYY-NNNNNN or EB-YYYY-NNNNNN-[B-Z].';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 19: BUILD VERSIONED WIRE INSTRUCTIONS SNAPSHOT
  --
  -- Use the EXACT current normal issuance JSON structure.
  -- This snapshot contains sensitive banking data internally.
  -- Do NOT return this snapshot from the RPC.
  -- ══════════════════════════════════════════════════════════════════════════

  v_wire_snapshot := jsonb_build_object(
    'schema_version', 1,
    'issuer', jsonb_build_object(
      'legal_name',    v_settings.issuer_legal_name,
      'address_line1', v_settings.issuer_address_line1,
      'address_line2', v_settings.issuer_address_line2,
      'city',          v_settings.issuer_city,
      'state',         v_settings.issuer_state,
      'postal_code',   v_settings.issuer_postal_code,
      'country',       v_settings.issuer_country
    ),
    'wire', jsonb_build_object(
      'bank_name',          v_settings.wire_bank_name,
      'account_name',       v_settings.wire_account_name,
      'routing_number',     v_settings.wire_routing_number,
      'account_number',     v_settings.wire_account_number,
      'bank_address',       v_settings.wire_bank_address,
      'memo_instructions',  v_settings.wire_memo_instructions
    ),
    'invoice_text', jsonb_build_object(
      'tagline',     v_settings.invoice_tagline,
      'footer_text', v_settings.invoice_footer_text
    )
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 20: FINAL ATOMIC REVISION DRAFT → ISSUING TRANSITION
  --
  -- After ALL validation succeeds, update the Revision Draft atomically.
  --
  -- Fields set (same as normal issuance plus revision-specific fields):
  --   subtotal_cents
  --   discount_cents
  --   tax_cents = 0
  --   total_cents
  --   credit_card_payment_enabled_snapshot = current authoritative Deal value
  --     (NOT copied from source invoice snapshot)
  --   wire_instructions_snapshot = current settings snapshot
  --     (contains sensitive banking data — NOT returned from RPC)
  --   invoice_number = derived Revision number (e.g. EB-2026-000001-B)
  --   due_date = resolved Revision due date
  --   issuing_started_at = v_now
  --   issued_at = NULL  (set later when issuing → open after PDF success)
  --   pdf_storage_path = NULL  (explicitly cleared)
  --   pdf_generated_at = NULL  (explicitly cleared)
  --   pdf_hash = NULL          (explicitly cleared)
  --   pdf_generation_status = 'pending'
  --   pdf_generation_error = NULL
  --   status = 'issuing'
  --   updated_at = v_now
  --
  -- Fields intentionally NOT set:
  --   replaces_invoice_id — MUST remain NULL until successful revision
  --                         issuance COMPLETION (complete_revision_invoice_issuance)
  --   revision_source_invoice_id — preserved permanently for audit history
  --
  -- The final UPDATE WHERE clause requires ALL of:
  --   id = p_invoice_id
  --   status = 'draft'
  --   invoice_type = 'initial'
  --   revision_source_invoice_id = locked source.id
  --   replaces_invoice_id IS NULL
  --   invoice_number IS NULL
  --
  -- If update does not affect exactly the expected row, fail safely.
  -- Do not leave a partial transition.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    subtotal_cents                       = v_subtotal_cents,
    discount_cents                       = v_discount_cents,
    tax_cents                            = 0,
    total_cents                          = v_total_cents,
    credit_card_payment_enabled_snapshot = v_app.credit_card_payment_enabled,
    wire_instructions_snapshot           = v_wire_snapshot,
    invoice_number                       = v_invoice_number,
    due_date                             = v_due_date,
    issuing_started_at                   = v_now,
    issued_at                            = NULL,
    pdf_storage_path                     = NULL,
    pdf_generated_at                     = NULL,
    pdf_hash                             = NULL,
    pdf_generation_status                = 'pending',
    pdf_generation_error                 = NULL,
    status                               = 'issuing',
    updated_at                           = v_now
  WHERE id                               = p_invoice_id
    AND status                           = 'draft'
    AND invoice_type                     = 'initial'
    AND revision_source_invoice_id       = v_source.id
    AND replaces_invoice_id              IS NULL
    AND invoice_number                   IS NULL;

  -- Verify the update actually applied (fail closed)
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_invoice_not_draft'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to transition revision invoice to issuing status. '
                      'The invoice may have been modified concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 21: BUILD SAFE RETURN PAYLOAD
  --
  -- Return JSONB consistent with the normal begin_invoice_issuance() contract
  -- so the future API/orchestrator can reuse as much code as possible.
  --
  -- Return safe fields only.
  -- Do NOT return:
  --   wire_instructions_snapshot
  --   routing/account numbers
  --   billing address
  --   billing email
  --   internal notes
  --   PDF path/hash
  --   payment data
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'invoice_id',                  p_invoice_id,
    'status',                      'issuing',
    'invoice_number',              v_invoice_number,
    'revision_source_invoice_id',  v_source.id,
    'source_invoice_number',       v_source.invoice_number,
    'issuing_started_at',          v_now,
    'due_date',                    v_due_date,
    'subtotal_cents',              v_subtotal_cents,
    'discount_cents',              v_discount_cents,
    'tax_cents',                   0,
    'total_cents',                 v_total_cents,
    'pdf_generation_status',       'pending'
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 2: GRANT / REVOKE EXECUTE ON begin_revision_invoice_issuance
--
-- The browser must never call this RPC directly.
-- Only the trusted server-side API (using service_role) may call it.
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.begin_revision_invoice_issuance(UUID, UUID)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders; covered by PUBLIC revoke above)
REVOKE EXECUTE ON FUNCTION public.begin_revision_invoice_issuance(UUID, UUID)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders; covered by PUBLIC revoke above)
REVOKE EXECUTE ON FUNCTION public.begin_revision_invoice_issuance(UUID, UUID)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.begin_revision_invoice_issuance(UUID, UUID)
  TO service_role;


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION SUMMARY (6A-5R4A — Begin Revision Invoice Issuance RPC)
-- -------------------------------------------------------------------
-- Migration file: 20260926030000_begin_revision_invoice_issuance_rpc.sql
-- Historical migrations modified: NO
--
-- ── begin_revision_invoice_issuance RPC ──────────────────────────────────
-- Function created:                public.begin_revision_invoice_issuance(uuid, uuid)
-- SECURITY DEFINER:                YES
-- search_path hardened:            YES (public, pg_catalog)
-- EXECUTE PUBLIC revoked:          YES
-- EXECUTE anon revoked:            YES
-- EXECUTE authenticated revoked:   YES
-- EXECUTE service_role granted:    YES
--
-- ── ADMIN VERIFICATION ────────────────────────────────────────────────────
-- Admin UUID verified in RPC:      YES
-- Source field:                    auth.users.raw_app_meta_data->>'role'
-- user_metadata trusted:           NO
-- NULL admin rejected:             YES
--
-- ── LOCK ORDER ────────────────────────────────────────────────────────────
-- Revision Draft locked first:     YES (FOR UPDATE)
-- Source invoice locked second:    YES (FOR UPDATE)
-- Consistent lock order:           YES (prevents deadlocks)
--
-- ── REVISION DRAFT VALIDATION ─────────────────────────────────────────────
-- status = 'draft' required:       YES
-- invoice_type = 'initial' required: YES
-- revision_source_invoice_id IS NOT NULL required: YES
-- replaces_invoice_id IS NULL required: YES
-- invoice_number IS NULL required: YES
-- Normal Initial Draft rejected:   YES (revision_invoice_not_draft)
--
-- ── SOURCE INVOICE VALIDATION ─────────────────────────────────────────────
-- Source must be status = 'open':  YES
-- Source must be invoice_type = 'initial': YES
-- Source must have invoice_number: YES
-- Source must have issued_at:      YES
-- Source must have pdf_generation_status = 'generated': YES
-- Source must match application_id: YES
-- Source unchanged by this RPC:    YES
--
-- ── SOURCE PAYMENT BLOCKING ───────────────────────────────────────────────
-- Blocking statuses checked:       pending, received, refunded
-- Failed payments ignored:         YES (do NOT block)
-- Payment rows modified:           NO
--
-- ── AUTHORITATIVE DEAL FACTS ──────────────────────────────────────────────
-- borrower_applications locked:    YES (FOR SHARE)
-- cycle 1 locked:                  YES (FOR SHARE)
-- emd_funded_cents used:           YES (current authoritative)
-- funded_date used:                YES (current authoritative)
-- deposit_goes_hard_date used:     YES (current authoritative)
-- deposit_amount used:             NO
--
-- ── STALE REVISION DRAFT CHECK ────────────────────────────────────────────
-- emd_funded_cents compared:       YES
-- funding_date compared:           YES
-- period_start_date compared:      YES
-- period_end_date compared:        YES
-- billable_days compared:          YES
-- Auto-refresh on stale:           NO (abort only)
--
-- ── CANONICAL DEAL FEE ────────────────────────────────────────────────────
-- calculate_deal_fee_cents used:   YES
-- Fee formula duplicated manually: NO
-- Expected daily rate:             10000 cents
--
-- ── LINE ITEM COMPOSITION ─────────────────────────────────────────────────
-- Allowed line types:              admin_fee / deal_fee / discount only
-- other line type rejected:        YES
-- extension_admin_fee rejected:    YES
-- extension_deal_fee rejected:     YES
-- Exactly 1 admin_fee required:    YES
-- Exactly 1 deal_fee required:     YES
--
-- ── ADMIN FEE VALIDATION ──────────────────────────────────────────────────
-- quantity = 1 required:           YES
-- unit_amount_cents = 250000:      YES
-- line_amount_cents = 250000:      YES
--
-- ── DEAL FEE VALIDATION ───────────────────────────────────────────────────
-- quantity = 1 required:           YES
-- line_amount_cents = canonical:   YES
-- unit_amount_cents = line_amount: YES
-- calc_daily_rate validated:       YES (= 10000)
-- calc_emd_funded_cents validated: YES
-- calc_billable_days validated:    YES
-- calc_period_start_date validated: YES
-- calc_period_end_date validated:  YES
--
-- ── TOTALS ────────────────────────────────────────────────────────────────
-- Totals recalculated from DB:     YES
-- Browser totals trusted:          NO
-- discount_cents <= subtotal_cents: YES (enforced)
-- total_cents >= 0:                YES (enforced)
--
-- ── BILLING ───────────────────────────────────────────────────────────────
-- billing_email required:          YES
-- Billing snapshot replaced from CRM: NO (Admin edits preserved)
--
-- ── INVOICE SETTINGS ──────────────────────────────────────────────────────
-- crm_invoice_settings locked:     YES (FOR SHARE)
-- Required settings validated:     YES (5 fields, same as normal issuance)
-- Wire snapshot built:             YES (same JSON structure as normal issuance)
-- Sensitive wire data returned:    NO
--
-- ── CREDIT CARD SNAPSHOT ──────────────────────────────────────────────────
-- credit_card_payment_enabled_snapshot: YES (current authoritative Deal value)
-- Copied from source invoice:      NO
--
-- ── TIMESTAMPS AND DATES ──────────────────────────────────────────────────
-- Business timezone:               America/New_York
-- Single v_now used:               YES
-- Due date override preserved:     YES
-- Null due date uses issuance date: YES
-- Source invoice due date copied:  NO
--
-- ── REVISION INVOICE NUMBER ───────────────────────────────────────────────
-- Global sequence used:            NO
-- Number derived from source:      YES
-- Base EB-YYYY-NNNNNN → -B:        YES
-- Existing -B → -C:                YES
-- Existing -Y → -Z:                YES
-- Existing -Z → revision_suffix_exhausted: YES
-- Malformed source → revision_source_number_invalid: YES
-- Original root year preserved:    YES (not derived from v_now)
-- UNIQUE constraint is final guard: YES
--
-- ── FINAL STATE ───────────────────────────────────────────────────────────
-- Revision Draft status:           issuing
-- issuing_started_at set:          YES
-- issued_at set:                   NO (remains NULL)
-- pdf_generation_status:           pending
-- replaces_invoice_id during begin: NULL (remains NULL)
-- revision_source_invoice_id:      preserved permanently
-- Source invoice modified:         NO
-- PDF generated:                   NO
-- Activity created:                NO
--
-- ── FAIL CLOSED ───────────────────────────────────────────────────────────
-- Final UPDATE WHERE clause:       id, status='draft', invoice_type='initial',
--                                  revision_source_invoice_id=source.id,
--                                  replaces_invoice_id IS NULL,
--                                  invoice_number IS NULL
-- Partial transition possible:     NO
--
-- ── SAFE RETURN PAYLOAD ───────────────────────────────────────────────────
-- invoice_id returned:             YES
-- status returned:                 YES ('issuing')
-- invoice_number returned:         YES
-- revision_source_invoice_id returned: YES
-- source_invoice_number returned:  YES
-- issuing_started_at returned:     YES
-- due_date returned:               YES
-- subtotal_cents returned:         YES
-- discount_cents returned:         YES
-- tax_cents returned:              YES (0)
-- total_cents returned:            YES
-- pdf_generation_status returned:  YES ('pending')
-- wire_instructions_snapshot returned: NO
-- billing data returned:           NO
-- internal notes returned:         NO
-- PDF path/hash returned:          NO
-- payment data returned:           NO
--
-- ── STABLE ERROR TOKENS ───────────────────────────────────────────────────
-- admin_not_authorized:            YES
-- revision_invoice_not_found:      YES
-- revision_invoice_not_draft:      YES
-- revision_source_ineligible:      YES
-- revision_draft_stale:            YES
-- revision_settings_incomplete:    YES
-- revision_billing_incomplete:     YES
-- revision_line_items_invalid:     YES
-- revision_source_number_invalid:  YES
-- revision_suffix_exhausted:       YES
-- Secrets in error messages:       NO
--
-- ── SCOPE EXCLUSIONS ──────────────────────────────────────────────────────
-- begin_invoice_issuance modified:         NO
-- refresh_initial_draft_invoice_snapshot modified: NO
-- refresh_revision_draft_invoice_snapshot modified: NO
-- create_revision_draft_invoice modified:  NO
-- complete_invoice_issuance modified:      NO
-- mark_invoice_pdf_failed modified:        NO
-- calculate_deal_fee_cents modified:       NO
-- complete_revision_invoice_issuance created: NO
-- Historical migrations modified:          NO
-- API files modified:                      NO
-- UI files modified:                       NO
-- Business data modified:                  NO
-- Production Revision Draft called:        NO
-- Supabase deployment performed:           NO
-- Safe to review:                          YES
-- ============================================================
