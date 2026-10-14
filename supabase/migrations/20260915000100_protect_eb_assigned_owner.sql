-- Migration: protect_eb_assigned_owner
-- Prevents borrower sessions from directly mutating borrower_applications.eb_assigned_owner.
--
-- APPROACH: Option A (service_role allowed)
--   The existing PATCH /api/admin/update-deal-owner endpoint authenticates the Admin
--   session server-side and then performs the write using the service-role client.
--   This trigger allows service_role writes so that endpoint continues to work.
--   The endpoint's own server-side Admin verification is the authorization gate;
--   the trigger is the database-layer safety net.
--
-- SCOPE: ONLY eb_assigned_owner is protected here.
--   Normal borrower application editing (all other columns) is unaffected.
--   No existing RLS policies are altered or deleted.
--
-- DOES NOT log owner activity — activity logging remains solely in the API endpoint
--   to prevent duplicate entries.

-- ─── Trigger function ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_eb_assigned_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_role TEXT;
BEGIN
  -- Only act when eb_assigned_owner is actually changing
  IF NEW.eb_assigned_owner IS NOT DISTINCT FROM OLD.eb_assigned_owner THEN
    RETURN NEW;
  END IF;

  -- Determine the effective database role of the current session
  v_role := current_setting('role', true);

  -- service_role bypasses this guard (used by the trusted Admin API endpoint)
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Authenticated Admin sessions are also permitted
  IF public.is_admin_user() THEN
    RETURN NEW;
  END IF;

  -- All other callers (borrowers, anonymous, etc.) are denied
  RAISE EXCEPTION
    'Permission denied: eb_assigned_owner may only be changed by an EarnestBridge Admin.'
    USING ERRCODE = 'insufficient_privilege';
END;
$func$;

-- ─── Attach trigger to borrower_applications ─────────────────────────────────
DROP TRIGGER IF EXISTS guard_eb_assigned_owner ON public.borrower_applications;
CREATE TRIGGER guard_eb_assigned_owner
  BEFORE UPDATE ON public.borrower_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_eb_assigned_owner();
