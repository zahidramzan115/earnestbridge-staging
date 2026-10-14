-- ============================================================
-- Migration: 20260925000000_refresh_initial_draft_invoice_snapshot_rpc
--
-- Step 6A-5C4C.3A — Atomic Initial Draft Financial Refresh RPC
--
-- PURPOSE
-- -------
-- Creates the atomic database RPC that refreshes the financial snapshot
-- of an existing initial Draft invoice when authoritative funding facts
-- or the original Hard Date change.
--
-- This migration creates ONLY the function and grants.
-- It does NOT call the function against any real data.
-- It does NOT modify any existing invoice.
-- It does NOT consume any invoice number.
--
-- BACKGROUND
-- ----------
-- When an Admin updates either:
--   A. Save Funding Details  (PATCH /api/admin/funding-billing)
--      → updates borrower_applications.emd_funded_cents / funded_date
--   B. Save Hard Date        (POST /api/admin/option-cycles/hard-date)
--      → updates crm_deal_option_cycles.deposit_goes_hard_date (cycle 1)
--
-- ...the existing initial Draft invoice snapshot becomes stale.
-- begin_invoice_issuance() will correctly reject the stale Draft with
-- invoice_draft_stale before assigning an invoice number.
--
-- This RPC atomically refreshes the Draft financial snapshot so the
-- Draft is ready for issuance after either save action.
--
-- WHAT THIS RPC DOES
-- ------------------
--   1. Verifies Admin identity via raw_app_meta_data (server-controlled)
--   2. Finds the eligible initial Draft invoice for p_application_id
--   3. Locks the Draft invoice FOR UPDATE
--   4. Re-checks status under the lock (concurrency guard)
--   5. Locks authoritative source rows FOR SHARE
--   6. Validates authoritative source facts
--   7. Calculates canonical deal fee via calculate_deal_fee_cents()
--   8. Validates existing Draft line-item structure
--   9. Updates the EXISTING deal_fee line in place (no delete/reinsert)
--  10. Preserves all discount/waiver lines unchanged
--  11. Recalculates totals from the final line-item set
--  12. Updates only the financial snapshot fields on crm_invoices
--  13. Returns a safe payload (no billing, wire, notes, PDF data)
--
-- WHAT THIS RPC DOES NOT DO
-- -------------------------
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
--   - Does NOT delete or recreate discount lines
--   - Does NOT create an application_activity event
--   - Does NOT call begin_invoice_issuance
--   - Does NOT consume an invoice number
--   - Does NOT modify any issued invoice (issuing/open/partially_paid/paid/void)
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
-- The RPC acquires FOR UPDATE on the Draft invoice row before any mutation.
-- If refresh gets the lock first, begin_invoice_issuance waits and then
-- sees the refreshed data.
-- If begin_invoice_issuance gets the lock first and transitions to issuing,
-- refresh re-checks status under the lock and returns a safe no-op.
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
-- begin_invoice_issuance stale-draft checks remain fully intact.
-- protect_issued_invoice_fields() trigger remains fully intact.
-- protect_issued_invoice_line_items() trigger remains fully intact.
-- validate_invoice_status_transition() trigger remains fully intact.
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call refresh_initial_draft_invoice_snapshot on any real application
--   - call begin_invoice_issuance on any real invoice
--   - consume any invoice number from crm_invoice_number_seq
--   - transition any invoice from draft to issuing
--   - create any activity records
--   - send any emails
--   - generate any PDFs
--   - upload any storage objects
--
-- Expected invoice numbers consumed: 0
-- Expected invoices modified: 0
-- ============================================================


