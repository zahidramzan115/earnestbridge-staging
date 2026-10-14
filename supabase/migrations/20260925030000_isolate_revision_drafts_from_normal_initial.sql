-- ============================================================
-- Migration: 20260925030000_isolate_revision_drafts_from_normal_initial
--
-- Step 6A-5R2B1 — Isolate Revision Drafts From Normal Initial DB Logic
--
-- PURPOSE
-- -------
-- Ensures Revision Drafts (invoice_type = 'initial',
-- revision_source_invoice_id IS NOT NULL, replaces_invoice_id IS NULL)
-- are completely invisible to the normal-initial refresh and issuance
-- paths.
--
-- BACKGROUND
-- ----------
-- Migration 20260925020000_invoice_revision_source_foundation added:
--   crm_invoices.revision_source_invoice_id UUID NULL
--
-- A normal initial invoice has:
--   invoice_type                 = 'initial'
--   revision_source_invoice_id   IS NULL
--   replaces_invoice_id          IS NULL
--
-- A Revision Draft has:
--   invoice_type                 = 'initial'
--   revision_source_invoice_id   IS NOT NULL
--   replaces_invoice_id          IS NULL
--
-- Without this migration, both functions would treat Revision Drafts
-- as eligible normal initial invoices because they share the same
-- invoice_type and replaces_invoice_id IS NULL predicate.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Replaces refresh_initial_draft_invoice_snapshot() with a version
--    that adds revision_source_invoice_id IS NULL to:
--      A. STEP 3 — Draft discovery query (array_agg predicate)
--      B. STEP 5 — Locked re-check (IF guard)
--      C. STEP 13 — Final UPDATE WHERE clause
--
-- 2. Replaces begin_invoice_issuance() with a version that adds
--    revision_source_invoice_id IS NOT NULL to the STEP 3 type guard,
--    raising the existing stable invoice_type_not_supported error token.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- --------------------------------
-- - Does NOT modify complete_invoice_issuance()
-- - Does NOT modify mark_invoice_pdf_failed()
-- - Does NOT modify calculate_deal_fee_cents()
-- - Does NOT modify validate_invoice_revision_source_integrity()
-- - Does NOT modify validate_invoice_replacement_integrity()
-- - Does NOT modify protect_issued_invoice_fields()
-- - Does NOT modify protect_issued_invoice_line_items()
-- - Does NOT modify validate_invoice_status_transition()
-- - Does NOT modify invoice numbering behavior
-- - Does NOT modify PDF lifecycle, storage, payments, or activities
-- - Does NOT create any revision-specific issuance RPC
-- - Does NOT create any Create Revision API
-- - Does NOT modify any application or UI files
-- - Does NOT modify any historical migration files
--
-- REGRESSION SAFETY
-- -----------------
-- Normal initial Draft (revision_source_invoice_id = NULL):
--   → refresh_initial_draft_invoice_snapshot: still eligible (unchanged)
--   → begin_invoice_issuance: still eligible (unchanged)
--
-- Revision Draft (revision_source_invoice_id IS NOT NULL):
--   → refresh_initial_draft_invoice_snapshot: excluded (new guard)
--   → begin_invoice_issuance: rejected with invoice_type_not_supported
--
-- SECURITY
-- --------
-- Both replacements retain:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
-- Admin authorization remains based only on raw_app_meta_data.role = 'admin'.
-- No user_metadata authorization.
-- EXECUTE permissions remain service_role only.
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call either function against any real invoice
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
-- SECTION 1: REPLACE refresh_initial_draft_invoice_snapshot()
--
-- Identical to the current production definition (from migration
-- 20260925010000_fix_refresh_draft_uuid_discovery.sql) with exactly
-- three additive changes:
--
--   A. STEP 3 discovery query: adds
--        AND revision_source_invoice_id IS NULL
--
--   B. STEP 5 locked re-check: adds
--        OR v_invoice.revision_source_invoice_id IS NOT NULL
--
--   C. STEP 13 final UPDATE WHERE clause: adds
--        AND revision_source_invoice_id IS NULL
--
-- All other logic, security, and behavior is preserved exactly.
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

  -- Eligible Draft discovery (UUID-safe)
  v_eligible_ids            UUID[];
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
  -- STEP 3: FIND THE ELIGIBLE NORMAL INITIAL DRAFT (UUID-SAFE)
  --
  -- Uses array_agg(id) + cardinality() — UUID-safe (no MIN on UUID).
  --
  -- Eligible invoice criteria:
  --   application_id             = p_application_id
  --   invoice_type               = 'initial'
  --   status                     = 'draft'
  --   replaces_invoice_id        IS NULL
  --   revision_source_invoice_id IS NULL   ← NEW: excludes Revision Drafts
  --
  -- A Revision Draft has revision_source_invoice_id IS NOT NULL and must
  -- never enter the normal-initial refresh path.
  --
  -- Behavior:
  --   0 eligible Drafts  → safe no-op (return "no_draft")
  --   1 eligible Draft   → v_draft_invoice_id := v_eligible_ids[1]; continue
  --   2+ eligible Drafts → fail closed with draft_refresh_ambiguous
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT array_agg(id)
  INTO v_eligible_ids
  FROM public.crm_invoices
  WHERE application_id             = p_application_id
    AND invoice_type               = 'initial'
    AND status                     = 'draft'
    AND replaces_invoice_id        IS NULL
    AND revision_source_invoice_id IS NULL;

  v_eligible_count := COALESCE(cardinality(v_eligible_ids), 0);

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

  -- Exactly one eligible Draft: extract the single UUID
  v_draft_invoice_id := v_eligible_ids[1];


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
  --
  -- NEW: Also reject if revision_source_invoice_id IS NOT NULL.
  -- A Revision Draft must never be refreshed through this path even if
  -- it somehow passed the STEP 3 discovery predicate.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.status                        IS DISTINCT FROM 'draft'
  OR v_invoice.invoice_type                  IS DISTINCT FROM 'initial'
  OR v_invoice.replaces_invoice_id           IS NOT NULL
  OR v_invoice.revision_source_invoice_id    IS NOT NULL
  OR v_invoice.application_id               IS DISTINCT FROM p_application_id
  THEN
    -- Invoice changed state or is a Revision Draft — safe no-op.
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
  --   EMD:           25000000 cents
  --   Funding:       2026-09-25
  --   Hard Date:     2026-10-25
  --   Billable Days: 30
  --   Deal Fee:      750000 cents ($7,500.00)
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
  --   quantity                       = 1
  --   unit_amount_cents              = canonical deal fee
  --   line_amount_cents              = canonical deal fee
  --   calc_emd_funded_cents          = authoritative emd_funded_cents
  --   calc_daily_rate_per_100k_cents = 10000
  --   calc_billable_days             = v_billable_days
  --   calc_period_start_date         = authoritative funded_date
  --   calc_period_end_date           = authoritative deposit_goes_hard_date
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
  -- NEW: revision_source_invoice_id IS NULL added to WHERE clause.
  -- This is the final UPDATE-level guard ensuring a Revision Draft can
  -- never be mutated through this path even under extreme concurrency.
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
  WHERE id                           = v_draft_invoice_id
    AND status                       = 'draft'
    AND invoice_type                 = 'initial'
    AND replaces_invoice_id          IS NULL
    AND revision_source_invoice_id   IS NULL
    AND application_id               = p_application_id;

  -- Guard: the invoice row must have been updated
  -- (If status changed between the re-check and this UPDATE, or if the
  -- invoice is a Revision Draft, the WHERE clause will not match and
  -- NOT FOUND will be true — safe no-op.)
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
-- SECTION 1B: GRANT / REVOKE EXECUTE ON refresh_initial_draft_invoice_snapshot
--
-- CREATE OR REPLACE resets privileges; re-apply grants.
-- The browser must never call this RPC directly.
-- Only the trusted server-side API (using service_role) may call it.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.refresh_initial_draft_invoice_snapshot(UUID, UUID)
  TO service_role;


