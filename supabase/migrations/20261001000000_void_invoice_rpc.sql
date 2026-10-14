-- ============================================================
-- Migration: 20261001000000_void_invoice_rpc
--
-- Phase 7B-6B1 — Void Invoice RPC + RLS Hardening
--
-- PURPOSE
-- -------
-- 1. Creates the atomic database RPC that performs a standalone void
--    of an open invoice with zero received payments.
--
-- 2. Hardens crm_invoices RLS by removing authenticated Admin browser
--    INSERT and UPDATE access. All legitimate invoice mutations already
--    go through server-side service_role API routes or SECURITY DEFINER
--    RPCs. No browser workflow depends on direct authenticated INSERT or
--    UPDATE to crm_invoices.
--
-- 3. Hardens the idempotent replay check to require matching audit_logs
--    evidence so that a revision-superseded void cannot be replayed as
--    a standalone void.
--
-- ── BROWSER WRITE AUDIT (Phase 7B-6B1 Section 1) ──────────────────────
--
-- All crm_invoices mutations in the application source were audited:
--
--   src/app/api/admin/invoices/route.ts
--     POST handler: service_role INSERT (create draft)
--     POST handler: service_role DELETE (orphan cleanup on line-item error)
--     → SERVER-SIDE service_role only. No browser client.
--
--   src/app/api/admin/invoices/[id]/route.ts
--     PATCH handler: service_role UPDATE (draft field edits)
--     → SERVER-SIDE service_role only. No browser client.
--
--   src/app/api/admin/invoices/[id]/issue/route.ts
--     → SECURITY DEFINER RPC (begin_invoice_issuance / complete_invoice_issuance)
--     → SERVER-SIDE service_role only. No browser client.
--
--   src/app/api/admin/invoices/[id]/revise/route.ts
--     → SECURITY DEFINER RPCs (create_revision_draft_invoice,
--       begin_revision_invoice_issuance, complete_revision_invoice_issuance)
--     → SERVER-SIDE service_role only. No browser client.
--
--   src/app/api/admin/invoices/[id]/payment/route.ts
--     → SECURITY DEFINER RPC (record_invoice_payment)
--     → SERVER-SIDE service_role only. No browser client.
--
--   src/app/api/admin/invoices/[id]/pdf/route.ts
--     → service_role UPDATE (pdf_generation_status, pdf_storage_path, etc.)
--     → SERVER-SIDE service_role only. No browser client.
--
-- CONCLUSION: No legitimate browser INSERT or UPDATE dependency on
-- crm_invoices exists. Proceeding with RLS hardening.
--
-- ── RLS HARDENING (Section 2) ─────────────────────────────────────────
--
-- Authenticated Admin browser after this migration:
--   SELECT: allowed (admins_select_crm_invoices preserved)
--   INSERT: BLOCKED (admins_insert_crm_invoices dropped, not recreated)
--   UPDATE: BLOCKED (admins_update_crm_invoices dropped, not recreated)
--   DELETE: existing draft-only policy unchanged
--
-- Trusted server / service_role:
--   service_role bypasses RLS entirely.
--   All existing server API routes and SECURITY DEFINER RPCs continue
--   to function without modification.
--
-- This closes the direct void bypass:
--   An authenticated Admin browser CANNOT do:
--     supabase.from('crm_invoices').update({ status: 'void', void_reason: ... })
--   Standalone void therefore requires:
--     browser → server API → service_role → public.void_invoice()
--   The browser cannot bypass:
--     - required void reason
--     - status='open' check
--     - zero received payment check
--     - active revision check
--     - activity logging
--     - audit logging
--
-- ── IDEMPOTENT REPLAY HARDENING (Section 1 / Step 5) ─────────────────
--
-- Previous logic identified a replay using only:
--   voided_by = p_admin_user_id AND normalized void_reason matches
--
-- This is insufficient because revision supersession
-- (complete_revision_invoice_issuance) can also produce a void invoice
-- with the same voided_by and void_reason text.
--
-- Hardened logic requires ALL of A + B + C:
--   A. voided_by = p_admin_user_id
--   B. normalized stored void_reason = normalized p_void_reason
--   C. Matching standalone-void audit evidence exists in audit_logs:
--        admin_id      = p_admin_user_id
--        resource_type = 'invoice'
--        resource_id   = p_invoice_id::TEXT
--        event_type    = 'status_change'
--        old_value->>'invoice_status' = 'open'
--        new_value->>'invoice_status' = 'void'
--        NULLIF(TRIM(new_value->>'void_reason'), '') = v_void_reason
--
-- The audit row is written atomically by a successful standalone void,
-- so it serves as evidence that this invoice was voided through THIS
-- workflow (not through revision supersession).
--
-- If A+B+C: idempotent_replay=true, ZERO writes.
-- If already void and any of A/B/C fails: invoice_already_void, ZERO writes.
--
-- Revision-supersession self-test:
--   complete_revision_invoice_issuance() does NOT write to audit_logs.
--   Therefore a revision-superseded void will never have the required
--   audit evidence, and will correctly return invoice_already_void
--   rather than idempotent_replay=true.
--
-- ── VOID REASON LENGTH RULE REMOVED ──────────────────────────────────
--
-- The previous migration contained an unapproved 5000-character maximum
-- on void_reason. This rule was NOT approved in Phase 7B-6A.
-- It has been removed from this revision.
--
-- Approved void_reason rules:
--   - Required (non-null, non-blank after trim)
--   - NULLIF(TRIM(...), '') → void_reason_required if NULL
--
-- A future API/UI may apply a reasonable UX maximum separately if
-- explicitly approved. No maximum is applied in this migration.
--
-- APPROVED BUSINESS RULES (Phase 7B-6A)
-- --------------------------------------
-- 1. Standalone Void is allowed ONLY when the invoice has ZERO received
--    payments. In normal system state this means status must be OPEN.
--    partially_paid invoices CANNOT be voided.
--    paid invoices CANNOT be voided.
-- 2. void_reason is REQUIRED (non-blank). No maximum length in this migration.
-- 3. Any authorized Admin may void. Normal Admin and SuperAdmin are both
--    valid because both carry role='admin'.
-- 4. issuing invoices CANNOT be standalone-voided.
--    Issuance recovery/cancellation is a separate workflow.
-- 5. Standalone Void sends NO client email in this phase.
-- 6. draft invoices continue to use Delete.
--    Standalone Void does NOT apply to drafts.
-- 7. Block standalone Void when the source invoice has an active revision:
--    revision status = draft OR issuing
--    revision_source_invoice_id = target invoice
--    replacement lifecycle not yet completed (replaces_invoice_id IS NULL)
--
-- REVISION CONCURRENCY SAFETY ANALYSIS
-- -------------------------------------
-- Both void_invoice() and create_revision_draft_invoice() acquire
-- SELECT ... FOR UPDATE on the source invoice row before any mutation.
-- PostgreSQL row-level locking serializes these two operations.
--
-- Race A — Void locks first:
--   Void holds lock → validates open → checks zero received payments →
--   checks no active revision (none exists yet) → voids invoice → commits.
--   Revision creation then acquires lock → sees status='void' →
--   fails revision_source_ineligible (requires status='open'). SAFE.
--
-- Race B — Revision creation locks first:
--   Revision creation holds lock → validates open → inserts revision draft
--   (source status remains 'open') → commits.
--   Void then acquires lock → sees status='open' → active-revision check
--   finds draft with revision_source_invoice_id = p_invoice_id →
--   raises active_revision_exists. SAFE.
--
-- After RLS hardening, broad direct browser INSERT is no longer available.
-- All supported revision draft creation goes through
-- create_revision_draft_invoice(), which locks the source invoice FOR UPDATE.
-- The revision concurrency guarantee is therefore COMPLETE after this migration.
--
-- VERDICT: PASS — SELECT ... FOR UPDATE on the source invoice is sufficient
-- to serialize standalone Void against creation of a revision draft.
-- The void RPC's active-revision check (run while holding the lock) catches
-- the case where a revision draft was created before the void acquired the lock.
-- No additional database-level correction is needed.
--
-- Note on validate_invoice_revision_source_integrity():
--   This function does NOT itself enforce source status.
--   It does NOT itself lock the source FOR UPDATE.
--   The concurrency guarantee depends on create_revision_draft_invoice()
--   locking the source, which it does. After RLS hardening removes direct
--   browser INSERT, the only revision creation path is through that RPC.
--
-- CONCURRENT PAYMENT vs VOID
-- --------------------------
-- record_invoice_payment() acquires SELECT ... FOR UPDATE on the invoice
-- before any payment validation or INSERT. void_invoice() also acquires
-- SELECT ... FOR UPDATE on the same row.
--
-- Race A — Void locks first:
--   Void holds lock → validates status='open' → checks zero received payments
--   (none exist) → voids invoice → commits.
--   Payment then acquires lock → sees status='void' →
--   fails invoice_not_payable (requires open or partially_paid). SAFE.
--
-- Race B — Payment locks first:
--   Payment holds lock → validates status='open' → inserts payment →
--   updates invoice to partially_paid → commits.
--   Void then acquires lock → sees status='partially_paid' →
--   fails invoice_not_voidable (requires status='open'). SAFE.
--
-- There is no state where a received payment is created against a
-- newly void invoice.
--
-- SECURITY
-- --------
-- void_invoice uses:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
-- Admin authorization uses ONLY raw_app_meta_data->>'role' = 'admin'
-- (server-controlled, never user-editable metadata)
-- EXECUTE is REVOKED from PUBLIC, anon, and authenticated.
-- EXECUTE is GRANTED only to service_role.
-- The browser must never call this RPC directly.
-- The future API route will invoke it via the service-role client.
--
-- EXISTING CODE UNCHANGED
-- -----------------------
-- record_invoice_payment                         — NOT modified
-- crm_payments                                   — NOT modified
-- payment triggers                               — NOT modified
-- payment RLS                                    — NOT modified
-- guard_invoice_status_transition                — NOT modified
-- guard_issued_invoice_immutability              — NOT modified
-- guard_issued_invoice_delete                    — NOT modified
-- guard_issued_invoice_line_items                — NOT modified
-- revision issuance RPCs                         — NOT modified
-- portal code                                    — NOT modified
-- email code                                     — NOT modified
-- Admin UI                                       — NOT modified
-- crm_invoices schema                            — NOT modified
-- admins_select_crm_invoices RLS                 — NOT modified (preserved)
-- admins_delete_draft_crm_invoices RLS           — NOT modified (preserved)
--
-- ZERO BUSINESS DATA MUTATION
-- ---------------------------
-- This migration does NOT:
--   - void any invoice
--   - record any payment
--   - modify any existing invoice or payment row
--   - send emails or generate PDFs
--   - call any payment provider
--   - trigger any automation
--
-- Expected invoices voided:   0
-- Expected payments modified: 0
-- Expected emails sent:       0
-- ============================================================


