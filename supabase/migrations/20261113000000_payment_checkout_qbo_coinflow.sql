-- ============================================================
-- Branded checkout: QuickBooks Online + Coinflow
-- ============================================================
-- Adds five NEW tables for the generic /payment page.
-- No existing table, function, or policy is changed.
--
--   1. qbo_connections          QuickBooks OAuth connection (encrypted tokens)
--   2. payment_checkouts        One row per checkout attempt
--   3. payment_webhook_events   Coinflow webhook events (dedup by event id)
--   4. payment_sync_log         QuickBooks sync / receipt / admin retry history
--   5. payment_lookup_attempts  Invoice lookup attempts (rate limiting)
--
-- Access model:
--   * The public /payment page never reads these tables directly.
--     All reads and writes go through server routes using the
--     service role key.
--   * anon: no access.
--   * authenticated: SELECT only, and only admins (is_admin_user())
--     on checkouts, webhook events and sync log.
--   * qbo_connections and payment_lookup_attempts: service role only.
--   * No card numbers or CVV are stored anywhere. Card data goes
--     straight from the browser to Coinflow.
--
-- Amounts are integer cents (21600 = $216.00).
-- ============================================================

BEGIN;

-- ── Shared updated_at trigger function ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payment_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $func$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$func$;


-- ============================================================
-- 1. qbo_connections
-- ============================================================

CREATE TABLE IF NOT EXISTS public.qbo_connections (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment               TEXT NOT NULL
    CHECK (environment IN ('sandbox', 'production')),
  realm_id                  TEXT NOT NULL,
  company_name              TEXT,

  -- Encrypted by the app (AES-256-GCM, key in QBO_TOKEN_ENCRYPTION_KEY).
  access_token_encrypted    TEXT NOT NULL,
  refresh_token_encrypted   TEXT NOT NULL,
  access_token_expires_at   TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at  TIMESTAMPTZ NOT NULL,

  status                    TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disconnected', 'error')),
  last_refreshed_at         TIMESTAMPTZ,
  last_error                TEXT,

  connected_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at           TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT qbo_connections_env_realm_unique UNIQUE (environment, realm_id)
);

-- Only one active connection per environment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qbo_connections_one_active
  ON public.qbo_connections (environment)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_qbo_connections_updated_at ON public.qbo_connections;
CREATE TRIGGER trg_qbo_connections_updated_at
  BEFORE UPDATE ON public.qbo_connections
  FOR EACH ROW EXECUTE FUNCTION public.payment_set_updated_at();


