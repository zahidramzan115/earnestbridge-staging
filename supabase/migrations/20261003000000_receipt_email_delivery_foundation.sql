-- ============================================================
-- Migration: 20261003000000_receipt_email_delivery_foundation
--
-- Phase 7B-11B — Receipt Email Delivery Database Foundation
--
-- PURPOSE
-- -------
-- Creates the complete database foundation for automatic receipt
-- email delivery. This migration mirrors the proven invoice email
-- delivery architecture (20260928000200 + 20260928000300) exactly,
-- changing the identity anchor from invoice_id to payment_id.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1.  Creates public.crm_receipt_email_deliveries
-- 2.  Adds all required columns with correct types and constraints
-- 3.  Adds TEXT + CHECK delivery_status constraint (not a PG enum)
-- 4.  Adds UNIQUE(payment_id) — one canonical delivery per payment
-- 5.  Adds UNIQUE(provider_idempotency_key) — provider dedupe
-- 6.  Adds sent-state guards (sent_at + provider_message_id required when sent)
-- 7.  Enables RLS with NO client/browser write policies
-- 8.  Attaches the existing public.set_updated_at() trigger
-- 9.  Adds a delivery_status index
-- 10. Creates BEFORE UPDATE state-machine trigger function + trigger
-- 11. Creates public.claim_receipt_email_delivery(p_payment_id, p_admin_user_id)
-- 12. Creates public.complete_receipt_email_delivery_success(p_delivery_id, p_provider_message_id)
-- 13. Creates public.complete_receipt_email_delivery_failure(p_delivery_id, p_error_code, p_error_message)
-- 14. Creates public.mark_receipt_email_delivery_uncertain(p_delivery_id, p_error_code, p_error_message)
-- 15. REVOKE/GRANT permissions on all RPCs (service_role only)
--
-- DESIGN DECISIONS
-- ----------------
-- UNIQUE(payment_id): One canonical automatic receipt email per payment.
-- This is intentional. A second successful resend after status='sent' is
-- OUT OF SCOPE for this migration. Manual resend history would require a
-- schema extension.
--
-- Recipient derived from crm_invoices.billing_email via payment.invoice_id.
-- The Admin browser must NEVER supply the recipient.
--
-- Provider idempotency key: 'receipt-email/' || payment_id::text
-- Generated inside the claim RPC only. Never accepted from caller input.
--
-- Stale sending threshold: 15 minutes (same as invoice email delivery).
-- Stale sending → uncertain (NOT failed). We prefer a missed email over
-- an accidental duplicate when delivery outcome is unknown.
--
-- Admin authorization: raw_app_meta_data->>'role' = 'admin'
-- OR raw_app_meta_data->>'is_superadmin' = 'true'
-- (mirrors the hardened admin authorization pattern in this project)
--
-- Receipt completeness gate: ALL of the following must be non-NULL before
-- any email delivery can be claimed:
--   receipt_number
--   receipt_issued_at
--   receipt_pdf_storage_path
--   receipt_pdf_generated_at
--   receipt_pdf_hash
--
-- RLS DECISION
-- ------------
-- RLS is enabled. No client/browser policies are created.
-- service_role bypasses RLS for all trusted server-side operations.
-- This matches the crm_invoice_email_deliveries precedent.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- --------------------------------
-- Does NOT modify crm_invoice_email_deliveries
-- Does NOT modify invoice email RPCs
-- Does NOT modify crm_payments financial facts
-- Does NOT modify crm_invoices
-- Does NOT modify receipt generation RPCs
-- Does NOT touch existing receipt rows
-- Does NOT create any receipt email delivery rows
-- Does NOT send email
-- Does NOT modify application_activity CHECK constraints
-- Does NOT add receipt_email_sent / receipt_email_failed event types
-- Does NOT deploy to Supabase
-- Does NOT deploy to Netlify
--
-- ZERO BUSINESS DATA MUTATION
-- ----------------------------
-- crm_receipt_email_deliveries rows created: 0
-- crm_payments rows changed:                 0
-- crm_invoices rows changed:                 0
-- emails sent:                               0
-- ============================================================


-- ============================================================
-- SECTION 1: CREATE TABLE crm_receipt_email_deliveries
-- ============================================================

