-- ============================================================
-- Migration: 20260918000000_crm_invoicing_foundation
--
-- Step 6A-2 — EarnestBridge Invoicing Foundation Schema
-- Step 6A-2a — Pre-Deployment Hardening Pass (in-place modification)
-- Step 6A-2b — Final State-Transition + Payment Audit Hardening (in-place)
--
-- PURPOSE
-- -------
-- Additive schema migration that creates the complete invoicing
-- foundation for EarnestBridge CRM. No business data is mutated.
-- No invoices, payments, or activities are created.
--
-- HARDENING CHANGES (6A-2a)
-- -------------------------
-- 1.  Issued snapshot immutability: Admin AND service_role bypass REMOVED.
--     Once OLD.status != 'draft', snapshot fields are immutable for EVERYONE.
--     The draft→issuing transition is the ONLY window to finalize snapshots.
--     Workflow fields (status, issued_at, pdf_*, voided_*, updated_at) remain
--     mutable through trusted server paths.
-- 2.  Line items: absolutely immutable for everyone (incl. Admin, service_role)
--     once parent invoice status != 'draft'. Void + replacement is the only
--     correction model.
-- 3.  Hard delete of non-draft invoices blocked by trigger (defense in depth)
--     AND by explicit DELETE RLS limited to draft-only.
-- 4.  Admin RLS split into separate SELECT / INSERT / UPDATE / DELETE policies.
--     DELETE restricted to draft invoices only.
-- 5.  crm_payments.application_id REMOVED. Deal derived through invoice_id.
-- 6.  Client SELECT on crm_payments REMOVED. Admin/server only.
-- 7.  crm_payments Admin RLS: SELECT / INSERT / UPDATE only. No DELETE.
-- 8.  option_cycle_id same-deal integrity: trigger ensures referenced cycle
--     belongs to the same application_id as the invoice.
-- 9.  Replacement invoice constraints: no self-reference, same-deal check,
--     one canonical replacement (partial UNIQUE index already present).
-- 10. crm_invoice_settings: Admin-only, no client access (unchanged intent,
--     confirmed explicit).
--
-- HARDENING CHANGES (6A-2b)
-- -------------------------
-- 11. Invoice status transition guard: validates all status transitions.
--     Non-draft → draft is NEVER allowed (for anyone, including Admin/service_role).
--     Void cannot reopen. Paid is permanent. Exact allowed matrix enforced.
-- 12. Payment core-fact immutability: once a payment reaches received/refunded/failed,
--     core historical facts (invoice_id, payment_method, amount_cents, currency,
--     received_at, reference_number, provider, provider_payment_id) become immutable
--     for everyone including Admin and service_role.
--     Operational metadata (notes, receipt_pdf_*, updated_at) remains updateable.
-- 13. Payment status transition guard: validates all payment status transitions.
--     Conservative model: pending→received/failed, received→refunded only.
--     No reversal/retry semantics invented yet.
-- 14. amount_cents > 0 CHECK constraint on crm_payments.
-- 15. Invoice total integrity CHECK constraints:
--     subtotal_cents >= 0, discount_cents >= 0, tax_cents = 0 (already present),
--     total_cents >= 0.
-- 16. Line item integrity: quantity > 0, fee lines >= 0, discount lines <= 0
--     (discount constraint already present; quantity and fee constraints added).
-- 17. replaces_invoice_id must point at a voided invoice (status = 'void').
--     Enforced by trigger in validate_invoice_replacement_integrity().
--
-- SCOPE
-- -----
-- 1.  Add funded_date, emd_funded_cents, credit_card_payment_enabled
--     to borrower_applications (Admin-controlled fields)
-- 2.  Update protect_borrower_application_admin_fields() to guard
--     the three new fields — preserving ALL existing protected fields
-- 3.  Create calculate_deal_fee_cents() canonical function
-- 4.  Create crm_invoices table
-- 5.  Create crm_invoice_line_items table
-- 6.  Create crm_payments table (WITHOUT application_id)
-- 7.  Create crm_invoice_settings singleton table
-- 8.  Create crm_invoice_number_seq PostgreSQL sequence
-- 9.  Create invoice-pdfs private storage bucket
-- 10. Enable RLS on all new tables with hardened Admin + Client policies
-- 11. Create issued invoice immutability trigger (no Admin/service_role bypass)
-- 12. Create issued invoice hard-delete protection trigger
-- 13. Create line-item absolute immutability trigger
-- 14. Create option_cycle_id same-deal integrity trigger
-- 15. Create replacement invoice integrity trigger (incl. original must be void)
-- 16. Create invoice status transition guard trigger
-- 17. Create payment core-fact immutability trigger
-- 18. Create payment status transition guard trigger
-- 19. Extend application_activity event_type CHECK constraint additively
-- 20. Create sensible indexes
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - create invoices, payments, or activities
--   - alter Deal or Option Cycle statuses
--   - populate funded_date or emd_funded_cents
--   - enable credit card on any Deal
--   - send emails or generate PDFs
--   - seed bank account / routing numbers
--
-- SECURITY
-- --------
-- All SECURITY DEFINER functions use:
--   SET search_path = public, pg_catalog
-- Admin authorization uses ONLY raw_app_meta_data->>'role' = 'admin'
-- (server-controlled, never user-editable metadata)
-- ============================================================


-- ============================================================
-- SECTION 1: ADD FIELDS TO borrower_applications
-- ============================================================

-- 1a. funded_date — Admin-set date EarnestBridge wired the EMD to escrow
--     Used as period_start_date for initial Deal Fee calculation.
ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS funded_date DATE NULL;

-- 1b. emd_funded_cents — Actual EMD amount EarnestBridge wired (BIGINT cents)
--     Distinct from deposit_amount (requested/application amount).
--     deposit_amount is preserved and unchanged.
ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS emd_funded_cents BIGINT NULL;

-- 1c. credit_card_payment_enabled — Admin-controlled per-Deal CC flag
--     Default false globally. Admin enables selectively per Deal.
ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS credit_card_payment_enabled BOOLEAN NOT NULL DEFAULT false;


-- ============================================================
-- SECTION 2: UPDATE BORROWER PROTECTION TRIGGER
-- Preserve ALL existing protected fields.
-- Add funded_date, emd_funded_cents, credit_card_payment_enabled.
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_borrower_application_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_role          TEXT;
  v_any_protected BOOLEAN;
