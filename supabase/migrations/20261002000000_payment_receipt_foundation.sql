-- ============================================================
-- Migration: 20261002000000_payment_receipt_foundation
--
-- Phase 7B-9D — Receipt Database + RPC Foundation
--
-- PURPOSE
-- -------
-- Implements the complete database and RPC foundation for
-- immutable payment receipts. This migration is DATABASE ONLY.
--
-- CHANGES IN THIS MIGRATION
-- -------------------------
-- 1.  Add crm_payments.amount_paid_after_cents BIGINT NULL
-- 2.  Add crm_payments.balance_remaining_after_cents BIGINT NULL
-- 3.  Add crm_payments.receipt_number TEXT NULL
-- 4.  Add crm_payments.receipt_issued_at TIMESTAMPTZ NULL
-- 5.  Add CHECK constraints for snapshot co-presence and value ranges
-- 6.  Add CHECK constraint for receipt identity co-presence
-- 7.  Add CHECK constraint for receipt PDF completion co-presence
-- 7b. Add CHECK constraint crm_payments_receipt_completion_requires_identity
--     (PDF completion requires receipt identity — Phase 7B-9D1 correction)
-- 8.  Create public.receipt_number_seq (global, never resets)
-- 9.  Harden sequence permissions (REVOKE from PUBLIC/anon/authenticated)
-- 10. Create UNIQUE partial index on receipt_number WHERE NOT NULL
-- 11. Safe dual-source legacy backfill from application_activity + audit_logs
--     (hardened: both sources bound to payment.id AND payment.invoice_id;
--      length<=19 pre-check before any NUMERIC/BIGINT cast — Phase 7B-9D1)
-- 12. CREATE OR REPLACE record_invoice_payment() — add snapshot fields to INSERT
-- 13. CREATE OR REPLACE protect_completed_payment_facts() — extend immutability
--     (hardened: snapshot fields fully immutable for any non-pending payment,
--      regardless of NULL/non-NULL — Phase 7B-9D1 correction)
-- 14. Create guard_receipt_write_once trigger function + trigger
-- 15. Create prepare_receipt_generation() SECURITY DEFINER RPC
--     (hardened: defensive invariant check before already_complete return
--      — Phase 7B-9D1 correction)
-- 16. Create complete_receipt_generation() SECURITY DEFINER RPC
-- 17. REVOKE/GRANT permissions on new RPCs and sequence
--
-- ZERO BUSINESS DATA MUTATION (except safe legacy backfill)
-- ----------------------------------------------------------
-- This migration does NOT:
--   - generate any receipt PDFs
--   - modify any application files
--   - create any API routes
--   - modify Admin UI or Client Portal
--   - deploy to Netlify or Supabase
--   - send emails
--
-- ORIGINAL MIGRATIONS NOT MODIFIED
-- ---------------------------------
-- 20260918000000_crm_invoicing_foundation.sql  — NOT modified
-- 20260918001000_crm_invoicing_foundation_hardening.sql — NOT modified
-- 20260930000000_record_invoice_payment_rpc.sql — NOT modified
-- All other historical migrations — NOT modified
--
-- SECURITY
-- --------
-- prepare_receipt_generation and complete_receipt_generation use:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
-- EXECUTE is REVOKED from PUBLIC, anon, and authenticated.
-- EXECUTE is GRANTED only to service_role.
-- receipt_number_seq USAGE is REVOKED from PUBLIC, anon, authenticated.
-- USAGE is GRANTED only to service_role.
-- ============================================================


-- ============================================================
-- SECTION 1: NEW crm_payments COLUMNS
--
-- amount_paid_after_cents:
--   The cumulative total of all received payments for this invoice
--   IMMEDIATELY AFTER this payment was recorded. Captured atomically
--   inside record_invoice_payment() under the invoice FOR UPDATE lock.
--   Immutable once set. NULL for legacy payments that could not be
--   safely backfilled.
--
-- balance_remaining_after_cents:
--   The invoice balance remaining IMMEDIATELY AFTER this payment.
--   = invoice.total_cents - amount_paid_after_cents
--   Immutable once set. NULL for legacy payments that could not be
--   safely backfilled.
--
-- receipt_number:
--   Human-readable receipt identifier. Format: EBR-{YEAR}-{NNNNNN}
--   Allocated by prepare_receipt_generation() via receipt_number_seq.
--   Write-once: NULL → value allowed; value → cannot change or clear.
--
-- receipt_issued_at:
--   Database timestamp at which the receipt number was first allocated
--   (set atomically with receipt_number in prepare_receipt_generation).
--   Printed on the receipt PDF as the "Receipt Date / Issued At" field.
--   Write-once: NULL → value allowed; value → cannot change or clear.
--   NOT the same as receipt_pdf_generated_at (which is operational metadata).
-- ============================================================

ALTER TABLE public.crm_payments
  ADD COLUMN IF NOT EXISTS amount_paid_after_cents       BIGINT NULL,
  ADD COLUMN IF NOT EXISTS balance_remaining_after_cents BIGINT NULL,
  ADD COLUMN IF NOT EXISTS receipt_number                TEXT NULL,
  ADD COLUMN IF NOT EXISTS receipt_issued_at             TIMESTAMPTZ NULL;


-- ============================================================
-- SECTION 2: SNAPSHOT CHECK CONSTRAINTS
--
-- A. Co-presence: both NULL or both non-NULL.
--    Legacy rows with both NULL remain valid.
--
-- B. Value ranges when populated:
--    amount_paid_after_cents > 0 (a received payment must be positive)
--    balance_remaining_after_cents >= 0 (cannot be negative)
-- ============================================================

ALTER TABLE public.crm_payments
  ADD CONSTRAINT crm_payments_snapshot_copresence CHECK (
    (amount_paid_after_cents IS NULL) = (balance_remaining_after_cents IS NULL)
  ),
  ADD CONSTRAINT crm_payments_amount_paid_after_positive CHECK (
    amount_paid_after_cents IS NULL OR amount_paid_after_cents > 0
  ),
  ADD CONSTRAINT crm_payments_balance_remaining_after_nonneg CHECK (
    balance_remaining_after_cents IS NULL OR balance_remaining_after_cents >= 0
  );


-- ============================================================
-- SECTION 3: RECEIPT IDENTITY CO-PRESENCE CONSTRAINT
--
-- receipt_number and receipt_issued_at must be either:
--   BOTH NULL  — receipt not yet prepared
--   BOTH non-NULL — receipt identity assigned
--
-- A payment with a receipt number but no issued timestamp (or vice versa)
-- is never valid.
-- ============================================================

ALTER TABLE public.crm_payments
  ADD CONSTRAINT crm_payments_receipt_identity_copresence CHECK (
    (receipt_number IS NULL) = (receipt_issued_at IS NULL)
  );


-- ============================================================
-- SECTION 4: RECEIPT PDF COMPLETION CO-PRESENCE CONSTRAINT
--
-- receipt_pdf_storage_path, receipt_pdf_generated_at, receipt_pdf_hash
-- must be either:
--   ALL NULL  — receipt PDF not yet generated
--   ALL non-NULL — receipt PDF generation complete
--
-- No partially completed receipt metadata state is valid.
-- ============================================================

ALTER TABLE public.crm_payments
  ADD CONSTRAINT crm_payments_receipt_pdf_copresence CHECK (
    (receipt_pdf_storage_path IS NULL)
      = (receipt_pdf_generated_at IS NULL)
    AND
    (receipt_pdf_storage_path IS NULL)
      = (receipt_pdf_hash IS NULL)
  );


-- ============================================================
-- SECTION 4B: RECEIPT COMPLETION REQUIRES IDENTITY CONSTRAINT
--
-- If the receipt PDF is complete (receipt_pdf_storage_path IS NOT NULL),
-- receipt identity MUST already exist (receipt_number and receipt_issued_at
-- must both be non-NULL).
--
-- Checking receipt_pdf_storage_path is sufficient because the PDF co-presence
-- constraint already guarantees all three receipt_pdf_* fields move together.
--
-- Valid states:
--   receipt_number = NULL, receipt_issued_at = NULL, receipt_pdf_* = all NULL
--     → no receipt prepared yet
--   receipt_number != NULL, receipt_issued_at != NULL, receipt_pdf_* = all NULL
--     → prepared but not yet completed (valid)
--   receipt_number != NULL, receipt_issued_at != NULL, receipt_pdf_* = all non-NULL
--     → fully complete (valid)
--
-- Impossible state (rejected by this constraint):
--   receipt_number = NULL, receipt_issued_at = NULL, receipt_pdf_* = all non-NULL
--     → PDF complete without identity (invalid)
-- ============================================================

ALTER TABLE public.crm_payments
  ADD CONSTRAINT crm_payments_receipt_completion_requires_identity CHECK (
    receipt_pdf_storage_path IS NULL
    OR (
      receipt_number IS NOT NULL
      AND receipt_issued_at IS NOT NULL
    )
  );


-- ============================================================
-- SECTION 5: RECEIPT NUMBER SEQUENCE
--
-- Global sequence, never resets.
-- Counter increments continuously across year boundaries.
-- The year prefix in the receipt number format is cosmetic/informational.
-- The sequence is the uniqueness guarantee.
--
-- Example:
--   Last receipt of 2026: EBR-2026-000847
--   First receipt of 2027: EBR-2027-000848
--
-- Permissions hardened:
--   REVOKE from PUBLIC, anon, authenticated
--   GRANT USAGE only to service_role
--   Only prepare_receipt_generation() (SECURITY DEFINER) may call nextval().
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS public.receipt_number_seq
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

