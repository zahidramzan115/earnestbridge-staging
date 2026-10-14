-- Migration: email_triggers
-- Sets up database triggers to fire transactional emails via the send-borrower-emails edge function
-- Covers: application submission confirmation, status update notifications, deadline reminders

-- ─── HELPER: Invoke edge function via pg_net (HTTP from DB) ──────────────────
-- We use a Postgres function that calls the Supabase edge function via HTTP
-- This is invoked by triggers on borrower_applications

CREATE OR REPLACE FUNCTION public.notify_borrower_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  edge_url TEXT;
  service_role_key TEXT;
  payload JSONB;
  email_type TEXT;
  days_until_closing INT;
BEGIN
  -- Only fire on status transitions (INSERT with submitted, or UPDATE changing app_status)
  IF TG_OP = 'INSERT' THEN
    -- New application submitted
    IF NEW.app_status = 'submitted' THEN
      email_type := 'application_submitted';
    ELSE
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only fire when app_status actually changes
    IF OLD.app_status IS NOT DISTINCT FROM NEW.app_status THEN
      RETURN NEW;
    END IF;
    IF NEW.app_status = 'submitted' THEN
      email_type := 'application_submitted';
    ELSIF NEW.app_status IN ('under_review', 'approved', 'rejected') THEN
      email_type := 'status_update';
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  -- Build payload
  payload := jsonb_build_object(
    'emailType', email_type,
    'borrower', jsonb_build_object(
      'firstName', COALESCE(NEW.first_name, ''),
      'lastName', COALESCE(NEW.last_name, ''),
      'email', NEW.email
    ),
    'application', jsonb_build_object(
      'propertyAddress', COALESCE(NEW.property_address, ''),
      'depositAmount', COALESCE(NEW.deposit_amount::TEXT, ''),
      'purchasePrice', COALESCE(NEW.purchase_price::TEXT, ''),
      'closingDate', COALESCE(NEW.closing_date::TEXT, ''),
      'newStatus', NEW.app_status::TEXT,
      'milestoneLabel', CASE NEW.app_status
        WHEN 'submitted' THEN 'Phase 1: Application Submitted'
        WHEN 'under_review' THEN 'Phase 2: Under Review'
        WHEN 'approved' THEN 'Phase 3: Approved'
        WHEN 'rejected' THEN 'Application Decision Made'
        ELSE ''
      END
    )
  );

  -- Get Supabase project URL and service role key from vault/env
  edge_url := COALESCE(
    current_setting('app.supabase_url', true),
    'https://placeholder.supabase.co'
  ) || '/functions/v1/send-borrower-emails';

  -- Use pg_net to call the edge function asynchronously (fire-and-forget)
  -- pg_net is available in Supabase managed environments
  BEGIN
    PERFORM net.http_post(
      url := edge_url,
      body := payload,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(current_setting('app.service_role_key', true), '')
      )
    );
  EXCEPTION
    WHEN OTHERS THEN
      -- Log but don't fail the transaction if email sending fails
      RAISE NOTICE 'Email notification failed for application %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- ─── TRIGGER: Fire on application INSERT (submitted) or status UPDATE ─────────
DROP TRIGGER IF EXISTS trigger_borrower_email_on_submit ON public.borrower_applications;
CREATE TRIGGER trigger_borrower_email_on_submit
  AFTER INSERT ON public.borrower_applications
  FOR EACH ROW
  WHEN (NEW.app_status = 'submitted')
  EXECUTE FUNCTION public.notify_borrower_email();

DROP TRIGGER IF EXISTS trigger_borrower_email_on_status_change ON public.borrower_applications;
CREATE TRIGGER trigger_borrower_email_on_status_change
  AFTER UPDATE OF app_status ON public.borrower_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_borrower_email();

-- ─── FUNCTION: Send deadline reminder emails (called by scheduled job or API) ─
-- This function is designed to be called from the application layer or a cron job
-- It returns the list of applications that need deadline reminders
CREATE OR REPLACE FUNCTION public.get_applications_needing_deadline_reminders()
RETURNS TABLE(
  application_id UUID,
  borrower_email TEXT,
  borrower_first_name TEXT,
  borrower_last_name TEXT,
  property_address TEXT,
  closing_date DATE,
  days_until_closing INT
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
    (closing_date - CURRENT_DATE)::INT AS days_until_closing
  FROM public.borrower_applications
  WHERE
    app_status IN ('submitted', 'under_review', 'approved')
    AND closing_date IS NOT NULL
    AND email IS NOT NULL
    AND email != ''
    AND (closing_date - CURRENT_DATE)::INT IN (14, 7, 3, 1, 0)
  ORDER BY closing_date ASC;
$$;
