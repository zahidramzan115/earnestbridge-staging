-- ============================================================
-- Step 3B-3A: Client-Facing Revision Message Field
-- Adds client_revision_message to both document tables.
--
-- DESIGN:
--   review_notes  = Admin-internal only. Never exposed to clients.
--   client_revision_message = Intentionally written for the client.
--                             Shown in the borrower portal when
--                             review_status = 'revision_requested'.
--
-- borrower_documents: also has legacy resubmit_reason.
--   We preserve resubmit_reason for backward compatibility.
--   client_revision_message is canonical for the new review workflow.
--
-- ATOMIC REVISION REQUEST:
--   update_document_review_status() is updated to accept an optional
--   p_client_revision_message parameter. When p_new_status = 'revision_requested',
--   both review_status AND client_revision_message are written in the same
--   database function call, eliminating the prior non-atomic two-step pattern.
-- ============================================================

-- ─── borrower_documents ──────────────────────────────────────────────────────
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS client_revision_message TEXT;

-- ─── application_documents ───────────────────────────────────────────────────
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS client_revision_message TEXT;

-- ─── Update update_document_review_status() to write client_revision_message atomically ──
-- Drop and recreate with the new optional parameter.
-- The function already exists from 20260913030000_document_versioning_review.sql.
-- We replace it here because the prior migration has not been deployed yet.
DROP FUNCTION IF EXISTS public.update_document_review_status(
  UUID, TEXT, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.update_document_review_status(
  p_document_id              UUID,
  p_table_name               TEXT,
  p_new_status               TEXT,
  p_reviewed_by              TEXT DEFAULT NULL,
  p_review_notes             TEXT DEFAULT NULL,
  p_client_revision_message  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
  v_application_id UUID;
  v_group_id UUID;
BEGIN
  -- Validate table target
  IF p_table_name NOT IN ('borrower_documents', 'application_documents') THEN
    RAISE EXCEPTION 'Invalid table target: %', p_table_name;
  END IF;

  -- Validate status
  IF p_new_status NOT IN ('uploaded', 'under_review', 'revision_requested', 'approved_final', 'superseded') THEN
    RAISE EXCEPTION 'Invalid review status: %', p_new_status;
  END IF;

  -- When requesting a revision, client message must be provided and non-empty
  IF p_new_status = 'revision_requested' THEN
    IF p_client_revision_message IS NULL OR trim(p_client_revision_message) = '' THEN
      RAISE EXCEPTION 'client_revision_message is required when requesting a revision';
    END IF;
  END IF;

  IF p_table_name = 'borrower_documents' THEN
    -- ── borrower_documents branch ──────────────────────────────────────────

    -- Fetch group id for approved_final supersession
    SELECT document_group_id, application_id
      INTO v_group_id, v_application_id
      FROM public.borrower_documents
     WHERE id = p_document_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Document not found: %', p_document_id;
    END IF;

    -- If approving final, supersede any existing approved_final in the same group
    IF p_new_status = 'approved_final' THEN
      UPDATE public.borrower_documents
         SET review_status      = 'superseded',
             is_current_version = FALSE
       WHERE document_group_id = v_group_id
         AND id                <> p_document_id
         AND review_status      = 'approved_final';
    END IF;

    -- Update the target document atomically
    UPDATE public.borrower_documents
       SET review_status             = p_new_status,
           review_notes              = COALESCE(p_review_notes, review_notes),
           reviewed_by               = COALESCE(p_reviewed_by, reviewed_by),
           reviewed_at               = NOW(),
           is_current_version        = CASE WHEN p_new_status = 'approved_final' THEN TRUE ELSE is_current_version END,
           client_revision_message   = CASE
                                         WHEN p_new_status = 'revision_requested'
                                         THEN trim(p_client_revision_message)
                                         ELSE client_revision_message
                                       END
     WHERE id = p_document_id
    RETURNING to_jsonb(borrower_documents.*) INTO v_result;

  ELSE
    -- ── application_documents branch ──────────────────────────────────────

    -- Fetch thread_id for approved_final supersession
    SELECT thread_id, application_id
      INTO v_group_id, v_application_id
      FROM public.application_documents
     WHERE id = p_document_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Document not found: %', p_document_id;
    END IF;

    -- If approving final, supersede any existing approved_final in the same thread
    IF p_new_status = 'approved_final' AND v_group_id IS NOT NULL THEN
      UPDATE public.application_documents
         SET review_status      = 'superseded',
             is_current_version = FALSE
       WHERE thread_id   = v_group_id
         AND id         <> p_document_id
         AND review_status = 'approved_final';
    END IF;

    -- Update the target document atomically
    UPDATE public.application_documents
       SET review_status             = p_new_status,
           review_notes              = COALESCE(p_review_notes, review_notes),
           reviewed_by               = COALESCE(p_reviewed_by, reviewed_by),
           reviewed_at               = NOW(),
           is_current_version        = CASE WHEN p_new_status = 'approved_final' THEN TRUE ELSE is_current_version END,
           client_revision_message   = CASE
                                         WHEN p_new_status = 'revision_requested'
                                         THEN trim(p_client_revision_message)
                                         ELSE client_revision_message
                                       END
     WHERE id = p_document_id
    RETURNING to_jsonb(application_documents.*) INTO v_result;

  END IF;

  RETURN v_result;
END;
$$;
