-- Bidirectional document exchange: add feedback/description column to application_documents
-- and ensure admin uploads are visible to borrowers

-- Add feedback/description column to application_documents if not exists
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS feedback text,
  ADD COLUMN IF NOT EXISTS is_admin_response boolean DEFAULT false;

-- Index for faster queries by role
CREATE INDEX IF NOT EXISTS idx_app_docs_role ON public.application_documents(application_id, uploaded_by_role);

-- Ensure borrowers can read ALL documents for their own applications (including admin-uploaded ones)
-- Drop existing borrower read policy if it exists
DROP POLICY IF EXISTS "Borrowers can view their own application documents" ON public.application_documents;
DROP POLICY IF EXISTS "borrower_read_own_app_docs" ON public.application_documents;

-- Recreate: borrowers can read all docs for their own applications
CREATE POLICY "borrower_read_own_app_docs"
  ON public.application_documents
  FOR SELECT
  USING (
    application_id IN (
      SELECT id FROM public.borrower_applications WHERE user_id = auth.uid()
    )
  );

-- Ensure admins can read all application documents
DROP POLICY IF EXISTS "Admins can view all application documents" ON public.application_documents;
DROP POLICY IF EXISTS "admin_read_all_app_docs" ON public.application_documents;

CREATE POLICY "admin_read_all_app_docs"
  ON public.application_documents
  FOR SELECT
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- Ensure admins can insert documents (for admin uploads back to borrower)
DROP POLICY IF EXISTS "Admins can insert application documents" ON public.application_documents;
DROP POLICY IF EXISTS "admin_insert_app_docs" ON public.application_documents;

CREATE POLICY "admin_insert_app_docs"
  ON public.application_documents
  FOR INSERT
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- Ensure admins can delete application documents
DROP POLICY IF EXISTS "Admins can delete application documents" ON public.application_documents;
DROP POLICY IF EXISTS "admin_delete_app_docs" ON public.application_documents;

CREATE POLICY "admin_delete_app_docs"
  ON public.application_documents
  FOR DELETE
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- Borrowers can insert their own documents
DROP POLICY IF EXISTS "Borrowers can insert their own application documents" ON public.application_documents;
DROP POLICY IF EXISTS "borrower_insert_own_app_docs" ON public.application_documents;

CREATE POLICY "borrower_insert_own_app_docs"
  ON public.application_documents
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
  );

-- Borrowers can delete their own documents
DROP POLICY IF EXISTS "Borrowers can delete their own application documents" ON public.application_documents;
DROP POLICY IF EXISTS "borrower_delete_own_app_docs" ON public.application_documents;

CREATE POLICY "borrower_delete_own_app_docs"
  ON public.application_documents
  FOR DELETE
  USING (
    user_id = auth.uid()
  );
