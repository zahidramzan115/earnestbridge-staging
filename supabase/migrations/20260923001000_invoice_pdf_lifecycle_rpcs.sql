-- ============================================================
-- Migration: 20260923001000_invoice_pdf_lifecycle_rpcs
--
-- Step 6A-5C2 / 6A-5C2.1 — Atomic Invoice PDF Completion / Failure RPCs
--
-- AMENDMENT (6A-5C2.1)
-- --------------------
-- mark_invoice_pdf_failed: NULL failure code now explicitly rejected.
-- The original validation used only:
--   IF p_failure_code NOT IN (...)
-- PostgreSQL evaluates NULL NOT IN (...) as NULL (not TRUE), so a NULL
-- p_failure_code would silently bypass the whitelist check.
-- Fixed to:
--   IF p_failure_code IS NULL
--   OR p_failure_code NOT IN (...)
-- NULL failure code rejected: YES
--
-- PURPOSE
-- -------
-- Creates two atomic SECURITY DEFINER RPCs needed after PDF generation:
--
--   1. public.complete_invoice_issuance(
--        p_invoice_id       uuid,
--        p_admin_user_id    uuid,
--        p_pdf_storage_path text,
--        p_pdf_hash         text
--      )
--      Atomically transitions an issuing invoice to open status,
--      setting all PDF metadata fields and issued_at in one transaction.
--      Also inserts an invoice_issued activity row in the same transaction.
--
--   2. public.mark_invoice_pdf_failed(
--        p_invoice_id    uuid,
--        p_admin_user_id uuid,
--        p_failure_code  text
--      )
--      Records a whitelisted PDF failure code while leaving the invoice
--      in issuing status so the same invoice number can be retried.
--
-- PREREQUISITE MIGRATION
-- ----------------------
-- 20260923000000_begin_invoice_issuance_rpc.sql must already be deployed.
-- This migration does NOT modify that migration.
--
-- APPLICATION_ACTIVITY SCHEMA AUDIT
-- ----------------------------------
-- Audited live schema from 20260412200000_activity_feed.sql and
-- subsequent migrations. Findings:
--
-- Columns:
--   id             uuid PK
--   application_id text NOT NULL
--   user_id        uuid NULL (FK auth.users — stores actor Admin UUID)
--   event_type     text NOT NULL (CHECK constraint — see below)
--   title          text NOT NULL
--   detail         text NULL
--   actor          text NOT NULL DEFAULT 'System' (human-readable actor name)
--   metadata       jsonb DEFAULT '{}'
--   created_at     timestamptz NOT NULL
--   source_id      uuid NULL (added in 20260917000100 for idempotency)
--
-- CHECK constraint on event_type (as of 20260918000000_crm_invoicing_foundation.sql):
--   event_type = ANY (ARRAY[
--     'status_change', 'document_upload', 'admin_note', 'deadline_shift',
--     'system', 'document_revision_uploaded', 'revision_requested',
--     'document_approved', 'owner_assigned', 'task_created', 'email_sent',
--     'call_logged', 'deadline_created', 'deadline_updated',
--     'deadline_completed', 'deadline_cancelled', 'deadline_reopened',
--     'option_cycle_created', 'option_exercised',
--     'extension_amendment_received', 'extension_fee_paid',
--     'option_cycle_extended', 'option_cycle_missed',
--     'extension_override_accepted',
--     'invoice_created', 'invoice_issued', 'invoice_voided',
--     'invoice_replaced', 'payment_received', 'invoice_paid',
--     'payment_refunded', 'receipt_generated'
--   ])
--
-- 'invoice_issued' IS ALREADY PERMITTED by the existing constraint.
-- No constraint change is required.
-- No constraint change is made in this migration.
--
-- Actor pattern (from existing server code):
--   user_id = Admin auth UUID (p_admin_user_id)
--   actor   = human-readable name (e.g., 'EarnestBridge Admin')
--
-- SECURITY
-- --------
-- Both RPCs use:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
-- Admin authorization uses ONLY raw_app_meta_data->>'role' = 'admin'
-- (server-controlled, never user-editable metadata)
-- EXECUTE is REVOKED from PUBLIC, anon, and authenticated.
-- EXECUTE is GRANTED only to service_role.
-- The browser must never call these RPCs directly.
--
-- STORAGE IMMUTABILITY NOTE
-- -------------------------
-- Future PDF orchestration MUST upload issued invoice PDFs with:
--   upsert: false
-- Issued PDFs are immutable. The DB completion RPC protects invoice state,
-- but storage immutability must also be protected at the object layer.
--
-- Future retry behavior:
--   A. No object exists in storage
--      → upload with upsert: false
--
--   B. Object already exists AND invoice is still issuing
--      → fetch/read existing object server-side and verify/reuse it
--      → do NOT blindly overwrite with upsert: true
--
--   C. Invoice already open (status = 'open')
--      → never upload or replace the PDF object
--
-- Do NOT implement storage code in this migration.
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call complete_invoice_issuance on any real invoice
--   - call mark_invoice_pdf_failed on any real invoice
--   - call begin_invoice_issuance on any real invoice
--   - consume any invoice number from crm_invoice_number_seq
--   - transition any invoice from issuing to open
--   - create any activity records
--   - send any emails
--   - generate any PDFs
--   - upload any storage objects
--
-- Expected invoice numbers consumed: 0
-- Expected invoices opened: 0
-- ============================================================