BEGIN
  -- ── Fast path: check whether any protected field actually changed ──────────
  v_any_protected :=
       NEW.eb_assigned_owner             IS DISTINCT FROM OLD.eb_assigned_owner
    OR NEW.app_status                    IS DISTINCT FROM OLD.app_status
    OR NEW.admin_notes                   IS DISTINCT FROM OLD.admin_notes
    OR NEW.admin_created                 IS DISTINCT FROM OLD.admin_created
    OR NEW.deal_workflow_stage           IS DISTINCT FROM OLD.deal_workflow_stage
    OR NEW.primary_contact_id            IS DISTINCT FROM OLD.primary_contact_id
    OR NEW.crm_company_id                IS DISTINCT FROM OLD.crm_company_id
    OR NEW.w9_signed                     IS DISTINCT FROM OLD.w9_signed
    OR NEW.mou_signed                    IS DISTINCT FROM OLD.mou_signed
    OR NEW.option_agreement_signed       IS DISTINCT FROM OLD.option_agreement_signed
    OR NEW.psa_signed                    IS DISTINCT FROM OLD.psa_signed
    OR NEW.llc_formed                    IS DISTINCT FROM OLD.llc_formed
    OR NEW.escrow_funded                 IS DISTINCT FROM OLD.escrow_funded
    OR NEW.option_exercised              IS DISTINCT FROM OLD.option_exercised
    -- New invoicing fields (Admin-controlled)
    OR NEW.funded_date                   IS DISTINCT FROM OLD.funded_date
    OR NEW.emd_funded_cents              IS DISTINCT FROM OLD.emd_funded_cents
    OR NEW.credit_card_payment_enabled   IS DISTINCT FROM OLD.credit_card_payment_enabled;

  -- Nothing protected changed → allow immediately
  IF NOT v_any_protected THEN
    RETURN NEW;
  END IF;

  -- ── Determine effective database role ─────────────────────────────────────
  v_role := current_setting('role', true);

  -- service_role bypasses this guard (trusted server-side API)
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Authenticated Admin sessions are permitted for all protected fields
  IF public.is_admin_user() THEN
    RETURN NEW;
  END IF;

  -- ── Borrower-submission exception ─────────────────────────────────────────
  -- A borrower may set app_status = 'submitted' when transitioning from
  -- 'draft' or 'application'. This is the ONLY protected-field change a
  -- borrower is permitted to make. All other protected fields must remain
  -- unchanged in the same UPDATE for this exception to apply.
  IF
    -- Only app_status changed among protected fields
    NEW.app_status                    IS DISTINCT FROM OLD.app_status
    AND NEW.eb_assigned_owner             IS NOT DISTINCT FROM OLD.eb_assigned_owner
    AND NEW.admin_notes                   IS NOT DISTINCT FROM OLD.admin_notes
    AND NEW.admin_created                 IS NOT DISTINCT FROM OLD.admin_created
    AND NEW.deal_workflow_stage           IS NOT DISTINCT FROM OLD.deal_workflow_stage
    AND NEW.primary_contact_id            IS NOT DISTINCT FROM OLD.primary_contact_id
    AND NEW.crm_company_id                IS NOT DISTINCT FROM OLD.crm_company_id
    AND NEW.w9_signed                     IS NOT DISTINCT FROM OLD.w9_signed
    AND NEW.mou_signed                    IS NOT DISTINCT FROM OLD.mou_signed
    AND NEW.option_agreement_signed       IS NOT DISTINCT FROM OLD.option_agreement_signed
    AND NEW.psa_signed                    IS NOT DISTINCT FROM OLD.psa_signed
    AND NEW.llc_formed                    IS NOT DISTINCT FROM OLD.llc_formed
    AND NEW.escrow_funded                 IS NOT DISTINCT FROM OLD.escrow_funded
    AND NEW.option_exercised              IS NOT DISTINCT FROM OLD.option_exercised
    AND NEW.funded_date                   IS NOT DISTINCT FROM OLD.funded_date
    AND NEW.emd_funded_cents              IS NOT DISTINCT FROM OLD.emd_funded_cents
    AND NEW.credit_card_payment_enabled   IS NOT DISTINCT FROM OLD.credit_card_payment_enabled
    -- Transition is exactly: (draft|application) → submitted
    AND NEW.app_status::TEXT = 'submitted'
    AND OLD.app_status::TEXT IN ('draft', 'application')
  THEN
    -- Legitimate borrower submission — allow
    RETURN NEW;
  END IF;

  -- ── All other cases: reject ────────────────────────────────────────────────
  RAISE EXCEPTION
    'Permission denied: one or more Admin-controlled fields on borrower_applications '
    'may only be changed by an EarnestBridge Admin or trusted server process.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

-- Re-attach trigger (DROP + CREATE is idempotent)
DROP TRIGGER IF EXISTS guard_borrower_application_admin_fields ON public.borrower_applications;
CREATE TRIGGER guard_borrower_application_admin_fields
  BEFORE UPDATE ON public.borrower_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_borrower_application_admin_fields();


-- ============================================================
-- SECTION 3: CANONICAL DEAL FEE CALCULATION FUNCTION
--
-- calculate_deal_fee_cents(p_emd_funded_cents, p_start_date, p_end_date)
--
-- Formula:
--   billable_days = p_end_date - p_start_date  (calendar date difference)
--   fee_cents = ROUND((p_emd_funded_cents::NUMERIC * billable_days::NUMERIC) / 1000)
--
-- This represents $100/day per $100,000 financed.
-- Supports both initial Deal Fee and extension Deal Fee.
-- Uses ROUND to avoid silent truncation on odd funded amounts.
--
-- Example: $250,000 funded (25,000,000 cents), 30 days
--   = ROUND((25000000 * 30) / 1000) = 750,000 cents = $7,500.00
--
-- Example: $250,000 funded (25,000,000 cents), 10 days
--   = ROUND((25000000 * 10) / 1000) = 250,000 cents = $2,500.00
-- ============================================================

CREATE OR REPLACE FUNCTION public.calculate_deal_fee_cents(
  p_emd_funded_cents  BIGINT,
  p_start_date        DATE,
  p_end_date          DATE
)
RETURNS BIGINT
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_billable_days INTEGER;
  v_fee_cents     BIGINT;
BEGIN
  -- Input validation
  IF p_emd_funded_cents IS NULL OR p_emd_funded_cents <= 0 THEN
    RAISE EXCEPTION 'calculate_deal_fee_cents: p_emd_funded_cents must be > 0, got %', p_emd_funded_cents
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_start_date IS NULL THEN
    RAISE EXCEPTION 'calculate_deal_fee_cents: p_start_date must not be NULL'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_end_date IS NULL THEN
    RAISE EXCEPTION 'calculate_deal_fee_cents: p_end_date must not be NULL'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'calculate_deal_fee_cents: p_end_date (%) must be after p_start_date (%)',
      p_end_date, p_start_date
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Calendar date difference (no business-day or holiday adjustment)
  v_billable_days := (p_end_date - p_start_date);

  -- Fee calculation: $100/day per $100,000 financed
  -- In cents: (emd_cents * days) / 1000
  -- ROUND avoids silent truncation on odd funded amounts
  v_fee_cents := ROUND(
    (p_emd_funded_cents::NUMERIC * v_billable_days::NUMERIC) / 1000
  )::BIGINT;

  RETURN v_fee_cents;
END;
$func$;

-- Grant execute to service_role only; revoke from PUBLIC
GRANT EXECUTE ON FUNCTION public.calculate_deal_fee_cents(BIGINT, DATE, DATE)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.calculate_deal_fee_cents(BIGINT, DATE, DATE)
  FROM PUBLIC;


-- ============================================================
-- SECTION 4: INVOICE NUMBER SEQUENCE
-- Global monotonically increasing sequence.
-- Never resets per year. Gaps are acceptable.
-- Format at issuance: EB-YYYY-NNNNNN
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS public.crm_invoice_number_seq
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;


-- ============================================================
-- SECTION 5: crm_invoice_settings — TYPED SINGLETON
--
-- Stores EarnestBridge issuer identity and bank wire instructions.
-- id SMALLINT PRIMARY KEY CHECK (id = 1) enforces singleton.
-- NOT client-readable through direct browser/RLS access.
-- Banking values must be entered through Admin workflow — NOT seeded here.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.crm_invoice_settings (
  id                      SMALLINT PRIMARY KEY CHECK (id = 1),

  -- Issuer identity (EarnestBridge legal entity)
  issuer_legal_name       TEXT,
  issuer_address_line1    TEXT,
  issuer_address_line2    TEXT NULL,
  issuer_city             TEXT,
  issuer_state            TEXT,
  issuer_postal_code      TEXT,
  issuer_country          TEXT NOT NULL DEFAULT 'US',

  -- Bank wire instructions
  -- IMPORTANT: Do NOT seed actual bank account or routing numbers here.
  -- These fields are intentionally left NULL at migration time.
  -- Values will be entered securely through the Admin settings workflow.
  wire_bank_name          TEXT NULL,
  wire_account_name       TEXT NULL,
  wire_routing_number     TEXT NULL,
  wire_account_number     TEXT NULL,
  wire_bank_address       TEXT NULL,
  wire_memo_instructions  TEXT NULL,

  -- Invoice presentation
  invoice_tagline         TEXT NULL,
  invoice_footer_text     TEXT NULL,

  -- Audit
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL
);


