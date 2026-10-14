-- ============================================================
-- Document Versioning & Review Workflow — Step 3A (REVISED)
-- Pre-deployment correction applied 2026-09-13.
--
-- ARCHITECTURE DECISION:
--   application_documents already has canonical versioning fields:
--     thread_id          = logical document group
--     revision_number    = version number
--     parent_document_id = prior/superseded document
--   We do NOT add duplicate fields to application_documents.
--   We add ONLY the 5 missing review/workflow fields.
--
--   borrower_documents has NO prior version model.
--   We add full versioning + review fields there.
-- ============================================================

-- ─── SECTION 1: EXTEND borrower_documents ────────────────────────────────────
-- borrower_documents has no existing version model; add all versioning + review fields.

-- 1a. document_group_id (UUID — groups all revisions of the same logical document)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS document_group_id UUID;

-- 1b. version_number (INTEGER — starts at 1, increments per revision)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;

-- 1c. is_current_version (BOOLEAN — only one true per document_group_id)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS is_current_version BOOLEAN NOT NULL DEFAULT true;

-- 1d. review_status (TEXT with CHECK constraint)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'uploaded'
  CHECK (review_status IN ('uploaded', 'under_review', 'revision_requested', 'approved_final', 'superseded'));

-- 1e. review_notes (TEXT nullable — Admin internal feedback, NOT client-visible in this phase)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- 1f. reviewed_by (TEXT nullable — Admin name: Eric, Dan, Tucker)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- 1g. reviewed_at (TIMESTAMPTZ nullable)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- 1h. supersedes_document_id (self-referential FK, nullable — explicit revision chain)
ALTER TABLE public.borrower_documents
  ADD COLUMN IF NOT EXISTS supersedes_document_id UUID
  REFERENCES public.borrower_documents(id) ON DELETE SET NULL;

-- ─── SECTION 2: BACKFILL borrower_documents ──────────────────────────────────
-- Each existing row gets its own unique document_group_id.
-- It becomes version 1, is_current_version = true, review_status = 'uploaded'.
-- No existing records are deleted or modified beyond adding these new fields.

UPDATE public.borrower_documents
SET document_group_id = gen_random_uuid()
WHERE document_group_id IS NULL;

-- Make document_group_id NOT NULL after backfill
ALTER TABLE public.borrower_documents
  ALTER COLUMN document_group_id SET NOT NULL;

-- ─── SECTION 3: INDEXES on borrower_documents ────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_bd_document_group_id
  ON public.borrower_documents(document_group_id);

CREATE INDEX IF NOT EXISTS idx_bd_group_current
  ON public.borrower_documents(document_group_id, is_current_version);

CREATE INDEX IF NOT EXISTS idx_bd_application_group
  ON public.borrower_documents(application_id, document_group_id);

CREATE INDEX IF NOT EXISTS idx_bd_review_status
  ON public.borrower_documents(review_status);

-- Unique: only one version_number per document_group_id
-- Prevents duplicate version numbers within the same group (concurrent upload guard)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bd_group_version_unique
  ON public.borrower_documents(document_group_id, version_number);

-- Partial unique: only one is_current_version = true per document_group_id
-- Database-level guard against multiple "current" versions in a group.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bd_group_one_current
  ON public.borrower_documents(document_group_id)
  WHERE is_current_version = true;

-- ─── SECTION 4: EXTEND application_documents (REVIEW FIELDS ONLY) ────────────
-- application_documents already has canonical versioning:
--   thread_id          = logical document group  (canonical group identifier)
--   revision_number    = version number          (canonical version counter)
--   parent_document_id = prior/superseded doc    (canonical revision chain)
--
-- We do NOT add document_group_id, version_number, or supersedes_document_id.
-- Those would duplicate existing concepts and create a second source of truth.
--
-- We add ONLY the 5 missing review/workflow fields:

-- 4a. is_current_version
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS is_current_version BOOLEAN NOT NULL DEFAULT true;

-- 4b. review_status
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'uploaded'
  CHECK (review_status IN ('uploaded', 'under_review', 'revision_requested', 'approved_final', 'superseded'));