-- ============================================================
-- SECTION 2: REPLACE begin_invoice_issuance()
--
-- Identical to the current production definition (from migration
-- 20260923000000_begin_invoice_issuance_rpc.sql) with exactly one
-- additive change:
--
--   STEP 3 type guard: adds
--     OR v_invoice.revision_source_invoice_id IS NOT NULL
--
--   so the full normal-initial guard becomes:
--     invoice_type != 'initial'
--     OR replaces_invoice_id IS NOT NULL
--     OR revision_source_invoice_id IS NOT NULL
--
--   raising the existing stable invoice_type_not_supported error token.
--
-- All other logic, security, and behavior is preserved exactly.
-- No second normal issuance path is introduced.
-- Revision invoices will later use begin_revision_invoice_issuance()
-- which does not exist yet.
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
  -- STEP 3: NORMAL INITIAL INVOICE TYPE GUARD
  --
  -- This step supports only normal initial invoices:
  --   invoice_type               = 'initial'
  --   replaces_invoice_id        IS NULL
  --   revision_source_invoice_id IS NULL   ← NEW: rejects Revision Drafts
  --
  -- A Revision Draft has revision_source_invoice_id IS NOT NULL and must
  -- never enter the normal initial issuance path. Revision invoices will
  -- later use begin_revision_invoice_issuance() which does not exist yet.
  --
  -- Extension, other, and replacement issuance are not yet implemented.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.invoice_type != 'initial'
  OR v_invoice.replaces_invoice_id IS NOT NULL
  OR v_invoice.revision_source_invoice_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'invoice_type_not_supported'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Only normal initial invoices (type=initial, replaces_invoice_id IS NULL, revision_source_invoice_id IS NULL) are supported by this issuance path. Revision invoices must use begin_revision_invoice_issuance().';
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
-- SECTION 2B: GRANT / REVOKE EXECUTE ON begin_invoice_issuance
--
-- CREATE OR REPLACE resets privileges; re-apply grants.
-- The browser must never call this RPC directly.
-- Only the trusted server-side API (using service_role) may call it.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.begin_invoice_issuance(UUID, UUID)
  TO service_role;


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION SUMMARY (6A-5R2B1)
-- -----------------------------------------------
-- Migration file: 20260925030000_isolate_revision_drafts_from_normal_initial.sql
-- Historical migrations modified: NO
--
-- ── refresh_initial_draft_invoice_snapshot ────────────────────────────────
-- Function replaced:                        YES (CREATE OR REPLACE)
-- STEP 3 discovery requires IS NULL:        YES (revision_source_invoice_id IS NULL added)
-- STEP 5 locked re-check rejects revision:  YES (OR v_invoice.revision_source_invoice_id IS NOT NULL)
-- STEP 13 final UPDATE guard requires IS NULL: YES (AND revision_source_invoice_id IS NULL)
-- UUID array_agg/cardinality fix preserved: YES (no MIN(id) on UUID)
-- All other logic unchanged:                YES
-- SECURITY DEFINER preserved:               YES
-- Hardened search_path preserved:           YES
-- service_role EXECUTE model preserved:     YES
--
-- ── begin_invoice_issuance ────────────────────────────────────────────────
-- Function replaced:                        YES (CREATE OR REPLACE)
-- STEP 3 type guard updated:                YES
-- Normal issuance requires IS NULL:         YES (revision_source_invoice_id IS NOT NULL → reject)
-- Revision Draft rejected:                  YES (invoice_type_not_supported)
-- Stable error token:                       invoice_type_not_supported
-- Second normal issuance path introduced:   NO
-- All other logic unchanged:                YES
-- SECURITY DEFINER preserved:               YES
-- Hardened search_path preserved:           YES
-- service_role EXECUTE model preserved:     YES
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- complete_invoice_issuance modified:       NO
-- mark_invoice_pdf_failed modified:         NO
-- calculate_deal_fee_cents modified:        NO
-- validate_invoice_revision_source_integrity modified: NO
-- validate_invoice_replacement_integrity modified: NO
-- protect_issued_invoice_fields modified:   NO
-- Invoice numbering modified:               NO
-- PDF lifecycle modified:                   NO
-- Storage modified:                         NO
-- Payments modified:                        NO
-- Activities modified:                      NO
-- API files modified:                       NO
-- UI files modified:                        NO
-- Business data modified:                   NO
-- Supabase deployment performed:            NO
-- ============================================================