-- ============================================================
-- SECTION 6: crm_invoices — MAIN INVOICE TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.crm_invoices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Invoice number: NULL while draft; assigned at issuance from sequence
  -- Format: EB-YYYY-NNNNNN
  invoice_number          TEXT UNIQUE NULL,

  -- Deal / entity relationships
  application_id          UUID NOT NULL REFERENCES public.borrower_applications(id),
  company_id              UUID NULL REFERENCES public.crm_companies(id) ON DELETE SET NULL,
  contact_id              UUID NULL REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  -- option_cycle_id: same-deal integrity enforced by trigger below
  option_cycle_id         UUID NULL REFERENCES public.crm_deal_option_cycles(id) ON DELETE SET NULL,

  -- Invoice classification
  invoice_type            TEXT NOT NULL
    CHECK (invoice_type IN ('initial', 'extension', 'other')),

  -- Workflow status
  -- draft → issuing → open → partially_paid / paid / void
  -- Status transitions enforced by trigger (validate_invoice_status_transition).
  status                  TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issuing', 'open', 'partially_paid', 'paid', 'void')),

  currency                TEXT NOT NULL DEFAULT 'USD',

  -- ── Billing snapshot ──────────────────────────────────────────────────────
  -- Editable while status = draft.
  -- Immutable once issuance begins (enforced by trigger below).
  -- Changing crm_companies later must NOT change an issued invoice.
  billing_name            TEXT NULL,
  billing_contact_name    TEXT NULL,
  billing_email           TEXT NULL,
  billing_address_line1   TEXT NULL,
  billing_address_line2   TEXT NULL,
  billing_city            TEXT NULL,
  billing_state           TEXT NULL,
  billing_postal_code     TEXT NULL,
  billing_country         TEXT NOT NULL DEFAULT 'US',

  -- ── Financial snapshot ────────────────────────────────────────────────────
  -- Snapshotted during draft→issuing transition; immutable after.
  emd_funded_cents        BIGINT NULL,
  funding_date            DATE NULL,
  period_start_date       DATE NULL,
  period_end_date         DATE NULL,
  billable_days           INTEGER NULL,

  -- ── Invoice totals (integer cents) ───────────────────────────────────────
  -- Calculated server-side from line items. Never trust browser-submitted totals.
  -- subtotal_cents >= 0: positive line items only
  -- discount_cents >= 0: absolute value of negative discount lines
  -- tax_cents = 0: EarnestBridge does not charge sales tax
  -- total_cents >= 0: a fully waived invoice may total 0 but never negative
  subtotal_cents          BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents          BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents               BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents = 0),
  total_cents             BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),

  -- ── Payment settings snapshot ─────────────────────────────────────────────
  -- Copied from borrower_applications.credit_card_payment_enabled at issuance.
  -- Changing the Deal setting later must NOT alter an issued invoice.
  credit_card_payment_enabled_snapshot BOOLEAN NOT NULL DEFAULT false,

  -- ── Wire instructions snapshot ────────────────────────────────────────────
  -- Populated at issuance from crm_invoice_settings.
  -- Ensures historical PDFs remain accurate if EarnestBridge changes banks.
  wire_instructions_snapshot JSONB NULL,

  -- ── Due date ──────────────────────────────────────────────────────────────
  -- Business default: DUE UPON RECEIPT.
  -- Future Issue Invoice logic: if Admin did not choose another due_date,
  -- due_date = issued date (date portion of issued_at).
  -- Admin can override while invoice is still a draft.
  due_date                DATE NULL,

  -- ── Issuance state fields ─────────────────────────────────────────────────
  -- Future workflow: draft → issuing → open
  -- issuing_started_at: set when Issue Invoice action begins
  -- issued_at: set when PDF is generated and invoice is fully open
  issuing_started_at      TIMESTAMPTZ NULL,
  issued_at               TIMESTAMPTZ NULL,
  paid_at                 TIMESTAMPTZ NULL,
  voided_at               TIMESTAMPTZ NULL,
  voided_by               UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  void_reason             TEXT NULL,

  -- ── Void / replacement chain ──────────────────────────────────────────────
  -- replaces_invoice_id: this invoice is the canonical replacement for that one.
  -- Integrity constraints enforced by trigger:
  --   - cannot replace itself
  --   - replacement must belong to same application_id
  --   - original invoice must have status = 'void'
  replaces_invoice_id     UUID NULL REFERENCES public.crm_invoices(id) ON DELETE SET NULL,

  -- ── PDF fields ────────────────────────────────────────────────────────────
  -- Do NOT generate PDFs in this step. Schema supports future generation.
  pdf_storage_path        TEXT NULL,
  pdf_generated_at        TIMESTAMPTZ NULL,
  pdf_hash                TEXT NULL,
  pdf_generation_status   TEXT NOT NULL DEFAULT 'not_started'
    CHECK (pdf_generation_status IN ('not_started', 'pending', 'generated', 'failed')),
  pdf_generation_error    TEXT NULL,

  -- ── Notes ─────────────────────────────────────────────────────────────────
  notes                   TEXT NULL,

  -- ── Audit ─────────────────────────────────────────────────────────────────
  created_by              UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index: one canonical replacement per voided invoice.
-- Prevents one voided invoice from accidentally having multiple replacements.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_invoices_replaces_invoice_id_unique
  ON public.crm_invoices (replaces_invoice_id)
  WHERE replaces_invoice_id IS NOT NULL;


-- ============================================================
-- SECTION 7: crm_invoice_line_items
-- ============================================================

CREATE TABLE IF NOT EXISTS public.crm_invoice_line_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  invoice_id              UUID NOT NULL
    REFERENCES public.crm_invoices(id) ON DELETE CASCADE,

  -- Line type classification
  line_type               TEXT NOT NULL
    CHECK (line_type IN (
      'admin_fee',
      'deal_fee',
      'extension_admin_fee',
      'extension_deal_fee',
      'discount',
      'other'
    )),

  description             TEXT NOT NULL,

  -- quantity must be positive (> 0)
  quantity                INTEGER NOT NULL DEFAULT 1
    CHECK (quantity > 0),

  unit_amount_cents       BIGINT NOT NULL,
  line_amount_cents       BIGINT NOT NULL,

  -- Discount constraint: discount lines must be <= 0
  -- Normal fee lines must be >= 0
  CONSTRAINT chk_line_amount_discount
    CHECK (
      (line_type = 'discount' AND line_amount_cents <= 0)
      OR (line_type != 'discount' AND line_amount_cents >= 0)
    ),

  -- ── Calculation audit fields ──────────────────────────────────────────────
  -- Snapshot WHY a Deal Fee amount exists.
  -- For deal_fee / extension_deal_fee lines:
  --   calc_daily_rate_per_100k_cents = 10000 ($100.00 = 10,000 cents)
  -- These fields allow future Admins to understand the calculation
  -- without recalculating historical invoices.
  calc_emd_funded_cents          BIGINT NULL,
  calc_daily_rate_per_100k_cents BIGINT NULL,
  calc_billable_days             INTEGER NULL,
  calc_period_start_date         DATE NULL,
  calc_period_end_date           DATE NULL,

  sort_order              INTEGER NOT NULL DEFAULT 0,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- SECTION 8: crm_payments
-- Bank wire first. Provider fields nullable for future Coinflow.
-- crm_payment_events NOT created (deferred to Coinflow phase).
--
-- HARDENING: application_id REMOVED.
-- The Deal is always derived through: crm_payments.invoice_id
--   → crm_invoices.application_id
-- Removing application_id eliminates the integrity mismatch risk
-- where payment.invoice_id could belong to Deal A while
-- payment.application_id points to Deal B.
--
-- amount_cents > 0: positive payments only. Refunds modeled through
-- status/refund workflow, not negative payment rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.crm_payments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  invoice_id              UUID NOT NULL
    REFERENCES public.crm_invoices(id),

  -- NOTE: application_id intentionally omitted.
  -- Derive the Deal via: crm_payments.invoice_id → crm_invoices.application_id
  -- This prevents application_id / invoice_id integrity mismatches.

  -- Payment method: bank_wire first; other for manual/miscellaneous
  payment_method          TEXT NOT NULL
    CHECK (payment_method IN ('bank_wire', 'other')),

  -- Payment status
  -- Transitions enforced by trigger (validate_payment_status_transition).
  status                  TEXT NOT NULL
    CHECK (status IN ('pending', 'received', 'refunded', 'failed')),

  -- amount_cents must be positive. Zero or negative payment records are not allowed.
  -- Refunds are modeled through status = 'refunded', not negative amounts.
  amount_cents            BIGINT NOT NULL CHECK (amount_cents > 0),
  currency                TEXT NOT NULL DEFAULT 'USD',

  received_at             TIMESTAMPTZ NULL,
  reference_number        TEXT NULL,
  notes                   TEXT NULL,

  recorded_by             UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  -- ── Future provider fields (nullable; unused for bank wire) ───────────────
  -- Do NOT create Coinflow-specific architecture yet.
  provider                TEXT NULL,
  provider_payment_id     TEXT NULL,

  -- ── Receipt PDF fields ────────────────────────────────────────────────────
  -- Do NOT generate receipts now. Schema supports future generation.
  receipt_pdf_storage_path    TEXT NULL,
  receipt_pdf_generated_at    TIMESTAMPTZ NULL,
  receipt_pdf_hash            TEXT NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- SECTION 9: UPDATED_AT TRIGGERS FOR NEW TABLES
-- ============================================================

-- crm_invoices updated_at
DROP TRIGGER IF EXISTS crm_invoices_updated_at ON public.crm_invoices;
CREATE TRIGGER crm_invoices_updated_at
  BEFORE UPDATE ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- crm_invoice_line_items updated_at
