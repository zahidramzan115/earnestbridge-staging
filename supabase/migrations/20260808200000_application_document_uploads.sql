-- ============================================================
-- Application Document Uploads
-- Allows borrowers and admins to upload free-form documents
-- tied to an application, with full audit trail logging
-- ============================================================

-- 1. Create application_documents table for free-form uploads
CREATE TABLE IF NOT EXISTS public.application_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL REFERENCES public.borrower_applications(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL,
    uploaded_by_role TEXT NOT NULL DEFAULT 'borrower', -- 'borrower' | 'admin'
    uploader_email  TEXT,
    document_name   TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    file_url        TEXT,
    storage_path    TEXT,
    file_size       BIGINT,
    mime_type       TEXT,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_app_docs_application_id ON public.application_documents(application_id);
CREATE INDEX IF NOT EXISTS idx_app_docs_user_id        ON public.application_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_app_docs_created_at     ON public.application_documents(created_at DESC);

-- 3. Updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_application_documents_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_application_documents_updated_at ON public.application_documents;
CREATE TRIGGER update_application_documents_updated_at
    BEFORE UPDATE ON public.application_documents
    FOR EACH ROW
    EXECUTE FUNCTION public.update_application_documents_updated_at();

-- 4. Enable RLS
ALTER TABLE public.application_documents ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies

-- Borrowers can manage their own uploads
DROP POLICY IF EXISTS "borrowers_manage_own_app_documents" ON public.application_documents;
CREATE POLICY "borrowers_manage_own_app_documents"
ON public.application_documents
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Borrowers can view admin-uploaded docs for their applications
DROP POLICY IF EXISTS "borrowers_view_admin_app_documents" ON public.application_documents;
CREATE POLICY "borrowers_view_admin_app_documents"
ON public.application_documents
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.borrower_applications ba
        WHERE ba.id = application_id
        AND ba.user_id = auth.uid()
    )
);

-- Admins have full access
DROP POLICY IF EXISTS "admin_full_access_app_documents" ON public.application_documents;
CREATE POLICY "admin_full_access_app_documents"
ON public.application_documents
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM auth.users au
        WHERE au.id = auth.uid()
        AND (au.raw_user_meta_data->>'role' = 'admin' OR au.raw_app_meta_data->>'role' = 'admin')
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM auth.users au
        WHERE au.id = auth.uid()
        AND (au.raw_user_meta_data->>'role' = 'admin' OR au.raw_app_meta_data->>'role' = 'admin')
    )
);

-- 6. Allow borrowers to insert their own audit log entries for document actions
-- Note: enum values 'document_upload' and 'document_download' were added in
-- migration 20260808100000_audit_enum_extensions.sql (committed before this runs)
DROP POLICY IF EXISTS "borrowers_insert_document_audit_logs" ON public.audit_logs;
CREATE POLICY "borrowers_insert_document_audit_logs"
ON public.audit_logs
FOR INSERT
TO authenticated
WITH CHECK (
    admin_id = auth.uid()
    AND event_type::text IN ('document_upload', 'document_download', 'document_access')
);