CREATE TABLE IF NOT EXISTS public.crm_receipt_email_deliveries (

  -- Primary key
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Payment reference — one canonical delivery record per payment
  -- ON DELETE RESTRICT: prevents deleting a payment that has a delivery record
  payment_id                UUID        NOT NULL
                                        REFERENCES public.crm_payments(id)
                                        ON DELETE RESTRICT,

  -- Delivery lifecycle state (TEXT + CHECK — not a PG enum for safe extensibility)
  -- Allowed values: pending | sending | sent | failed | uncertain
  --
  -- pending   = delivery record exists but no send claim has started
  -- sending   = a server-side send attempt has been claimed and may be in progress
  -- sent      = provider confirmed success and provider_message_id is stored
  -- failed    = provider/network returned a definite failure that is safe to retry
  -- uncertain = server cannot prove whether the provider sent the message
  --             (e.g. provider success may have occurred but local completion
  --             could not be persisted). The claim RPC must NOT automatically
  --             retry an 'uncertain' delivery.
  delivery_status           TEXT        NOT NULL
                                        DEFAULT 'pending'
                                        CONSTRAINT crm_receipt_email_deliveries_status_check
                                        CHECK (delivery_status IN (
                                          'pending',
                                          'sending',
                                          'sent',
                                          'failed',
                                          'uncertain'
                                        )),

  -- Recipient email address (snapshot at delivery record creation time)
  -- Derived from crm_invoices.billing_email via payment.invoice_id.
  -- Never accepted from caller input.
  recipient_email           TEXT        NOT NULL
                                        CONSTRAINT crm_receipt_email_deliveries_recipient_nonempty
                                        CHECK (trim(recipient_email) <> ''),

  -- Email provider identifier
  provider                  TEXT        NOT NULL
                                        DEFAULT 'resend',

  -- Deterministic idempotency key passed to the provider as Idempotency-Key.
  -- Format: receipt-email/{payment_id}
  -- Generated by the claim RPC when the delivery record is created.
  -- The same key is reused on every retry for this canonical delivery row.
  -- Never accepted from caller input.
  provider_idempotency_key  TEXT        NOT NULL
                                        CONSTRAINT crm_receipt_email_deliveries_idempotency_key_nonempty
                                        CHECK (trim(provider_idempotency_key) <> ''),

  -- Provider-assigned message ID (e.g. Resend email ID).
  -- Required when delivery_status = 'sent' (enforced by CHECK below).
  -- NULL for all other states.
  provider_message_id       TEXT        NULL,

  -- Number of send attempts made (>= 0)
  attempt_count             INTEGER     NOT NULL
                                        DEFAULT 0
                                        CONSTRAINT crm_receipt_email_deliveries_attempt_count_nonneg
                                        CHECK (attempt_count >= 0),

  -- Timestamp of the most recent send attempt
  last_attempt_at           TIMESTAMPTZ NULL,

  -- Timestamp when the provider confirmed successful delivery
  -- Required when delivery_status = 'sent' (enforced by CHECK below).
  sent_at                   TIMESTAMPTZ NULL,

  -- Last provider or network error code (for diagnostics and retry decisions)
  last_error_code           TEXT        NULL,

  -- Last provider or network error message (for diagnostics)
  last_error_message        TEXT        NULL,

  -- Record timestamps
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()

);


-- ============================================================
-- SECTION 2: CONSTRAINTS
-- ============================================================

-- ONE canonical automatic receipt email delivery per payment
ALTER TABLE public.crm_receipt_email_deliveries
  ADD CONSTRAINT crm_receipt_email_deliveries_unique_payment_id
  UNIQUE (payment_id);

-- Provider idempotency key must also be globally unique
ALTER TABLE public.crm_receipt_email_deliveries
  ADD CONSTRAINT crm_receipt_email_deliveries_unique_idempotency_key
  UNIQUE (provider_idempotency_key);

-- Sent-state guards:
--   When delivery_status = 'sent':
--     sent_at must be NOT NULL
--     provider_message_id must be NOT NULL and non-blank
--   These are NOT required for any other state.
ALTER TABLE public.crm_receipt_email_deliveries
  ADD CONSTRAINT crm_receipt_email_deliveries_sent_state_requires_sent_at
  CHECK (
    delivery_status <> 'sent'
    OR sent_at IS NOT NULL
  );

ALTER TABLE public.crm_receipt_email_deliveries
  ADD CONSTRAINT crm_receipt_email_deliveries_sent_state_requires_message_id
  CHECK (
    delivery_status <> 'sent'
    OR (provider_message_id IS NOT NULL AND trim(provider_message_id) <> '')
  );


-- ============================================================
-- SECTION 3: INDEXES
-- ============================================================

-- UNIQUE(payment_id) already provides a payment lookup index.
-- UNIQUE(provider_idempotency_key) already provides its index.
--
-- delivery_status index: justified for future retry worker queries that
-- scan WHERE delivery_status IN ('pending', 'failed') across all rows.
CREATE INDEX IF NOT EXISTS idx_crm_receipt_email_deliveries_status
  ON public.crm_receipt_email_deliveries(delivery_status);


-- ============================================================
-- SECTION 4: UPDATED_AT TRIGGER
--
-- Reuses the existing project-wide public.set_updated_at() function
-- (first defined in 20260411014854_borrower_applications.sql).
-- ============================================================

DROP TRIGGER IF EXISTS crm_receipt_email_deliveries_updated_at
  ON public.crm_receipt_email_deliveries;

CREATE TRIGGER crm_receipt_email_deliveries_updated_at
  BEFORE UPDATE ON public.crm_receipt_email_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- SECTION 5: ROW LEVEL SECURITY
--
-- RLS is enabled.
-- No client/browser policies are created.
-- service_role bypasses RLS for all trusted server-side operations.
-- This matches the crm_invoice_email_deliveries precedent.
-- ============================================================

