-- ============================================================
-- Extend audit_event_type enum with document-related values
-- Must be in a separate migration so new values are committed
-- before they can be referenced in subsequent migrations.
-- ============================================================

ALTER TYPE public.audit_event_type ADD VALUE IF NOT EXISTS 'document_upload';
ALTER TYPE public.audit_event_type ADD VALUE IF NOT EXISTS 'document_download';
