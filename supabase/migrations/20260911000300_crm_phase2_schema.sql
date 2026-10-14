-- ============================================================
-- CRM Phase 2 Schema Extensions
-- Adds: estimated_emd_amount, target_closing_date, promo_code
-- to submissions; duplicate detection columns; email comms log;
-- merge audit; deal contact portal visibility index.
-- Safe, backwards-compatible, additive only.
-- ============================================================

-- ─── EXTEND crm_contact_submissions ──────────────────────────────────────────

ALTER TABLE public.crm_contact_submissions
  ADD COLUMN IF NOT EXISTS estimated_emd_amount  NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS target_closing_date   DATE,
  ADD COLUMN IF NOT EXISTS promo_code_used       TEXT;

-- ─── EXTEND crm_contacts for duplicate tracking ───────────────────────────────

ALTER TABLE public.crm_contacts
  ADD COLUMN IF NOT EXISTS duplicate_of_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS has_potential_duplicate BOOLEAN NOT NULL DEFAULT false;

-- ─── CRM EMAIL COMMUNICATIONS LOG ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_email_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  sent_by         TEXT NOT NULL DEFAULT 'Admin',
  sent_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  to_email        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  delivery_status TEXT DEFAULT 'sent',
  resend_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_email_log_contact ON public.crm_email_log(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_email_log_created ON public.crm_email_log(created_at DESC);

ALTER TABLE public.crm_email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_crm_email_log" ON public.crm_email_log;
CREATE POLICY "admins_all_crm_email_log"
  ON public.crm_email_log FOR ALL TO authenticated
  USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

-- ─── ADDITIONAL ACTIVITY EVENT TYPES (no schema change needed, just docs) ────
-- New event_type values used in phase 2:
--   contact_merged, alternate_email_added, alternate_email_removed,
--   company_assigned, company_changed, deal_associated, deal_removed,
--   email_sent, portal_relationship_updated, duplicate_flagged

-- ─── INDEX: borrower_applications portal visibility ──────────────────────────
-- Ensure portal users can efficiently query their deals via contact link

CREATE INDEX IF NOT EXISTS idx_crm_deal_contacts_contact_role
  ON public.crm_deal_contacts(contact_id, role);

-- ─── FUNCTION: merge_crm_contacts ────────────────────────────────────────────
-- Merges source_id INTO target_id (surviving contact).
-- Reassigns all related records to target, marks source as merged.

CREATE OR REPLACE FUNCTION public.merge_crm_contacts(
  p_target_id UUID,
  p_source_id UUID,
  p_admin_actor TEXT DEFAULT 'Admin'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  source_rec RECORD;
  target_rec RECORD;
BEGIN
  -- Validate
  IF p_target_id = p_source_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot merge a contact with itself');
  END IF;

  SELECT * INTO source_rec FROM public.crm_contacts WHERE id = p_source_id AND is_merged = false;
  SELECT * INTO target_rec FROM public.crm_contacts WHERE id = p_target_id AND is_merged = false;

  IF source_rec IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Source contact not found or already merged');
  END IF;
  IF target_rec IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Target contact not found');
  END IF;

  -- Reassign alternate emails (avoid unique constraint violations)
  UPDATE public.crm_contact_emails
  SET contact_id = p_target_id, is_primary = false
  WHERE contact_id = p_source_id
    AND lower(trim(email)) NOT IN (
      SELECT lower(trim(email)) FROM public.crm_contact_emails WHERE contact_id = p_target_id
    );

  -- Add source primary email as alternate on target (if not already there)
  INSERT INTO public.crm_contact_emails (contact_id, email, label, is_primary, source)
  VALUES (p_target_id, source_rec.primary_email, 'merged', false, 'Contact Merge')
  ON CONFLICT (lower(trim(email))) DO NOTHING;

  -- Reassign submissions
  UPDATE public.crm_contact_submissions SET contact_id = p_target_id WHERE contact_id = p_source_id;

  -- Reassign activities
  UPDATE public.crm_activities SET contact_id = p_target_id WHERE contact_id = p_source_id;

  -- Reassign tasks
  UPDATE public.crm_tasks SET contact_id = p_target_id WHERE contact_id = p_source_id;

  -- Reassign deal contacts (avoid duplicates)
  UPDATE public.crm_deal_contacts SET contact_id = p_target_id
  WHERE contact_id = p_source_id
    AND deal_id NOT IN (
      SELECT deal_id FROM public.crm_deal_contacts WHERE contact_id = p_target_id
    );
  -- Remove any remaining (duplicate deal associations)
  DELETE FROM public.crm_deal_contacts WHERE contact_id = p_source_id;

  -- Transfer portal user link if target has none
  IF target_rec.portal_user_id IS NULL AND source_rec.portal_user_id IS NOT NULL THEN
    UPDATE public.crm_contacts
    SET portal_user_id = source_rec.portal_user_id,
        portal_link_status = source_rec.portal_link_status,
        portal_linked_at = source_rec.portal_linked_at,
        portal_approved_at = source_rec.portal_approved_at
    WHERE id = p_target_id;
  END IF;

  -- Transfer original attribution if target has none
  IF target_rec.original_lead_source IS NULL AND source_rec.original_lead_source IS NOT NULL THEN
    UPDATE public.crm_contacts
    SET original_lead_source = source_rec.original_lead_source,
        original_campaign = source_rec.original_campaign
    WHERE id = p_target_id;
  END IF;

  -- Mark source as merged
  UPDATE public.crm_contacts
  SET is_merged = true,
      merged_into_id = p_target_id,
      updated_at = now()
  WHERE id = p_source_id;

  -- Log merge activity on target
  INSERT INTO public.crm_activities (
    contact_id, event_type, title, detail, actor
  ) VALUES (
    p_target_id,
    'contact_merged',
    'Contact merged: ' || source_rec.first_name || ' ' || source_rec.last_name || ' → ' || target_rec.first_name || ' ' || target_rec.last_name,
    'Merged contact ID ' || p_source_id || ' (email: ' || source_rec.primary_email || ') into this contact. Performed by: ' || p_admin_actor,
    p_admin_actor
  );

  RETURN jsonb_build_object('success', true, 'target_id', p_target_id, 'source_id', p_source_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
