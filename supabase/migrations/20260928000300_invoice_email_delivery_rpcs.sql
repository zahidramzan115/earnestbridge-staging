-- ============================================================
-- Migration: 20260928000300_invoice_email_delivery_rpcs
--
-- Step 5E-1B — Invoice Email Atomic Claim + Finalize RPCs
--
-- PREREQUISITE
-- ------------
-- 20260928000200_crm_invoice_email_deliveries.sql must already be
-- deployed. This migration does NOT modify that migration.
--
-- PURPOSE
-- -------
-- Creates four hardened SECURITY DEFINER RPCs that control the
-- complete lifecycle of one canonical issued-invoice email delivery,
-- plus a BEFORE UPDATE trigger that enforces immutable core fields
-- and legal status transitions on crm_invoice_email_deliveries.
--
-- FUNCTIONS CREATED
-- -----------------
-- 1. public.claim_invoice_email_delivery(p_invoice_id, p_admin_user_id)
--    Atomic claim RPC. Admin-authenticated. Derives recipient and
--    idempotency key from crm_invoices. Handles first-claim, retry,
--    already-sent, uncertain, and stale-sending logic.
--
-- 2. public.complete_invoice_email_delivery_success(
--      p_delivery_id, p_attempt_count, p_provider_message_id)
--    Marks a claimed send as successfully accepted by the provider.
--    Idempotent for repeated success calls with the same message ID.
--
-- 3. public.complete_invoice_email_delivery_failure(
--      p_delivery_id, p_attempt_count, p_error_code, p_error_message)
--    Records a definite provider rejection. Retryable via claim RPC.
--
-- 4. public.mark_invoice_email_delivery_uncertain(
--      p_delivery_id, p_attempt_count, p_error_code, p_error_message,
--      p_provider_message_id DEFAULT NULL)
--    Records an uncertain outcome. NOT automatically retryable.
--
-- TRIGGER CREATED
-- ---------------
-- crm_invoice_email_deliveries_state_guard (BEFORE UPDATE)
-- Enforces:
--   - Core identity fields are immutable after INSERT
--   - Only legal status transitions are permitted
--
-- SECURITY
-- --------
-- All RPCs use:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
-- Admin authorization uses ONLY raw_app_meta_data->>'role' = 'admin'
-- EXECUTE is REVOKED from PUBLIC, anon, and authenticated.
-- EXECUTE is GRANTED only to service_role (and postgres for trigger
-- function compatibility).
-- The browser must never call these RPCs directly.
--
-- LIFECYCLE SUPPORTED
-- -------------------
-- no row → sending → sent
-- no row → sending → failed → sending → sent
-- sending → uncertain  (stale: last_attempt_at < now() - 15 min)
--
-- An uncertain delivery must NOT be automatically retried.
-- A sent delivery must NEVER be sent again through the normal pipeline.
--
-- NO SIDE EFFECTS
-- ---------------
-- These RPCs do NOT:
--   - call Resend or any email provider
--   - call Edge Functions
--   - download PDFs
--   - create crm_email_log rows
--   - create application_activity rows
--   - modify invoice status or PDF state
--   - change Contact data
-- They control ONLY canonical delivery state.
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- crm_invoice_email_deliveries rows created: 0
-- crm_invoices rows changed:                 0
-- emails sent:                               0
-- ============================================================


