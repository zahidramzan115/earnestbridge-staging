-- ============================================================
-- CRM Portal Claiming Trigger
-- When a new user registers and verifies their email,
-- automatically check for a matching CRM Contact and
-- set portal_link_status = 'pending' for Admin review.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crm_check_portal_user_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  matched_contact_id UUID;
  contact_name TEXT;
BEGIN
  -- Only fire when email_confirmed_at transitions from NULL to a value
  IF (TG_OP = 'UPDATE') THEN
    IF (OLD.email_confirmed_at IS NOT NULL) THEN
      RETURN NEW; -- Already confirmed, skip
    END IF;
    IF (NEW.email_confirmed_at IS NULL) THEN
      RETURN NEW; -- Not yet confirmed, skip
    END IF;
  END IF;

  -- Skip admin users
  IF (NEW.raw_user_meta_data->>'role' = 'admin' OR NEW.raw_app_meta_data->>'role' = 'admin') THEN
    RETURN NEW;
  END IF;

  -- Look for a matching CRM contact by email
  SELECT id, (first_name || ' ' || last_name)
  INTO matched_contact_id, contact_name
  FROM public.crm_contacts
  WHERE lower(trim(primary_email)) = lower(trim(NEW.email))
    AND is_merged = false
    AND portal_user_id IS NULL  -- Not already linked
  LIMIT 1;

  IF matched_contact_id IS NOT NULL THEN
    -- Link the user to the contact with pending status
    UPDATE public.crm_contacts
    SET
      portal_user_id = NEW.id,
      portal_link_status = 'pending',
      portal_linked_at = now(),
      updated_at = now()
    WHERE id = matched_contact_id;

    -- Log activity
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

    -- Create in-app notification for admin
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      message,
      crm_contact_id
    )
    SELECT
      au.id,
      'crm_portal_match',
      'Portal Account Match: ' || contact_name,
      NEW.email || ' registered and matches existing CRM Contact. Review and approve portal access.',
      matched_contact_id
    FROM auth.users au
    WHERE au.raw_app_meta_data->>'role' = 'admin'
       OR au.raw_user_meta_data->>'role' = 'admin'
    LIMIT 5;

  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'CRM portal match check failed for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_portal_user_match_trigger ON auth.users;
CREATE TRIGGER crm_portal_user_match_trigger
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_check_portal_user_match();
