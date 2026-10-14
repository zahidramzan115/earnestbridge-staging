-- Add borrower-specific notification types: admin_note, document_decision, status_change
-- These are inserted by admin actions and surfaced on the borrower dashboard

-- Extend the notification_type enum with new values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'admin_note'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'notification_type')
  ) THEN
    ALTER TYPE public.notification_type ADD VALUE 'admin_note';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'document_decision'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'notification_type')
  ) THEN
    ALTER TYPE public.notification_type ADD VALUE 'document_decision';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'status_change'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'notification_type')
  ) THEN
    ALTER TYPE public.notification_type ADD VALUE 'status_change';
  END IF;
END $$;

-- Add optional metadata column for richer context (e.g. document name, old/new status)
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Seed demo borrower-specific notifications for existing users
DO $$
DECLARE
  existing_user_id UUID;
BEGIN
  SELECT id INTO existing_user_id FROM auth.users LIMIT 1;

  IF existing_user_id IS NOT NULL THEN
    INSERT INTO public.notifications (id, user_id, type, title, message, is_read, action_url, action_label, created_at, metadata)
    VALUES
      (gen_random_uuid(), existing_user_id, 'admin_note'::public.notification_type,
       'Note from Your Loan Officer',
       'Hi Marcus — we reviewed your application and need a few clarifications on the deposit source. Please check the documents section.',
       false, '/application-status', 'View Application', NOW() - INTERVAL '45 minutes',
       '{"author": "Admin", "note_type": "clarification"}'::jsonb),

      (gen_random_uuid(), existing_user_id, 'document_decision'::public.notification_type,
       'Bank Statement Approved',
       'Your bank statement (uploaded Oct 5) has been reviewed and approved by the underwriting team.',
       false, '/application-status', 'View Documents', NOW() - INTERVAL '3 hours',
       '{"document_name": "Bank Statement", "decision": "approved"}'::jsonb),

      (gen_random_uuid(), existing_user_id, 'document_decision'::public.notification_type,
       'Proof of Funds — Action Required',
       'Your Proof of Funds document was flagged for resubmission. Please upload a more recent statement (within 60 days).',
       false, '/application-status', 'Resubmit Document', NOW() - INTERVAL '1 hour',
       '{"document_name": "Proof of Funds", "decision": "rejected"}'::jsonb),

      (gen_random_uuid(), existing_user_id, 'status_change'::public.notification_type,
       'Application Status Updated',
       'Your application status has changed from "Submitted" to "Under Review". Our team will be in touch within 24 business hours.',
       false, '/application-status', 'Track Progress', NOW() - INTERVAL '6 hours',
       '{"old_status": "submitted", "new_status": "under_review"}'::jsonb),

      (gen_random_uuid(), existing_user_id, 'status_change'::public.notification_type,
       'Funding Approved',
       'Congratulations! Your EMD financing has been approved. Funds will be wired within 1–2 business days.',
       true, '/application-status', 'View Details', NOW() - INTERVAL '2 days',
       '{"old_status": "under_review", "new_status": "approved"}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Borrower notification seed failed: %', SQLERRM;
END $$;