ALTER TABLE public.crm_receipt_email_deliveries ENABLE ROW LEVEL SECURITY;

-- No policies created in this migration.
-- service_role bypasses RLS for all trusted server-side operations.
-- Direct client/browser policies will be added only when a specific
-- server-validated access pattern is designed and reviewed.


-- ============================================================
-- SECTION 6: BEFORE UPDATE STATE-MACHINE TRIGGER
--
-- Enforces on crm_receipt_email_deliveries:
--
-- A. Core identity fields are immutable after INSERT:
--      id
--      payment_id
--      recipient_email
--      provider
--      provider_idempotency_key
--      created_at
--
-- B. Only legal status transitions are permitted:
--      pending   → sending
--      sending   → sent
--      sending   → failed
--      sending   → uncertain
--      failed    → sending
--      (same-status no-op is allowed for controlled RPCs that
--       update other fields without changing status)
--
-- Terminal states:
--      sent      → any other state  (BLOCKED)
--      uncertain → any other state  (BLOCKED — no automatic retry)
--
-- Mirrors crm_invoice_email_deliveries_state_guard_fn() exactly.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crm_receipt_email_deliveries_state_guard_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
BEGIN

  -- ── A. IMMUTABLE CORE IDENTITY FIELDS ─────────────────────────────────────

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'receipt_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'id is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
    RAISE EXCEPTION 'receipt_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'payment_id is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.recipient_email IS DISTINCT FROM OLD.recipient_email THEN
    RAISE EXCEPTION 'receipt_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'recipient_email is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'receipt_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'provider is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key THEN
    RAISE EXCEPTION 'receipt_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'provider_idempotency_key is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'receipt_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'created_at is immutable after INSERT and cannot be changed.';
  END IF;


  -- ── B. LEGAL STATUS TRANSITIONS ───────────────────────────────────────────
  -- Same-status is always allowed (RPCs update other fields without
  -- necessarily changing status in every code path).

  IF NEW.delivery_status IS NOT DISTINCT FROM OLD.delivery_status THEN
    RETURN NEW;
  END IF;

  -- sent is a terminal state — no transitions out
  IF OLD.delivery_status = 'sent' THEN
    RAISE EXCEPTION 'receipt_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Illegal status transition: sent → %s. '
              'The sent state is terminal and cannot be changed.',
              NEW.delivery_status
            );
  END IF;

  -- uncertain must NOT be automatically retried
  IF OLD.delivery_status = 'uncertain' THEN
    RAISE EXCEPTION 'receipt_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Illegal status transition: uncertain → %s. '
              'An uncertain delivery cannot be automatically retried. '
              'Manual admin intervention is required.',
              NEW.delivery_status
            );
  END IF;

  -- pending may only go to sending
  IF OLD.delivery_status = 'pending' AND NEW.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'receipt_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Illegal status transition: pending → %s. '
              'pending may only transition to sending.',
              NEW.delivery_status
            );
  END IF;

  -- sending may go to sent, failed, or uncertain
  IF OLD.delivery_status = 'sending'
     AND NEW.delivery_status NOT IN ('sent', 'failed', 'uncertain') THEN
    RAISE EXCEPTION 'receipt_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Illegal status transition: sending → %s. '
              'sending may only transition to sent, failed, or uncertain.',
              NEW.delivery_status
            );
  END IF;

  -- failed may only go to sending (explicit retry via claim RPC)
  IF OLD.delivery_status = 'failed' AND NEW.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'receipt_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Illegal status transition: failed → %s. '
              'failed may only transition to sending (explicit retry).',
              NEW.delivery_status
            );
  END IF;

  RETURN NEW;

END;
$func$;

-- Drop and recreate trigger to ensure idempotency
DROP TRIGGER IF EXISTS crm_receipt_email_deliveries_state_guard
  ON public.crm_receipt_email_deliveries;

CREATE TRIGGER crm_receipt_email_deliveries_state_guard
  BEFORE UPDATE ON public.crm_receipt_email_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_receipt_email_deliveries_state_guard_fn();

-- Grant trigger function to postgres (required for trigger execution)
GRANT EXECUTE ON FUNCTION public.crm_receipt_email_deliveries_state_guard_fn()
  TO postgres;


