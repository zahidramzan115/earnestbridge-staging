-- ============================================================
-- CRM Data Migration: Link existing portal users to CRM contacts
-- Safe, non-destructive migration.
-- Creates CRM Contact records for existing portal Users.
-- Links them. Associates existing Deals.
-- Preserves all existing portal functionality.
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  new_contact_id UUID;
  existing_contact_id UUID;
BEGIN
  -- For each existing borrower_application that has a user_id,
  -- create a CRM contact if one doesn't already exist for that email.
  FOR rec IN
    SELECT DISTINCT ON (lower(trim(email)))
      user_id,
      first_name,
      last_name,
      email,
      phone,
      company_name,
      id AS app_id
    FROM public.borrower_applications
    WHERE user_id IS NOT NULL
      AND email IS NOT NULL
      AND email != ''
    ORDER BY lower(trim(email)), created_at ASC
  LOOP
    BEGIN
      -- Check if a contact already exists for this email
      SELECT id INTO existing_contact_id
      FROM public.crm_contacts
      WHERE lower(trim(primary_email)) = lower(trim(rec.email))
        AND is_merged = false
      LIMIT 1;

      IF existing_contact_id IS NULL THEN
        -- Create new CRM contact linked to this portal user
        INSERT INTO public.crm_contacts (
          first_name,
          last_name,
          primary_email,
          phone,
          lead_status,
          assigned_owner,
          lead_source,
          portal_user_id,
          portal_link_status,
          portal_linked_at,
          portal_approved_at
        ) VALUES (
          COALESCE(NULLIF(trim(rec.first_name), ''), 'Unknown'),
          COALESCE(NULLIF(trim(rec.last_name), ''), ''),
          lower(trim(rec.email)),
          rec.phone,
          'Client',
          'Unassigned',
          'Portal Registration',
          rec.user_id,
          'approved',
          now(),
          now()
        )
        RETURNING id INTO new_contact_id;

        -- Log activity
        INSERT INTO public.crm_activities (
          contact_id,
          event_type,
          title,
          detail,
          actor
        ) VALUES (
          new_contact_id,
          'contact_created',
          'Contact created from existing portal user',
          'Migrated from portal registration. Email: ' || rec.email,
          'System Migration'
        );

      ELSE
        new_contact_id := existing_contact_id;

        -- If contact exists but has no portal link, link it now
        UPDATE public.crm_contacts
        SET
          portal_user_id = rec.user_id,
          portal_link_status = 'approved',
          portal_linked_at = COALESCE(portal_linked_at, now()),
          portal_approved_at = COALESCE(portal_approved_at, now())
        WHERE id = new_contact_id
          AND portal_user_id IS NULL;
      END IF;

      -- Associate all deals for this user with the contact (as primary)
      INSERT INTO public.crm_deal_contacts (deal_id, contact_id, role)
      SELECT ba.id, new_contact_id, 'primary'
      FROM public.borrower_applications ba
      WHERE ba.user_id = rec.user_id
      ON CONFLICT (deal_id, contact_id) DO NOTHING;

      -- Update borrower_applications.primary_contact_id where not already set
      UPDATE public.borrower_applications
      SET primary_contact_id = new_contact_id
      WHERE user_id = rec.user_id
        AND primary_contact_id IS NULL;

    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'CRM migration skipped for email %: %', rec.email, SQLERRM;
    END;
  END LOOP;

  -- Also handle admin-created deals (user_id IS NULL, client_email set)
  FOR rec IN
    SELECT DISTINCT ON (lower(trim(client_email)))
      NULL::UUID AS user_id,
      first_name,
      last_name,
      client_email AS email,
      phone,
      company_name,
      id AS app_id
    FROM public.borrower_applications
    WHERE user_id IS NULL
      AND client_email IS NOT NULL
      AND client_email != ''
    ORDER BY lower(trim(client_email)), created_at ASC
  LOOP
    BEGIN
      SELECT id INTO existing_contact_id
      FROM public.crm_contacts
      WHERE lower(trim(primary_email)) = lower(trim(rec.email))
        AND is_merged = false
      LIMIT 1;

      IF existing_contact_id IS NULL THEN
        INSERT INTO public.crm_contacts (
          first_name,
          last_name,
          primary_email,
          phone,
          lead_status,
          assigned_owner,
          lead_source,
          portal_link_status
        ) VALUES (
          COALESCE(NULLIF(trim(rec.first_name), ''), 'Unknown'),
          COALESCE(NULLIF(trim(rec.last_name), ''), ''),
          lower(trim(rec.email)),
          rec.phone,
          'Deal Submitted',
          'Unassigned',
          'Admin Created Deal',
          'none'
        )
        RETURNING id INTO new_contact_id;

        INSERT INTO public.crm_activities (
          contact_id,
          event_type,
          title,
          detail,
          actor
        ) VALUES (
          new_contact_id,
          'contact_created',
          'Contact created from admin-created deal',
          'Migrated from admin-created deal. Email: ' || rec.email,
          'System Migration'
        );
      ELSE
        new_contact_id := existing_contact_id;
      END IF;

      INSERT INTO public.crm_deal_contacts (deal_id, contact_id, role)
      SELECT ba.id, new_contact_id, 'primary'
      FROM public.borrower_applications ba
      WHERE ba.client_email = rec.email
        AND ba.user_id IS NULL
      ON CONFLICT (deal_id, contact_id) DO NOTHING;

      UPDATE public.borrower_applications
      SET primary_contact_id = new_contact_id
      WHERE client_email = rec.email
        AND user_id IS NULL
        AND primary_contact_id IS NULL;

    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'CRM migration skipped for admin deal email %: %', rec.email, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'CRM data migration completed successfully.';
END $$;