DROP TRIGGER IF EXISTS crm_invoice_line_items_updated_at ON public.crm_invoice_line_items;
CREATE TRIGGER crm_invoice_line_items_updated_at
  BEFORE UPDATE ON public.crm_invoice_line_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- crm_payments updated_at
DROP TRIGGER IF EXISTS crm_payments_updated_at ON public.crm_payments;
CREATE TRIGGER crm_payments_updated_at
  BEFORE UPDATE ON public.crm_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- crm_invoice_settings updated_at
DROP TRIGGER IF EXISTS crm_invoice_settings_updated_at ON public.crm_invoice_settings;
CREATE TRIGGER crm_invoice_settings_updated_at
  BEFORE UPDATE ON public.crm_invoice_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- SECTION 10: ISSUED INVOICE SNAPSHOT IMMUTABILITY TRIGGER
--
-- HARDENING (6A-2a):
-- Admin AND service_role bypasses have been REMOVED.
-- Once an invoice leaves status = 'draft', the snapshot fields
-- listed below are immutable for EVERYONE — including Admin and
-- service_role. There is no bypass.
--
-- The ONLY window to finalize snapshot fields is the
-- draft → issuing transition:
--   OLD.status = 'draft' AND NEW.status = 'issuing'
-- During this transition the trigger allows all field changes
-- because OLD.status IS 'draft' (the guard condition is not met).
--
-- Protected immutable fields (once OLD.status != 'draft'):
--   application_id, company_id, contact_id, option_cycle_id,
--   invoice_type, currency,
--   billing_name, billing_contact_name, billing_email,
--   billing_address_line1/2, billing_city, billing_state,
--   billing_postal_code, billing_country,
--   emd_funded_cents, funding_date, period_start_date,
--   period_end_date, billable_days,
--   subtotal_cents, discount_cents, tax_cents, total_cents,
--   credit_card_payment_enabled_snapshot, wire_instructions_snapshot,
--   invoice_number
--
-- Workflow fields that remain mutable through trusted server paths
-- (NOT protected by this trigger):
--   status, issued_at, issuing_started_at, paid_at,
--   voided_at, voided_by, void_reason,
--   pdf_storage_path, pdf_generated_at, pdf_hash,
--   pdf_generation_status, pdf_generation_error,
--   due_date, notes, updated_at
--
-- If an issued invoice is wrong: Void + Replacement Invoice.
-- Do not edit history.
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_issued_invoice_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_any_immutable BOOLEAN;
BEGIN
  -- ── ONLY enforce once the invoice has left draft status ───────────────────
  -- While OLD.status = 'draft', ALL fields are freely editable.
  -- This includes the draft → issuing transition, which is the intended
  -- window for the issuance action to finalize all snapshot fields,
  -- assign the invoice number, and snapshot wire instructions / CC availability.
  -- No bypass is needed for service_role or Admin — the OLD.status guard
  -- is sufficient and correct.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- ── Check whether any immutable snapshot field changed ────────────────────
  v_any_immutable :=
       NEW.application_id                       IS DISTINCT FROM OLD.application_id
    OR NEW.company_id                           IS DISTINCT FROM OLD.company_id
    OR NEW.contact_id                           IS DISTINCT FROM OLD.contact_id
    OR NEW.option_cycle_id                      IS DISTINCT FROM OLD.option_cycle_id
    OR NEW.invoice_type                         IS DISTINCT FROM OLD.invoice_type
    OR NEW.currency                             IS DISTINCT FROM OLD.currency
    OR NEW.billing_name                         IS DISTINCT FROM OLD.billing_name
    OR NEW.billing_contact_name                 IS DISTINCT FROM OLD.billing_contact_name
    OR NEW.billing_email                        IS DISTINCT FROM OLD.billing_email
    OR NEW.billing_address_line1                IS DISTINCT FROM OLD.billing_address_line1
    OR NEW.billing_address_line2                IS DISTINCT FROM OLD.billing_address_line2
    OR NEW.billing_city                         IS DISTINCT FROM OLD.billing_city
    OR NEW.billing_state                        IS DISTINCT FROM OLD.billing_state
    OR NEW.billing_postal_code                  IS DISTINCT FROM OLD.billing_postal_code
    OR NEW.billing_country                      IS DISTINCT FROM OLD.billing_country
    OR NEW.emd_funded_cents                     IS DISTINCT FROM OLD.emd_funded_cents
    OR NEW.funding_date                         IS DISTINCT FROM OLD.funding_date
    OR NEW.period_start_date                    IS DISTINCT FROM OLD.period_start_date
    OR NEW.period_end_date                      IS DISTINCT FROM OLD.period_end_date
    OR NEW.billable_days                        IS DISTINCT FROM OLD.billable_days
    OR NEW.subtotal_cents                       IS DISTINCT FROM OLD.subtotal_cents
    OR NEW.discount_cents                       IS DISTINCT FROM OLD.discount_cents
    OR NEW.tax_cents                            IS DISTINCT FROM OLD.tax_cents
    OR NEW.total_cents                          IS DISTINCT FROM OLD.total_cents
    OR NEW.credit_card_payment_enabled_snapshot IS DISTINCT FROM OLD.credit_card_payment_enabled_snapshot
    OR NEW.wire_instructions_snapshot           IS DISTINCT FROM OLD.wire_instructions_snapshot
    OR NEW.invoice_number                       IS DISTINCT FROM OLD.invoice_number;

  -- No immutable field changed → allow (workflow fields like status, pdf_*, voided_* are fine)
  IF NOT v_any_immutable THEN
    RETURN NEW;
  END IF;

  -- ── Reject for EVERYONE — no Admin or service_role bypass ─────────────────
  -- Once an invoice has left draft, its financial/document snapshot is
  -- immutable. The correction model is: Void + Replacement Invoice.
  -- Admin and service_role must use that model, not direct field edits.
  RAISE EXCEPTION
    'Permission denied: financial and billing snapshot fields on an issued invoice '
    'are immutable and cannot be changed once the invoice has left draft status. '
    'Use Void + Replacement Invoice to correct an issued invoice.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

DROP TRIGGER IF EXISTS guard_issued_invoice_immutability ON public.crm_invoices;
CREATE TRIGGER guard_issued_invoice_immutability
  BEFORE UPDATE ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_issued_invoice_fields();


-- ============================================================
-- SECTION 11: ISSUED INVOICE HARD-DELETE PROTECTION TRIGGER
--
-- HARDENING (6A-2a):
-- An invoice that has left draft must NEVER be hard-deleted.
-- Admin may delete a draft invoice.
-- Invoices in: issuing, open, partially_paid, paid, void
-- must not be DELETE-able by anyone, including service_role.
--
-- The normal correction model is: Void + Replacement Invoice.
-- This trigger provides defense-in-depth alongside the RLS
-- DELETE policy (which is also restricted to draft-only).
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_issued_invoice_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
BEGIN
  -- Allow deletion of draft invoices only
  IF OLD.status = 'draft' THEN
    RETURN OLD;
  END IF;

  -- Block hard delete of any invoice that has left draft status.
  -- This applies to everyone, including Admin and service_role.
  -- The correction model is: Void + Replacement Invoice.
  RAISE EXCEPTION
    'Permission denied: invoices that have left draft status (current status: %) '
    'cannot be hard-deleted. Use the Void + Replacement Invoice workflow instead.',
    OLD.status
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

DROP TRIGGER IF EXISTS guard_issued_invoice_delete ON public.crm_invoices;
CREATE TRIGGER guard_issued_invoice_delete
  BEFORE DELETE ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_issued_invoice_delete();


-- ============================================================
-- SECTION 12: LINE ITEM ABSOLUTE IMMUTABILITY TRIGGER
--
-- HARDENING (6A-2a):
-- crm_invoice_line_items may be INSERT/UPDATE/DELETE only while
-- the parent invoice status = 'draft'.
-- Once parent invoice status != 'draft':
--   - reject INSERT
--   - reject UPDATE
--   - reject DELETE
-- for EVERYONE, including Admin and service_role.
-- No bypass.
--
-- If an issued invoice is wrong: Void + Replacement Invoice.
-- Do not edit history.
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_issued_invoice_line_items()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_invoice_id     UUID;
  v_invoice_status TEXT;