-- Harden sequence permissions
REVOKE ALL ON SEQUENCE public.receipt_number_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.receipt_number_seq FROM anon;
REVOKE ALL ON SEQUENCE public.receipt_number_seq FROM authenticated;

-- Only service_role (trusted server path) may use the sequence.
-- The SECURITY DEFINER prepare_receipt_generation() runs as the
-- function owner (typically postgres/service_role) and can call nextval().
GRANT USAGE ON SEQUENCE public.receipt_number_seq TO service_role;


-- ============================================================
-- SECTION 6: RECEIPT NUMBER UNIQUENESS
--
-- Partial unique index: uniqueness enforced only for non-NULL values.
-- Multiple NULL rows are valid (payments without receipts yet).
-- Defense-in-depth beyond sequence behavior alone.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS crm_payments_receipt_number_unique
  ON public.crm_payments (receipt_number)
  WHERE receipt_number IS NOT NULL;


-- ============================================================
-- SECTION 7: SAFE LEGACY SNAPSHOT BACKFILL
--
-- For each existing crm_payments row with status = 'received':
--
-- Require EXACTLY ONE matching application_activity row where:
--   event_type = 'payment_received'
--   metadata->>'payment_id' = payment.id::TEXT
--
-- AND EXACTLY ONE matching audit_logs row where:
--   resource_type = 'invoice'
--   new_value->>'payment_id' = payment.id::TEXT
--   event_type IN ('status_change', 'edit')
--
-- Both sources must agree on:
--   amount_paid_cents
--   balance_remaining_cents
--
-- Safe JSON casting: validate before casting to BIGINT.
--   - key must exist
--   - value must match digits-only integer format
--   - value must fit BIGINT range
--   - amount_paid_cents must be > 0
--   - balance_remaining_cents must be >= 0
--
-- FAIL CLOSED PER ROW: if any condition fails, leave BOTH NULL.
-- The migration continues; no row failure aborts the migration.
-- ============================================================

DO $$
DECLARE
  v_payment RECORD;

  -- application_activity source
  v_act_amount_paid_text       TEXT;
  v_act_balance_remaining_text TEXT;
  v_act_amount_paid            BIGINT;
  v_act_balance_remaining      BIGINT;
  v_act_count                  INT;

  -- audit_logs source
  v_aud_amount_paid_text       TEXT;
  v_aud_balance_remaining_text TEXT;
  v_aud_amount_paid            BIGINT;
  v_aud_balance_remaining      BIGINT;
  v_aud_count                  INT;

BEGIN
  FOR v_payment IN
    SELECT id, invoice_id
    FROM public.crm_payments
    WHERE status = 'received'
      AND amount_paid_after_cents IS NULL
      AND balance_remaining_after_cents IS NULL
  LOOP

    -- ── Reset per-row variables ──────────────────────────────────────────
    v_act_amount_paid_text       := NULL;
    v_act_balance_remaining_text := NULL;
    v_act_amount_paid            := NULL;
    v_act_balance_remaining      := NULL;
    v_act_count                  := 0;

    v_aud_amount_paid_text       := NULL;
    v_aud_balance_remaining_text := NULL;
    v_aud_amount_paid            := NULL;
    v_aud_balance_remaining      := NULL;
    v_aud_count                  := 0;

    -- ── SOURCE 1: application_activity ──────────────────────────────────
    -- Count matching payment_received activity rows for this payment_id AND invoice_id.
    -- Require EXACTLY ONE row bound to both payment.id and payment.invoice_id.
    SELECT COUNT(*)
    INTO v_act_count
    FROM public.application_activity
    WHERE event_type = 'payment_received'
      AND metadata->>'payment_id' = v_payment.id::TEXT
      AND metadata->>'invoice_id' = v_payment.invoice_id::TEXT;

    -- Fail closed: must be exactly one match
    IF v_act_count != 1 THEN
      CONTINUE;
    END IF;

    -- Extract raw text values from the single matching row
    SELECT
      metadata->>'amount_paid_cents',
      metadata->>'balance_remaining_cents'
    INTO
      v_act_amount_paid_text,
      v_act_balance_remaining_text
    FROM public.application_activity
    WHERE event_type = 'payment_received'
      AND metadata->>'payment_id' = v_payment.id::TEXT
      AND metadata->>'invoice_id' = v_payment.invoice_id::TEXT
    LIMIT 1;

    -- Fail closed: both keys must exist
    IF v_act_amount_paid_text IS NULL OR v_act_balance_remaining_text IS NULL THEN
      CONTINUE;
    END IF;

    -- Fail closed: both values must be digits-only integers
    IF v_act_amount_paid_text !~ '^[0-9]+$' THEN
      CONTINUE;
    END IF;
    IF v_act_balance_remaining_text !~ '^[0-9]+$' THEN
      CONTINUE;
    END IF;

    -- Fail closed: length <= 19 before any numeric/bigint cast.
    -- A 19-digit string may still exceed BIGINT max; the range check below
    -- handles that. But strings longer than 19 digits can never be valid
    -- BIGINTs and must be rejected before any cast to avoid overflow.
    IF LENGTH(v_act_amount_paid_text) > 19 THEN
      CONTINUE;
    END IF;
    IF LENGTH(v_act_balance_remaining_text) > 19 THEN
      CONTINUE;
    END IF;

    -- Fail closed: if length = 19, require value <= 9223372036854775807
    -- using safe text comparison (no cast of potentially oversized value).
    IF LENGTH(v_act_amount_paid_text) = 19
       AND v_act_amount_paid_text > '9223372036854775807' THEN
      CONTINUE;
    END IF;
    IF LENGTH(v_act_balance_remaining_text) = 19
       AND v_act_balance_remaining_text > '9223372036854775807' THEN
      CONTINUE;
    END IF;

    -- Fail closed: values must fit BIGINT range
    IF (v_act_amount_paid_text::NUMERIC) > 9223372036854775807 THEN
      CONTINUE;
    END IF;
    IF (v_act_balance_remaining_text::NUMERIC) > 9223372036854775807 THEN
      CONTINUE;
    END IF;

    -- Cast to BIGINT (safe after validation)
    v_act_amount_paid       := v_act_amount_paid_text::BIGINT;
    v_act_balance_remaining := v_act_balance_remaining_text::BIGINT;

    -- Fail closed: business value constraints
    IF v_act_amount_paid <= 0 THEN
      CONTINUE;
    END IF;
    IF v_act_balance_remaining < 0 THEN
      CONTINUE;
    END IF;

    -- ── SOURCE 2: audit_logs ─────────────────────────────────────────────
    -- Count matching audit_logs rows for this payment_id AND invoice_id.
    -- Require EXACTLY ONE row bound to both new_value->>'payment_id' and
    -- resource_id = payment.invoice_id::text.
    -- The record_invoice_payment RPC writes event_type = 'status_change'
    -- when invoice status changes, or 'edit' when it does not change.
    -- Both are valid; do NOT require only 'status_change'.
    SELECT COUNT(*)
    INTO v_aud_count
    FROM public.audit_logs
    WHERE resource_type = 'invoice'
      AND event_type IN ('status_change', 'edit')
      AND new_value->>'payment_id' = v_payment.id::TEXT
      AND resource_id = v_payment.invoice_id::TEXT;

    -- Fail closed: must be exactly one match
    IF v_aud_count != 1 THEN
      CONTINUE;
    END IF;

    -- Extract raw text values from the single matching audit row
    SELECT
      new_value->>'amount_paid_cents',
      new_value->>'balance_remaining_cents'
    INTO
      v_aud_amount_paid_text,
      v_aud_balance_remaining_text
    FROM public.audit_logs
    WHERE resource_type = 'invoice'
      AND event_type IN ('status_change', 'edit')
      AND new_value->>'payment_id' = v_payment.id::TEXT
      AND resource_id = v_payment.invoice_id::TEXT
    LIMIT 1;

    -- Fail closed: both keys must exist
    IF v_aud_amount_paid_text IS NULL OR v_aud_balance_remaining_text IS NULL THEN
      CONTINUE;
    END IF;

    -- Fail closed: both values must be digits-only integers
    IF v_aud_amount_paid_text !~ '^[0-9]+$' THEN
      CONTINUE;
    END IF;
    IF v_aud_balance_remaining_text !~ '^[0-9]+$' THEN
      CONTINUE;
    END IF;

    -- Fail closed: length <= 19 before any numeric/bigint cast.
    IF LENGTH(v_aud_amount_paid_text) > 19 THEN
      CONTINUE;
    END IF;
    IF LENGTH(v_aud_balance_remaining_text) > 19 THEN
      CONTINUE;
    END IF;

    -- Fail closed: if length = 19, require value <= 9223372036854775807
    -- using safe text comparison (no cast of potentially oversized value).
    IF LENGTH(v_aud_amount_paid_text) = 19
       AND v_aud_amount_paid_text > '9223372036854775807' THEN
      CONTINUE;
    END IF;
    IF LENGTH(v_aud_balance_remaining_text) = 19
       AND v_aud_balance_remaining_text > '9223372036854775807' THEN
      CONTINUE;
    END IF;

    -- Fail closed: values must fit BIGINT range
    IF (v_aud_amount_paid_text::NUMERIC) > 9223372036854775807 THEN
      CONTINUE;
    END IF;
    IF (v_aud_balance_remaining_text::NUMERIC) > 9223372036854775807 THEN
      CONTINUE;
    END IF;

    -- Cast to BIGINT (safe after validation)
    v_aud_amount_paid       := v_aud_amount_paid_text::BIGINT;
    v_aud_balance_remaining := v_aud_balance_remaining_text::BIGINT;

    -- Fail closed: business value constraints
    IF v_aud_amount_paid <= 0 THEN
      CONTINUE;
    END IF;
    IF v_aud_balance_remaining < 0 THEN
      CONTINUE;
    END IF;

    -- ── CROSS-SOURCE AGREEMENT CHECK ─────────────────────────────────────
    -- Both sources must agree exactly on both values.
    -- If they disagree, leave NULL (fail closed).
    IF v_act_amount_paid != v_aud_amount_paid THEN
      CONTINUE;
    END IF;
    IF v_act_balance_remaining != v_aud_balance_remaining THEN
      CONTINUE;
    END IF;

    -- ── BACKFILL ─────────────────────────────────────────────────────────
    -- Both sources agree. Populate the snapshot columns.
    UPDATE public.crm_payments
    SET
      amount_paid_after_cents       = v_act_amount_paid,
      balance_remaining_after_cents = v_act_balance_remaining
    WHERE id = v_payment.id
      AND amount_paid_after_cents IS NULL
      AND balance_remaining_after_cents IS NULL;

  END LOOP;