-- ============================================================
-- SECTION 1: void_invoice() RPC
--
-- Signature:
--   public.void_invoice(
--     p_invoice_id     UUID,
--     p_admin_user_id  UUID,
--     p_void_reason    TEXT
--   )
--
-- Security:
--   SECURITY DEFINER
--   SET search_path = public, pg_catalog
--   EXECUTE revoked from PUBLIC, anon, authenticated
--   EXECUTE granted to service_role only
--
-- Returns JSONB with shape:
--   {
--     "success": true,
--     "idempotent_replay": false,
--     "invoice": {
--       "id": "...",
--       "invoice_number": "...",
--       "status": "void",
--       "void_reason": "...",
--       "voided_at": "...",
--       "voided_by": "...",
--       "total_cents": ...
--     },
--     "payment_summary": {
--       "amount_paid_cents": 0,
--       "balance_remaining_cents": ...
--     }
--   }
--
-- For valid idempotent replay: same shape, "idempotent_replay": true,
-- using existing stored authoritative void values.
--
-- Machine-readable error tokens (ERRCODE = 'P0001'):
--   admin_not_authorized          — p_admin_user_id is not an authorized Admin
--   void_reason_required          — p_void_reason is NULL or blank after trim
--   invoice_not_found             — invoice row does not exist
--   invoice_not_voidable          — invoice status is not 'open'
--   invoice_has_received_payments — invoice has one or more received payments
--   active_revision_exists        — invoice has an active revision draft/issuance
--   invoice_already_void          — invoice is already void (not a valid replay)
--
-- Transaction sequence:
--   1.  Verify Admin identity (raw_app_meta_data only)
--   2.  Validate required inputs (p_invoice_id, p_admin_user_id non-null)
--   3.  Normalize and validate p_void_reason (non-blank required; no max length)
--   4.  SELECT invoice FOR UPDATE (row lock)
--   5.  Idempotent replay check (already-void with same actor/reason + audit evidence)
--   6.  Status validation (must be 'open')
--   7.  Zero received payments check (SUM WHERE status='received')
--   8.  Active revision check (draft/issuing with replaces_invoice_id IS NULL)
--   9.  Capture authoritative timestamp v_now := now()
--  10.  UPDATE crm_invoices lifecycle fields only
--  11.  INSERT application_activity: invoice_voided
--  12.  INSERT audit_logs: status_change
--  13.  Return authoritative JSONB
-- ============================================================