BEGIN
  -- Resolve the invoice_id for this operation
  -- For DELETE, NEW is NULL so use OLD; for INSERT/UPDATE use NEW
  v_invoice_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- Fetch the parent invoice status
  SELECT status INTO v_invoice_status
  FROM public.crm_invoices
  WHERE id = v_invoice_id;

  -- If invoice is still draft (or not found), allow all operations
  IF v_invoice_status IS NULL OR v_invoice_status = 'draft' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── Reject for EVERYONE — no Admin or service_role bypass ─────────────────
  -- Line items are absolutely immutable once the parent invoice has left draft.
  -- This applies to INSERT, UPDATE, and DELETE.
  -- The correction model is: Void + Replacement Invoice.
  RAISE EXCEPTION
    'Permission denied: invoice line items are immutable once the parent invoice '
    'has left draft status (current invoice status: %). '
    'Use Void + Replacement Invoice to correct an issued invoice.',
    v_invoice_status
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

DROP TRIGGER IF EXISTS guard_issued_invoice_line_items ON public.crm_invoice_line_items;
CREATE TRIGGER guard_issued_invoice_line_items
  BEFORE INSERT OR UPDATE OR DELETE ON public.crm_invoice_line_items
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_issued_invoice_line_items();


-- ============================================================
-- SECTION 13: OPTION CYCLE SAME-DEAL INTEGRITY TRIGGER
--
-- HARDENING (6A-2a):
-- A simple FK crm_invoices.option_cycle_id → crm_deal_option_cycles.id
-- does NOT ensure the cycle belongs to the invoice's application_id.
-- This trigger enforces that when option_cycle_id IS NOT NULL,
-- the referenced crm_deal_option_cycles.application_id must equal
-- crm_invoices.application_id.
--
-- This is critical because a future paid Extension invoice may update
-- extension_fee_paid_at on the linked Option Cycle. It must be
-- impossible to link an invoice for Deal A to Deal B's cycle.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_invoice_option_cycle_same_deal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_cycle_application_id UUID;
BEGIN
  -- Only validate when option_cycle_id is being set (non-NULL)
  IF NEW.option_cycle_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only re-validate if option_cycle_id or application_id actually changed
  IF TG_OP = 'UPDATE'
     AND NEW.option_cycle_id IS NOT DISTINCT FROM OLD.option_cycle_id
     AND NEW.application_id  IS NOT DISTINCT FROM OLD.application_id
  THEN
    RETURN NEW;
  END IF;

  -- Look up the cycle's application_id
  SELECT application_id INTO v_cycle_application_id
  FROM public.crm_deal_option_cycles
  WHERE id = NEW.option_cycle_id;

  IF v_cycle_application_id IS NULL THEN
    RAISE EXCEPTION
      'validate_invoice_option_cycle_same_deal: option_cycle_id % does not exist.',
      NEW.option_cycle_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_cycle_application_id IS DISTINCT FROM NEW.application_id THEN
    RAISE EXCEPTION
      'validate_invoice_option_cycle_same_deal: option_cycle_id % belongs to '
      'application_id % but this invoice belongs to application_id %. '
      'An invoice may only be linked to an Option Cycle from the same Deal.',
      NEW.option_cycle_id, v_cycle_application_id, NEW.application_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS guard_invoice_option_cycle_same_deal ON public.crm_invoices;
CREATE TRIGGER guard_invoice_option_cycle_same_deal
  BEFORE INSERT OR UPDATE OF option_cycle_id, application_id ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invoice_option_cycle_same_deal();


-- ============================================================
-- SECTION 14: REPLACEMENT INVOICE INTEGRITY TRIGGER
--
-- HARDENING (6A-2a + 6A-2b):
-- Enforces:
--   1. An invoice cannot replace itself (no self-reference).
--   2. The replacement and the original must belong to the same
--      application_id (same Deal).
--   3. One canonical replacement per original is enforced by the
--      partial UNIQUE index on replaces_invoice_id (already created
--      in Section 6 above).
--   4. (6A-2b) The original invoice must have status = 'void'.
--      A replacement may only point at a voided invoice.
--      This matches the business workflow: Void original → create replacement.
--      Do not allow a replacement to point at an active/open/paid invoice.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_invoice_replacement_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_original_application_id UUID;
  v_original_status          TEXT;
BEGIN
  -- Only validate when replaces_invoice_id is being set (non-NULL)
  IF NEW.replaces_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only re-validate if replaces_invoice_id or application_id actually changed
  IF TG_OP = 'UPDATE'
     AND NEW.replaces_invoice_id IS NOT DISTINCT FROM OLD.replaces_invoice_id
     AND NEW.application_id      IS NOT DISTINCT FROM OLD.application_id
  THEN
    RETURN NEW;
  END IF;

  -- 1. Self-reference check: an invoice cannot replace itself
  IF NEW.replaces_invoice_id = NEW.id THEN
    RAISE EXCEPTION
      'validate_invoice_replacement_integrity: an invoice cannot replace itself (id: %).',
      NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- 2. Fetch original invoice application_id and status
  SELECT application_id, status
    INTO v_original_application_id, v_original_status
  FROM public.crm_invoices
  WHERE id = NEW.replaces_invoice_id;

  IF v_original_application_id IS NULL THEN
    RAISE EXCEPTION
      'validate_invoice_replacement_integrity: replaces_invoice_id % does not exist.',
      NEW.replaces_invoice_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- 3. Same-Deal check: replacement must belong to the same application_id
  IF v_original_application_id IS DISTINCT FROM NEW.application_id THEN
    RAISE EXCEPTION
      'validate_invoice_replacement_integrity: replacement invoice belongs to '
      'application_id % but the original invoice (%) belongs to application_id %. '
      'A replacement invoice must belong to the same Deal as the original.',
      NEW.application_id, NEW.replaces_invoice_id, v_original_application_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- 4. (6A-2b) Original must be voided: a replacement may only point at a void invoice.
  --    Business workflow: Void original → create replacement.
  --    Do not allow a replacement to point at an active, open, or paid invoice.
  IF v_original_status IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION
      'validate_invoice_replacement_integrity: replaces_invoice_id % has status ''%''. '
      'A replacement invoice may only reference an invoice with status = ''void''. '
      'Void the original invoice first, then create the replacement.',
      NEW.replaces_invoice_id, v_original_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS guard_invoice_replacement_integrity ON public.crm_invoices;
CREATE TRIGGER guard_invoice_replacement_integrity
  BEFORE INSERT OR UPDATE OF replaces_invoice_id, application_id ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invoice_replacement_integrity();


-- ============================================================
-- SECTION 15: PAYMENT HARD-DELETE PROTECTION TRIGGER
--
-- HARDENING (6A-2a):
-- crm_payments are financial audit records.
-- Hard DELETE of payment records is not permitted.
-- If a payment is entered incorrectly, preserve an audit trail
-- rather than erasing a received payment.
-- Correction/reversal behavior will be designed when Record Payment
-- is implemented. No payment rows exist now.
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_payment_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
BEGIN
  -- Block hard delete of payment records for everyone, including service_role.
  -- Payment records are financial audit history.
  -- Use status = 'refunded' or a future reversal record for corrections.
  RAISE EXCEPTION
    'Permission denied: crm_payments records cannot be hard-deleted. '
    'Payment records are financial audit history. '
    'Use status corrections or reversal records for payment adjustments.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

DROP TRIGGER IF EXISTS guard_payment_delete ON public.crm_payments;
CREATE TRIGGER guard_payment_delete
  BEFORE DELETE ON public.crm_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_payment_delete();