-- 4c. review_notes (Admin internal — NOT client-visible in this phase)
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- 4d. reviewed_by
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- 4e. reviewed_at
ALTER TABLE public.application_documents
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- ─── SECTION 5: BACKFILL application_documents ───────────────────────────────
-- IMPORTANT: Do NOT blindly set all rows to is_current_version = true.
-- Multiple rows may share the same thread_id (prior revision chain).
-- Rule: within each thread_id, the row with the HIGHEST revision_number
-- is the current version. All others are not current.
--
-- Step 1: Set all existing rows to is_current_version = false as a safe baseline.
UPDATE public.application_documents
SET is_current_version = false;

-- Step 2: For each thread_id, mark only the highest revision_number as current.
-- If revision_number is NULL (should not exist after migration 20260809220000,
-- but handled safely): treat NULL as revision 0 (lowest priority).
-- A NULL-revision row will only become current if it is the sole row in its thread.
UPDATE public.application_documents ad
SET is_current_version = true
WHERE COALESCE(ad.revision_number, 0) = (
  SELECT MAX(COALESCE(ad2.revision_number, 0))
  FROM public.application_documents ad2
  WHERE ad2.thread_id = ad.thread_id
    AND ad2.thread_id IS NOT NULL
);

-- Handle rows where thread_id IS NULL (edge case — should not exist after prior migration).
-- These rows have no group context; mark them current individually.
UPDATE public.application_documents
SET is_current_version = true
WHERE thread_id IS NULL;

-- ─── SECTION 6: INDEXES on application_documents ─────────────────────────────

-- Index for fast current-version lookup by thread
CREATE INDEX IF NOT EXISTS idx_appdoc_thread_current
  ON public.application_documents(thread_id, is_current_version);

CREATE INDEX IF NOT EXISTS idx_appdoc_review_status
  ON public.application_documents(review_status);

-- Version uniqueness: one revision_number per thread_id
-- Only safe to create if existing data is clean. We use a conditional approach:
-- The unique index will fail if duplicate (thread_id, revision_number) pairs exist.
-- In that case the migration will surface the conflict rather than silently corrupt data.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appdoc_thread_version_unique
  ON public.application_documents(thread_id, revision_number)
  WHERE thread_id IS NOT NULL AND revision_number IS NOT NULL;

-- Partial unique: one is_current_version = true per thread_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_appdoc_thread_one_current
  ON public.application_documents(thread_id)
  WHERE is_current_version = true AND thread_id IS NOT NULL;

-- ─── SECTION 7: TRIGGER — auto-set document_group_id on new borrower_documents ──
-- When a new borrower_documents row is inserted without a document_group_id,
-- assign one automatically. This ensures new uploads (not revisions) always
-- start their own group.
CREATE OR REPLACE FUNCTION public.bd_set_document_group_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.document_group_id IS NULL THEN
    NEW.document_group_id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS bd_set_document_group_id_trigger ON public.borrower_documents;
CREATE TRIGGER bd_set_document_group_id_trigger
  BEFORE INSERT ON public.borrower_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.bd_set_document_group_id();

-- ─── SECTION 8: TRIGGER — keep thread_id in sync for application_documents ───
-- Replace the existing set_document_thread_id_trigger.
-- Behavior is identical: if thread_id is NULL on insert, set it to the new row's id.
-- We do NOT add document_group_id logic here — thread_id remains canonical.
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