-- ============================================================
-- SECTION 7: claim_receipt_email_delivery()
--
-- Atomic claim RPC. Called by trusted server code AFTER Admin
-- authentication. Derives all canonical values from crm_payments
-- and crm_invoices. The caller provides ONLY payment_id and
-- Admin user ID.
--
-- Signature:
--   public.claim_receipt_email_delivery(
--     p_payment_id    UUID,
--     p_admin_user_id UUID
--   )
--
-- Returns TABLE:
--   outcome                  TEXT
--   delivery_id              UUID
--   payment_id               UUID
--   recipient_email          TEXT
--   provider                 TEXT
--   provider_idempotency_key TEXT
--   attempt_count            INTEGER
--
-- Possible outcome values:
--   claimed           — new delivery row created in sending state
--   retry_claimed     — existing failed row reclaimed for retry
--   already_sent      — delivery already confirmed sent; do not resend
--   currently_sending — a send is already in progress (not stale)
--   uncertain         — delivery outcome unknown; do not auto-retry
--
-- ADMIN AUTHORIZATION
-- -------------------
-- Validates p_admin_user_id against auth.users.
-- Checks raw_app_meta_data->>'role' = 'admin'
-- OR raw_app_meta_data->>'is_superadmin' = 'true'.
-- Raises insufficient_privilege if not authorized.
--
-- PAYMENT ELIGIBILITY
-- -------------------
-- Requires:
--   payment exists
--   payment.status = 'received'
--
-- RECEIPT COMPLETENESS GATE
-- -------------------------
-- All of the following must be non-NULL before any email delivery
-- can be claimed:
--   receipt_number
--   receipt_issued_at
--   receipt_pdf_storage_path
--   receipt_pdf_generated_at
--   receipt_pdf_hash
--
-- RECIPIENT DERIVATION
-- --------------------
-- Recipient is derived ONLY from crm_invoices.billing_email
-- via payment.invoice_id. Never from function input.
--
-- IDEMPOTENCY KEY
-- ---------------
-- Generated INSIDE the RPC as: 'receipt-email/' || payment_id::text
-- Never accepted from caller input.
-- The same key is reused on every retry for this canonical delivery row.
--
-- STALE SENDING DETECTION
-- -----------------------
-- If delivery_status = 'sending' AND last_attempt_at < now() - 15 min:
--   → transitions to 'uncertain' (NOT to 'failed')
--   → returns outcome 'uncertain'
-- We prefer a missed email over an accidental duplicate when delivery
-- outcome is unknown. Same threshold as invoice email delivery.
--
-- CONCURRENCY
-- -----------
-- Uses INSERT ON CONFLICT + FOR UPDATE row locking to ensure two
-- concurrent requests for the same payment cannot both receive
-- permission to send.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_receipt_email_delivery(
  p_payment_id    UUID,
  p_admin_user_id UUID
)
RETURNS TABLE (
  outcome                  TEXT,
  delivery_id              UUID,
  payment_id               UUID,
  recipient_email          TEXT,
  provider                 TEXT,
  provider_idempotency_key TEXT,
  attempt_count            INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_admin_role              TEXT;
  v_admin_is_superadmin     TEXT;
  v_payment                 public.crm_payments%ROWTYPE;
  v_invoice                 public.crm_invoices%ROWTYPE;
  v_idempotency_key         TEXT;
  v_recipient               TEXT;
  v_delivery                public.crm_receipt_email_deliveries%ROWTYPE;
  v_now                     TIMESTAMPTZ;
BEGIN

  v_now := now();

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
  -- Use raw_app_meta_data (server-controlled) — never user_metadata.
  -- Allow role = 'admin' OR is_superadmin = true.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    raw_app_meta_data->>'role',
    raw_app_meta_data->>'is_superadmin'
  INTO v_admin_role, v_admin_is_superadmin
  FROM auth.users
  WHERE id = p_admin_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL  = 'The supplied Admin identity does not exist in auth.users.';
  END IF;

  IF v_admin_role IS DISTINCT FROM 'admin'
     AND v_admin_is_superadmin IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL  = 'The supplied Admin identity is not authorized to claim receipt email delivery.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 2: LOAD AND LOCK THE PAYMENT ROW
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_payment
  FROM public.crm_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Payment does not exist.';
  END IF;

  -- Payment must be in received status
  IF v_payment.status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'payment_not_eligible_for_receipt_email'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Payment status is ''%s''. Only received payments may have a receipt email delivery claimed.',
              v_payment.status
            );
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: REQUIRE RECEIPT COMPLETION BEFORE EMAIL DELIVERY
  -- All receipt fields must be non-NULL before any email can be claimed.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_payment.receipt_number IS NULL
     OR v_payment.receipt_issued_at IS NULL
     OR v_payment.receipt_pdf_storage_path IS NULL
     OR v_payment.receipt_pdf_generated_at IS NULL
     OR v_payment.receipt_pdf_hash IS NULL THEN
    RAISE EXCEPTION 'receipt_email_receipt_incomplete'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Receipt is not complete. All of receipt_number, receipt_issued_at, '
                      'receipt_pdf_storage_path, receipt_pdf_generated_at, and receipt_pdf_hash '
                      'must be non-NULL before a receipt email delivery can be claimed.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: LOAD ASSOCIATED INVOICE AND DERIVE RECIPIENT
  -- Recipient is derived ONLY from crm_invoices.billing_email.
  -- Never from function input.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = v_payment.invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt_email_invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Associated invoice does not exist.';
  END IF;

  -- billing_email is the authoritative recipient snapshot
  -- Do NOT fall back to crm_contacts, borrower_applications, or Auth email
  IF v_invoice.billing_email IS NULL OR trim(v_invoice.billing_email) = '' THEN
    RAISE EXCEPTION 'receipt_email_missing_billing_email'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice billing_email is missing. Cannot claim receipt email delivery without a recipient.';
  END IF;

  -- Derive canonical values server-side
  v_recipient       := trim(v_invoice.billing_email);
  v_idempotency_key := 'receipt-email/' || p_payment_id::text;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: ATTEMPT FIRST CLAIM (INSERT ON CONFLICT)
  -- If no delivery row exists, create one in 'sending' state atomically.
  -- The UNIQUE(payment_id) constraint prevents concurrent double-inserts.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.crm_receipt_email_deliveries (
    payment_id,
    recipient_email,
    provider,
    provider_idempotency_key,
    delivery_status,
    attempt_count,
    last_attempt_at,
    last_error_code,
    last_error_message
  )
  VALUES (
    p_payment_id,
    v_recipient,
    'resend',
    v_idempotency_key,
    'sending',
    1,
    v_now,
    NULL,
    NULL
  )
  ON CONFLICT (payment_id) DO NOTHING;

  -- Check whether the INSERT succeeded (no conflict) or was blocked (conflict)
  IF FOUND THEN
    -- First claim succeeded — return the newly created row
    SELECT * INTO v_delivery
    FROM public.crm_receipt_email_deliveries
    WHERE payment_id = p_payment_id;

    RETURN QUERY SELECT
      'claimed'::TEXT,
      v_delivery.id,
      v_delivery.payment_id,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.attempt_count;
    RETURN;
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: EXISTING ROW — LOCK FOR UPDATE AND HANDLE ALL STATES
  -- The INSERT conflicted, meaning a delivery row already exists.
  -- Lock it FOR UPDATE to serialize concurrent access.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_delivery
  FROM public.crm_receipt_email_deliveries
  WHERE payment_id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Extremely unlikely race: row was deleted between INSERT conflict and SELECT
    RAISE EXCEPTION 'receipt_email_delivery_race_condition'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Delivery row disappeared between conflict detection and lock acquisition.';
  END IF;


  -- ── SENT: terminal state — do not modify ──────────────────────────────────
  IF v_delivery.delivery_status = 'sent' THEN
    RETURN QUERY SELECT
      'already_sent'::TEXT,
      v_delivery.id,
      v_delivery.payment_id,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.attempt_count;
    RETURN;
  END IF;


  -- ── UNCERTAIN: do not allow automatic retry ────────────────────────────────
  IF v_delivery.delivery_status = 'uncertain' THEN
    RETURN QUERY SELECT
      'uncertain'::TEXT,
      v_delivery.id,
      v_delivery.payment_id,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.attempt_count;
    RETURN;
  END IF;


  -- ── FAILED: valid explicit retry ──────────────────────────────────────────
  IF v_delivery.delivery_status = 'failed' THEN
    UPDATE public.crm_receipt_email_deliveries
    SET
      delivery_status    = 'sending',
      attempt_count      = v_delivery.attempt_count + 1,
      last_attempt_at    = v_now,
      last_error_code    = NULL,
      last_error_message = NULL,
      updated_at         = v_now
    WHERE id = v_delivery.id;

    RETURN QUERY SELECT
      'retry_claimed'::TEXT,
      v_delivery.id,
      v_delivery.payment_id,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.attempt_count + 1;
    RETURN;
  END IF;


  -- ── PENDING: claim it ─────────────────────────────────────────────────────
  IF v_delivery.delivery_status = 'pending' THEN
    UPDATE public.crm_receipt_email_deliveries
    SET
      delivery_status = 'sending',
      attempt_count   = v_delivery.attempt_count + 1,
      last_attempt_at = v_now,
      updated_at      = v_now
    WHERE id = v_delivery.id;

    RETURN QUERY SELECT
      'claimed'::TEXT,
      v_delivery.id,
      v_delivery.payment_id,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.attempt_count + 1;
    RETURN;
  END IF;


  -- ── SENDING: check for stale claim ────────────────────────────────────────
  IF v_delivery.delivery_status = 'sending' THEN

    -- Stale: last_attempt_at is older than 15 minutes (same threshold as invoice email)
    -- Conservatively mark as uncertain rather than failed.
    -- We prefer a missed email over an accidental duplicate when
    -- delivery outcome is unknown.
    IF v_delivery.last_attempt_at IS NOT NULL
       AND v_delivery.last_attempt_at < (v_now - INTERVAL '15 minutes') THEN

      UPDATE public.crm_receipt_email_deliveries
      SET
        delivery_status    = 'uncertain',
        last_error_code    = 'stale_sending_claim',
        last_error_message = 'Previous receipt email send claim became stale before delivery outcome was recorded.',
        updated_at         = v_now
      WHERE id = v_delivery.id;

      RETURN QUERY SELECT
        'uncertain'::TEXT,
        v_delivery.id,
        v_delivery.payment_id,
        v_delivery.recipient_email,
        v_delivery.provider,
        v_delivery.provider_idempotency_key,
        v_delivery.attempt_count;
      RETURN;

    ELSE
      -- Not stale: a live send is in progress
      RETURN QUERY SELECT
        'currently_sending'::TEXT,
        v_delivery.id,
        v_delivery.payment_id,
        v_delivery.recipient_email,
        v_delivery.provider,
        v_delivery.provider_idempotency_key,
        v_delivery.attempt_count;
      RETURN;
    END IF;

  END IF;

  -- Should never reach here — all statuses handled above
  RAISE EXCEPTION 'receipt_email_delivery_unexpected_state'
    USING ERRCODE = 'P0001',
          DETAIL  = format('Unhandled delivery_status value: %s', v_delivery.delivery_status);

