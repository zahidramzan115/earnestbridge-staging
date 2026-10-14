-- ============================================================
-- Simplify deal stages to 6 statuses:
-- application, under_review, approved, in_progress, funded, closed
-- Keep rejected as an option. Remove/migrate old statuses.
-- ============================================================

-- Step 1: Add new enum values if they don't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'application'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'application_status')
  ) THEN
    ALTER TYPE public.application_status ADD VALUE 'application';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'in_progress'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'application_status')
  ) THEN
    ALTER TYPE public.application_status ADD VALUE 'in_progress';
  END IF;
END $$;
