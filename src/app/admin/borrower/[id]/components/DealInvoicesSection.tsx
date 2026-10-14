'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DealInvoice {
  id: string;
  invoice_number: string | null;
  invoice_type: string;
  status: string;
  total_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  created_at: string;
  issued_at: string | null;
  billing_name: string | null;
  billing_email: string | null;
  due_date: string | null;
  replaces_invoice_id: string | null;
  revision_source_invoice_id: string | null;
  emd_funded_cents: number | null;
  funding_date: string | null;
  billable_days: number | null;
}

interface DealInvoicesSectionProps {
  applicationId: string;
  isMockId?: boolean;
  // Financial prerequisites passed from parent for prerequisite messaging
  emdFundedCents?: number | null;
  fundedDate?: string | null;
  originalHardDate?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCentsAsCurrency(cents: number | null): string {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const raw = dateStr.split('T')[0];
  const [y, m, d] = raw.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  draft:          { label: 'Draft',          color: 'text-gray-600',    bg: 'bg-gray-50',     border: 'border-gray-200' },
  issuing:        { label: 'Issuing',        color: 'text-blue-700',    bg: 'bg-blue-50',     border: 'border-blue-200' },
  open:           { label: 'Open',           color: 'text-amber-700',   bg: 'bg-amber-50',    border: 'border-amber-200' },
  partially_paid: { label: 'Partial',        color: 'text-orange-700',  bg: 'bg-orange-50',   border: 'border-orange-200' },
  paid:           { label: 'Paid',           color: 'text-emerald-700', bg: 'bg-emerald-50',  border: 'border-emerald-200' },
  void:           { label: 'Void',           color: 'text-red-600',     bg: 'bg-red-50',      border: 'border-red-200' },
};

const TYPE_LABELS: Record<string, string> = {
  initial:   'Initial',
  extension: 'Extension',
  other:     'Other',
};

// ── Revision helpers ──────────────────────────────────────────────────────────

// Statuses that count as an "active" child revision (blocks or replaces the button)
const ACTIVE_REVISION_STATUSES = new Set(['draft', 'issuing', 'open', 'partially_paid', 'paid']);

// A possible revision source (UI eligibility only — server is authoritative)
function isRevisionSource(inv: DealInvoice): boolean {
  return (
    inv.invoice_type === 'initial' &&
    inv.status === 'open' &&
    inv.invoice_number != null &&
    inv.invoice_number.trim() !== ''
  );
}

// Map API error tokens to admin-facing messages
function mapRevisionError(token: string | undefined): string {
  switch (token) {
    case 'revision_source_ineligible':
      return 'This invoice is no longer eligible for revision. Its status or payment activity may have changed.';
    case 'revision_already_in_progress':
      return 'A revision is already in progress for this invoice.';
    case 'revision_create_source_invalid':
      return 'Funding details or the Deposit Goes Hard date must be corrected before creating a revision.';
    case 'revision_create_line_items_invalid':
      return 'The invoice line items must be reviewed before creating a revision.';
    case 'revision_source_not_found':
      return 'Invoice not found.';
    case 'admin_not_authorized':
      return 'You are not authorized to create a revision.';
    default:
      return 'Unable to create the invoice revision.';
  }
}

// ── UI-only relationship helpers ──────────────────────────────────────────────
// These are derived purely from the loaded invoice list. No API calls.
// Canonical replacement relationship: replacement.replaces_invoice_id === source.id
// Revision lineage: revision.revision_source_invoice_id === source.id
// Do NOT infer relationships from invoice-number suffixes, created_at, array order, or status alone.

/**
 * Returns the replacement invoice for a given source invoice id, if one exists
 * in the current list (i.e. another invoice whose replaces_invoice_id === sourceId).
 */
function findReplacementInvoice(invoices: DealInvoice[], sourceId: string): DealInvoice | null {
  return invoices.find((inv) => inv.replaces_invoice_id === sourceId) ?? null;
}

/**
 * Returns true if the given invoice has been superseded — meaning another invoice
 * in the list has replaces_invoice_id === invoice.id.
 */
function isSuperseded(invoices: DealInvoice[], invoice: DealInvoice): boolean {
  return invoices.some((inv) => inv.replaces_invoice_id === invoice.id);
}

/**
 * Returns true if the invoice is a Revision invoice (has revision_source_invoice_id set).
 * Do NOT infer from invoice_number suffix, replaces_invoice_id, or invoice_type.
 */
function isRevisionInvoice(inv: DealInvoice): boolean {
  return inv.revision_source_invoice_id != null;
}

// ── Component ─────────────────────────────────────────────────────────────────

const DealInvoicesSection: React.FC<DealInvoicesSectionProps> = ({
  applicationId,
  isMockId = false,
  emdFundedCents,
  fundedDate,
  originalHardDate,
}) => {
  const router = useRouter();
  const [invoices, setInvoices] = useState<DealInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Track which source invoice is currently being revised (for loading/double-click protection)
  const [revisingInvoiceId, setRevisingInvoiceId] = useState<string | null>(null);
  // Per-source revision error (keyed by source invoice id)
  const [revisionErrors, setRevisionErrors] = useState<Record<string, string>>({});

  const loadInvoices = useCallback(async () => {
    if (isMockId) {
      setInvoices([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/invoices?application_id=${applicationId}`);
      if (!res.ok) {
        let json = await res.json().catch(() => ({}));
        setError(json.error ?? 'Failed to load invoices.');
        setLoading(false);
        return;
      }
      let json = await res.json();
      setInvoices(json.invoices ?? []);
    } catch {
      setError('Failed to load invoices.');
    } finally {
      setLoading(false);
    }
  }, [applicationId, isMockId]);

  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

  async function handleCreateInitialInvoice() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/admin/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ application_id: applicationId }),
      });
      let json = await res.json();
      if (!res.ok) {
        setCreateError(json.error ?? 'Failed to create invoice.');
        return;
      }
      // Navigate to the invoice detail page
      router.push(`/admin/invoices/${json.invoice_id}`);
    } catch {
      setCreateError('Failed to create invoice. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  // ── Create Revision handler ───────────────────────────────────────────────
  async function handleCreateRevision(sourceInvoiceId: string) {
    if (revisingInvoiceId != null) return; // double-click protection

    setRevisingInvoiceId(sourceInvoiceId);
    setRevisionErrors((prev) => {
      const next = { ...prev };
      delete next[sourceInvoiceId];
      return next;
    });

    try {
      const res = await fetch(`/api/admin/invoices/${sourceInvoiceId}/revise`, {
        method: 'POST',
        credentials: 'same-origin',
      });

      let json: Record<string, unknown> = {};
      try {
        json = await res.json();
      } catch {
        // non-JSON body — fall through to error handling
      }

      if (!res.ok || json.success !== true) {
        const token = typeof json.error === 'string' ? json.error : undefined;
        setRevisionErrors((prev) => ({
          ...prev,
          [sourceInvoiceId]: mapRevisionError(token),
        }));
        return;
      }

      // Validate that invoice_id is a non-empty string before navigating
      const invoiceId = json.invoice_id;
      if (typeof invoiceId !== 'string' || invoiceId.trim() === '') {
        setRevisionErrors((prev) => ({
          ...prev,
          [sourceInvoiceId]: 'Unable to create the invoice revision.',
        }));
        return;
      }

      // Navigate to the returned Revision Draft (works for both 'created' and 'existing_draft')
      router.push(`/admin/invoices/${invoiceId}`);
    } catch {
      setRevisionErrors((prev) => ({
        ...prev,
        [sourceInvoiceId]: 'Unable to create the invoice revision.',
      }));
    } finally {
      setRevisingInvoiceId(null);
    }
  }

  // A "normal" initial invoice is one with invoice_type='initial', replaces_invoice_id=null,
  // AND revision_source_invoice_id=null. The revision_source_invoice_id guard ensures Revision
  // Drafts (which also have replaces_invoice_id=null while in Draft) are never counted as
  // normal initial invoices.
  // Once ANY normal initial invoice has ever existed (any status), we must never show
  // "Create Initial Invoice" again. Void initial invoices require a replacement workflow.
  const normalInitialInvoices = invoices.filter(
    (inv) =>
      inv.invoice_type === 'initial' &&
      inv.replaces_invoice_id === null &&
      inv.revision_source_invoice_id === null
  );
  const hasAnyNormalInitial = normalInitialInvoices.length > 0;

  // A void normal initial invoice is only "unresolved" if no canonical replacement exists.
  // Canonical replacement: another invoice whose replaces_invoice_id === voidInvoice.id
  const voidInitialInvoice = normalInitialInvoices.find((inv) => inv.status === 'void') ?? null;
  const voidInitialReplacement = voidInitialInvoice
    ? findReplacementInvoice(invoices, voidInitialInvoice.id)
    : null;
  // Show the red warning only when there is a void initial invoice with NO canonical replacement.
  const showUnresolvedVoidWarning = voidInitialInvoice != null && voidInitialReplacement == null;

  // ── Financial prerequisite check (independent of Deal status) ────────────
  // Determine which prerequisites are missing so we can show helpful messages.
  // These props may be undefined if the parent doesn't pass them — in that case
  // we rely on the server to validate and surface errors via createError.
  const missingPrerequisites: string[] = [];
  if (emdFundedCents !== undefined && (!emdFundedCents || emdFundedCents <= 0)) {
    missingPrerequisites.push('Actual EMD Funded');
  }
  if (fundedDate !== undefined && !fundedDate) {
    missingPrerequisites.push('Funding Date');
  }
  if (originalHardDate !== undefined && !originalHardDate) {
    missingPrerequisites.push('Original Deposit Goes Hard Date');
  }
  // Pair ordering check
  if (fundedDate && originalHardDate) {
    const fundedTs = new Date(fundedDate + 'T00:00:00');
    const hardTs = new Date(originalHardDate + 'T00:00:00');
    if (hardTs <= fundedTs) {
      missingPrerequisites.push('Hard Date must be after Funding Date');
    }
  }

  const hasPrerequisiteData = missingPrerequisites.length === 0;

  // Show "Create Initial Invoice" only when NO normal initial invoice has ever existed
  const showCreateButton = !hasAnyNormalInitial && !isMockId;

  // Build a helpful prerequisite message
  function getPrerequisiteMessage(): string | null {
    if (emdFundedCents === undefined && fundedDate === undefined && originalHardDate === undefined) {
      // Props not passed — don't show a message, let server validate
      return null;
    }
    if (missingPrerequisites.length === 0) return null;
    if (missingPrerequisites.length === 1 && missingPrerequisites[0] === 'Original Deposit Goes Hard Date') {
      return 'Set the Original Deposit Goes Hard Date before creating an invoice.';
    }
    if (missingPrerequisites.includes('Actual EMD Funded') || missingPrerequisites.includes('Funding Date')) {
      const parts = missingPrerequisites.filter(p => p !== 'Hard Date must be after Funding Date');
      if (parts.length > 0) {
        return `Enter ${parts.join(' and ')} before creating an invoice.`;
      }
    }
    if (missingPrerequisites.includes('Hard Date must be after Funding Date')) {
      return 'Original Deposit Goes Hard Date must be after the Funding Date.';
    }
    return `Complete required fields before creating an invoice: ${missingPrerequisites.join(', ')}.`;
  }

  const prerequisiteMessage = getPrerequisiteMessage();

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Icon name="DocumentTextIcon" size={15} className="text-eb-green-700" />
          <h3 className="font-display font-700 text-sm text-gray-900">Invoices</h3>
        </div>
        {showCreateButton && (
          <button
            onClick={handleCreateInitialInvoice}
            disabled={creating || !hasPrerequisiteData}
            title={prerequisiteMessage ?? undefined}
            className="flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {creating ? (
              <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
            ) : (
              <Icon name="PlusIcon" size={13} />
            )}
            {creating ? 'Creating…' : 'Create Initial Invoice'}
          </button>
        )}
      </div>

      {/* Prerequisite message — shown when financial data is incomplete */}
      {showCreateButton && prerequisiteMessage && (
        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 mb-4">
          <Icon name="InformationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
          <span>{prerequisiteMessage}</span>
        </div>
      )}

      {/* Create error */}
      {createError && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 mb-4">
          <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
          <span>{createError}</span>
        </div>
      )}

      {/* Mock ID notice */}
      {isMockId && (
        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-3">
          <Icon name="InformationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
          <span>Invoice management is not available for demo deals.</span>
        </div>
      )}

      {/* Loading */}
      {!isMockId && loading && (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-6 justify-center">
          <Icon name="ArrowPathIcon" size={14} className="animate-spin" />
          Loading invoices…
        </div>
      )}

      {/* Load error */}
      {!isMockId && !loading && error && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Empty state */}
      {!isMockId && !loading && !error && invoices.length === 0 && (
        <div className="text-center py-10 border border-dashed border-gray-200 rounded-xl">
          <div className="w-10 h-10 rounded-xl bg-gray-50 border border-gray-200 flex items-center justify-center mx-auto mb-3">
            <Icon name="DocumentTextIcon" size={18} className="text-gray-400" />
          </div>
          <p className="text-sm font-display font-600 text-gray-600 mb-1">No invoices yet</p>
          {prerequisiteMessage ? (
            <p className="text-xs text-amber-600 mb-4 px-4">{prerequisiteMessage}</p>
          ) : (
            <p className="text-xs text-gray-400 mb-4">
              Create an initial invoice once funding details are complete.
            </p>
          )}
          {showCreateButton && (
            <button
              onClick={handleCreateInitialInvoice}
              disabled={creating || !hasPrerequisiteData}
              className="inline-flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 transition-all"
            >
              {creating ? (
                <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
              ) : (
                <Icon name="PlusIcon" size={13} />
              )}
              {creating ? 'Creating…' : 'Create Initial Invoice'}
            </button>
          )}
        </div>
      )}

      {/* Unresolved void initial invoice warning — shown ONLY when no canonical replacement exists */}
      {!isMockId && !loading && !error && showUnresolvedVoidWarning && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl mb-3">
          <Icon name="ExclamationTriangleIcon" size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-display font-700 text-red-700 mb-0.5">
              Initial Invoice Voided
            </p>
            <p className="text-xs text-red-600">
              The initial invoice for this deal is void and no replacement invoice is currently linked.
            </p>
          </div>
        </div>
      )}

      {/* Invoice list */}
      {!isMockId && !loading && !error && invoices.length > 0 && (
        <div className="space-y-3">
          {invoices.map((inv) => {
            const statusCfg = STATUS_CONFIG[inv.status] ?? STATUS_CONFIG.draft;
            const typeLabel = TYPE_LABELS[inv.invoice_type] ?? inv.invoice_type;
            const isDraft = inv.status === 'draft';
            const invoiceNumberDisplay = inv.invoice_number
              ? inv.invoice_number
              : 'Draft — Number assigned when issued';

            // ── Revision invoice detection ──────────────────────────────────
            // Uses revision_source_invoice_id exclusively. Do NOT infer from
            // invoice_number suffix, replaces_invoice_id, or invoice_type.
            const isRevision = isRevisionInvoice(inv);

            // ── Superseded detection ────────────────────────────────────────
            // Canonical: another invoice in the list has replaces_invoice_id === inv.id
            const supersededByInvoice = findReplacementInvoice(invoices, inv.id);
            const invoiceIsSuperseded = supersededByInvoice != null;

            // ── Revision button logic ───────────────────────────────────────
            // A possible revision source: invoice_type='initial', status='open',
            // invoice_number non-null/non-empty. Does NOT require
            // revision_source_invoice_id === null so Revision B can also be a source.
            const isPossibleRevisionSource = isRevisionSource(inv);

            // Find an active child revision from the already-loaded list.
            // VOID children do NOT count as active.
            const activeChild = isPossibleRevisionSource
              ? invoices.find(
                  (child) =>
                    child.revision_source_invoice_id === inv.id &&
                    ACTIVE_REVISION_STATUSES.has(child.status)
                )
              : undefined;

            // Determine which revision button variant to show:
            //   'create'       — no active child → "Create Revision"
            //   'open_draft'   — active child with status='draft' → "Open Revision Draft"
            //   'in_progress'  — active child with issuing/open/partially_paid/paid → no button
            //   null           — not a revision source
            type RevisionButtonVariant = 'create' | 'open_draft' | 'in_progress' | null;
            let revisionVariant: RevisionButtonVariant = null;
            // VOID superseded source must NOT offer Create Revision
            if (isPossibleRevisionSource && !invoiceIsSuperseded) {
              if (!activeChild) {
                revisionVariant = 'create';
              } else if (activeChild.status === 'draft') {
                revisionVariant = 'open_draft';
              } else {
                revisionVariant = 'in_progress';
              }
            }

            const isRevisingThis = revisingInvoiceId === inv.id;
            const revisionError = revisionErrors[inv.id];

            // ── Badge: "Replacement required" shown only for unresolved void ──
            // A void normal initial invoice with NO canonical replacement.
            const isNormalInitial =
              inv.invoice_type === 'initial' &&
              inv.replaces_invoice_id === null &&
              inv.revision_source_invoice_id === null;
            const showReplacementRequiredBadge =
              inv.status === 'void' &&
              isNormalInitial &&
              !invoiceIsSuperseded;

            return (
              <div key={inv.id} className="flex flex-col gap-2">
                <div
                  className="flex items-center gap-4 p-4 bg-gray-50 border border-gray-200 rounded-xl hover:border-gray-300 transition-all"
                >
                  {/* Icon */}
                  <div className="w-9 h-9 rounded-lg bg-white border border-gray-200 flex items-center justify-center flex-shrink-0">
                    <Icon name="DocumentTextIcon" size={16} className="text-gray-500" />
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-display font-700 text-gray-900 truncate">
                        {invoiceNumberDisplay}
                      </span>
                      {/* Primary status badge */}
                      <span className={`text-[10px] font-display font-600 px-2 py-0.5 rounded-full border ${statusCfg.color} ${statusCfg.bg} ${statusCfg.border}`}>
                        {statusCfg.label}
                      </span>
                      {/* Type badge */}
                      <span className="text-[10px] font-display font-600 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700">
                        {typeLabel}
                      </span>
                      {/* Superseded badge — neutral/audit style, replaces "Replacement required" when replacement exists */}
                      {invoiceIsSuperseded && (
                        <span className="text-[10px] font-display font-600 px-2 py-0.5 rounded-full bg-gray-100 border border-gray-300 text-gray-600">
                          Superseded
                        </span>
                      )}
                      {/* Replacement required badge — only for genuinely unresolved void */}
                      {showReplacementRequiredBadge && (
                        <span className="text-[10px] font-display font-600 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
                          Replacement required
                        </span>
                      )}
                      {/* Revision badge — for any revision invoice (draft/issuing/open) */}
                      {isRevision && (
                        <span className="text-[10px] font-display font-600 px-2 py-0.5 rounded-full bg-violet-50 border border-violet-200 text-violet-700">
                          Revision
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="text-xs text-gray-500">
                        Created {formatDate(inv.created_at)}
                      </span>
                      <span className="text-xs font-display font-700 text-gray-900">
                        {formatCentsAsCurrency(inv.total_cents)}
                      </span>
                      {/* Superseded-by supporting text — shows replacement invoice number */}
                      {invoiceIsSuperseded && supersededByInvoice.invoice_number && (
                        <span className="text-xs text-gray-500">
                          Superseded by{' '}
                          <button
                            onClick={() => router.push(`/admin/invoices/${supersededByInvoice.id}`)}
                            className="text-eb-green-700 hover:text-eb-green-900 font-display font-600 underline underline-offset-2 transition-colors"
                          >
                            {supersededByInvoice.invoice_number}
                          </button>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Revision button — not shown on superseded/void source */}
                    {revisionVariant === 'create' && (
                      <button
                        onClick={() => handleCreateRevision(inv.id)}
                        disabled={isRevisingThis || revisingInvoiceId != null}
                        className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-violet-700 bg-white border border-violet-200 rounded-lg hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        {isRevisingThis ? (
                          <>
                            <Icon name="ArrowPathIcon" size={12} className="animate-spin" />
                            Creating…
                          </>
                        ) : (
                          <>
                            <Icon name="DocumentDuplicateIcon" size={12} />
                            Create Revision
                          </>
                        )}
                      </button>
                    )}
                    {revisionVariant === 'open_draft' && (
                      <button
                        onClick={() => handleCreateRevision(inv.id)}
                        disabled={isRevisingThis || revisingInvoiceId != null}
                        className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-violet-700 bg-white border border-violet-200 rounded-lg hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        {isRevisingThis ? (
                          <>
                            <Icon name="ArrowPathIcon" size={12} className="animate-spin" />
                            Creating…
                          </>
                        ) : (
                          <>
                            <Icon name="DocumentDuplicateIcon" size={12} />
                            Open Revision Draft
                          </>
                        )}
                      </button>
                    )}
                    {revisionVariant === 'in_progress' && (
                      <span className="text-[10px] text-gray-400 font-display font-500 px-2">
                        Revision in progress
                      </span>
                    )}

                    {/* View / Open Draft button — preserved for all invoices including superseded */}
                    <button
                      onClick={() => router.push(`/admin/invoices/${inv.id}`)}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-eb-green-900 bg-white border border-eb-green-200 rounded-lg hover:bg-eb-green-50 transition-all"
                    >
                      <Icon name="ArrowTopRightOnSquareIcon" size={12} />
                      {isDraft ? 'Open Draft' : 'View Invoice'}
                    </button>
                  </div>
                </div>

                {/* Per-row revision error */}
                {revisionError && (
                  <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                    <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
                    <span>{revisionError}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DealInvoicesSection;