-- ============================================================
-- SECTION 16: INVOICE STATUS TRANSITION GUARD (6A-2b)
--
-- Validates that every invoice status change follows the allowed
-- transition matrix. Disallows all transitions not in the matrix,
-- especially non-draft → draft (the "loophole" this closes).
--
-- Same-status updates are always allowed.
--
-- Allowed transitions:
--   draft         → draft, issuing
--   issuing       → issuing, open, void
--   open          → open, partially_paid, paid, void
--   partially_paid→ partially_paid, paid, void
--   paid          → paid          (permanent; no reopening)
--   void          → void          (permanent; no reopening)
--
-- Explicitly disallowed (among others):
--   issuing       → draft
--   open          → draft
--   partially_paid→ draft
--   paid          → draft
--   void          → draft
--   void          → open
--   void          → issuing
--   paid          → open
--   paid          → partially_paid
--   paid          → void
--
-- This trigger applies to ALL callers including Admin and service_role.
-- There is no bypass.
--
-- Rationale for paid permanence:
--   Future refunds/reversals will be modeled explicitly rather than
--   silently reopening the invoice.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_invoice_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
BEGIN
  -- Same-status update: always allowed
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Validate the transition against the allowed matrix
  IF NOT (
    -- draft → issuing (only forward transition from draft)
    (OLD.status = 'draft'          AND NEW.status = 'issuing')
    -- issuing → open or void
    OR (OLD.status = 'issuing'     AND NEW.status IN ('open', 'void'))
    -- open → partially_paid, paid, void
    OR (OLD.status = 'open'        AND NEW.status IN ('partially_paid', 'paid', 'void'))
    -- partially_paid → paid, void
    OR (OLD.status = 'partially_paid' AND NEW.status IN ('paid', 'void'))
    -- paid → (no transitions; paid is permanent)
    -- void → (no transitions; void is permanent)
  ) THEN
    RAISE EXCEPTION
      'Invalid invoice status transition: % → %. '
      'Allowed transitions: '
      'draft→issuing; '
      'issuing→open,void; '
      'open→partially_paid,paid,void; '
      'partially_paid→paid,void; '
      'paid and void are terminal states. '
      'A non-draft invoice can never return to draft.',
      OLD.status, NEW.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS guard_invoice_status_transition ON public.crm_invoices;
CREATE TRIGGER guard_invoice_status_transition
  BEFORE UPDATE OF status ON public.crm_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invoice_status_transition();


-- ============================================================
-- SECTION 17: PAYMENT CORE-FACT IMMUTABILITY TRIGGER (6A-2b)
--
-- crm_payments are financial audit records.
-- While payment status = 'pending', Admin/server may edit fields freely.
--
-- Once a payment reaches: received, refunded, failed
-- the following core historical payment facts become immutable
-- for EVERYONE including Admin and service_role:
--
--   invoice_id
--   payment_method
--   amount_cents
--   currency
--   received_at
--   reference_number
--   provider
--   provider_payment_id
--
-- Operational metadata that remains updateable:
--   notes
--   receipt_pdf_storage_path
--   receipt_pdf_generated_at
--   receipt_pdf_hash
--   updated_at
--   status (governed separately by payment status transition trigger)
--
-- There is no Admin or service_role bypass for core fact immutability.
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
    -- Only operational metadata changed (notes, receipt_pdf_*, updated_at, status)
    RETURN NEW;
  END IF;

  -- Reject for EVERYONE — no Admin or service_role bypass
  RAISE EXCEPTION
    'Permission denied: core payment facts (invoice_id, payment_method, amount_cents, '
    'currency, received_at, reference_number, provider, provider_payment_id) are '
    'immutable once a payment has reached status ''%''. '
    'These fields cannot be changed after the payment is no longer pending.',
    OLD.status
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

DROP TRIGGER IF EXISTS guard_completed_payment_facts ON public.crm_payments;
CREATE TRIGGER guard_completed_payment_facts
  BEFORE UPDATE ON public.crm_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_completed_payment_facts();


-- ============================================================
-- SECTION 18: PAYMENT STATUS TRANSITION GUARD (6A-2b)
--
-- Validates that every payment status change follows the allowed
-- conservative transition matrix.
--
-- Same-status updates are always allowed.
--
-- Allowed transitions:
--   pending   → pending, received, failed
--   received  → received, refunded
--   failed    → failed    (terminal)
--   refunded  → refunded  (terminal)
--
-- Explicitly disallowed:
--   received  → pending
--   received  → failed
--   failed    → pending
--   failed    → received
--   refunded  → received
--   refunded  → pending
--
-- No reversal/retry semantics invented yet.
-- Future Coinflow may require additional provider-specific states.
-- This trigger applies to ALL callers including Admin and service_role.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_payment_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
BEGIN
  -- Same-status update: always allowed
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Validate the transition against the allowed matrix
  IF NOT (
    -- pending → received or failed
    (OLD.status = 'pending'  AND NEW.status IN ('received', 'failed'))
    -- received → refunded (only forward transition from received)
    OR (OLD.status = 'received' AND NEW.status = 'refunded')
    -- failed → (no transitions; failed is terminal)
    -- refunded → (no transitions; refunded is terminal)
  ) THEN
    RAISE EXCEPTION
      'Invalid payment status transition: % → %. '
      'Allowed transitions: '
      'pending→received,failed; '
      'received→refunded; '
      'failed and refunded are terminal states.',
      OLD.status, NEW.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS guard_payment_status_transition ON public.crm_payments;
CREATE TRIGGER guard_payment_status_transition
  BEFORE UPDATE OF status ON public.crm_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_payment_status_transition();


-- ============================================================
-- SECTION 19: ENABLE RLS ON ALL NEW TABLES
-- ============================================================

ALTER TABLE public.crm_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_invoice_settings ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SECTION 20: RLS POLICIES
--
-- HARDENING (6A-2a):
-- Admin RLS is split into separate SELECT / INSERT / UPDATE / DELETE
-- policies. Broad FOR ALL is NOT used where it would unintentionally
-- permit destructive DELETE behavior.
--
-- crm_invoices Admin:
--   SELECT = yes (all invoices)
--   INSERT = yes
--   UPDATE = yes (subject to immutability trigger)
--   DELETE = draft only
--
-- crm_invoice_line_items Admin:
--   SELECT = yes
--   INSERT / UPDATE / DELETE = only when parent invoice is draft
--   (Database trigger is authoritative; RLS provides defense-in-depth)
--
-- crm_payments Admin:
--   SELECT = yes
--   INSERT = yes
--   UPDATE = yes
--   DELETE = NO (trigger blocks; no RLS DELETE policy created)
--
-- crm_invoice_settings:
--   Admin = FOR ALL (no client access whatsoever)
--   Client = NONE
--
-- Client portal:
--   crm_invoices = SELECT only via crm_deal_contacts explicit access
--   crm_invoice_line_items = SELECT only via invoice → deal → contact chain
--   crm_payments = NO ACCESS (Admin/server only)
--   crm_invoice_settings = NO ACCESS
--
-- Admin authorization: raw_app_meta_data->>'role' = 'admin' ONLY
-- (server-controlled; never user-editable metadata)
-- Company membership alone does NOT grant invoice access.
-- ============================================================

-- ── crm_invoices ─────────────────────────────────────────────────────────────

-- Admin SELECT: all invoices
DROP POLICY IF EXISTS "admins_select_crm_invoices" ON public.crm_invoices;
CREATE POLICY "admins_select_crm_invoices"
  ON public.crm_invoices
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- Admin INSERT: allowed
DROP POLICY IF EXISTS "admins_insert_crm_invoices" ON public.crm_invoices;
CREATE POLICY "admins_insert_crm_invoices"
  ON public.crm_invoices
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin_user());

-- Admin UPDATE: allowed (immutability trigger is authoritative for snapshot fields)
DROP POLICY IF EXISTS "admins_update_crm_invoices" ON public.crm_invoices;
CREATE POLICY "admins_update_crm_invoices"
  ON public.crm_invoices
  FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- Admin DELETE: draft invoices only
-- Non-draft invoices are also blocked by the hard-delete trigger (defense-in-depth).
DROP POLICY IF EXISTS "admins_delete_draft_crm_invoices" ON public.crm_invoices;
CREATE POLICY "admins_delete_draft_crm_invoices"
  ON public.crm_invoices
  FOR DELETE
  TO authenticated
  USING (
    public.is_admin_user()
    AND status = 'draft'
  );

-- Portal clients: SELECT only, for invoices on Deals they have explicit access to.
-- Access requires: approved CRM contact in crm_deal_contacts for the invoice's deal.
-- Company membership alone does NOT grant access.
DROP POLICY IF EXISTS "portal_clients_read_own_invoices" ON public.crm_invoices;
CREATE POLICY "portal_clients_read_own_invoices"
  ON public.crm_invoices
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.crm_deal_contacts dc
      JOIN public.crm_contacts c ON c.id = dc.contact_id
      WHERE dc.deal_id = crm_invoices.application_id
        AND c.portal_user_id = auth.uid()
        AND c.portal_link_status = 'approved'
    )
  );

-- ── crm_invoice_line_items ────────────────────────────────────────────────────

