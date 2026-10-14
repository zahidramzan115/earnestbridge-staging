-- ============================================================
-- Migration: 20260922000000_crm_email_attachments_foundation
--
-- Step 6A-4.5B — Email Attachment & Audit Schema Foundation
--
-- PURPOSE
-- -------
-- Additive schema foundation for CRM email attachments.
-- This migration creates:
--   1. A private email-attachments Supabase Storage bucket
--      (no storage policies — all access via trusted server routes)
--   2. public.crm_email_attachments table with FK to crm_email_log.id
--   3. RLS enabled on crm_email_attachments with NO client policies
--
-- PRE-CONDITIONS VERIFIED
-- -----------------------
-- crm_email_log.id  = UUID PRIMARY KEY DEFAULT gen_random_uuid()
-- crm_email_log RLS = ENABLED
-- crm_email_log policy = admins_all_crm_email_log (admin only)
-- email-attachments bucket = does NOT yet exist
-- crm_email_attachments table = does NOT yet exist
--
-- WHAT THIS MIGRATION DOES NOT DO
-- --------------------------------
-- Does NOT modify crm_email_log
-- Does NOT modify crm_activities or application_activity
-- Does NOT modify the Resend Edge Function
-- Does NOT create storage policies (bucket is hardened private)
-- Does NOT create application_id on crm_email_log
-- Does NOT store long-lived signed URLs
-- Does NOT create any business data rows
-- Does NOT send emails
-- Does NOT push to production (review before pushing)
--
-- ZERO BUSINESS DATA MUTATION
-- ----------------------------
-- crm_email_log rows created:    0
-- crm_email_attachments rows:    0
-- storage objects created:       0
-- crm_activities rows:           0
-- emails sent:                   0
-- ============================================================

-- ─── 1. PRIVATE email-attachments STORAGE BUCKET ─────────────────────────────
--
-- Requirements:
--   public = false
--   file_size_limit = 5 MB (5242880 bytes)
--   allowed_mime_types = business document types only
--   No executables, scripts, HTML, SVG, ZIP archives
--
-- Access model: hardened private (same as invoice-pdfs).
-- NO authenticated direct browser policies.
-- NO admin INSERT/UPDATE/DELETE/SELECT storage policies.
-- NO client policies.
-- NO anonymous policies.
-- All future upload/download operations go through authenticated
-- server routes using trusted server credentials (service_role).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'email-attachments',
  'email-attachments',
  false,
  5242880,
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'image/jpeg',
    'image/png'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ─── 2. crm_email_attachments TABLE ──────────────────────────────────────────
--
-- Stores metadata for files attached to outbound CRM emails.
-- One row per file per email log entry.
-- email_log_id FK type = UUID, matching crm_email_log.id exactly.
-- storage_path references the private email-attachments bucket object path.
-- No long-lived signed URL stored — server generates authorized access on demand.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_email_attachments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK must exactly match crm_email_log.id type (UUID)
  email_log_id     UUID        NOT NULL
                               REFERENCES public.crm_email_log(id)
                               ON DELETE CASCADE,

  -- Path within the email-attachments bucket (no signed URL stored)
  storage_path     TEXT        NOT NULL
                               CONSTRAINT crm_email_attachments_storage_path_nonempty
                               CHECK (storage_path <> ''),

  original_filename TEXT       NOT NULL
                               CONSTRAINT crm_email_attachments_original_filename_nonempty
                               CHECK (original_filename <> ''),

  mime_type        TEXT        NOT NULL
                               CONSTRAINT crm_email_attachments_mime_type_nonempty
                               CHECK (mime_type <> ''),

  size_bytes       BIGINT      NOT NULL
                               CONSTRAINT crm_email_attachments_size_bytes_positive
                               CHECK (size_bytes > 0),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 3. INDEXES ──────────────────────────────────────────────────────────────

-- Primary lookup: all attachments for a given email log entry
CREATE INDEX IF NOT EXISTS idx_crm_email_attachments_email_log_id
  ON public.crm_email_attachments(email_log_id);

-- ─── 4. UNIQUENESS CONSTRAINT ────────────────────────────────────────────────
--
-- Prevent duplicate attachment references within the same email log entry.
-- A given storage_path should appear at most once per email_log_id.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.crm_email_attachments
  ADD CONSTRAINT crm_email_attachments_unique_email_log_storage_path
  UNIQUE (email_log_id, storage_path);

-- ─── 5. ENABLE ROW LEVEL SECURITY ────────────────────────────────────────────
--
-- RLS is enabled.
-- For this phase: NO direct browser/client policies.
-- Admin application code will access attachment metadata through secure
-- server routes. service_role performs trusted server-side operations.
-- No public access. No client access. No anonymous access.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.crm_email_attachments ENABLE ROW LEVEL SECURITY;

-- No policies created in this migration.
-- service_role bypasses RLS and will be used for all server-side operations.
-- Direct client/browser policies will be added only when a specific
-- server-validated access pattern is designed and reviewed.