-- ============================================================
-- SECTION 1: BEFORE UPDATE STATE-MACHINE TRIGGER
--
-- Enforces on crm_invoice_email_deliveries:
--
-- A. Core identity fields are immutable after INSERT:
--      invoice_id
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
-- Illegal transitions (explicitly blocked):
--      sent      → any other state
--      uncertain → sending
--      uncertain → failed
--      uncertain → sent (through normal automatic flow)
--      failed    → sent  (directly, without going through sending)
--      pending   → sent  (directly)
--
-- RATIONALE FOR TRIGGER VS. RPC-ONLY ENFORCEMENT
-- -----------------------------------------------
-- The four RPCs already enforce legal transitions in their own
-- logic. However, a BEFORE UPDATE trigger provides a defense-in-depth
-- layer that cannot be bypassed by future code paths, direct SQL
-- updates, or administrative corrections that forget the state machine.
-- The trigger is the authoritative enforcement point; the RPCs are
-- compatible with it (they only perform transitions the trigger allows).
--
-- The trigger allows same-status updates (OLD.delivery_status =
-- NEW.delivery_status) because the controlled RPCs legitimately update
-- other fields (attempt_count, last_attempt_at, error fields, etc.)
-- while keeping the same status in some code paths.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crm_invoice_email_deliveries_state_guard_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
BEGIN

  -- ── A. IMMUTABLE CORE IDENTITY FIELDS ─────────────────────────────────────

  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'invoice_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'invoice_id is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.recipient_email IS DISTINCT FROM OLD.recipient_email THEN
    RAISE EXCEPTION 'invoice_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'recipient_email is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'invoice_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'provider is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key THEN
    RAISE EXCEPTION 'invoice_email_delivery_immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL  = 'provider_idempotency_key is immutable after INSERT and cannot be changed.';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'invoice_email_delivery_immutable_field'
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
    RAISE EXCEPTION 'invoice_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Illegal status transition: sent → %s. '
              'The sent state is terminal and cannot be changed.',
              NEW.delivery_status
            );
  END IF;

  -- uncertain must NOT be automatically retried
  -- (only allowed transition out of uncertain would be a manual admin override,
  --  which is not implemented in the normal pipeline)
  IF OLD.delivery_status = 'uncertain' THEN
    RAISE EXCEPTION 'invoice_email_delivery_illegal_transition'
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
    RAISE EXCEPTION 'invoice_email_delivery_illegal_transition'
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
    RAISE EXCEPTION 'invoice_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Illegal status transition: sending → %s. '
              'sending may only transition to sent, failed, or uncertain.',
              NEW.delivery_status
            );
  END IF;

  -- failed may only go to sending (explicit retry)
  IF OLD.delivery_status = 'failed' AND NEW.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'invoice_email_delivery_illegal_transition'
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
DROP TRIGGER IF EXISTS crm_invoice_email_deliveries_state_guard
  ON public.crm_invoice_email_deliveries;

CREATE TRIGGER crm_invoice_email_deliveries_state_guard
  BEFORE UPDATE ON public.crm_invoice_email_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_invoice_email_deliveries_state_guard_fn();

-- Grant trigger function to postgres (required for trigger execution)
GRANT EXECUTE ON FUNCTION public.crm_invoice_email_deliveries_state_guard_fn()
  TO postgres;