-- ─── SECTION 9: HELPER FUNCTION — create_borrower_document_revision ──────────
-- Called by the API when uploading a new revision to an existing document group.
-- Uses advisory lock to prevent concurrent uploads receiving the same version number.
-- Returns: the newly inserted row id (UUID).
CREATE OR REPLACE FUNCTION public.create_borrower_document_revision(
  p_document_group_id  UUID,
  p_user_id            UUID,
  p_application_id     UUID,
  p_document_name      TEXT,
  p_document_type      TEXT,
  p_category           public.document_category,
  p_file_url           TEXT,
  p_file_name          TEXT,
  p_file_size          BIGINT,
  p_mime_type          TEXT,
  p_compliance_type    TEXT DEFAULT NULL,
  p_checklist_step     INTEGER DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_next_version    INTEGER;
  v_prev_current_id UUID;
  v_new_id          UUID;
BEGIN
  -- Lock the group to prevent concurrent revision uploads getting the same version number
  PERFORM pg_advisory_xact_lock(hashtext(p_document_group_id::text));

  -- Determine next version number
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO v_next_version
  FROM public.borrower_documents
  WHERE document_group_id = p_document_group_id;

  -- Find the current version to supersede
  SELECT id INTO v_prev_current_id
  FROM public.borrower_documents
  WHERE document_group_id = p_document_group_id
    AND is_current_version = true
  LIMIT 1;

  -- Mark previous current version as no longer current
  IF v_prev_current_id IS NOT NULL THEN
    UPDATE public.borrower_documents
    SET is_current_version = false
    WHERE id = v_prev_current_id;
  END IF;

  -- Insert new revision
  INSERT INTO public.borrower_documents (
    user_id,
    application_id,
    document_name,
    document_type,
    category,
    file_url,
    file_name,
    file_size,
    mime_type,
    doc_status,
    uploaded_at,
    compliance_type,
    checklist_step,
    document_group_id,
    version_number,
    is_current_version,
    review_status,
    supersedes_document_id
  )
  VALUES (
    p_user_id,
    p_application_id,
    p_document_name,
    p_document_type,
    p_category,
    p_file_url,
    p_file_name,
    p_file_size,
    p_mime_type,
    'uploaded'::public.document_status,
    now(),
    p_compliance_type,
    p_checklist_step,
    p_document_group_id,
    v_next_version,
    true,
    'uploaded',
    v_prev_current_id
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$func$;

-- ─── SECTION 10: HELPER FUNCTION — create_application_document_revision ───────
-- Uses the CANONICAL fields for application_documents:
--   thread_id          = logical document group
--   revision_number    = version counter
--   parent_document_id = prior/superseded document
-- Does NOT use document_group_id, version_number, or supersedes_document_id
-- (those do not exist on application_documents).
CREATE OR REPLACE FUNCTION public.create_application_document_revision(
  p_thread_id          UUID,       -- canonical group identifier (thread_id)
  p_application_id     UUID,
  p_user_id            UUID,
  p_uploaded_by_role   TEXT,
  p_uploader_email     TEXT,
  p_document_name      TEXT,
  p_file_name          TEXT,
  p_file_url           TEXT,
  p_storage_path       TEXT,
  p_file_size          BIGINT,
  p_mime_type          TEXT,
  p_feedback           TEXT DEFAULT NULL,
  p_is_admin_response  BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_next_revision    INTEGER;
  v_prev_current_id  UUID;
  v_new_id           UUID;
BEGIN
  -- Lock the thread to prevent concurrent revision uploads
  PERFORM pg_advisory_xact_lock(hashtext(p_thread_id::text));

  -- Determine next revision number using canonical revision_number field
  SELECT COALESCE(MAX(revision_number), 0) + 1
  INTO v_next_revision
  FROM public.application_documents
  WHERE thread_id = p_thread_id;

  -- Find the current version to supersede (using canonical is_current_version)
  SELECT id INTO v_prev_current_id
  FROM public.application_documents
  WHERE thread_id = p_thread_id
    AND is_current_version = true
  LIMIT 1;

  -- Mark previous current version as no longer current
  IF v_prev_current_id IS NOT NULL THEN
    UPDATE public.application_documents
    SET is_current_version = false
    WHERE id = v_prev_current_id;
  END IF;

  -- Insert new revision using canonical fields:
  --   thread_id          = group
  --   revision_number    = version
  --   parent_document_id = prior doc (canonical supersedes reference)
  INSERT INTO public.application_documents (
    application_id,
    user_id,
    uploaded_by_role,
    uploader_email,
    document_name,
    file_name,
    file_url,
    storage_path,
    file_size,
    mime_type,
    feedback,
    is_admin_response,
    thread_id,
    revision_number,
    parent_document_id,
    is_current_version,
    review_status
  )
  VALUES (
    p_application_id,
    p_user_id,
    p_uploaded_by_role,
    p_uploader_email,
    p_document_name,
    p_file_name,
    p_file_url,
    p_storage_path,
    p_file_size,
    p_mime_type,
    p_feedback,
    p_is_admin_response,
    p_thread_id,
    v_next_revision,
    v_prev_current_id,  -- canonical parent_document_id
    true,
    'uploaded'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$func$;

-- ─── SECTION 11: HELPER FUNCTION — update_document_review_status ─────────────
-- Safe status transition helper for Admin review actions.
-- Enforces that only one approved_final version exists per group.
-- For application_documents: uses thread_id as the group identifier.
-- For borrower_documents: uses document_group_id as the group identifier.
CREATE OR REPLACE FUNCTION public.update_document_review_status(
  p_document_id   UUID,
  p_table_name    TEXT,  -- 'borrower_documents' or 'application_documents'
  p_new_status    TEXT,
  p_reviewed_by   TEXT DEFAULT NULL,
  p_review_notes  TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_group_id UUID;
BEGIN
  -- Validate status value (server-side guard in addition to CHECK constraint)
  IF p_new_status NOT IN ('uploaded', 'under_review', 'revision_requested', 'approved_final', 'superseded') THEN
    RAISE EXCEPTION 'Invalid review_status value: %', p_new_status;
  END IF;

  IF p_table_name = 'borrower_documents' THEN
    -- Use document_group_id as canonical group for borrower_documents
    SELECT document_group_id INTO v_group_id
    FROM public.borrower_documents WHERE id = p_document_id;

    IF v_group_id IS NULL THEN
      RAISE EXCEPTION 'Document not found: %', p_document_id;
    END IF;

    -- If approving final, clear any prior approved_final in the group
    IF p_new_status = 'approved_final' THEN
      UPDATE public.borrower_documents
      SET review_status = 'superseded'
      WHERE document_group_id = v_group_id
        AND review_status = 'approved_final'
        AND id != p_document_id;
    END IF;

    UPDATE public.borrower_documents
    SET
      review_status = p_new_status,
      reviewed_by   = COALESCE(p_reviewed_by, reviewed_by),
      review_notes  = COALESCE(p_review_notes, review_notes),
      reviewed_at   = CASE WHEN p_reviewed_by IS NOT NULL THEN now() ELSE reviewed_at END,
      updated_at    = now()
    WHERE id = p_document_id;

  ELSIF p_table_name = 'application_documents' THEN
    -- Use thread_id as canonical group for application_documents
    SELECT thread_id INTO v_group_id
    FROM public.application_documents WHERE id = p_document_id;

    IF v_group_id IS NULL THEN
      RAISE EXCEPTION 'Document not found: %', p_document_id;
    END IF;

    IF p_new_status = 'approved_final' THEN
      UPDATE public.application_documents
      SET review_status = 'superseded'
      WHERE thread_id = v_group_id
        AND review_status = 'approved_final'
        AND id != p_document_id;
    END IF;

    UPDATE public.application_documents
    SET
      review_status = p_new_status,
      reviewed_by   = COALESCE(p_reviewed_by, reviewed_by),
      review_notes  = COALESCE(p_review_notes, review_notes),
      reviewed_at   = CASE WHEN p_reviewed_by IS NOT NULL THEN now() ELSE reviewed_at END,
      updated_at    = now()
    WHERE id = p_document_id;

  ELSE
    RAISE EXCEPTION 'Unknown table_name: %. Must be borrower_documents or application_documents', p_table_name;
  END IF;

  RETURN true;
END;
$func$;

-- ─── SECTION 12: EXTEND application_activity event_type CHECK ─────────────────
-- AUDIT OF EXISTING CONSTRAINT:
--   Original (migration 20260412200000_activity_feed.sql):
--     'status_change', 'document_upload', 'admin_note', 'deadline_shift', 'system'
--
-- New values being added and justification:
--   document_revision_uploaded — required: new revision upload API writes this event
--   revision_requested         — required: Admin review PATCH writes this event
--   document_approved          — required: Admin approval PATCH writes this event
--   owner_assigned             — required: existing CRM contact/deal header already
--                                writes 'owner_assigned' events (BorrowerDetailContent,
--                                ContactDetailContent). Without this value those writes fail.
--   task_created               — required: existing Deal Detail Add Task action writes
--                                'task_created' to application_activity. Already in use.
--   email_sent                 — required: existing Deal Detail Email Client action writes
--                                'email_sent' to application_activity. Already in use.
--   call_logged                — required: existing Contact Detail Log Call action writes
--                                'call_logged' to application_activity. Already in use.
--
-- All 5 original values are preserved. No existing valid event type is removed.

ALTER TABLE public.application_activity
  DROP CONSTRAINT IF EXISTS application_activity_event_type_check;

ALTER TABLE public.application_activity
  ADD CONSTRAINT application_activity_event_type_check
  CHECK (event_type = ANY (ARRAY[
    -- Original 5 values (preserved exactly)
    'status_change',
    'document_upload',
    'admin_note',
    'deadline_shift',
    'system',
    -- Document versioning workflow (new — Step 3A)
    'document_revision_uploaded',
    'revision_requested',
    'document_approved',
    -- Already written by existing UI code (owner/task/email/call)
    'owner_assigned',
    'task_created',
    'email_sent',
    'call_logged'
  ]));

-- ─── VALIDATION NOTICE ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_bd_count        INTEGER;
  v_ad_count        INTEGER;
  v_bd_null_group   INTEGER;
  v_ad_multi_curr   INTEGER;
  v_bd_multi_curr   INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_bd_count FROM public.borrower_documents;
  SELECT COUNT(*) INTO v_ad_count FROM public.application_documents;
  SELECT COUNT(*) INTO v_bd_null_group FROM public.borrower_documents WHERE document_group_id IS NULL;

  -- Check for threads with multiple current versions (should be 0 after backfill)
  SELECT COUNT(*) INTO v_ad_multi_curr
  FROM (
    SELECT thread_id, COUNT(*) AS cnt
    FROM public.application_documents
    WHERE is_current_version = true AND thread_id IS NOT NULL
    GROUP BY thread_id
    HAVING COUNT(*) > 1
  ) sub;

  SELECT COUNT(*) INTO v_bd_multi_curr
  FROM (
    SELECT document_group_id, COUNT(*) AS cnt
    FROM public.borrower_documents
    WHERE is_current_version = true
    GROUP BY document_group_id
    HAVING COUNT(*) > 1
  ) sub;

  RAISE NOTICE '=== Document Versioning Migration Complete (REVISED) ===';
  RAISE NOTICE 'borrower_documents rows: % | NULL document_group_id: %', v_bd_count, v_bd_null_group;
  RAISE NOTICE 'application_documents rows: %', v_ad_count;
  RAISE NOTICE 'application_documents threads with multiple current versions: % (must be 0)', v_ad_multi_curr;
  RAISE NOTICE 'borrower_documents groups with multiple current versions: % (must be 0)', v_bd_multi_curr;
  RAISE NOTICE 'application_documents canonical fields: thread_id / revision_number / parent_document_id / is_current_version';
  RAISE NOTICE 'borrower_documents canonical fields: document_group_id / version_number / supersedes_document_id / is_current_version';
  RAISE NOTICE 'Duplicate fields NOT added to application_documents: document_group_id, version_number (as separate col), supersedes_document_id';

  IF v_bd_null_group > 0 THEN
    RAISE WARNING 'borrower_documents has % rows with NULL document_group_id — investigate before deploying', v_bd_null_group;
  END IF;
  IF v_ad_multi_curr > 0 THEN
    RAISE WARNING 'application_documents has % threads with multiple current versions — investigate before deploying', v_ad_multi_curr;
  END IF;
  IF v_bd_multi_curr > 0 THEN
    RAISE WARNING 'borrower_documents has % groups with multiple current versions — investigate before deploying', v_bd_multi_curr;
  END IF;
END $$;
