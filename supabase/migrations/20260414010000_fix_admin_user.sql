-- Fix admin user credentials
-- Ensures admin@earnestbridge.com can log in with EarnestAdmin#2026!

DO $$
DECLARE
  admin_id UUID;
BEGIN
  -- Get existing admin user id if exists
  SELECT id INTO admin_id FROM auth.users WHERE email = 'admin@earnestbridge.com';

  IF admin_id IS NULL THEN
    -- Create fresh admin user
    admin_id := gen_random_uuid();
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_user_meta_data, raw_app_meta_data,
      is_sso_user, is_anonymous, confirmation_token, confirmation_sent_at,
      recovery_token, recovery_sent_at, email_change_token_new, email_change,
      email_change_sent_at, email_change_token_current, email_change_confirm_status,
      reauthentication_token, reauthentication_sent_at, phone, phone_change,
      phone_change_token, phone_change_sent_at
    ) VALUES (
      admin_id,
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
    );
  ELSE
    -- Update existing admin user password and metadata
    UPDATE auth.users
    SET
      encrypted_password = crypt('EarnestAdmin#2026!', gen_salt('bf', 10)),
      email_confirmed_at = COALESCE(email_confirmed_at, now()),
      raw_user_meta_data = jsonb_build_object('full_name', 'EarnestBridge Admin', 'role', 'admin'),
      raw_app_meta_data = jsonb_build_object('provider', 'email', 'providers', ARRAY['email']::TEXT[], 'role', 'admin'),
      updated_at = now()
    WHERE id = admin_id;
  END IF;

  -- Ensure identity record exists for email provider (required for signInWithPassword)
  INSERT INTO auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    admin_id,
    'admin@earnestbridge.com',
    jsonb_build_object('sub', admin_id::text, 'email', 'admin@earnestbridge.com'),
    'email',
    now(),
    now(),
    now()
  )
  ON CONFLICT (provider, provider_id) DO UPDATE
    SET
      user_id = admin_id,
      identity_data = jsonb_build_object('sub', admin_id::text, 'email', 'admin@earnestbridge.com'),
      updated_at = now();

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Admin user fix: %', SQLERRM;
END $$;

-- Ensure is_admin function exists and checks both meta fields
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
