-- ============================================================
-- Migration: 20260930000000_record_invoice_payment_rpc
--
-- Phase 7B-3 — Payment Transaction RPC + Schema Hardening
-- Revised in place: Phase 7B-3A — RPC Idempotency + Received-Date Hardening
--
-- PURPOSE
-- -------
-- Additive migration that:
--
--   A. Adds crm_payments.idempotency_key UUID column
--   B. Adds UNIQUE constraint on (invoice_id, idempotency_key)
--      to prevent duplicate payment creation on browser/network retry
--   C. Creates the record_invoice_payment SECURITY DEFINER RPC
--      — the authoritative, atomic, transactional path for recording
--        a received bank-wire payment against an open invoice
--   D. Hardens crm_payments RLS so the browser cannot directly
--      INSERT or UPDATE payment rows, enforcing the trusted server path
--
-- PHASE 7B-3A HARDENING CHANGES (revised in place)
-- -------------------------------------------------
-- 1. POST-LOCK IDEMPOTENCY RE-CHECK
--    After acquiring SELECT ... FOR UPDATE on the invoice, a second
--    idempotency lookup is performed before any financial validation.
--    This closes the race window where two simultaneous requests with
--    the same idempotency key both pass the pre-lock check, then one
--    commits while the other waits on the lock. The post-lock re-check
--    ensures the second request returns the existing authoritative result
--    rather than proceeding to validation or INSERT.
--
-- 2. IDEMPOTENCY KEY CONFLICT DETECTION
--    Both the pre-lock and post-lock replay paths now validate that the
--    existing payment represents the same intended operation. If the same
--    idempotency key is reused with different payment details, the RPC
--    raises idempotency_key_conflict rather than silently returning success.
--    Fields compared: amount_cents, reference_number (normalized), notes
--    (normalized), and received_at (when p_received_at IS NOT NULL).
--    A shared helper block performs the comparison so both paths use
--    identical logic.
--
-- 3. RECEIVED DATE CANNOT BE FUTURE
--    After normalizing v_received_at := COALESCE(p_received_at, now()),
--    the RPC validates that v_received_at <= now(). A future received_at
--    is rejected with machine-readable error received_at_cannot_be_future.
--    Historical received dates are not restricted.
--    If p_received_at is NULL, defaulting to now() is always safe.
--
-- 4. AUDIT EVENT SEMANTICS
--    The audit_logs event_type is now truthful:
--      old_invoice_status != new_invoice_status → event_type = 'status_change'
--      old_invoice_status  = new_invoice_status → event_type = 'edit'
--    Example: a second partial payment where the invoice remains
--    partially_paid writes event_type = 'edit', not 'status_change'.
--    Both values exist in the audit_event_type enum.
--
-- ESTABLISHED BUSINESS DECISIONS (Phase 7B)
-- ------------------------------------------
-- 1. Bank wire only for Phase 7B — payment_method = 'bank_wire' (hardcoded)
-- 2. Record received payments only — status = 'received' (hardcoded)
-- 3. Overpayments rejected — p_amount_cents > remaining balance → error
-- 4. Partial payments allowed — invoice transitions to partially_paid
-- 5. No UNIQUE constraint on reference_number alone — not globally unique
-- 6. Idempotency key required — prevents duplicate on retry
-- 7. Refunds out of scope — no refund workflow created
-- 8. currency = 'USD' (hardcoded)
-- 9. recorded_by = p_admin_user_id (server-derived, never browser-supplied)
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - record any payment
--   - void any invoice
--   - modify any existing invoice or payment row
--   - send emails or generate PDFs
--   - call any payment provider
--   - trigger any automation
--
-- ORIGINAL MIGRATIONS NOT MODIFIED
-- ---------------------------------
-- 20260918000000_crm_invoicing_foundation.sql  — NOT modified
-- 20260918001000_crm_invoicing_foundation_hardening.sql — NOT modified
-- All other historical migrations — NOT modified
--
-- SECURITY
-- --------
-- record_invoice_payment uses:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
-- Admin authorization uses ONLY raw_app_meta_data->>'role' = 'admin'
-- (server-controlled, never user-editable metadata)
-- EXECUTE is REVOKED from PUBLIC, anon, and authenticated.
-- EXECUTE is GRANTED only to service_role.
-- The browser must never call this RPC directly.
-- The future API route will invoke it via the service-role client.
--
-- EXISTING TRIGGERS PRESERVED
-- ----------------------------
-- guard_completed_payment_facts       — payment core-fact immutability
-- guard_payment_status_transition     — payment status transition guard
-- guard_payment_delete                — payment hard-delete protection
-- guard_invoice_status_transition     — invoice status transition guard
-- guard_issued_invoice_immutability   — invoice snapshot immutability
-- guard_issued_invoice_delete         — invoice hard-delete protection
-- guard_issued_invoice_line_items     — line item immutability
-- guard_invoice_option_cycle_same_deal — option cycle same-deal integrity
-- guard_invoice_replacement_integrity — replacement invoice integrity
-- All triggers above are UNCHANGED by this migration.
-- ============================================================


