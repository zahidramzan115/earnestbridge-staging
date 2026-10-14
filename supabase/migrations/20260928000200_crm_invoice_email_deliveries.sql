-- ============================================================
-- Migration: 20260928000200_crm_invoice_email_deliveries
--
-- Step 5E-1A — Invoice Email Delivery Schema Foundation
--
-- PURPOSE
-- -------
-- Creates a dedicated invoice-email delivery state table.
-- This is the canonical idempotency and delivery-state record
-- for invoice email sends. It is NOT a reuse of crm_email_log
-- or option_cycle_automation_log.
--
-- crm_email_log may later be used as a secondary communication
-- log, but the canonical delivery/idempotency state belongs here.
--
-- Normal invoices and revision invoices share this table because
-- each revision has its own crm_invoices.id. There is ONE canonical
-- "issued invoice email" delivery record per invoice (UNIQUE on invoice_id).
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Creates public.crm_invoice_email_deliveries
-- 2. Adds all required columns with correct types and constraints
-- 3. Adds TEXT + CHECK delivery_status constraint (not a PG enum)
-- 4. Adds UNIQUE(invoice_id) — one canonical delivery per invoice
-- 5. Adds UNIQUE(provider_idempotency_key) — provider dedupe
-- 6. Adds sent-state guards (sent_at + provider_message_id required when sent)
-- 7. Enables RLS with NO client/browser write policies
-- 8. Attaches the existing public.set_updated_at() trigger
-- 9. Adds a delivery_status index (justified below)
--
-- RLS DECISION
-- ------------
-- The Admin Invoice UI accesses invoice state through the existing
-- server API routes (/api/admin/invoices/[id]), not via direct browser
-- SELECT on this table. Therefore NO authenticated SELECT policy is
-- created. service_role bypasses RLS for all trusted server-side
-- operations. This matches the crm_email_attachments precedent
-- (RLS enabled, zero policies).
--
-- UPDATED_AT DECISION
-- -------------------
-- public.set_updated_at() already exists (created in
-- 20260411014854_borrower_applications.sql) and is reused by
-- crm_invoices, crm_contacts, crm_tasks, and others. It is the
-- project-wide canonical updated_at trigger function. Reusing it
-- here avoids unnecessary infrastructure duplication.
--
-- INDEX JUSTIFICATION
-- -------------------
-- UNIQUE(invoice_id) already provides an invoice lookup index.
-- UNIQUE(provider_idempotency_key) already provides its index.
-- An index on delivery_status IS added because the future retry
-- worker will query WHERE delivery_status IN ('pending','failed')
-- across all rows to find retryable deliveries. Without this index
-- that query would require a full table scan as the table grows.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- --------------------------------
-- Does NOT modify crm_invoices
-- Does NOT modify crm_email_log
-- Does NOT modify application_activity event types
-- Does NOT create delivery rows
-- Does NOT update existing invoices
-- Does NOT send email
-- Does NOT change invoice status
-- Does NOT change PDF state
-- Does NOT change CRM contacts
-- Does NOT alter existing email logs
-- Does NOT deploy Netlify
-- Does NOT push Supabase (review before pushing)
--
-- ZERO BUSINESS DATA MUTATION
-- ----------------------------
-- crm_invoice_email_deliveries rows created: 0
-- crm_invoices rows changed:                 0
-- crm_email_log rows changed:                0
-- application_activity rows changed:         0
-- emails sent:                               0
-- ============================================================


-- ─── 1. CREATE TABLE ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_invoice_email_deliveries (

  -- Primary key
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Invoice reference — one canonical delivery record per invoice
  -- ON DELETE RESTRICT: prevents deleting an invoice that has a delivery record
  invoice_id                UUID        NOT NULL
                                        REFERENCES public.crm_invoices(id)
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
  --             could not be persisted). The future retry logic must NOT
  --             blindly resend an 'uncertain' delivery.
  delivery_status           TEXT        NOT NULL
                                        DEFAULT 'pending'
                                        CONSTRAINT crm_invoice_email_deliveries_status_check
                                        CHECK (delivery_status IN (
                                          'pending',
                                          'sending',
                                          'sent',
                                          'failed',
                                          'uncertain'
                                        )),

  -- Recipient email address (snapshot at delivery record creation time)
  recipient_email           TEXT        NOT NULL
                                        CONSTRAINT crm_invoice_email_deliveries_recipient_nonempty
                                        CHECK (trim(recipient_email) <> ''),

  -- Email provider identifier
  provider                  TEXT        NOT NULL
                                        DEFAULT 'resend',

  -- Deterministic idempotency key passed to the provider as Idempotency-Key.
  -- Planned format: invoice-issued/{invoice_id}
  -- Generated by the server/RPC when the delivery record is created.
  -- The same key will eventually be passed to Resend as the HTTP Idempotency-Key.
  provider_idempotency_key  TEXT        NOT NULL
                                        CONSTRAINT crm_invoice_email_deliveries_idempotency_key_nonempty
                                        CHECK (trim(provider_idempotency_key) <> ''),

  -- Provider-assigned message ID (e.g. Resend email ID).
  -- Required when delivery_status = 'sent' (enforced by CHECK below).
  -- NULL for all other states.
  provider_message_id       TEXT        NULL,

  -- Number of send attempts made (>= 0)
  attempt_count             INTEGER     NOT NULL
                                        DEFAULT 0
                                        CONSTRAINT crm_invoice_email_deliveries_attempt_count_nonneg
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


