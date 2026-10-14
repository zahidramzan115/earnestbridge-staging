-- Activity Feed table for chronological deal events
CREATE TABLE IF NOT EXISTS public.application_activity (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  application_id text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('status_change', 'document_upload', 'admin_note', 'deadline_shift', 'system')),
  title text NOT NULL,
  detail text,
  actor text NOT NULL DEFAULT 'System',
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Index for fast per-application queries
CREATE INDEX IF NOT EXISTS idx_application_activity_app_id ON public.application_activity(application_id);
CREATE INDEX IF NOT EXISTS idx_application_activity_user_id ON public.application_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_application_activity_created_at ON public.application_activity(created_at DESC);

-- Enable RLS
ALTER TABLE public.application_activity ENABLE ROW LEVEL SECURITY;

-- Borrowers can read their own activity
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'application_activity' AND policyname = 'borrowers_read_own_activity'
  ) THEN
    CREATE POLICY borrowers_read_own_activity ON public.application_activity
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- Admins can read all activity
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'application_activity' AND policyname = 'admins_read_all_activity'
  ) THEN
    CREATE POLICY admins_read_all_activity ON public.application_activity
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM public.borrower_applications ba
          WHERE ba.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Admins can insert activity (service role bypasses RLS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'application_activity' AND policyname = 'service_insert_activity'
  ) THEN
    CREATE POLICY service_insert_activity ON public.application_activity
      FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- Enable real-time for activity feed
ALTER PUBLICATION supabase_realtime ADD TABLE public.application_activity;
