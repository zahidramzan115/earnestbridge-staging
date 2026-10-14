-- ============================================================
-- Secure Storage Policies for borrower-documents bucket
-- Ensures only the owning borrower and admins can access files
-- ============================================================

-- Ensure bucket exists and is private
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'borrower-documents',
    'borrower-documents',
    false,
    52428800,
    ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Drop all existing storage policies for this bucket to recreate cleanly
DROP POLICY IF EXISTS "borrowers_upload_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "borrowers_read_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "borrowers_delete_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "borrowers_update_own_documents" ON storage.objects;
DROP POLICY IF EXISTS "admin_full_access_storage" ON storage.objects;

-- Borrowers: INSERT (upload their own files — path must start with their user_id)
CREATE POLICY "borrowers_upload_own_documents"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Borrowers: SELECT (read/download only their own files)
CREATE POLICY "borrowers_read_own_documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Borrowers: UPDATE (upsert support — their own files only)
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

-- Borrowers: DELETE (their own files only)
CREATE POLICY "borrowers_delete_own_documents"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'borrower-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Admins: Full access to all files in the bucket
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
