'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Icon from '@/components/ui/AppIcon';
import RecordPaymentDialog from './RecordPaymentDialog';
import PaymentHistorySection, { PaymentRecord } from './PaymentHistorySection';
import VoidInvoiceDialog from './VoidInvoiceDialog';

// ── Types ─────────────────────────────────────────────────────────────────────

interface InvoiceLineItem {
  id: string;
  line_type: string;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  line_amount_cents: number;
  sort_order: number;
  calc_emd_funded_cents: number | null;
  calc_daily_rate_per_100k_cents: number | null;
  calc_billable_days: number | null;
  calc_period_start_date: string | null;
  calc_period_end_date: string | null;
}

interface Invoice {
  id: string;
  invoice_number: string | null;
  invoice_type: string;
  status: string;
  currency: string;
  application_id: string;
  billing_name: string | null;
  billing_contact_name: string | null;
  billing_email: string | null;
  billing_address_line1: string | null;
  billing_address_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_postal_code: string | null;
  billing_country: string;
  emd_funded_cents: number | null;
  funding_date: string | null;
  period_start_date: string | null;
  period_end_date: string | null;
  billable_days: number | null;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  due_date: string | null;
  invoice_notes: string | null;
  internal_notes: string | null;
  replaces_invoice_id: string | null;
  revision_source_invoice_id: string | null;
  created_at: string;
  updated_at: string;
  // Issuance fields
  pdf_generation_status: string | null;
  issued_at: string | null;
  // Void fields (Phase 7B-6C read model)
  void_reason: string | null;
  voided_at: string | null;
}

// ── Payment Summary Type ──────────────────────────────────────────────────────

interface PaymentSummary {
  amount_paid_cents: number;
  balance_remaining_cents: number;
}

// ── Email Delivery Types ──────────────────────────────────────────────────────

type InvoiceEmailDeliveryStatus =
  | 'not_sent' |'pending' |'sending' |'sent' |'failed' |'uncertain';

interface InvoiceEmailDelivery {
  status: InvoiceEmailDeliveryStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  sent_at: string | null;
  last_error_code: string | null;
}

const ALLOWED_EMAIL_STATUSES = new Set<string>([
  'not_sent', 'pending', 'sending', 'sent', 'failed', 'uncertain',
]);

const DEFAULT_EMAIL_DELIVERY: InvoiceEmailDelivery = {
  status: 'not_sent',
  attempt_count: 0,
  last_attempt_at: null,
  sent_at: null,
  last_error_code: null,
};

// ── Error message map ─────────────────────────────────────────────────────────

const ISSUE_ERROR_MESSAGES: Record<string, string> = {
  invoice_not_found: 'Invoice not found. Refresh the page and try again.',
  invoice_not_issuable: 'This invoice can no longer be issued.',
  invoice_invalid_state: 'The invoice state changed. Refresh the page and try again.',
  invoice_issue_state_invalid:
    'The invoice appears to be issued but its issuance state is incomplete. Please contact support before retrying.',
  invoice_pdf_generation_failed:
    'The invoice PDF could not be generated. Review the invoice content and try again.',
  invoice_pdf_processing_failed:
    'The invoice could not be processed. Please try again.',
  invoice_pdf_storage_failed:
    'The invoice PDF could not be stored. Please try again.',
  invoice_pdf_completion_failed:
    'The invoice PDF was created, but issuance could not be finalized. Please try again.',
  invoice_issue_failed: 'Invoice issuance failed. Please try again.',
};

// ── Revision error message map ────────────────────────────────────────────────

const REVISION_ERROR_MESSAGES: Record<string, string> = {
  revision_source_ineligible:
    'This invoice is no longer eligible for revision. Its status or payment activity may have changed.',
  revision_already_in_progress: 'A revision is already in progress for this invoice.',
  revision_create_source_invalid:
    'Funding details or the Deposit Goes Hard date must be corrected before creating a revision.',
  revision_create_line_items_invalid:
    'The invoice line items must be reviewed before creating a revision.',
  revision_source_not_found: 'Invoice not found.',
  admin_not_authorized: 'You are not authorized to create a revision.',
};

function mapRevisionError(token: string | undefined): string {
  if (token && REVISION_ERROR_MESSAGES[token]) return REVISION_ERROR_MESSAGES[token];
  return 'Unable to create the invoice revision.';
}

/**
 * Known safe begin_invoice_issuance messages returned verbatim by the API.
 * Map these to useful Admin-facing copy. Only exact matches are mapped.
 * Covers both normal and Revision begin-issuance safe messages.
 */
const BEGIN_ISSUANCE_SAFE_MESSAGES: Record<string, string> = {
  // ── Shared / normal begin-issuance ─────────────────────────────────────────
  'You are not authorized to issue this invoice.': 'You are not authorized to issue this invoice.',
  'Invoice not found.': 'Invoice not found. Refresh the page and try again.',
  'This invoice type is not supported for issuance.': 'This invoice type is not supported for issuance.',
  'The invoice draft is out of date. Refresh or update the draft before issuing.': 'The invoice draft is out of date. Refresh or update the draft before issuing.',
  'Invoice settings are incomplete.': 'Invoice settings must be completed before this invoice can be issued.',
  'Billing information is incomplete.': 'Complete the billing information before issuing this invoice.',
  'Invoice line items are not valid for issuance.': 'Review the invoice line items before issuing.',
  'Unable to begin invoice issuance.': 'Invoice issuance failed. Please try again.',
  // ── Revision begin-issuance ────────────────────────────────────────────────
  'The source invoice is no longer eligible for revision.': 'The source invoice is no longer eligible for revision.',
  'The revision draft is out of date. Refresh or update the draft before issuing.': 'The revision draft is out of date. Refresh or update the draft before issuing.',
  'Revision invoice line items are not valid for issuance.': 'Revision invoice line items are not valid for issuance.',
  'The source invoice number is not valid for revision issuance.': 'The source invoice number is not valid for revision issuance.',
  'No further revision number is available for this invoice.': 'No further revision number is available for this invoice.',
  'Unable to begin revision invoice issuance.': 'Revision issuance failed. Please try again.',
};

function mapIssueError(errorToken: string | undefined, rawMessage?: string): string {
  if (!errorToken && !rawMessage) return 'Invoice issuance failed. Please try again.';

  // 1. Try stable token map first
  if (errorToken && ISSUE_ERROR_MESSAGES[errorToken]) {
    return ISSUE_ERROR_MESSAGES[errorToken];
  }

  // 2. Try exact known safe begin-issuance messages via errorToken
  //    (API returns human-readable messages in json.error for begin-issuance errors)
  if (errorToken && BEGIN_ISSUANCE_SAFE_MESSAGES[errorToken]) {
    return BEGIN_ISSUANCE_SAFE_MESSAGES[errorToken];
  }

  // 3. Try exact known safe begin-issuance messages via rawMessage (json.message)
  if (rawMessage && BEGIN_ISSUANCE_SAFE_MESSAGES[rawMessage]) {
    return BEGIN_ISSUANCE_SAFE_MESSAGES[rawMessage];
  }

  // 4. Unknown — generic safe fallback (never display arbitrary server strings)
  return 'Invoice issuance failed. Please try again.';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCents(cents: number | null): string {
  if (cents == null) return '—';
  const abs = Math.abs(cents);
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs / 100);
  return cents < 0 ? `-${formatted}` : formatted;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';

  // DATE-only values (YYYY-MM-DD): format directly without timezone conversion.
  // This covers funding_date, period_start_date, period_end_date, due_date,
  // calc_period_start_date, calc_period_end_date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
  }

  // TIMESTAMPTZ values (issued_at, created_at): parse as real Date and
  // display in America/New_York so a UTC midnight-crossing is shown correctly.
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  return parsed.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format a TIMESTAMPTZ string for email delivery timestamps.
 * Displays month, day, year, hour, and minute in America/New_York.
 * Example: Sep 28, 2026, 7:46 PM
 */
function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  return parsed.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Parse a positive currency string like "1250" or "1,250.00" into integer cents.
 * Returns null if invalid.
 */
function parseCurrencyToCents(raw: string): number | null {
  const stripped = raw.replace(/[$,\s]/g, '');
  if (!stripped) return null;
  const match = stripped.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const dollars = parseInt(match[1], 10);
  const centsStr = (match[2] ?? '00').padEnd(2, '0').slice(0, 2);
  const cents = parseInt(centsStr, 10);
  return dollars * 100 + cents;
}

// ── Issue Invoice Confirmation Dialog ─────────────────────────────────────────

interface IssueInvoiceDialogProps {
  mode: 'draft' | 'issuing';
  pdfGenerationStatus: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  isRevision: boolean;
  sourceInvoiceNumber: string | null;
}

