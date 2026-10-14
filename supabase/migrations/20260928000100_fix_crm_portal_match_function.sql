-- ============================================================
-- Portal CRM Repair 1B — Fix Broken Portal Match Trigger
-- Replaces public.crm_check_portal_user_match() only.
-- Does NOT modify the trigger definition.
-- Does NOT alter the notification_type enum.
-- Does NOT backfill or modify any production data rows.
-- ============================================================
--
-- ROOT CAUSE FIXED:
--   The previous function inserted notifications.type = 'crm_portal_match'
--   which is not a valid notification_type enum value. The outer
--   EXCEPTION WHEN OTHERS block silently rolled back the crm_contacts
--   UPDATE and crm_activities INSERT, leaving the Contact unlinked.
--
-- CHANGES:
--   1. Replace invalid 'crm_portal_match' with valid 'system_message'.
--   2. Restructure failure isolation:
--      - crm_contacts UPDATE is the primary operation (no exception wrapper).
--      - crm_activities INSERT is wrapped in its own nested BEGIN/EXCEPTION.
--      - notifications INSERT is wrapped in its own nested BEGIN/EXCEPTION.
--      - Side-effect failures log a NOTICE but do NOT roll back the Contact link.
--   3. Remove the outer EXCEPTION WHEN OTHERS that was swallowing all errors.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crm_check_portal_user_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  matched_contact_id UUID;
  contact_name       TEXT;
BEGIN
  -- ── Guard: only act on UPDATE where email_confirmed_at transitions NULL → non-NULL
  IF (TG_OP = 'UPDATE') THEN
    IF (OLD.email_confirmed_at IS NOT NULL) THEN
      RETURN NEW; -- Already confirmed previously, skip
    END IF;
    IF (NEW.email_confirmed_at IS NULL) THEN
      RETURN NEW; -- Still not confirmed, skip
    END IF;
  END IF;

  -- ── Guard: skip admin users
  IF (NEW.raw_user_meta_data->>'role' = 'admin'
      OR NEW.raw_app_meta_data->>'role' = 'admin') THEN
    RETURN NEW;
  END IF;

  -- ── Match: find an unlinked, non-merged CRM Contact by email
  SELECT id, (first_name || ' ' || last_name)
  INTO   matched_contact_id, contact_name
  FROM   public.crm_contacts
  WHERE  lower(trim(primary_email)) = lower(trim(NEW.email))
    AND  is_merged = false
    AND  portal_user_id IS NULL
  LIMIT 1;

  IF matched_contact_id IS NULL THEN
    RETURN NEW; -- No matching contact found; nothing to do
  END IF;

  -- ══════════════════════════════════════════════════════════════
  -- PRIMARY OPERATION: link the Auth user to the CRM Contact.
  -- This UPDATE is NOT wrapped in a catch-all exception block so
  -- that a genuine DB error surfaces rather than being swallowed.
  -- Side-effect failures below cannot roll this back.
  -- ══════════════════════════════════════════════════════════════
  UPDATE public.crm_contacts
  SET
    portal_user_id    = NEW.id,
    portal_link_status = 'pending',
    portal_linked_at  = now(),
    updated_at        = now()
  WHERE id = matched_contact_id;

  -- ══════════════════════════════════════════════════════════════
  -- SIDE EFFECT 1: activity log
  -- Wrapped in its own BEGIN/EXCEPTION so a failure here does NOT
  -- roll back the crm_contacts UPDATE above.
  -- ══════════════════════════════════════════════════════════════
  BEGIN
    INSERT INTO public.crm_activities (
      contact_id,
      event_type,
      title,
      detail,
      actor,
      actor_user_id
    ) VALUES (
      matched_contact_id,
      'portal_account_registered',
      'Portal account registered — pending Admin approval',
      'User registered with email ' || NEW.email || '. Portal access pending Admin review.',
      'System',
      NEW.id
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'crm_check_portal_user_match: activity log failed for contact % user %: %',
                   matched_contact_id, NEW.id, SQLERRM;
  END;

  -- ══════════════════════════════════════════════════════════════
  -- SIDE EFFECT 2: admin notifications
  -- Wrapped in its own BEGIN/EXCEPTION so a failure here does NOT
  -- roll back the crm_contacts UPDATE above.
  -- Uses valid enum value 'system_message' (replaces invalid 'crm_portal_match').
  -- ══════════════════════════════════════════════════════════════
  BEGIN
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      message,
      crm_contact_id
    )
    SELECT
      au.id,
      'system_message'::public.notification_type,
      'Portal Account Match: ' || contact_name,
      NEW.email || ' registered and matches existing CRM Contact. Review and approve portal access.',
      matched_contact_id
    FROM auth.users au
    WHERE au.raw_app_meta_data->>'role' = 'admin'
       OR au.raw_user_meta_data->>'role' = 'admin'
    LIMIT 5;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'crm_check_portal_user_match: notification insert failed for contact % user %: %',
                   matched_contact_id, NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$func$;

-- Grant execute to postgres role (matches original migration pattern)
GRANT EXECUTE ON FUNCTION public.crm_check_portal_user_match() TO postgres;