-- ============================================================
-- SECTION 1: refresh_initial_draft_invoice_snapshot RPC
--
-- Signature:
--   public.refresh_initial_draft_invoice_snapshot(
--     p_application_id uuid,
--     p_admin_user_id  uuid
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
--   admin_not_authorized              — p_admin_user_id is not an authorized Admin
--   draft_refresh_ambiguous           — more than one eligible initial Draft found
--   draft_refresh_source_invalid      — authoritative source facts are missing or invalid
--   draft_refresh_line_items_invalid  — Draft line-item structure is invalid or
--                                       discount exceeds subtotal
--
-- Safe no-op results (no exception raised):
--   { "status": "no_draft", ... }       — no eligible Draft exists
--   { "status": "no_longer_draft", ... } — Draft changed state while waiting for lock
--
-- Future API switches on error.message (the stable token).
-- DETAIL provides human-readable context; never contains sensitive data.
-- ============================================================

CREATE OR REPLACE FUNCTION public.refresh_initial_draft_invoice_snapshot(
  p_application_id UUID,
  p_admin_user_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  -- Admin verification
  v_admin_role              TEXT;

  -- Eligible Draft discovery
  v_eligible_count          INTEGER;
  v_draft_invoice_id        UUID;

  -- Invoice row (locked FOR UPDATE)
  v_invoice                 public.crm_invoices%ROWTYPE;

  -- Authoritative source data
  v_app                     RECORD;  -- borrower_applications row
  v_cycle1                  RECORD;  -- crm_deal_option_cycles cycle 1 row

  -- Calculated values
  v_billable_days           INTEGER;
  v_canonical_deal_fee_cents BIGINT;

  -- Line item validation
  v_admin_fee_count         INTEGER;
  v_deal_fee_count          INTEGER;
  v_invalid_type_count      INTEGER;
  v_admin_fee_line          RECORD;

  -- Expected constants (consistent with begin_invoice_issuance and Draft creation)
  v_expected_admin_fee_cents  CONSTANT BIGINT := 250000;
  v_expected_daily_rate_cents CONSTANT BIGINT := 10000;

  -- Recalculated totals
  v_subtotal_cents          BIGINT;
  v_discount_cents          BIGINT;
  v_total_cents             BIGINT;

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
  -- STEP 3: FIND THE ELIGIBLE INITIAL DRAFT
  --
  -- Eligible invoice criteria:
  --   application_id = p_application_id
  --   invoice_type   = 'initial'
  --   status         = 'draft'
  --   replaces_invoice_id IS NULL
  --
  -- Behavior:
  --   0 eligible Drafts → safe no-op (return "no_draft")
  --   1 eligible Draft  → continue
  --   2+ eligible Drafts → fail closed with draft_refresh_ambiguous
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COUNT(*), MIN(id)
  INTO v_eligible_count, v_draft_invoice_id
  FROM public.crm_invoices
  WHERE application_id        = p_application_id
    AND invoice_type          = 'initial'
    AND status                = 'draft'
    AND replaces_invoice_id   IS NULL;

  -- No eligible Draft: safe no-op
  IF v_eligible_count = 0 THEN
    RETURN jsonb_build_object(
      'status',         'no_draft',
      'application_id', p_application_id
    );
  END IF;

  -- Multiple eligible Drafts: fail closed
  IF v_eligible_count > 1 THEN
    RAISE EXCEPTION 'draft_refresh_ambiguous'
      USING ERRCODE = 'P0001',
            DETAIL  = 'More than one eligible initial Draft invoice exists for this application. Cannot safely determine which Draft to refresh.';
  END IF;

  -- Exactly one eligible Draft: v_draft_invoice_id is set, continue.


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: LOCK THE DRAFT INVOICE FOR UPDATE
  --
  -- Acquire an exclusive row lock before any validation or mutation.
  --
  -- Concurrency behavior:
  --   - If refresh gets the lock first, begin_invoice_issuance waits and
  --     then sees the refreshed data.
  --   - If begin_invoice_issuance gets the lock first and transitions the
  --     invoice to issuing, refresh acquires the lock after issuance commits
  --     and the re-check below detects the status change, returning a safe
  --     no-op without mutating the now-issuing invoice.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = v_draft_invoice_id
  FOR UPDATE;

  -- Should always be found since we just discovered it above, but guard anyway.
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status',         'no_draft',
      'application_id', p_application_id
    );
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: RE-CHECK STATUS UNDER THE LOCK
  --
  -- The invoice may have changed state while we were waiting for the lock
  -- (e.g., a concurrent begin_invoice_issuance completed).
  -- Re-verify all eligibility criteria under the lock before mutating.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.status         IS DISTINCT FROM 'draft'
  OR v_invoice.invoice_type   IS DISTINCT FROM 'initial'
  OR v_invoice.replaces_invoice_id IS NOT NULL
  OR v_invoice.application_id IS DISTINCT FROM p_application_id
  THEN
    -- Invoice changed state while waiting for the lock — safe no-op.
    RETURN jsonb_build_object(
      'status',         'no_longer_draft',
      'application_id', p_application_id,
      'invoice_id',     v_draft_invoice_id
    );
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: LOAD AND LOCK AUTHORITATIVE SOURCE DATA
  --
  -- Lock borrower_applications FOR SHARE — prevents concurrent modification
  -- of the authoritative funding facts while we are refreshing the Draft.
  -- Lock crm_deal_option_cycles cycle 1 FOR SHARE — same reason.
  --
  -- Do NOT use requested deposit_amount.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    ba.emd_funded_cents,
    ba.funded_date,
    ba.credit_card_payment_enabled
  INTO v_app
  FROM public.borrower_applications ba
  WHERE ba.id = p_application_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'borrower_applications row for this application could not be found.';
  END IF;

  SELECT
    doc.deposit_goes_hard_date
  INTO v_cycle1
  FROM public.crm_deal_option_cycles doc
  WHERE doc.application_id = p_application_id
    AND doc.cycle_number   = 1
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 option cycle row for this application could not be found.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: VALIDATE AUTHORITATIVE SOURCE FACTS
  --
  -- Require all three authoritative facts to be present and logically valid.
  -- Use stable safe token: draft_refresh_source_invalid
  -- Do not put raw row contents into the exception message.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_app.emd_funded_cents IS NULL OR v_app.emd_funded_cents <= 0 THEN
    RAISE EXCEPTION 'draft_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'emd_funded_cents must be present and greater than zero.';
  END IF;

  IF v_app.funded_date IS NULL THEN
    RAISE EXCEPTION 'draft_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'funded_date is missing on the borrower application.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date IS NULL THEN
    RAISE EXCEPTION 'draft_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cycle 1 deposit_goes_hard_date is missing.';
  END IF;

  IF v_cycle1.deposit_goes_hard_date <= v_app.funded_date THEN
    RAISE EXCEPTION 'draft_refresh_source_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'deposit_goes_hard_date must be after funded_date.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: CALCULATE CANONICAL VALUES IN DATABASE
  --
  -- v_billable_days: PostgreSQL DATE subtraction (not JavaScript Math.round)
  -- v_canonical_deal_fee_cents: via public.calculate_deal_fee_cents()
  --   — do NOT duplicate the fee formula manually.
  --
  -- Expected test case:
  --   EMD:          25000000 cents
  --   Funding:      2026-09-25
  --   Hard Date:    2026-10-25
  --   Billable Days: 30
  --   Deal Fee:     750000 cents ($7,500.00)
  -- ══════════════════════════════════════════════════════════════════════════

  v_billable_days := (v_cycle1.deposit_goes_hard_date - v_app.funded_date);

  v_canonical_deal_fee_cents := public.calculate_deal_fee_cents(
    v_app.emd_funded_cents,
    v_app.funded_date,
    v_cycle1.deposit_goes_hard_date
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: VALIDATE DRAFT LINE-ITEM STRUCTURE
  --
  -- Before changing anything, validate the Draft line-item composition.
  --
  -- Require:
  --   exactly 1 admin_fee line
  --   exactly 1 deal_fee line
  --   zero or more discount lines
  --
  -- Reject any other line_type:
  --   other, extension_admin_fee, extension_deal_fee, or any unknown type
  --
  -- Also validate the admin_fee line amounts are correct.
  -- Do NOT modify the admin_fee line.
  --
  -- NOTE: Plain SELECT (no FOR SHARE) is safe here because the parent
  -- invoice FOR UPDATE lock acquired in STEP 4 serializes all concurrent
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
  WHERE li.invoice_id = v_draft_invoice_id;

  -- Reject any line type outside the permitted set
  IF v_invalid_type_count > 0 THEN
    RAISE EXCEPTION 'draft_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Initial Draft invoice contains line type(s) not permitted for refresh. Only admin_fee, deal_fee, and discount lines are allowed.';
  END IF;

  -- Require exactly 1 admin_fee line
  IF v_admin_fee_count != 1 THEN
    RAISE EXCEPTION 'draft_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Initial Draft invoice must have exactly 1 admin_fee line item.';
  END IF;

  -- Require exactly 1 deal_fee line
  IF v_deal_fee_count != 1 THEN
    RAISE EXCEPTION 'draft_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Initial Draft invoice must have exactly 1 deal_fee line item.';
  END IF;

  -- Validate admin_fee line amounts are correct and unchanged
  SELECT
    li.quantity,
    li.unit_amount_cents,
    li.line_amount_cents
  INTO v_admin_fee_line
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = v_draft_invoice_id
    AND li.line_type  = 'admin_fee';

  IF v_admin_fee_line.quantity          IS DISTINCT FROM 1
  OR v_admin_fee_line.unit_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  OR v_admin_fee_line.line_amount_cents IS DISTINCT FROM v_expected_admin_fee_cents
  THEN
    RAISE EXCEPTION 'draft_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Admin fee line does not match the expected base Administrative Fee (quantity=1, $2,500.00). The draft line items are invalid.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: UPDATE ONLY THE EXISTING DEAL_FEE LINE IN PLACE
  --
  -- Do NOT delete and reinsert the deal_fee row.
  -- Update the EXISTING row so its row ID remains unchanged.
  --
  -- Set:
  --   quantity                    = 1
  --   unit_amount_cents           = canonical deal fee
  --   line_amount_cents           = canonical deal fee
  --   calc_emd_funded_cents       = authoritative emd_funded_cents
  --   calc_daily_rate_per_100k_cents = 10000
  --   calc_billable_days          = v_billable_days
  --   calc_period_start_date      = authoritative funded_date
  --   calc_period_end_date        = authoritative deposit_goes_hard_date
  --
  -- Even if the deal fee dollar amount is numerically unchanged, ALL calc
  -- audit fields must still be refreshed to match the new authoritative dates.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoice_line_items
  SET
    quantity                      = 1,
    unit_amount_cents             = v_canonical_deal_fee_cents,
    line_amount_cents             = v_canonical_deal_fee_cents,
    calc_emd_funded_cents         = v_app.emd_funded_cents,
    calc_daily_rate_per_100k_cents = v_expected_daily_rate_cents,
    calc_billable_days            = v_billable_days,
    calc_period_start_date        = v_app.funded_date,
    calc_period_end_date          = v_cycle1.deposit_goes_hard_date,
    updated_at                    = now()
  WHERE invoice_id = v_draft_invoice_id
    AND line_type  = 'deal_fee';

  -- Guard: the deal_fee row must have been updated
  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'deal_fee line item could not be updated. The line item may have been removed concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: DISCOUNT ROWS ARE PRESERVED
  --
  -- Discount lines (including Admin Fee Waiver and all other discount/waiver
  -- rows) are NOT touched by this RPC. Their row IDs, amounts, and all other
  -- fields remain exactly as they were.
  --
  -- This is enforced by the UPDATE in STEP 10 targeting only line_type = 'deal_fee'.
  -- No DELETE or INSERT on discount rows occurs anywhere in this function.
  -- ══════════════════════════════════════════════════════════════════════════


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: RECALCULATE TOTALS FROM THE FINAL LINE ITEMS
  --
  -- Calculate totals AFTER updating the deal_fee line so the totals reflect
  -- the refreshed deal_fee amount.
  --
  -- subtotal_cents: sum of line_amount_cents for all NON-discount lines
  -- discount_cents: sum of ABS(line_amount_cents) for discount lines
  -- tax_cents:      0
  -- total_cents:    subtotal_cents - discount_cents
  --
  -- Require: discount_cents <= subtotal_cents
  -- Do not silently clamp a negative total.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    COALESCE(SUM(li.line_amount_cents) FILTER (WHERE li.line_type != 'discount'), 0),
    COALESCE(ABS(SUM(li.line_amount_cents) FILTER (WHERE li.line_type = 'discount')), 0)
  INTO
    v_subtotal_cents,
    v_discount_cents
  FROM public.crm_invoice_line_items li
  WHERE li.invoice_id = v_draft_invoice_id;

  -- Discount must not exceed subtotal
  IF v_discount_cents > v_subtotal_cents THEN
    RAISE EXCEPTION 'draft_refresh_line_items_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Total discount exceeds subtotal; invoice total would be negative. Review discount lines before refreshing.';
  END IF;

  v_total_cents := v_subtotal_cents - v_discount_cents;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: UPDATE ONLY THE FINANCIAL SNAPSHOT FIELDS ON crm_invoices
  --
  -- Update ONLY:
  --   emd_funded_cents    — authoritative emd_funded_cents
  --   funding_date        — authoritative funded_date
  --   period_start_date   — authoritative funded_date
  --   period_end_date     — authoritative deposit_goes_hard_date
  --   billable_days       — v_billable_days
  --   subtotal_cents      — recalculated subtotal
  --   discount_cents      — recalculated discounts
  --   tax_cents           — 0
  --   total_cents         — recalculated total
  --   updated_at          — now()
  --
  -- Do NOT modify:
  --   billing_name, billing_contact_name, billing_email
  --   billing_address_line1/2, billing_city, billing_state
  --   billing_postal_code, billing_country
  --   due_date
  --   invoice_notes, internal_notes
  --   invoice_number
  --   wire_instructions_snapshot
  --   credit_card_payment_enabled_snapshot
  --   status
  --   issued_at, issuing_started_at
  --   pdf_storage_path, pdf_generated_at, pdf_hash, pdf_generation_status
  --   created_by
  --
  -- The credit_card_payment_enabled value is snapshotted by
  -- begin_invoice_issuance at issuance time — not here.
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
  WHERE id            = v_draft_invoice_id
    AND status        = 'draft'
    AND invoice_type  = 'initial'
    AND replaces_invoice_id IS NULL
    AND application_id = p_application_id;

  -- Guard: the invoice row must have been updated
  -- (If status changed between the re-check and this UPDATE, the WHERE
  -- clause will not match and NOT FOUND will be true — safe no-op.)
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status',         'no_longer_draft',
      'application_id', p_application_id,
      'invoice_id',     v_draft_invoice_id
    );
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: BUILD SAFE RETURN PAYLOAD
  --
  -- Return only safe financial snapshot fields.
  -- Do NOT return:
  --   billing data
  --   wire data
  --   notes
  --   PDF path or hash
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'status',            'refreshed',
    'application_id',    p_application_id,
    'invoice_id',        v_draft_invoice_id,
    'emd_funded_cents',  v_app.emd_funded_cents,
    'funding_date',      v_app.funded_date,
    'period_start_date', v_app.funded_date,
    'period_end_date',   v_cycle1.deposit_goes_hard_date,
    'billable_days',     v_billable_days,
    'subtotal_cents',    v_subtotal_cents,
    'discount_cents',    v_discount_cents,
    'tax_cents',         0,
    'total_cents',       v_total_cents
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 2: GRANT / REVOKE EXECUTE
--
-- The browser must never call this RPC directly.
-- Only the trusted server-side API (using service_role) may call it.
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders: anon is a named role in Supabase)
REVOKE EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders: authenticated is a named role)
REVOKE EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  TO service_role;
