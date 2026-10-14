-- Migration: admin_applications_policy
-- Adds admin read-all policy for borrower_applications using auth metadata

-- ─── ADMIN HELPER FUNCTION ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
SELECT EXISTS (
  SELECT 1 FROM auth.users au
  WHERE au.id = auth.uid()
    AND (
      au.raw_user_meta_data->>'role' = 'admin'
      OR au.raw_app_meta_data->>'role' = 'admin'
    )
)
$$;

-- ─── ADMIN POLICY: read all applications ─────────────────────────────────────
DROP POLICY IF EXISTS "admins_read_all_borrower_applications" ON public.borrower_applications;
CREATE POLICY "admins_read_all_borrower_applications"
  ON public.borrower_applications
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- ─── ADMIN POLICY: update any application status ─────────────────────────────
DROP POLICY IF EXISTS "admins_update_all_borrower_applications" ON public.borrower_applications;
CREATE POLICY "admins_update_all_borrower_applications"
  ON public.borrower_applications
  FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());
