-- Executed PSA (PDF) uploaded by Admin on the document source of truth.
-- One current PSA per deal; uploading again replaces it. It is used as
-- Exhibit A for the Option Agreement and the Written Action.
--
-- The file lives in the private borrower-documents bucket under psa/{dealId}/.
-- Only server routes (service role) write this table; Admins may read it.

BEGIN;

CREATE TABLE IF NOT EXISTS public.deal_psa_files (
  application_id  UUID PRIMARY KEY
    REFERENCES public.borrower_applications(id) ON DELETE CASCADE,
  storage_path    TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_size       BIGINT NOT NULL CHECK (file_size > 0),
  uploaded_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.deal_psa_files ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.deal_psa_files FROM anon, authenticated;
GRANT SELECT ON public.deal_psa_files TO authenticated;

DROP POLICY IF EXISTS deal_psa_files_admin_select ON public.deal_psa_files;
CREATE POLICY deal_psa_files_admin_select
  ON public.deal_psa_files
  FOR SELECT TO authenticated
  USING (public.is_admin_user());

COMMIT;
