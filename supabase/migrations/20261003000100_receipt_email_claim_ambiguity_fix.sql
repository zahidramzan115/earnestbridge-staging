-- ============================================================
-- Migration: 20261003000100_receipt_email_claim_ambiguity_fix
--
-- Phase 7B-11B2 — Fix claim_receipt_email_delivery() ambiguous payment_id
--
-- PROBLEM
-- -------
-- Production error:
--   ERROR: 42702: column reference "payment_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- ROOT CAUSE
-- ----------
-- claim_receipt_email_delivery() RETURNS TABLE declares output columns
-- (outcome, delivery_id, payment_id, recipient_email, provider,
-- provider_idempotency_key, attempt_count). In PL/pgSQL these become
-- variables in function scope, so unqualified references to payment_id
-- inside SQL statements collide with
-- crm_receipt_email_deliveries.payment_id.
--
-- FIX
-- ---
-- 1. ON CONFLICT (payment_id) → ON CONFLICT ON CONSTRAINT
--    crm_receipt_email_deliveries_unique_payment_id
-- 2. All SELECT/UPDATE statements against crm_receipt_email_deliveries
--    use an explicit table alias (d) and qualified column references.
--
-- SCOPE
-- -----
-- Replaces ONLY public.claim_receipt_email_delivery(UUID, UUID).
-- The RPC contract (signature, RETURNS TABLE) is unchanged.
-- No tables, constraints, indexes, triggers, or finalizer RPCs are
-- modified. No #variable_conflict directive is used.
-- The deployed migration 20261003000000 is NOT modified.
--
-- Emails sent: 0. Delivery rows created: 0.
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
    u.raw_app_meta_data->>'role',
    u.raw_app_meta_data->>'is_superadmin'
  INTO v_admin_role, v_admin_is_superadmin
  FROM auth.users AS u
  WHERE u.id = p_admin_user_id;

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

  SELECT p.*
  INTO v_payment
  FROM public.crm_payments AS p
  WHERE p.id = p_payment_id
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

  SELECT i.*
  INTO v_invoice
  FROM public.crm_invoices AS i
  WHERE i.id = v_payment.invoice_id;

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
  --
  -- ON CONFLICT uses the NAMED constraint (not the column name) so the
  -- RETURNS TABLE output variable payment_id cannot be confused with the
  -- table column.
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
  ON CONFLICT ON CONSTRAINT crm_receipt_email_deliveries_unique_payment_id
  DO NOTHING;

  -- Check whether the INSERT succeeded (no conflict) or was blocked (conflict)
  IF FOUND THEN
    -- First claim succeeded — return the newly created row
    SELECT d.*
    INTO v_delivery
    FROM public.crm_receipt_email_deliveries AS d
    WHERE d.payment_id = p_payment_id;

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

  SELECT d.*
  INTO v_delivery
  FROM public.crm_receipt_email_deliveries AS d
  WHERE d.payment_id = p_payment_id
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
    UPDATE public.crm_receipt_email_deliveries AS d
    SET
      delivery_status    = 'sending',
      attempt_count      = v_delivery.attempt_count + 1,
      last_attempt_at    = v_now,
      last_error_code    = NULL,
      last_error_message = NULL,
      updated_at         = v_now
    WHERE d.id = v_delivery.id;

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
    UPDATE public.crm_receipt_email_deliveries AS d
    SET
      delivery_status = 'sending',
      attempt_count   = v_delivery.attempt_count + 1,
      last_attempt_at = v_now,
      updated_at      = v_now
    WHERE d.id = v_delivery.id;

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

      UPDATE public.crm_receipt_email_deliveries AS d
      SET
        delivery_status    = 'uncertain',
        last_error_code    = 'stale_sending_claim',
        last_error_message = 'Previous receipt email send claim became stale before delivery outcome was recorded.',
        updated_at         = v_now
      WHERE d.id = v_delivery.id;

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
-- PERMISSIONS (preserved / re-hardened)
-- CREATE OR REPLACE keeps existing ACLs, but we re-apply explicitly.
-- service_role only. Access is NOT broadened.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.claim_receipt_email_delivery(UUID, UUID)
  TO service_role;
