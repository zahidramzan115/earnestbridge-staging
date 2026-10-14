-- Notifications table for EarnestBridge borrower platform
-- Stores application alerts, deadline reminders, required actions, and system messages

DROP TYPE IF EXISTS public.notification_type CASCADE;
CREATE TYPE public.notification_type AS ENUM (
  'application_alert',
  'deadline_reminder',
  'required_action',
  'system_message'
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type public.notification_type NOT NULL DEFAULT 'system_message'::public.notification_type,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  action_url TEXT,
  action_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_manage_own_notifications" ON public.notifications;
CREATE POLICY "users_manage_own_notifications"
ON public.notifications
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Seed demo notifications for any existing authenticated user
DO $$
DECLARE
  existing_user_id UUID;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    SELECT id INTO existing_user_id FROM auth.users LIMIT 1;

    IF existing_user_id IS NOT NULL THEN
      INSERT INTO public.notifications (id, user_id, type, title, message, is_read, action_url, action_label, created_at)
      VALUES
        (gen_random_uuid(), existing_user_id, 'required_action'::public.notification_type,
         'Identity Verification Required',
         'Your application is pending identity verification. Please complete Step 1.6 to proceed.',
         false, '/apply', 'Complete Verification', NOW() - INTERVAL '10 minutes'),

        (gen_random_uuid(), existing_user_id, 'deadline_reminder'::public.notification_type,
         'PSA Closing Date Approaching',
         'Your Purchase and Sale Agreement closing date is in 7 days. Ensure all documents are submitted.',
         false, '/application-status', 'View Application', NOW() - INTERVAL '2 hours'),

        (gen_random_uuid(), existing_user_id, 'application_alert'::public.notification_type,
         'Application Under Review',
         'Your EMD financing application has been received and is currently under review by our team. Expected response within 24 business hours.',
         false, '/application-status', 'Track Status', NOW() - INTERVAL '5 hours'),

        (gen_random_uuid(), existing_user_id, 'system_message'::public.notification_type,
         'Welcome to EarnestBridge',
         'Your account has been created successfully. Start your application to access EMD financing for your real estate deals.',
         true, '/apply', 'Start Application', NOW() - INTERVAL '1 day'),

        (gen_random_uuid(), existing_user_id, 'required_action'::public.notification_type,
         'Service Agreement Ready for Signature',
         'Your service agreement has been prepared and is ready for your signature via Adobe Sign.',
         false, '/application-status', 'Sign Agreement', NOW() - INTERVAL '30 minutes'),

        (gen_random_uuid(), existing_user_id, 'application_alert'::public.notification_type,
         'LLC Formation Complete',
         'Your LLC has been successfully formed. Related documentation is now available on the platform.',
         true, '/application-status', 'View Documents', NOW() - INTERVAL '2 days'),

        (gen_random_uuid(), existing_user_id, 'deadline_reminder'::public.notification_type,
         'Option Agreement Expiration Notice',
         'Your option agreement expires in 14 days. Please decide whether to purchase the LLC, request an extension, or terminate the PSA.',
         false, '/application-status', 'Review Options', NOW() - INTERVAL '1 hour')
      ON CONFLICT (id) DO NOTHING;
    ELSE
      RAISE NOTICE 'No existing users found. Notifications seed skipped.';
    END IF;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Notifications seed failed: %', SQLERRM;
END $$;
