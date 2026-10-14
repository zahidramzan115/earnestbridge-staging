-- Migration: Add borrower access control (disable/enable users)
-- Creates a borrower_access table to track disabled status per user_id

CREATE TABLE IF NOT EXISTS public.borrower_access (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_disabled boolean NOT NULL DEFAULT false,
  disabled_at timestamp with time zone,
  disabled_by uuid REFERENCES auth.users(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.borrower_access ENABLE ROW LEVEL SECURITY;

-- Admins can read and write all rows
CREATE POLICY "Admins can manage borrower access"
  ON public.borrower_access
  FOR ALL
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- Borrowers can read their own row (to check if they are disabled)
CREATE POLICY "Borrowers can read own access row"
  ON public.borrower_access
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