-- ============================================================
-- SECTION 2: claim_invoice_email_delivery()
--
-- Atomic claim RPC. Called by trusted server code AFTER Admin
-- authentication. Derives all canonical values from crm_invoices.
-- The caller provides ONLY invoice_id and Admin user ID.
--
-- Signature:
--   public.claim_invoice_email_delivery(
--     p_invoice_id    UUID,
--     p_admin_user_id UUID
--   )
--
-- Returns TABLE:
--   outcome                  TEXT
--   delivery_id              UUID
--   delivery_status          TEXT
--   recipient_email          TEXT
--   provider                 TEXT
--   provider_idempotency_key TEXT
--   provider_message_id      TEXT
--   attempt_count            INTEGER
--
-- Possible outcome values:
--   claimed           — new delivery row created in sending state
--   retry_claimed     — existing failed row reclaimed for retry
--   already_sent      — delivery already confirmed sent; do not resend
--   uncertain         — delivery outcome unknown; do not auto-retry
--   currently_sending — a send is already in progress (not stale)
--
-- ADMIN AUTHORIZATION
-- -------------------
-- Validates p_admin_user_id against auth.users.
-- Uses ONLY raw_app_meta_data->>'role' = 'admin'.
-- Raises insufficient_privilege if not authorized.
--
-- INVOICE ELIGIBILITY
-- -------------------
-- Eligible statuses: open, partially_paid, paid
-- (automatic send happens while open; legitimate failed-email retry
--  may occur later after payment state changes)
-- NOT eligible: draft, issuing, void
--
-- Also requires:
--   invoice_number IS NOT NULL and nonblank
--   issued_at IS NOT NULL
--   pdf_generation_status = 'generated'
--   pdf_storage_path IS NOT NULL and nonblank
--   billing_email IS NOT NULL and nonblank
--
-- CONCURRENCY
-- -----------
-- Uses INSERT ON CONFLICT + FOR UPDATE row locking to ensure two
-- concurrent requests for the same invoice cannot both receive
-- permission to send.
--
-- IDEMPOTENCY KEY
-- ---------------
-- Generated INSIDE the RPC as: 'invoice-issued/' || invoice_id::text
-- Never accepted from caller input.
--
-- STALE SENDING DETECTION
-- -----------------------
-- If delivery_status = 'sending' AND last_attempt_at < now() - 15 min:
--   → transitions to 'uncertain' (NOT to 'failed')
--   → returns outcome 'uncertain'
-- We prefer a missed email over an accidental duplicate when delivery
-- outcome is unknown.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_invoice_email_delivery(
  p_invoice_id    UUID,
  p_admin_user_id UUID
)
RETURNS TABLE (
  outcome                  TEXT,
  delivery_id              UUID,
  delivery_status          TEXT,
  recipient_email          TEXT,
  provider                 TEXT,
  provider_idempotency_key TEXT,
  provider_message_id      TEXT,
  attempt_count            INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_admin_role              TEXT;
  v_invoice                 public.crm_invoices%ROWTYPE;
  v_idempotency_key         TEXT;
  v_recipient               TEXT;
  v_delivery                public.crm_invoice_email_deliveries%ROWTYPE;
  v_now                     TIMESTAMPTZ;
BEGIN

  v_now := now();

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
      USING ERRCODE = 'insufficient_privilege',
            DETAIL  = 'The supplied Admin identity is not authorized to claim invoice email delivery.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 2: LOAD AND VALIDATE INVOICE
  -- All canonical values are derived from crm_invoices server-side.
  -- The caller does NOT supply recipient, idempotency key, PDF path, or
  -- invoice number.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = p_invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice does not exist.';
  END IF;

  -- Eligible statuses: open, partially_paid, paid
  -- NOT eligible: draft, issuing, void
  IF v_invoice.status NOT IN ('open', 'partially_paid', 'paid') THEN
    RAISE EXCEPTION 'invoice_not_eligible_for_email'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Invoice status is ''%s''. Only open, partially_paid, or paid invoices '
              'may have an email delivery claimed.',
              v_invoice.status
            );
  END IF;

  -- invoice_number must be assigned and nonblank
  IF v_invoice.invoice_number IS NULL OR trim(v_invoice.invoice_number) = '' THEN
    RAISE EXCEPTION 'invoice_not_eligible_for_email'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice has no invoice_number assigned. Cannot claim email delivery.';
  END IF;

  -- issued_at must be set
  IF v_invoice.issued_at IS NULL THEN
    RAISE EXCEPTION 'invoice_not_eligible_for_email'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice issued_at is NULL. Cannot claim email delivery for an unissued invoice.';
  END IF;

  -- PDF must be generated
  IF v_invoice.pdf_generation_status IS DISTINCT FROM 'generated' THEN
    RAISE EXCEPTION 'invoice_not_eligible_for_email'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Invoice pdf_generation_status is ''%s''. PDF must be generated before email delivery.',
              v_invoice.pdf_generation_status
            );
  END IF;

  -- pdf_storage_path must be present and nonblank
  IF v_invoice.pdf_storage_path IS NULL OR trim(v_invoice.pdf_storage_path) = '' THEN
    RAISE EXCEPTION 'invoice_not_eligible_for_email'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice pdf_storage_path is missing. Cannot claim email delivery.';
  END IF;

  -- billing_email is the authoritative recipient snapshot
  -- Do NOT fall back to crm_contacts, borrower_applications, or Auth email
  IF v_invoice.billing_email IS NULL OR trim(v_invoice.billing_email) = '' THEN
    RAISE EXCEPTION 'invoice_not_eligible_for_email'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice billing_email is missing. Cannot claim email delivery without a recipient.';
  END IF;

  -- Derive canonical values server-side
  v_recipient       := trim(v_invoice.billing_email);
  v_idempotency_key := 'invoice-issued/' || p_invoice_id::text;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: ATTEMPT FIRST CLAIM (INSERT ON CONFLICT)
  -- If no delivery row exists, create one in 'sending' state atomically.
  -- The UNIQUE(invoice_id) constraint prevents concurrent double-inserts.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.crm_invoice_email_deliveries (
    invoice_id,
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
    p_invoice_id,
    v_recipient,
    'resend',
    v_idempotency_key,
    'sending',
    1,
    v_now,
    NULL,
    NULL
  )
  ON CONFLICT (invoice_id) DO NOTHING;

  -- Check whether the INSERT succeeded (no conflict) or was blocked (conflict)
  IF FOUND THEN
    -- First claim succeeded — return the newly created row
    SELECT * INTO v_delivery
    FROM public.crm_invoice_email_deliveries
    WHERE invoice_id = p_invoice_id;

    RETURN QUERY SELECT
      'claimed'::TEXT,
      v_delivery.id,
      v_delivery.delivery_status,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.provider_message_id,
      v_delivery.attempt_count;
    RETURN;
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: EXISTING ROW — LOCK FOR UPDATE AND HANDLE ALL STATES
  -- The INSERT conflicted, meaning a delivery row already exists.
  -- Lock it FOR UPDATE to serialize concurrent access.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_delivery
  FROM public.crm_invoice_email_deliveries
  WHERE invoice_id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Extremely unlikely race: row was deleted between INSERT conflict and SELECT
    RAISE EXCEPTION 'invoice_email_delivery_race_condition'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Delivery row disappeared between conflict detection and lock acquisition.';
  END IF;


  -- ── SENT: terminal state — do not modify ──────────────────────────────────
  IF v_delivery.delivery_status = 'sent' THEN
    RETURN QUERY SELECT
      'already_sent'::TEXT,
      v_delivery.id,
      v_delivery.delivery_status,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.provider_message_id,
      v_delivery.attempt_count;
    RETURN;
  END IF;


  -- ── UNCERTAIN: do not allow automatic retry ────────────────────────────────
  IF v_delivery.delivery_status = 'uncertain' THEN
    RETURN QUERY SELECT
      'uncertain'::TEXT,
      v_delivery.id,
      v_delivery.delivery_status,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.provider_message_id,
      v_delivery.attempt_count;
    RETURN;
  END IF;


  -- ── FAILED: valid explicit retry ──────────────────────────────────────────
  IF v_delivery.delivery_status = 'failed' THEN
    UPDATE public.crm_invoice_email_deliveries
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
      'sending'::TEXT,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      NULL::TEXT,                        -- provider_message_id cleared on retry
      v_delivery.attempt_count + 1;
    RETURN;
  END IF;


  -- ── PENDING: claim it ─────────────────────────────────────────────────────
  IF v_delivery.delivery_status = 'pending' THEN
    UPDATE public.crm_invoice_email_deliveries
    SET
      delivery_status = 'sending',
      attempt_count   = v_delivery.attempt_count + 1,
      last_attempt_at = v_now,
      updated_at      = v_now
    WHERE id = v_delivery.id;

    RETURN QUERY SELECT
      'claimed'::TEXT,
      v_delivery.id,
      'sending'::TEXT,
      v_delivery.recipient_email,
      v_delivery.provider,
      v_delivery.provider_idempotency_key,
      v_delivery.provider_message_id,
      v_delivery.attempt_count + 1;
    RETURN;
  END IF;


  -- ── SENDING: check for stale claim ────────────────────────────────────────
  IF v_delivery.delivery_status = 'sending' THEN

    -- Stale: last_attempt_at is older than 15 minutes
    -- Conservatively mark as uncertain rather than failed.
    -- We prefer a missed email over an accidental duplicate when
    -- delivery outcome is unknown.
    IF v_delivery.last_attempt_at IS NOT NULL
       AND v_delivery.last_attempt_at < (v_now - INTERVAL '15 minutes') THEN

      UPDATE public.crm_invoice_email_deliveries
      SET
        delivery_status    = 'uncertain',
        last_error_code    = 'stale_sending_claim',
        last_error_message = 'Previous email send claim became stale before delivery outcome was recorded.',
        updated_at         = v_now
      WHERE id = v_delivery.id;

      RETURN QUERY SELECT
        'uncertain'::TEXT,
        v_delivery.id,
        'uncertain'::TEXT,
        v_delivery.recipient_email,
        v_delivery.provider,
        v_delivery.provider_idempotency_key,
        v_delivery.provider_message_id,
        v_delivery.attempt_count;
      RETURN;

    ELSE
      -- Not stale: a live send is in progress
      RETURN QUERY SELECT
        'currently_sending'::TEXT,
        v_delivery.id,
        v_delivery.delivery_status,
        v_delivery.recipient_email,
        v_delivery.provider,
        v_delivery.provider_idempotency_key,
        v_delivery.provider_message_id,
        v_delivery.attempt_count;
      RETURN;
    END IF;

  END IF;

  -- Should never reach here — all statuses handled above
  RAISE EXCEPTION 'invoice_email_delivery_unexpected_state'
    USING ERRCODE = 'P0001',
          DETAIL  = format('Unhandled delivery_status value: %s', v_delivery.delivery_status);