-- ============================================================
-- SECTION 1: ADD idempotency_key COLUMN TO crm_payments
--
-- Purpose:
--   Allows the record_invoice_payment RPC to detect a retry of
--   an already-committed payment operation and return the existing
--   authoritative result without creating a duplicate row.
--
-- Design:
--   - UUID type — generated by the browser/API caller per form submission
--   - NULL allowed for legacy rows (0 existing rows; safe)
--   - UNIQUE constraint scoped to (invoice_id, idempotency_key) so the
--     same key cannot be reused for two different payments on the same
--     invoice, while still allowing the same key to be used across
--     different invoices (not a concern in practice but avoids a
--     global uniqueness assumption)
--   - The RPC requires p_idempotency_key to be non-NULL
--
-- Why NOT a global UNIQUE on idempotency_key alone:
--   A global constraint would prevent the same UUID from ever being
--   reused across invoices, which is unnecessarily restrictive and
--   could cause false conflicts if a client reuses a key by mistake
--   on a different invoice. Scoping to (invoice_id, idempotency_key)
--   is the correct idempotency boundary.
--
-- Why NOT a partial UNIQUE on idempotency_key WHERE idempotency_key IS NOT NULL:
--   The (invoice_id, idempotency_key) composite index already handles
--   NULL exclusion correctly because NULL IS DISTINCT FROM NULL in
--   PostgreSQL UNIQUE constraints (NULLs do not conflict with each other).
--   A partial index is not needed.
-- ============================================================

ALTER TABLE public.crm_payments
  ADD COLUMN IF NOT EXISTS idempotency_key UUID NULL;

