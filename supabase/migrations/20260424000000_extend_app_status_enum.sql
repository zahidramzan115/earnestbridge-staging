-- Extend application_status ENUM with funded, closed, conditionally_approved, in_review statuses
-- These are needed for the dashboard KPI display and demo data

DO $$
BEGIN
  -- Add 'funded' if not exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'funded'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'application_status')
  ) THEN
    ALTER TYPE public.application_status ADD VALUE 'funded';
  END IF;

  -- Add 'closed' if not exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'closed'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'application_status')
  ) THEN
    ALTER TYPE public.application_status ADD VALUE 'closed';
  END IF;

  -- Add 'conditionally_approved' if not exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'conditionally_approved'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'application_status')
  ) THEN
    ALTER TYPE public.application_status ADD VALUE 'conditionally_approved';
  END IF;

  -- Add 'in_review' if not exists (alias used in some components)
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'in_review'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'application_status')
  ) THEN
    ALTER TYPE public.application_status ADD VALUE 'in_review';
  END IF;

  -- Add 'expired' if not exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'expired'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'application_status')
  ) THEN
    ALTER TYPE public.application_status ADD VALUE 'expired';
  END IF;
END $$;

-- Add days_to_funding computed column helper (stored as nullable int for KPI display)
ALTER TABLE public.borrower_applications
  ADD COLUMN IF NOT EXISTS days_to_funding INTEGER;
