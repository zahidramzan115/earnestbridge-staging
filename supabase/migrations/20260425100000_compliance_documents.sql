-- ============================================================
-- Compliance Documents: Seed W-9, PSA, MOU for existing users
-- ============================================================

-- Add compliance_type column to borrower_documents if it doesn't exist
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS compliance_type TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS checklist_step INTEGER DEFAULT NULL;

-- Seed compliance document slots for all existing borrowers who have applications
-- but don't yet have these compliance doc types
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT DISTINCT user_id, id AS application_id
    FROM public.borrower_applications
    WHERE app_status NOT IN ('draft')
  LOOP
    -- MOU (Step 3)
    IF NOT EXISTS (
      SELECT 1 FROM public.borrower_documents
      WHERE user_id = rec.user_id
        AND compliance_type = 'mou'
    ) THEN
      INSERT INTO public.borrower_documents
        (user_id, application_id, document_name, document_type, category, doc_status, compliance_type, checklist_step)
      VALUES
        (rec.user_id, rec.application_id, 'Memorandum of Understanding (MOU)', 'mou', 'legal'::public.document_category, 'pending'::public.document_status, 'mou', 3);
    END IF;

    -- PSA (Step 4)
    IF NOT EXISTS (
      SELECT 1 FROM public.borrower_documents
      WHERE user_id = rec.user_id
        AND compliance_type = 'psa'
    ) THEN
      INSERT INTO public.borrower_documents
        (user_id, application_id, document_name, document_type, category, doc_status, compliance_type, checklist_step)
      VALUES
        (rec.user_id, rec.application_id, 'Purchase & Sale Agreement (PSA)', 'psa', 'legal'::public.document_category, 'pending'::public.document_status, 'psa', 4);
    END IF;

    -- W-9 (Step 8)
    IF NOT EXISTS (
      SELECT 1 FROM public.borrower_documents
      WHERE user_id = rec.user_id
        AND compliance_type = 'w9'
    ) THEN
      INSERT INTO public.borrower_documents
        (user_id, application_id, document_name, document_type, category, doc_status, compliance_type, checklist_step)
      VALUES
        (rec.user_id, rec.application_id, 'W-9 Tax Form', 'w9', 'financial'::public.document_category, 'pending'::public.document_status, 'w9', 8);
    END IF;
  END LOOP;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Compliance document seed skipped: %', SQLERRM;
END $$;
