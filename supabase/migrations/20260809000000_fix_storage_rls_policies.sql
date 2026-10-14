-- ============================================================
-- Fix Storage RLS Policies
-- Simplify storage policies: borrowers own their folder,
-- admins get full access via app_metadata (not user_metadata).
-- The server-side API route uses service role key which bypasses
-- all RLS, so these policies are a safety net only.
-- ============================================================

-- Drop all existing storage policies for borrower-documents bucket
DROP POLICY IF EXISTS "borrowers_upload_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "borrowers_read_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "borrowers_delete_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "borrowers_update_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "admin_full_access_storage" ON storage.objects;

-- Borrowers: INSERT — path must start with their user_id
CREATE POLICY "borrowers_upload_own_documents"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Borrowers: SELECT — read their own files
CREATE POLICY "borrowers_read_own_documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Borrowers: UPDATE — their own files
CREATE POLICY "borrowers_update_own_documents"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Borrowers: DELETE — their own files
CREATE POLICY "borrowers_delete_own_documents"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Admins: Full access — check app_metadata only (server-controlled, not user_metadata)
CREATE POLICY "admin_full_access_storage"
ON storage.objects
FOR ALL
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
WITH CHECK (
    bucket_id = 'borrower-documents'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- Also fix application_documents RLS: use app_metadata for admin check
DROP POLICY IF EXISTS "admin_full_access_app_documents" ON public.application_documents;
CREATE POLICY "admin_full_access_app_documents"
ON public.application_documents
FOR ALL
TO authenticated
USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- Fix borrower_documents RLS: use app_metadata for admin check
DROP POLICY IF EXISTS "admin_full_access_documents" ON public.borrower_documents;
CREATE POLICY "admin_full_access_documents"
ON public.borrower_documents
FOR ALL
TO authenticated
USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
