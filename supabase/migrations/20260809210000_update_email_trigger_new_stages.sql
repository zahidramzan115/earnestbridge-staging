-- Migration: update_email_trigger_for_new_stages
-- Updates the notify_borrower_email trigger function to handle the new 6-stage deal flow:
--   Application → Under Review → Approved → Funded (key borrower notification stages)
-- Also fires admin_stage_transition emails for all stage changes.

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
BEGIN
  -- Determine email type based on operation and status
  IF TG_OP = 'INSERT' THEN
    -- New deal created — send application received email
    IF NEW.app_status IN ('application', 'submitted') THEN
      email_type := 'application_submitted';
    ELSE
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only fire when app_status actually changes
    IF OLD.app_status IS NOT DISTINCT FROM NEW.app_status THEN
      RETURN NEW;
    END IF;
    -- Map new statuses to email types
    -- Key borrower notification stages: application, under_review, approved, funded
    IF NEW.app_status IN ('application', 'submitted') THEN
      email_type := 'application_submitted';
    ELSIF NEW.app_status IN ('under_review', 'approved', 'funded', 'rejected') THEN
      email_type := 'status_update';
    ELSE
      -- in_progress, closed — no borrower email, but admin gets notified below
      email_type := NULL;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  -- Get Supabase project URL and service role key
  edge_url := COALESCE(
    current_setting('app.supabase_url', true),
    'https://placeholder.supabase.co'
  ) || '/functions/v1/send-borrower-emails';

  service_role_key := COALESCE(current_setting('app.service_role_key', true), '');

  -- ── Send borrower email (if applicable) ──────────────────────────────────
  IF email_type IS NOT NULL THEN
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
          WHEN 'application' THEN 'Stage 1: Application'
          WHEN 'submitted'   THEN 'Stage 1: Application'
          WHEN 'under_review' THEN 'Stage 2: Under Review'
          WHEN 'approved'    THEN 'Stage 3: Approved'
          WHEN 'in_progress' THEN 'Stage 4: In Progress'
          WHEN 'funded'      THEN 'Stage 5: Funded'
          WHEN 'closed'      THEN 'Stage 6: Closed'
          WHEN 'rejected'    THEN 'Application Decision Made'
          ELSE ''
        END
      )
    );

    BEGIN
      PERFORM net.http_post(
        url := edge_url,
        body := payload,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_role_key
        )
      );
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Borrower email notification failed for application %: %', NEW.id, SQLERRM;
    END;
  END IF;

  -- ── Send admin stage transition email for all status changes ─────────────
  IF TG_OP = 'UPDATE' AND OLD.app_status IS DISTINCT FROM NEW.app_status THEN
    BEGIN
      PERFORM net.http_post(
        url := edge_url,
        body := jsonb_build_object(
          'emailType', 'admin_stage_transition',
          'borrower', jsonb_build_object(
            'firstName', COALESCE(NEW.first_name, ''),
            'lastName', COALESCE(NEW.last_name, ''),
            'email', NEW.email
          ),
          'application', jsonb_build_object(
            'propertyAddress', COALESCE(NEW.property_address, ''),
            'newStatus', NEW.app_status::TEXT
          )
        ),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_role_key
        )
      );
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Admin stage transition email failed for application %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- Recreate triggers to cover all status changes
DROP TRIGGER IF EXISTS trigger_borrower_email_on_submit ON public.borrower_applications;
CREATE TRIGGER trigger_borrower_email_on_submit
  AFTER INSERT ON public.borrower_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_borrower_email();

DROP TRIGGER IF EXISTS trigger_borrower_email_on_status_change ON public.borrower_applications;
CREATE TRIGGER trigger_borrower_email_on_status_change
  AFTER UPDATE OF app_status ON public.borrower_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_borrower_email();