-- Admin SELECT: all line items
DROP POLICY IF EXISTS "admins_select_crm_invoice_line_items" ON public.crm_invoice_line_items;
CREATE POLICY "admins_select_crm_invoice_line_items"
  ON public.crm_invoice_line_items
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- Admin INSERT: only when parent invoice is draft
-- (trigger is authoritative; RLS provides defense-in-depth)
DROP POLICY IF EXISTS "admins_insert_crm_invoice_line_items" ON public.crm_invoice_line_items;
CREATE POLICY "admins_insert_crm_invoice_line_items"
  ON public.crm_invoice_line_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin_user()
    AND EXISTS (
      SELECT 1 FROM public.crm_invoices
      WHERE id = invoice_id AND status = 'draft'
    )
  );

-- Admin UPDATE: only when parent invoice is draft
DROP POLICY IF EXISTS "admins_update_crm_invoice_line_items" ON public.crm_invoice_line_items;
CREATE POLICY "admins_update_crm_invoice_line_items"
  ON public.crm_invoice_line_items
  FOR UPDATE
  TO authenticated
  USING (
    public.is_admin_user()
    AND EXISTS (
      SELECT 1 FROM public.crm_invoices
      WHERE id = invoice_id AND status = 'draft'
    )
  )
  WITH CHECK (
    public.is_admin_user()
    AND EXISTS (
      SELECT 1 FROM public.crm_invoices
      WHERE id = invoice_id AND status = 'draft'
    )
  );

-- Admin DELETE: only when parent invoice is draft
DROP POLICY IF EXISTS "admins_delete_crm_invoice_line_items" ON public.crm_invoice_line_items;
CREATE POLICY "admins_delete_crm_invoice_line_items"
  ON public.crm_invoice_line_items
  FOR DELETE
  TO authenticated
  USING (
    public.is_admin_user()
    AND EXISTS (
      SELECT 1 FROM public.crm_invoices
      WHERE id = invoice_id AND status = 'draft'
    )
  );

-- Portal clients: SELECT only, through invoice → deal → contact access chain
DROP POLICY IF EXISTS "portal_clients_read_own_invoice_line_items" ON public.crm_invoice_line_items;
CREATE POLICY "portal_clients_read_own_invoice_line_items"
  ON public.crm_invoice_line_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.crm_invoices inv
      JOIN public.crm_deal_contacts dc ON dc.deal_id = inv.application_id
      JOIN public.crm_contacts c ON c.id = dc.contact_id
      WHERE inv.id = crm_invoice_line_items.invoice_id
        AND c.portal_user_id = auth.uid()
        AND c.portal_link_status = 'approved'
    )
  );

-- ── crm_payments ─────────────────────────────────────────────────────────────
--
-- HARDENING (6A-2a):
-- crm_payments = Admin/server only. No client SELECT access.
-- No DELETE policy (trigger blocks all deletes; no RLS DELETE policy needed).
-- Admin may SELECT, INSERT, UPDATE only.

-- Admin SELECT
DROP POLICY IF EXISTS "admins_select_crm_payments" ON public.crm_payments;
CREATE POLICY "admins_select_crm_payments"
  ON public.crm_payments
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- Admin INSERT
DROP POLICY IF EXISTS "admins_insert_crm_payments" ON public.crm_payments;
CREATE POLICY "admins_insert_crm_payments"
  ON public.crm_payments
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin_user());

-- Admin UPDATE
DROP POLICY IF EXISTS "admins_update_crm_payments" ON public.crm_payments;
CREATE POLICY "admins_update_crm_payments"
  ON public.crm_payments
  FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- NO Admin DELETE policy for crm_payments.
-- The protect_payment_delete() trigger blocks all deletes at the DB level.
-- Not creating a DELETE RLS policy ensures no accidental bypass path exists.

-- NO client SELECT policy for crm_payments.
-- crm_payments contains operational information (reference_number, notes,
-- future provider IDs) not appropriate for direct client access.
-- Future client-facing payment/receipt information will be exposed through
-- an intentionally limited server response/view when the client Payments UI
-- is built.

-- ── crm_invoice_settings ─────────────────────────────────────────────────────
-- Admin-only. No client access whatsoever.
-- Banking details must NOT be client-readable through direct browser/RLS access.
-- Anonymous access = NONE. Client access = NONE.

DROP POLICY IF EXISTS "admins_all_crm_invoice_settings" ON public.crm_invoice_settings;
CREATE POLICY "admins_all_crm_invoice_settings"
  ON public.crm_invoice_settings
  FOR ALL
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());


-- ============================================================
-- SECTION 21: INDEXES
-- ============================================================

-- crm_invoices
CREATE INDEX IF NOT EXISTS idx_crm_invoices_application_id
  ON public.crm_invoices (application_id);

CREATE INDEX IF NOT EXISTS idx_crm_invoices_company_id
  ON public.crm_invoices (company_id);

CREATE INDEX IF NOT EXISTS idx_crm_invoices_contact_id
  ON public.crm_invoices (contact_id);

CREATE INDEX IF NOT EXISTS idx_crm_invoices_option_cycle_id
  ON public.crm_invoices (option_cycle_id);

CREATE INDEX IF NOT EXISTS idx_crm_invoices_status
  ON public.crm_invoices (status);

-- invoice_number already has a UNIQUE constraint (implicit index); no duplicate needed.

-- crm_invoice_line_items
CREATE INDEX IF NOT EXISTS idx_crm_invoice_line_items_invoice_id
  ON public.crm_invoice_line_items (invoice_id);

-- crm_payments
-- application_id index removed (column does not exist on crm_payments).
-- Derive the Deal via: crm_payments.invoice_id → crm_invoices.application_id.
CREATE INDEX IF NOT EXISTS idx_crm_payments_invoice_id
  ON public.crm_payments (invoice_id);

CREATE INDEX IF NOT EXISTS idx_crm_payments_status
  ON public.crm_payments (status);


-- ============================================================
-- SECTION 22: EXTEND application_activity event_type CHECK
--
-- The existing CHECK constraint is:
--   event_type = ANY (ARRAY[
--     'status_change', 'document_upload', 'admin_note', 'deadline_shift',
--     'system', 'document_revision_uploaded', 'revision_requested',
--     'document_approved', 'owner_assigned', 'task_created', 'email_sent',
--     'call_logged', 'deadline_created', 'deadline_updated',
--     'deadline_completed', 'deadline_cancelled', 'deadline_reopened',
--     'option_cycle_created', 'option_exercised',
--     'extension_amendment_received', 'extension_fee_paid',
--     'option_cycle_extended', 'option_cycle_missed',
--     'extension_override_accepted'
--   ])
--
-- We ADD the new invoice/payment event types ADDITIVELY.
-- ALL existing values are preserved exactly.
-- No existing event types are removed or renamed.
-- ============================================================

ALTER TABLE public.application_activity
  DROP CONSTRAINT IF EXISTS application_activity_event_type_check;

ALTER TABLE public.application_activity
  ADD CONSTRAINT application_activity_event_type_check
  CHECK (event_type = ANY (ARRAY[
    -- ── Existing values (preserved exactly) ──────────────────────────────
    'status_change'::text,
    'document_upload'::text,
    'admin_note'::text,
    'deadline_shift'::text,
    'system'::text,
    'document_revision_uploaded'::text,
    'revision_requested'::text,
    'document_approved'::text,
    'owner_assigned'::text,
    'task_created'::text,
    'email_sent'::text,
    'call_logged'::text,
    'deadline_created'::text,
    'deadline_updated'::text,
    'deadline_completed'::text,
    'deadline_cancelled'::text,
    'deadline_reopened'::text,
    'option_cycle_created'::text,
    'option_exercised'::text,
    'extension_amendment_received'::text,
    'extension_fee_paid'::text,
    'option_cycle_extended'::text,
    'option_cycle_missed'::text,
    'extension_override_accepted'::text,
    -- ── New invoice / payment event types ────────────────────────────────
    'invoice_created'::text,
    'invoice_issued'::text,
    'invoice_voided'::text,
    'invoice_replaced'::text,
    'payment_received'::text,
    'invoice_paid'::text,
    'payment_refunded'::text,
    'receipt_generated'::text
  ]));


-- ============================================================
-- SECTION 23: PRIVATE STORAGE BUCKET — invoice-pdfs
--
-- Invoice PDFs contain client billing information, Deal financial
-- information, and banking/payment instructions.
-- Must NOT be stored in a public bucket.
--
-- Path concept: invoices/{application_id}/{invoice_id}.pdf
-- Future access:
--   Admin: authorized server/signed access
--   Client: server validates explicit Deal access,
--           then creates a short-lived signed URL
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoice-pdfs',
  'invoice-pdfs',
  false,
  20971520,  -- 20 MB: sufficient for invoice and receipt PDFs
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: Admin full access to invoice-pdfs bucket
DROP POLICY IF EXISTS "admins_all_invoice_pdfs" ON storage.objects;
CREATE POLICY "admins_all_invoice_pdfs"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (
    bucket_id = 'invoice-pdfs'
    AND public.is_admin_user()
  )
  WITH CHECK (
    bucket_id = 'invoice-pdfs'
    AND public.is_admin_user()
  );

