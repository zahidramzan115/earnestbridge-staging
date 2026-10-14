-- ============================================================
-- Migration: 20260916000000_option_cycle_missed_status_hardening
--
-- PURPOSE
-- -------
-- Step 5D-1.2 final hardening pass before Step 5D-2:
--
-- 1. Verify 'missed' is in the crm_deal_option_cycles status CHECK.
--    The original migration included it; this migration confirms and
--    documents the canonical status values.
--
-- 2. Add 'option_cycle_missed' and 'extension_override_accepted'
--    event types to application_activity for Step 5D-2 and future
--    manual override workflow.
--
-- 3. Document the canonical timeliness semantics:
--    - actual_amendment_received_at  → canonical amendment timeliness field
--    - actual_option_exercised_at    → canonical exercise timeliness field
--    - extension_psa_amendment_received_at / option_exercised_at are
--      retained for backward compatibility only (CRM/system timestamps)
--
-- 4. Document the manual override model contract for Step 5D-2:
--    - After auto-close (Funded → Closed), Admin may perform
--      "Accept Extension Override" when a valid signed PSA amendment
--      was received before the actual due-diligence period expired.
--    - This is Admin-only. No automatic determination.
--    - Prior missed cycle is preserved as 'missed' — NOT rewritten.
--    - Override creates a new active extension cycle.
--    - application_activity captures the full audit trail.
--    - No new schema columns are added speculatively; application_activity
--      is sufficient for the override audit trail.
--
-- CANONICAL TIMELINESS FIELDS
-- ---------------------------
-- actual_amendment_received_at:
--   Admin-recorded actual receipt time for the signed PSA amendment.
--   Canonical field for determining whether amendment met the
--   CLIENT-FACING Option Exercise Deadline (5:00 PM ET).
--
-- actual_option_exercised_at:
--   Admin-recorded actual exercise receipt timestamp.
--   Canonical field for client-facing deadline timeliness.
--
-- extension_psa_amendment_received_at / option_exercised_at:
--   CRM/system action timestamps. Retained for backward compatibility.
--   Do NOT use for business timeliness determinations.
--
-- MISSED CYCLE SEMANTICS
-- ----------------------
-- status = 'missed' is set by Step 5D-2 automation when:
--   NO timely exercise (actual_option_exercised_at <= cutoff)
--   AND NO timely amendment (actual_amendment_received_at <= cutoff)
-- A missed cycle is preserved as-is. It is NOT rewritten to 'exercised'
-- or falsely marked timely after the fact.
--
-- MANUAL OVERRIDE CONTRACT
-- ------------------------
-- After Step 5D-2 auto-closes a Deal (Funded → Closed):
--   Admin may perform "Accept Extension Override" when:
--     - actual_amendment_received_at IS NOT NULL (required)
--     - Admin explicitly attests: "I have verified that the signed PSA
--       amendment was received before the applicable DD period expired."
--   This creates a new active extension cycle (cycle_number + 1).
--   The prior missed cycle remains status = 'missed'.
--   Deal status transitions: Closed → Funded.
--   extension_fee_paid_at may still be NULL (fee outstanding).
--   Admin UI shows "Extension Fee Outstanding" until recorded paid.
--   Do NOT block override solely because extension_fee_paid_at IS NULL.
--
-- BLOCKED ACTIONS
-- ---------------
-- The generic 'new_extension' action is BLOCKED on missed cycles.
-- Missed cycles may only be extended via the explicit Admin override
-- action (to be built in Step 5D-2). This separation ensures:
--   - Normal extension (timely amendment) uses 'new_extension'
--   - Exception override (missed cycle) uses a distinct override action
--   - History is never silently rewritten
-- ============================================================

-- ─── 1. CONFIRM status CHECK includes 'missed' ───────────────────────────────
-- The original migration 20260915010000 already includes 'missed' in the
-- CHECK constraint. We re-apply it here idempotently to confirm.

ALTER TABLE public.crm_deal_option_cycles
  DROP CONSTRAINT IF EXISTS crm_deal_option_cycles_status_check;

ALTER TABLE public.crm_deal_option_cycles
  ADD CONSTRAINT crm_deal_option_cycles_status_check
  CHECK (status = ANY (ARRAY['active', 'exercised', 'extended', 'missed']));

-- ─── 2. EXTEND application_activity event_type CHECK ─────────────────────────
-- Add option_cycle_missed and extension_override_accepted for Step 5D-2
-- and future manual override workflow.

ALTER TABLE public.application_activity
  DROP CONSTRAINT IF EXISTS application_activity_event_type_check;

ALTER TABLE public.application_activity
  ADD CONSTRAINT application_activity_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'status_change',
    'document_upload',
    'admin_note',
    'deadline_shift',
    'system',
    'document_revision_uploaded',
    'revision_requested',
    'document_approved',
    'owner_assigned',
    'task_created',
    'email_sent',
    'call_logged',
    'deadline_created',
    'deadline_updated',
    'deadline_completed',
    'deadline_cancelled',
    'deadline_reopened',
    'option_cycle_created',
    'option_exercised',
    'extension_amendment_received',
    'extension_fee_paid',
    'option_cycle_extended',
    'option_cycle_missed',
    'extension_override_accepted'
  ]));

-- ─── 3. SECURITY DEFINER VERIFICATION ────────────────────────────────────────
-- Confirm fn_subtract_business_days and set_crm_deal_option_cycles_updated_at
-- both have explicit SET search_path = public, pg_catalog.
-- These were hardened in migration 20260915011000. No changes needed here.
-- Documented for audit trail.

-- fn_subtract_business_days:
--   SECURITY DEFINER SET search_path = public, pg_catalog ✓ (confirmed in 20260915011000)
--
-- set_crm_deal_option_cycles_updated_at:
--   SECURITY DEFINER SET search_path = public, pg_catalog ✓ (confirmed in 20260915011000)

-- ─── 4. DOCUMENT: No new schema columns added speculatively ──────────────────
-- manual_override_at, manual_override_by, manual_override_reason are NOT
-- added here. application_activity captures the full override audit trail.
-- These fields may be added in Step 5D-2 if the override workflow requires
-- queryable structured data beyond what application_activity provides.
