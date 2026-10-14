-- ============================================================
-- Document Revision Chain
-- Adds parent_document_id, revision_number, and thread_id to
-- application_documents so each upload can be linked to a prior
-- document, forming a traceable back-and-forth revision thread.
-- ============================================================

-- 1. Add revision chain columns
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS parent_document_id UUID REFERENCES public.application_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revision_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS thread_id UUID;

-- 2. Indexes for fast thread lookups
CREATE INDEX IF NOT EXISTS idx_app_docs_thread_id ON public.application_documents(thread_id);
CREATE INDEX IF NOT EXISTS idx_app_docs_parent_id ON public.application_documents(parent_document_id);

-- 3. Backfill thread_id for existing documents (each existing doc becomes its own thread root)
UPDATE public.application_documents
SET thread_id = id
WHERE thread_id IS NULL;

-- 4. Trigger function: auto-set thread_id = id for new root documents (when thread_id not provided)
CREATE OR REPLACE FUNCTION public.set_document_thread_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.thread_id IS NULL THEN
    NEW.thread_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_document_thread_id_trigger ON public.application_documents;
CREATE TRIGGER set_document_thread_id_trigger
  BEFORE INSERT ON public.application_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_document_thread_id();
