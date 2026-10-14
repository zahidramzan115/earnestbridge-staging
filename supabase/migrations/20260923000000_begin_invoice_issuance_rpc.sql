-- ============================================================
-- Migration: 20260923000000_begin_invoice_issuance_rpc
--
-- Step 6A-5B1.4 — Remove Deal-Fee Row Lock Before Push
--
-- PURPOSE
-- -------
-- Creates the atomic database foundation for the draft → issuing
-- invoice status transition.
--
-- This migration:
--   1. Hardens protect_issued_invoice_line_items() to acquire a
--      FOR SHARE lock on the parent invoice row during status
--      checks, serializing concurrent line-item mutations against
--      the begin_invoice_issuance FOR UPDATE row lock.
--   2. Creates public.begin_invoice_issuance(p_invoice_id, p_admin_user_id)
--      as a SECURITY DEFINER RPC callable only by service_role.
--
-- CORRECTIONS IN 6A-5B1.1
-- ------------------------
-- A. Removed FOR SHARE from the aggregate COUNT query on line items.
--    The parent invoice FOR UPDATE lock provides the serialization
--    boundary. Once begin_invoice_issuance holds the invoice FOR UPDATE:
--      - any earlier line-item transaction has already completed
--      - any new line-item mutation blocks on the parent FOR SHARE
--    The aggregate COUNT may therefore use a plain SELECT.
--    The deal_fee single-row SELECT also uses a plain SELECT (no FOR SHARE).
--    The parent crm_invoices FOR UPDATE lock, combined with the line-item
--    mutation trigger's parent FOR SHARE lock, serializes the full line-item
--    set. All line-item reads inside begin_invoice_issuance therefore use
--    normal MVCC SELECTs.
-- B. Added rejection of line_type = 'other' for initial invoice issuance.
--    Permitted composition is EXACTLY: admin_fee / deal_fee / discount.
--    Any other line type (including 'other', 'extension_admin_fee',
--    'extension_deal_fee') causes abort BEFORE nextval().
-- C. Added admin_fee line validation:
--    quantity = 1, unit_amount_cents = 250000, line_amount_cents = 250000
--    ($2,500.00 base Administrative Fee). Abort BEFORE nextval() if wrong.
-- D. Added deal_fee calc_daily_rate_per_100k_cents validation against
--    the stored value 10000 cents ($100 per $100,000 per calendar day),
--    confirmed from the existing Draft invoice creation code.
-- E. Replaced all CONSTRAINT-based error tokens with stable
--    ERRCODE = 'P0001', MESSAGE = '<token>' pattern so the future
--    Next.js API can switch on error.message without parsing prose.
--    Wire secrets are never included in error messages.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- --------------------------------
-- - Does NOT generate a PDF
-- - Does NOT transition issuing → open
-- - Does NOT set issued_at (remains NULL)
-- - Does NOT send an invoice email
-- - Does NOT create an invoice_issued activity
-- - Does NOT add an Issue Invoice UI button
-- - Does NOT add an Issue API route
-- - Does NOT change payments
-- - Does NOT change Option automation
-- - Does NOT add issuance attempt counters
-- - Does NOT consume a real invoice number (RPC not called here)
--
-- TRIGGER HARDENING RATIONALE
-- ----------------------------
-- The existing protect_issued_invoice_line_items() performs an
-- unlocked SELECT to read the parent invoice status. This creates
-- a serialization gap:
--
--   T1 (line-item INSERT): reads parent status = 'draft' (no lock)
--   T2 (begin_invoice_issuance): acquires FOR UPDATE on invoice row
--   T2: transitions status to 'issuing', commits
--   T1: proceeds to insert line item into a now-issuing invoice
--
-- Fix: replace the plain SELECT with SELECT ... FOR SHARE.
-- FOR SHARE is compatible with other FOR SHARE readers but
-- conflicts with FOR UPDATE writers, so:
--   - if line-item mutation starts first → issuance waits
--   - if issuance FOR UPDATE starts first → line mutation waits
--   - after issuance commits status='issuing', waiting line
--     mutation re-checks status and correctly rejects
--
-- DEADLOCK PREVENTION
-- -------------------
-- The reparenting UPDATE case must lock two parent rows.
-- Deterministic lock ordering (lower UUID first) prevents deadlocks.
-- The issuance RPC only ever locks one invoice row, so no
-- circular dependency is possible between the two lock paths.
--
-- SECURITY
-- --------
-- All SECURITY DEFINER functions use:
--   SET search_path = public, pg_catalog
-- Admin authorization uses ONLY raw_app_meta_data->>'role' = 'admin'
-- (server-controlled, never user-editable metadata)
-- EXECUTE on begin_invoice_issuance is REVOKED from PUBLIC, anon,
-- and authenticated; GRANTED only to service_role.
-- The browser must never call this RPC directly.
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call begin_invoice_issuance on any real invoice
--   - consume any invoice number from crm_invoice_number_seq
--   - transition any invoice from draft to issuing
--   - create any activity records
--   - send any emails
--   - generate any PDFs
--
-- Expected invoice numbers consumed: 0
-- ============================================================


