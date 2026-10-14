-- Migration: Fix admin RLS policies for activity feed and notifications
-- Ensures admins can read all data; borrowers are strictly scoped to their own

-- ─── Fix activity feed admin policy ─────────────────────────────────────────
-- The original admins_read_all_activity policy incorrectly checked if the admin
-- had their own borrower_applications instead of checking admin role.
-- Drop and recreate with correct is_admin_user() check.

DROP POLICY IF EXISTS "admins_read_all_activity" ON public.application_activity;
CREATE POLICY "admins_read_all_activity"
  ON public.application_activity
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- Admins can also insert activity entries
DROP POLICY IF EXISTS "admins_insert_activity" ON public.application_activity;
CREATE POLICY "admins_insert_activity"
  ON public.application_activity
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin_user());

-- ─── Add admin read policy for notifications ─────────────────────────────────
-- Admins need to see all notifications for CRM/support purposes
DROP POLICY IF EXISTS "admins_read_all_notifications" ON public.notifications;
CREATE POLICY "admins_read_all_notifications"
  ON public.notifications
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- ─── Ensure user_profiles table has proper RLS (if it exists) ────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
  ) THEN
    -- Enable RLS if not already enabled
    EXECUTE 'ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY';

    -- Users can read/update their own profile
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'user_profiles' AND policyname = 'users_manage_own_profile'
    ) THEN
      EXECUTE '
        CREATE POLICY "users_manage_own_profile"
          ON public.user_profiles
          FOR ALL
          TO authenticated
          USING (id = auth.uid())
          WITH CHECK (id = auth.uid())
      ';
    END IF;

    -- Admins can read all profiles
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'user_profiles' AND policyname = 'admins_read_all_profiles'
    ) THEN
      EXECUTE '
        CREATE POLICY "admins_read_all_profiles"
          ON public.user_profiles
          FOR SELECT
          TO authenticated
          USING (public.is_admin_user())
      ';
    END IF;
  END IF;
END $$;
