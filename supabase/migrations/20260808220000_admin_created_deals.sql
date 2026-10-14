-- Migration: admin_created_deals
-- Allows admins to create deals on behalf of clients directly from the admin portal

-- Add a flag to track admin-created deals
ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS admin_created BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- Allow user_id to be nullable so admin can create a deal for a client
-- who may not yet have a portal account (linked by email instead)
ALTER TABLE public.borrower_applications
  ALTER COLUMN user_id DROP NOT NULL;

-- Add a client_email column for admin-created deals where user may not have an account
ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS client_email TEXT;

-- Backfill client_email from email column for existing records
UPDATE public.borrower_applications
  SET client_email = email
  WHERE client_email IS NULL AND email IS NOT NULL AND email != '';

-- Index for quick lookup by client_email
CREATE INDEX IF NOT EXISTS idx_borrower_applications_client_email
  ON public.borrower_applications(client_email);

-- Index for admin_created flag
CREATE INDEX IF NOT EXISTS idx_borrower_applications_admin_created
  ON public.borrower_applications(admin_created);
