-- Migration: Fix insecure RLS policy on borrower_access
-- Removes reference to user_metadata (editable by end users) and uses only app_metadata for admin role check

DROP POLICY IF EXISTS "Admins can manage borrower access" ON public.borrower_access;

CREATE POLICY "Admins can manage borrower access"
  ON public.borrower_access
  FOR ALL
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );
