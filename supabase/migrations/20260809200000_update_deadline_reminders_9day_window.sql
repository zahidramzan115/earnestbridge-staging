-- Migration: update_deadline_reminders_9day_window
-- Updates the deadline reminder logic to:
--   1. Fire daily starting 9 days before closing date
--   2. Include all active deal statuses (application, under_review, approved, in_progress, funded)
--   3. Adds deposit_amount to the returned columns for admin emails

-- Drop existing function first to allow changing the return type (OUT parameters)
DROP FUNCTION IF EXISTS public.get_applications_needing_deadline_reminders();

-- Recreate the function with the new 9-day daily window
CREATE OR REPLACE FUNCTION public.get_applications_needing_deadline_reminders()
RETURNS TABLE(
  application_id UUID,
  borrower_email TEXT,
  borrower_first_name TEXT,
  borrower_last_name TEXT,
  property_address TEXT,
  closing_date DATE,
  days_until_closing INT,
  deposit_amount NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    id AS application_id,
    email AS borrower_email,
    first_name AS borrower_first_name,
    last_name AS borrower_last_name,
    COALESCE(property_address, '') AS property_address,
    closing_date,
    (closing_date - CURRENT_DATE)::INT AS days_until_closing,
    COALESCE(deposit_amount, 0) AS deposit_amount
  FROM public.borrower_applications
  WHERE
    -- All active statuses — any deal that hasn't closed or been rejected
    app_status IN ('application', 'under_review', 'approved', 'in_progress', 'funded')
    AND closing_date IS NOT NULL
    AND email IS NOT NULL
    AND email != ''
    -- Send daily from 9 days out through closing day (0)
    -- 9 days = 7 days until option period expires (option expires 2 days before closing)
    AND (closing_date - CURRENT_DATE)::INT BETWEEN 0 AND 9
  ORDER BY closing_date ASC;
$$;