-- ─── 2. CONSTRAINTS ──────────────────────────────────────────────────────────

-- ONE canonical issued-invoice email delivery per invoice
ALTER TABLE public.crm_invoice_email_deliveries
  ADD CONSTRAINT crm_invoice_email_deliveries_unique_invoice_id
  UNIQUE (invoice_id);

-- Provider idempotency key must also be globally unique
ALTER TABLE public.crm_invoice_email_deliveries
  ADD CONSTRAINT crm_invoice_email_deliveries_unique_idempotency_key
  UNIQUE (provider_idempotency_key);

-- Sent-state guards:
--   When delivery_status = 'sent':
--     sent_at must be NOT NULL
--     provider_message_id must be NOT NULL and non-blank
--   These are NOT required for any other state.
ALTER TABLE public.crm_invoice_email_deliveries
  ADD CONSTRAINT crm_invoice_email_deliveries_sent_state_requires_sent_at
  CHECK (
    delivery_status <> 'sent'
    OR sent_at IS NOT NULL
  );

ALTER TABLE public.crm_invoice_email_deliveries
  ADD CONSTRAINT crm_invoice_email_deliveries_sent_state_requires_message_id
  CHECK (
    delivery_status <> 'sent'
    OR (provider_message_id IS NOT NULL AND trim(provider_message_id) <> '')
  );


-- ─── 3. INDEXES ──────────────────────────────────────────────────────────────

-- UNIQUE(invoice_id) already provides an invoice lookup index.
-- UNIQUE(provider_idempotency_key) already provides its index.
--
-- delivery_status index: justified for future retry worker queries that
-- scan WHERE delivery_status IN ('pending', 'failed') across all rows.
-- Without this index the query would require a full table scan as the
-- table grows. The cardinality is low (5 values) but the access pattern
-- is a targeted filter, making a partial or full index on this column
-- worthwhile.
CREATE INDEX IF NOT EXISTS idx_crm_invoice_email_deliveries_status
  ON public.crm_invoice_email_deliveries(delivery_status);


-- ─── 4. UPDATED_AT TRIGGER ───────────────────────────────────────────────────
--
-- Reuses the existing project-wide public.set_updated_at() function
-- (first defined in 20260411014854_borrower_applications.sql).
-- This function is already used by crm_invoices, crm_contacts, crm_tasks,
-- and others. No new trigger function is created.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS crm_invoice_email_deliveries_updated_at
  ON public.crm_invoice_email_deliveries;

CREATE TRIGGER crm_invoice_email_deliveries_updated_at
  BEFORE UPDATE ON public.crm_invoice_email_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- ─── 5. ROW LEVEL SECURITY ───────────────────────────────────────────────────
--
-- RLS is enabled.
--
-- The browser/client must NOT be able to INSERT, UPDATE, or DELETE rows.
-- No borrower/client policies are created.
-- No direct authenticated write policies are created.
--
-- RLS SELECT policy decision:
--   The Admin Invoice UI accesses invoice email delivery state through
--   the existing server API routes (/api/admin/invoices/[id]), not via
--   direct browser SELECT on this table. No authenticated SELECT policy
--   is therefore required at this time. This matches the crm_email_attachments
--   precedent (RLS enabled, zero policies in the foundation migration).
--
--   If a future Admin UI feature requires a direct browser SELECT (e.g. a
--   real-time delivery status widget), a SELECT policy using
--   public.is_admin_user() should be added in a subsequent migration.
--
-- All current and future writes are performed by trusted server routes
-- and controlled RPCs using service_role, which bypasses RLS entirely.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.crm_invoice_email_deliveries ENABLE ROW LEVEL SECURITY;

-- No policies created in this migration.
-- service_role bypasses RLS for all trusted server-side operations.
-- Direct client/browser policies will be added only when a specific
-- server-validated access pattern is designed and reviewed.
