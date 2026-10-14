-- ============================================================
-- Borrower Documents Module
-- ============================================================

-- 1. ENUM types
DROP TYPE IF EXISTS public.document_status CASCADE;
CREATE TYPE public.document_status AS ENUM ('pending', 'uploaded', 'approved', 'rejected', 'expired', 'resubmit_requested');

DROP TYPE IF EXISTS public.document_category CASCADE;
CREATE TYPE public.document_category AS ENUM ('identity', 'financial', 'property', 'legal', 'other');

-- 2. Core table
CREATE TABLE IF NOT EXISTS public.borrower_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    application_id UUID REFERENCES public.borrower_applications(id) ON DELETE SET NULL,
    document_name TEXT NOT NULL,
    document_type TEXT NOT NULL,
    category public.document_category DEFAULT 'other'::public.document_category,
    file_url TEXT,
    file_name TEXT,
    file_size BIGINT,
    mime_type TEXT,
    doc_status public.document_status DEFAULT 'pending'::public.document_status,
    expiration_date DATE,
    admin_notes TEXT,
    resubmit_reason TEXT,
    resubmit_requested_at TIMESTAMPTZ,
    uploaded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_borrower_documents_user_id ON public.borrower_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_borrower_documents_application_id ON public.borrower_documents(application_id);
CREATE INDEX IF NOT EXISTS idx_borrower_documents_status ON public.borrower_documents(doc_status);

-- 4. Updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_borrower_documents_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

-- 5. Enable RLS
ALTER TABLE public.borrower_documents ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies
DROP POLICY IF EXISTS "borrowers_manage_own_documents" ON public.borrower_documents;
CREATE POLICY "borrowers_manage_own_documents"
ON public.borrower_documents
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "admin_full_access_documents" ON public.borrower_documents;
CREATE POLICY "admin_full_access_documents"
ON public.borrower_documents
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

-- 7. Trigger
DROP TRIGGER IF EXISTS update_borrower_documents_updated_at ON public.borrower_documents;
CREATE TRIGGER update_borrower_documents_updated_at
    BEFORE UPDATE ON public.borrower_documents
    FOR EACH ROW
    EXECUTE FUNCTION public.update_borrower_documents_updated_at();

-- 8. Storage bucket for borrower documents (via SQL insert into storage schema)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'borrower-documents',
    'borrower-documents',
    false,
    52428800,
    ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
ON CONFLICT (id) DO NOTHING;

-- 9. Storage RLS policies
DROP POLICY IF EXISTS "borrowers_upload_own_documents" ON storage.objects;
CREATE POLICY "borrowers_upload_own_documents"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "borrowers_read_own_documents" ON storage.objects;
CREATE POLICY "borrowers_read_own_documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "borrowers_delete_own_documents" ON storage.objects;
CREATE POLICY "borrowers_delete_own_documents"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "admin_full_access_storage" ON storage.objects;
CREATE POLICY "admin_full_access_storage"
ON storage.objects
FOR ALL
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND EXISTS (
        SELECT 1 FROM auth.users au
        WHERE au.id = auth.uid()
        AND (au.raw_user_meta_data->>'role' = 'admin' OR au.raw_app_meta_data->>'role' = 'admin')
    )
)
WITH CHECK (
    bucket_id = 'borrower-documents'
    AND EXISTS (
        SELECT 1 FROM auth.users au
        WHERE au.id = auth.uid()
        AND (au.raw_user_meta_data->>'role' = 'admin' OR au.raw_app_meta_data->>'role' = 'admin')
    )
);

-- 10. Seed default document types for existing users
DO $$
DECLARE
    existing_user_id UUID;
    existing_app_id UUID;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'borrower_applications'
    ) THEN
        SELECT user_id INTO existing_user_id FROM public.borrower_applications LIMIT 1;
        SELECT id INTO existing_app_id FROM public.borrower_applications LIMIT 1;
    END IF;

    IF existing_user_id IS NOT NULL THEN
        INSERT INTO public.borrower_documents
            (user_id, application_id, document_name, document_type, category, doc_status, expiration_date)
        VALUES
            (existing_user_id, existing_app_id, 'Government-Issued ID', 'identity_document', 'identity'::public.document_category, 'resubmit_requested'::public.document_status, CURRENT_DATE + INTERVAL '90 days'),
            (existing_user_id, existing_app_id, 'Purchase & Sale Agreement', 'psa', 'legal'::public.document_category, 'approved'::public.document_status, CURRENT_DATE + INTERVAL '60 days'),
            (existing_user_id, existing_app_id, 'Proof of Funds', 'proof_of_funds', 'financial'::public.document_category, 'pending'::public.document_status, NULL),
            (existing_user_id, existing_app_id, 'LLC Operating Agreement', 'llc_agreement', 'legal'::public.document_category, 'uploaded'::public.document_status, CURRENT_DATE + INTERVAL '365 days'),
            (existing_user_id, existing_app_id, 'Bank Statement (Last 3 Months)', 'bank_statement', 'financial'::public.document_category, 'rejected'::public.document_status, NULL)
        ON CONFLICT (id) DO NOTHING;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Seed data insertion skipped: %', SQLERRM;
END $$;
