-- Migration: Admin Audit Logs
-- Tracks all admin views, edits, and data access events for compliance and security

-- ─── Audit event type enum ───────────────────────────────────────────────────
DROP TYPE IF EXISTS public.audit_event_type CASCADE;
CREATE TYPE public.audit_event_type AS ENUM (
  'view',
  'edit',
  'create',
  'delete',
  'status_change',
  'document_access',
  'login',
  'export'
);

-- ─── Audit logs table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        UUID NOT NULL,
  admin_email     TEXT NOT NULL,
  event_type      public.audit_event_type NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  borrower_id     UUID,
  borrower_email  TEXT,
  description     TEXT NOT NULL,
  old_value       JSONB,
  new_value       JSONB,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id    ON public.audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_borrower_id ON public.audit_logs(borrower_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type  ON public.audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at  ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource    ON public.audit_logs(resource_type, resource_id);

-- ─── Enable RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ─── RLS Policies ────────────────────────────────────────────────────────────
-- Only admins can read audit logs
DROP POLICY IF EXISTS "admins_read_audit_logs" ON public.audit_logs;
CREATE POLICY "admins_read_audit_logs"
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin_user());

-- Only admins can insert audit log entries
DROP POLICY IF EXISTS "admins_insert_audit_logs" ON public.audit_logs;
CREATE POLICY "admins_insert_audit_logs"
  ON public.audit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin_user());

-- No one can update or delete audit logs (immutable for compliance)
