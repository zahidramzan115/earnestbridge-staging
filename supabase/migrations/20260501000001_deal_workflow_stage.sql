-- Migration: Add deal workflow stage tracking
-- Adds deal_workflow_stage to borrower_applications for 11-step deal flow
-- Adds deal_shared_documents for admin-shared documents (MOU, Option Agreement, PI)

-- 1. Add deal_workflow_stage column to borrower_applications
ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS deal_workflow_stage INTEGER DEFAULT 0;

-- Stage mapping:
-- 0  = Application submitted (Step 1)
-- 1  = Admin reviewing application (Step 2)
-- 2  = Admin approved, documents shared with borrower (Step 3)
-- 3  = Borrower reviewing/signing documents (Step 4)
-- 4  = Borrower provided PSA, under review (Step 5)
-- 5  = LLC formation in progress (Step 6)
-- 6  = PSA review / back-and-forth (Step 7)
-- 7  = All parties signing PSA, Option, Escrow (Step 8)
-- 8  = W-9 completion (Step 9)
-- 9  = Funds transferred to escrow (Step 10)
-- 10 = Option agreement exercised (Step 11 - complete)

-- 2. Add w9_signed, mou_signed, option_agreement_signed, psa_signed, llc_formed, escrow_funded columns
ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS w9_signed BOOLEAN DEFAULT FALSE;

ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS mou_signed BOOLEAN DEFAULT FALSE;

ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS option_agreement_signed BOOLEAN DEFAULT FALSE;

ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS psa_signed BOOLEAN DEFAULT FALSE;

ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS llc_formed BOOLEAN DEFAULT FALSE;

ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS escrow_funded BOOLEAN DEFAULT FALSE;

ALTER TABLE public.borrower_applications
ADD COLUMN IF NOT EXISTS option_exercised BOOLEAN DEFAULT FALSE;

-- 3. Create deal_shared_documents table for admin-shared documents
CREATE TABLE IF NOT EXISTS public.deal_shared_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES public.borrower_applications(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL, -- 'mou', 'option_agreement', 'pi', 'escrow_agreement', 'other'
  document_name TEXT NOT NULL,
  file_url TEXT,
  file_name TEXT,
  file_size BIGINT,
  shared_by UUID REFERENCES auth.users(id),
  shared_at TIMESTAMPTZ DEFAULT now(),
  borrower_signed BOOLEAN DEFAULT FALSE,
  borrower_signed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_shared_docs_application_id ON public.deal_shared_documents(application_id);

ALTER TABLE public.deal_shared_documents ENABLE ROW LEVEL SECURITY;

-- Admin can do everything
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
SELECT EXISTS (
  SELECT 1 FROM auth.users au
  WHERE au.id = auth.uid()
  AND (au.raw_user_meta_data->>'role' = 'admin' OR au.raw_app_meta_data->>'role' = 'admin')
)
$$;

DROP POLICY IF EXISTS "admin_manage_deal_shared_documents" ON public.deal_shared_documents;
CREATE POLICY "admin_manage_deal_shared_documents"
ON public.deal_shared_documents
FOR ALL
TO authenticated
USING (public.is_admin_user())
WITH CHECK (public.is_admin_user());

-- Borrowers can view documents shared for their applications
DROP POLICY IF EXISTS "borrowers_view_own_deal_shared_documents" ON public.deal_shared_documents;
CREATE POLICY "borrowers_view_own_deal_shared_documents"
ON public.deal_shared_documents
FOR SELECT
TO authenticated
USING (
  application_id IN (
    SELECT id FROM public.borrower_applications WHERE user_id = auth.uid()
  )
);

-- Borrowers can update signing status on their documents
DROP POLICY IF EXISTS "borrowers_update_signing_deal_shared_documents" ON public.deal_shared_documents;
CREATE POLICY "borrowers_update_signing_deal_shared_documents"
ON public.deal_shared_documents
FOR UPDATE
TO authenticated
USING (
  application_id IN (
    SELECT id FROM public.borrower_applications WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  application_id IN (
    SELECT id FROM public.borrower_applications WHERE user_id = auth.uid()
  )
);
