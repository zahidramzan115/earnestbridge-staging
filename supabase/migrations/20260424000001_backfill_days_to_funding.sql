-- Backfill days_to_funding for funded/closed/approved deals
-- This must run in a separate transaction AFTER the enum values ('funded', 'closed') are committed
-- PostgreSQL requires new enum values to be committed before they can be used in queries

UPDATE public.borrower_applications
SET days_to_funding = EXTRACT(DAY FROM (closing_date::timestamptz - submitted_at))::INTEGER
WHERE app_status IN ('funded', 'closed', 'approved')
  AND submitted_at IS NOT NULL
  AND closing_date IS NOT NULL
  AND days_to_funding IS NULL;