END;
$$;


-- ============================================================
-- SECTION 8: EXTEND protect_completed_payment_facts()
--
-- Extend the existing trigger function to make the new snapshot
-- fields (amount_paid_after_cents, balance_remaining_after_cents)
-- immutable once set.
--
-- These fields are set at INSERT time (status = 'received').
-- The trigger fires on UPDATE. Once non-NULL, they cannot change.
--
-- The existing core-fact immutability logic is preserved exactly.
-- Operational metadata (notes, receipt_pdf_*, updated_at, status)
-- remains updateable as before.
--
-- New snapshot fields follow the same "once set, never change" rule.
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_completed_payment_facts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_any_core_fact_changed BOOLEAN;
BEGIN
  -- Only enforce once the payment has left pending status
  IF OLD.status = 'pending' THEN
    RETURN NEW;
  END IF;

  -- Check whether any core historical fact changed
  v_any_core_fact_changed :=
       NEW.invoice_id          IS DISTINCT FROM OLD.invoice_id
    OR NEW.payment_method      IS DISTINCT FROM OLD.payment_method
    OR NEW.amount_cents        IS DISTINCT FROM OLD.amount_cents
    OR NEW.currency            IS DISTINCT FROM OLD.currency
    OR NEW.received_at         IS DISTINCT FROM OLD.received_at
    OR NEW.reference_number    IS DISTINCT FROM OLD.reference_number
    OR NEW.provider            IS DISTINCT FROM OLD.provider
    OR NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id;

  IF NOT v_any_core_fact_changed THEN
    -- Core facts unchanged. Now check snapshot fields.
    -- Snapshot fields are immutable once non-NULL.
    -- NULL → non-NULL is allowed (initial set).
    -- non-NULL → any change (including clear) is rejected.

    -- Snapshot fields are fully immutable for any non-pending payment,
    -- regardless of whether OLD value is NULL or non-NULL.
    -- The backfill runs BEFORE this trigger is installed, so backfilled
    -- values are already in place when this trigger takes effect.
    -- Legacy NULL snapshot values remain permanently NULL — no later code
    -- may "guess" and populate them after this migration completes.
    IF NEW.amount_paid_after_cents IS DISTINCT FROM OLD.amount_paid_after_cents THEN
      RAISE EXCEPTION
        'Permission denied: amount_paid_after_cents is completely immutable for any '
        'non-pending payment. Neither NULL-to-value nor value-to-value changes are '
        'permitted after the payment is created as received.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.balance_remaining_after_cents IS DISTINCT FROM OLD.balance_remaining_after_cents THEN
      RAISE EXCEPTION
        'Permission denied: balance_remaining_after_cents is completely immutable for any '
        'non-pending payment. Neither NULL-to-value nor value-to-value changes are '
        'permitted after the payment is created as received.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Only operational metadata changed (notes, receipt_pdf_*, receipt_number,
    -- receipt_issued_at, updated_at, status) — allow
    RETURN NEW;
  END IF;

  -- Reject core fact change for EVERYONE — no Admin or service_role bypass
  RAISE EXCEPTION
    'Permission denied: core payment facts (invoice_id, payment_method, amount_cents, '
    'currency, received_at, reference_number, provider, provider_payment_id) are '
    'immutable once a payment has reached status ''%''. '
    'These fields cannot be changed after the payment is no longer pending.',
    OLD.status
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

-- Trigger already exists from original migration; DROP + CREATE to replace function
DROP TRIGGER IF EXISTS guard_completed_payment_facts ON public.crm_payments;
CREATE TRIGGER guard_completed_payment_facts
  BEFORE UPDATE ON public.crm_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_completed_payment_facts();


-- ============================================================
-- SECTION 9: guard_receipt_write_once TRIGGER
--
-- BEFORE UPDATE trigger on crm_payments.
-- Enforces write-once semantics for all receipt identity and
-- receipt PDF completion fields:
--
--   receipt_number:          NULL → value permitted; non-NULL → cannot change or clear
--   receipt_issued_at:       NULL → value permitted; non-NULL → cannot change or clear
--   receipt_pdf_storage_path: NULL → value permitted; non-NULL → cannot change or clear
--   receipt_pdf_generated_at: NULL → value permitted; non-NULL → cannot change or clear
--   receipt_pdf_hash:         NULL → value permitted; non-NULL → cannot change or clear
--
-- No role bypass. Protects against future service-role bugs as well
-- as browser writes.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_receipt_write_once_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
BEGIN
  -- receipt_number: once set, cannot change or clear
  IF OLD.receipt_number IS NOT NULL
     AND NEW.receipt_number IS DISTINCT FROM OLD.receipt_number THEN
    RAISE EXCEPTION
      'Permission denied: receipt_number is write-once. '
      'Once assigned, receipt_number cannot be changed or cleared. '
      'Existing: %. Attempted: %.',
      OLD.receipt_number, NEW.receipt_number
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- receipt_issued_at: once set, cannot change or clear
  IF OLD.receipt_issued_at IS NOT NULL
     AND NEW.receipt_issued_at IS DISTINCT FROM OLD.receipt_issued_at THEN
    RAISE EXCEPTION
      'Permission denied: receipt_issued_at is write-once. '
      'Once assigned, receipt_issued_at cannot be changed or cleared.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- receipt_pdf_storage_path: once set, cannot change or clear
  IF OLD.receipt_pdf_storage_path IS NOT NULL
     AND NEW.receipt_pdf_storage_path IS DISTINCT FROM OLD.receipt_pdf_storage_path THEN
    RAISE EXCEPTION
      'Permission denied: receipt_pdf_storage_path is write-once. '
      'Once assigned, receipt_pdf_storage_path cannot be changed or cleared.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- receipt_pdf_generated_at: once set, cannot change or clear
  IF OLD.receipt_pdf_generated_at IS NOT NULL
     AND NEW.receipt_pdf_generated_at IS DISTINCT FROM OLD.receipt_pdf_generated_at THEN
    RAISE EXCEPTION
      'Permission denied: receipt_pdf_generated_at is write-once. '
      'Once assigned, receipt_pdf_generated_at cannot be changed or cleared.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- receipt_pdf_hash: once set, cannot change or clear
  IF OLD.receipt_pdf_hash IS NOT NULL
     AND NEW.receipt_pdf_hash IS DISTINCT FROM OLD.receipt_pdf_hash THEN
    RAISE EXCEPTION
      'Permission denied: receipt_pdf_hash is write-once. '
      'Once assigned, receipt_pdf_hash cannot be changed or cleared.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS guard_receipt_write_once ON public.crm_payments;
CREATE TRIGGER guard_receipt_write_once
  BEFORE UPDATE ON public.crm_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_receipt_write_once_fn();


