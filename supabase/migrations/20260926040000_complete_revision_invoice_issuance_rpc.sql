-- ============================================================
-- Migration: 20260926040000_complete_revision_invoice_issuance_rpc
--
-- Step 6A-5R4B — Complete Revision Invoice Issuance RPC
--
-- PURPOSE
-- -------
-- Creates the atomic database RPC that COMPLETES the issuance of a
-- Revision invoice after its PDF has been generated.
--
-- This is the revision-specific counterpart to:
--   public.complete_invoice_issuance()
--
-- It differs from complete_invoice_issuance() in the following ways:
--   - Locks Revision invoice FIRST, then source invoice SECOND
--   - Validates the Revision invoice is a Revision (not a normal invoice)
--   - Validates the source invoice is still OPEN (not yet voided)
--   - Checks source invoice has no blocking payments
--   - Revalidates the revision number relationship
--   - Voids the source invoice FIRST (required by validate_invoice_replacement_integrity)
--   - Sets replaces_invoice_id AFTER source is void (same transaction)
--   - Inserts TWO activity rows: invoice_issued + invoice_voided
--   - Returns a safe payload including both invoice references
--
-- PREREQUISITE MIGRATIONS
-- -----------------------
-- 20260918000000_crm_invoicing_foundation.sql
-- 20260918001000_crm_invoicing_foundation_hardening.sql
-- 20260923000000_begin_invoice_issuance_rpc.sql
-- 20260923001000_invoice_pdf_lifecycle_rpcs.sql
-- 20260925020000_invoice_revision_source_foundation.sql
-- 20260925030000_isolate_revision_drafts_from_normal_initial.sql
-- 20260926010000_refresh_revision_draft_invoice_snapshot_rpc.sql
-- 20260926030000_begin_revision_invoice_issuance_rpc.sql
--
-- REVISION INVOICE DEFINITION (at completion time)
-- -------------------------------------------------
-- A Revision invoice eligible for completion satisfies ALL of:
--   invoice_type               = 'initial'
--   status                     = 'issuing'
--   revision_source_invoice_id IS NOT NULL
--   replaces_invoice_id        IS NULL        (not yet linked)
--   invoice_number             IS NOT NULL AND non-empty
--   issued_at                  IS NULL
--   application_id             IS NOT NULL
--   pdf_generation_status      IN ('pending', 'failed')
--
-- SOURCE INVOICE ELIGIBILITY (at completion time)
-- ------------------------------------------------
-- The source invoice must satisfy ALL of:
--   id                         = revision.revision_source_invoice_id
--   application_id             = revision.application_id
--   invoice_type               = 'initial'
--   status                     = 'open'
--   invoice_number             IS NOT NULL AND non-empty
--   issued_at                  IS NOT NULL
--   pdf_generation_status      = 'generated'
-- AND zero blocking payments (pending/received/refunded).
--
-- LOCK ORDER (deadlock-safe)
-- --------------------------
-- 1. Revision invoice (p_invoice_id)                    — FOR UPDATE
-- 2. Source invoice (revision_source_invoice_id)        — FOR UPDATE
--
-- This order must NEVER be reversed.
--
-- TRANSACTION ATOMICITY
-- ---------------------
-- The following succeed or roll back together in a single transaction:
--   1. Source invoice: status → 'void', voided_at, voided_by, void_reason, updated_at
--   2. Revision invoice: replaces_invoice_id, pdf_*, issued_at, status → 'open', updated_at
--   3. application_activity INSERT: invoice_issued
--   4. application_activity INSERT: invoice_voided
--
-- If any step fails, the entire transaction rolls back:
--   - Source remains 'open'
--   - Revision remains 'issuing'
--   - replaces_invoice_id remains NULL
--   - No activity rows are created
--
-- REPLACEMENT INTEGRITY TRIGGER ORDERING
-- ----------------------------------------
-- validate_invoice_replacement_integrity() requires that
-- replaces_invoice_id can only point at an invoice whose status = 'void'.
-- Therefore the source void UPDATE must occur BEFORE the revision UPDATE
-- that sets replaces_invoice_id — both within the SAME transaction.
-- Because both UPDATEs are in the same transaction, the trigger sees the
-- source as 'void' when it fires on the revision UPDATE.
--
-- CONCURRENCY
-- -----------
-- The FOR UPDATE locks on both invoices serialize concurrent completion
-- attempts. A second concurrent call will block on the Revision lock;
-- after the first commits (Revision status = 'open'), the second will
-- proceed and fail with revision_invoice_not_issuing.
--
-- The source invoice FOR UPDATE lock serializes against payment workflows
-- ONLY if payment recording also locks/updates the invoice row.
-- Future payment implementation must maintain that invariant before
-- creating or finalizing payments.
--
-- IDEMPOTENCY
-- -----------
-- A second call after successful completion will fail with
-- revision_invoice_not_issuing because the Revision is already 'open'.
-- The orchestrator/API reconciles concurrent success by re-fetching
-- and verifying the completed state.
--
-- PDF FAILURE SEMANTICS
-- ---------------------
-- This RPC is only called after a valid PDF object/hash is available.
-- If PDF generation fails before completion, do not call this RPC.
-- Revision stays 'issuing'; source remains 'open'.
-- mark_invoice_pdf_failed() may be used by the future orchestrator.
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
-- begin_revision_invoice_issuance()              — NOT modified
-- complete_invoice_issuance()                    — NOT modified
-- mark_invoice_pdf_failed()                      — NOT modified
-- refresh_initial_draft_invoice_snapshot()       — NOT modified
-- refresh_revision_draft_invoice_snapshot()      — NOT modified
-- create_revision_draft_invoice()                — NOT modified
-- calculate_deal_fee_cents()                     — NOT modified
-- validate_invoice_replacement_integrity()       — NOT modified
-- validate_invoice_revision_source_integrity()   — NOT modified
-- protect_issued_invoice_fields()                — NOT modified
-- protect_issued_invoice_line_items()            — NOT modified
-- validate_invoice_status_transition()           — NOT modified
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - call complete_revision_invoice_issuance on any real invoice
--   - modify EB-2026-000001 or any other invoice row
--   - void the source invoice
--   - assign replaces_invoice_id on the production Revision Draft
--   - consume any invoice number from crm_invoice_number_seq
--   - transition any invoice status
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
-- SECTION 1: complete_revision_invoice_issuance RPC
--
-- Signature:
--   public.complete_revision_invoice_issuance(
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
-- Returns a safe JSONB payload (no wire/billing/notes/PDF path/hash data).
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized              — p_admin_user_id is not an authorized Admin
--   revision_invoice_not_found        — no invoice row found for p_invoice_id
--   revision_invoice_not_issuing      — invoice is not a valid Revision in issuing state
--   revision_source_ineligible        — source invoice is not open/numbered/issued/PDF-generated,
--                                       or has blocking payments (pending/received/refunded)
--   revision_number_relationship_invalid — revision invoice number does not represent
--                                          exactly the next revision after its source
--   revision_pdf_state_invalid        — Revision PDF precondition fields not met
--   revision_pdf_metadata_invalid     — storage path or hash validation failed
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_revision_invoice_issuance(
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

  -- Revision invoice row (locked FOR UPDATE first)
  v_revision                public.crm_invoices%ROWTYPE;

  -- Source invoice row (locked FOR UPDATE second)
  v_source                  public.crm_invoices%ROWTYPE;

  -- Blocking payment count on source invoice
  v_blocking_payment_count  INTEGER;

  -- Invoice number relationship validation
  v_source_base             TEXT;   -- EB-YYYY-NNNNNN portion
  v_source_suffix           TEXT;   -- NULL or single letter B-Z
  v_expected_revision_number TEXT;

  -- Derived expected storage path
  v_expected_path           TEXT;

  -- Normalized hash
  v_normalized_hash         TEXT;

  -- Authoritative timestamp (single v_now for all completion timestamps)
  v_now                     TIMESTAMPTZ;

  -- Source void UPDATE row count guard
  v_source_void_count       INTEGER;

  -- Revision open UPDATE row count guard
  v_revision_open_count     INTEGER;

  -- Return payload
  v_result                  JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
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
  -- STEP 2: LOCK REVISION INVOICE FIRST (FOR UPDATE)
  --
  -- Acquire an exclusive row lock on the Revision invoice BEFORE the source
  -- invoice lock. This lock order must never be reversed.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_revision
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice does not exist.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: VALIDATE REVISION INVOICE IS ELIGIBLE FOR COMPLETION
  --
  -- Must satisfy ALL of:
  --   status                     = 'issuing'
  --   invoice_type               = 'initial'
  --   revision_source_invoice_id IS NOT NULL
  --   replaces_invoice_id        IS NULL
  --   invoice_number             IS NOT NULL and non-empty
  --   issued_at                  IS NULL
  --   application_id             IS NOT NULL
  --   pdf_generation_status      IN ('pending', 'failed')
  --
  -- Do NOT accept a normal invoice (revision_source_invoice_id IS NULL).
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_revision.status != 'issuing' THEN
    RAISE EXCEPTION 'revision_invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice status is not issuing; cannot complete PDF issuance.';
  END IF;

  IF v_revision.invoice_type != 'initial' THEN
    RAISE EXCEPTION 'revision_invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice is not of type initial; cannot complete as a Revision invoice.';
  END IF;

  IF v_revision.revision_source_invoice_id IS NULL THEN
    RAISE EXCEPTION 'revision_invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice has no revision_source_invoice_id; this is a normal invoice, not a Revision.';
  END IF;

  IF v_revision.replaces_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'revision_invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice already has replaces_invoice_id set; it may already be completed.';
  END IF;

  IF v_revision.invoice_number IS NULL OR v_revision.invoice_number = '' THEN
    RAISE EXCEPTION 'revision_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice number is missing; cannot complete PDF issuance.';
  END IF;

  IF v_revision.issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'revision_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice issued_at is already set; invoice may already be open.';
  END IF;

  IF v_revision.application_id IS NULL THEN
    RAISE EXCEPTION 'revision_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice application_id is missing; cannot complete PDF issuance.';
  END IF;

  IF v_revision.pdf_generation_status NOT IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'revision_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice pdf_generation_status is not pending or failed; cannot complete PDF issuance.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: LOCK SOURCE INVOICE SECOND (FOR UPDATE)
  --
  -- Lock order: Revision first, Source second.
  -- This consistent ordering prevents deadlocks with concurrent callers.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_source
  FROM public.crm_invoices
  WHERE id = v_revision.revision_source_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice referenced by revision_source_invoice_id does not exist.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: VALIDATE SOURCE INVOICE ELIGIBILITY
  --
  -- Source must satisfy ALL of:
  --   id                         = revision.revision_source_invoice_id  (already locked)
  --   application_id             = revision.application_id
  --   invoice_type               = 'initial'
  --   status                     = 'open'
  --   invoice_number             IS NOT NULL and non-empty
  --   issued_at                  IS NOT NULL
  --   pdf_generation_status      = 'generated'
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_source.application_id IS DISTINCT FROM v_revision.application_id THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice belongs to a different Deal (application_id mismatch).';
  END IF;

  IF v_source.invoice_type != 'initial' THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice is not of type initial.';
  END IF;

  IF v_source.status != 'open' THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice status is not open; cannot void and replace.';
  END IF;

  IF v_source.invoice_number IS NULL OR v_source.invoice_number = '' THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice has no invoice_number.';
  END IF;

  IF v_source.issued_at IS NULL THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice has no issued_at; it was never fully issued.';
  END IF;

  IF v_source.pdf_generation_status != 'generated' THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice pdf_generation_status is not generated.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: FINAL SOURCE PAYMENT CHECK
  --
  -- While holding the source invoice FOR UPDATE lock, verify there are
  -- zero blocking payments on the source invoice.
  --
  -- Blocking statuses: pending, received, refunded
  -- Non-blocking:      failed (does not block voiding)
  --
  -- This is the final payment safety check before the source becomes void.
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
            DETAIL  = 'Source invoice has blocking payments (pending/received/refunded). Cannot void.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: VALIDATE REVISION NUMBER RELATIONSHIP
  --
  -- Fail closed if the Revision invoice number does not represent exactly
  -- the NEXT revision after its immediate source.
  --
  -- Supported source formats:
  --
  --   A. EB-YYYY-NNNNNN
  --      Expected revision: EB-YYYY-NNNNNN-B
  --
  --   B. EB-YYYY-NNNNNN-[B-Y]
  --      Expected revision: next single letter
  --      Example: source EB-2026-000001-B → revision EB-2026-000001-C
  --               source EB-2026-000001-Y → revision EB-2026-000001-Z
  --
  --   A source ending in -Z cannot have another revision.
  --   (Rejected by begin_revision_invoice_issuance; confirmed here.)
  --
  -- The Revision invoice number was already assigned by
  -- begin_revision_invoice_issuance(), so DO NOT change it here.
  -- This step only validates the existing relationship.
  --
  -- Do NOT call the global sequence.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_source.invoice_number ~ '^EB-[0-9]{4}-[0-9]{6}$' THEN
    -- Format A: base number — expected revision is base + '-B'
    v_source_base   := v_source.invoice_number;
    v_source_suffix := NULL;
    v_expected_revision_number := v_source_base || '-B';

  ELSIF v_source.invoice_number ~ '^EB-[0-9]{4}-[0-9]{6}-[B-Z]$' THEN
    -- Format B: existing revision suffix
    v_source_base   := substring(v_source.invoice_number FROM 1 FOR length(v_source.invoice_number) - 2);
    v_source_suffix := right(v_source.invoice_number, 1);

    -- -Z cannot have another revision
    IF v_source_suffix = 'Z' THEN
      RAISE EXCEPTION 'revision_number_relationship_invalid'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Source invoice number ends in -Z; no further revision suffix is available.';
    END IF;

    -- Next letter: chr(ascii(current) + 1)
    v_expected_revision_number := v_source_base || '-' || chr(ascii(v_source_suffix) + 1);

  ELSE
    RAISE EXCEPTION 'revision_number_relationship_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Source invoice number does not match a supported format (EB-YYYY-NNNNNN or EB-YYYY-NNNNNN-[B-Z]).';
  END IF;

  IF v_revision.invoice_number IS DISTINCT FROM v_expected_revision_number THEN
    RAISE EXCEPTION 'revision_number_relationship_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice number does not represent exactly the next revision after its source.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: VALIDATE REVISION PDF STATE (mirror complete_invoice_issuance)
  --
  -- Re-confirm all preconditions on the locked Revision invoice.
  -- These were checked in STEP 3 but are re-confirmed here before
  -- accepting caller-supplied PDF metadata.
  --
  -- Revision must still have:
  --   status                = 'issuing'
  --   pdf_generation_status IN ('pending', 'failed')
  --   issued_at             IS NULL
  --   invoice_number        non-null/non-empty
  --   application_id        non-null
  --
  -- Existing immutable PDF metadata must not already indicate success.
  -- ══════════════════════════════════════════════════════════════════════════

  -- (All conditions already validated in STEP 3 above.)
  -- Additional guard: existing pdf_storage_path must be NULL (no stale artifact)
  IF v_revision.pdf_storage_path IS NOT NULL THEN
    RAISE EXCEPTION 'revision_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice already has a pdf_storage_path set; cannot overwrite.';
  END IF;

  IF v_revision.pdf_hash IS NOT NULL THEN
    RAISE EXCEPTION 'revision_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice already has a pdf_hash set; cannot overwrite.';
  END IF;

  IF v_revision.pdf_generated_at IS NOT NULL THEN
    RAISE EXCEPTION 'revision_pdf_state_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Revision invoice already has pdf_generated_at set; cannot overwrite.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: VALIDATE DETERMINISTIC PDF STORAGE PATH
  --
  -- The ONLY valid path is exactly:
  --   invoices/{application_id}/{invoice_id}/{invoice_number}.pdf
  -- constructed from the LOCKED Revision invoice.
  --
  -- Example:
  --   invoices/{application_id}/{revision_id}/EB-2026-000001-B.pdf
  --
  -- The application cannot associate a Revision invoice with an arbitrary
  -- storage object. No billing names, emails, or bank data belong in the path.
  -- ══════════════════════════════════════════════════════════════════════════

  v_expected_path := 'invoices/'
    || v_revision.application_id::TEXT
    || '/'
    || v_revision.id::TEXT
    || '/'
    || v_revision.invoice_number
    || '.pdf';

  IF p_pdf_storage_path IS DISTINCT FROM v_expected_path THEN
    RAISE EXCEPTION 'revision_pdf_metadata_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'PDF storage path does not match the expected deterministic path for this Revision invoice.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: VALIDATE SHA-256 HASH (mirror complete_invoice_issuance)
  --
  -- Must be non-null and exactly 64 lowercase hexadecimal characters.
  -- Normalize to lowercase before validation.
  -- Do NOT return the hash in the response payload.
  -- ══════════════════════════════════════════════════════════════════════════

  IF p_pdf_hash IS NULL THEN
    RAISE EXCEPTION 'revision_pdf_metadata_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'PDF hash is required.';
  END IF;

  -- Normalize to lowercase
  v_normalized_hash := lower(p_pdf_hash);

  -- Must be exactly 64 hexadecimal characters
  IF v_normalized_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'revision_pdf_metadata_invalid'
      USING ERRCODE = 'P0001',
            DETAIL  = 'PDF hash must be exactly 64 lowercase hexadecimal characters (SHA-256).';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: CAPTURE ONE AUTHORITATIVE TIMESTAMP
  --
  -- Use exactly one v_now for all completion timestamps in this transaction.
  --
  -- Used for:
  --   Revision: pdf_generated_at, issued_at, updated_at
  --   Source:   voided_at, updated_at
  --
  -- Activities receive DB created_at behavior (no explicit timestamp needed).
  -- ══════════════════════════════════════════════════════════════════════════

  v_now := now();


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: VOID SOURCE INVOICE FIRST
  --
  -- This ordering is REQUIRED by validate_invoice_replacement_integrity().
  -- The trigger checks that replaces_invoice_id points at a 'void' invoice.
  -- By voiding the source FIRST (within the same transaction), the trigger
  -- will see status = 'void' when the Revision UPDATE fires.
  --
  -- The source void UPDATE is NOT independently committed.
  -- It is part of the same transaction as all following Revision changes.
  -- If anything later fails, the source MUST roll back to OPEN.
  --
  -- Fail-closed WHERE clause requires:
  --   id     = v_source.id
  --   status = 'open'
  --
  -- void_reason identifies the superseding Revision invoice.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    status      = 'void',
    voided_at   = v_now,
    voided_by   = p_admin_user_id,
    void_reason = 'Superseded by ' || v_revision.invoice_number,
    updated_at  = v_now
  WHERE id     = v_source.id
    AND status = 'open';

  GET DIAGNOSTICS v_source_void_count = ROW_COUNT;

  IF v_source_void_count != 1 THEN
    RAISE EXCEPTION 'revision_source_ineligible'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to void source invoice. The source invoice may have been modified concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: SET REVISION REPLACEMENT LINK AND OPEN REVISION
  --
  -- AFTER source status has been changed to 'void' inside the same
  -- transaction, update the locked Revision invoice.
  --
  -- validate_invoice_replacement_integrity() will fire on this UPDATE
  -- (triggered by UPDATE OF replaces_invoice_id) and will see the source
  -- as 'void' because both UPDATEs are in the same transaction.
  --
  -- Fields set:
  --   replaces_invoice_id    = v_source.id
  --   pdf_storage_path       = deterministic path
  --   pdf_generated_at       = v_now
  --   pdf_hash               = normalized SHA-256
  --   pdf_generation_status  = 'generated'
  --   pdf_generation_error   = NULL
  --   issued_at              = v_now
  --   status                 = 'open'
  --   updated_at             = v_now
  --
  -- Fields NOT modified:
  --   revision_source_invoice_id  — preserved permanently for audit history
  --   invoice_number              — immutable after begin_revision_invoice_issuance
  --   billing snapshot fields     — immutable after draft
  --   financial snapshot fields   — immutable after draft
  --   line items                  — immutable after draft
  --   wire_instructions_snapshot  — immutable after draft
  --   credit_card_payment_enabled_snapshot — immutable after draft
  --   due_date                    — immutable after draft
  --   invoice_notes               — immutable after draft
  --
  -- Fail-closed WHERE clause requires:
  --   id                         = p_invoice_id
  --   status                     = 'issuing'
  --   revision_source_invoice_id = v_source.id
  --   replaces_invoice_id        IS NULL
  --   invoice_number             = locked revision invoice number
  --   issued_at                  IS NULL
  --   pdf_generation_status      IN ('pending', 'failed')
  --   pdf_storage_path           IS NULL   (defense-in-depth: no stale artifact)
  --   pdf_generated_at           IS NULL   (defense-in-depth: no stale artifact)
  --   pdf_hash                   IS NULL   (defense-in-depth: no stale artifact)
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    replaces_invoice_id    = v_source.id,
    pdf_storage_path       = v_expected_path,
    pdf_generated_at       = v_now,
    pdf_hash               = v_normalized_hash,
    pdf_generation_status  = 'generated',
    pdf_generation_error   = NULL,
    issued_at              = v_now,
    status                 = 'open',
    updated_at             = v_now
  WHERE id                         = p_invoice_id
    AND status                     = 'issuing'
    AND revision_source_invoice_id = v_source.id
    AND replaces_invoice_id        IS NULL
    AND invoice_number             = v_revision.invoice_number
    AND issued_at                  IS NULL
    AND pdf_generation_status      IN ('pending', 'failed')
    AND pdf_storage_path           IS NULL
    AND pdf_generated_at           IS NULL
    AND pdf_hash                   IS NULL;

  GET DIAGNOSTICS v_revision_open_count = ROW_COUNT;

  IF v_revision_open_count != 1 THEN
    -- This failure automatically rolls back the source void UPDATE above.
    RAISE EXCEPTION 'revision_invoice_not_issuing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to transition Revision invoice to open status. The invoice may have been modified concurrently.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: ATOMIC ACTIVITY — REVISION ISSUED
  --
  -- Insert an application_activity row for the Revision invoice inside
  -- the SAME transaction.
  --
  -- 'invoice_issued' is already permitted by the existing CHECK constraint
  -- (added in 20260918000000_crm_invoicing_foundation.sql).
  -- No constraint change is required.
  --
  -- Safe metadata includes only invoice lifecycle fields.
  -- Excluded: bank data, wire snapshot, billing data, PDF path, PDF hash,
  --           payment data.
  --
  -- If this INSERT fails, the entire transaction rolls back:
  --   source remains OPEN, revision remains ISSUING, replaces_invoice_id NULL.
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
    v_revision.application_id,
    p_admin_user_id,
    'invoice_issued',
    'Invoice issued: ' || v_revision.invoice_number,
    'Invoice ' || v_revision.invoice_number || ' has been issued and is now open.',
    'EarnestBridge Admin',
    jsonb_build_object(
      'invoice_id',                  p_invoice_id,
      'invoice_number',              v_revision.invoice_number,
      'revision_source_invoice_id',  v_revision.revision_source_invoice_id,
      'source_invoice_number',       v_source.invoice_number
    )
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 15: ATOMIC ACTIVITY — SOURCE VOIDED / SUPERSEDED
  --
  -- Insert a second application_activity row inside the SAME transaction.
  --
  -- Uses existing allowed event_type 'invoice_voided'.
  -- Do NOT add a new event type.
  --
  -- The detail and metadata identify the reason as supersession.
  --
  -- Safe metadata includes only invoice lifecycle fields.
  -- Excluded: bank data, wire snapshot, billing data, PDF path, PDF hash,
  --           payment data.
  --
  -- If this INSERT fails, the entire transaction rolls back:
  --   source remains OPEN, revision remains ISSUING, replaces_invoice_id NULL.
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
    v_source.application_id,
    p_admin_user_id,
    'invoice_voided',
    'Invoice superseded: ' || v_source.invoice_number,
    'Superseded by ' || v_revision.invoice_number,
    'EarnestBridge Admin',
    jsonb_build_object(
      'invoice_id',                      v_source.id,
      'invoice_number',                  v_source.invoice_number,
      'superseded_by_invoice_id',        p_invoice_id,
      'superseded_by_invoice_number',    v_revision.invoice_number
    )
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 16: BUILD SAFE RETURN PAYLOAD
  --
  -- Return only non-secret lifecycle fields needed by the server API.
  --
  -- Excluded: pdf_storage_path, pdf_hash, wire_instructions_snapshot,
  --           routing/account numbers, billing address, billing email,
  --           internal_notes, payment rows.
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    -- Revision invoice fields
    'invoice_id',                  p_invoice_id,
    'invoice_number',              v_revision.invoice_number,
    'status',                      'open',
    'revision_source_invoice_id',  v_revision.revision_source_invoice_id,
    'replaces_invoice_id',         v_source.id,
    'issued_at',                   v_now,
    'pdf_generated_at',            v_now,
    'pdf_generation_status',       'generated',
    'total_cents',                 v_revision.total_cents,
    -- Source invoice fields
    'source_invoice_id',           v_source.id,
    'source_invoice_number',       v_source.invoice_number,
    'source_status',               'void'
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 2: GRANT / REVOKE EXECUTE ON complete_revision_invoice_issuance
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.complete_revision_invoice_issuance(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.complete_revision_invoice_issuance(UUID, UUID, TEXT, TEXT)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.complete_revision_invoice_issuance(UUID, UUID, TEXT, TEXT)
  FROM authenticated;

-- Grant ONLY to service_role
GRANT EXECUTE ON FUNCTION public.complete_revision_invoice_issuance(UUID, UUID, TEXT, TEXT)
  TO service_role;


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION REPORT (6A-5R4B — Complete Revision Invoice Issuance RPC)
-- ---------------------------------------------------------------------
-- Migration file: 20260926040000_complete_revision_invoice_issuance_rpc.sql
-- Historical migration files modified: NO
-- Supabase deployment performed: NO
--
-- ── RPC ───────────────────────────────────────────────────────────────────
-- complete_revision_invoice_issuance() created:        YES
-- Existing complete_invoice_issuance() modified:       NO
--
-- ── LOCK ORDER ────────────────────────────────────────────────────────────
-- Revision invoice locked first:                       YES (FOR UPDATE)
-- Source invoice locked second:                        YES (FOR UPDATE)
-- Lock order consistent (deadlock-safe):               YES
--
-- ── SOURCE VALIDATION ─────────────────────────────────────────────────────
-- Source must still be OPEN:                           YES
-- Source blocking payment statuses:                    pending, received, refunded
-- Failed payments ignored:                             YES
--
-- ── REVISION NUMBER RELATIONSHIP ──────────────────────────────────────────
-- Revision number relationship revalidated:            YES
-- Base EB-YYYY-NNNNNN → -B:                            YES
-- Existing -B → -C, -Y → -Z:                          YES
-- -Z rejected:                                         YES (revision_number_relationship_invalid)
-- Malformed source number rejected:                    YES (revision_number_relationship_invalid)
-- Global invoice sequence used:                        NO
--
-- ── PDF VALIDATION ────────────────────────────────────────────────────────
-- Deterministic PDF path validated:                    YES
--   invoices/{application_id}/{invoice_id}/{invoice_number}.pdf
-- SHA-256 hash validated:                              YES (64 hex chars, normalized lower)
-- Existing stale PDF artifact checked:                 YES (pdf_storage_path/pdf_generated_at/pdf_hash must be NULL)
--
-- ── TIMESTAMP ─────────────────────────────────────────────────────────────
-- Single v_now used:                                   YES
-- Used for Revision pdf_generated_at, issued_at, updated_at: YES
-- Used for Source voided_at, updated_at:               YES
--
-- ── TRANSACTION ATOMICITY ─────────────────────────────────────────────────
-- Source voided before replaces_invoice_id set:        YES
-- Source void fields set (voided_at, voided_by, void_reason): YES
-- Revision replaces_invoice_id set:                    YES
-- revision_source_invoice_id preserved:                YES (NOT modified)
-- Revision transitions issuing → open:                 YES
-- Source transitions open → void:                      YES
-- Source PDF preserved:                                YES (NOT modified)
-- Revision PDF metadata stored:                        YES
-- Failure rolls back source void:                      YES (same transaction)
--
-- ── ACTIVITIES ────────────────────────────────────────────────────────────
-- invoice_issued activity atomic:                      YES
-- invoice_voided activity atomic:                      YES
-- New activity event type added:                       NO
-- Second completion does not duplicate activities:     YES (fails with revision_invoice_not_issuing)
--
-- ── RETURN PAYLOAD ────────────────────────────────────────────────────────
-- Safe return payload:                                 YES
-- Sensitive PDF/wire/billing data returned:            NO
--
-- ── SECURITY ──────────────────────────────────────────────────────────────
-- SECURITY DEFINER:                                    YES
-- Hardened search_path:                                YES (public, pg_catalog)
-- Admin uses raw_app_meta_data:                        YES
-- service_role only execute:                           YES
--
-- ── EXISTING FUNCTIONS ────────────────────────────────────────────────────
-- Existing RPCs modified:                              NO
-- Existing triggers modified:                          NO
-- Business data modified by migration:                 NO
-- Production Revision RPC called:                      NO
-- Supabase deployment performed:                       NO
-- Safe to review:                                      YES
-- ============================================================
