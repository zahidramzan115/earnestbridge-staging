/**
 * Option Cycle Email Type Constants — Canonical Mapping
 *
 * Step 5D-2.9a: Single source of truth for all Option Cycle emailType values.
 *
 * IMPORTANT: These constants define the exact emailType strings accepted by
 * the send-borrower-emails Supabase Edge Function. Any caller that invokes
 * the edge function for Option Cycle emails MUST use these constants.
 *
 * Root cause of Step 5D-2.9a bug:
 *   The live_client_test sent emailType = 'client_reminder_7d' which IS the
 *   correct value. The error "Unknown emailType: client_reminder_7d" was caused
 *   by the edge function not being redeployed after the Option Cycle reminder
 *   cases were added to its source. The source and callers were already in sync;
 *   only the deployed edge function was stale.
 *
 * AUTOMATION EVENT TYPES vs EMAIL TYPES:
 *   These are the same for reminders (e.g., 'client_reminder_7d' is both the
 *   automation log event_type AND the emailType sent to the edge function).
 *   For closeout, the automation event type differs from the email type:
 *     automation event: 'client_closeout_notice' → emailType: 'option_client_closeout' *     automation event:'admin_closeout_notice'  → emailType: 'option_admin_closeout'
 *
 * DEDUPE KEY FORMAT (do NOT change — existing rows use this format):
 *   Reminders:  option:{cycle_id}:{deadline_date}:{event_type}:{normalized_email}
 *   Auto-close: option:{cycle_id}:{deadline_date}:auto_close
 *   Closeout notices use their own event_type in the dedupe key.
 */

// ── Client reminder emailTypes (sent to borrower) ────────────────────────────
// These are BOTH the automation log event_type AND the edge function emailType.
export const CLIENT_REMINDER_EMAIL_TYPES = {
  '7d': 'client_reminder_7d',
  '5d': 'client_reminder_5d',
  '3d': 'client_reminder_3d',
  '1d': 'client_reminder_1d',
} as const;

// ── Admin reminder emailTypes (sent to assigned owner) ───────────────────────
// These are BOTH the automation log event_type AND the edge function emailType.
export const ADMIN_REMINDER_EMAIL_TYPES = {
  '7d': 'admin_reminder_7d',
  '5d': 'admin_reminder_5d',
  '3d': 'admin_reminder_3d',
  '1d': 'admin_reminder_1d',
} as const;

// ── Closeout emailTypes ───────────────────────────────────────────────────────
// NOTE: The automation log event_type differs from the edge function emailType.
// Automation event_type: 'client_closeout_notice' / 'admin_closeout_notice'
// Edge function emailType: 'option_client_closeout' / 'option_admin_closeout'
export const CLOSEOUT_EMAIL_TYPES = {
  client: 'option_client_closeout',   // edge function emailType
  admin: 'option_admin_closeout',     // edge function emailType
} as const;

// ── Automation log event_type → edge function emailType mapping ───────────────
// For reminders, these are identical. For closeout, they differ.
// Use this mapping when building the email payload from an automation event.
export const AUTOMATION_EVENT_TO_EMAIL_TYPE: Record<string, string> = {
  // Client reminders — event_type === emailType
  'client_reminder_7d': 'client_reminder_7d',
  'client_reminder_5d': 'client_reminder_5d',
  'client_reminder_3d': 'client_reminder_3d',
  'client_reminder_1d': 'client_reminder_1d',
  // Admin reminders — event_type === emailType
  'admin_reminder_7d': 'admin_reminder_7d',
  'admin_reminder_5d': 'admin_reminder_5d',
  'admin_reminder_3d': 'admin_reminder_3d',
  'admin_reminder_1d': 'admin_reminder_1d',
  // Closeout — event_type DIFFERS from emailType
  'client_closeout_notice': 'option_client_closeout',
  'admin_closeout_notice': 'option_admin_closeout',
};

// ── All Option Cycle automation log event_types ───────────────────────────────
// These match the CHECK constraint in the option_cycle_automation_log table.
export const OPTION_CYCLE_EVENT_TYPES = [
  'client_reminder_7d',
  'admin_reminder_7d',
  'client_reminder_5d',
  'admin_reminder_5d',
  'client_reminder_3d',
  'admin_reminder_3d',
  'client_reminder_1d',
  'admin_reminder_1d',
  'auto_close',
  'client_closeout_notice',
  'admin_closeout_notice',
] as const;

export type OptionCycleEventType = typeof OPTION_CYCLE_EVENT_TYPES[number];