-- ============================================================
-- 2. payment_checkouts
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payment_checkouts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  status                    TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN (
      'verified',     -- invoice verified, payment not started
      'processing',   -- sent to Coinflow, awaiting result
      'settled',      -- Coinflow confirmed settlement (webhook)
      'declined',     -- card declined
      'failed',       -- other payment error
      'expired',      -- verification too old, not paid
      'cancelled',    -- abandoned / superseded
      'refunded',     -- refunded after settlement
      'disputed'      -- chargeback opened
    )),

  -- QuickBooks invoice snapshot (taken at verification)
  qbo_environment           TEXT NOT NULL
    CHECK (qbo_environment IN ('sandbox', 'production')),
  qbo_realm_id              TEXT NOT NULL,
  qbo_invoice_id            TEXT NOT NULL,
  qbo_invoice_number        TEXT NOT NULL,
  qbo_customer_id           TEXT NOT NULL,
  qbo_customer_name         TEXT,
  invoice_description       TEXT,
  currency                  TEXT NOT NULL DEFAULT 'USD'
    CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_total_cents       BIGINT NOT NULL CHECK (invoice_total_cents >= 0),
  amount_due_cents          BIGINT NOT NULL CHECK (amount_due_cents > 0),
  verified_by               TEXT NOT NULL
    CHECK (verified_by IN ('email', 'name')),
  verification_expires_at   TIMESTAMPTZ NOT NULL,

  -- Payer details (no card data)
  payer_first_name          TEXT,
  payer_last_name           TEXT,
  payer_email               TEXT,
  payer_phone               TEXT,
  billing_address           JSONB,

  -- Terms & Conditions acceptance
  terms_accepted_at         TIMESTAMPTZ,
  terms_version             TEXT,

  -- Coinflow
  coinflow_payment_id       TEXT,
  coinflow_status           TEXT,
  coinflow_subtotal_cents   BIGINT,
  coinflow_fees_cents       BIGINT,
  coinflow_total_cents      BIGINT,
  card_brand                TEXT,
  card_last4                TEXT CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  failure_code              TEXT,
  failure_message           TEXT,
  processing_started_at     TIMESTAMPTZ,
  settled_at                TIMESTAMPTZ,

  -- QuickBooks payment sync
  qbo_sync_status           TEXT NOT NULL DEFAULT 'not_started'
    CHECK (qbo_sync_status IN ('not_started', 'pending', 'synced', 'failed', 'needs_review')),
  qbo_payment_id            TEXT,
  qbo_synced_at             TIMESTAMPTZ,
  qbo_sync_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (qbo_sync_attempts >= 0),
  qbo_next_retry_at         TIMESTAMPTZ,
  qbo_last_error            TEXT,

  -- Receipt email (sent once)
  receipt_status            TEXT NOT NULL DEFAULT 'not_sent'
    CHECK (receipt_status IN ('not_sent', 'sending', 'sent', 'failed')),
  receipt_sent_at           TIMESTAMPTZ,
  receipt_provider_id       TEXT,
  receipt_error             TEXT,

  -- Request context (hashed IP only)
  ip_hash                   TEXT,
  user_agent                TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_checkouts_settled_has_time
    CHECK (status <> 'settled' OR settled_at IS NOT NULL),
  CONSTRAINT payment_checkouts_synced_has_payment
    CHECK (qbo_sync_status <> 'synced' OR qbo_payment_id IS NOT NULL)
);

-- One Coinflow payment maps to one checkout; one QBO payment to one checkout.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_checkouts_coinflow_payment_id
  ON public.payment_checkouts (coinflow_payment_id)
  WHERE coinflow_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_checkouts_qbo_payment_id
  ON public.payment_checkouts (qbo_realm_id, qbo_payment_id)
  WHERE qbo_payment_id IS NOT NULL;

-- Double-charge guard: at most one in-flight or settled checkout per invoice.
-- A refunded or disputed checkout frees the invoice again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_checkouts_one_active_per_invoice
  ON public.payment_checkouts (qbo_realm_id, qbo_invoice_id)
  WHERE status IN ('processing', 'settled');

CREATE INDEX IF NOT EXISTS idx_payment_checkouts_created_at
  ON public.payment_checkouts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_checkouts_status
  ON public.payment_checkouts (status);

CREATE INDEX IF NOT EXISTS idx_payment_checkouts_invoice_number
  ON public.payment_checkouts (qbo_invoice_number);

CREATE INDEX IF NOT EXISTS idx_payment_checkouts_sync_queue
  ON public.payment_checkouts (qbo_next_retry_at)
  WHERE qbo_sync_status IN ('pending', 'failed');

DROP TRIGGER IF EXISTS trg_payment_checkouts_updated_at ON public.payment_checkouts;
CREATE TRIGGER trg_payment_checkouts_updated_at
  BEFORE UPDATE ON public.payment_checkouts
  FOR EACH ROW EXECUTE FUNCTION public.payment_set_updated_at();