END;
$func$;


-- ============================================================
-- SECTION 8: GRANT / REVOKE EXECUTE ON claim_receipt_email_delivery
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  TO service_role;


-- ============================================================
-- SECTION 9: complete_receipt_email_delivery_success()
--
-- Marks a claimed send as successfully accepted by the provider.
--
-- Signature:
--   public.complete_receipt_email_delivery_success(
--     p_delivery_id         UUID,
--     p_provider_message_id TEXT
--   )
--
-- Returns TABLE:
--   outcome         TEXT
--   delivery_id     UUID
--   delivery_status TEXT
--   attempt_count   INTEGER
--
-- Possible outcome values:
--   sent         — successfully marked as sent
--   already_sent — row was already sent with the same message ID (idempotent)
--
-- VALIDATION
-- ----------
-- - delivery row must exist
-- - p_provider_message_id must be non-null and nonblank
-- - delivery_status must be 'sending'
--
-- IDEMPOTENCY
-- -----------
-- If status = 'sent' AND provider_message_id = trim(p_provider_message_id):
--   returns 'already_sent' without modifying the row.
-- If status = 'sent' AND provider_message_id differs:
--   raises an integrity error (never overwrite a sent record).
--
-- sent becomes terminal.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_receipt_email_delivery_success(
  p_delivery_id         UUID,
  p_provider_message_id TEXT
)
RETURNS TABLE (
  outcome         TEXT,
  delivery_id     UUID,
  delivery_status TEXT,
  attempt_count   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_delivery  public.crm_receipt_email_deliveries%ROWTYPE;
  v_msg_id    TEXT;
  v_now       TIMESTAMPTZ;
BEGIN

  v_now := now();

  -- ── Input validation ──────────────────────────────────────────────────────

  IF p_provider_message_id IS NULL OR trim(p_provider_message_id) = '' THEN
    RAISE EXCEPTION 'receipt_email_delivery_invalid_input'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_provider_message_id must be non-null and nonblank.';
  END IF;

  v_msg_id := trim(p_provider_message_id);

  -- ── Lock delivery row FOR UPDATE ──────────────────────────────────────────

  SELECT * INTO v_delivery
  FROM public.crm_receipt_email_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt_email_delivery_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Delivery row does not exist.';
  END IF;

  -- ── Idempotency: already sent with same message ID ────────────────────────

  IF v_delivery.delivery_status = 'sent' THEN
    IF v_delivery.provider_message_id = v_msg_id THEN
      -- Repeated completion call with same message ID — harmless
      RETURN QUERY SELECT
        'already_sent'::TEXT,
        v_delivery.id,
        v_delivery.delivery_status,
        v_delivery.attempt_count;
      RETURN;
    ELSE
      -- Sent with a DIFFERENT message ID — integrity violation
      RAISE EXCEPTION 'receipt_email_delivery_integrity_error'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Delivery row is already sent with a different provider_message_id. '
                        'Cannot overwrite a confirmed sent record.';
    END IF;
  END IF;

  -- ── Normal success: require sending state ─────────────────────────────────

  IF v_delivery.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'receipt_email_delivery_not_sending'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Cannot complete success: delivery_status is ''%s'', expected ''sending''.',
              v_delivery.delivery_status
            );
  END IF;

  -- ── Apply success transition ──────────────────────────────────────────────

  UPDATE public.crm_receipt_email_deliveries
  SET
    delivery_status     = 'sent',
    provider_message_id = v_msg_id,
    sent_at             = v_now,
    last_error_code     = NULL,
    last_error_message  = NULL,
    updated_at          = v_now
  WHERE id = p_delivery_id;

  RETURN QUERY SELECT
    'sent'::TEXT,
    v_delivery.id,
    'sent'::TEXT,
    v_delivery.attempt_count;
  RETURN;