END;
$func$;


-- ============================================================
-- SECTION 3: GRANT / REVOKE EXECUTE ON claim_invoice_email_delivery
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.claim_invoice_email_delivery(UUID, UUID)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.claim_invoice_email_delivery(UUID, UUID)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.claim_invoice_email_delivery(UUID, UUID)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.claim_invoice_email_delivery(UUID, UUID)
  TO service_role;


-- ============================================================
-- SECTION 4: complete_invoice_email_delivery_success()
--
-- Marks a claimed send as successfully accepted by the provider.
--
-- Signature:
--   public.complete_invoice_email_delivery_success(
--     p_delivery_id         UUID,
--     p_attempt_count       INTEGER,
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
-- - p_attempt_count must be > 0
-- - delivery_status must be 'sending' AND attempt_count = p_attempt_count
--
-- IDEMPOTENCY
-- -----------
-- If status = 'sent' AND provider_message_id = trim(p_provider_message_id):
--   returns 'already_sent' without modifying the row.
-- If status = 'sent' AND provider_message_id differs:
--   raises an integrity error (never overwrite a sent record).
--
-- STALE ATTEMPT PROTECTION
-- ------------------------
-- If attempt_count != p_attempt_count: raises stale_attempt_error.
-- Prevents an older request from overwriting a newer retry attempt.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_invoice_email_delivery_success(
  p_delivery_id         UUID,
  p_attempt_count       INTEGER,
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
  v_delivery  public.crm_invoice_email_deliveries%ROWTYPE;
  v_msg_id    TEXT;
  v_now       TIMESTAMPTZ;
BEGIN

  v_now := now();

  -- ── Input validation ──────────────────────────────────────────────────────

  IF p_provider_message_id IS NULL OR trim(p_provider_message_id) = '' THEN
    RAISE EXCEPTION 'invoice_email_delivery_invalid_input'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_provider_message_id must be non-null and nonblank.';
  END IF;

  IF p_attempt_count IS NULL OR p_attempt_count <= 0 THEN
    RAISE EXCEPTION 'invoice_email_delivery_invalid_input'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_attempt_count must be greater than 0.';
  END IF;

  v_msg_id := trim(p_provider_message_id);

  -- ── Lock delivery row FOR UPDATE ──────────────────────────────────────────

  SELECT * INTO v_delivery
  FROM public.crm_invoice_email_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_email_delivery_not_found'
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
      RAISE EXCEPTION 'invoice_email_delivery_integrity_error'
        USING ERRCODE = 'P0001',
              DETAIL  = 'Delivery row is already sent with a different provider_message_id. '
                        'Cannot overwrite a confirmed sent record.';
    END IF;
  END IF;

  -- ── Stale attempt protection ──────────────────────────────────────────────
  -- If the current attempt_count does not match p_attempt_count, an older
  -- request is trying to complete a newer retry. Reject it.

  IF v_delivery.attempt_count != p_attempt_count THEN
    RAISE EXCEPTION 'invoice_email_delivery_stale_attempt'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Stale attempt: current attempt_count is %s but p_attempt_count is %s. '
              'This completion request is for an outdated send attempt.',
              v_delivery.attempt_count, p_attempt_count
            );
  END IF;

  -- ── Normal success: require sending state ─────────────────────────────────

  IF v_delivery.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'invoice_email_delivery_not_sending'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Cannot complete success: delivery_status is ''%s'', expected ''sending''.',
              v_delivery.delivery_status
            );
  END IF;

  -- ── Apply success transition ──────────────────────────────────────────────

  UPDATE public.crm_invoice_email_deliveries
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
-- SECTION 5: GRANT / REVOKE EXECUTE ON complete_invoice_email_delivery_success
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.complete_invoice_email_delivery_success(UUID, INTEGER, TEXT)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.complete_invoice_email_delivery_success(UUID, INTEGER, TEXT)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.complete_invoice_email_delivery_success(UUID, INTEGER, TEXT)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.complete_invoice_email_delivery_success(UUID, INTEGER, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 6: complete_invoice_email_delivery_failure()
--
-- Records a definite provider rejection/failure where the server
-- knows the email was NOT successfully accepted.
-- This is NOT for uncertain outcomes — use mark_invoice_email_delivery_uncertain
-- when the outcome cannot be safely proven.
--
-- Signature:
--   public.complete_invoice_email_delivery_failure(
--     p_delivery_id   UUID,
--     p_attempt_count INTEGER,
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
-- - attempt_count must match p_attempt_count
--
-- SAFETY
-- ------
-- Never overwrites sent or uncertain.
-- provider_message_id remains NULL.
-- sent_at remains NULL.
-- last_error_message is truncated to 1000 characters.
-- Do not store: request bodies, PDF data, wire instructions, secrets, tokens.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_invoice_email_delivery_failure(
  p_delivery_id   UUID,
  p_attempt_count INTEGER,
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
  v_delivery      public.crm_invoice_email_deliveries%ROWTYPE;
  v_error_code    TEXT;
  v_error_message TEXT;
  v_now           TIMESTAMPTZ;
BEGIN

  v_now := now();

  -- ── Input validation ──────────────────────────────────────────────────────

  IF p_attempt_count IS NULL OR p_attempt_count <= 0 THEN
    RAISE EXCEPTION 'invoice_email_delivery_invalid_input'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_attempt_count must be greater than 0.';
  END IF;

  -- Normalize error fields — store NULL for blank codes, truncate messages
  v_error_code    := NULLIF(trim(COALESCE(p_error_code, '')), '');
  v_error_message := left(trim(COALESCE(p_error_message, '')), 1000);
  IF v_error_message = '' THEN v_error_message := NULL; END IF;

  -- ── Lock delivery row FOR UPDATE ──────────────────────────────────────────

  SELECT * INTO v_delivery
  FROM public.crm_invoice_email_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_email_delivery_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Delivery row does not exist.';
  END IF;

  -- ── Never overwrite sent or uncertain ────────────────────────────────────

  IF v_delivery.delivery_status = 'sent' THEN
    RAISE EXCEPTION 'invoice_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cannot record failure: delivery is already in sent state.';
  END IF;

  IF v_delivery.delivery_status = 'uncertain' THEN
    RAISE EXCEPTION 'invoice_email_delivery_illegal_transition'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Cannot record failure: delivery is already in uncertain state. '
                      'Manual admin intervention is required.';
  END IF;

  -- ── Stale attempt protection ──────────────────────────────────────────────

  IF v_delivery.attempt_count != p_attempt_count THEN
    RAISE EXCEPTION 'invoice_email_delivery_stale_attempt'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Stale attempt: current attempt_count is %s but p_attempt_count is %s.',
              v_delivery.attempt_count, p_attempt_count
            );
  END IF;

  -- ── Require sending state ─────────────────────────────────────────────────

  IF v_delivery.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'invoice_email_delivery_not_sending'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Cannot record failure: delivery_status is ''%s'', expected ''sending''.',
              v_delivery.delivery_status
            );
  END IF;

  -- ── Apply failure transition ──────────────────────────────────────────────
  -- provider_message_id remains NULL
  -- sent_at remains NULL

  UPDATE public.crm_invoice_email_deliveries
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
-- SECTION 7: GRANT / REVOKE EXECUTE ON complete_invoice_email_delivery_failure
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.complete_invoice_email_delivery_failure(UUID, INTEGER, TEXT, TEXT)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.complete_invoice_email_delivery_failure(UUID, INTEGER, TEXT, TEXT)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.complete_invoice_email_delivery_failure(UUID, INTEGER, TEXT, TEXT)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.complete_invoice_email_delivery_failure(UUID, INTEGER, TEXT, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 8: mark_invoice_email_delivery_uncertain()
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
--   public.mark_invoice_email_delivery_uncertain(
--     p_delivery_id         UUID,
--     p_attempt_count       INTEGER,
--     p_error_code          TEXT,
--     p_error_message       TEXT,
--     p_provider_message_id TEXT DEFAULT NULL
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
-- - attempt_count must match p_attempt_count
--
-- SAFETY
-- ------
-- provider_message_id stored ONLY if actually known (non-null/nonblank).
-- sent_at is NOT set.
-- last_error_message truncated to 1000 characters.
-- Once uncertain, the claim RPC refuses automatic retry.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_invoice_email_delivery_uncertain(
  p_delivery_id         UUID,
  p_attempt_count       INTEGER,
  p_error_code          TEXT,
  p_error_message       TEXT,
  p_provider_message_id TEXT DEFAULT NULL
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
  v_delivery      public.crm_invoice_email_deliveries%ROWTYPE;
  v_error_code    TEXT;
  v_error_message TEXT;
  v_msg_id        TEXT;
  v_now           TIMESTAMPTZ;
BEGIN

  v_now := now();

  -- ── Input validation ──────────────────────────────────────────────────────

  IF p_attempt_count IS NULL OR p_attempt_count <= 0 THEN
    RAISE EXCEPTION 'invoice_email_delivery_invalid_input'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_attempt_count must be greater than 0.';
  END IF;

  -- Normalize error fields
  v_error_code    := NULLIF(trim(COALESCE(p_error_code, '')), '');
  v_error_message := left(trim(COALESCE(p_error_message, '')), 1000);
  IF v_error_message = '' THEN v_error_message := NULL; END IF;

  -- Store provider_message_id ONLY if actually known
  v_msg_id := NULLIF(trim(COALESCE(p_provider_message_id, '')), '');

  -- ── Lock delivery row FOR UPDATE ──────────────────────────────────────────

  SELECT * INTO v_delivery
  FROM public.crm_invoice_email_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_email_delivery_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Delivery row does not exist.';
  END IF;

  -- ── Stale attempt protection ──────────────────────────────────────────────

  IF v_delivery.attempt_count != p_attempt_count THEN
    RAISE EXCEPTION 'invoice_email_delivery_stale_attempt'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Stale attempt: current attempt_count is %s but p_attempt_count is %s.',
              v_delivery.attempt_count, p_attempt_count
            );
  END IF;

  -- ── Require sending state ─────────────────────────────────────────────────

  IF v_delivery.delivery_status != 'sending' THEN
    RAISE EXCEPTION 'invoice_email_delivery_not_sending'
      USING ERRCODE = 'P0001',
            DETAIL  = format(
              'Cannot mark uncertain: delivery_status is ''%s'', expected ''sending''.',
              v_delivery.delivery_status
            );
  END IF;

  -- ── Apply uncertain transition ────────────────────────────────────────────
  -- sent_at is NOT set
  -- provider_message_id stored only if known

  UPDATE public.crm_invoice_email_deliveries
  SET
    delivery_status     = 'uncertain',
    provider_message_id = COALESCE(v_msg_id, provider_message_id),
    last_error_code     = v_error_code,
    last_error_message  = v_error_message,
    updated_at          = v_now
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
-- SECTION 9: GRANT / REVOKE EXECUTE ON mark_invoice_email_delivery_uncertain
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.mark_invoice_email_delivery_uncertain(UUID, INTEGER, TEXT, TEXT, TEXT)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.mark_invoice_email_delivery_uncertain(UUID, INTEGER, TEXT, TEXT, TEXT)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.mark_invoice_email_delivery_uncertain(UUID, INTEGER, TEXT, TEXT, TEXT)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.mark_invoice_email_delivery_uncertain(UUID, INTEGER, TEXT, TEXT, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 10: VALIDATION SUMMARY
-- ============================================================
--
-- Migration File
--   20260928000300_invoice_email_delivery_rpcs.sql
--
-- Functions Created
--   public.crm_invoice_email_deliveries_state_guard_fn()  [trigger function]
--   public.claim_invoice_email_delivery(UUID, UUID)
--   public.complete_invoice_email_delivery_success(UUID, INTEGER, TEXT)
--   public.complete_invoice_email_delivery_failure(UUID, INTEGER, TEXT, TEXT)
--   public.mark_invoice_email_delivery_uncertain(UUID, INTEGER, TEXT, TEXT, TEXT)
--
-- Claim Admin Authorization
--   app_metadata only: YES
--   raw_app_meta_data->>'role' = 'admin' — never raw_user_meta_data
--
-- Ordinary Authenticated Browser Can Execute RPCs
--   NO — REVOKE from PUBLIC, anon, authenticated; GRANT to service_role only
--
-- Recipient Caller-Controlled
--   NO — derived from crm_invoices.billing_email inside the RPC
--
-- Recipient Source
--   crm_invoices.billing_email (immutable snapshot)
--
-- Provider Idempotency Key Caller-Controlled
--   NO — generated inside claim RPC as 'invoice-issued/' || invoice_id::text
--
-- Provider Idempotency Key Format
--   invoice-issued/{invoice_id}
--
-- Concurrent Double Claim Prevented
--   YES — INSERT ON CONFLICT (invoice_id) DO NOTHING + SELECT FOR UPDATE
--   Two concurrent requests: first INSERT wins; second INSERT is blocked by
--   UNIQUE(invoice_id), then falls through to SELECT FOR UPDATE and sees
--   the already-claimed 'sending' row, returning 'currently_sending'.
--
-- Sent Delivery Can Be Reclaimed
--   NO — claim RPC returns 'already_sent' without modifying the row
--
-- Failed Delivery Can Be Retried
--   YES — claim RPC transitions failed → sending, increments attempt_count
--
-- Uncertain Delivery Can Be Automatically Retried
--   NO — claim RPC returns 'uncertain' without modifying the row
--
-- Stale Sending Becomes
--   uncertain after 15 minutes (last_attempt_at < now() - interval '15 minutes')
--   NOT failed — we prefer a missed email over an accidental duplicate
--
-- Attempt Count Guards Completion
--   YES — both success and failure RPCs reject if attempt_count != p_attempt_count
--
-- Sent Completion Idempotent
--   YES — repeated call with same provider_message_id returns 'already_sent'
--
-- Sent State Terminal
--   YES — trigger blocks sent → any other state; success RPC never transitions away
--
-- Core Delivery Identity Immutable
--   YES — BEFORE UPDATE trigger blocks changes to invoice_id, recipient_email,
--   provider, provider_idempotency_key, created_at
--
-- Emails Sent
--   0
--
-- Business Rows Created
--   0
--
-- Existing Invoices Modified
--   0
--
-- Netlify Deploy Required
--   NO
--
-- Supabase Push Performed
--   NO — review SQL before pushing
-- ============================================================
