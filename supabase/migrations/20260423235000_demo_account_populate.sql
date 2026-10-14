-- Demo Account: Fix auth and populate with realistic borrower data
-- Demo credentials: marcus.reid@reidcapitalgroup.com / EarnestBridge#2026

DO $$
DECLARE
  demo_id UUID;
  app1_id UUID := gen_random_uuid();
  app2_id UUID := gen_random_uuid();
  app3_id UUID := gen_random_uuid();
  app4_id UUID := gen_random_uuid();
  app5_id UUID := gen_random_uuid();
BEGIN
  -- ── 1. Fix / create demo auth user ────────────────────────────────────────
  SELECT id INTO demo_id FROM auth.users WHERE email = 'marcus.reid@reidcapitalgroup.com';

  IF demo_id IS NULL THEN
    demo_id := gen_random_uuid();
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_user_meta_data, raw_app_meta_data,
      is_sso_user, is_anonymous, confirmation_token, confirmation_sent_at,
      recovery_token, recovery_sent_at, email_change_token_new, email_change,
      email_change_sent_at, email_change_token_current, email_change_confirm_status,
      reauthentication_token, reauthentication_sent_at, phone, phone_change,
      phone_change_token, phone_change_sent_at
    ) VALUES (
      demo_id,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'marcus.reid@reidcapitalgroup.com',
      crypt('EarnestBridge#2026', gen_salt('bf', 10)),
      now(),
      now(),
      now(),
      jsonb_build_object('full_name', 'Marcus Reid', 'role', 'borrower'),
      jsonb_build_object('provider', 'email', 'providers', ARRAY['email']::TEXT[]),
      false, false, '', null, '', null, '', '', null, '', 0, '', null, null, '', '', null
    );
  ELSE
    -- Ensure account is confirmed and password is correct
    UPDATE auth.users
    SET
      encrypted_password  = crypt('EarnestBridge#2026', gen_salt('bf', 10)),
      email_confirmed_at  = COALESCE(email_confirmed_at, now()),
      confirmed_at        = COALESCE(confirmed_at, now()),
      raw_user_meta_data  = jsonb_build_object('full_name', 'Marcus Reid', 'role', 'borrower'),
      raw_app_meta_data   = jsonb_build_object('provider', 'email', 'providers', ARRAY['email']::TEXT[]),
      confirmation_token  = '',
      recovery_token      = '',
      updated_at          = now()
    WHERE id = demo_id;
  END IF;

  -- Ensure identity record exists for signInWithPassword
  DELETE FROM auth.identities
  WHERE user_id = demo_id AND provider = 'email';

  INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(),
    demo_id,
    'marcus.reid@reidcapitalgroup.com',
    jsonb_build_object(
      'sub', demo_id::text,
      'email', 'marcus.reid@reidcapitalgroup.com',
      'email_verified', true
    ),
    'email',
    now(), now(), now()
  );

  -- ── 2. Remove any existing demo applications to avoid duplicates ──────────
  DELETE FROM public.application_activity WHERE user_id = demo_id;
  DELETE FROM public.borrower_documents    WHERE user_id = demo_id;
  DELETE FROM public.notifications         WHERE user_id = demo_id;
  DELETE FROM public.borrower_applications WHERE user_id = demo_id;

  -- ── 3. Insert demo applications ───────────────────────────────────────────
  -- App 1: Approved deal (active, closing in 7 days) — $18.2M Industrial
  INSERT INTO public.borrower_applications (
    id, user_id, first_name, last_name, email, phone, agreed_to_terms,
    deposit_amount, company_name, company_type, property_address, property_type,
    purchase_price, closing_date, identity_method, identity_verified,
    app_status, days_to_funding, submitted_at, created_at, updated_at
  ) VALUES (
    app1_id, demo_id, 'Marcus', 'Reid', 'marcus.reid@reidcapitalgroup.com', '(512) 555-0182',
    true, 500000, 'Harbor Point Industrial Park', 'LLC',
    '1102 Commerce Dr, Houston, TX 77032', 'Industrial',
    18200000, (CURRENT_DATE + INTERVAL '7 days')::date,
    'id_selfie', true, 'approved', NULL,
    now() - INTERVAL '26 days', now() - INTERVAL '28 days', now() - INTERVAL '1 day'
  );

  -- App 2: Under review (multifamily) — $5.75M
  INSERT INTO public.borrower_applications (
    id, user_id, first_name, last_name, email, phone, agreed_to_terms,
    deposit_amount, company_name, company_type, property_address, property_type,
    purchase_price, closing_date, identity_method, identity_verified,
    app_status, days_to_funding, submitted_at, created_at, updated_at
  ) VALUES (
    app2_id, demo_id, 'Marcus', 'Reid', 'marcus.reid@reidcapitalgroup.com', '(512) 555-0182',
    true, 175000, 'Midtown Lofts Portfolio', 'LLC',
    '308 W 5th St, Charlotte, NC 28202', 'Multifamily',
    5750000, (CURRENT_DATE + INTERVAL '22 days')::date,
    'id_selfie', true, 'under_review', NULL,
    now() - INTERVAL '21 days', now() - INTERVAL '22 days', now() - INTERVAL '2 days'
  );

  -- App 3: Submitted (retail) — $11.4M
  INSERT INTO public.borrower_applications (
    id, user_id, first_name, last_name, email, phone, agreed_to_terms,
    deposit_amount, company_name, company_type, property_address, property_type,
    purchase_price, closing_date, identity_method, identity_verified,
    app_status, days_to_funding, submitted_at, created_at, updated_at
  ) VALUES (
    app3_id, demo_id, 'Marcus', 'Reid', 'marcus.reid@reidcapitalgroup.com', '(512) 555-0182',
    true, 320000, 'Riverside Retail Center', 'LLC',
    '9900 Riverside Pkwy, Atlanta, GA 30339', 'Retail',
    11400000, (CURRENT_DATE + INTERVAL '35 days')::date,
    'id_selfie', true, 'submitted', NULL,
    now() - INTERVAL '7 days', now() - INTERVAL '8 days', now() - INTERVAL '7 days'
  );

  -- App 4: Funded/Closed deal (historical) — $8.5M Multifamily, EMD $250K returned
  INSERT INTO public.borrower_applications (
    id, user_id, first_name, last_name, email, phone, agreed_to_terms,
    deposit_amount, company_name, company_type, property_address, property_type,
    purchase_price, closing_date, identity_method, identity_verified,
    app_status, days_to_funding, submitted_at, created_at, updated_at
  ) VALUES (
    app4_id, demo_id, 'Marcus', 'Reid', 'marcus.reid@reidcapitalgroup.com', '(512) 555-0182',
    true, 250000, 'Westlake Commons Acquisition', 'LLC',
    '4821 Westlake Blvd, Austin, TX 78746', 'Multifamily',
    8500000, (CURRENT_DATE - INTERVAL '25 days')::date,
    'id_selfie', true, 'funded', 30,
    now() - INTERVAL '55 days', now() - INTERVAL '60 days', now() - INTERVAL '25 days'
  );

  -- App 5: Draft (mixed-use, in progress) — $9.8M
  INSERT INTO public.borrower_applications (
    id, user_id, first_name, last_name, email, phone, agreed_to_terms,
    deposit_amount, company_name, company_type, property_address, property_type,
    purchase_price, closing_date, identity_method, identity_verified,
    app_status, days_to_funding, submitted_at, created_at, updated_at
  ) VALUES (
    app5_id, demo_id, 'Marcus', 'Reid', 'marcus.reid@reidcapitalgroup.com', '(512) 555-0182',
    false, 280000, 'Northgate Mixed-Use Development', 'LLC',
    '5501 N Lamar Blvd, Austin, TX 78751', 'Mixed-Use',
    9800000, (CURRENT_DATE + INTERVAL '60 days')::date,
    null, false, 'draft', NULL,
    null, now() - INTERVAL '2 days', now() - INTERVAL '2 days'
  );

  -- ── 4. Insert demo documents ───────────────────────────────────────────────
  -- App 1 (approved) — LOI approved, PSA approved, ID approved
  INSERT INTO public.borrower_documents (
    id, user_id, application_id, document_name, document_type, category,
    file_name, file_size, mime_type, doc_status, uploaded_at, created_at, updated_at
  ) VALUES
    (gen_random_uuid(), demo_id, app1_id, 'Letter of Intent (LOI)', 'loi', 'legal',
     'harbor_point_loi.pdf', 245760, 'application/pdf', 'approved',
     now() - INTERVAL '25 days', now() - INTERVAL '25 days', now() - INTERVAL '20 days'),
    (gen_random_uuid(), demo_id, app1_id, 'Purchase & Sale Agreement', 'psa', 'legal',
     'harbor_point_psa.pdf', 512000, 'application/pdf', 'approved',
     now() - INTERVAL '24 days', now() - INTERVAL '24 days', now() - INTERVAL '18 days'),
    (gen_random_uuid(), demo_id, app1_id, 'Government-Issued ID', 'identity', 'identity',
     'marcus_reid_id.pdf', 102400, 'application/pdf', 'approved',
     now() - INTERVAL '26 days', now() - INTERVAL '26 days', now() - INTERVAL '20 days');

  -- App 2 (under_review) — LOI uploaded, ID approved, Phase I pending
  INSERT INTO public.borrower_documents (
    id, user_id, application_id, document_name, document_type, category,
    file_name, file_size, mime_type, doc_status, uploaded_at, created_at, updated_at
  ) VALUES
    (gen_random_uuid(), demo_id, app2_id, 'Letter of Intent (LOI)', 'loi', 'legal',
     'midtown_lofts_loi.pdf', 198000, 'application/pdf', 'uploaded',
     now() - INTERVAL '20 days', now() - INTERVAL '20 days', now() - INTERVAL '20 days'),
    (gen_random_uuid(), demo_id, app2_id, 'Government-Issued ID', 'identity', 'identity',
     'marcus_reid_id.pdf', 102400, 'application/pdf', 'approved',
     now() - INTERVAL '21 days', now() - INTERVAL '21 days', now() - INTERVAL '15 days'),
    (gen_random_uuid(), demo_id, app2_id, 'Phase I Environmental Report', 'environmental', 'property',
     null, null, null, 'pending',
     null, now() - INTERVAL '10 days', now() - INTERVAL '10 days');

  -- App 3 (submitted) — LOI uploaded, ID uploaded
  INSERT INTO public.borrower_documents (
    id, user_id, application_id, document_name, document_type, category,
    file_name, file_size, mime_type, doc_status, uploaded_at, created_at, updated_at
  ) VALUES
    (gen_random_uuid(), demo_id, app3_id, 'Letter of Intent (LOI)', 'loi', 'legal',
     'riverside_retail_loi.pdf', 220000, 'application/pdf', 'uploaded',
     now() - INTERVAL '7 days', now() - INTERVAL '7 days', now() - INTERVAL '7 days'),
    (gen_random_uuid(), demo_id, app3_id, 'Government-Issued ID', 'identity', 'identity',
     'marcus_reid_id.pdf', 102400, 'application/pdf', 'uploaded',
     now() - INTERVAL '7 days', now() - INTERVAL '7 days', now() - INTERVAL '7 days');

  -- App 4 (funded/closed) — all docs approved
  INSERT INTO public.borrower_documents (
    id, user_id, application_id, document_name, document_type, category,
    file_name, file_size, mime_type, doc_status, uploaded_at, created_at, updated_at
  ) VALUES
    (gen_random_uuid(), demo_id, app4_id, 'Letter of Intent (LOI)', 'loi', 'legal',
     'westlake_commons_loi.pdf', 210000, 'application/pdf', 'approved',
     now() - INTERVAL '54 days', now() - INTERVAL '54 days', now() - INTERVAL '50 days'),
    (gen_random_uuid(), demo_id, app4_id, 'Purchase & Sale Agreement', 'psa', 'legal',
     'westlake_commons_psa.pdf', 480000, 'application/pdf', 'approved',
     now() - INTERVAL '53 days', now() - INTERVAL '53 days', now() - INTERVAL '48 days'),
    (gen_random_uuid(), demo_id, app4_id, 'Government-Issued ID', 'identity', 'identity',
     'marcus_reid_id.pdf', 102400, 'application/pdf', 'approved',
     now() - INTERVAL '55 days', now() - INTERVAL '55 days', now() - INTERVAL '50 days');

  -- ── 5. Insert demo notifications ──────────────────────────────────────────
  INSERT INTO public.notifications (
    id, user_id, type, title, message, is_read, action_url, action_label, created_at
  ) VALUES
    (gen_random_uuid(), demo_id, 'status_change',
     'Application Approved — Harbor Point',
     'Your EMD application for Harbor Point Industrial Park has been approved. Funding is being prepared for the $500,000 EMD.',
     false, '/application-status', 'View Status',
     now() - INTERVAL '1 day'),
    (gen_random_uuid(), demo_id, 'deadline_reminder',
     'Closing in 7 Days — Harbor Point',
     'Harbor Point Industrial Park ($18.2M) is scheduled to close in 7 days. Please ensure all documents are in order.',
     false, '/application-status', 'View Details',
     now() - INTERVAL '12 hours'),
    (gen_random_uuid(), demo_id, 'required_action',
     'Document Required — Midtown Lofts',
     'Please upload the Phase I Environmental Report for Midtown Lofts Portfolio to continue underwriting review.',
     false, '/documents', 'Upload Now',
     now() - INTERVAL '2 days'),
    (gen_random_uuid(), demo_id, 'status_change',
     'Application Under Review — Midtown Lofts',
     'Your application for Midtown Lofts Portfolio is now under review by our underwriting team. Expected: 3–5 business days.',
     true, '/application-status', 'View Status',
     now() - INTERVAL '5 days'),
    (gen_random_uuid(), demo_id, 'system_message',
     'Application Received — Riverside Retail',
     'We have received your application for Riverside Retail Center ($11.4M). Our team will begin review within 24 hours.',
     true, '/application-status', 'View Status',
     now() - INTERVAL '7 days'),
    (gen_random_uuid(), demo_id, 'document_decision',
     'LOI Approved — Harbor Point',
     'Your Letter of Intent for Harbor Point Industrial Park has been reviewed and approved by our legal team.',
     true, '/documents', 'View Documents',
     now() - INTERVAL '20 days'),
    (gen_random_uuid(), demo_id, 'status_change',
     'Deal Funded — Westlake Commons',
     'Congratulations! Westlake Commons Acquisition ($8.5M) has been successfully funded and closed. EMD of $250,000 has been returned.',
     true, '/application-status', 'View History',
     now() - INTERVAL '25 days');

  -- ── 6. Insert demo activity feed ──────────────────────────────────────────
  INSERT INTO public.application_activity (
    id, application_id, user_id, event_type, title, detail, actor, created_at
  ) VALUES
    -- App 1 activity (Harbor Point — Approved, closing in 7 days)
    (gen_random_uuid(), app1_id::text, demo_id, 'status_change',
     'Application Approved',
     'EMD application approved. Funding team has been notified to initiate wire transfer for $500,000 EMD.',
     'EarnestBridge Team', now() - INTERVAL '1 day'),
    (gen_random_uuid(), app1_id::text, demo_id, 'document_upload',
     'PSA Reviewed and Approved',
     'Purchase and Sale Agreement has been reviewed and approved by our legal team.',
     'EarnestBridge Legal', now() - INTERVAL '18 days'),
    (gen_random_uuid(), app1_id::text, demo_id, 'document_upload',
     'LOI Approved',
     'Letter of Intent has been verified and approved.',
     'EarnestBridge Team', now() - INTERVAL '20 days'),
    (gen_random_uuid(), app1_id::text, demo_id, 'status_change',
     'Application Submitted',
     'Application for Harbor Point Industrial Park submitted successfully.',
     'Marcus Reid', now() - INTERVAL '26 days'),
    -- App 2 activity (Midtown Lofts — Under Review)
    (gen_random_uuid(), app2_id::text, demo_id, 'admin_note',
     'Additional Document Requested',
     'Please provide Phase I Environmental Report to complete underwriting review.',
     'EarnestBridge Underwriting', now() - INTERVAL '2 days'),
    (gen_random_uuid(), app2_id::text, demo_id, 'status_change',
     'Under Review',
     'Application is now under review by our underwriting team. Expected review time: 3–5 business days.',
     'EarnestBridge Team', now() - INTERVAL '5 days'),
    (gen_random_uuid(), app2_id::text, demo_id, 'document_upload',
     'LOI Uploaded',
     'Letter of Intent uploaded and pending review.',
     'Marcus Reid', now() - INTERVAL '20 days'),
    -- App 3 activity (Riverside Retail — Submitted)
    (gen_random_uuid(), app3_id::text, demo_id, 'status_change',
     'Application Submitted',
     'Application for Riverside Retail Center submitted. Our team will begin initial review within 24 hours.',
     'Marcus Reid', now() - INTERVAL '7 days'),
    -- App 4 activity (Westlake Commons — Funded/Closed)
    (gen_random_uuid(), app4_id::text, demo_id, 'status_change',
     'Deal Funded & Closed',
     'Westlake Commons Acquisition has closed successfully. EMD of $250,000 has been returned per agreement terms.',
     'EarnestBridge Team', now() - INTERVAL '25 days'),
    (gen_random_uuid(), app4_id::text, demo_id, 'status_change',
     'Application Approved',
     'EMD application for Westlake Commons Acquisition approved. Funding initiated for $250,000 EMD.',
     'EarnestBridge Team', now() - INTERVAL '40 days');

  RAISE NOTICE 'Demo account populated successfully. User ID: %', demo_id;

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Demo account setup error: %', SQLERRM;
END $$;