-- ============================================================
-- SECTION 10: UPDATE record_invoice_payment()
--
-- CREATE OR REPLACE the existing function without changing its
-- public signature or existing behavior.
--
-- The ONLY change is:
--   Before the existing payment INSERT (Step 13), compute:
--     v_amount_paid_after_cents    := v_existing_received_cents + p_amount_cents
--     v_balance_remaining_after_cents := v_invoice.total_cents - v_amount_paid_after_cents
--
--   Then include both new columns in the INSERT VALUES list.
--
-- This is a single INSERT. No follow-up UPDATE.
-- The values are computed from v_existing_received_cents (already
-- available from Step 9, under the FOR UPDATE lock) plus p_amount_cents.
-- This is arithmetically identical to the Step 14 re-query result
-- because no other payment can be inserted while the lock is held.
--
-- All existing behavior is preserved:
--   - authorization
--   - idempotency logic (pre-lock + post-lock)
--   - invoice FOR UPDATE
--   - payable-status validation
--   - overpayment prevention
--   - received_at validation
--   - payment/activity/audit behavior
--   - invoice status behavior
--   - paid_at behavior
--   - existing return contract
--
-- The Step 14 re-query (v_new_received_cents) remains unchanged
-- for use in Steps 15–20 (invoice status, activity, audit, return).
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id       UUID,
  p_admin_user_id    UUID,
  p_amount_cents     BIGINT,
  p_received_at      TIMESTAMPTZ,
  p_reference_number TEXT,
  p_notes            TEXT,
  p_idempotency_key  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  -- Admin verification
  v_admin_role              TEXT;

  -- Idempotency check (shared by pre-lock and post-lock paths)
  v_existing_payment        public.crm_payments%ROWTYPE;
  v_idempotent_invoice      public.crm_invoices%ROWTYPE;
  v_idempotent_paid_cents   BIGINT;

  -- Invoice row (locked FOR UPDATE)
  v_invoice                 public.crm_invoices%ROWTYPE;

  -- Payment calculation
  v_existing_received_cents BIGINT;
  v_remaining_before        BIGINT;

  -- Normalized inputs
  v_reference_number        TEXT;
  v_notes_normalized        TEXT;
  v_received_at             TIMESTAMPTZ;

  -- New payment row
  v_new_payment_id          UUID;
  v_now                     TIMESTAMPTZ;

  -- Snapshot values (computed before INSERT, under the invoice lock)
  v_amount_paid_after_cents         BIGINT;
  v_balance_remaining_after_cents   BIGINT;

  -- Post-insert recalculation (for invoice status / activity / audit / return)
  v_new_received_cents      BIGINT;
  v_balance_remaining       BIGINT;
  v_new_invoice_status      TEXT;
  v_old_invoice_status      TEXT;
  v_paid_at                 TIMESTAMPTZ;

  -- Audit event type
  v_audit_event_type        public.audit_event_type;

  -- Return payload
  v_result                  JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT raw_app_meta_data->>'role'
  INTO v_admin_role
  FROM auth.users
  WHERE id = p_admin_user_id;

  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The supplied p_admin_user_id does not belong to an authorized Admin. '
                      'Authorization requires raw_app_meta_data->>''role'' = ''admin''.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 2: VALIDATE REQUIRED INPUTS
  -- ══════════════════════════════════════════════════════════════════════════

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_idempotency_key is required. Generate a UUID per form submission '
                      'to enable safe retry behavior.';
  END IF;

  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_must_be_positive'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_amount_cents must be a positive integer (cents). '
                      'Received: ' || COALESCE(p_amount_cents::TEXT, 'NULL');
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: NORMALIZE OPTIONAL INPUTS
  -- ══════════════════════════════════════════════════════════════════════════

  v_reference_number := NULLIF(TRIM(COALESCE(p_reference_number, '')), '');
  v_notes_normalized := NULLIF(TRIM(COALESCE(p_notes, '')), '');
  v_received_at      := COALESCE(p_received_at, now());


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: VALIDATE RECEIVED DATE IS NOT IN THE FUTURE
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_received_at > now() THEN
    RAISE EXCEPTION 'received_at_cannot_be_future'
      USING ERRCODE = 'P0001',
            DETAIL  = 'received_at cannot be a future timestamp. '
                      'record_invoice_payment records a payment that has already been received. '
                      'Supplied received_at: ' || v_received_at::TEXT || '. '
                      'Current server time: ' || now()::TEXT || '.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: PRE-LOCK IDEMPOTENCY CHECK
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_existing_payment
  FROM public.crm_payments
  WHERE invoice_id      = p_invoice_id
    AND idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    IF v_existing_payment.amount_cents != p_amount_cents THEN
      RAISE EXCEPTION 'idempotency_key_conflict'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                        || ' was previously used for a payment of '
                        || v_existing_payment.amount_cents::TEXT
                        || ' cents, but this request specifies '
                        || p_amount_cents::TEXT || ' cents. '
                        'The same idempotency key cannot represent two different payment amounts.';
    END IF;

    IF v_existing_payment.reference_number IS DISTINCT FROM v_reference_number THEN
      RAISE EXCEPTION 'idempotency_key_conflict'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                        || ' was previously used with reference_number '
                        || COALESCE(v_existing_payment.reference_number, '(none)')
                        || ', but this request specifies '
                        || COALESCE(v_reference_number, '(none)') || '. '
                        'The same idempotency key cannot represent two different payment requests.';
    END IF;

    IF v_existing_payment.notes IS DISTINCT FROM v_notes_normalized THEN
      RAISE EXCEPTION 'idempotency_key_conflict'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                        || ' was previously used with different notes. '
                        'The same idempotency key cannot represent two different payment requests.';
    END IF;

    IF p_received_at IS NOT NULL THEN
      IF v_existing_payment.received_at IS DISTINCT FROM v_received_at THEN
        RAISE EXCEPTION 'idempotency_key_conflict'
          USING ERRCODE = 'P0001',
                DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                          || ' was previously used with received_at '
                          || COALESCE(v_existing_payment.received_at::TEXT, '(none)')
                          || ', but this request specifies '
                          || v_received_at::TEXT || '. '
                          'The same idempotency key cannot represent two different payment requests.';
      END IF;
    END IF;

    -- Valid replay — return existing authoritative result (zero writes)
    SELECT * INTO v_idempotent_invoice
    FROM public.crm_invoices
    WHERE id = p_invoice_id;

    SELECT COALESCE(SUM(amount_cents), 0)
    INTO v_idempotent_paid_cents
    FROM public.crm_payments
    WHERE invoice_id = p_invoice_id
      AND status = 'received';

    RETURN jsonb_build_object(
      'success',           true,
      'idempotent_replay', true,
      'payment', jsonb_build_object(
        'id',               v_existing_payment.id,
        'invoice_id',       v_existing_payment.invoice_id,
        'payment_method',   v_existing_payment.payment_method,
        'status',           v_existing_payment.status,
        'amount_cents',     v_existing_payment.amount_cents,
        'currency',         v_existing_payment.currency,
        'received_at',      v_existing_payment.received_at,
        'reference_number', v_existing_payment.reference_number,
        'notes',            v_existing_payment.notes,
        'recorded_by',      v_existing_payment.recorded_by,
        'created_at',       v_existing_payment.created_at
      ),
      'invoice', jsonb_build_object(
        'id',             v_idempotent_invoice.id,
        'invoice_number', v_idempotent_invoice.invoice_number,
        'status',         v_idempotent_invoice.status,
        'total_cents',    v_idempotent_invoice.total_cents,
        'paid_at',        v_idempotent_invoice.paid_at
      ),
      'payment_summary', jsonb_build_object(
        'amount_paid_cents',       v_idempotent_paid_cents,
        'balance_remaining_cents', v_idempotent_invoice.total_cents - v_idempotent_paid_cents
      )
    );
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: LOCK THE INVOICE ROW FOR UPDATE
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice with id ' || p_invoice_id::TEXT || ' does not exist.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: POST-LOCK IDEMPOTENCY RE-CHECK
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_existing_payment
  FROM public.crm_payments
  WHERE invoice_id      = p_invoice_id
    AND idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    IF v_existing_payment.amount_cents != p_amount_cents THEN
      RAISE EXCEPTION 'idempotency_key_conflict'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                        || ' was previously used for a payment of '
                        || v_existing_payment.amount_cents::TEXT
                        || ' cents, but this request specifies '
                        || p_amount_cents::TEXT || ' cents. '
                        'The same idempotency key cannot represent two different payment amounts.';
    END IF;

    IF v_existing_payment.reference_number IS DISTINCT FROM v_reference_number THEN
      RAISE EXCEPTION 'idempotency_key_conflict'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                        || ' was previously used with reference_number '
                        || COALESCE(v_existing_payment.reference_number, '(none)')
                        || ', but this request specifies '
                        || COALESCE(v_reference_number, '(none)') || '. '
                        'The same idempotency key cannot represent two different payment requests.';
    END IF;

    IF v_existing_payment.notes IS DISTINCT FROM v_notes_normalized THEN
      RAISE EXCEPTION 'idempotency_key_conflict'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                        || ' was previously used with different notes. '
                        'The same idempotency key cannot represent two different payment requests.';
    END IF;

    IF p_received_at IS NOT NULL THEN
      IF v_existing_payment.received_at IS DISTINCT FROM v_received_at THEN
        RAISE EXCEPTION 'idempotency_key_conflict'
          USING ERRCODE = 'P0001',
                DETAIL  = 'Idempotency key ' || p_idempotency_key::TEXT
                          || ' was previously used with received_at '
                          || COALESCE(v_existing_payment.received_at::TEXT, '(none)')
                          || ', but this request specifies '
                          || v_received_at::TEXT || '. '
                          'The same idempotency key cannot represent two different payment requests.';
      END IF;
    END IF;

    -- Valid replay (post-lock) — return existing result (zero writes)
    SELECT COALESCE(SUM(amount_cents), 0)
    INTO v_idempotent_paid_cents
    FROM public.crm_payments
    WHERE invoice_id = p_invoice_id
      AND status = 'received';

    RETURN jsonb_build_object(
      'success',           true,
      'idempotent_replay', true,
      'payment', jsonb_build_object(
        'id',               v_existing_payment.id,
        'invoice_id',       v_existing_payment.invoice_id,
        'payment_method',   v_existing_payment.payment_method,
        'status',           v_existing_payment.status,
        'amount_cents',     v_existing_payment.amount_cents,
        'currency',         v_existing_payment.currency,
        'received_at',      v_existing_payment.received_at,
        'reference_number', v_existing_payment.reference_number,
        'notes',            v_existing_payment.notes,
        'recorded_by',      v_existing_payment.recorded_by,
        'created_at',       v_existing_payment.created_at
      ),
      'invoice', jsonb_build_object(
        'id',             v_invoice.id,
        'invoice_number', v_invoice.invoice_number,
        'status',         v_invoice.status,
        'total_cents',    v_invoice.total_cents,
        'paid_at',        v_invoice.paid_at
      ),
      'payment_summary', jsonb_build_object(
        'amount_paid_cents',       v_idempotent_paid_cents,
        'balance_remaining_cents', v_invoice.total_cents - v_idempotent_paid_cents
      )
    );
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: VERIFY INVOICE IS PAYABLE
  -- ══════════════════════════════════════════════════════════════════════════

  v_old_invoice_status := v_invoice.status;

  IF v_invoice.status NOT IN ('open', 'partially_paid') THEN
    RAISE EXCEPTION 'invoice_not_payable'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
                      || ' has status ''' || v_invoice.status || ''' and cannot receive a payment. '
                      'Only invoices with status ''open'' or ''partially_paid'' are payable.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: CALCULATE EXISTING RECEIVED PAYMENTS (under invoice lock)
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COALESCE(SUM(amount_cents), 0)
  INTO v_existing_received_cents
  FROM public.crm_payments
  WHERE invoice_id = p_invoice_id
    AND status = 'received';


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: CALCULATE REMAINING BALANCE
  -- ══════════════════════════════════════════════════════════════════════════

  v_remaining_before := v_invoice.total_cents - v_existing_received_cents;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: VALIDATE PAYMENT AMOUNT — REJECT OVERPAYMENT
  -- ══════════════════════════════════════════════════════════════════════════

  IF p_amount_cents > v_remaining_before THEN
    RAISE EXCEPTION 'overpayment_rejected'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment amount of ' || p_amount_cents::TEXT || ' cents exceeds the '
                      'remaining balance of ' || v_remaining_before::TEXT || ' cents for invoice '
                      || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT) || '. '
                      'Overpayments are not permitted. '
                      'Remaining balance: ' || v_remaining_before::TEXT || ' cents.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: CAPTURE AUTHORITATIVE TIMESTAMP
  -- ══════════════════════════════════════════════════════════════════════════

  v_now := now();


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12A: COMPUTE SNAPSHOT VALUES (NEW — Phase 7B-9D)
  --
  -- Computed BEFORE the INSERT, while the invoice row is still locked.
  -- v_existing_received_cents is the authoritative pre-payment total
  -- (computed in Step 9 under the FOR UPDATE lock).
  -- Adding p_amount_cents gives the exact post-payment total.
  --
  -- This is arithmetically identical to the Step 14 re-query result
  -- because no other payment can be inserted while the lock is held.
  --
  -- These values are written directly into the INSERT below.
  -- ONE INSERT. No follow-up UPDATE.
  -- ══════════════════════════════════════════════════════════════════════════

  v_amount_paid_after_cents       := v_existing_received_cents + p_amount_cents;
  v_balance_remaining_after_cents := v_invoice.total_cents - v_amount_paid_after_cents;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: INSERT RECEIVED PAYMENT ROW
  --
  -- Includes the new snapshot columns amount_paid_after_cents and
  -- balance_remaining_after_cents. All other behavior unchanged.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.crm_payments (
    invoice_id,
    payment_method,
    status,
    amount_cents,
    currency,
    received_at,
    reference_number,
    notes,
    recorded_by,
    provider,
    provider_payment_id,
    receipt_pdf_storage_path,
    receipt_pdf_generated_at,
    receipt_pdf_hash,
    idempotency_key,
    amount_paid_after_cents,
    balance_remaining_after_cents,
    created_at,
    updated_at
  ) VALUES (
    p_invoice_id,
    'bank_wire',
    'received',
    p_amount_cents,
    'USD',
    v_received_at,
    v_reference_number,
    v_notes_normalized,
    p_admin_user_id,
    NULL,   -- provider: deferred
    NULL,   -- provider_payment_id: deferred
    NULL,   -- receipt_pdf_storage_path: deferred
    NULL,   -- receipt_pdf_generated_at: deferred
    NULL,   -- receipt_pdf_hash: deferred
    p_idempotency_key,
    v_amount_paid_after_cents,
    v_balance_remaining_after_cents,
    v_now,
    v_now
  )
  RETURNING id INTO v_new_payment_id;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: RECALCULATE AUTHORITATIVE RECEIVED TOTAL (for Steps 15–20)
  --
  -- Re-query after INSERT for use in invoice status, activity, audit, return.
  -- This is unchanged from the original RPC.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COALESCE(SUM(amount_cents), 0)
  INTO v_new_received_cents
  FROM public.crm_payments
  WHERE invoice_id = p_invoice_id
    AND status = 'received';

  v_balance_remaining := v_invoice.total_cents - v_new_received_cents;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 15: DETERMINE NEW INVOICE STATUS
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_new_received_cents >= v_invoice.total_cents THEN
    v_new_invoice_status := 'paid';
    v_paid_at            := v_now;
  ELSE
    v_new_invoice_status := 'partially_paid';
    v_paid_at            := NULL;
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 16: UPDATE INVOICE STATUS
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    status     = v_new_invoice_status,
    paid_at    = v_paid_at,
    updated_at = v_now
  WHERE id = p_invoice_id
    AND status = v_old_invoice_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_payable'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to update invoice status. The invoice may have been modified '
                      'concurrently. Please retry the operation.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 17: WRITE payment_received ACTIVITY
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
    'payment_received',
    'Payment received: $' || ROUND(p_amount_cents::NUMERIC / 100, 2)::TEXT
      || ' for invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT),
    'Bank wire payment of $' || ROUND(p_amount_cents::NUMERIC / 100, 2)::TEXT
      || ' received for invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
      || '. Invoice status: ' || v_new_invoice_status || '.'
      || ' Balance remaining: $' || ROUND(v_balance_remaining::NUMERIC / 100, 2)::TEXT || '.',
    'EarnestBridge Admin',
    jsonb_build_object(
      'invoice_id',              p_invoice_id,
      'invoice_number',          v_invoice.invoice_number,
      'payment_id',              v_new_payment_id,
      'amount_cents',            p_amount_cents,
      'invoice_status',          v_new_invoice_status,
      'amount_paid_cents',       v_new_received_cents,
      'balance_remaining_cents', v_balance_remaining
    )
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 18: WRITE invoice_paid ACTIVITY (if fully paid)
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_new_invoice_status = 'paid' THEN
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
      'invoice_paid',
      'Invoice paid: ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT),
      'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
        || ' has been fully paid. Total received: $'
        || ROUND(v_new_received_cents::NUMERIC / 100, 2)::TEXT || '.',
      'EarnestBridge Admin',
      jsonb_build_object(
        'invoice_id',        p_invoice_id,
        'invoice_number',    v_invoice.invoice_number,
        'payment_id',        v_new_payment_id,
        'total_cents',       v_invoice.total_cents,
        'amount_paid_cents', v_new_received_cents,
        'paid_at',           v_now
      )
    );
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 19: WRITE AUDIT LOG
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_old_invoice_status != v_new_invoice_status THEN
    v_audit_event_type := 'status_change'::public.audit_event_type;
  ELSE
    v_audit_event_type := 'edit'::public.audit_event_type;
  END IF;

  INSERT INTO public.audit_logs (
    admin_id,
    admin_email,
    event_type,
    resource_type,
    resource_id,
    description,
    old_value,
    new_value
  )
  SELECT
    p_admin_user_id,
    COALESCE(u.email, ''),
    v_audit_event_type,
    'invoice',
    p_invoice_id::TEXT,
    'Payment recorded for invoice '
      || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
      || ': $' || ROUND(p_amount_cents::NUMERIC / 100, 2)::TEXT
      || ' received. Invoice status: '
      || v_old_invoice_status || ' → ' || v_new_invoice_status || '.',
    jsonb_build_object(
      'invoice_status', v_old_invoice_status
    ),
    jsonb_build_object(
      'invoice_status',          v_new_invoice_status,
      'payment_id',              v_new_payment_id,
      'amount_cents',            p_amount_cents,
      'amount_paid_cents',       v_new_received_cents,
      'balance_remaining_cents', v_balance_remaining
    )
  FROM auth.users u
  WHERE u.id = p_admin_user_id;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 20: BUILD AND RETURN AUTHORITATIVE RESULT
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'success',           true,
    'idempotent_replay', false,
    'payment', jsonb_build_object(
      'id',               v_new_payment_id,
      'invoice_id',       p_invoice_id,
      'payment_method',   'bank_wire',
      'status',           'received',
      'amount_cents',     p_amount_cents,
      'currency',         'USD',
      'received_at',      v_received_at,
      'reference_number', v_reference_number,
      'notes',            v_notes_normalized,
      'recorded_by',      p_admin_user_id,
      'created_at',       v_now
    ),
    'invoice', jsonb_build_object(
      'id',             p_invoice_id,
      'invoice_number', v_invoice.invoice_number,
      'status',         v_new_invoice_status,
      'total_cents',    v_invoice.total_cents,
      'paid_at',        v_paid_at
    ),
    'payment_summary', jsonb_build_object(
      'amount_paid_cents',       v_new_received_cents,
      'balance_remaining_cents', v_balance_remaining
    )
  );

  RETURN v_result;

END;
$func$;

-- Preserve existing REVOKE/GRANT for record_invoice_payment
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  TO service_role;


-- ============================================================
-- SECTION 11: prepare_receipt_generation() RPC
--
-- Signature:
--   public.prepare_receipt_generation(
--     p_payment_id    UUID,
--     p_admin_user_id UUID
--   )
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Behavior:
--   1. Verify Admin from auth.users.raw_app_meta_data
--   2. SELECT payment FOR UPDATE
--   3. Require status = 'received'
--   4. Require amount_paid_after_cents IS NOT NULL
--   5. Require balance_remaining_after_cents IS NOT NULL
--   6. Load related invoice
--   7. Require valid immutable invoice snapshot fields
--   8. If receipt PDF already complete: return already_complete = true
--   9. If receipt_number already exists: reuse both (no new sequence call)
--  10. If receipt_number IS NULL: allocate sequence, set receipt_number + receipt_issued_at
--  11. Return immutable fields needed by PDF renderer
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized       — p_admin_user_id not an authorized Admin
--   payment_not_found          — payment row does not exist
--   payment_not_received       — payment.status != 'received'
--   payment_snapshot_missing   — amount_paid_after_cents or balance_remaining_after_cents IS NULL
--   invoice_not_found          — related invoice does not exist
--   invoice_snapshot_incomplete — required invoice snapshot fields are NULL
-- ============================================================

CREATE OR REPLACE FUNCTION public.prepare_receipt_generation(
  p_payment_id    UUID,
  p_admin_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_admin_role          TEXT;
  v_payment             public.crm_payments%ROWTYPE;
  v_invoice             public.crm_invoices%ROWTYPE;
  v_receipt_issued_at   TIMESTAMPTZ;
  v_receipt_year        INT;
  v_seq_val             BIGINT;
  v_receipt_number      TEXT;
BEGIN

  -- ── STEP 1: VERIFY ADMIN IDENTITY ────────────────────────────────────────
  SELECT raw_app_meta_data->>'role'
  INTO v_admin_role
  FROM auth.users
  WHERE id = p_admin_user_id;

  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The supplied p_admin_user_id does not belong to an authorized Admin. '
                      'Authorization requires raw_app_meta_data->>''role'' = ''admin''.';
  END IF;

  -- ── STEP 2: LOCK PAYMENT FOR UPDATE ──────────────────────────────────────
  SELECT * INTO v_payment
  FROM public.crm_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment with id ' || p_payment_id::TEXT || ' does not exist.';
  END IF;

  -- ── STEP 3: REQUIRE status = 'received' ──────────────────────────────────
  IF v_payment.status != 'received' THEN
    RAISE EXCEPTION 'payment_not_received'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment ' || p_payment_id::TEXT || ' has status '''
                      || v_payment.status || '''. '
                      'Receipts can only be generated for received payments.';
  END IF;

  -- ── STEP 4–5: REQUIRE SNAPSHOT FIELDS ────────────────────────────────────
  IF v_payment.amount_paid_after_cents IS NULL
     OR v_payment.balance_remaining_after_cents IS NULL THEN
    RAISE EXCEPTION 'payment_snapshot_missing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment ' || p_payment_id::TEXT
                      || ' is missing amount_paid_after_cents or balance_remaining_after_cents. '
                      'This payment predates receipt infrastructure and could not be safely backfilled. '
                      'A receipt cannot be generated without authoritative snapshot values.';
  END IF;

  -- ── STEP 6: LOAD RELATED INVOICE ─────────────────────────────────────────
  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = v_payment.invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || v_payment.invoice_id::TEXT
                      || ' referenced by payment ' || p_payment_id::TEXT || ' does not exist.';
  END IF;

  -- ── STEP 7: REQUIRE VALID INVOICE SNAPSHOT ───────────────────────────────
  IF v_invoice.invoice_number IS NULL
     OR v_invoice.total_cents IS NULL
     OR v_invoice.currency IS NULL
     OR v_invoice.issued_at IS NULL
     OR v_invoice.application_id IS NULL THEN
    RAISE EXCEPTION 'invoice_snapshot_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || v_payment.invoice_id::TEXT
                      || ' is missing required snapshot fields (invoice_number, total_cents, '
                      'currency, issued_at, or application_id). '
                      'Cannot generate a receipt without a complete invoice snapshot.';
  END IF;

  -- ── STEP 8: CHECK IF RECEIPT PDF ALREADY COMPLETE ────────────────────────
  -- All three PDF completion fields are non-NULL (co-presence constraint guarantees this)
  IF v_payment.receipt_pdf_storage_path IS NOT NULL THEN
    -- Defensive invariant: the new CHECK constraint makes this impossible,
    -- but fail closed if inconsistent legacy/corrupt data somehow exists.
    -- A complete PDF without receipt identity is an unrecoverable corrupt state.
    IF v_payment.receipt_number IS NULL OR v_payment.receipt_issued_at IS NULL THEN
      RAISE EXCEPTION 'receipt_identity_missing'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Payment ' || p_payment_id::TEXT
                        || ' has a completed receipt PDF but is missing receipt_number '
                        'or receipt_issued_at. This is an inconsistent state that cannot '
                        'be recovered automatically. Manual investigation required.';
    END IF;

    RETURN jsonb_build_object(
      'already_complete',              true,
      'receipt_number',                v_payment.receipt_number,
      'receipt_issued_at',             v_payment.receipt_issued_at,
      'payment_id',                    v_payment.id,
      'payment_amount_cents',          v_payment.amount_cents,
      'payment_received_at',           v_payment.received_at,
      'payment_method',                v_payment.payment_method,
      'payment_reference_number',      v_payment.reference_number,
      'payment_currency',              v_payment.currency,
      'amount_paid_after_cents',       v_payment.amount_paid_after_cents,
      'balance_remaining_after_cents', v_payment.balance_remaining_after_cents,
      'invoice_id',                    v_invoice.id,
      'application_id',                v_invoice.application_id,
      'invoice_number',                v_invoice.invoice_number,
      'invoice_total_cents',           v_invoice.total_cents,
      'invoice_issued_at',             v_invoice.issued_at,
      'invoice_currency',              v_invoice.currency,
      'billing_name',                  v_invoice.billing_name,
      'billing_contact_name',          v_invoice.billing_contact_name,
      'billing_address_line1',         v_invoice.billing_address_line1,
      'billing_address_line2',         v_invoice.billing_address_line2,
      'billing_city',                  v_invoice.billing_city,
      'billing_state',                 v_invoice.billing_state,
      'billing_postal_code',           v_invoice.billing_postal_code,
      'billing_country',               v_invoice.billing_country
    );
  END IF;

  -- ── STEP 9–10: IDEMPOTENT RECEIPT NUMBER ALLOCATION ──────────────────────
  -- If receipt_number already exists (PREPARE was called before but COMPLETE
  -- has not yet run), reuse both receipt_number and receipt_issued_at.
  -- Do NOT call nextval() again.
  IF v_payment.receipt_number IS NOT NULL THEN
    -- receipt_issued_at must also be set (co-presence constraint guarantees this)
    v_receipt_number    := v_payment.receipt_number;
    v_receipt_issued_at := v_payment.receipt_issued_at;

  ELSE
    -- ── STEP 11: ALLOCATE NEW RECEIPT NUMBER ─────────────────────────────
    -- Set ONE database timestamp; derive YEAR from that same variable.
    -- This prevents midnight/New-Year boundary mismatch.
    v_receipt_issued_at := now();
    v_receipt_year      := EXTRACT(YEAR FROM v_receipt_issued_at)::INT;
    v_seq_val           := nextval('public.receipt_number_seq');

    -- Safe non-truncating format:
    --   sequence < 1000000  → left-pad to 6 digits
    --   sequence >= 1000000 → use entire sequence value unchanged
    -- LPAD truncates strings longer than the target width — do NOT use bare LPAD.
    v_receipt_number := 'EBR-' || v_receipt_year::TEXT || '-'
      || CASE
           WHEN v_seq_val < 1000000
           THEN LPAD(v_seq_val::TEXT, 6, '0')
           ELSE v_seq_val::TEXT
         END;

    -- Atomically write receipt_number and receipt_issued_at.
    -- The guard_receipt_write_once trigger will protect these from future changes.
    UPDATE public.crm_payments
    SET
      receipt_number    = v_receipt_number,
      receipt_issued_at = v_receipt_issued_at,
      updated_at        = v_receipt_issued_at
    WHERE id = p_payment_id;
  END IF;

  -- ── STEP 12: RETURN IMMUTABLE FIELDS FOR PDF RENDERER ────────────────────
  -- Returns only the fields needed to render the receipt PDF.
  -- Excluded: notes, recorded_by, idempotency_key, provider, provider_payment_id,
  --           receipt_pdf_storage_path, receipt_pdf_hash, receipt_pdf_generated_at,
  --           Admin UUID/email, service-role information.
  RETURN jsonb_build_object(
    'already_complete',              false,
    'receipt_number',                v_receipt_number,
    'receipt_issued_at',             v_receipt_issued_at,
    'payment_id',                    v_payment.id,
    'payment_amount_cents',          v_payment.amount_cents,
    'payment_received_at',           v_payment.received_at,
    'payment_method',                v_payment.payment_method,
    'payment_reference_number',      v_payment.reference_number,
    'payment_currency',              v_payment.currency,
    'amount_paid_after_cents',       v_payment.amount_paid_after_cents,
    'balance_remaining_after_cents', v_payment.balance_remaining_after_cents,
    'invoice_id',                    v_invoice.id,
    'application_id',                v_invoice.application_id,
    'invoice_number',                v_invoice.invoice_number,
    'invoice_total_cents',           v_invoice.total_cents,
    'invoice_issued_at',             v_invoice.issued_at,
    'invoice_currency',              v_invoice.currency,
    'billing_name',                  v_invoice.billing_name,
    'billing_contact_name',          v_invoice.billing_contact_name,
    'billing_address_line1',         v_invoice.billing_address_line1,
    'billing_address_line2',         v_invoice.billing_address_line2,
    'billing_city',                  v_invoice.billing_city,
    'billing_state',                 v_invoice.billing_state,
    'billing_postal_code',           v_invoice.billing_postal_code,
    'billing_country',               v_invoice.billing_country
  );

END;
$func$;

-- Permissions for prepare_receipt_generation
REVOKE EXECUTE ON FUNCTION public.prepare_receipt_generation(UUID, UUID)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prepare_receipt_generation(UUID, UUID)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.prepare_receipt_generation(UUID, UUID)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_receipt_generation(UUID, UUID)
  TO service_role;


-- ============================================================
-- SECTION 12: complete_receipt_generation() RPC
--
-- Signature:
--   public.complete_receipt_generation(
--     p_payment_id    UUID,
--     p_admin_user_id UUID,
--     p_pdf_hash      TEXT
--   )
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Behavior:
--   1. Verify Admin from auth.users.raw_app_meta_data
--   2. Validate p_pdf_hash is a 64-character lowercase hex SHA-256 string
--   3. Lock payment FOR UPDATE
--   4. Require status = 'received'
--   5. Require amount_paid_after_cents, balance_remaining_after_cents,
--      receipt_number, receipt_issued_at all non-NULL
--   6. Load invoice/application identifiers from trusted DB rows
--   7. Derive canonical storage path internally:
--      receipts/{application_id}/{invoice_id}/{payment_id}.pdf
--   8. Verify canonical storage object exists in invoice-pdfs bucket
--   9. If receipt already completed:
--      - same hash → idempotent replay (zero writes)
--      - different hash → receipt_hash_conflict
--  10. Atomically set receipt_pdf_storage_path, receipt_pdf_generated_at, receipt_pdf_hash
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized         — p_admin_user_id not an authorized Admin
--   invalid_pdf_hash             — p_pdf_hash is not a valid SHA-256 hex string
--   payment_not_found            — payment row does not exist
--   payment_not_received         — payment.status != 'received'
--   payment_snapshot_missing     — snapshot or receipt identity fields missing
--   invoice_not_found            — related invoice does not exist
--   receipt_storage_object_missing — canonical PDF not found in storage
--   receipt_hash_conflict        — receipt already complete with different hash
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_receipt_generation(
  p_payment_id    UUID,
  p_admin_user_id UUID,
  p_pdf_hash      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_admin_role          TEXT;
  v_normalized_hash     TEXT;
  v_payment             public.crm_payments%ROWTYPE;
  v_invoice             public.crm_invoices%ROWTYPE;
  v_canonical_path      TEXT;
  v_storage_object_count INT;
  v_generated_at        TIMESTAMPTZ;
BEGIN

  -- ── STEP 1: VERIFY ADMIN IDENTITY ────────────────────────────────────────
  SELECT raw_app_meta_data->>'role'
  INTO v_admin_role
  FROM auth.users
  WHERE id = p_admin_user_id;

  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The supplied p_admin_user_id does not belong to an authorized Admin. '
                      'Authorization requires raw_app_meta_data->>''role'' = ''admin''.';
  END IF;

  -- ── STEP 2: VALIDATE p_pdf_hash ──────────────────────────────────────────
  -- Must be a SHA-256 hex string: exactly 64 hexadecimal characters.
  -- Normalize to lowercase for consistent storage and comparison.
  IF p_pdf_hash IS NULL OR LENGTH(p_pdf_hash) != 64
     OR LOWER(p_pdf_hash) !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_pdf_hash'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_pdf_hash must be a valid SHA-256 hex string (64 lowercase hexadecimal characters). '
                      'Received: ' || COALESCE(p_pdf_hash, 'NULL');
  END IF;

  v_normalized_hash := LOWER(p_pdf_hash);

  -- ── STEP 3: LOCK PAYMENT FOR UPDATE ──────────────────────────────────────
  SELECT * INTO v_payment
  FROM public.crm_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment with id ' || p_payment_id::TEXT || ' does not exist.';
  END IF;

  -- ── STEP 4: REQUIRE status = 'received' ──────────────────────────────────
  IF v_payment.status != 'received' THEN
    RAISE EXCEPTION 'payment_not_received'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment ' || p_payment_id::TEXT || ' has status '''
                      || v_payment.status || '''. '
                      'Receipt completion requires a received payment.';
  END IF;

  -- ── STEP 5: REQUIRE SNAPSHOT + RECEIPT IDENTITY FIELDS ───────────────────
  IF v_payment.amount_paid_after_cents IS NULL
     OR v_payment.balance_remaining_after_cents IS NULL
     OR v_payment.receipt_number IS NULL
     OR v_payment.receipt_issued_at IS NULL THEN
    RAISE EXCEPTION 'payment_snapshot_missing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment ' || p_payment_id::TEXT
                      || ' is missing required fields for receipt completion. '
                      'Ensure prepare_receipt_generation() was called successfully before '
                      'calling complete_receipt_generation().';
  END IF;

  -- ── STEP 6: LOAD INVOICE IDENTIFIERS FROM TRUSTED DB ROWS ────────────────
  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = v_payment.invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || v_payment.invoice_id::TEXT
                      || ' referenced by payment ' || p_payment_id::TEXT || ' does not exist.';
  END IF;

  -- ── STEP 7: DERIVE CANONICAL STORAGE PATH INTERNALLY ─────────────────────
  -- Path is NEVER accepted from the caller.
  -- Derived from trusted DB values: application_id, invoice_id, payment_id.
  v_canonical_path := 'receipts/'
    || v_invoice.application_id::TEXT || '/'
    || v_invoice.id::TEXT || '/'
    || p_payment_id::TEXT || '.pdf';

  -- ── STEP 8: VERIFY CANONICAL STORAGE OBJECT EXISTS ───────────────────────
  -- Check that the PDF was actually uploaded to the private invoice-pdfs bucket
  -- at the canonical path before marking the receipt as complete in the DB.
  -- Uses storage.objects schema (Supabase internal storage table).
  SELECT COUNT(*)
  INTO v_storage_object_count
  FROM storage.objects
  WHERE bucket_id = 'invoice-pdfs'
    AND name = v_canonical_path;

  IF v_storage_object_count = 0 THEN
    RAISE EXCEPTION 'receipt_storage_object_missing'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The canonical receipt PDF object does not exist in storage. '
                      'Expected bucket: invoice-pdfs. '
                      'Expected path: ' || v_canonical_path || '. '
                      'Upload the PDF before calling complete_receipt_generation().';
  END IF;

  -- ── STEP 9: IDEMPOTENT REPLAY CHECK ──────────────────────────────────────
  -- If receipt is already completed (all three PDF fields non-NULL):
  IF v_payment.receipt_pdf_storage_path IS NOT NULL THEN
    -- Same hash → idempotent replay (zero writes)
    IF v_payment.receipt_pdf_hash = v_normalized_hash THEN
      RETURN jsonb_build_object(
        'success',          true,
        'idempotent_replay', true,
        'receipt_number',   v_payment.receipt_number,
        'receipt_issued_at', v_payment.receipt_issued_at,
        'storage_path',     v_payment.receipt_pdf_storage_path,
        'generated_at',     v_payment.receipt_pdf_generated_at
      );
    END IF;

    -- Different hash → conflict (cannot overwrite an existing receipt PDF)
    RAISE EXCEPTION 'receipt_hash_conflict'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment ' || p_payment_id::TEXT
                      || ' already has a completed receipt with a different PDF hash. '
                      'The existing receipt cannot be overwritten. '
                      'Existing hash: ' || v_payment.receipt_pdf_hash || '. '
                      'Supplied hash: ' || v_normalized_hash || '.';
  END IF;

  -- ── STEP 10: ATOMICALLY COMPLETE THE RECEIPT ─────────────────────────────
  -- Set all three PDF completion fields in a single UPDATE.
  -- receipt_pdf_generated_at uses database now() — never server-supplied.
  -- receipt_number and receipt_issued_at are NOT modified.
  -- Snapshot totals are NOT modified.
  -- Payment financial facts are NOT modified.
  v_generated_at := now();

  UPDATE public.crm_payments
  SET
    receipt_pdf_storage_path = v_canonical_path,
    receipt_pdf_generated_at = v_generated_at,
    receipt_pdf_hash         = v_normalized_hash,
    updated_at               = v_generated_at
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'success',           true,
    'idempotent_replay', false,
    'receipt_number',    v_payment.receipt_number,
    'receipt_issued_at', v_payment.receipt_issued_at,
    'storage_path',      v_canonical_path,
    'generated_at',      v_generated_at
  );

END;
$func$;

-- Permissions for complete_receipt_generation
REVOKE EXECUTE ON FUNCTION public.complete_receipt_generation(UUID, UUID, TEXT)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_receipt_generation(UUID, UUID, TEXT)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_receipt_generation(UUID, UUID, TEXT)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_receipt_generation(UUID, UUID, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 13: DIRECT BROWSER WRITE PROTECTION CONFIRMATION
--
-- The admins_insert_crm_payments and admins_update_crm_payments
-- RLS policies were removed in 20260930000000_record_invoice_payment_rpc.sql.
-- No browser INSERT or UPDATE policies exist on crm_payments.
-- All receipt-number, snapshot, and completion mutations must occur
-- through trusted service-role/RPC paths only.
--
-- No new policies are added here.
-- ============================================================

-- (No SQL needed — existing RLS hardening from Phase 7B-3 is sufficient)


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- ── PHASE 7B-9D COMPLETION REPORT ────────────────────────────────────────
--
-- A. New columns:
--    crm_payments.amount_paid_after_cents       BIGINT NULL
--    crm_payments.balance_remaining_after_cents BIGINT NULL
--    crm_payments.receipt_number                TEXT NULL
--    crm_payments.receipt_issued_at             TIMESTAMPTZ NULL
--
-- B. New constraints:
--    crm_payments_snapshot_copresence           — both NULL or both non-NULL
--    crm_payments_amount_paid_after_positive    — > 0 when non-NULL
--    crm_payments_balance_remaining_after_nonneg — >= 0 when non-NULL
--    crm_payments_receipt_identity_copresence   — receipt_number + receipt_issued_at co-presence
--    crm_payments_receipt_pdf_copresence        — all three PDF fields co-presence
--
-- C. Unique index:
--    crm_payments_receipt_number_unique         — UNIQUE WHERE receipt_number IS NOT NULL
--
-- D. Sequence definition:
--    public.receipt_number_seq                  — START 1, INCREMENT 1, NO CYCLE
--    REVOKE from PUBLIC/anon/authenticated; GRANT USAGE to service_role
--
-- E. Exact backfill logic:
--    Dual-source cross-check: application_activity (payment_received) + audit_logs (invoice)
--    Match by payment_id in metadata/new_value
--    Safe JSON casting: regex validation + BIGINT range check before cast
--    Fail-closed per row: zero/multiple/invalid/disagreeing sources → leave NULL
--    Only status='received' payments with NULL snapshot columns are processed
--
-- F. Existing record_invoice_payment changes:
--    Added v_amount_paid_after_cents and v_balance_remaining_after_cents variables
--    Computed before INSERT (Step 12A) from v_existing_received_cents + p_amount_cents
--    Both new columns included in the INSERT VALUES list (Step 13)
--    Single INSERT — no follow-up UPDATE
--    All existing behavior preserved exactly
--
-- G. guard_completed_payment_facts changes:
--    Extended to check amount_paid_after_cents and balance_remaining_after_cents
--    Once non-NULL, these fields cannot change or be cleared
--    Existing core-fact immutability logic preserved exactly
--
-- H. guard_receipt_write_once source:
--    New BEFORE UPDATE trigger function: guard_receipt_write_once_fn()
--    New trigger: guard_receipt_write_once on crm_payments
--    Covers: receipt_number, receipt_issued_at, receipt_pdf_storage_path,
--            receipt_pdf_generated_at, receipt_pdf_hash
--    NULL → value: permitted; non-NULL → any change: rejected
--    No role bypass
--
-- I. prepare_receipt_generation source:
--    SECURITY DEFINER, service_role only
--    Verifies Admin, locks payment FOR UPDATE, validates status/snapshot/invoice
--    Idempotent: reuses existing receipt_number if already allocated
--    Allocates sequence using safe non-truncating CASE expression
--    Year derived from same v_receipt_issued_at variable
--    Returns immutable fields for PDF renderer; excludes sensitive fields
--
-- J. complete_receipt_generation source:
--    SECURITY DEFINER, service_role only
--    Verifies Admin, validates SHA-256 hash format (64 hex chars, normalized lowercase)
--    Locks payment FOR UPDATE, validates status/snapshot/receipt identity
--    Derives canonical path internally: receipts/{app_id}/{inv_id}/{pay_id}.pdf
--    Verifies storage object exists in invoice-pdfs bucket before DB write
--    Same hash → idempotent replay; different hash → receipt_hash_conflict
--    Atomically sets all three PDF completion fields; uses database now()
--
-- K. RPC/sequence permissions:
--    record_invoice_payment:        EXECUTE → service_role only (preserved)
--    prepare_receipt_generation:    EXECUTE → service_role only (new)
--    complete_receipt_generation:   EXECUTE → service_role only (new)
--    receipt_number_seq:            USAGE → service_role only (new)
--    All three RPCs: REVOKE from PUBLIC, anon, authenticated
--
-- L. Confirmation no application files changed:
--    Application files modified: 0
--    src/app/api/admin/invoices/[id]/payment/route.ts — NOT modified
--    RecordPaymentDialog — NOT modified
--    PaymentHistorySection — NOT modified
--    AdminInvoiceDetailContent — NOT modified
--    Client Portal — NOT modified
--
-- ── STATIC SAFETY MATRIX (Phase 7B-9D1 corrections applied) ─────────────
--
-- A. Snapshot values calculated under invoice lock                    PASS
-- B. Snapshot written in original payment INSERT                      PASS
-- C. No follow-up snapshot UPDATE for new payments                    PASS
-- D. Legacy backfill dual-source and fail-closed                      PASS
-- E. Malformed legacy JSON cannot crash migration                     PASS
-- F. Snapshot fields co-present                                       PASS
-- G. Receipt identity fields co-present                               PASS
-- H. Receipt PDF fields co-present                                    PASS
-- I. Receipt number database-unique                                   PASS
-- J. Number formatting cannot truncate                                PASS
-- K. Year derived from receipt_issued_at                              PASS
-- L. Snapshot immutable                                               PASS
--    (fully immutable for any non-pending payment, NULL or non-NULL)
-- M. Receipt identity write-once                                      PASS
-- N. Receipt PDF metadata write-once                                  PASS
-- O. Prepare locks payment                                            PASS
-- P. Prepare idempotently reuses receipt number                       PASS
-- Q. Complete derives canonical storage path internally               PASS
-- R. Complete validates SHA-256 format                                PASS
-- S. Complete requires canonical storage object exists                PASS
-- T. Complete same-hash replay is idempotent                          PASS
-- U. Complete different-hash replay conflicts                         PASS
-- V. Browser cannot execute receipt RPCs directly                     PASS
-- W. Browser cannot directly update receipt fields                    PASS
-- X. Existing payment behavior preserved                              PASS
-- Y. Existing payment API untouched                                   PASS
-- Z. No application code modified                                     PASS
--
-- Phase 7B-9D1 additional checks:
-- A. Backfill still runs before strict snapshot immutability installed PASS
--    (DO block runs before CREATE OR REPLACE protect_completed_payment_facts)
-- B. Legacy NULL snapshots cannot later become non-NULL               PASS
--    (fully immutable: ANY change rejected for non-pending payments)
-- C. Backfilled non-NULL snapshots cannot change                      PASS
-- D. New payment snapshots cannot change                              PASS
-- E. Activity backfill row bound to payment + invoice                 PASS
--    (metadata->>'payment_id' AND metadata->>'invoice_id')
-- F. Audit backfill row bound to payment + invoice                    PASS
--    (new_value->>'payment_id' AND resource_id = invoice_id)
-- G. Backfill remains dual-source                                     PASS
-- H. Oversized malformed JSON cannot abort migration                  PASS
--    (length<=19 pre-check before any NUMERIC/BIGINT cast)
-- I. PDF completion requires receipt identity at DB level             PASS
--    (crm_payments_receipt_completion_requires_identity constraint)
-- J. Prepared-but-incomplete receipt remains valid                    PASS
--    (receipt_number+receipt_issued_at non-NULL, receipt_pdf_*=NULL allowed)
-- K. Prepare fails closed on impossible complete-without-identity     PASS
--    (receipt_identity_missing exception before already_complete return)
-- L. No other receipt architecture changed                            PASS
-- M. No application files modified                                    PASS
-- N. Migration still not executed                                     PASS
--
-- ── ZERO-CHANGE / NO-DEPLOY CONFIRMATION ─────────────────────────────────
--
-- 7B-9D RECEIPT DATABASE FOUNDATION IMPLEMENTED LOCALLY
--
-- READY FOR SOURCE REVIEW: YES
--
-- Migration created:
-- supabase/migrations/20261002000000_payment_receipt_foundation.sql
--
-- Application files modified: 0
-- Migration executed locally: NO
-- Migration executed in production: NO
-- Database rows modified: 0
-- Payments modified: 0
-- Invoices modified: 0
-- Receipts generated: 0
-- Emails sent: 0
-- Netlify deployed: NO
-- Supabase deployed: NO
-- ============================================================