-- Composite UNIQUE index: one idempotency_key per invoice
-- NULLs are excluded from uniqueness enforcement automatically
-- (PostgreSQL: NULL IS DISTINCT FROM NULL in unique indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_payments_invoice_idempotency
  ON public.crm_payments (invoice_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Standard lookup index for idempotency key lookups
CREATE INDEX IF NOT EXISTS idx_crm_payments_idempotency_key
  ON public.crm_payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;


-- ============================================================
-- SECTION 2: HARDEN crm_payments RLS
--
-- CURRENT STATE (from 20260918000000_crm_invoicing_foundation.sql):
--   admins_select_crm_payments — Admin SELECT (all rows)
--   admins_insert_crm_payments — Admin INSERT (any authenticated Admin)
--   admins_update_crm_payments — Admin UPDATE (any authenticated Admin)
--   No DELETE policy (trigger blocks all deletes)
--
-- PROBLEM:
--   The existing admins_insert_crm_payments and admins_update_crm_payments
--   policies allow any authenticated Admin to INSERT or UPDATE payment rows
--   directly from the browser using the anon-key Supabase client.
--   This bypasses the record_invoice_payment RPC, which is the only
--   authorized transactional path for recording payments.
--
--   A browser-direct INSERT could:
--     - Skip the invoice FOR UPDATE lock
--     - Skip the overpayment validation
--     - Skip the idempotency check
--     - Skip the invoice status recalculation
--     - Skip the application_activity write
--     - Skip the audit_logs write
--     - Create inconsistent financial state
--
-- HARDENING CHANGE:
--   Remove admins_insert_crm_payments (browser INSERT → blocked)
--   Remove admins_update_crm_payments (browser UPDATE → blocked)
--   Retain admins_select_crm_payments (Admin SELECT → preserved)
--
-- TRUSTED PATH:
--   The future POST /api/admin/invoices/[id]/payment API route will:
--     1. Authenticate the Admin server-side (requireAdmin())
--     2. Call record_invoice_payment via the service-role Supabase client
--     3. The RPC executes as SECURITY DEFINER with service_role privileges
--     4. RLS is bypassed for the service-role client — the RPC handles
--        all authorization, validation, and state transitions internally
--
-- DEFENSE-IN-DEPTH:
--   Even if a future RLS policy were accidentally re-added, the
--   record_invoice_payment RPC's own Admin authorization check,
--   invoice locking, and validation logic remain as the authoritative
--   financial control layer.
--
-- SELECT ACCESS PRESERVED:
--   Admin SELECT on crm_payments is retained so the Admin UI can
--   display payment history for an invoice.
--
-- EXISTING TRIGGERS UNCHANGED:
--   guard_completed_payment_facts, guard_payment_status_transition,
--   and guard_payment_delete remain as defense-in-depth regardless
--   of RLS policy state.
-- ============================================================

-- Remove direct Admin INSERT capability from browser
DROP POLICY IF EXISTS "admins_insert_crm_payments" ON public.crm_payments;

-- Remove direct Admin UPDATE capability from browser
DROP POLICY IF EXISTS "admins_update_crm_payments" ON public.crm_payments;

-- Retain Admin SELECT (payment history display)
-- admins_select_crm_payments is NOT dropped — it remains as-is.

-- No new INSERT or UPDATE RLS policies are created.
-- All payment writes must go through record_invoice_payment (service_role path).


-- ============================================================
-- SECTION 3: record_invoice_payment() RPC
--
-- Signature:
--   public.record_invoice_payment(
--     p_invoice_id       UUID,
--     p_admin_user_id    UUID,
--     p_amount_cents     BIGINT,
--     p_received_at      TIMESTAMPTZ,
--     p_reference_number TEXT,
--     p_notes            TEXT,
--     p_idempotency_key  UUID
--   )
--
-- Fixed/derived values (NOT accepted from caller):
--   payment_method = 'bank_wire'
--   currency       = 'USD'
--   status         = 'received'
--   recorded_by    = p_admin_user_id
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Returns JSONB with shape:
--   {
--     success: true,
--     idempotent_replay: boolean,
--     payment: { id, invoice_id, payment_method, status, amount_cents,
--                currency, received_at, reference_number, notes,
--                recorded_by, created_at },
--     invoice: { id, invoice_number, status, total_cents, paid_at },
--     payment_summary: { amount_paid_cents, balance_remaining_cents }
--   }
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized         — p_admin_user_id is not an authorized Admin
--   idempotency_key_required     — p_idempotency_key is NULL
--   amount_must_be_positive      — p_amount_cents <= 0
--   received_at_cannot_be_future — v_received_at > now()
--   invoice_not_found            — invoice row does not exist
--   invoice_not_payable          — invoice status not in (open, partially_paid)
--   overpayment_rejected         — p_amount_cents > remaining balance
--   idempotency_key_conflict     — same key reused with different payment details
--
-- Transaction sequence:
--   1.  Verify Admin identity (app_metadata only)
--   2.  Validate required inputs
--   3.  Normalize optional inputs; resolve v_received_at
--   4.  Validate received_at is not in the future
--   5.  PRE-LOCK idempotency check
--       → If found: validate conflict, return existing result (zero writes)
--   6.  SELECT invoice FOR UPDATE (row lock)
--   7.  POST-LOCK idempotency re-check (closes concurrent-request race)
--       → If found: validate conflict, return existing result (zero writes)
--   8.  Verify invoice is payable (open or partially_paid)
--   9.  Calculate existing received total (status = 'received' only)
--   10. Calculate remaining balance
--   11. Validate p_amount_cents <= remaining balance
--   12. INSERT crm_payments row (status = 'received', method = 'bank_wire')
--   13. Recalculate new received total
--   14. Determine new invoice status (partially_paid or paid)
--   15. UPDATE crm_invoices status (and paid_at if fully paid)
--   16. INSERT application_activity: payment_received
--   17. If fully paid: INSERT application_activity: invoice_paid
--   18. INSERT audit_logs:
--         event_type = 'status_change' if old_status != new_status
--         event_type = 'edit'          if old_status  = new_status
--   19. Return authoritative result
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

  -- Post-insert recalculation
  v_new_received_cents      BIGINT;
  v_balance_remaining       BIGINT;
  v_new_invoice_status      TEXT;
  v_old_invoice_status      TEXT;
  v_paid_at                 TIMESTAMPTZ;

  -- Audit event type (determined by whether invoice status actually changes)
  v_audit_event_type        public.audit_event_type;

  -- Return payload
  v_result                  JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
  --
  -- Authorization uses ONLY raw_app_meta_data (server-controlled JWT claim).
  -- user_metadata is NEVER trusted for authorization decisions.
  -- Both normal Admin and SuperAdmin are permitted:
  --   raw_app_meta_data->>'role' = 'admin' covers both.
  -- The future API route derives p_admin_user_id from the authenticated
  -- server session — the browser never supplies a trusted Admin identity.
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

  -- Idempotency key is mandatory — no payment without it
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_idempotency_key is required. Generate a UUID per form submission '
                      'to enable safe retry behavior.';
  END IF;

  -- Payment amount must be positive
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_must_be_positive'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_amount_cents must be a positive integer (cents). '
                      'Received: ' || COALESCE(p_amount_cents::TEXT, 'NULL');
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: NORMALIZE OPTIONAL INPUTS
  --
  -- Trim whitespace; treat empty string as NULL.
  -- Resolve v_received_at: default to now() if not supplied.
  -- ══════════════════════════════════════════════════════════════════════════

  v_reference_number := NULLIF(TRIM(COALESCE(p_reference_number, '')), '');
  v_notes_normalized := NULLIF(TRIM(COALESCE(p_notes, '')), '');
  v_received_at      := COALESCE(p_received_at, now());


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: VALIDATE RECEIVED DATE IS NOT IN THE FUTURE
  --
  -- Business meaning: record_invoice_payment means EarnestBridge has ACTUALLY
  -- RECEIVED the bank wire. A payment cannot be recorded as received at a
  -- future timestamp.
  --
  -- If p_received_at is NULL, v_received_at defaults to now(), which is
  -- always safe and never triggers this check.
  --
  -- Historical received dates (past) are not restricted.
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
  --
  -- Before acquiring the invoice lock, check whether a payment with this
  -- idempotency key already exists for this invoice.
  --
  -- This is a fast-path replay for the common case (sequential retry after
  -- a committed transaction). It avoids acquiring the invoice lock
  -- unnecessarily when the payment already exists.
  --
  -- If found:
  --   - Validate that the existing payment represents the same intended
  --     operation (idempotency_key_conflict detection).
  --   - If valid replay: return existing authoritative result (zero writes).
  --   - If conflict: raise idempotency_key_conflict.
  --
  -- NOTE: This pre-lock check is NOT sufficient for two truly simultaneous
  -- requests. The post-lock re-check (Step 7) closes that race window.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_existing_payment
  FROM public.crm_payments
  WHERE invoice_id      = p_invoice_id
    AND idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    -- ── IDEMPOTENCY CONFLICT CHECK (pre-lock) ──────────────────────────────
    -- Validate that the existing payment matches the current request.
    -- The same idempotency key must never silently represent two different
    -- payment requests.
    --
    -- Fields compared:
    --   amount_cents      — always compared (core financial fact)
    --   reference_number  — compared after normalization
    --   notes             — compared after normalization
    --   received_at       — compared only when p_received_at IS NOT NULL
    --                       (if caller omitted received_at, the server-generated
    --                        timestamp on the existing row is not a conflict)
    -- ──────────────────────────────────────────────────────────────────────

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

    -- Compare received_at only when the caller explicitly supplied it.
    -- If p_received_at IS NULL, the stored server-generated timestamp is
    -- not treated as a conflict — the caller did not assert a specific time.
    IF p_received_at IS NOT NULL THEN
      -- Allow a small tolerance (1 second) for floating-point/rounding edge cases
      -- when the same timestamp is serialized and deserialized across the wire.
      -- Use exact comparison — timestamps are stored as TIMESTAMPTZ.
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

    -- ── VALID REPLAY — return existing authoritative result (zero writes) ──

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
  --
  -- Acquire an exclusive row lock before any financial calculation.
  -- This ensures that concurrent payment attempts against the same invoice
  -- are serialized — only one can proceed at a time.
  --
  -- The lock must be acquired BEFORE:
  --   - the post-lock idempotency re-check
  --   - calculating existing received payments
  --   - calculating remaining balance
  --   - validating the new amount
  --   - inserting the payment
  --   - updating invoice status
  --
  -- A concurrent second payment attempt will block at this SELECT and,
  -- after the first transaction commits, will see the updated invoice
  -- status and recalculated balance.
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
  --
  -- CRITICAL: This second check closes the concurrent-request race window.
  --
  -- Scenario this prevents:
  --   Request A and Request B use the same invoice_id + idempotency_key.
  --   Both pass the pre-lock check (Step 5) before either payment exists.
  --   Request A acquires the invoice lock and completes the payment.
  --   Request B was waiting on the invoice lock.
  --   After A commits, B acquires the invoice lock.
  --   At this point B MUST re-check the idempotency key BEFORE:
  --     - invoice payable-status validation
  --     - balance calculation
  --     - overpayment validation
  --     - payment INSERT
  --   Without this re-check:
  --     - If A fully paid the invoice, B would reach invoice_not_payable
  --       (incorrect — B should return the existing payment result)
  --     - If A partially paid the invoice, B would reach INSERT and hit
  --       the UNIQUE index (incorrect — B should return the existing result)
  --
  -- This re-check must happen BEFORE invoice status validation (Step 8).
  --
  -- Same conflict detection logic as the pre-lock check (Step 5).
  -- Zero writes on replay.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_existing_payment
  FROM public.crm_payments
  WHERE invoice_id      = p_invoice_id
    AND idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    -- ── IDEMPOTENCY CONFLICT CHECK (post-lock) ─────────────────────────────
    -- Identical logic to the pre-lock conflict check.
    -- The invoice lock is already held; we must still validate before
    -- returning so that a conflicting retry does not silently succeed.
    -- ──────────────────────────────────────────────────────────────────────

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

    -- ── VALID REPLAY (post-lock) — return existing result (zero writes) ────
    -- The invoice lock is held but we return immediately without any writes.
    -- The lock is released when this transaction ends.

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
  --
  -- Only invoices in open or partially_paid status may receive payments.
  --
  -- Rejected statuses:
  --   draft      — not yet issued; no payment due
  --   issuing    — issuance in progress; not yet open
  --   paid       — already fully paid; terminal state
  --   void       — voided; terminal state
  --
  -- This check occurs AFTER the post-lock idempotency re-check (Step 7)
  -- so that a simultaneous duplicate request that arrives after the invoice
  -- has been fully paid by the first request returns the existing payment
  -- result rather than invoice_not_payable.
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
  -- STEP 9: CALCULATE EXISTING RECEIVED PAYMENTS
  --
  -- CRITICAL: Only status = 'received' payments count toward Amount Paid.
  --
  -- Do NOT include:
  --   pending  — not yet confirmed; must not count as paid funds
  --   failed   — payment did not succeed
  --   refunded — payment was returned
  --
  -- This is the authoritative calculation for the current paid balance.
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
  --
  -- Overpayments are NOT allowed.
  -- The new payment amount must not exceed the remaining balance.
  --
  -- This check is performed AFTER the FOR UPDATE lock so the remaining
  -- balance is authoritative and cannot be stale due to a concurrent payment.
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
  -- STEP 13: INSERT RECEIVED PAYMENT ROW
  --
  -- Fixed values (not accepted from caller):
  --   payment_method = 'bank_wire'
  --   currency       = 'USD'
  --   status         = 'received'
  --   recorded_by    = p_admin_user_id
  --
  -- Receipt PDF fields are NOT populated (deferred to Phase 7C).
  -- Provider fields are NULL (Coinflow deferred).
  --
  -- The existing guard_completed_payment_facts trigger will lock the
  -- core facts of this row immediately since status = 'received'.
  -- The existing guard_payment_status_transition trigger will enforce
  -- that only received → refunded is allowed in the future.
  -- The existing guard_payment_delete trigger prevents deletion.
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
    NULL,   -- provider: Coinflow deferred
    NULL,   -- provider_payment_id: Coinflow deferred
    NULL,   -- receipt_pdf_storage_path: receipt generation deferred
    NULL,   -- receipt_pdf_generated_at: receipt generation deferred
    NULL,   -- receipt_pdf_hash: receipt generation deferred
    p_idempotency_key,
    v_now,
    v_now
  )
  RETURNING id INTO v_new_payment_id;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 14: RECALCULATE AUTHORITATIVE RECEIVED TOTAL
  --
  -- Re-query after the INSERT to get the definitive total including the
  -- new payment. This is the authoritative source of truth.
  --
  -- CRITICAL: Only status = 'received' payments count.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COALESCE(SUM(amount_cents), 0)
  INTO v_new_received_cents
  FROM public.crm_payments
  WHERE invoice_id = p_invoice_id
    AND status = 'received';

  v_balance_remaining := v_invoice.total_cents - v_new_received_cents;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 15: DETERMINE NEW INVOICE STATUS
  --
  -- Fully paid:
  --   new_received_cents = invoice.total_cents
  --   → status = 'paid', paid_at = v_now
  --
  -- Partially paid:
  --   0 < new_received_cents < invoice.total_cents
  --   → status = 'partially_paid', paid_at = NULL
  --
  -- Overpayment is impossible here because it was rejected in Step 11.
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
  --
  -- The existing guard_invoice_status_transition trigger validates:
  --   open → partially_paid  ✓ allowed
  --   open → paid            ✓ allowed
  --   partially_paid → paid  ✓ allowed
  --   partially_paid → partially_paid (same-status) ✓ allowed
  --
  -- paid_at is a workflow field (not in the immutable snapshot list) so
  -- it may be set here even though the invoice has left draft.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    status     = v_new_invoice_status,
    paid_at    = v_paid_at,
    updated_at = v_now
  WHERE id = p_invoice_id
    AND status = v_old_invoice_status;

  -- Guard against unexpected concurrent change
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_payable'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to update invoice status. The invoice may have been modified '
                      'concurrently. Please retry the operation.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 17: WRITE payment_received ACTIVITY
  --
  -- Written for every successful NEW payment transaction.
  -- NOT written on idempotent replay (handled in Steps 5 and 7).
  --
  -- Identifies: invoice number/id, received amount, resulting payment state.
  -- Does NOT include: wire account number, routing number, banking secrets.
  --
  -- Actor pattern follows existing server code:
  --   user_id = Admin auth UUID (p_admin_user_id)
  --   actor   = 'EarnestBridge Admin'
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
  --
  -- Written only when the invoice transitions to paid status.
  -- NOT written for partial payments.
  -- NOT written on idempotent replay.
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
  --
  -- Captures the Admin actor, invoice resource, payment ID, amount,
  -- old invoice status, and new invoice status.
  --
  -- AUDIT EVENT SEMANTICS (Phase 7B-3A hardening):
  --   If old invoice status != new invoice status:
  --     event_type = 'status_change'
  --     (e.g., open → partially_paid, open → paid, partially_paid → paid)
  --
  --   If old invoice status = new invoice status:
  --     event_type = 'edit'
  --     (e.g., partially_paid → partially_paid: a second partial payment
  --      was recorded but the invoice status did not change)
  --
  -- Both 'status_change' and 'edit' exist in the audit_event_type enum.
  -- This ensures the audit record is truthful about what actually changed.
  --
  -- Does NOT log:
  --   - wire account number
  --   - routing number
  --   - financial settings secrets
  --   - full app_metadata
  --
  -- NOT written on idempotent replay.
  -- ══════════════════════════════════════════════════════════════════════════

  -- Determine the truthful audit event type
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
  --
  -- Returns the full payment row, current invoice state, and payment summary.
  -- Sufficient for the future POST /api/admin/invoices/[id]/payment API route.
  --
  -- Excluded from return:
  --   - wire_instructions_snapshot
  --   - pdf_storage_path / pdf_hash
  --   - receipt_pdf_* fields (not yet populated)
  --   - raw app_metadata
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


-- ============================================================
-- SECTION 4: GRANT / REVOKE EXECUTE ON record_invoice_payment
--
-- The browser must NEVER call this RPC directly.
-- The future API route will invoke it via the service-role client.
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders — blocks browser Supabase client)
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  FROM authenticated;

