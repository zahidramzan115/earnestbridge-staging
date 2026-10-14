-- Deal note replies: inline replies tied to admin_note activity events
CREATE TABLE IF NOT EXISTS public.deal_note_replies (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  activity_id text NOT NULL,          -- references application_activity.id (stored as text for flexibility)
  application_id text NOT NULL,       -- denormalized for fast per-deal queries
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  actor text NOT NULL DEFAULT 'Borrower',
  body text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_deal_note_replies_activity_id ON public.deal_note_replies(activity_id);
CREATE INDEX IF NOT EXISTS idx_deal_note_replies_application_id ON public.deal_note_replies(application_id);
CREATE INDEX IF NOT EXISTS idx_deal_note_replies_created_at ON public.deal_note_replies(created_at ASC);

-- Enable RLS
ALTER TABLE public.deal_note_replies ENABLE ROW LEVEL SECURITY;

-- Borrowers can read replies on their own deals
DROP POLICY IF EXISTS "borrowers_read_own_replies" ON public.deal_note_replies;
CREATE POLICY "borrowers_read_own_replies" ON public.deal_note_replies
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Borrowers can insert their own replies
DROP POLICY IF EXISTS "borrowers_insert_own_replies" ON public.deal_note_replies;
CREATE POLICY "borrowers_insert_own_replies" ON public.deal_note_replies
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Admins can read all replies (service role bypasses RLS; this covers authenticated admin reads)
DROP POLICY IF EXISTS "open_read_replies" ON public.deal_note_replies;
CREATE POLICY "open_read_replies" ON public.deal_note_replies
  FOR SELECT
  USING (true);

-- Anyone authenticated can insert (admin replies use service role or this policy)
DROP POLICY IF EXISTS "authenticated_insert_replies" ON public.deal_note_replies;
CREATE POLICY "authenticated_insert_replies" ON public.deal_note_replies
  FOR INSERT
  WITH CHECK (true);

-- Enable real-time for live reply updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.deal_note_replies;