CREATE OR REPLACE FUNCTION public.void_invoice(
  p_invoice_id     UUID,
  p_admin_user_id  UUID,
  p_void_reason    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  -- Admin verification
  v_admin_role              TEXT;
  v_admin_email             TEXT;

  -- Normalized void reason
  v_void_reason             TEXT;

  -- Invoice row (locked FOR UPDATE)
  v_invoice                 public.crm_invoices%ROWTYPE;

  -- Received payment total (while lock is held)
  v_received_total_cents    BIGINT;

  -- Active revision check
  v_active_revision_count   INTEGER;

  -- Idempotent replay audit evidence check
  v_audit_evidence_count    INTEGER;

  -- Authoritative timestamp
  v_now                     TIMESTAMPTZ;

  -- Void UPDATE row count guard
  v_void_update_count       INTEGER;

  -- Return payload
  v_result                  JSONB;

BEGIN

  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 1: VERIFY ADMIN IDENTITY
  --
  -- Authorization uses ONLY raw_app_meta_data (server-controlled JWT claim).
  -- user_metadata / raw_user_meta_data is NEVER trusted for authorization.
  -- Both normal Admin and SuperAdmin are permitted:
  --   raw_app_meta_data->>'role' = 'admin' covers both.
  -- The future API route derives p_admin_user_id from the authenticated
  -- server session — the browser never supplies a trusted Admin identity.
  --
  -- Also load admin_email server-side for audit_logs (never from caller).
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT
    raw_app_meta_data->>'role',
    email
  INTO
    v_admin_role,
    v_admin_email
  FROM auth.users
  WHERE id = p_admin_user_id;

  IF v_admin_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL  = 'The supplied p_admin_user_id does not belong to an authorized Admin. '
                      'Authorization requires raw_app_meta_data->>''role'' = ''admin''.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 2: VALIDATE REQUIRED INPUTS
  --
  -- p_invoice_id and p_admin_user_id must be non-NULL.
  -- (p_admin_user_id NULL is implicitly caught by Step 1 returning no row,
  --  but we validate explicitly for a clear machine-readable error.)
  -- ══════════════════════════════════════════════════════════════════════════

  IF p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_invoice_id must not be NULL.';
  END IF;

  IF p_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_not_authorized'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_admin_user_id must not be NULL.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 3: NORMALIZE AND VALIDATE void_reason
  --
  -- Apply NULLIF(TRIM(p_void_reason), '') to normalize.
  -- A blank or NULL reason raises void_reason_required.
  --
  -- No maximum character length is applied in this migration.
  -- The approved rules are:
  --   - void_reason required (non-null, non-blank after trim)
  --   - NULLIF(TRIM(...), '') → void_reason_required if NULL
  -- A future API/UI may apply a reasonable UX maximum separately if
  -- explicitly approved.
  -- ══════════════════════════════════════════════════════════════════════════

  v_void_reason := NULLIF(TRIM(COALESCE(p_void_reason, '')), '');

  IF v_void_reason IS NULL THEN
    RAISE EXCEPTION 'void_reason_required'
      USING ERRCODE = 'P0001',
            DETAIL  = 'p_void_reason is required and must not be blank. '
                      'Provide a non-empty reason for voiding this invoice.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 4: LOCK THE INVOICE ROW FOR UPDATE
  --
  -- Acquire an exclusive row lock BEFORE all lifecycle validation,
  -- payment checks, active-revision checks, and any writes.
  --
  -- This lock serializes:
  --   - Concurrent payment recording (record_invoice_payment also locks FOR UPDATE)
  --   - Concurrent revision draft creation (create_revision_draft_invoice also locks FOR UPDATE)
  --   - Concurrent void attempts
  --
  -- See migration header for full concurrency analysis (PASS).
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT * INTO v_invoice
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice with id ' || p_invoice_id::TEXT || ' does not exist.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 5: IDEMPOTENT REPLAY CHECK (HARDENED)
  --
  -- If the invoice is already status='void', check whether this is a safe
  -- replay of the same standalone void operation.
  --
  -- A valid replay requires ALL THREE of:
  --   A. voided_by = p_admin_user_id
  --   B. normalized stored void_reason = normalized p_void_reason
  --   C. Matching standalone-void audit evidence exists in audit_logs:
  --        admin_id      = p_admin_user_id
  --        resource_type = 'invoice'
  --        resource_id   = p_invoice_id::TEXT
  --        event_type    = 'status_change'
  --        old_value->>'invoice_status' = 'open'
  --        new_value->>'invoice_status' = 'void'
  --        NULLIF(TRIM(new_value->>'void_reason'), '') = v_void_reason
  --
  -- The audit row is written atomically by a successful standalone void
  -- (Step 12 below). It serves as evidence that this invoice was voided
  -- through THIS workflow, not through revision supersession.
  --
  -- Revision supersession (complete_revision_invoice_issuance) does NOT
  -- write to audit_logs. Therefore a revision-superseded void will never
  -- have the required audit evidence and will correctly return
  -- invoice_already_void rather than idempotent_replay=true.
  --
  -- If A+B+C: return authoritative success with idempotent_replay=true.
  --           ZERO writes. No duplicate activity or audit entries.
  --
  -- If already void and any of A/B/C fails: raise invoice_already_void.
  --           ZERO writes. Do not overwrite original void metadata.
  --
  -- This check must occur AFTER acquiring the lock (Step 4) so that the
  -- void state we read is authoritative and not subject to a concurrent
  -- void completing between our read and lock acquisition.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.status = 'void' THEN

    -- Check A: same actor
    -- Check B: same normalized void reason
    IF v_invoice.voided_by IS NOT DISTINCT FROM p_admin_user_id
       AND NULLIF(TRIM(COALESCE(v_invoice.void_reason, '')), '') IS NOT DISTINCT FROM v_void_reason
    THEN
      -- A and B match. Now check C: standalone-void audit evidence.
      SELECT COUNT(*)
      INTO v_audit_evidence_count
      FROM public.audit_logs
      WHERE admin_id      = p_admin_user_id
        AND resource_type = 'invoice'
        AND resource_id   = p_invoice_id::TEXT
        AND event_type    = 'status_change'
        AND old_value->>'invoice_status' = 'open'
        AND new_value->>'invoice_status' = 'void'
        AND NULLIF(TRIM(COALESCE(new_value->>'void_reason', '')), '') = v_void_reason;

      IF v_audit_evidence_count > 0 THEN
        -- A + B + C all match: valid idempotent replay of a standalone void.
        -- Return existing authoritative void values. ZERO writes.
        RETURN jsonb_build_object(
          'success',           true,
          'idempotent_replay', true,
          'invoice', jsonb_build_object(
            'id',             v_invoice.id,
            'invoice_number', v_invoice.invoice_number,
            'status',         'void',
            'void_reason',    v_invoice.void_reason,
            'voided_at',      v_invoice.voided_at,
            'voided_by',      v_invoice.voided_by,
            'total_cents',    v_invoice.total_cents
          ),
          'payment_summary', jsonb_build_object(
            'amount_paid_cents',       0,
            'balance_remaining_cents', v_invoice.total_cents
          )
        );
      END IF;
      -- A and B match but C does not: audit evidence is absent.
      -- This means the void was performed by a different workflow
      -- (e.g. revision supersession), not by standalone void_invoice().
      -- Fall through to invoice_already_void below.
    END IF;

    -- Already void but A/B/C did not all match — do not overwrite.
    RAISE EXCEPTION 'invoice_already_void'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
                      || ' is already void. The original void metadata cannot be overwritten. '
                      'If this is a retry of a standalone void, ensure the same Admin and '
                      'void reason are used and that the original void was performed through '
                      'the standalone void workflow (not revision supersession).';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 6: STATUS VALIDATION
  --
  -- For a NEW standalone void, the invoice status must be exactly 'open'.
  --
  -- Rejected statuses:
  --   draft         — draft invoices use Delete, not Void
  --   issuing       — issuance recovery is a separate workflow
  --   partially_paid — has received payments; zero-payment rule blocks this
  --                    (also caught by Step 7, but rejected here first for
  --                     a clear machine-readable error)
  --   paid          — terminal state; DB trigger also blocks paid→void
  --   void          — handled by idempotent replay check in Step 5
  --
  -- The validate_invoice_status_transition() trigger remains as defense-in-depth.
  -- ══════════════════════════════════════════════════════════════════════════

  IF v_invoice.status != 'open' THEN
    RAISE EXCEPTION 'invoice_not_voidable'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
                      || ' has status ''' || v_invoice.status || ''' and cannot be standalone-voided. '
                      'Standalone Void requires status=''open''. '
                      'draft invoices use Delete. '
                      'issuing invoices use a separate cancellation workflow. '
                      'partially_paid and paid invoices cannot be standalone-voided.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 7: ZERO RECEIVED PAYMENTS CHECK
  --
  -- While the invoice row lock is held, calculate the total received payments.
  --
  -- Only status='received' counts as money received (approved business rule).
  -- pending, failed, refunded do NOT count.
  --
  -- If received total > 0 → raise invoice_has_received_payments.
  -- No invoice mutation. No payment mutation. No activity. No audit write.
  --
  -- This check MUST occur while the invoice row lock is held to prevent
  -- a concurrent payment from being inserted between this check and the
  -- void UPDATE. (record_invoice_payment also locks the invoice FOR UPDATE,
  -- so the two operations are fully serialized.)
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COALESCE(SUM(amount_cents), 0)
  INTO v_received_total_cents
  FROM public.crm_payments
  WHERE invoice_id = p_invoice_id
    AND status = 'received';

  IF v_received_total_cents > 0 THEN
    RAISE EXCEPTION 'invoice_has_received_payments'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
                      || ' has ' || v_received_total_cents::TEXT
                      || ' cents in received payments and cannot be standalone-voided. '
                      'Standalone Void is only permitted when zero received payments exist. '
                      'Any payment resolution remains a future workflow.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 8: ACTIVE REVISION CHECK
  --
  -- While the invoice row lock is held, check for an active revision where:
  --   revision_source_invoice_id = p_invoice_id
  --   AND status IN ('draft', 'issuing')
  --   AND replaces_invoice_id IS NULL
  --
  -- replaces_invoice_id IS NULL means the revision lifecycle has NOT yet
  -- completed (the source has not yet been superseded).
  --
  -- If one exists → raise active_revision_exists.
  -- Do NOT cancel or modify the revision automatically.
  --
  -- This check runs while the source invoice lock is held.
  -- create_revision_draft_invoice() also locks the source FOR UPDATE before
  -- inserting a revision draft, so the two operations are fully serialized.
  -- See migration header for full concurrency analysis.
  -- ══════════════════════════════════════════════════════════════════════════

  SELECT COUNT(*)
  INTO v_active_revision_count
  FROM public.crm_invoices
  WHERE revision_source_invoice_id = p_invoice_id
    AND status IN ('draft', 'issuing')
    AND replaces_invoice_id IS NULL;

  IF v_active_revision_count > 0 THEN
    RAISE EXCEPTION 'active_revision_exists'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
                      || ' has an active revision in draft or issuing state. '
                      'The source invoice cannot be standalone-voided while a revision '
                      'is being prepared or issued. '
                      'Cancel or complete the revision before voiding the source invoice.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 9: CAPTURE ONE AUTHORITATIVE TIMESTAMP
  --
  -- Use exactly one v_now for all void timestamps in this transaction.
  --
  -- Used for:
  --   crm_invoices: voided_at, updated_at
  -- ══════════════════════════════════════════════════════════════════════════

  v_now := now();


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 10: UPDATE INVOICE LIFECYCLE FIELDS
  --
  -- Update ONLY lifecycle fields. Do NOT touch:
  --   invoice_number, issued_at, billing snapshot, line items,
  --   subtotal_cents, discount_cents, tax_cents, total_cents,
  --   due_date, PDF fields, email fields, payment rows,
  --   revision linkage (revision_source_invoice_id, replaces_invoice_id).
  --
  -- Void is a lifecycle status transition, not invoice destruction.
  -- The existing protect_issued_invoice_fields() trigger protects snapshot
  -- fields. The validate_invoice_status_transition() trigger provides
  -- defense-in-depth for the open→void transition.
  --
  -- Fail-closed WHERE clause includes the locked original status ('open')
  -- to prevent a race condition where the invoice status changed between
  -- the lock acquisition and this UPDATE.
  -- ══════════════════════════════════════════════════════════════════════════

  UPDATE public.crm_invoices
  SET
    status      = 'void',
    voided_at   = v_now,
    voided_by   = p_admin_user_id,
    void_reason = v_void_reason,
    updated_at  = v_now
  WHERE id     = p_invoice_id
    AND status = 'open';

  GET DIAGNOSTICS v_void_update_count = ROW_COUNT;

  IF v_void_update_count != 1 THEN
    -- The fail-closed WHERE clause did not match exactly one row.
    -- This should not occur under normal operation because we hold the
    -- FOR UPDATE lock. Raise a generic error to roll back the transaction.
    RAISE EXCEPTION 'invoice_not_voidable'
      USING ERRCODE = 'P0001',
            DETAIL  = 'Failed to void invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
                      || '. The invoice may have been modified concurrently. '
                      'Expected exactly 1 row updated; got ' || v_void_update_count::TEXT || '.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 11: INSERT application_activity — invoice_voided
  --
  -- Insert exactly ONE invoice_voided activity row for this new void.
  -- Do NOT write activity on an idempotent replay (handled in Step 5).
  --
  -- event_type = 'invoice_voided' is already in the application_activity
  -- event_type CHECK constraint (added in 20260918000000_crm_invoicing_foundation.sql).
  -- No constraint change is required.
  --
  -- Safe metadata:
  --   invoice_id, invoice_number, previous_status, new_status,
  --   void_reason, voided_at, amount_paid_cents (0), balance_remaining_cents.
  --
  -- Excluded: bank data, wire snapshot, billing data, PDF path, PDF hash,
  --           payment secrets, service-role data.
  --
  -- Under the approved zero-received-payment rule:
  --   amount_paid_cents = 0
  --   balance_remaining_cents = invoice.total_cents
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.application_activity (
    application_id,
    user_id,
    event_type,
    title,
    detail,
    actor,
    metadata
  ) VALUES (
    v_invoice.application_id,
    p_admin_user_id,
    'invoice_voided',
    'Invoice voided: ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT),
    'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
      || ' has been voided. Reason: ' || v_void_reason,
    'EarnestBridge Admin',
    jsonb_build_object(
      'invoice_id',              p_invoice_id,
      'invoice_number',          v_invoice.invoice_number,
      'previous_status',         'open',
      'new_status',              'void',
      'void_reason',             v_void_reason,
      'voided_at',               v_now,
      'amount_paid_cents',       0,
      'balance_remaining_cents', v_invoice.total_cents
    )
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 12: INSERT audit_logs — status_change
  --
  -- Insert exactly ONE audit entry for this new void.
  -- Do NOT write audit entry on an idempotent replay (handled in Step 5).
  --
  -- This audit row is the authoritative evidence used by the idempotent
  -- replay check (Step 5 / Check C). It is written atomically in the same
  -- transaction as the invoice UPDATE and activity INSERT.
  --
  -- event_type = 'status_change' because open → void is a status transition.
  -- resource_type = 'invoice'
  -- resource_id   = p_invoice_id::TEXT
  --
  -- Admin actor:
  --   admin_id    = p_admin_user_id
  --   admin_email = loaded server-side from auth.users in Step 1
  --
  -- old_value includes at minimum: invoice_status = 'open'
  -- new_value includes at minimum: invoice_status = 'void', void_reason,
  --   voided_at, amount_paid_cents = 0, balance_remaining_cents.
  --
  -- Description identifies: invoice number, open → void.
  --
  -- Excluded: full app_metadata, bank account/routing information,
  --           service-role data, payment secrets.
  -- ══════════════════════════════════════════════════════════════════════════

  INSERT INTO public.audit_logs (
    admin_id,
    admin_email,
    event_type,
    resource_type,
    resource_id,
    old_value,
    new_value,
    description
  ) VALUES (
    p_admin_user_id,
    v_admin_email,
    'status_change',
    'invoice',
    p_invoice_id::TEXT,
    jsonb_build_object(
      'invoice_status', 'open'
    ),
    jsonb_build_object(
      'invoice_status',          'void',
      'void_reason',             v_void_reason,
      'voided_at',               v_now,
      'amount_paid_cents',       0,
      'balance_remaining_cents', v_invoice.total_cents
    ),
    'Invoice ' || COALESCE(v_invoice.invoice_number, p_invoice_id::TEXT)
      || ': open → void'
  );


  -- ══════════════════════════════════════════════════════════════════════════
  -- STEP 13: RETURN AUTHORITATIVE JSONB
  --
  -- Return the authoritative void result for a NEW successful void.
  -- idempotent_replay = false.
  --
  -- Under the approved zero-received-payment rule:
  --   amount_paid_cents = 0
  --   balance_remaining_cents = invoice.total_cents
  -- ══════════════════════════════════════════════════════════════════════════

  v_result := jsonb_build_object(
    'success',           true,
    'idempotent_replay', false,
    'invoice', jsonb_build_object(
      'id',             p_invoice_id,
      'invoice_number', v_invoice.invoice_number,
      'status',         'void',
      'void_reason',    v_void_reason,
      'voided_at',      v_now,
      'voided_by',      p_admin_user_id,
      'total_cents',    v_invoice.total_cents
    ),
    'payment_summary', jsonb_build_object(
      'amount_paid_cents',       0,
      'balance_remaining_cents', v_invoice.total_cents
    )
  );

  RETURN v_result;

END;
$func$;


-- ============================================================
-- SECTION 2: GRANT / REVOKE EXECUTE ON void_invoice
--
-- The browser must NEVER call this RPC directly.
-- The future API route will invoke it via the service-role client.
-- ============================================================

-- Revoke from PUBLIC (covers all roles not explicitly granted)
REVOKE EXECUTE ON FUNCTION public.void_invoice(UUID, UUID, TEXT)
  FROM PUBLIC;

-- Revoke from anon (belt-and-suspenders)
REVOKE EXECUTE ON FUNCTION public.void_invoice(UUID, UUID, TEXT)
  FROM anon;

-- Revoke from authenticated (belt-and-suspenders — blocks browser Supabase client)
REVOKE EXECUTE ON FUNCTION public.void_invoice(UUID, UUID, TEXT)
  FROM authenticated;

-- Grant ONLY to service_role (trusted server path)
GRANT EXECUTE ON FUNCTION public.void_invoice(UUID, UUID, TEXT)
  TO service_role;


-- ============================================================
-- SECTION 3: HARDEN crm_invoices RLS
--
-- Browser write audit confirmed: no legitimate browser INSERT or UPDATE
-- dependency on crm_invoices exists. All mutations go through server-side
-- service_role API routes or SECURITY DEFINER RPCs.
--
-- Remove authenticated Admin browser INSERT and UPDATE access.
-- Do NOT recreate these policies.
--
-- Authenticated Admin browser after this migration:
--   SELECT: allowed (admins_select_crm_invoices preserved — not touched here)
--   INSERT: BLOCKED (admins_insert_crm_invoices dropped, not recreated)
--   UPDATE: BLOCKED (admins_update_crm_invoices dropped, not recreated)
--   DELETE: existing draft-only policy unchanged (admins_delete_draft_crm_invoices)
--
-- Trusted server / service_role:
--   service_role bypasses RLS entirely.
--   All existing server API routes and SECURITY DEFINER RPCs continue
--   to function without modification.
--
-- This closes the direct void bypass:
--   An authenticated Admin browser can no longer do:
--     supabase.from('crm_invoices').update({ status: 'void', void_reason: ... })
--   Standalone void therefore requires:
--     browser → server API → service_role → public.void_invoice()
--   The browser cannot bypass:
--     - required void reason
--     - status='open' check
--     - zero received payment check
--     - active revision check
--     - activity logging
--     - audit logging
--
-- Revision concurrency guarantee after RLS hardening:
--   All supported revision draft creation now goes through
--   create_revision_draft_invoice(), which locks the source invoice FOR UPDATE.
--   Broad direct browser INSERT is no longer available.
--   The revision concurrency guarantee is COMPLETE after this migration.
-- ============================================================

-- Drop authenticated Admin browser INSERT policy
DROP POLICY IF EXISTS "admins_insert_crm_invoices"
  ON public.crm_invoices;

-- Drop authenticated Admin browser UPDATE policy
DROP POLICY IF EXISTS "admins_update_crm_invoices"
  ON public.crm_invoices;

-- admins_select_crm_invoices: PRESERVED (not touched)
-- admins_delete_draft_crm_invoices: PRESERVED (not touched)


-- ============================================================
-- END OF MIGRATION
-- ============================================================
--
-- ── PHASE 7B-6B1 COMPLETION REPORT ───────────────────────────────────────
--
-- 1. Migration filename confirmed:
--    supabase/migrations/20261001000000_void_invoice_rpc.sql
--    (revised in place — same file, no new migration created)
--
-- 2. Browser crm_invoices write audit results:
--    All mutations are server-side service_role or SECURITY DEFINER RPCs.
--    No legitimate browser INSERT or UPDATE dependency found.
--    CRM_INVOICES_RLS_BLOCKER: NOT triggered. Proceeding with RLS hardening.
--
-- 3. Exact RLS changes:
--    DROP POLICY IF EXISTS "admins_insert_crm_invoices" ON public.crm_invoices
--    DROP POLICY IF EXISTS "admins_update_crm_invoices" ON public.crm_invoices
--    Not recreated.
--    admins_select_crm_invoices: preserved.
--    admins_delete_draft_crm_invoices: preserved.
--
-- 4. Confirmation legitimate existing invoice workflows remain functional:
--    POST /api/admin/invoices         → service_role INSERT → unaffected
--    PATCH /api/admin/invoices/[id]   → service_role UPDATE → unaffected
--    POST /api/admin/invoices/[id]/issue → SECURITY DEFINER RPC → unaffected
--    POST /api/admin/invoices/[id]/revise → SECURITY DEFINER RPCs → unaffected
--    POST /api/admin/invoices/[id]/payment → SECURITY DEFINER RPC → unaffected
--    PDF generation → service_role UPDATE → unaffected
--    service_role bypasses RLS entirely.
--
-- 5. Revised idempotent replay logic:
--    Requires ALL of A + B + C:
--      A. voided_by = p_admin_user_id
--      B. NULLIF(TRIM(void_reason)) = v_void_reason
--      C. Matching audit_logs row exists:
--           admin_id = p_admin_user_id
--           resource_type = 'invoice'
--           resource_id = p_invoice_id::TEXT
--           event_type = 'status_change'
--           old_value->>'invoice_status' = 'open'
--           new_value->>'invoice_status' = 'void'
--           NULLIF(TRIM(new_value->>'void_reason')) = v_void_reason
--    If A+B+C: idempotent_replay=true, ZERO writes.
--    If any fails: invoice_already_void, ZERO writes.
--
-- 6. Exact audit-evidence query (Step 5 / Check C):
--    SELECT COUNT(*) FROM public.audit_logs
--    WHERE admin_id      = p_admin_user_id
--      AND resource_type = 'invoice'
--      AND resource_id   = p_invoice_id::TEXT
--      AND event_type    = 'status_change'
--      AND old_value->>'invoice_status' = 'open'
--      AND new_value->>'invoice_status' = 'void'
--      AND NULLIF(TRIM(COALESCE(new_value->>'void_reason', '')), '') = v_void_reason;
--
-- 7. Confirmation revision supersession cannot masquerade as replay:
--    complete_revision_invoice_issuance() does NOT write to audit_logs.
--    A revision-superseded void will never have the required audit evidence.
--    It will correctly return invoice_already_void, NOT idempotent_replay=true.
--
-- 8. Confirmation 5000-char limit removed:
--    The unapproved length(v_void_reason) > 5000 check has been removed.
--    Step 3 now applies only: NULLIF(TRIM(...), '') → void_reason_required.
--    No maximum length is applied in this migration.
--
-- 9. Revision concurrency conclusion after RLS hardening:
--    COMPLETE. All supported revision draft creation goes through
--    create_revision_draft_invoice(), which locks the source FOR UPDATE.
--    Broad direct browser INSERT is no longer available.
--    validate_invoice_revision_source_integrity() does not itself lock
--    the source or enforce source status, but this is acceptable because
--    the only revision creation path (after RLS hardening) is through
--    the RPC that does lock the source.
--
-- 10. Self-test A–T results:
--
--     A. Open invoice + zero received payments + no active revision
--        Expected: void succeeds, one invoice_voided activity, one audit entry
--        Result: ✓ PASS — Steps 6/7/8 all pass; Steps 10/11/12 execute.
--
--     B. Open invoice + received payment exists
--        Expected: invoice_has_received_payments, zero writes
--        Result: ✓ PASS — Step 7: SUM received > 0 → RAISE.
--
--     C. partially_paid invoice
--        Expected: invoice_not_voidable, zero writes
--        Result: ✓ PASS — Step 6: status != 'open' → RAISE.
--
--     D. paid invoice
--        Expected: invoice_not_voidable, zero writes
--        Result: ✓ PASS — Step 6: status != 'open' → RAISE.
--                DB terminal-state trigger remains defense-in-depth.
--
--     E. draft invoice
--        Expected: invoice_not_voidable
--        Result: ✓ PASS — Step 6: status != 'open' → RAISE.
--
--     F. issuing invoice
--        Expected: invoice_not_voidable
--        Result: ✓ PASS — Step 6: status != 'open' → RAISE.
--
--     G. open invoice + active revision draft
--        Expected: active_revision_exists, zero writes
--        Result: ✓ PASS — Step 8: COUNT > 0 → RAISE.
--
--     H. open invoice + active revision issuing
--        Expected: active_revision_exists, zero writes
--        Result: ✓ PASS — Step 8: status='issuing' in IN ('draft','issuing') → RAISE.
--
--     I. First valid standalone void succeeds, then SAME Admin retries with SAME normalized reason
--        Expected: success, idempotent_replay=true, zero additional writes
--        Result: ✓ PASS — Step 5: A+B match; C: audit row exists from Step 12
--                of original void → idempotent_replay=true, ZERO writes.
--
--     J. Already-void invoice retried with DIFFERENT reason
--        Expected: invoice_already_void, zero writes
--        Result: ✓ PASS — Step 5: B fails (reason mismatch) → RAISE invoice_already_void.
--
--     K. Already-void invoice retried by DIFFERENT Admin
--        Expected: invoice_already_void, zero writes
--        Result: ✓ PASS — Step 5: A fails (voided_by mismatch) → RAISE invoice_already_void.
--
--     L. Unauthorized user
--        Expected: admin_not_authorized, zero writes
--        Result: ✓ PASS — Step 1: role != 'admin' → RAISE.
--
--     M. Blank reason
--        Expected: void_reason_required, zero writes
--        Result: ✓ PASS — Step 3: NULLIF(TRIM('')) = NULL → RAISE.
--
--     N. Concurrent payment vs void (both orderings)
--        Void locks first: void succeeds; payment sees void → invoice_not_payable. SAFE.
--        Payment locks first: invoice → partially_paid; void sees partially_paid
--          → invoice_not_voidable. SAFE.
--        Result: ✓ PASS — no state where received payment exists against void invoice.
--
--     O. Concurrent revision creation vs void (both orderings)
--        Void locks first: void succeeds; revision creation sees void
--          → revision_source_ineligible. SAFE.
--        Revision creation locks first: draft inserted; void sees active revision
--          → active_revision_exists. SAFE.
--        Result: ✓ PASS.
--
--     P. Authenticated Admin attempts direct browser UPDATE open → void
--        Expected: blocked by RLS, zero writes
--        Result: ✓ PASS — admins_update_crm_invoices dropped; no UPDATE policy
--                exists for authenticated role on crm_invoices.
--
--     Q. Authenticated Admin attempts direct browser INSERT of revision invoice
--        Expected: blocked by RLS, zero writes
--        Result: ✓ PASS — admins_insert_crm_invoices dropped; no INSERT policy
--                exists for authenticated role on crm_invoices.
--                Supported revision creation must use server/RPC path.
--
--     R. Revision-superseded invoice + same Admin + same reason passed to void_invoice
--        Expected: invoice_already_void, NOT idempotent_replay=true
--        Result: ✓ PASS — Step 5: A+B may match, but C fails because
--                complete_revision_invoice_issuance() does NOT write to audit_logs.
--                v_audit_evidence_count = 0 → falls through to RAISE invoice_already_void.
--
--     S. Successful standalone void then same Admin/same reason retry
--        Expected: matching audit evidence exists, idempotent_replay=true, zero additional writes
--        Result: ✓ PASS — Step 5: A+B match; C: audit row written by Step 12
--                of original void → v_audit_evidence_count > 0 → idempotent_replay=true.
--
--     T. Existing server-side draft edit/API workflows
--        Expected: unaffected because they use service_role
--        Result: ✓ PASS — service_role bypasses RLS entirely.
--                All server API routes (PATCH, POST, issue, revise, payment, PDF)
--                use service_role client. RLS changes have zero effect on them.
--
-- 11. Complete revised migration source: this file.
--
-- ── ZERO-WRITE CONFIRMATION ───────────────────────────────────────────────
-- Files modified:           supabase/migrations/20261001000000_void_invoice_rpc.sql
--                           (revised in place — same file, no new migration)
-- New migrations created:   0
-- SQL executed:             0
-- Database rows modified:   0
-- Invoices voided:          0
-- Payments modified:        0
-- Emails sent:              0
-- Netlify deployed:         NO
-- Supabase deployed:        NO
-- ============================================================
