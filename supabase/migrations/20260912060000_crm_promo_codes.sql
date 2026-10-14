-- ============================================================
-- CRM Promo Codes Table
-- Generic promo/discount code table for CRM campaigns.
-- First use: BPCON26 conference promo.
-- ============================================================

-- ─── TABLE ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_promo_codes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign          TEXT        NOT NULL,
  promo_code        TEXT        NOT NULL,
  crm_contact_id    UUID        REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  email             TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'claimed',
  discount_type     TEXT        NOT NULL DEFAULT 'fixed_amount',
  discount_amount   NUMERIC(10,2),
  original_fee      NUMERIC(10,2),
  claimed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_resent_at    TIMESTAMPTZ,
  redeemed_at       TIMESTAMPTZ,
  redeemed_deal_id  UUID,
  voided_at         TIMESTAMPTZ,
  landing_page      TEXT,
  referrer          TEXT,
  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  utm_content       TEXT,
  utm_term          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── UNIQUE CONSTRAINTS ───────────────────────────────────────────────────────

-- Promo codes must be globally unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_promo_codes_unique_code
  ON public.crm_promo_codes(promo_code);

-- One non-voided promo per campaign per normalized email
-- Prevents race-condition duplicates at the database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_promo_codes_one_per_email_campaign
  ON public.crm_promo_codes(campaign, lower(trim(email)))
  WHERE voided_at IS NULL;

-- ─── INDEXES ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_crm_promo_codes_contact
  ON public.crm_promo_codes(crm_contact_id);

CREATE INDEX IF NOT EXISTS idx_crm_promo_codes_email
  ON public.crm_promo_codes(lower(trim(email)));

CREATE INDEX IF NOT EXISTS idx_crm_promo_codes_campaign
  ON public.crm_promo_codes(campaign);

CREATE INDEX IF NOT EXISTS idx_crm_promo_codes_status
  ON public.crm_promo_codes(status);

CREATE INDEX IF NOT EXISTS idx_crm_promo_codes_created
  ON public.crm_promo_codes(created_at DESC);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.crm_promo_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_promo_codes" ON public.crm_promo_codes;
CREATE POLICY "admins_all_crm_promo_codes"
  ON public.crm_promo_codes FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- ─── UPDATED_AT TRIGGER ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_promo_codes_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_promo_codes_updated_at ON public.crm_promo_codes;
CREATE TRIGGER trg_crm_promo_codes_updated_at
  BEFORE UPDATE ON public.crm_promo_codes
  FOR EACH ROW EXECUTE FUNCTION public.crm_promo_codes_set_updated_at();