-- Grant ONLY to service_role (trusted server path)
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(UUID, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, UUID)
  TO service_role;


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- ── PHASE 7B-3A COMPLETION REPORT ────────────────────────────────────────
--
-- 1. Migration filename:
--    20260930000000_record_invoice_payment_rpc.sql
--
-- 2. Same undeployed migration revised in place:
--    YES — no new migration file created; the existing undeployed migration
--    was revised in place as instructed.
--
-- 3. Pre-lock idempotency check retained:
--    YES — Step 5 (pre-lock fast-path replay check) is retained.
--    It now also performs idempotency_key_conflict detection before returning.
--
-- 4. Post-lock idempotency re-check added:
--    YES — Step 7 (post-lock re-check) was added.
--
-- 5. Exact location of second re-check:
--    Step 7, immediately after the SELECT ... FOR UPDATE in Step 6,
--    and BEFORE invoice payable-status validation in Step 8.
--    This ordering ensures that a simultaneous duplicate request that
--    arrives after the invoice has been fully paid by the first request
--    returns the existing payment result rather than invoice_not_payable.
--
-- 6. idempotency_key_conflict behavior:
--    Raised (ERRCODE = 'P0001', message = 'idempotency_key_conflict') when
--    the same idempotency key is found but the existing payment does not
--    match the current request. Raised on BOTH the pre-lock path (Step 5)
--    and the post-lock path (Step 7) using identical comparison logic.
--    Zero new payment created. Zero writes performed.
--
-- 7. Fields compared on replay:
--    - amount_cents      — always compared (core financial fact)
--    - reference_number  — compared after normalization (NULLIF(TRIM(...)))
--    - notes             — compared after normalization (NULLIF(TRIM(...)))
--    - received_at       — compared ONLY when p_received_at IS NOT NULL
--                          (if caller omitted received_at, the server-generated
--                           timestamp on the existing row is not a conflict)
--
-- 8. Future received_at validation:
--    Step 4: after v_received_at := COALESCE(p_received_at, now()),
--    validates v_received_at > now() → raises received_at_cannot_be_future.
--    Historical received dates are not restricted.
--    If p_received_at is NULL, defaulting to now() is always safe.
--
-- 9. Audit event_type logic:
--    v_old_invoice_status != v_new_invoice_status → 'status_change'
--    v_old_invoice_status  = v_new_invoice_status → 'edit'
--    Example: partially_paid → partially_paid (second partial payment)
--    writes event_type = 'edit', not 'status_change'.
--    Both values exist in the audit_event_type enum.
--
-- 10. All financial writes remain atomic:
--     YES — the entire function is one PostgreSQL transaction.
--     For a successful NEW payment:
--       invoice lock → validate → insert payment → recalculate →
--       update invoice → write application_activity → write audit_logs → return
--     Any failure rolls back all writes.
--     For an idempotent replay: ZERO writes.
--
-- 11. No API/UI added:
--     YES — POST /api/admin/invoices/[id]/payment deferred to Phase 7B-4.
--     No UI components modified.
--
-- 12. No SQL executed/deployed:
--     YES — this migration has not been pushed to Supabase.
--     SQL executed: 0. Database rows modified: 0.
--
-- ── SELF-TEST ANALYSIS ────────────────────────────────────────────────────
--
-- A. First full payment
--    Expected: payment inserted once, invoice → paid, balance = 0
--    Logic:    Step 5: no existing payment → proceed
--              Step 7: no existing payment → proceed
--              Step 8: invoice status = 'open' → payable
--              Step 9: existing_received = 0
--              Step 11: p_amount_cents = total_cents → not overpayment
--              Step 13: INSERT payment (status = 'received')
--              Step 14: new_received = total_cents
--              Step 15: new_received >= total_cents → status = 'paid'
--              Step 16: UPDATE invoice status = 'paid', paid_at = now()
--              Step 17: INSERT payment_received activity
--              Step 18: INSERT invoice_paid activity
--              Step 19: old='open' != new='paid' → event_type = 'status_change'
--    Result:   ✓ CORRECT
--
-- B. First partial payment
--    Expected: payment inserted once, invoice → partially_paid
--    Logic:    Step 11: p_amount_cents < total_cents → not overpayment
--              Step 15: 0 < new_received < total_cents → status = 'partially_paid'
--              Step 19: old='open' != new='partially_paid' → 'status_change'
--    Result:   ✓ CORRECT
--
-- C. Second legitimate partial payment with NEW idempotency key
--    Expected: second payment inserted, received totals summed, correct balance
--    Logic:    Step 5: new idempotency_key → no existing payment found → proceed
--              Step 7: new idempotency_key → no existing payment found → proceed
--              Step 9: existing_received = first payment amount
--              Step 11: new amount <= remaining → not overpayment
--              Step 13: INSERT second payment
--              Step 14: new_received = sum of both payments
--              Step 15: if sum < total → 'partially_paid'; if sum = total → 'paid'
--    Result:   ✓ CORRECT
--
-- D. Sequential retry with same key and same request
--    Expected: existing payment returned, idempotent_replay = true, zero writes
--    Logic:    Step 5: existing payment found with same idempotency_key
--              Conflict check: amount/reference/notes/received_at all match
--              → return existing result, idempotent_replay = true
--              Zero INSERT, zero activity, zero audit
--    Result:   ✓ CORRECT
--
-- E. Two simultaneous requests using same invoice + same idempotency key
--    Expected: first succeeds, second returns existing payment, zero duplicates
--    Logic:    Both pass Step 5 (pre-lock) before either payment exists
--              Request A acquires invoice lock (Step 6), completes payment,
--              commits transaction
--              Request B was waiting on the lock
--              After A commits, B acquires the lock
--              B executes Step 7 (post-lock re-check):
--                finds the payment A just created
--                conflict check: same amount/reference/notes/received_at → match
--                → return existing result, idempotent_replay = true
--                → zero writes, zero duplicate activity, zero duplicate audit
--    Result:   ✓ CORRECT
--
-- F. Same idempotency key reused with DIFFERENT amount
--    Expected: idempotency_key_conflict, zero new payment
--    Logic:    Step 5: existing payment found
--              Conflict check: v_existing_payment.amount_cents != p_amount_cents
--              → RAISE idempotency_key_conflict
--              (Also caught at Step 7 if somehow Step 5 was bypassed)
--    Result:   ✓ CORRECT
--
-- G. Same idempotency key reused with different reference/notes
--    Expected: idempotency_key_conflict, zero new payment
--    Logic:    Step 5: existing payment found
--              Conflict check: reference_number or notes IS DISTINCT FROM normalized value
--              → RAISE idempotency_key_conflict
--    Result:   ✓ CORRECT
--
-- H. Future received_at
--    Expected: received_at_cannot_be_future, zero writes
--    Logic:    Step 4: v_received_at > now() → RAISE received_at_cannot_be_future
--              Raised before any idempotency check or lock acquisition
--    Result:   ✓ CORRECT
--
-- I. Payment > remaining balance
--    Expected: overpayment_rejected, zero writes
--    Logic:    Step 11: p_amount_cents > v_remaining_before
--              → RAISE overpayment_rejected
--    Result:   ✓ CORRECT
--
-- J. Second partial payment where invoice remains partially_paid
--    Expected: audit event_type = 'edit', not 'status_change'
--    Logic:    Step 15: new_received < total_cents → v_new_invoice_status = 'partially_paid'
--              Step 19: v_old_invoice_status = 'partially_paid'
--                       v_new_invoice_status = 'partially_paid'
--                       old = new → v_audit_event_type = 'edit'
--    Result:   ✓ CORRECT
--
-- ── PRESERVED (DO NOT CHANGE) ─────────────────────────────────────────────
-- crm_payments status CHECK values:          UNCHANGED
-- payment status transition trigger:         UNCHANGED
-- invoice status transition trigger:         UNCHANGED
-- payment immutability trigger:              UNCHANGED
-- payment delete trigger:                    UNCHANGED
-- invoice immutability:                      UNCHANGED
-- invoice deletion rules:                    UNCHANGED
-- bank_wire-only rule:                       UNCHANGED (hardcoded in RPC)
-- USD-only rule:                             UNCHANGED (hardcoded in RPC)
-- received-only rule:                        UNCHANGED (hardcoded in RPC)
-- overpayment rejection rule:                UNCHANGED
-- partial payment support:                   UNCHANGED
-- service_role-only RPC execution:           UNCHANGED
-- RLS browser-write hardening:               UNCHANGED
-- Option Cycle code:                         UNCHANGED
-- Refund workflow:                           UNCHANGED (out of scope)
-- Void workflow:                             UNCHANGED (out of scope)
-- Receipt workflow:                          UNCHANGED (out of scope)
--
-- ── ZERO-WRITE CONFIRMATION ───────────────────────────────────────────────
-- Files modified:           supabase/migrations/20260930000000_record_invoice_payment_rpc.sql
-- New migrations created:   0
-- SQL executed:             0
-- Database rows modified:   0
-- Payments recorded:        0
-- Invoices voided:          0
-- Netlify deployed:         NO
-- Supabase deployed:        NO
-- ============================================================