END;
$func$;


-- ============================================================
-- SECTION 10: GRANT / REVOKE EXECUTE ON complete_receipt_email_delivery_success
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.complete_receipt_email_delivery_success(UUID, TEXT)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.complete_receipt_email_delivery_success(UUID, TEXT)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.complete_receipt_email_delivery_success(UUID, TEXT)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.complete_receipt_email_delivery_success(UUID, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 11: complete_receipt_email_delivery_failure()
--
-- Records a definite provider rejection/failure where the server
-- knows the email was NOT successfully accepted.
-- This is NOT for uncertain outcomes — use
-- mark_receipt_email_delivery_uncertain when the outcome cannot
-- be safely proven.
--
-- Signature:
--   public.complete_receipt_email_delivery_failure(
--     p_delivery_id   UUID,
--     p_error_code    TEXT,
--     p_error_message TEXT
--   )
--
-- Returns TABLE:
--   outcome         TEXT
--   delivery_id     UUID
--   delivery_status TEXT
--   attempt_count   INTEGER
--
-- Possible outcome values:
--   failed — successfully marked as failed (retryable via claim RPC)
--
-- VALIDATION
-- ----------
-- - delivery_status must be 'sending'
--
-- SAFETY
-- ------
-- Never overwrites sent or uncertain.
-- provider_message_id remains NULL.
-- sent_at remains NULL.
-- last_error_message is truncated to 1000 characters.
-- Do not store: request bodies, PDF data, wire instructions, secrets, tokens.
-- failed remains retryable only through the claim RPC.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_receipt_email_delivery_failure(
  p_delivery_id   UUID,
  p_error_code    TEXT,
  p_error_message TEXT
)
RETURNS TABLE (
  outcome         TEXT,
  delivery_id     UUID,
  delivery_status TEXT,
  attempt_count   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_delivery      public.crm_receipt_email_deliveries%ROWTYPE;
  v_error_code    TEXT;
  v_error_message TEXT;
  v_now           TIMESTAMPTZ;
BEGIN

  v_now := now();

  -- Normalize error fields — store NULL for blank codes, truncate messages
  v_error_code    := NULLIF(trim(COALESCE(p_error_code, '')), '');
  v_error_message := left(trim(COALESCE(p_error_message, '')), 1000);
  IF v_error_message = '' THEN v_error_message := NULL; END IF;

  -- ── Lock delivery row FOR UPDATE ──────────────────────────────────────────

  SELECT * INTO v_delivery
  FROM public.crm_receipt_email_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt_email_delivery_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Delivery row does not exist.';
  END IF;

  -- ── Never overwrite sent or uncertain ────────────────────────────────────

  IF v_delivery.delivery_status = 'sent' THEN
    RAISE EXCEPTION 'receipt_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cannot record failure: delivery is already in sent state.';
  END IF;

  IF v_delivery.delivery_status = 'uncertain' THEN
    RAISE EXCEPTION 'receipt_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cannot record failure: delivery is already in uncertain state. '
                      'Manual admin intervention is required.';
  END IF;

  -- ── Require sending state ─────────────────────────────────────────────────

  IF v_delivery.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'receipt_email_delivery_not_sending'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Cannot record failure: delivery_status is ''%s'', expected ''sending''.',
              v_delivery.delivery_status
            );
  END IF;

  -- ── Apply failure transition ──────────────────────────────────────────────
  -- provider_message_id remains NULL
  -- sent_at remains NULL

  UPDATE public.crm_receipt_email_deliveries
  SET
    delivery_status    = 'failed',
    last_error_code    = v_error_code,
    last_error_message = v_error_message,
    updated_at         = v_now
  WHERE id = p_delivery_id;

  RETURN QUERY SELECT
    'failed'::TEXT,
    v_delivery.id,
    'failed'::TEXT,
    v_delivery.attempt_count;
  RETURN;

END;
$func$;


-- ============================================================
-- SECTION 12: GRANT / REVOKE EXECUTE ON complete_receipt_email_delivery_failure
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.complete_receipt_email_delivery_failure(UUID, TEXT, TEXT)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.complete_receipt_email_delivery_failure(UUID, TEXT, TEXT)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.complete_receipt_email_delivery_failure(UUID, TEXT, TEXT)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.complete_receipt_email_delivery_failure(UUID, TEXT, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 13: mark_receipt_email_delivery_uncertain()
--
-- Records an uncertain outcome when the application cannot safely
-- prove whether the provider accepted/sent the email.
--
-- Examples:
--   - network timeout during provider call
--   - malformed response after provider call
--   - provider success received but local completion could not be
--     safely finalized
--
-- Signature:
--   public.mark_receipt_email_delivery_uncertain(
--     p_delivery_id   UUID,
--     p_error_code    TEXT,
--     p_error_message TEXT
--   )
--
-- Returns TABLE:
--   outcome         TEXT
--   delivery_id     UUID
--   delivery_status TEXT
--   attempt_count   INTEGER
--
-- Possible outcome values:
--   uncertain — successfully marked as uncertain
--
-- VALIDATION
-- ----------
-- - delivery_status must be 'sending'
--
-- SAFETY
-- ------
-- sent_at is NOT set.
-- last_error_message truncated to 1000 characters.
-- Once uncertain, the claim RPC refuses automatic retry.
-- uncertain is terminal for AUTOMATIC retries.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_receipt_email_delivery_uncertain(
  p_delivery_id   UUID,
  p_error_code    TEXT,
  p_error_message TEXT
)
RETURNS TABLE (
  outcome         TEXT,
  delivery_id     UUID,
  delivery_status TEXT,
  attempt_count   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_delivery      public.crm_receipt_email_deliveries%ROWTYPE;
  v_error_code    TEXT;
  v_error_message TEXT;
  v_now           TIMESTAMPTZ;
BEGIN

  v_now := now();

  -- Normalize error fields
  v_error_code    := NULLIF(trim(COALESCE(p_error_code, '')), '');
  v_error_message := left(trim(COALESCE(p_error_message, '')), 1000);
  IF v_error_message = '' THEN v_error_message := NULL; END IF;

  -- ── Lock delivery row FOR UPDATE ──────────────────────────────────────────

  SELECT * INTO v_delivery
  FROM public.crm_receipt_email_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt_email_delivery_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Delivery row does not exist.';
  END IF;

  -- ── Require sending state ─────────────────────────────────────────────────

  IF v_delivery.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'receipt_email_delivery_not_sending'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Cannot mark uncertain: delivery_status is ''%s'', expected ''sending''.',
              v_delivery.delivery_status
            );
  END IF;

  -- ── Apply uncertain transition ────────────────────────────────────────────
  -- sent_at is NOT set

  UPDATE public.crm_receipt_email_deliveries
  SET
    delivery_status    = 'uncertain',
    last_error_code    = v_error_code,
    last_error_message = v_error_message,
    updated_at         = v_now
  WHERE id = p_delivery_id;

  RETURN QUERY SELECT
    'uncertain'::TEXT,
    v_delivery.id,
    'uncertain'::TEXT,
    v_delivery.attempt_count;
  RETURN;

END;
$func$;


-- ============================================================
-- SECTION 14: GRANT / REVOKE EXECUTE ON mark_receipt_email_delivery_uncertain
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.mark_receipt_email_delivery_uncertain(UUID, TEXT, TEXT)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.mark_receipt_email_delivery_uncertain(UUID, TEXT, TEXT)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.mark_receipt_email_delivery_uncertain(UUID, TEXT, TEXT)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.mark_receipt_email_delivery_uncertain(UUID, TEXT, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 15: VALIDATION SUMMARY
-- ============================================================
--
-- Migration File
--   20261003000000_receipt_email_delivery_foundation.sql
--
-- Table Created
--   public.crm_receipt_email_deliveries
--
-- Functions Created
--   public.crm_receipt_email_deliveries_state_guard_fn()  [trigger function]
--   public.claim_receipt_email_delivery(UUID, UUID)
--   public.complete_receipt_email_delivery_success(UUID, TEXT)
--   public.complete_receipt_email_delivery_failure(UUID, TEXT, TEXT)
--   public.mark_receipt_email_delivery_uncertain(UUID, TEXT, TEXT)
--
-- A. UNIQUE(payment_id)
--   YES — crm_receipt_email_deliveries_unique_payment_id constraint
--
-- B. Recipient derived from crm_invoices.billing_email
--   YES — derived via payment.invoice_id → crm_invoices.billing_email
--   Never from function input
--
-- C. Receipt must be complete before claim
--   YES — receipt_number, receipt_issued_at, receipt_pdf_storage_path,
--   receipt_pdf_generated_at, receipt_pdf_hash all checked non-NULL
--
-- D. Admin verified from auth.users metadata
--   YES — raw_app_meta_data->>'role' = 'admin'
--   OR raw_app_meta_data->>'is_superadmin' = 'true'
--
-- E. Provider idempotency key derived server-side
--   YES — 'receipt-email/' || payment_id::text, generated inside claim RPC
--   Never accepted from caller input
--
-- F. Failed retryable
--   YES — claim RPC transitions failed → sending, increments attempt_count
--
-- G. Uncertain not retryable
--   YES — claim RPC returns 'uncertain' without modification
--   State-machine trigger blocks uncertain → any other state
--
-- H. Sent terminal
--   YES — claim RPC returns 'already_sent' without modification
--   State-machine trigger blocks sent → any other state
--
-- I. Stale sending → uncertain using same threshold as invoice email
--   YES — 15 minutes (last_attempt_at < now() - INTERVAL '15 minutes')
--
-- J. attempt_count increments correctly
--   YES — increments on first claim (INSERT with attempt_count=1)
--   and on every retry_claimed / pending→sending transition
--
-- K. service_role only RPC execution
--   YES — REVOKE from PUBLIC, anon, authenticated; GRANT to service_role only
--
-- L. No existing tables/RPCs modified
--   YES — this migration is purely additive
--
-- M. No delivery rows inserted
--   YES — zero crm_receipt_email_deliveries rows created
--
-- N. Migration not deployed
--   YES — file created only, not pushed to Supabase
--
-- Emails Sent
--   0
--
-- Business Rows Created
--   0
--
-- Existing Payments Modified
--   0
--
-- Existing Invoices Modified
--   0
--
-- Netlify Deploy Required
--   NO
--
-- Supabase Push Performed
--   NO
-- ============================================================
