-- Admin credentials migration
-- Creates admin user in auth.users and sets up is_admin helper function

-- 1. Create is_admin function using auth metadata (safe for all tables, no recursion)
CREATE OR REPLACE FUNCTION public.is_admin()
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

-- 2. Create admin user in auth.users
DO $$
DECLARE
  admin_uuid UUID := gen_random_uuid();
BEGIN
  -- Insert admin user (idempotent: skip if email already exists)
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    created_at, updated_at, raw_user_meta_data, raw_app_meta_data,
    is_sso_user, is_anonymous, confirmation_token, confirmation_sent_at,
    recovery_token, recovery_sent_at, email_change_token_new, email_change,
    email_change_sent_at, email_change_token_current, email_change_confirm_status,
    reauthentication_token, reauthentication_sent_at, phone, phone_change,
    phone_change_token, phone_change_sent_at
  ) VALUES (
    admin_uuid,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'admin@earnestbridge.com',
    crypt('EarnestAdmin#2026!', gen_salt('bf', 10)),
    now(),
    now(),
    now(),
    jsonb_build_object('full_name', 'EarnestBridge Admin', 'role', 'admin'),
    jsonb_build_object('provider', 'email', 'providers', ARRAY['email']::TEXT[], 'role', 'admin'),
    false, false, '', null, '', null, '', '', null, '', 0, '', null, null, '', '', null
  )
  ON CONFLICT (email) DO UPDATE
    SET raw_user_meta_data = jsonb_build_object('full_name', 'EarnestBridge Admin', 'role', 'admin'),
        raw_app_meta_data = jsonb_build_object('provider', 'email', 'providers', ARRAY['email']::TEXT[], 'role', 'admin'),
        updated_at = now();

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Admin user creation: %', SQLERRM;
END $$;

-- 3. Add admin RLS policies to borrower_applications (admin can read/update all)
DROP POLICY IF EXISTS "admin_full_access_borrower_applications" ON public.borrower_applications;
CREATE POLICY "admin_full_access_borrower_applications"
ON public.borrower_applications
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- 4. Add admin RLS policies to borrower_documents
DROP POLICY IF EXISTS "admin_full_access_borrower_documents" ON public.borrower_documents;
CREATE POLICY "admin_full_access_borrower_documents"
ON public.borrower_documents
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- 5. Add admin RLS policies to application_activity
DROP POLICY IF EXISTS "admin_full_access_application_activity" ON public.application_activity;
CREATE POLICY "admin_full_access_application_activity"
ON public.application_activity
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- 6. Add admin RLS policies to notifications
DROP POLICY IF EXISTS "admin_full_access_notifications" ON public.notifications;
CREATE POLICY "admin_full_access_notifications"
ON public.notifications
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());
