-- ============================================================
-- Migration: crm_deal_deadlines
-- Timestamp: 20260915003000
--
-- PURPOSE
-- -------
-- Create the crm_deal_deadlines table for tracking custom Deal
-- deadlines (EMD due, document due, funding, option, inspection,
-- custom). Closing Date remains canonical on borrower_applications
-- and is NOT duplicated here.
--
-- SCOPE
-- -----
-- 1. crm_deal_deadlines table with all required fields
-- 2. CHECK constraints for deadline_type, responsible_party, status
-- 3. Indexes on application_id and (status, due_date)
-- 4. updated_at trigger
-- 5. RLS: Admin full access, NO borrower access (Admin-only for Step 5B)
--    Borrower client-facing access will be added in Step 5C via a
--    safe view that excludes the internal `notes` field.
-- 6. Additive application_activity event types for deadline events
--
-- NOTES ON BORROWER ACCESS
-- ------------------------
-- Borrowers have NO SELECT policy on crm_deal_deadlines in this step.
-- The `notes` field is internal Admin context and must not be exposed
-- to borrowers. When client-facing deadline UI is built in Step 5C,
-- a view (e.g. crm_deal_deadlines_client_view) will expose only
-- safe columns (id, application_id, title, deadline_type, due_date,
-- responsible_party, client_visible) with its own RLS, ensuring
-- `notes` is never accessible to borrower sessions.
--
-- ADMIN MUTATION AUTHORIZATION
-- ----------------------------
-- All mutations go through /api/admin/deadlines which uses:
--   1. createServerClient with cookie-based session (authenticated Admin)
--   2. requireAdmin() check (user_metadata.role === 'admin')
--   3. RLS on crm_deal_deadlines enforces is_admin_user() for all ops
-- Service-role is NOT used from the browser.
-- ============================================================


-- ─── 1. crm_deal_deadlines TABLE ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_deal_deadlines (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid        NOT NULL
                                REFERENCES public.borrower_applications(id)
                                ON DELETE CASCADE,
  title             text        NOT NULL,
  deadline_type     text        NOT NULL
                                CHECK (deadline_type IN (
                                  'emd_due',
                                  'document_due',
                                  'funding',
                                  'option',
                                  'inspection',
                                  'custom'
                                )),
  due_date          date        NOT NULL,
  responsible_party text        NOT NULL
                                CHECK (responsible_party IN (
                                  'client',
                                  'earnestbridge',
                                  'third_party'
                                )),
  client_visible    boolean     NOT NULL DEFAULT false,
  status            text        NOT NULL DEFAULT 'open'
                                CHECK (status IN (
                                  'open',
                                  'completed',
                                  'cancelled'
                                )),
  notes             text,
  created_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at      timestamptz,
  completed_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ─── 2. INDEXES ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_crm_deal_deadlines_application_id
  ON public.crm_deal_deadlines(application_id);

CREATE INDEX IF NOT EXISTS idx_crm_deal_deadlines_status_due_date
  ON public.crm_deal_deadlines(status, due_date);

-- ─── 3. updated_at TRIGGER ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_crm_deal_deadlines_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_deal_deadlines_updated_at ON public.crm_deal_deadlines;
CREATE TRIGGER trg_crm_deal_deadlines_updated_at
  BEFORE UPDATE ON public.crm_deal_deadlines
  FOR EACH ROW
  EXECUTE FUNCTION public.set_crm_deal_deadlines_updated_at();

-- ─── 4. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.crm_deal_deadlines ENABLE ROW LEVEL SECURITY;

-- Admin: full access (SELECT, INSERT, UPDATE, DELETE)
DROP POLICY IF EXISTS "admins_all_crm_deal_deadlines" ON public.crm_deal_deadlines;
CREATE POLICY "admins_all_crm_deal_deadlines"
  ON public.crm_deal_deadlines
  FOR ALL
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- NOTE: No borrower SELECT policy in Step 5B.
-- Borrowers have zero access to this table until Step 5C adds a safe
-- view that excludes the internal `notes` field.

-- ─── 5. EXTEND application_activity event_type CHECK ─────────────────────────
-- Add deadline event types additively. All existing values are preserved.
-- Current allowed values (from 20260913030000_document_versioning_review.sql):
--   status_change, document_upload, admin_note, deadline_shift, system,
--   document_revision_uploaded, revision_requested, document_approved,
--   owner_assigned, task_created, email_sent, call_logged

ALTER TABLE public.application_activity
  DROP CONSTRAINT IF EXISTS application_activity_event_type_check;

ALTER TABLE public.application_activity
  ADD CONSTRAINT application_activity_event_type_check
  CHECK (event_type = ANY (ARRAY[
    -- Original 5 values (preserved exactly)
    'status_change',
    'document_upload',
    'admin_note',
    'deadline_shift',
    'system',
    -- Document versioning workflow (Step 3A)
    'document_revision_uploaded',
    'revision_requested',
    'document_approved',
    -- Already written by existing UI code (owner/task/email/call)
    'owner_assigned',
    'task_created',
    'email_sent',
    'call_logged',
    -- Deal deadline events (Step 5B — new)
    'deadline_created',
    'deadline_updated',
    'deadline_completed',
    'deadline_cancelled',
    'deadline_reopened'
  ]));