-- ============================================================
-- 3. payment_webhook_events
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                  TEXT NOT NULL DEFAULT 'coinflow'
    CHECK (provider IN ('coinflow')),
  -- Provider event id, or a hash of the payload when none is supplied.
  event_id                  TEXT NOT NULL,
  event_type                TEXT,
  checkout_id               UUID REFERENCES public.payment_checkouts(id) ON DELETE SET NULL,
  coinflow_payment_id       TEXT,
  signature_valid           BOOLEAN NOT NULL DEFAULT false,
  payload                   JSONB NOT NULL,

  processing_status         TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  processing_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  processed_at              TIMESTAMPTZ,
  error_message             TEXT,

  received_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_webhook_events_provider_event_unique UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_checkout
  ON public.payment_webhook_events (checkout_id);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_coinflow_payment
  ON public.payment_webhook_events (coinflow_payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_received_at
  ON public.payment_webhook_events (received_at DESC);


-- ============================================================
-- 4. payment_sync_log
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payment_sync_log (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id               UUID NOT NULL
    REFERENCES public.payment_checkouts(id) ON DELETE RESTRICT,
  action                    TEXT NOT NULL
    CHECK (action IN (
      'qbo_payment_create',
      'qbo_invoice_check',
      'receipt_email',
      'status_change',
      'admin_retry',
      'refund_flag'
    )),
  attempt_number            INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  result                    TEXT NOT NULL
    CHECK (result IN ('success', 'error', 'skipped')),
  error_message             TEXT,
  details                   JSONB,
  triggered_by              TEXT NOT NULL DEFAULT 'system'
    CHECK (triggered_by IN ('system', 'webhook', 'admin')),
  triggered_by_user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_sync_log_checkout
  ON public.payment_sync_log (checkout_id, created_at DESC);


-- ============================================================
-- 5. payment_lookup_attempts
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payment_lookup_attempts (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash                   TEXT NOT NULL,
  invoice_number            TEXT,
  result                    TEXT NOT NULL
    CHECK (result IN (
      'verified',
      'not_found',
      'mismatch',
      'already_paid',
      'ineligible',
      'rate_limited',
      'captcha_failed',
      'error'
    )),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_lookup_attempts_ip
  ON public.payment_lookup_attempts (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_lookup_attempts_invoice
  ON public.payment_lookup_attempts (invoice_number, created_at DESC);


-- ============================================================
-- Row Level Security and grants
-- ============================================================

ALTER TABLE public.qbo_connections          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_checkouts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_sync_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_lookup_attempts  ENABLE ROW LEVEL SECURITY;

-- Remove the default Supabase grants; add back only what is needed.
REVOKE ALL ON public.qbo_connections          FROM anon, authenticated;
REVOKE ALL ON public.payment_checkouts        FROM anon, authenticated;
REVOKE ALL ON public.payment_webhook_events   FROM anon, authenticated;
REVOKE ALL ON public.payment_sync_log         FROM anon, authenticated;
REVOKE ALL ON public.payment_lookup_attempts  FROM anon, authenticated;

-- Admins may read checkouts, webhook events and the sync log.
GRANT SELECT ON public.payment_checkouts      TO authenticated;
GRANT SELECT ON public.payment_webhook_events TO authenticated;
GRANT SELECT ON public.payment_sync_log       TO authenticated;

DROP POLICY IF EXISTS payment_checkouts_admin_select ON public.payment_checkouts;
CREATE POLICY payment_checkouts_admin_select
  ON public.payment_checkouts
  FOR SELECT TO authenticated
  USING (public.is_admin_user());

DROP POLICY IF EXISTS payment_webhook_events_admin_select ON public.payment_webhook_events;
CREATE POLICY payment_webhook_events_admin_select
  ON public.payment_webhook_events
  FOR SELECT TO authenticated
  USING (public.is_admin_user());

DROP POLICY IF EXISTS payment_sync_log_admin_select ON public.payment_sync_log;
CREATE POLICY payment_sync_log_admin_select
  ON public.payment_sync_log
  FOR SELECT TO authenticated
  USING (public.is_admin_user());

-- qbo_connections and payment_lookup_attempts: no policies.
-- With RLS on and grants revoked, only the service role can use them.

COMMIT;
