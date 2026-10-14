-- ============================================================
-- Migration: harden_admin_authorization
-- Timestamp: 20260915004000
--
-- PURPOSE
-- -------
-- Fix is_admin_user() and is_admin() to rely ONLY on
-- raw_app_meta_data->>'role' = 'admin' (server-controlled).
--
-- raw_user_meta_data is user-controlled and MUST NOT be used
-- to grant EarnestBridge Admin privileges.
--
-- SCOPE
-- -----
-- 1. Recreate is_admin_user() — app_metadata only
-- 2. Recreate is_admin()      — app_metadata only (alias used by older policies)
--
-- WHAT IS NOT CHANGED
-- -------------------
-- - crm_deal_deadlines schema
-- - Any other table or policy
-- - Admin user records in auth.users (both raw_app_meta_data
--   and raw_user_meta_data already have role=admin for the
--   seeded admin accounts; app_metadata is sufficient)
--
-- SECURITY RATIONALE
-- ------------------
-- raw_user_meta_data can be written by the user via
-- supabase.auth.updateUser(). raw_app_meta_data can only be
-- written by the service role or Supabase dashboard — it is
-- server-controlled and safe for privilege decisions.
-- ============================================================


-- ─── 1. Fix is_admin_user() — app_metadata only ──────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
  SELECT EXISTS (
    SELECT 1 FROM auth.users au
    WHERE au.id = auth.uid()
      AND au.raw_app_meta_data->>'role' = 'admin'
  )
$func$;


-- ─── 2. Fix is_admin() — app_metadata only ───────────────────────────────────
-- is_admin() is an older alias used by policies created in
-- 20260414002325_admin_credentials.sql. Apply the same fix.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
  SELECT EXISTS (
    SELECT 1 FROM auth.users au
    WHERE au.id = auth.uid()
      AND au.raw_app_meta_data->>'role' = 'admin'
  )
$func$;
