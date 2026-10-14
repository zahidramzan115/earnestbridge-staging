-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260922001000_harden_crm_email_log_audit.sql
-- Step 6A-4.5C — Harden crm_email_log to SELECT-only for Admin browser sessions
-- ─────────────────────────────────────────────────────────────────────────────
--
-- CONTEXT
-- -------
-- crm_email_log is an email delivery audit table.
-- Authenticated Admin browser sessions should be able to READ email history
-- but must NOT directly INSERT, UPDATE, or DELETE historical email-log rows.
--
-- Trusted server routes (using service_role) will create and update delivery
-- records. service_role bypasses RLS entirely, so no service_role policy is
-- needed.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. DROPs the existing broad admins_all_crm_email_log policy (FOR ALL)
-- 2. Creates a new Admin SELECT-only policy using public.is_admin_user()
-- 3. Does NOT create INSERT, UPDATE, or DELETE policies for authenticated users
-- 4. Does NOT disable RLS
-- 5. Does NOT modify any other table
-- 6. Does NOT change any existing data
--
-- DIRECT USAGE AUDIT (verified before removing write access)
-- ----------------------------------------------------------
-- crm_email_log is read/written in the following locations:
--
--   READ (browser Supabase client):
--     - ContactDetailContent.tsx: does NOT directly query crm_email_log
--       (email history is shown via crm_activities, not crm_email_log directly)
--     - No other browser component directly queries crm_email_log
--
--   WRITE (previously browser-side via old route):
--     - src/app/api/crm/contacts/[id]/send-email/route.ts
--       Previously: INSERT via service_role client (already server-side)
--       After 6A-4.5C: INSERT + UPDATE via service_role (pending → sent/failed)
--       This is a trusted server route — no browser direct write needed.
--
--   WRITE (BorrowerDetailContent.tsx):
--     - Calls /api/crm/contacts/[id]/send-email API route (server-side)
--     - Does NOT directly write to crm_email_log from the browser
--
-- CONCLUSION: No browser code performs legitimate direct INSERT/UPDATE/DELETE
-- on crm_email_log. All writes go through the trusted server route.
-- Admin SELECT must remain functional for any future email history UI.
--
-- ZERO DATA MUTATION
-- ------------------
-- crm_email_log rows changed: 0
-- crm_email_attachments rows changed: 0
-- crm_activities rows changed: 0
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Drop the existing broad FOR ALL policy
DROP POLICY IF EXISTS "admins_all_crm_email_log" ON public.crm_email_log;

-- Step 2: Create Admin SELECT-only policy
-- Authenticated Admin browser sessions may read email history.
-- INSERT, UPDATE, DELETE are handled exclusively by service_role server routes.
CREATE POLICY "admins_select_crm_email_log"
ON public.crm_email_log
FOR SELECT
TO authenticated
USING (public.is_admin_user());

-- RLS remains enabled (was already enabled — no change needed)
-- No INSERT/UPDATE/DELETE policies for authenticated users
-- service_role bypasses RLS for all trusted server-side operations