-- Storage RLS: Portal clients — NO direct access to invoice-pdfs.
-- PDF access will happen through a secure server endpoint after Deal authorization.
-- A blanket client storage policy is intentionally NOT created here.
-- Company membership alone must NOT grant access.
-- Anonymous access = NONE (no policy created for anon role).


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- COMPLETION SUMMARY (6A-2 + 6A-2a + 6A-2b Hardening)
-- -----------------------------------------------------
-- Migration file: 20260918000000_crm_invoicing_foundation.sql
-- Modified in place: YES
-- New migration created: NO
--
-- ── CORE SCHEMA ───────────────────────────────────────────────────────────
--
-- borrower_applications fields added:
--   funded_date DATE NULL
--   emd_funded_cents BIGINT NULL
--   credit_card_payment_enabled BOOLEAN NOT NULL DEFAULT false
--
-- deposit_amount preserved: YES (unchanged)
--
-- Borrower protection updated: YES
--   protect_borrower_application_admin_fields() guards
--   funded_date, emd_funded_cents, credit_card_payment_enabled
--   plus ALL previously protected fields.
--
-- Canonical Deal Fee function: YES
--   calculate_deal_fee_cents(p_emd_funded_cents BIGINT, p_start_date DATE, p_end_date DATE)
--   RETURNS BIGINT
--   Formula: ROUND((p_emd_funded_cents::NUMERIC * billable_days::NUMERIC) / 1000)::BIGINT
--   $250,000 / 30 days = 750,000 cents = $7,500.00 ✓
--   $250,000 / 10 days = 250,000 cents = $2,500.00 ✓
--
-- Money fields use BIGINT cents: YES
-- crm_companies modified: NO
--
-- crm_invoices created: YES
--   Statuses: draft, issuing, open, partially_paid, paid, void
--   issuing state included: YES
--   Billing snapshot fields: YES
--   Due Upon Receipt supported: YES (due_date NULL; future issuance sets due_date = issued date)
--   amount_paid_cents stored: NO (derived from crm_payments)
--   amount_due_cents stored: NO (derived from total_cents minus valid payments)
--   wire_instructions_snapshot: YES (JSONB NULL)
--   invoice_number: NULL while draft; assigned at issuance
--   subtotal_cents >= 0: YES (CHECK constraint)
--   discount_cents >= 0: YES (CHECK constraint)
--   tax_cents = 0: YES (CHECK constraint)
--   total_cents >= 0: YES (CHECK constraint)
--
-- crm_invoice_line_items created: YES
--   Calculation audit fields: YES (5 fields)
--   Discount constraint: YES (line_amount_cents <= 0 for discount type)
--   Fee line constraint: YES (line_amount_cents >= 0 for non-discount types)
--   quantity > 0: YES (CHECK constraint)
--
-- crm_payments created: YES
--   application_id: REMOVED (derive via invoice_id → crm_invoices.application_id)
--   amount_cents > 0: YES (CHECK constraint)
--   crm_payment_events created: NO (deferred to Coinflow phase)
--   Receipt fields prepared: YES
--
-- Option Cycle FK: crm_invoices.option_cycle_id → crm_deal_option_cycles(id) NULL
--
-- Invoice sequence created: YES (crm_invoice_number_seq, global, no per-year reset)
-- Invoice number format planned: EB-YYYY-NNNNNN
--
-- crm_invoice_settings type: typed singleton (id SMALLINT CHECK (id = 1))
-- Bank values hardcoded/seeded: NO
--
-- invoice-pdfs bucket: private (public=false), PDF only, 20 MB limit
-- Client storage public access: NO
-- Anonymous storage access: NO
--
-- ── HARDENING REPORT (6A-2a) ──────────────────────────────────────────────
--
-- Issued Snapshot Admin Bypass Removed: YES
-- Issued Snapshot service_role Bypass Removed: YES
-- Draft → Issuing Snapshot Finalization Still Works: YES
-- Issued Line Items Editable By Admin: NO
-- Issued Line Items Editable By service_role: NO
-- Issued Invoice Hard Delete Possible: NO
-- Draft Invoice Delete Possible: YES
-- Admin Invoice RLS: SELECT yes / INSERT yes / UPDATE yes / DELETE draft-only
-- crm_payments application_id Removed: YES
-- Client Direct crm_payments SELECT: NO
-- Payment Hard Delete Allowed: NO
-- Option Cycle Same-Deal Constraint: YES (trigger)
-- Replacement Self-Reference Prevented: YES
-- Replacement Same-Deal Constraint: YES
-- One Canonical Replacement Constraint: YES (partial UNIQUE index)
-- crm_invoice_settings Client Access: NONE
-- invoice-pdfs Still Private: YES
-- Canonical Deal Fee Function Unchanged: YES
-- Existing application_activity Values Preserved: YES (all 24 existing values)
-- New application_activity Values Added: 8 invoice/payment event types
--
-- ── HARDENING REPORT (6A-2b) ──────────────────────────────────────────────
--
-- Non-Draft → Draft Possible: NO
--   validate_invoice_status_transition() blocks all non-draft→draft transitions
--   for everyone including Admin and service_role.
--
-- Invoice Status Transition Trigger Added: YES
--   guard_invoice_status_transition fires BEFORE UPDATE OF status.
--   Allowed matrix:
--     draft         → issuing
--     issuing       → open, void
--     open          → partially_paid, paid, void
--     partially_paid→ paid, void
--     paid          → (terminal, no transitions)
--     void          → (terminal, no transitions)
--   Same-status updates always allowed.
--
-- Void Invoice Can Reopen: NO
--   void is a terminal state. No transitions out of void.
--
-- Paid Invoice Can Reopen: NO
--   paid is a terminal state. No transitions out of paid.
--
-- Draft → Issuing Still Works: YES
--   draft → issuing is the only allowed forward transition from draft.
--
-- Snapshot Locked After Draft: YES
--   protect_issued_invoice_fields() locks snapshot fields once OLD.status != 'draft'.
--   The draft→issuing transition window is the only time to finalize snapshots.
--
-- Line Items Locked After Draft: YES
--   protect_issued_invoice_line_items() blocks all INSERT/UPDATE/DELETE
--   once parent invoice status != 'draft'.
--
-- Payment Core Facts Immutable After received/failed/refunded: YES
--   protect_completed_payment_facts() locks:
--   invoice_id, payment_method, amount_cents, currency, received_at,
--   reference_number, provider, provider_payment_id
--   once OLD.status != 'pending'. No Admin or service_role bypass.
--   Operational metadata (notes, receipt_pdf_*, updated_at) remains updateable.
--
-- Payment service_role Bypass: NO
--   No bypass exists in protect_completed_payment_facts() or
--   validate_payment_status_transition().
--
-- Payment Status Transition Trigger Added: YES
--   guard_payment_status_transition fires BEFORE UPDATE OF status.
--   Allowed matrix:
--     pending  → received, failed
--     received → refunded
--     failed   → (terminal)
--     refunded → (terminal)
--   Same-status updates always allowed.
--
-- Payment amount_cents > 0: YES (CHECK constraint on crm_payments)
--
-- Invoice subtotal >= 0: YES (CHECK constraint on crm_invoices)
-- Invoice discount >= 0: YES (CHECK constraint on crm_invoices)
-- Invoice tax = 0: YES (CHECK constraint on crm_invoices)
-- Invoice total >= 0: YES (CHECK constraint on crm_invoices)
--
-- Line Item quantity > 0: YES (CHECK constraint on crm_invoice_line_items)
--
-- Replacement Requires Original = void: YES
--   validate_invoice_replacement_integrity() checks v_original_status = 'void'.
--   Raises integrity_constraint_violation if original is not voided.
--
-- All Prior Security Hardening Preserved: YES
--
-- Business Rows Changed: 0
-- Emails Sent: 0
-- PDFs Generated: 0
-- Coinflow Added: NO
--
-- Supabase Migration Required: YES
-- Safe To Push After Review: YES (pending review — do NOT push yet)