function IssueInvoiceDialog({
  mode,
  pdfGenerationStatus,
  onConfirm,
  onCancel,
  isSubmitting,
  isRevision,
  sourceInvoiceNumber,
}: IssueInvoiceDialogProps) {
  const isDraft = mode === 'draft';
  const isRetry = !isDraft && pdfGenerationStatus === 'failed';

  // ── Title ──────────────────────────────────────────────────────────────────
  let title: string;
  if (isDraft) {
    title = isRevision ? 'Issue Revision?' : 'Issue Invoice?';
  } else if (isRetry) {
    title = isRevision ? 'Retry Revision Issuance?' : 'Retry Issuance?';
  } else {
    title = isRevision ? 'Resume Revision Issuance?' : 'Resume Issuance?';
  }

  // ── Confirm label ──────────────────────────────────────────────────────────
  let confirmLabel: string;
  if (isDraft) {
    confirmLabel = isRevision ? 'Issue Revision' : 'Issue Invoice';
  } else if (isRetry) {
    confirmLabel = isRevision ? 'Retry Revision Issuance' : 'Retry Issuance';
  } else {
    confirmLabel = isRevision ? 'Resume Revision Issuance' : 'Resume Issuance';
  }

  // ── Loading label ──────────────────────────────────────────────────────────
  let loadingLabel: string;
  if (isDraft) {
    loadingLabel = isRevision ? 'Issuing Revision…' : 'Issuing…';
  } else if (isRetry) {
    loadingLabel = isRevision ? 'Retrying Revision…' : 'Resuming…';
  } else {
    loadingLabel = isRevision ? 'Resuming Revision…' : 'Resuming…';
  }

  // ── Body copy ──────────────────────────────────────────────────────────────
  const sourceRef = sourceInvoiceNumber ? sourceInvoiceNumber : 'the source invoice';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-md w-full p-6 space-y-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-eb-green-50 border border-eb-green-200 flex items-center justify-center">
            <Icon name="DocumentCheckIcon" size={16} className="text-eb-green-800" />
          </div>
          <div>
            <h2 className="text-sm font-display font-700 text-gray-900">{title}</h2>
            {isDraft ? (
              isRevision ? (
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  This revision will receive a permanent invoice number and can no longer be
                  edited after issuance begins. {sourceRef} will remain open unless and until
                  this revision is successfully completed. On successful completion, the source
                  invoice will be superseded and this revision will become the open invoice.
                  After successful issuance, the system will attempt to email the invoice PDF
                  to the billing email on the invoice.
                </p>
              ) : (
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  Once issued, this invoice will receive a permanent invoice number and can no
                  longer be edited. EarnestBridge will generate and store the final invoice PDF.
                  After successful issuance, the system will attempt to email the invoice PDF
                  to the billing email on the invoice.
                </p>
              )
            ) : (
              isRevision ? (
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  The already-assigned Revision invoice number will be reused — no second
                  Revision number will be assigned. The system will attempt to finish the PDF
                  issuance process. If issuance completes successfully, the system will attempt
                  to email the final invoice PDF to the billing email on the invoice.
                </p>
              ) : (
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                  The existing invoice number will be reused — no second invoice number will be
                  assigned. The system will attempt to finish the PDF issuance process. If
                  issuance completes successfully, the system will attempt to email the final
                  invoice PDF to the billing email on the invoice.
                </p>
              )
            )}
          </div>
        </div>

        {/* Key points */}
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2">
          {isDraft ? (
            isRevision ? (
              <>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="HashtagIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>A permanent Revision invoice number will be assigned.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="LockClosedIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>The Revision will be locked from further editing.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="DocumentTextIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>An immutable final PDF will be generated and stored.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="DocumentDuplicateIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>
                    {sourceRef} remains open while issuance is in progress. It will be
                    superseded only after successful completion.
                  </span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="EnvelopeIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>After successful issuance, the invoice PDF will be emailed to the billing email.</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="HashtagIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>A permanent invoice number will be assigned.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="LockClosedIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>The invoice will be locked from further editing.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="DocumentTextIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>An immutable PDF will be generated and stored.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="EnvelopeIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>After successful issuance, the invoice PDF will be emailed to the billing email.</span>
                </div>
              </>
            )
          ) : (
            isRevision ? (
              <>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="ArrowPathIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>The already-assigned Revision invoice number will be reused.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="DocumentTextIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>The system will attempt to complete PDF generation, storage, and finalization.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="DocumentDuplicateIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>{sourceRef} remains open unless this revision is successfully completed.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="EnvelopeIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>If issuance completes successfully, the system will attempt invoice email delivery.</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="ArrowPathIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>The existing invoice number will be reused.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="DocumentTextIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>The system will attempt to complete PDF generation and storage.</span>
                </div>
                <div className="flex items-start gap-2 text-xs text-gray-700">
                  <Icon name="EnvelopeIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                  <span>If issuance completes successfully, the system will attempt invoice email delivery.</span>
                </div>
              </>
            )
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="flex-1 px-4 py-2.5 text-sm font-display font-600 text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-all"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-display font-700 text-white bg-eb-green-900 rounded-xl hover:bg-eb-green-800 disabled:opacity-60 transition-all"
          >
            {isSubmitting ? (
              <>
                <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                {loadingLabel}
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Email Confirmation Dialog ─────────────────────────────────────────────────

interface EmailConfirmDialogProps {
  mode: 'send' | 'retry';
  billingEmail: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  inProgress: boolean;
}

function EmailConfirmDialog({
  mode,
  billingEmail,
  onConfirm,
  onCancel,
  inProgress,
}: EmailConfirmDialogProps) {
  const isSend = mode === 'send';
  let title = isSend ? 'Send Invoice Email?' : 'Retry Invoice Email?';
  let confirmLabel = isSend ? 'Send Invoice Email' : 'Retry Invoice Email';
  let loadingLabel = isSend ? 'Sending…' : 'Retrying…';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-md w-full p-6 space-y-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-blue-50 border border-blue-200 flex items-center justify-center">
            <Icon name="EnvelopeIcon" size={16} className="text-blue-700" />
          </div>
          <div>
            <h2 className="text-sm font-display font-700 text-gray-900">{title}</h2>
            {isSend ? (
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                This will email the final invoice PDF to the billing email saved on this invoice.
              </p>
            ) : (
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                This will make one new delivery attempt using the billing email and final PDF saved on this invoice.
              </p>
            )}
          </div>
        </div>

        {/* Recipient display */}
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2">
          <div className="flex items-start gap-2 text-xs text-gray-700">
            <Icon name="EnvelopeIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
            <span>
              <span className="font-display font-600 text-gray-500">Recipient: </span>
              <span className="font-display font-700 text-gray-900">{billingEmail ?? '—'}</span>
            </span>
          </div>
          <div className="flex items-start gap-2 text-xs text-gray-500">
            <Icon name="InformationCircleIcon" size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
            <span>
              {isSend
                ? 'The recipient and PDF are determined server-side and cannot be changed during this action.' :'No automatic resend will occur if delivery cannot be confirmed.'}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={inProgress}
            className="flex-1 px-4 py-2.5 text-sm font-display font-600 text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-all"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={inProgress}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-display font-700 text-white bg-blue-700 rounded-xl hover:bg-blue-600 disabled:opacity-60 transition-all"
          >
            {inProgress ? (
              <>
                <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                {loadingLabel}
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Discount Form ─────────────────────────────────────────────────────────────

interface DiscountFormProps {
  onAdd: (description: string, amountCents: number) => void;
  onCancel: () => void;
  saving: boolean;
}

function DiscountForm({ onAdd, onCancel, saving }: DiscountFormProps) {
  const [desc, setDesc] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!desc.trim()) {
      setFormError('Description is required.');
      return;
    }
    const cents = parseCurrencyToCents(amountStr);
    if (!cents || cents <= 0) {
      setFormError('Enter a valid positive discount amount.');
      return;
    }
    onAdd(desc.trim(), cents);
  }

  return (
    <form onSubmit={handleSubmit} className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
      <p className="text-xs font-display font-700 text-amber-800">Add Discount</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-500 mb-1">Description</label>
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="e.g. BPCON26 Discount"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all"
          />
        </div>
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-500 mb-1">Amount (positive)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
            <input
              type="text"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder="1,250.00"
              className="w-full pl-7 pr-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all"
            />
          </div>
        </div>
      </div>
      {formError && (
        <p className="text-xs text-red-600 flex items-center gap-1">
          <Icon name="ExclamationCircleIcon" size={12} />
          {formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-lg hover:bg-eb-green-800 disabled:opacity-50 transition-all"
        >
          {saving ? 'Adding…' : 'Add Discount'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Edit Discount Form ────────────────────────────────────────────────────────

interface EditDiscountFormProps {
  line: InvoiceLineItem;
  onSave: (id: string, description: string, amountCents: number) => void;
  onCancel: () => void;
  saving: boolean;
}

function EditDiscountForm({ line, onSave, onCancel, saving }: EditDiscountFormProps) {
  const [desc, setDesc] = useState(line.description);
  const [amountStr, setAmountStr] = useState(String(Math.abs(line.unit_amount_cents) / 100));
  const [formError, setFormError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!desc.trim()) {
      setFormError('Description is required.');
      return;
    }
    const cents = parseCurrencyToCents(amountStr);
    if (!cents || cents <= 0) {
      setFormError('Enter a valid positive discount amount.');
      return;
    }
    onSave(line.id, desc.trim(), cents);
  }

  return (
    <form onSubmit={handleSubmit} className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3 mt-2">
      <p className="text-xs font-display font-700 text-amber-800">Edit Discount</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-500 mb-1">Description</label>
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all"
          />
        </div>
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-500 mb-1">Amount (positive)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
            <input
              type="text"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              className="w-full pl-7 pr-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all"
            />
          </div>
        </div>
      </div>
      {formError && (
        <p className="text-xs text-red-600 flex items-center gap-1">
          <Icon name="ExclamationCircleIcon" size={12} />
          {formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-lg hover:bg-eb-green-800 disabled:opacity-50 transition-all"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const AdminInvoiceDetailContent: React.FC = () => {
  const params = useParams();
  const router = useRouter();
  const invoiceId = params?.invoiceId as string;

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lineItems, setLineItems] = useState<InvoiceLineItem[]>([]);
  const [settingsComplete, setSettingsComplete] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Revision context (from GET API)
  const [sourceInvoiceNumber, setSourceInvoiceNumber] = useState<string | null>(null);
  const [activeRevisionChild, setActiveRevisionChild] = useState<{ id: string; status: string } | null>(null);

  // Revision action state (for OPEN source invoice)
  const [revisingInProgress, setRevisingInProgress] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);

  // Form state — billing
  const [billingName, setBillingName] = useState('');
  const [billingContactName, setBillingContactName] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [billingAddressLine1, setBillingAddressLine1] = useState('');
  const [billingAddressLine2, setBillingAddressLine2] = useState('');
  const [billingCity, setBillingCity] = useState('');
  const [billingState, setBillingState] = useState('');
  const [billingPostalCode, setBillingPostalCode] = useState('');
  const [billingCountry, setBillingCountry] = useState('US');

  // Form state — other
  const [dueDate, setDueDate] = useState('');
  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  // Discount UI state
  const [showAddDiscount, setShowAddDiscount] = useState(false);
  const [editingDiscountId, setEditingDiscountId] = useState<string | null>(null);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Issue Invoice state
  const [showIssueDialog, setShowIssueDialog] = useState(false);
  const [isIssuing, setIsIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueSuccess, setIssueSuccess] = useState<string | null>(null);

  // Email delivery state
  const [emailDelivery, setEmailDelivery] = useState<InvoiceEmailDelivery>(DEFAULT_EMAIL_DELIVERY);
  const [emailActionInProgress, setEmailActionInProgress] = useState(false);
  const [emailActionError, setEmailActionError] = useState<string | null>(null);
  const [emailActionSuccess, setEmailActionSuccess] = useState<string | null>(null);
  const [showEmailConfirmDialog, setShowEmailConfirmDialog] = useState(false);

  // Computed totals (live from line items)
  const [liveTotals, setLiveTotals] = useState({
    subtotal_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    total_cents: 0,
  });

  // ── Payment state ───────────────────────────────────────────────────────────
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);
  const [paymentHistory, setPaymentHistory] = useState<PaymentRecord[]>([]);
  const [showRecordPaymentDialog, setShowRecordPaymentDialog] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState<string | null>(null);

  // ── Void state ──────────────────────────────────────────────────────────────
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [voidSuccess, setVoidSuccess] = useState<string | null>(null);

  // ── Load invoice ────────────────────────────────────────────────────────────
  const loadInvoice = useCallback(async () => {
    if (!invoiceId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        let json = await res.json().catch(() => ({}));
        setLoadError(json.error ?? 'Failed to load invoice.');
        setLoading(false);
        return;
      }
      let json = await res.json();
      const inv: Invoice = json.invoice;
      const lines: InvoiceLineItem[] = json.line_items ?? [];

      setInvoice(inv);
      setLineItems(lines);
      setSettingsComplete(json.settings_complete ?? true);
      setSourceInvoiceNumber(json.source_invoice_number ?? null);
      setActiveRevisionChild(json.active_revision_child ?? null);

      // ── Payment history + summary ────────────────────────────────────────
      const rawPaymentHistory = json.payment_history;
      if (Array.isArray(rawPaymentHistory)) {
        setPaymentHistory(rawPaymentHistory as PaymentRecord[]);
      } else {
        setPaymentHistory([]);
      }
      const rawPaymentSummary = json.payment_summary;
      if (
        rawPaymentSummary &&
        typeof rawPaymentSummary === 'object' &&
        typeof rawPaymentSummary.amount_paid_cents === 'number' &&
        typeof rawPaymentSummary.balance_remaining_cents === 'number'
      ) {
        setPaymentSummary({
          amount_paid_cents: rawPaymentSummary.amount_paid_cents,
          balance_remaining_cents: rawPaymentSummary.balance_remaining_cents,
        });
      } else {
        setPaymentSummary(null);
      }

      // ── Email delivery state ─────────────────────────────────────────────
      // Validate the returned email_delivery object. If missing or malformed,
      // treat the entire invoice GET as failed rather than inventing "not_sent".
      const rawDelivery = json.email_delivery;
      if (rawDelivery == null || typeof rawDelivery !== 'object' || Array.isArray(rawDelivery)) {
        setLoadError('Invoice email delivery status could not be loaded. Refresh the page.');
        setLoading(false);
        return;
      }
      const deliveryStatus = (rawDelivery as Record<string, unknown>).status;
      if (typeof deliveryStatus !== 'string' || !ALLOWED_EMAIL_STATUSES.has(deliveryStatus)) {
        setLoadError('Invoice email delivery status is invalid. Refresh the page.');
        setLoading(false);
        return;
      }

      // ── Strict validation of all remaining delivery fields ───────────────
      const rawAttemptCount = (rawDelivery as Record<string, unknown>).attempt_count;
      if (
        typeof rawAttemptCount !== 'number' ||
        !Number.isInteger(rawAttemptCount) ||
        rawAttemptCount < 0
      ) {
        setLoadError('Invoice email delivery status is invalid. Refresh the page.');
        setLoading(false);
        return;
      }

      const rawLastAttemptAt = (rawDelivery as Record<string, unknown>).last_attempt_at;
      if (
        rawLastAttemptAt !== null &&
        !(typeof rawLastAttemptAt === 'string' && rawLastAttemptAt.trim() !== '' && !isNaN(new Date(rawLastAttemptAt).getTime()))
      ) {
        setLoadError('Invoice email delivery status is invalid. Refresh the page.');
        setLoading(false);
        return;
      }

      const rawSentAt = (rawDelivery as Record<string, unknown>).sent_at;
      if (
        rawSentAt !== null &&
        !(typeof rawSentAt === 'string' && rawSentAt.trim() !== '' && !isNaN(new Date(rawSentAt).getTime()))
      ) {
        setLoadError('Invoice email delivery status is invalid. Refresh the page.');
        setLoading(false);
        return;
      }

      const rawLastErrorCode = (rawDelivery as Record<string, unknown>).last_error_code;
      if (rawLastErrorCode !== null && typeof rawLastErrorCode !== 'string') {
        setLoadError('Invoice email delivery status is invalid. Refresh the page.');
        setLoading(false);
        return;
      }

      setEmailDelivery({
        status: deliveryStatus as InvoiceEmailDeliveryStatus,
        attempt_count: rawAttemptCount,
        last_attempt_at: rawLastAttemptAt as string | null,
        sent_at: rawSentAt as string | null,
        last_error_code: rawLastErrorCode as string | null,
      });

      // Populate form fields
      setBillingName(inv.billing_name ?? '');
      setBillingContactName(inv.billing_contact_name ?? '');
      setBillingEmail(inv.billing_email ?? '');
      setBillingAddressLine1(inv.billing_address_line1 ?? '');
      setBillingAddressLine2(inv.billing_address_line2 ?? '');
      setBillingCity(inv.billing_city ?? '');
      setBillingState(inv.billing_state ?? '');
      setBillingPostalCode(inv.billing_postal_code ?? '');
      setBillingCountry(inv.billing_country ?? 'US');
      setDueDate(inv.due_date ?? '');
      setInvoiceNotes(inv.invoice_notes ?? '');
      setInternalNotes(inv.internal_notes ?? '');

      // Compute live totals
      computeLiveTotals(lines);
    } catch {
      setLoadError('Failed to load invoice.');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    loadInvoice();
  }, [loadInvoice]);

  function computeLiveTotals(lines: InvoiceLineItem[]) {
    let subtotal = 0;
    let discount = 0;
    for (const line of lines) {
      if (line.line_type === 'discount') {
        discount += Math.abs(line.line_amount_cents);
      } else {
        subtotal += line.line_amount_cents;
      }
    }
    const total = Math.max(0, subtotal - discount);
    setLiveTotals({ subtotal_cents: subtotal, discount_cents: discount, tax_cents: 0, total_cents: total });
  }

  // ── Issue Invoice ───────────────────────────────────────────────────────────
  async function handleConfirmIssue() {
    if (!invoice || isIssuing) return;
    // Guard: only allow for draft or issuing
    if (invoice.status !== 'draft' && invoice.status !== 'issuing') return;

    setIsIssuing(true);
    setIssueError(null);
    setIssueSuccess(null);
    setShowIssueDialog(false);

    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/issue`, {
        method: 'POST',
        headers: { 'Cache-Control': 'no-store' },
      });

      let json: Record<string, unknown> = {};
      try {
        json = await res.json();
      } catch {
        // non-JSON response — treat as failure
        setIssueError('Invoice issuance failed. Please refresh the page.');
        await loadInvoice();
        return;
      }

      if (!res.ok) {
        // Extract token and raw message for mapping — never display raw strings directly
        const errorToken = typeof json.error === 'string' ? json.error : undefined;
        const rawMessage = typeof json.message === 'string' ? json.message : undefined;
        setIssueError(mapIssueError(errorToken, rawMessage));
        // Refresh authoritative state after failure so issuing invoices can show Resume
        await loadInvoice();
        return;
      }

      // ── Strict 2xx validation — fail closed ──────────────────────────────

      // 1. success must be exactly true
      if (json.success !== true) {
        setIssueError('Invoice issuance failed. Please refresh the page.');
        await loadInvoice();
        return;
      }

      // 2. already_issued must be a boolean
      if (typeof json.already_issued !== 'boolean') {
        setIssueError('Invoice issuance failed. Please refresh the page.');
        await loadInvoice();
        return;
      }

      // 3. invoice must be a non-null, non-array object
      const inv = json.invoice;
      if (!inv || typeof inv !== 'object' || Array.isArray(inv)) {
        setIssueError('Invoice issuance failed. Please refresh the page.');
        await loadInvoice();
        return;
      }
      const invoiceObj = inv as Record<string, unknown>;

      // 4. invoice.id must match current invoiceId
      if (invoiceObj.id !== invoiceId) {
        setIssueError('Invoice issuance failed. Please refresh the page.');
        await loadInvoice();
        return;
      }

      // 5. invoice.status must be 'open'
      if (invoiceObj.status !== 'open') {
        setIssueError('Invoice issuance failed. Please refresh the page.');
        await loadInvoice();
        return;
      }

      // 6. invoice.invoice_number must be a non-empty string
      if (typeof invoiceObj.invoice_number !== 'string' || !invoiceObj.invoice_number.trim()) {
        setIssueError('Invoice issuance failed. Please refresh the page.');
        await loadInvoice();
        return;
      }

      const alreadyIssued = json.already_issued === true;

      if (!alreadyIssued) {
        // ── Newly-issued: additional required fields ───────────────────────

        // 7. issued_at: non-empty string and valid timestamp
        if (
          typeof invoiceObj.issued_at !== 'string' ||
          !invoiceObj.issued_at.trim() ||
          isNaN(new Date(invoiceObj.issued_at).getTime())
        ) {
          setIssueError('Invoice issuance failed. Please refresh the page.');
          await loadInvoice();
          return;
        }

        // 8. pdf_generation_status must be 'generated'
        if (invoiceObj.pdf_generation_status !== 'generated') {
          setIssueError('Invoice issuance failed. Please refresh the page.');
          await loadInvoice();
          return;
        }

        // 9. total_cents must be a safe integer
        if (!Number.isSafeInteger(invoiceObj.total_cents)) {
          setIssueError('Invoice issuance failed. Please refresh the page.');
          await loadInvoice();
          return;
        }

        // All newly-issued validations passed — Revision-aware success message
        const isRevisionIssue = invoice.revision_source_invoice_id != null;
        setIssueSuccess(isRevisionIssue ? 'Revision issued successfully.' : 'Invoice issued successfully.');
      } else {
        // ── already_issued=true: smaller safe response — no issued_at/pdf/total required
        const isRevisionIssue = invoice.revision_source_invoice_id != null;
        setIssueSuccess(isRevisionIssue ? 'Revision is already issued.' : 'Invoice is already issued.');
      }

      // Reload authoritative invoice state
      await loadInvoice();

      // Auto-clear success message after 5s
      setTimeout(() => setIssueSuccess(null), 5000);
    } catch {
      setIssueError('Invoice issuance failed. Please try again.');
      // Attempt to refresh state
      await loadInvoice();
    } finally {
      setIsIssuing(false);
    }
  }

  // ── Create Revision handler (for OPEN source invoice) ──────────────────────
  async function handleCreateRevision() {
    if (!invoice || revisingInProgress) return;
    setRevisingInProgress(true);
    setRevisionError(null);

    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/revise`, {
        method: 'POST',
      });

      let json: Record<string, unknown> = {};
      try {
        json = await res.json();
      } catch {
        // non-JSON body
      }

      if (!res.ok || json.success !== true) {
        const token = typeof json.error === 'string' ? json.error : undefined;
        setRevisionError(mapRevisionError(token));
        return;
      }

      const returnedInvoiceId = json.invoice_id;
      if (typeof returnedInvoiceId !== 'string' || returnedInvoiceId.trim() === '') {
        setRevisionError('Unable to create the invoice revision.');
        return;
      }

      router.push(`/admin/invoices/${returnedInvoiceId}`);
    } catch {
      setRevisionError('Unable to create the invoice revision.');
    } finally {
      setRevisingInProgress(false);
    }
  }

  // ── Waive Admin Fee shortcut ────────────────────────────────────────────────
  function handleWaiveAdminFee() {
    // Check if an admin fee waiver already exists
    const alreadyWaived = lineItems.some(
      (l) => l.line_type === 'discount' && l.description === 'Admin Fee Waiver'
    );
    if (alreadyWaived) return;

    // Find admin fee amount
    const adminFeeLine = lineItems.find((l) => l.line_type === 'admin_fee');
    if (!adminFeeLine) return;

    // Add waiver via save
    handleSaveDraft([{
      op: 'add',
      description: 'Admin Fee Waiver',
      amount_cents: adminFeeLine.line_amount_cents,
    }]);
  }

  // ── Add discount ────────────────────────────────────────────────────────────
  function handleAddDiscount(description: string, amountCents: number) {
    setShowAddDiscount(false);
    handleSaveDraft([{ op: 'add', description, amount_cents: amountCents }]);
  }

  // ── Edit discount ───────────────────────────────────────────────────────────
  function handleEditDiscount(id: string, description: string, amountCents: number) {
    setEditingDiscountId(null);
    handleSaveDraft([{ op: 'update', id, description, amount_cents: amountCents }]);
  }

  // ── Delete discount ─────────────────────────────────────────────────────────
  function handleDeleteDiscount(id: string) {
    handleSaveDraft([{ op: 'delete', id }]);
  }

  // ── Save draft ──────────────────────────────────────────────────────────────
  async function handleSaveDraft(
    discountOps?: Array<{ op: 'add' | 'update' | 'delete'; id?: string; description?: string; amount_cents?: number }>
  ) {
    if (!invoice || invoice.status !== 'draft') return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const payload: Record<string, unknown> = {
      billing_name: billingName,
      billing_contact_name: billingContactName,
      billing_email: billingEmail,
      billing_address_line1: billingAddressLine1,
      billing_address_line2: billingAddressLine2,
      billing_city: billingCity,
      billing_state: billingState,
      billing_postal_code: billingPostalCode,
      billing_country: billingCountry,
      due_date: dueDate || null,
      invoice_notes: invoiceNotes,
      internal_notes: internalNotes,
    };

    if (discountOps && discountOps.length > 0) {
      payload.discount_ops = discountOps;
    }

    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let json = await res.json();
      if (!res.ok) {
        setSaveError(json.error ?? 'Failed to save invoice.');
        return;
      }

      // Update live totals from server response
      setLiveTotals({
        subtotal_cents: json.subtotal_cents,
        discount_cents: json.discount_cents,
        tax_cents: json.tax_cents,
        total_cents: json.total_cents,
      });

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);

      // Reload line items to reflect discount changes
      await loadInvoice();
    } catch {
      setSaveError('Failed to save invoice. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Email action handler ────────────────────────────────────────────────────
  async function handleConfirmEmailAction() {
    if (!invoice || emailActionInProgress) return;
    setEmailActionInProgress(true);
    setEmailActionError(null);
    setEmailActionSuccess(null);
    setShowEmailConfirmDialog(false);

    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/email`, {
        method: 'POST',
        headers: { 'Cache-Control': 'no-store' },
      });

      let json: Record<string, unknown> = {};
      try {
        json = await res.json();
      } catch {
        setEmailActionError('Invoice email could not be processed. Refresh the page and try again.');
        return;
      }

      const outcome = typeof json.outcome === 'string' ? json.outcome : null;

      if (outcome === 'sent') {
        setEmailActionSuccess('Invoice email sent successfully.');
      } else if (outcome === 'already_sent') {
        setEmailActionSuccess('Invoice email was already sent.');
      } else if (outcome === 'currently_sending') {
        setEmailActionError('Invoice email delivery is already in progress.');
      } else if (outcome === 'uncertain') {
        setEmailActionError('Delivery could not be confirmed. Do not retry automatically.');
      } else if (outcome === 'failed') {
        setEmailActionError('Invoice email could not be sent. Review the status and retry when appropriate.');
      } else {
        setEmailActionError('Invoice email could not be processed. Refresh the page and try again.');
      }
    } catch {
      setEmailActionError('Invoice email could not be processed. Refresh the page and try again.');
    } finally {
      setEmailActionInProgress(false);
      // Always reload authoritative status from GET API after every POST attempt
      await loadInvoice();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Icon name="ArrowPathIcon" size={16} className="animate-spin" />
          Loading invoice…
        </div>
      </div>
    );
  }

  if (loadError || !invoice) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-red-200 p-6 max-w-md w-full text-center">
          <Icon name="ExclamationCircleIcon" size={32} className="text-red-400 mx-auto mb-3" />
          <p className="text-sm font-display font-700 text-gray-900 mb-1">Invoice Not Found</p>
          <p className="text-xs text-gray-500 mb-4">{loadError ?? 'This invoice could not be loaded.'}</p>
          <button
            onClick={() => router.back()}
            className="px-4 py-2 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-all"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  const isDraft = invoice.status === 'draft';
  const isIssuingStatus = invoice.status === 'issuing';
  const isVoid = invoice.status === 'void';

  // Revision detection: authoritative field only — never infer from invoice_number suffix
  const isRevision = invoice.revision_source_invoice_id != null;

  // A Revision Draft: has revision_source_invoice_id AND status = 'draft'
  const isRevisionDraft = isDraft && isRevision;

  // Issue action is shown for ANY draft (including Revision Drafts) and issuing invoices
  // Backend Revision issuance is now complete — enable for Revision Drafts too
  const showIssueAction = isDraft || isIssuingStatus;

  // Label for the issue/resume button — Revision-aware
  let issueButtonLabel: string;
  if (isDraft) {
    issueButtonLabel = isRevision ? 'Issue Revision' : 'Issue Invoice';
  } else if (invoice.pdf_generation_status === 'failed') {
    issueButtonLabel = isRevision ? 'Retry Revision Issuance' : 'Retry Issuance';
  } else {
    issueButtonLabel = isRevision ? 'Resume Revision Issuance' : 'Resume Issuance';
  }

  // Loading label for the top-right button — Revision-aware
  let issueLoadingLabel: string;
  if (isDraft) {
    issueLoadingLabel = isRevision ? 'Issuing Revision…' : 'Issuing…';
  } else if (invoice.pdf_generation_status === 'failed') {
    issueLoadingLabel = isRevision ? 'Retrying Revision…' : 'Resuming…';
  } else {
    issueLoadingLabel = isRevision ? 'Resuming Revision…' : 'Resuming…';
  }

  // PDF action visibility: only when pdf is generated AND status is a retrievable issued status
  const PDF_RETRIEVABLE_STATUSES = new Set(['open', 'partially_paid', 'paid', 'void']);
  const showPdfActions =
    invoice.pdf_generation_status === 'generated' &&
    PDF_RETRIEVABLE_STATUSES.has(invoice.status);

  const pdfViewUrl = `/api/admin/invoices/${invoiceId}/pdf`;
  const pdfDownloadUrl = `/api/admin/invoices/${invoiceId}/pdf?disposition=attachment`;

  // Header number display
  // Revision Draft: "Revision Draft — Number assigned when issued"
  // Normal Draft: "Draft — Number assigned when issued"
  // Issued: invoice_number
  const invoiceNumberDisplay = invoice.invoice_number
    ? invoice.invoice_number
    : isRevisionDraft
    ? 'Revision Draft — Number assigned when issued' :'Draft — Number assigned when issued';

  const discountLines = lineItems.filter((l) => l.line_type === 'discount');
  const baseLines = lineItems.filter((l) => l.line_type !== 'discount');
  const adminFeeWaived = discountLines.some((l) => l.description === 'Admin Fee Waiver');

  // ── Email card visibility ────────────────────────────────────────────────
  // Show card for open, partially_paid, paid, void — NOT draft or issuing
  const EMAIL_CARD_STATUSES = new Set(['open', 'partially_paid', 'paid', 'void']);
  const showEmailCard = EMAIL_CARD_STATUSES.has(invoice.status);

  // ── Email action eligibility ─────────────────────────────────────────────
  // Action allowed only for open/partially_paid/paid + pdf generated + invoice_number + issued_at
  const EMAIL_ACTION_STATUSES = new Set(['open', 'partially_paid', 'paid']);
  const emailActionEligible =
    EMAIL_ACTION_STATUSES.has(invoice.status) &&
    invoice.pdf_generation_status === 'generated' &&
    typeof invoice.invoice_number === 'string' &&
    invoice.invoice_number.trim() !== '' &&
    typeof invoice.issued_at === 'string' &&
    invoice.issued_at.trim() !== '';

  // Show Send button for not_sent and pending; Retry for failed; none otherwise
  const showEmailSendButton =
    emailActionEligible &&
    (emailDelivery.status === 'not_sent' || emailDelivery.status === 'pending');
  const showEmailRetryButton =
    emailActionEligible && emailDelivery.status === 'failed';

  // Revision button variant for OPEN source invoices
  // open + initial + no active child → 'create'
  // open + initial + active child is draft → 'open_draft'
  // open + initial + active child is issuing/open/partially_paid/paid → 'in_progress'
  const isOpenInitial = invoice.status === 'open' && invoice.invoice_type === 'initial';
  let revisionVariant: 'create' | 'open_draft' | 'in_progress' | null = null;
  if (isOpenInitial) {
    if (!activeRevisionChild) {
      revisionVariant = 'create';
    } else if (activeRevisionChild.status === 'draft') {
      revisionVariant = 'open_draft';
    } else {
      revisionVariant = 'in_progress';
    }
  }

  // Status badge styling
  function getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'draft':
        return 'text-gray-600 bg-gray-50 border-gray-200';
      case 'issuing':
        return 'text-blue-700 bg-blue-50 border-blue-200';
      case 'open':
        return 'text-emerald-700 bg-emerald-50 border-emerald-200';
      case 'partially_paid':
        return 'text-amber-700 bg-amber-50 border-amber-200';
      case 'paid':
        return 'text-green-700 bg-green-50 border-green-200';
      case 'void':
        return 'text-red-600 bg-red-50 border-red-200';
      default:
        return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  }

  function getStatusLabel(status: string): string {
    switch (status) {
      case 'draft': return 'Draft';
      case 'issuing': return 'Issuing…';
      case 'open': return 'Open';
      case 'partially_paid': return 'Partially Paid';
      case 'paid': return 'Paid';
      case 'void': return 'Void';
      default: return status;
    }
  }

  // ── Void button visibility ──────────────────────────────────────────────────
  // Show "Void Invoice" ONLY when status === 'open'
  const showVoidAction = invoice.status === 'open';

  // Active revision guard: if open invoice has active_revision_child, disable void
  const voidBlockedByRevision =
    showVoidAction && activeRevisionChild != null;

  // Payment guard: if amount_paid_cents > 0, disable void (defense-in-depth)
  const voidBlockedByPayment =
    showVoidAction &&
    paymentSummary != null &&
    paymentSummary.amount_paid_cents > 0;

  const voidEnabled =
    showVoidAction && !voidBlockedByRevision && !voidBlockedByPayment;

  // Void disabled reason (for tooltip/explanation)
  let voidDisabledReason: string | null = null;
  if (voidBlockedByRevision) {
    voidDisabledReason = 'This invoice has an active revision and cannot be voided.';
  } else if (voidBlockedByPayment) {
    voidDisabledReason = 'Invoices with received payments cannot be voided.';
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Issue Invoice Confirmation Dialog */}
      {showIssueDialog && (
        <IssueInvoiceDialog
          mode={isDraft ? 'draft' : 'issuing'}
          pdfGenerationStatus={invoice.pdf_generation_status}
          onConfirm={handleConfirmIssue}
          onCancel={() => setShowIssueDialog(false)}
          isSubmitting={isIssuing}
          isRevision={isRevision}
          sourceInvoiceNumber={sourceInvoiceNumber}
        />
      )}

      {/* Email Confirmation Dialog */}
      {showEmailConfirmDialog && (
        <EmailConfirmDialog
          mode={emailDelivery.status === 'failed' ? 'retry' : 'send'}
          billingEmail={invoice.billing_email}
          onConfirm={handleConfirmEmailAction}
          onCancel={() => setShowEmailConfirmDialog(false)}
          inProgress={emailActionInProgress}
        />
      )}

      {/* Record Payment Dialog */}
      {showRecordPaymentDialog && paymentSummary && (
        <RecordPaymentDialog
          invoiceId={invoiceId}
          invoiceTotalCents={invoice.total_cents}
          balanceRemainingCents={paymentSummary.balance_remaining_cents}
          onSuccess={async () => {
            setShowRecordPaymentDialog(false);
            setPaymentSuccess('Payment recorded successfully.');
            await loadInvoice();
            setTimeout(() => setPaymentSuccess(null), 5000);
          }}
          onRefresh={loadInvoice}
          onClose={() => setShowRecordPaymentDialog(false)}
        />
      )}

      {/* Void Invoice Dialog */}
      {showVoidDialog && (
        <VoidInvoiceDialog
          invoiceId={invoiceId}
          invoiceNumber={invoice.invoice_number}
          invoiceTotalCents={invoice.total_cents}
          onSuccess={async () => {
            setShowVoidDialog(false);
            setVoidSuccess('Invoice voided successfully.');
            await loadInvoice();
            setTimeout(() => setVoidSuccess(null), 5000);
          }}
          onRefresh={loadInvoice}
          onClose={() => setShowVoidDialog(false)}
        />
      )}

      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => router.back()}
              className="flex items-center gap-1.5 text-xs font-display font-600 text-gray-500 hover:text-gray-700 transition-colors flex-shrink-0"
            >
              <Icon name="ArrowLeftIcon" size={13} />
              Back
            </button>
            <div className="w-px h-4 bg-gray-200 flex-shrink-0" />
            <div className="flex items-center gap-2 min-w-0">
              <Icon name="DocumentTextIcon" size={15} className="text-eb-green-700 flex-shrink-0" />
              <span className="text-sm font-display font-700 text-gray-900 truncate">
                {invoiceNumberDisplay}
              </span>
              <span className={`text-[10px] font-display font-600 px-2 py-0.5 rounded-full border flex-shrink-0 ${getStatusBadgeClass(invoice.status)}`}>
                {getStatusLabel(invoice.status)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            {saveSuccess && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-700">
                <Icon name="CheckCircleIcon" size={13} />
                Saved
              </span>
            )}
            {issueSuccess && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-700">
                <Icon name="CheckCircleIcon" size={13} />
                {issueSuccess}
              </span>
            )}
            {voidSuccess && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-700">
                <Icon name="CheckCircleIcon" size={13} />
                {voidSuccess}
              </span>
            )}
            {isDraft && (
              <button
                onClick={() => handleSaveDraft()}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 text-xs font-display font-700 rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-all"
              >
                {saving ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : <Icon name="CheckIcon" size={13} />}
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
            )}
            {/* Issue Invoice — top-right button */}
            {showIssueAction && (
              <button
                onClick={() => { setIssueError(null); setShowIssueDialog(true); }}
                disabled={isIssuing || saving}
                className="flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 transition-all"
              >
                {isIssuing ? (
                  <>
                    <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                    {issueLoadingLabel}
                  </>
                ) : (
                  <>
                    <Icon name="DocumentCheckIcon" size={13} />
                    {issueButtonLabel}
                  </>
                )}
              </button>
            )}
            {/* Create Revision / Open Revision Draft — for OPEN initial invoices */}
            {revisionVariant === 'create' && (
              <button
                onClick={handleCreateRevision}
                disabled={revisingInProgress}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-violet-200 text-violet-700 text-xs font-display font-700 rounded-xl hover:bg-violet-50 disabled:opacity-50 transition-all"
              >
                {revisingInProgress ? (
                  <>
                    <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <Icon name="DocumentDuplicateIcon" size={13} />
                    Create Revision
                  </>
                )}
              </button>
            )}
            {revisionVariant === 'open_draft' && (
              <button
                onClick={handleCreateRevision}
                disabled={revisingInProgress}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-violet-200 text-violet-700 text-xs font-display font-700 rounded-xl hover:bg-violet-50 disabled:opacity-50 transition-all"
              >
                {revisingInProgress ? (
                  <>
                    <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                    Opening…
                  </>
                ) : (
                  <>
                    <Icon name="DocumentTextIcon" size={13} />
                    Open Revision Draft
                  </>
                )}
              </button>
            )}
            {revisionVariant === 'in_progress' && (
              <span className="text-xs text-gray-400 font-display font-600">
                Revision in progress
              </span>
            )}
            {showPdfActions && (
              <>
                <a
                  href={pdfViewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View invoice PDF"
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 text-xs font-display font-700 rounded-xl hover:bg-gray-50 transition-all"
                >
                  <Icon name="DocumentMagnifyingGlassIcon" size={13} />
                  View PDF
                </a>
                <a
                  href={pdfDownloadUrl}
                  aria-label="Download invoice PDF"
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-500 text-xs font-display font-600 rounded-xl hover:bg-gray-50 transition-all"
                >
                  <Icon name="ArrowDownTrayIcon" size={13} />
                  Download PDF
                </a>
              </>
            )}
            {/* Void Invoice — top-right button, only for open invoices */}
            {showVoidAction && (
              voidEnabled ? (
                <button
                  type="button"
                  onClick={() => setShowVoidDialog(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-600 text-xs font-display font-700 rounded-xl hover:bg-red-50 transition-all"
                >
                  <Icon name="NoSymbolIcon" size={13} />
                  Void Invoice
                </button>
              ) : (
                <div className="relative group">
                  <button
                    type="button"
                    disabled
                    className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-400 text-xs font-display font-700 rounded-xl cursor-not-allowed opacity-60"
                    aria-disabled="true"
                    aria-label={voidDisabledReason ?? 'Void Invoice unavailable'}
                  >
                    <Icon name="NoSymbolIcon" size={13} />
                    Void Invoice
                  </button>
                  {voidDisabledReason && (
                    <div className="absolute right-0 top-full mt-1.5 z-10 w-64 bg-gray-900 text-white text-[11px] rounded-lg px-3 py-2 leading-relaxed opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                      {voidDisabledReason}
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">

        {/* Invoice settings warning */}
        {!settingsComplete && (
          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <Icon name="ExclamationTriangleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>Invoice settings must be completed before this invoice can be issued.</span>
          </div>
        )}

        {/* Save error */}
        {saveError && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{saveError}</span>
          </div>
        )}

        {/* Issue error */}
        {issueError && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{issueError}</span>
          </div>
        )}

        {/* Revision action error */}
        {revisionError && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{revisionError}</span>
          </div>
        )}

        {/* Payment success notification */}
        {paymentSuccess && (
          <div className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
            <Icon name="CheckCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{paymentSuccess}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Left column: billing + notes */}
          <div className="lg:col-span-2 space-y-5">

            {/* Invoice summary card */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                <Icon name="InformationCircleIcon" size={14} className="text-gray-400" />
                <h2 className="font-display font-700 text-sm text-gray-900">Invoice Details</h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
                <div>
                  <p className="text-gray-400 font-display font-600 mb-0.5">Type</p>
                  <p className="text-gray-900 font-display font-700 capitalize">{invoice.invoice_type}</p>
                </div>
                <div>
                  <p className="text-gray-400 font-display font-600 mb-0.5">Status</p>
                  <p className="text-gray-900 font-display font-700 capitalize">{getStatusLabel(invoice.status)}</p>
                </div>
                <div>
                  <p className="text-gray-400 font-display font-600 mb-0.5">Created</p>
                  <p className="text-gray-900 font-display font-700">{formatDate(invoice.created_at)}</p>
                </div>
                {/* Revision Of — shown for ANY Revision invoice when isRevision and sourceInvoiceNumber exist */}
                {isRevision && sourceInvoiceNumber && (
                  <div>
                    <p className="text-gray-400 font-display font-600 mb-0.5">Revision Of</p>
                    <p className="text-violet-700 font-display font-700">{sourceInvoiceNumber}</p>
                  </div>
                )}
                {invoice.issued_at && (
                  <div>
                    <p className="text-gray-400 font-display font-600 mb-0.5">Issued</p>
                    <p className="text-gray-900 font-display font-700">{formatDate(invoice.issued_at)}</p>
                  </div>
                )}
                {invoice.emd_funded_cents != null && (
                  <div>
                    <p className="text-gray-400 font-display font-600 mb-0.5">EMD Funded</p>
                    <p className="text-gray-900 font-display font-700">{formatCents(invoice.emd_funded_cents)}</p>
                  </div>
                )}
                {invoice.funding_date && (
                  <div>
                    <p className="text-gray-400 font-display font-600 mb-0.5">Funding Date</p>
                    <p className="text-gray-900 font-display font-700">{formatDate(invoice.funding_date)}</p>
                  </div>
                )}
                {invoice.billable_days != null && (
                  <div>
                    <p className="text-gray-400 font-display font-600 mb-0.5">Billable Days</p>
                    <p className="text-gray-900 font-display font-700">{invoice.billable_days} days</p>
                  </div>
                )}
                {invoice.period_start_date && (
                  <div>
                    <p className="text-gray-400 font-display font-600 mb-0.5">Period Start</p>
                    <p className="text-gray-900 font-display font-700">{formatDate(invoice.period_start_date)}</p>
                  </div>
                )}
                {invoice.period_end_date && (
                  <div>
                    <p className="text-gray-400 font-display font-600 mb-0.5">Period End</p>
                    <p className="text-gray-900 font-display font-700">{formatDate(invoice.period_end_date)}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Billing editor */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                <Icon name="BuildingOfficeIcon" size={14} className="text-gray-400" />
                <h2 className="font-display font-700 text-sm text-gray-900">Billed To</h2>
                {!isDraft && (
                  <span className="ml-auto text-[10px] text-gray-400 font-display font-600">Read-only</span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Billing Name</label>
                  <input
                    type="text"
                    value={billingName}
                    onChange={(e) => setBillingName(e.target.value)}
                    disabled={!isDraft}
                    placeholder="Company or individual name"
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Billing Contact</label>
                  <input
                    type="text"
                    value={billingContactName}
                    onChange={(e) => setBillingContactName(e.target.value)}
                    disabled={!isDraft}
                    placeholder="Contact name"
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Billing Email</label>
                  <input
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    disabled={!isDraft}
                    placeholder="billing@example.com"
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Address Line 1</label>
                  <input
                    type="text"
                    value={billingAddressLine1}
                    onChange={(e) => setBillingAddressLine1(e.target.value)}
                    disabled={!isDraft}
                    placeholder="Street address"
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Address Line 2</label>
                  <input
                    type="text"
                    value={billingAddressLine2}
                    onChange={(e) => setBillingAddressLine2(e.target.value)}
                    disabled={!isDraft}
                    placeholder="Suite, unit, etc."
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">City</label>
                  <input
                    type="text"
                    value={billingCity}
                    onChange={(e) => setBillingCity(e.target.value)}
                    disabled={!isDraft}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">State</label>
                  <input
                    type="text"
                    value={billingState}
                    onChange={(e) => setBillingState(e.target.value)}
                    disabled={!isDraft}
                    placeholder="CA"
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Postal Code</label>
                  <input
                    type="text"
                    value={billingPostalCode}
                    onChange={(e) => setBillingPostalCode(e.target.value)}
                    disabled={!isDraft}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Country</label>
                  <input
                    type="text"
                    value={billingCountry}
                    onChange={(e) => setBillingCountry(e.target.value)}
                    disabled={!isDraft}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
              </div>
              <p className="text-[11px] text-gray-400 mt-3">
                Billing edits update only this invoice draft. They do not modify CRM company or contact records.
              </p>
            </div>

            {/* Line items */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <Icon name="ListBulletIcon" size={14} className="text-gray-400" />
                  <h2 className="font-display font-700 text-sm text-gray-900">Line Items</h2>
                </div>
                {isDraft && (
                  <div className="flex items-center gap-2">
                    {!adminFeeWaived && (
                      <button
                        onClick={handleWaiveAdminFee}
                        className="text-[11px] font-display font-600 text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition-all"
                      >
                        Waive Admin Fee
                      </button>
                    )}
                    <button
                      onClick={() => { setShowAddDiscount(true); setEditingDiscountId(null); }}
                      className="flex items-center gap-1.5 text-[11px] font-display font-600 text-eb-green-900 border border-eb-green-200 rounded-lg px-2.5 py-1.5 hover:bg-eb-green-50 transition-all"
                    >
                      <Icon name="PlusIcon" size={11} />
                      Add Discount
                    </button>
                  </div>
                )}
              </div>

              {/* Line items table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left pb-2 font-display font-600 text-gray-400">Description</th>
                      <th className="text-right pb-2 font-display font-600 text-gray-400 w-16">Qty</th>
                      <th className="text-right pb-2 font-display font-600 text-gray-400 w-28">Rate</th>
                      <th className="text-right pb-2 font-display font-600 text-gray-400 w-28">Amount</th>
                      {isDraft && <th className="w-16 pb-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {/* Base lines (read-only) */}
                    {baseLines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-3 pr-4">
                          <p className="font-display font-600 text-gray-900">{line.description}</p>
                          {line.line_type === 'deal_fee' && line.calc_billable_days != null && (
                            <p className="text-[10px] text-gray-400 mt-0.5">
                              {line.calc_billable_days} billable days
                              {line.calc_period_start_date && line.calc_period_end_date
                                ? ` · ${formatDate(line.calc_period_start_date)} – ${formatDate(line.calc_period_end_date)}`
                                : ''}
                            </p>
                          )}
                        </td>
                        <td className="py-3 text-right text-gray-600">{line.quantity}</td>
                        <td className="py-3 text-right text-gray-600">{formatCents(line.unit_amount_cents)}</td>
                        <td className="py-3 text-right font-display font-700 text-gray-900">{formatCents(line.line_amount_cents)}</td>
                        {isDraft && (
                          <td className="py-3 text-right">
                            <span className="text-[10px] text-gray-300 font-display font-600">System</span>
                          </td>
                        )}
                      </tr>
                    ))}

                    {/* Discount lines */}
                    {discountLines.map((line) => (
                      <React.Fragment key={line.id}>
                        <tr className="bg-amber-50/30">
                          <td className="py-3 pr-4">
                            <p className="font-display font-600 text-amber-800">{line.description}</p>
                          </td>
                          <td className="py-3 text-right text-amber-700">{line.quantity}</td>
                          <td className="py-3 text-right text-amber-700">{formatCents(line.unit_amount_cents)}</td>
                          <td className="py-3 text-right font-display font-700 text-amber-800">{formatCents(line.line_amount_cents)}</td>
                          {isDraft && (
                            <td className="py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => setEditingDiscountId(editingDiscountId === line.id ? null : line.id)}
                                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                  title="Edit"
                                >
                                  <Icon name="PencilSquareIcon" size={12} />
                                </button>
                                <button
                                  onClick={() => handleDeleteDiscount(line.id)}
                                  className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                                  title="Delete"
                                >
                                  <Icon name="TrashIcon" size={12} />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                        {editingDiscountId === line.id && isDraft && (
                          <tr>
                            <td colSpan={isDraft ? 5 : 4} className="pb-3">
                              <EditDiscountForm
                                line={line}
                                onSave={handleEditDiscount}
                                onCancel={() => setEditingDiscountId(null)}
                                saving={saving}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Add discount form */}
              {showAddDiscount && isDraft && (
                <div className="mt-4">
                  <DiscountForm
                    onAdd={handleAddDiscount}
                    onCancel={() => setShowAddDiscount(false)}
                    saving={saving}
                  />
                </div>
              )}

              {/* Totals */}
              <div className="mt-5 pt-4 border-t border-gray-100 space-y-2">
                <div className="flex justify-between text-xs text-gray-600">
                  <span className="font-display font-600">Subtotal</span>
                  <span>{formatCents(liveTotals.subtotal_cents)}</span>
                </div>
                {liveTotals.discount_cents > 0 && (
                  <div className="flex justify-between text-xs text-amber-700">
                    <span className="font-display font-600">Discounts</span>
                    <span>-{formatCents(liveTotals.discount_cents)}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs text-gray-400">
                  <span className="font-display font-600">Tax (0%)</span>
                  <span>$0.00</span>
                </div>
                <div className="flex justify-between text-sm font-display font-700 text-gray-900 pt-2 border-t border-gray-100">
                  <span>Total</span>
                  <span>{formatCents(liveTotals.total_cents)}</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                <Icon name="ChatBubbleLeftEllipsisIcon" size={14} className="text-gray-400" />
                <h2 className="font-display font-700 text-sm text-gray-900">Notes</h2>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
                    Invoice Notes
                  </label>
                  <textarea
                    value={invoiceNotes}
                    onChange={(e) => setInvoiceNotes(e.target.value)}
                    disabled={!isDraft}
                    rows={3}
                    placeholder="Optional client-facing note that may appear on the issued invoice."
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 resize-none transition-all disabled:bg-gray-50 disabled:text-gray-500"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Optional client-facing note that may appear on the issued invoice.
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
                    Internal Notes
                    <span className="ml-1.5 text-[10px] text-gray-400 font-400 normal-case">(Admin only)</span>
                  </label>
                  <textarea
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    rows={3}
                    placeholder="Internal CRM note. Never shown to the client."
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 resize-none transition-all"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Internal CRM note. Never shown to the client.
                  </p>
                </div>
              </div>
            </div>

            {/* Payment History — shown for open, partially_paid, paid, void */}
            {['open', 'partially_paid', 'paid', 'void'].includes(invoice.status) && (
              <PaymentHistorySection
                payments={paymentHistory}
                invoiceId={invoiceId as string}
                onReceiptGenerated={loadInvoice}
              />
            )}

          </div>

          {/* Right column: payment terms + summary */}
          <div className="space-y-5">

            {/* Payment Terms */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                <Icon name="CalendarDaysIcon" size={14} className="text-gray-400" />
                <h2 className="font-display font-700 text-sm text-gray-900">Payment Terms</h2>
              </div>
              <div>
                <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={!isDraft}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                />
                <p className="text-[11px] text-gray-400 mt-1.5">
                  {dueDate
                    ? `Due ${formatDate(dueDate)}`
                    : 'Due Upon Receipt — leave blank to use default.'}
                </p>
              </div>
            </div>

            {/* Invoice Summary */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                <Icon name="CalculatorIcon" size={14} className="text-gray-400" />
                <h2 className="font-display font-700 text-sm text-gray-900">Summary</h2>
              </div>
              <div className="space-y-2.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 font-display font-600">Subtotal</span>
                  <span className="text-gray-900 font-display font-700">{formatCents(liveTotals.subtotal_cents)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 font-display font-600">Discounts</span>
                  <span className={liveTotals.discount_cents > 0 ? 'text-amber-700 font-display font-700' : 'text-gray-400'}>
                    {liveTotals.discount_cents > 0 ? `-${formatCents(liveTotals.discount_cents)}` : '$0.00'}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 font-display font-600">Tax (0%)</span>
                  <span className="text-gray-400">$0.00</span>
                </div>
                <div className="flex justify-between text-sm pt-2 border-t border-gray-100">
                  <span className="font-display font-700 text-gray-900">Total</span>
                  <span className="font-display font-700 text-eb-green-900 text-base">{formatCents(liveTotals.total_cents)}</span>
                </div>
              </div>
            </div>

            {/* Payment Summary — shown for open, partially_paid, paid */}
            {paymentSummary && ['open', 'partially_paid', 'paid'].includes(invoice.status) && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                  <Icon name="BanknotesIcon" size={14} className="text-gray-400" />
                  <h2 className="font-display font-700 text-sm text-gray-900">Payment</h2>
                </div>
                <div className="space-y-2.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500 font-display font-600">Invoice Total</span>
                    <span className="text-gray-900 font-display font-700">{formatCents(invoice.total_cents)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500 font-display font-600">Amount Paid</span>
                    <span className={paymentSummary.amount_paid_cents > 0 ? 'text-emerald-700 font-display font-700' : 'text-gray-400'}>
                      {formatCents(paymentSummary.amount_paid_cents)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm pt-2 border-t border-gray-100">
                    <span className="font-display font-700 text-gray-900">Balance Remaining</span>
                    <span className={`font-display font-700 text-base ${paymentSummary.balance_remaining_cents === 0 ? 'text-emerald-700' : 'text-eb-green-900'}`}>
                      {formatCents(paymentSummary.balance_remaining_cents)}
                    </span>
                  </div>
                </div>

                {/* Paid badge */}
                {invoice.status === 'paid' && (
                  <div className="mt-3 flex items-center gap-1.5 text-[11px] font-display font-600 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                    <Icon name="CheckCircleIcon" size={12} className="flex-shrink-0" />
                    Paid
                  </div>
                )}

                {/* Partially paid indicator */}
                {invoice.status === 'partially_paid' && (
                  <div className="mt-3 flex items-center gap-1.5 text-[11px] font-display font-600 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <Icon name="ClockIcon" size={12} className="flex-shrink-0" />
                    Partial payment received
                  </div>
                )}

                {/* Record Payment button — only for open and partially_paid */}
                {(invoice.status === 'open' || invoice.status === 'partially_paid') && (
                  <button
                    type="button"
                    onClick={() => setShowRecordPaymentDialog(true)}
                    className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 transition-all"
                  >
                    <Icon name="BanknotesIcon" size={13} />
                    Record Payment
                  </button>
                )}
              </div>
            )}

            {/* Void state display card — shown when status === 'void' */}
            {isVoid && (
              <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-red-100">
                  <Icon name="NoSymbolIcon" size={14} className="text-red-500" />
                  <h2 className="font-display font-700 text-sm text-red-700">Void</h2>
                  <span className="ml-auto text-[10px] font-display font-600 px-2 py-0.5 rounded-full border text-red-600 bg-red-50 border-red-200">
                    VOID
                  </span>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-[11px] font-display font-600 text-gray-400 mb-0.5">Voided At</p>
                    <p className="text-xs font-display font-700 text-gray-900">
                      {invoice.voided_at
                        ? (() => {
                            const d = new Date(invoice.voided_at);
                            return isNaN(d.getTime())
                              ? '—' : d.toLocaleString('en-US', {
                                  timeZone: 'America/New_York',
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                  hour: 'numeric',
                                  minute: '2-digit',
                                });
                          })()
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-display font-600 text-gray-400 mb-0.5">Void Reason</p>
                    <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
                      {invoice.void_reason ?? '—'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Invoice Email card */}
            {showEmailCard && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                  <Icon name="EnvelopeIcon" size={14} className="text-gray-400" />
                  <h2 className="font-display font-700 text-sm text-gray-900">Invoice Email</h2>
                </div>

                {/* Status badge */}
                <div className="mb-3">
                  {emailDelivery.status === 'not_sent' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 px-2.5 py-1 rounded-full border text-gray-600 bg-gray-50 border-gray-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" />
                      Not Sent
                    </span>
                  )}
                  {emailDelivery.status === 'pending' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 px-2.5 py-1 rounded-full border text-blue-700 bg-blue-50 border-blue-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                      Pending
                    </span>
                  )}
                  {emailDelivery.status === 'sending' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 px-2.5 py-1 rounded-full border text-blue-700 bg-blue-50 border-blue-200">
                      <Icon name="ArrowPathIcon" size={11} className="animate-spin flex-shrink-0" />
                      Sending…
                    </span>
                  )}
                  {emailDelivery.status === 'sent' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 px-2.5 py-1 rounded-full border text-emerald-700 bg-emerald-50 border-emerald-200">
                      <Icon name="CheckCircleIcon" size={11} className="flex-shrink-0" />
                      Sent
                    </span>
                  )}
                  {emailDelivery.status === 'failed' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 px-2.5 py-1 rounded-full border text-red-700 bg-red-50 border-red-200">
                      <Icon name="ExclamationCircleIcon" size={11} className="flex-shrink-0" />
                      Failed
                    </span>
                  )}
                  {emailDelivery.status === 'uncertain' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 px-2.5 py-1 rounded-full border text-amber-700 bg-amber-50 border-amber-200">
                      <Icon name="ExclamationTriangleIcon" size={11} className="flex-shrink-0" />
                      Delivery Uncertain
                    </span>
                  )}
                </div>

                {/* Status copy */}
                <div className="space-y-2 mb-3">
                  {emailDelivery.status === 'not_sent' && (
                    <p className="text-[11px] text-gray-500 leading-relaxed">
                      No invoice email has been sent for this invoice.
                    </p>
                  )}
                  {emailDelivery.status === 'pending' && (
                    <p className="text-[11px] text-gray-500 leading-relaxed">
                      Invoice email delivery is pending.
                    </p>
                  )}
                  {emailDelivery.status === 'sending' && (
                    <p className="text-[11px] text-gray-500 leading-relaxed">
                      Invoice email delivery is currently in progress. Refresh the invoice to check the latest status.
                    </p>
                  )}
                  {emailDelivery.status === 'sent' && (
                    <p className="text-[11px] text-gray-500 leading-relaxed">
                      The invoice email was successfully delivered to the email provider.
                      {emailDelivery.sent_at && (
                        <span className="block mt-1 text-emerald-700 font-display font-600">
                          Sent {formatDateTime(emailDelivery.sent_at)}
                        </span>
                      )}
                    </p>
                  )}
                  {emailDelivery.status === 'failed' && (
                    <p className="text-[11px] text-gray-500 leading-relaxed">
                      The most recent invoice email attempt failed. You may retry the delivery.
                    </p>
                  )}
                  {emailDelivery.status === 'uncertain' && (
                    <p className="text-[11px] text-amber-700 leading-relaxed">
                      The delivery outcome could not be confirmed. Do not retry automatically. Verify delivery before taking further action.
                    </p>
                  )}
                </div>

                {/* Attempt metadata */}
                {emailDelivery.attempt_count > 0 && (
                  <div className="text-[11px] text-gray-400 space-y-1 mb-3">
                    <p>
                      <span className="font-display font-600">Attempts:</span>{' '}
                      {emailDelivery.attempt_count}
                    </p>
                    {emailDelivery.last_attempt_at && (
                      <p>
                        <span className="font-display font-600">Last attempt:</span>{' '}
                        {formatDateTime(emailDelivery.last_attempt_at)}
                      </p>
                    )}
                    {(emailDelivery.status === 'failed' || emailDelivery.status === 'uncertain') &&
                      emailDelivery.last_error_code && (
                        <p>
                          <span className="font-display font-600">Reference:</span>{' '}
                          {emailDelivery.last_error_code}
                        </p>
                      )}
                  </div>
                )}

                {/* Email action feedback */}
                {emailActionSuccess && (
                  <div className="flex items-start gap-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">
                    <Icon name="CheckCircleIcon" size={12} className="flex-shrink-0 mt-0.5" />
                    <span>{emailActionSuccess}</span>
                  </div>
                )}
                {emailActionError && (
                  <div className="flex items-start gap-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
                    <Icon name="ExclamationCircleIcon" size={12} className="flex-shrink-0 mt-0.5" />
                    <span>{emailActionError}</span>
                  </div>
                )}

                {/* Action buttons — void invoices never show a button */}
                {invoice.status !== 'void' && (
                  <>
                    {showEmailSendButton && (
                      <button
                        type="button"
                        onClick={() => {
                          setEmailActionError(null);
                          setEmailActionSuccess(null);
                          setShowEmailConfirmDialog(true);
                        }}
                        disabled={emailActionInProgress}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-700 text-white text-xs font-display font-700 rounded-xl hover:bg-blue-600 disabled:opacity-50 transition-all"
                      >
                        {emailActionInProgress ? (
                          <>
                            <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                            Sending…
                          </>
                        ) : (
                          <>
                            <Icon name="EnvelopeIcon" size={13} />
                            Send Invoice Email
                          </>
                        )}
                      </button>
                    )}
                    {showEmailRetryButton && (
                      <button
                        type="button"
                        onClick={() => {
                          setEmailActionError(null);
                          setEmailActionSuccess(null);
                          setShowEmailConfirmDialog(true);
                        }}
                        disabled={emailActionInProgress}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-600 text-white text-xs font-display font-700 rounded-xl hover:bg-amber-500 disabled:opacity-50 transition-all"
                      >
                        {emailActionInProgress ? (
                          <>
                            <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                            Retrying…
                          </>
                        ) : (
                          <>
                            <Icon name="ArrowPathIcon" size={13} />
                            Retry Invoice Email
                          </>
                        )}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Status-specific notice cards */}
            {isDraft && (
              isRevisionDraft ? (
                /* Revision Draft notice — replaces generic Draft Invoice notice */
                <div className="bg-violet-50 border border-violet-200 rounded-xl p-4">
                  <div className="flex items-start gap-2">
                    <Icon name="InformationCircleIcon" size={14} className="text-violet-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-display font-700 text-violet-800 mb-1">Revision Draft</p>
                      <p className="text-[11px] text-violet-700 leading-relaxed">
                        This invoice is a revision of{' '}
                        <span className="font-700">{sourceInvoiceNumber ?? 'the original invoice'}</span>.
                        The original invoice remains open until this revision is successfully issued.
                        A new invoice number will be assigned when the revision is issued.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                /* Normal Draft notice — unchanged */
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <div className="flex items-start gap-2">
                    <Icon name="InformationCircleIcon" size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-display font-700 text-blue-800 mb-1">Draft Invoice</p>
                      <p className="text-[11px] text-blue-700 leading-relaxed">
                        This invoice is in draft status. No invoice number has been assigned.
                        Invoice number will be assigned when issued.
                      </p>
                    </div>
                  </div>
                </div>
              )
            )}

            {isIssuingStatus && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <div className="flex items-start gap-2">
                  <Icon name="ClockIcon" size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-display font-700 text-amber-800 mb-1">Issuance In Progress</p>
                    <p className="text-[11px] text-amber-700 leading-relaxed">
                      This invoice is currently being issued. Invoice number:{' '}
                      <span className="font-700">{invoice.invoice_number ?? '—'}</span>.
                      {invoice.pdf_generation_status === 'failed'
                        ? (isRevision
                            ? 'PDF generation failed. Use Retry Revision Issuance to try again.' :' PDF generation failed. Use Retry Issuance to try again.')
                        : (isRevision
                            ? ' Use Resume Revision Issuance to continue if the process did not complete.'
                            : ' Use Resume Issuance to continue if the process did not complete.')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Issue Invoice action card — Revision-aware */}
            {showIssueAction && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-3 pb-3 border-b border-gray-100">
                  <Icon name="DocumentCheckIcon" size={14} className="text-eb-green-700" />
                  <h2 className="font-display font-700 text-sm text-gray-900">
                    {isDraft
                      ? (isRevision ? 'Issue Revision' : 'Issue Invoice')
                      : (isRevision ? 'Revision Issuance' : 'Issuance')}
                  </h2>
                </div>
                <p className="text-[11px] text-gray-500 leading-relaxed mb-4">
                  {isDraft
                    ? (isRevision
                        ? 'Issuing will assign the permanent Revision invoice number, lock the Revision, generate the final PDF, and only supersede the source invoice after successful completion. After successful issuance, the system will attempt to email the invoice PDF to the billing email on the invoice.'
                        : 'Issuing will assign a permanent invoice number, lock the invoice from editing, and generate the final PDF. After successful issuance, the system will attempt to email the invoice PDF to the billing email on the invoice.')
                    : (isRevision
                        ? 'The already-assigned Revision invoice number will be reused — no second Revision number will be assigned. The system will attempt to complete PDF generation, storage, and finalization. The source invoice remains open unless this revision is successfully completed.'
                        : 'The issuance process was started but did not complete. Use the button below to safely resume or retry without creating a new invoice number.')}
                </p>
                <button
                  onClick={() => { setIssueError(null); setShowIssueDialog(true); }}
                  disabled={isIssuing || saving}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-eb-green-900 text-white text-sm font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 transition-all"
                >
                  {isIssuing ? (
                    <>
                      <Icon name="ArrowPathIcon" size={14} className="animate-spin" />
                      {issueLoadingLabel}
                    </>
                  ) : (
                    <>
                      <Icon name="DocumentCheckIcon" size={14} />
                      {issueButtonLabel}
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Save button (bottom, draft only) */}
            {isDraft && (
              <button
                onClick={() => handleSaveDraft()}
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white border border-gray-200 text-gray-700 text-sm font-display font-700 rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-all"
              >
                {saving ? <Icon name="ArrowPathIcon" size={14} className="animate-spin" /> : <Icon name="CheckIcon" size={14} />}
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminInvoiceDetailContent;