-- ============================================================
-- SECTION 1: complete_invoice_issuance()
--
-- Atomically completes PDF generation and opens an issuing invoice.
--
-- Signature:
--   public.complete_invoice_issuance(
--     p_invoice_id       uuid,
--     p_admin_user_id    uuid,
--     p_pdf_storage_path text,
--     p_pdf_hash         text
--   )
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Returns a safe JSON subset (no wire secrets, no storage path, no hash).
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized          — p_admin_user_id is not an authorized Admin
--   invoice_not_found             — invoice row does not exist
--   invoice_not_issuing           — invoice status is not 'issuing'
--   invoice_pdf_state_invalid     — precondition on invoice fields not met
--   invoice_pdf_metadata_invalid  — storage path or hash validation failed
--
-- Future API switches on error.message (the stable token).
-- DETAIL provides human-readable context; never contains wire secrets.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_invoice_issuance(
  p_invoice_id       UUID,
  p_admin_user_id    UUID,
  p_pdf_storage_path TEXT,
  p_pdf_hash         TEXT
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

  -- Derived expected storage path
  v_expected_path           TEXT;

  -- Normalized hash
  v_normalized_hash         TEXT;

  -- Authoritative timestamp (single v_now for all fields)
  v_now                     TIMESTAMPTZ;

  -- Return payload
  v_result                  JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
  -- Use raw_app_meta_data (server-controlled) — never user_metadata.
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
  -- A concurrent second completion attempt will block here and, after the
  -- first request commits (status = 'open'), will proceed to the status
  -- check below and fail with invoice_not_issuing — never rewriting an
  -- already-open invoice.
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


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: REQUIRE STATUS = 'issuing'
  -- The invoice must be in issuing state.
  -- An already-open/paid/void invoice must never be rewritten.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.status != 'issuing' THEN
    RAISE EXCEPTION 'invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice status is not issuing; cannot complete PDF issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: VALIDATE COMPLETION PRECONDITIONS
  -- All preconditions must be met before accepting any caller-supplied data.
  -- ══════════════════════════════════════════════════════════════════════════

  -- invoice_number must be assigned and non-empty
  IF v_invoice.invoice_number IS NULL OR v_invoice.invoice_number = '' THEN
    RAISE EXCEPTION 'invoice_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice number is missing; cannot complete PDF issuance.';
  END IF;

  -- application_id must be present
  IF v_invoice.application_id IS NULL THEN
    RAISE EXCEPTION 'invoice_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice application_id is missing; cannot complete PDF issuance.';
  END IF;

  -- pdf_generation_status must be pending or failed (allows retry)
  IF v_invoice.pdf_generation_status NOT IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'invoice_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice pdf_generation_status is not pending or failed; cannot complete PDF issuance.';
  END IF;

  -- issued_at must be NULL (invoice must not already be open)
  IF v_invoice.issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice issued_at is already set; invoice may already be open.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: VALIDATE DETERMINISTIC STORAGE PATH
  -- The ONLY valid path is exactly:
  --   invoices/{application_id}/{invoice_id}/{invoice_number}.pdf
  -- constructed from the locked invoice row.
  -- The application cannot associate an invoice with an arbitrary storage object.
  -- No billing names, emails, or bank data belong in the path.
  -- ══════════════════════════════════════════════════════════════════════════

  v_expected_path := 'invoices/'
    || v_invoice.application_id::TEXT
    || '/'
    || v_invoice.id::TEXT
    || '/'
    || v_invoice.invoice_number
    || '.pdf';

  IF p_pdf_storage_path IS DISTINCT FROM v_expected_path THEN
    RAISE EXCEPTION 'invoice_pdf_metadata_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'PDF storage path does not match the expected deterministic path for this invoice.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: VALIDATE SHA-256 HASH
  -- Must be non-null and exactly 64 lowercase hexadecimal characters.
  -- Normalize to lowercase before validation.
  -- ══════════════════════════════════════════════════════════════════════════

  IF p_pdf_hash IS NULL THEN
    RAISE EXCEPTION 'invoice_pdf_metadata_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'PDF hash is required.';
  END IF;

  -- Normalize to lowercase
  v_normalized_hash := lower(p_pdf_hash);

  -- Must be exactly 64 hexadecimal characters
  IF v_normalized_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invoice_pdf_metadata_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'PDF hash must be exactly 64 lowercase hexadecimal characters (SHA-256).';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: CAPTURE AUTHORITATIVE TIMESTAMP
  -- One v_now is used for pdf_generated_at, issued_at, and updated_at.
  -- The caller does NOT supply a timestamp.
  -- The PDF's visible Issue Date derives from the immutable
  -- issuing_started_at / business date snapshot set by begin_invoice_issuance.
  -- ══════════════════════════════════════════════════════════════════════════

  v_now := now();


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: ATOMIC COMPLETION UPDATE
  -- Set all PDF metadata fields, issued_at, and status = 'open' in one UPDATE.
  -- The existing triggers permit this because OLD.status = 'issuing':
  --   - validate_invoice_status_transition() allows issuing → open
  --   - protect_issued_invoice_fields() does not block workflow fields
  --     (pdf_storage_path, pdf_generated_at, pdf_hash, pdf_generation_status,
  --      pdf_generation_error, issued_at, status, updated_at are all mutable
  --      while OLD.status = 'issuing')
  -- Immutable financial/billing/wire snapshot fields are NOT modified.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    pdf_storage_path      = v_expected_path,
    pdf_generated_at      = v_now,
    pdf_hash              = v_normalized_hash,
    pdf_generation_status = 'generated',
    pdf_generation_error  = NULL,
    issued_at             = v_now,
    status                = 'open',
    updated_at            = v_now
  WHERE id = p_invoice_id
    AND status = 'issuing';

  -- Guard against unexpected concurrent change
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to transition invoice to open status. The invoice may have been modified concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: ATOMIC invoice_issued ACTIVITY INSERT
  -- Insert the Deal-level invoice_issued activity in the SAME transaction.
  -- If this INSERT fails, the entire transaction rolls back so the invoice
  -- does NOT become open without its audit activity.
  --
  -- 'invoice_issued' is already permitted by the existing CHECK constraint
  -- (added in 20260918000000_crm_invoicing_foundation.sql).
  -- No constraint change is required.
  --
  -- Actor pattern follows existing server code:
  --   user_id = Admin auth UUID (p_admin_user_id)
  --   actor   = 'EarnestBridge Admin'
  --
  -- Safe metadata includes only invoice_id and invoice_number.
  -- Wire snapshot, routing/account numbers, and bank settings are excluded.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.application_activity (
    application_id,
    user_id,
    event_type,
    title,
    detail,
    actor,
    metadata
  ) VALUES (
    v_invoice.application_id,
    p_admin_user_id,
    'invoice_issued',
    'Invoice issued: ' || v_invoice.invoice_number,
    'Invoice ' || v_invoice.invoice_number || ' has been issued and is now open.',
    'EarnestBridge Admin',
    jsonb_build_object(
      'invoice_id',     p_invoice_id,
      'invoice_number', v_invoice.invoice_number
    )
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: BUILD SAFE RETURN PAYLOAD
  -- Return only non-secret fields needed by the server API.
  -- Excluded: wire_instructions_snapshot, pdf_hash, pdf_storage_path,
  --           routing/account data, billing secrets.
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'invoice_id',            p_invoice_id,
    'invoice_number',        v_invoice.invoice_number,
    'status',                'open',
    'issued_at',             v_now,
    'pdf_generated_at',      v_now,
    'pdf_generation_status', 'generated',
    'total_cents',           v_invoice.total_cents
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 2: GRANT / REVOKE EXECUTE ON complete_invoice_issuance
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.complete_invoice_issuance(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.complete_invoice_issuance(UUID, UUID, TEXT, TEXT)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.complete_invoice_issuance(UUID, UUID, TEXT, TEXT)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.complete_invoice_issuance(UUID, UUID, TEXT, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 3: mark_invoice_pdf_failed()
--
-- Records a whitelisted PDF failure code while leaving the invoice
-- in issuing status so the same invoice number can be retried.
--
-- Signature:
--   public.mark_invoice_pdf_failed(
--     p_invoice_id    uuid,
--     p_admin_user_id uuid,
--     p_failure_code  text
--   )
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Returns a safe JSON subset.
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized           — p_admin_user_id is not an authorized Admin
--   invoice_not_found              — invoice row does not exist
--   invoice_not_issuing            — invoice status is not 'issuing'
--   invoice_pdf_state_invalid      — precondition on invoice fields not met
--   invoice_pdf_failure_code_invalid — p_failure_code is not in the whitelist
--
-- Whitelisted failure codes:
--   pdf_generation_failed
--   pdf_upload_failed
--   pdf_storage_read_failed
--   pdf_completion_failed
--
-- Only whitelisted tokens are stored in pdf_generation_error.
-- Raw exception messages, stack traces, wire data, and filesystem paths
-- are never stored.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_invoice_pdf_failed(
  p_invoice_id    UUID,
  p_admin_user_id UUID,
  p_failure_code  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  -- Admin verification
  v_admin_role  TEXT;

  -- Invoice row (locked FOR UPDATE)
  v_invoice     public.crm_invoices%ROWTYPE;

  -- Authoritative timestamp
  v_now         TIMESTAMPTZ;

  -- Return payload
  v_result      JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
  -- Use raw_app_meta_data (server-controlled) — never user_metadata.
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
  -- STEP 2: VALIDATE FAILURE CODE WHITELIST
  -- Only safe, pre-approved tokens may be stored in pdf_generation_error.
  -- Raw exception messages, stack traces, wire data, routing/account numbers,
  -- filesystem paths, and Supabase raw errors are never accepted.
  -- ══════════════════════════════════════════════════════════════════════════

  IF p_failure_code IS NULL
  OR p_failure_code NOT IN (
    'pdf_generation_failed',
    'pdf_upload_failed',
    'pdf_storage_read_failed',
    'pdf_completion_failed'
  ) THEN
    RAISE EXCEPTION 'invoice_pdf_failure_code_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_failure_code is not in the permitted whitelist.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: LOCK INVOICE ROW FOR UPDATE
  -- Acquire an exclusive row lock before any validation.
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


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: REQUIRE STATUS = 'issuing'
  -- Cannot mark an open/paid/void invoice as failed.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.status != 'issuing' THEN
    RAISE EXCEPTION 'invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice status is not issuing; cannot mark PDF generation as failed.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: VALIDATE FAILURE PRECONDITIONS
  -- ══════════════════════════════════════════════════════════════════════════

  -- invoice_number must be assigned and non-empty (retry reuses same number)
  IF v_invoice.invoice_number IS NULL OR v_invoice.invoice_number = '' THEN
    RAISE EXCEPTION 'invoice_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice number is missing; cannot mark PDF generation as failed.';
  END IF;

  -- pdf_generation_status must be pending or failed (allows re-marking on retry)
  IF v_invoice.pdf_generation_status NOT IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'invoice_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice pdf_generation_status is not pending or failed; cannot mark as failed.';
  END IF;

  -- issued_at must be NULL
  IF v_invoice.issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice issued_at is already set; invoice may already be open.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: CAPTURE AUTHORITATIVE TIMESTAMP
  -- ══════════════════════════════════════════════════════════════════════════

  v_now := now();


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: FAILURE UPDATE
  -- Set only pdf_generation_status and pdf_generation_error.
  -- Leave unchanged:
  --   status = 'issuing'
  --   invoice_number (retry reuses same number)
  --   issued_at = NULL
  --   pdf_storage_path (unchanged — may be NULL or partial)
  --   pdf_generated_at (unchanged)
  --   pdf_hash (unchanged)
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    pdf_generation_status = 'failed',
    pdf_generation_error  = p_failure_code,
    updated_at            = v_now
  WHERE id = p_invoice_id
    AND status = 'issuing';

  -- Guard against unexpected concurrent change
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to record PDF failure. The invoice may have been modified concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: BUILD SAFE RETURN PAYLOAD
  -- Return only safe fields. No raw PDF/storage/wire metadata.
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'invoice_id',            p_invoice_id,
    'invoice_number',        v_invoice.invoice_number,
    'status',                'issuing',
    'pdf_generation_status', 'failed'
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 4: GRANT / REVOKE EXECUTE ON mark_invoice_pdf_failed
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.mark_invoice_pdf_failed(UUID, UUID, TEXT)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.mark_invoice_pdf_failed(UUID, UUID, TEXT)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.mark_invoice_pdf_failed(UUID, UUID, TEXT)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.mark_invoice_pdf_failed(UUID, UUID, TEXT)
  TO service_role;


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION SUMMARY (6A-5C2 — Invoice PDF Lifecycle RPCs)
-- ---------------------------------------------------------
-- Migration file: 20260923001000_invoice_pdf_lifecycle_rpcs.sql
--
-- ── APPLICATION_ACTIVITY SCHEMA AUDIT ────────────────────────────────────
-- Schema audited:                  YES
-- invoice_issued already allowed:  YES (added in 20260918000000)
-- Activity constraint changed:     NO (not needed)
-- invoice_issued atomic with open: YES (same transaction in complete_invoice_issuance)
--
-- ── complete_invoice_issuance ─────────────────────────────────────────────
-- Function created:                public.complete_invoice_issuance(uuid, uuid, text, text)
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
-- Invoice locked FOR UPDATE:       YES (both RPCs)
-- Second completion attempt fails: YES (sees status='open', invoice_not_issuing)
--
-- ── PRECONDITIONS ─────────────────────────────────────────────────────────
-- status = 'issuing' required:     YES
-- invoice_number non-empty:        YES
-- application_id non-null:         YES
-- pdf_generation_status IN (pending, failed): YES
-- issued_at IS NULL:               YES
--
-- ── DETERMINISTIC PATH VALIDATION ────────────────────────────────────────
-- Path validated in DB:            YES
-- Expected path format:            invoices/{application_id}/{invoice_id}/{invoice_number}.pdf
-- Arbitrary storage path accepted: NO
--
-- ── SHA-256 VALIDATION ────────────────────────────────────────────────────
-- Hash validated:                  YES (non-null, exactly 64 hex chars)
-- Normalized to lowercase:         YES
--
-- ── AUTHORITATIVE TIMESTAMP ───────────────────────────────────────────────
-- Single v_now captured:           YES
-- pdf_generated_at set by DB:      YES (v_now)
-- issued_at set by DB:             YES (v_now)
-- Same v_now used for both:        YES
-- Caller-supplied timestamp:       NOT ACCEPTED
--
-- ── ATOMIC COMPLETION ─────────────────────────────────────────────────────
-- issuing → open atomic:           YES
-- Wire snapshot modified:          NO
-- Immutable snapshot fields modified: NO
-- invoice_issued activity atomic:  YES (same transaction)
--
-- ── SAFE RETURN PAYLOAD ───────────────────────────────────────────────────
-- wire_instructions_snapshot returned: NO
-- pdf_hash returned:               NO
-- pdf_storage_path returned:       NO
-- routing/account data returned:   NO
-- Safe fields returned:            invoice_id, invoice_number, status,
--                                  issued_at, pdf_generated_at,
--                                  pdf_generation_status, total_cents
--
-- ── mark_invoice_pdf_failed ───────────────────────────────────────────────
-- Function created:                public.mark_invoice_pdf_failed(uuid, uuid, text)
-- SECURITY DEFINER:                YES
-- search_path hardened:            YES (public, pg_catalog)
-- EXECUTE PUBLIC revoked:          YES
-- EXECUTE anon revoked:            YES
-- EXECUTE authenticated revoked:   YES
-- EXECUTE service_role granted:    YES
--
-- ── FAILURE CODE WHITELIST ────────────────────────────────────────────────
-- Failure code whitelisted:        YES
-- NULL failure code rejected:      YES (explicit IS NULL check before NOT IN)
-- Whitelist:                       pdf_generation_failed, pdf_upload_failed,
--                                  pdf_storage_read_failed, pdf_completion_failed
-- Raw error text accepted:         NO
-- Stack traces stored:             NO
-- Wire data stored:                NO
--
-- ── FAILURE BEHAVIOR ──────────────────────────────────────────────────────
-- Failure leaves status issuing:   YES
-- Failure leaves invoice_number:   UNCHANGED
-- Failure leaves issued_at NULL:   YES
-- invoice_issued activity on fail: NO
--
-- ── STORAGE IMMUTABILITY ──────────────────────────────────────────────────
-- PDF upload upsert:true recommended: NO
-- Required future upload behavior: upsert: false
-- Retry behavior documented:       YES (see STORAGE IMMUTABILITY NOTE above)
--
-- ── SCOPE EXCLUSIONS ──────────────────────────────────────────────────────
-- RPCs executed:                   NO
-- Real invoice mutated:            NO
-- Invoice numbers consumed:        0
-- PDF generated:                   NO
-- Email sent:                      NO
-- begin_invoice_issuance called:   NO
-- complete_invoice_issuance called: NO
-- mark_invoice_pdf_failed called:  NO
-- Issue API modified:              NO
-- Issue button added:              NO
-- pdf-lib installed:               NO
-- Supabase deployment required:    YES
-- Netlify redeploy required:       NO
-- Safe to push migration:          YES
-- ============================================================