-- ============================================================
-- SECTION 1: HARDEN LINE-ITEM TRIGGER FOR SERIALIZATION
--
-- Replace protect_issued_invoice_line_items() to acquire a
-- FOR SHARE lock on the parent invoice row during status checks.
--
-- This serializes concurrent line-item mutations against the
-- begin_invoice_issuance FOR UPDATE row lock.
--
-- All existing protections are preserved:
--   - INSERT: parent must exist and be 'draft'
--   - DELETE: parent must exist and be 'draft'
--   - UPDATE: both OLD and NEW parents must exist and be 'draft'
--   - Reparenting: deterministic lock ordering (lower UUID first)
--     to prevent deadlocks when OLD.invoice_id != NEW.invoice_id
--   - Fail closed: missing parent raises exception
--   - NULL parent status is NOT treated as safe
--
-- The only change from the previous version is replacing plain
-- SELECT with SELECT ... FOR SHARE on all parent row lookups.
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
  v_lock_first_id      UUID;
  v_lock_second_id     UUID;
BEGIN

  -- ── INSERT ────────────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN

    -- Acquire FOR SHARE lock on the parent invoice row.
    -- FOR SHARE conflicts with FOR UPDATE (held by begin_invoice_issuance),
    -- ensuring the line-item insert serializes against concurrent issuance.
    SELECT status INTO v_new_invoice_status
    FROM public.crm_invoices
    WHERE id = NEW.invoice_id
    FOR SHARE;

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

    -- Acquire FOR SHARE lock on the parent invoice row.
    SELECT status INTO v_old_invoice_status
    FROM public.crm_invoices
    WHERE id = OLD.invoice_id
    FOR SHARE;

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

    -- Determine whether this is a reparenting UPDATE (invoice_id changing).
    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN

      -- ── Reparenting: must lock BOTH parent rows ──────────────────────────
      -- Use deterministic lock ordering (lower UUID first) to prevent
      -- deadlocks when two concurrent reparenting operations involve the
      -- same pair of invoices in opposite order.
      IF OLD.invoice_id < NEW.invoice_id THEN
        v_lock_first_id  := OLD.invoice_id;
        v_lock_second_id := NEW.invoice_id;
      ELSE
        v_lock_first_id  := NEW.invoice_id;
        v_lock_second_id := OLD.invoice_id;
      END IF;

      -- Lock first (lower UUID) with FOR SHARE
      SELECT status INTO v_old_invoice_status
      FROM public.crm_invoices
      WHERE id = v_lock_first_id
      FOR SHARE;

      IF v_old_invoice_status IS NULL THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE reparent): invoice % does not exist. '
          'Cannot reparent a line item involving a non-existent invoice.',
          v_lock_first_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;

      IF v_old_invoice_status != 'draft' THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE reparent): invoice % has status ''%''. '
          'A line item cannot be moved from or to a non-draft invoice. '
          'Use Void + Replacement Invoice to correct an issued invoice.',
          v_lock_first_id, v_old_invoice_status
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      -- Lock second (higher UUID) with FOR SHARE
      SELECT status INTO v_new_invoice_status
      FROM public.crm_invoices
      WHERE id = v_lock_second_id
      FOR SHARE;

      IF v_new_invoice_status IS NULL THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE reparent): invoice % does not exist. '
          'Cannot reparent a line item involving a non-existent invoice.',
          v_lock_second_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;

      IF v_new_invoice_status != 'draft' THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE reparent): invoice % has status ''%''. '
          'A line item cannot be moved from or to a non-draft invoice. '
          'Use Void + Replacement Invoice to correct an issued invoice.',
          v_lock_second_id, v_new_invoice_status
          USING ERRCODE = 'insufficient_privilege';
      END IF;

    ELSE

      -- ── Non-reparenting UPDATE: lock only the single parent row ──────────
      -- OLD.invoice_id = NEW.invoice_id; only one lock needed.
      SELECT status INTO v_old_invoice_status
      FROM public.crm_invoices
      WHERE id = OLD.invoice_id
      FOR SHARE;

      -- Fail closed: OLD parent must exist
      IF v_old_invoice_status IS NULL THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE): parent invoice % does not exist. '
          'Cannot update a line item whose parent invoice cannot be found.',
          OLD.invoice_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;

      -- OLD parent must be draft
      IF v_old_invoice_status != 'draft' THEN
        RAISE EXCEPTION
          'protect_issued_invoice_line_items (UPDATE): parent invoice % has status ''%''. '
          'A line item from a non-draft invoice cannot be updated. '
          'Use Void + Replacement Invoice to correct an issued invoice.',
          OLD.invoice_id, v_old_invoice_status
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
-- SECTION 2: begin_invoice_issuance RPC
--
-- Atomically transitions a draft invoice to issuing status.
--
-- Signature:
--   public.begin_invoice_issuance(
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
-- Returns a safe subset of invoice fields (no wire secrets).
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized        — p_admin_user_id is not an authorized Admin
--   invoice_not_found           — invoice row does not exist
--   invoice_not_draft           — invoice status is not 'draft'
--   invoice_type_not_supported  — not a normal initial invoice
--   invoice_draft_stale         — snapshot facts differ from source, or draft
--                                 contains unexpected PDF artifact metadata
--   invoice_settings_incomplete — required settings fields missing
--   invoice_billing_incomplete  — billing_email missing
--   invoice_line_items_invalid  — line composition or amounts wrong
--
-- Future API switches on error.message (the stable token).
-- DETAIL provides human-readable context; never contains wire secrets.
-- ============================================================

CREATE OR REPLACE FUNCTION public.begin_invoice_issuance(
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

  -- Invoice row (locked FOR UPDATE)
  v_invoice                 public.crm_invoices%ROWTYPE;

  -- Source data
  v_app                     RECORD;  -- borrower_applications row
  v_cycle1                  RECORD;  -- crm_deal_option_cycles cycle 1 row
  v_settings                public.crm_invoice_settings%ROWTYPE;

  -- Canonical deal fee
  v_canonical_deal_fee_cents BIGINT;

  -- Line item validation
  v_admin_fee_count         INTEGER;
  v_deal_fee_count          INTEGER;
  v_invalid_type_count      INTEGER;
  v_admin_fee_line          RECORD;
  v_deal_fee_line           RECORD;

  -- Expected base admin fee (EarnestBridge initial invoice Administrative Fee)
  -- $2,500.00 = 250000 cents — confirmed from Draft invoice creation code
  v_expected_admin_fee_cents CONSTANT BIGINT := 250000;

  -- Expected daily rate per $100k (confirmed from Draft invoice creation code)
  -- $100 per $100,000 per calendar day = 10000 cents
  v_expected_daily_rate_cents CONSTANT BIGINT := 10000;

  -- Recalculated totals
  v_subtotal_cents          BIGINT;
  v_discount_cents          BIGINT;
  v_total_cents             BIGINT;

  -- Timestamps and dates
  v_now                     TIMESTAMPTZ;
  v_invoice_date            DATE;

  -- Invoice number
  v_seq_val                 BIGINT;
  v_invoice_number          TEXT;

  -- Due date
  v_due_date                DATE;

  -- Wire snapshot
  v_wire_snapshot           JSONB;

  -- Return payload
  v_result                  JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
  -- Even though the future API will authenticate Admin before calling this
  -- RPC, we verify defensively inside the function.
  -- We use raw_app_meta_data (server-controlled) — never user_metadata.
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
  -- STEP 2: LOCK INVOICE ROW FOR UPDATE
  -- Acquire an exclusive row lock before any validation.
  -- A concurrent second Issue request will block here and, after the first
  -- request commits (status = 'issuing'), will proceed to the status check
  -- below and fail with invoice_not_draft — consuming NO invoice number.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice does not exist.';
  END IF;

  IF v_invoice.status != 'draft' THEN
    RAISE EXCEPTION 'invoice_not_draft'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice status is not draft; cannot begin issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: INITIAL INVOICE TYPE GUARD
  -- This step supports only normal initial invoices.
  -- Extension, other, and replacement issuance are not yet implemented.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.invoice_type != 'initial' OR v_invoice.replaces_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_type_not_supported'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Only normal initial invoices (type=initial, replaces_invoice_id IS NULL) are supported in this version.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: LOCK AUTHORITATIVE SOURCE ROWS
  -- Lock borrower_applications and cycle 1 with FOR SHARE so these source
  -- facts cannot change mid-issuance.
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
    RAISE EXCEPTION 'invoice_draft_stale'
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
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 option cycle row for this invoice could not be found.';
  END IF;

  -- Validate required source facts
  IF v_app.emd_funded_cents IS NULL OR v_app.emd_funded_cents <= 0 THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'emd_funded_cents must be greater than zero.';
  END IF;

  IF v_app.funded_date IS NULL THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'funded_date is missing on the deal.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date IS NULL THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 deposit_goes_hard_date is missing.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date <= v_app.funded_date THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 deposit_goes_hard_date must be after funded_date.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: STALE DRAFT DETECTION
  -- Compare the Draft financial snapshot against current authoritative facts.
  -- Abort before nextval() if any fact has drifted.
  -- ══════════════════════════════════════════════════════════════════════════

  -- Check financial snapshot fields
  IF v_invoice.emd_funded_cents IS DISTINCT FROM v_app.emd_funded_cents THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Draft snapshot emd_funded_cents does not match current deal value. Refresh the draft before issuing.';
  END IF;

  IF v_invoice.funding_date IS DISTINCT FROM v_app.funded_date THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Draft snapshot funding_date does not match current deal funded_date. Refresh the draft before issuing.';
  END IF;

  IF v_invoice.period_start_date IS DISTINCT FROM v_app.funded_date THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Draft snapshot period_start_date does not match current funded_date. Refresh the draft before issuing.';
  END IF;

  IF v_invoice.period_end_date IS DISTINCT FROM v_cycle1.deposit_goes_hard_date THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Draft snapshot period_end_date does not match current cycle 1 deposit_goes_hard_date. Refresh the draft before issuing.';
  END IF;

  IF v_invoice.billable_days IS DISTINCT FROM
     (v_cycle1.deposit_goes_hard_date - v_app.funded_date) THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Draft snapshot billable_days does not match current (deposit_goes_hard_date - funded_date). Refresh the draft before issuing.';
  END IF;

  -- Revalidate canonical deal fee
  v_canonical_deal_fee_cents := public.calculate_deal_fee_cents(
    v_app.emd_funded_cents,
    v_app.funded_date,
    v_cycle1.deposit_goes_hard_date
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: VALIDATE LINE ITEM COMPOSITION
  --
  -- For a normal initial invoice the ONLY permitted line types are:
  --   admin_fee   (exactly 1 required)
  --   deal_fee    (exactly 1 required)
  --   discount    (0 or more)
  --
  -- Any other line type — including 'other', 'extension_admin_fee',
  -- 'extension_deal_fee' — causes abort BEFORE nextval().
  --
  -- NOTE: The aggregate COUNT query uses a plain SELECT (no FOR SHARE).
  -- Serialization is provided by the parent invoice FOR UPDATE lock
  -- acquired in STEP 2. Once this RPC holds the invoice FOR UPDATE:
  --   - any earlier line-item transaction has already completed before
  --     this RPC obtained the lock
  --   - any new line-item mutation will block trying to acquire the
  --     parent FOR SHARE lock in protect_issued_invoice_line_items()
  -- Therefore the line-item set is stable and a plain SELECT is safe.
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

  -- Reject any line type outside the permitted set (other, extension_*, etc.)
  IF v_invalid_type_count > 0 THEN
    RAISE EXCEPTION 'invoice_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Initial invoice contains line type(s) not permitted for issuance. Only admin_fee, deal_fee, and discount lines are allowed.';
  END IF;

  -- Require exactly 1 admin_fee line
  IF v_admin_fee_count != 1 THEN
    RAISE EXCEPTION 'invoice_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Initial invoice must have exactly 1 admin_fee line item.';
  END IF;

  -- Require exactly 1 deal_fee line
  IF v_deal_fee_count != 1 THEN
    RAISE EXCEPTION 'invoice_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Initial invoice must have exactly 1 deal_fee line item.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: VALIDATE ADMIN FEE LINE
  --
  -- The EarnestBridge initial invoice base Administrative Fee is:
  --   $2,500.00 = 250000 cents
  --
  -- Confirmed from Draft invoice creation code:
  --   DEFAULT_ADMIN_FEE_CENTS = 250000
  --   quantity = 1
  --   unit_amount_cents = 250000
  --   line_amount_cents = 250000
  --
  -- Discounts and waivers must remain separate negative discount lines.
  -- Do NOT silently rewrite the line — abort if it differs.
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
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Admin fee line does not match the expected base Administrative Fee (quantity=1, $2,500.00). The draft is invalid and must be corrected before issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: VALIDATE DEAL FEE LINE
  --
  -- Fetch the deal_fee line using a normal MVCC SELECT (no FOR SHARE).
  -- The parent crm_invoices FOR UPDATE lock, combined with the line-item
  -- mutation trigger's parent FOR SHARE lock, serializes the full line-item
  -- set. All line-item reads inside begin_invoice_issuance therefore use
  -- normal MVCC SELECTs.
  --
  -- Validates:
  --   quantity = 1
  --   line_amount_cents matches canonical calculate_deal_fee_cents()
  --   unit_amount_cents = line_amount_cents (quantity=1 invariant)
  --   calc_emd_funded_cents, calc_billable_days,
  --   calc_period_start_date, calc_period_end_date — match source facts
  --   calc_daily_rate_per_100k_cents = 10000
  --     ($100 per $100,000 per calendar day — confirmed from Draft creation code)
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
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line quantity must be 1. The draft is invalid and must be corrected before issuance.';
  END IF;

  -- Validate deal_fee line amount matches canonical calculation
  IF v_deal_fee_line.line_amount_cents IS DISTINCT FROM v_canonical_deal_fee_cents THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line amount does not match the canonical deal fee calculation. The draft is stale and must be refreshed before issuance.';
  END IF;

  -- Validate unit_amount_cents is consistent with line_amount_cents (quantity=1)
  IF v_deal_fee_line.unit_amount_cents IS DISTINCT FROM v_deal_fee_line.line_amount_cents THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line unit_amount_cents does not equal line_amount_cents (expected for quantity=1). The draft is invalid and must be corrected before issuance.';
  END IF;

  -- Validate daily rate audit field
  IF v_deal_fee_line.calc_daily_rate_per_100k_cents IS DISTINCT FROM v_expected_daily_rate_cents THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line calc_daily_rate_per_100k_cents does not match the current business rate. The draft is stale and must be refreshed before issuance.';
  END IF;

  -- Validate calculation audit fields are consistent with current source data
  IF v_deal_fee_line.calc_emd_funded_cents IS DISTINCT FROM v_app.emd_funded_cents
  OR v_deal_fee_line.calc_billable_days IS DISTINCT FROM
     (v_cycle1.deposit_goes_hard_date - v_app.funded_date)
  OR v_deal_fee_line.calc_period_start_date IS DISTINCT FROM v_app.funded_date
  OR v_deal_fee_line.calc_period_end_date IS DISTINCT FROM v_cycle1.deposit_goes_hard_date
  THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Deal fee line calculation audit fields are inconsistent with current authoritative source data. The draft is stale and must be refreshed before issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: RECALCULATE FINAL TOTALS FROM DATABASE LINE ITEMS
  -- Calculate directly from line items. Never trust browser totals.
  -- The parent invoice FOR UPDATE lock guarantees the line-item set is stable.
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
    RAISE EXCEPTION 'invoice_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Total discount exceeds subtotal; invoice total would be negative.';
  END IF;

  v_total_cents := v_subtotal_cents - v_discount_cents;

  -- Sanity check: total must be >= 0
  IF v_total_cents < 0 THEN
    RAISE EXCEPTION 'invoice_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Computed total_cents is negative.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: VALIDATE BILLING REQUIREMENTS
  -- Require a non-empty billing_email at minimum.
  -- Preserve all existing Draft billing snapshot fields exactly as edited.
  -- Do NOT repopulate from crm_companies or crm_contacts.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.billing_email IS NULL OR trim(v_invoice.billing_email) = '' THEN
    RAISE EXCEPTION 'invoice_billing_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'A billing email address is required before issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: VALIDATE AND LOCK INVOICE SETTINGS
  -- Read the singleton crm_invoice_settings row with FOR SHARE.
  -- Require all five mandatory fields before consuming a sequence number.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_settings
  FROM public.crm_invoice_settings
  WHERE id = 1
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_settings_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice settings have not been configured. All required fields must be set before issuance.';
  END IF;

  -- Validate all five required fields are non-empty
  IF v_settings.issuer_legal_name IS NULL OR trim(v_settings.issuer_legal_name) = ''
  OR v_settings.wire_bank_name IS NULL OR trim(v_settings.wire_bank_name) = ''
  OR v_settings.wire_account_name IS NULL OR trim(v_settings.wire_account_name) = ''
  OR v_settings.wire_routing_number IS NULL OR trim(v_settings.wire_routing_number) = ''
  OR v_settings.wire_account_number IS NULL OR trim(v_settings.wire_account_number) = ''
  THEN
    RAISE EXCEPTION 'invoice_settings_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice settings are incomplete. issuer_legal_name, wire_bank_name, wire_account_name, wire_routing_number, and wire_account_number must all be configured before issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: CAPTURE TIMESTAMP AND DERIVE BUSINESS DATE
  -- Capture a single v_now so all date derivations are consistent.
  -- Use America/New_York for business-date calculations.
  -- ══════════════════════════════════════════════════════════════════════════

  v_now         := now();
  v_invoice_date := timezone('America/New_York', v_now)::DATE;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: RESOLVE DUE DATE
  -- Preserve Admin override if already set.
  -- If NULL, set to v_invoice_date (Due Upon Receipt).
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.due_date IS NOT NULL THEN
    v_due_date := v_invoice.due_date;
  ELSE
    v_due_date := v_invoice_date;
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13B: FAIL CLOSED ON STALE DRAFT PDF METADATA
  -- A normal Draft invoice must never already have an immutable PDF artifact.
  -- If any of pdf_storage_path, pdf_generated_at, or pdf_hash are non-NULL,
  -- abort BEFORE nextval() — do NOT silently reuse an existing PDF artifact.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.pdf_storage_path IS NOT NULL
  OR v_invoice.pdf_generated_at IS NOT NULL
  OR v_invoice.pdf_hash IS NOT NULL
  THEN
    RAISE EXCEPTION 'invoice_draft_stale'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Draft invoice contains unexpected PDF artifact metadata.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: ASSIGN INVOICE NUMBER FROM SEQUENCE
  -- Only called AFTER all validation above has passed.
  -- Format: EB-YYYY-NNNNNN (global sequence, no annual reset)
  -- ══════════════════════════════════════════════════════════════════════════

  v_seq_val       := nextval('public.crm_invoice_number_seq');
  v_invoice_number := 'EB-' ||
                      to_char(v_invoice_date, 'YYYY') || '-' ||
                      lpad(v_seq_val::TEXT, 6, '0');


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 15: BUILD VERSIONED WIRE INSTRUCTIONS SNAPSHOT
  -- Store a structured JSON object as the immutable issuance-time snapshot.
  -- This snapshot is used by future PDF retries and must not depend on
  -- settings that may change after issuance begins.
  --
  -- IMPORTANT: This JSONB is stored in wire_instructions_snapshot.
  -- It contains sensitive wire data and must NOT be returned in the RPC
  -- result or exposed through any client-facing API.
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
  -- STEP 16: FINAL ATOMIC PARENT UPDATE
  -- Transition draft → issuing with all finalized immutable fields.
  -- OLD.status = 'draft' at trigger evaluation time, so protect_issued_invoice_fields()
  -- allows all field changes in this single UPDATE.
  -- After this UPDATE commits, all snapshot fields become immutable.
  --
  -- Fields set:
  --   subtotal_cents, discount_cents, tax_cents = 0, total_cents
  --   credit_card_payment_enabled_snapshot
  --   wire_instructions_snapshot  (contains sensitive wire data — not returned)
  --   invoice_number
  --   due_date
  --   issuing_started_at = v_now
  --   status = 'issuing'
  --   pdf_generation_status = 'pending'
  --   pdf_generation_error = NULL
  --
  -- Fields intentionally NOT set / explicitly cleared:
  --   issued_at = NULL  (set later when issuing → open after PDF success)
  --   pdf_storage_path = NULL  (explicitly cleared — no prior PDF artifact)
  --   pdf_generated_at = NULL  (explicitly cleared — no prior PDF artifact)
  --   pdf_hash = NULL          (explicitly cleared — no prior PDF artifact)
  --
  -- Draft billing fields are NOT changed.
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
  WHERE id = p_invoice_id
    AND status = 'draft';

  -- Verify the update actually applied (guard against unexpected concurrent change)
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_draft'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to transition invoice to issuing status. The invoice may have been modified concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 17: BUILD SAFE RETURN PAYLOAD
  -- Return only non-secret fields needed by the future server API.
  -- wire_instructions_snapshot and all bank/routing/account data are
  -- intentionally excluded.
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'invoice_id',            p_invoice_id,
    'status',                'issuing',
    'invoice_number',        v_invoice_number,
    'issuing_started_at',    v_now,
    'due_date',              v_due_date,
    'subtotal_cents',        v_subtotal_cents,
    'discount_cents',        v_discount_cents,
    'tax_cents',             0,
    'total_cents',           v_total_cents,
    'pdf_generation_status', 'pending'
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 3: GRANT / REVOKE EXECUTE ON begin_invoice_issuance
--
-- The browser must never call this RPC directly.
-- Only the trusted server-side API (using service_role) may call it.
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders; covered by PUBLIC revoke above)
REVOKE EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders; covered by PUBLIC revoke above)
REVOKE EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  TO service_role;


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION SUMMARY (6A-5B1.4 — Remove Deal-Fee Row Lock)
-- -------------------------------------------
-- Migration file: 20260923000000_begin_invoice_issuance_rpc.sql
-- Modified in place — NO second migration created.
--
-- ── LINE-ITEM TRIGGER HARDENING ───────────────────────────────────────────
-- Trigger function replaced:       protect_issued_invoice_line_items()
-- Trigger re-attached:             guard_issued_invoice_line_items
-- Hardened trigger uses FOR SHARE: YES (all parent row lookups)
-- Reparenting deadlock prevention: YES (deterministic lock ordering by UUID)
-- All existing protections preserved: YES
--
-- ── begin_invoice_issuance RPC ────────────────────────────────────────────
-- Function created:                public.begin_invoice_issuance(uuid, uuid)
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
--
-- ── INVOICE ROW LOCK ──────────────────────────────────────────────────────
-- Invoice locked FOR UPDATE:       YES
-- Concurrent second issue consumes number: NO (sees status='issuing', aborts)
--
-- ── AGGREGATE QUERY SERIALIZATION ────────────────────────────────────────
-- Aggregate COUNT query uses FOR SHARE: NO (plain SELECT — correct)
-- Serialization provided by:       parent invoice FOR UPDATE lock (STEP 2)
-- Explanation: once begin_invoice_issuance holds the invoice FOR UPDATE,
--   any earlier line-item transaction has already completed before issuance
--   obtained the lock; any new line-item mutation blocks on the parent
--   FOR SHARE lock in protect_issued_invoice_line_items(). The line-item
--   set is therefore stable and a plain SELECT is safe and correct.
-- deal_fee single-row SELECT uses FOR SHARE: NO (plain MVCC SELECT — correct)
-- All line-item reads inside begin_invoice_issuance: plain MVCC SELECTs
-- Serialization for all line-item reads provided by:
--   parent invoice FOR UPDATE lock (STEP 2) combined with
--   protect_issued_invoice_line_items() parent FOR SHARE lock
--
-- ── INVOICE TYPE GUARD ────────────────────────────────────────────────────
-- Initial invoice only:            YES (type='initial', replaces_invoice_id IS NULL)
-- Extension/other/replacement:     REJECTED (invoice_type_not_supported)
--
-- ── LINE ITEM COMPOSITION ─────────────────────────────────────────────────
-- Allowed line types:              admin_fee / deal_fee / discount only
-- other line type rejected:        YES (before nextval)
-- extension_admin_fee rejected:    YES (before nextval)
-- extension_deal_fee rejected:     YES (before nextval)
-- Any invalid type aborts before nextval: YES
--
-- ── ADMIN FEE VALIDATION ──────────────────────────────────────────────────
-- Exactly one admin_fee required:  YES
-- Admin fee quantity validated:    YES (must = 1)
-- Admin fee unit_amount validated: YES (must = 250000 cents = $2,500.00)
-- Admin fee line_amount validated: YES (must = 250000 cents = $2,500.00)
-- Confirmed value source:          DEFAULT_ADMIN_FEE_CENTS = 250000
--                                  in src/app/api/admin/invoices/route.ts
-- Invalid admin fee aborts before nextval: YES
--
-- ── DEAL FEE VALIDATION ───────────────────────────────────────────────────
-- Exactly one deal_fee required:   YES
-- Deal fee quantity validated:     YES (must = 1)
-- Canonical deal fee revalidated:  YES (calculate_deal_fee_cents called)
-- calc_daily_rate_per_100k_cents validated: YES (must = 10000)
-- Confirmed daily rate stored value: 10000 cents ($100 per $100k per day)
--   confirmed from: calc_daily_rate_per_100k_cents: 10000
--   in src/app/api/admin/invoices/route.ts line ~332
-- All deal fee audit fields validated: YES
--   (calc_emd_funded_cents, calc_billable_days,
--    calc_period_start_date, calc_period_end_date,
--    calc_daily_rate_per_100k_cents)
-- Invalid deal fee aborts before nextval: YES
--
-- ── MACHINE-READABLE RPC ERRORS ───────────────────────────────────────────
-- Stable error token transport:    ERRCODE = 'P0001', MESSAGE = '<token>'
--   Future API reads: error.message (the stable token string)
--   DETAIL provides human-readable context (no wire secrets)
-- Stable tokens implemented:
--   admin_not_authorized
--   invoice_not_found
--   invoice_not_draft
--   invoice_type_not_supported
--   invoice_draft_stale
--   invoice_settings_incomplete
--   invoice_billing_incomplete
--   invoice_line_items_invalid
-- Wire secrets included in errors: NO
--
-- ── SOURCE ROW LOCKS ──────────────────────────────────────────────────────
-- borrower_applications locked:    YES (FOR SHARE)
-- cycle 1 locked:                  YES (FOR SHARE)
-- invoice settings locked:         YES (FOR SHARE)
--
-- ── STALE DRAFT DETECTION ─────────────────────────────────────────────────
-- Stale draft detected:            YES (all 5 financial snapshot fields checked)
-- Stale draft consumes number:     NO (aborts before nextval)
--
-- ── FINAL TOTALS ──────────────────────────────────────────────────────────
-- Final totals recalculated from DB: YES
-- Browser totals trusted:          NO
--
-- ── BILLING ───────────────────────────────────────────────────────────────
-- billing_email required:          YES
-- Draft billing snapshot replaced from CRM: NO
--
-- ── INVOICE SETTINGS ──────────────────────────────────────────────────────
-- Required settings validated:     YES (5 fields)
-- Settings validated before nextval: YES
-- Versioned snapshot stored:       YES (wire_instructions_snapshot JSONB)
-- Snapshot includes issuer:        YES
-- Snapshot includes wire:          YES
-- Snapshot includes invoice tagline/footer: YES
-- Sensitive wire data returned:    NO
--
-- ── CREDIT CARD SNAPSHOT ──────────────────────────────────────────────────
-- credit_card_payment_enabled_snapshot set: YES
--
-- ── TIMESTAMPS AND DATES ──────────────────────────────────────────────────
-- Business timezone:               America/New_York
-- Single v_now used:               YES
-- Due date override preserved:     YES
-- Null due date uses invoice date: YES
--
-- ── INVOICE NUMBER ────────────────────────────────────────────────────────
-- Sequence used:                   public.crm_invoice_number_seq
-- Sequence called only after ALL validation: YES
-- Number format:                   EB-YYYY-NNNNNN
-- Sequence resets annually:        NO (global monotonic)
--
-- ── FINAL STATE ───────────────────────────────────────────────────────────
-- Final status:                    issuing
-- issuing_started_at set:          YES
-- issued_at set:                   NO (remains NULL)
-- pdf_generation_status:           pending
-- PDF generated:                   NO
-- Status transitioned to open:     NO
-- invoice_issued activity created: NO
--
-- ── SCOPE EXCLUSIONS ──────────────────────────────────────────────────────
-- Second migration created:        NO
-- Issue API route created:         NO
-- Issue Invoice UI added:          NO
-- Real production draft issued:    NO
-- Invoice numbers consumed:        0
-- Edge function changed:           NO
-- Netlify redeploy required:       NO
-- Supabase deployment required:    YES
-- Safe to push corrected migration: YES
-- ============================================================
