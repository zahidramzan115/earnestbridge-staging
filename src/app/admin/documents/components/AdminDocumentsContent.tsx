'use client';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import {
  ReviewActionButtons,
  RequestRevisionModal,
  ApproveFinalModal,
} from '@/components/DocumentReviewActions';
import type { ReviewStatus, TableTarget } from '@/components/DocumentReviewActions';
import type { DocumentQueueItem, DocumentQueueCounters } from '@/app/api/admin/documents-queue/route';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: string | null): string {
  if (!ts) return '—';
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (days >= 1) return `${days}d ago`;
  if (hours >= 1) return `${hours}h ago`;
  if (mins >= 1) return `${mins}m ago`;
  return 'Just now';
}

function waitDuration(ts: string | null): { label: string; urgency: 'normal' | 'mild' | 'high' } {
  if (!ts) return { label: '—', urgency: 'normal' };
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  let label = '';
  if (days >= 1) label = `${days}d`;
  else if (hours >= 1) label = `${hours}h`;
  else if (mins >= 1) label = `${mins}m`;
  else label = 'Just now';
  const urgency = days >= 3 ? 'high' : days >= 1 ? 'mild' : 'normal';
  return { label, urgency };
}

function clientName(item: DocumentQueueItem): string {
  const first = item.contact_first_name ?? '';
  const last = item.contact_last_name ?? '';
  const full = `${first} ${last}`.trim();
  return full || item.contact_email || 'Unknown Client';
}

function dealUrl(item: DocumentQueueItem): string {
  return `/admin/borrower/${item.user_id}/application/${item.application_id}`;
}

/** Derive the correct tableTarget from the queue item's source field */
function getTableTarget(item: DocumentQueueItem): TableTarget {
  return item.source === 'borrower_document' ? 'borrower_documents' : 'application_documents';
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; color: string; dot: string }> = {
  uploaded:           { label: 'Awaiting Review',  color: 'bg-amber-100 text-amber-800 border-amber-200',   dot: 'bg-amber-500' },
  under_review:       { label: 'Under Review',      color: 'bg-blue-100 text-blue-800 border-blue-200',      dot: 'bg-blue-500' },
  revision_requested: { label: 'Waiting on Client', color: 'bg-slate-100 text-slate-700 border-slate-200',   dot: 'bg-slate-400' },
  approved_final:     { label: 'Approved',          color: 'bg-emerald-100 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, color: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${meta.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

// ─── Owner badge ──────────────────────────────────────────────────────────────

const OWNER_COLORS: Record<string, string> = {
  Eric:       'bg-violet-100 text-violet-700',
  Dan:        'bg-sky-100 text-sky-700',
  Tucker:     'bg-teal-100 text-teal-700',
  Unassigned: 'bg-gray-100 text-gray-500',
};

function OwnerBadge({ owner }: { owner: string | null }) {
  let label = owner || 'Unassigned';
  const cls = OWNER_COLORS[label] ?? 'bg-gray-100 text-gray-500';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ─── Counter card ─────────────────────────────────────────────────────────────

interface CounterCardProps {
  label: string;
  count: number;
  icon: string;
  color: string;
  active: boolean;
  onClick: () => void;
}

function CounterCard({ label, count, icon, color, active, onClick }: CounterCardProps) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 min-w-0 flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left
        ${active
          ? 'border-eb-green-700 bg-eb-green-900/5 shadow-sm'
          : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
        }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon name={icon as Parameters<typeof Icon>[0]['name']} size={18} className="text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-700 text-gray-900 leading-none">{count}</p>
        <p className="text-xs text-gray-500 mt-0.5 truncate">{label}</p>
      </div>
    </button>
  );
}

// ─── Review modal state ───────────────────────────────────────────────────────

interface QueueReviewModal {
  type: 'request_revision' | 'approve_final';
  item: DocumentQueueItem;
}

// ─── Document row ─────────────────────────────────────────────────────────────

interface DocumentRowProps {
  item: DocumentQueueItem;
  /** Called when a review action succeeds — passes the updated item */
  onReviewSuccess: (updatedItem: DocumentQueueItem) => void;
}

function DocumentRow({ item, onReviewSuccess }: DocumentRowProps) {
  const wait = item.review_status === 'uploaded' ? waitDuration(item.uploaded_at) : null;
  const requestedAgo = item.review_status === 'revision_requested' ? timeAgo(item.reviewed_at) : null;
  const name = clientName(item);
  const url = dealUrl(item);

  // ── Local review action state ──
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [reviewModal, setReviewModal] = useState<QueueReviewModal | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reviewStatus = item.review_status as ReviewStatus;
  const tableTarget = getTableTarget(item);
  const versionLabel = `v${item.version_number}`;

  async function performReviewAction(
    newStatus: ReviewStatus,
    clientRevisionMessage?: string,
    reviewNotes?: string
  ) {
    setSubmittingAction(newStatus);
    setActionError(null);
    try {
      const res = await fetch('/api/documents/revision', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: item.id,
          tableTarget,
          newStatus,
          reviewNotes: reviewNotes ?? null,
          clientRevisionMessage: clientRevisionMessage ?? null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setActionError(json.error ?? 'Action failed. Please try again.');
        return;
      }
      // Notify parent with the updated item so counters + queue movement work
      onReviewSuccess({ ...item, review_status: newStatus });
      setReviewModal(null);
    } catch {
      setActionError('Network error. Please try again.');
    } finally {
      setSubmittingAction(null);
    }
  }

  const urgencyClass = wait
    ? wait.urgency === 'high' ? 'border-l-red-400'
      : wait.urgency === 'mild'? 'border-l-amber-400' : 'border-l-transparent' :'border-l-transparent';

  const isRevisionRequested = reviewStatus === 'revision_requested';
  const isApprovedFinal = reviewStatus === 'approved_final';

  return (
    <>
      {/* Request Revision Modal */}
      <RequestRevisionModal
        open={reviewModal?.type === 'request_revision'}
        documentName={item.document_name}
        versionLabel={versionLabel}
        submitting={submittingAction === 'revision_requested'}
        onClose={() => { setReviewModal(null); setActionError(null); }}
        onSubmit={(clientMessage, internalNote) =>
          performReviewAction('revision_requested', clientMessage, internalNote || undefined)
        }
      />

      {/* Approve Final Modal */}
      <ApproveFinalModal
        open={reviewModal?.type === 'approve_final'}
        documentName={item.document_name}
        versionLabel={versionLabel}
        isRevisionRequested={isRevisionRequested}
        submitting={submittingAction === 'approved_final'}
        onClose={() => { setReviewModal(null); setActionError(null); }}
        onConfirm={() => performReviewAction('approved_final')}
      />

      <div className={`bg-white border border-gray-200 rounded-xl p-4 hover:shadow-sm transition-shadow border-l-4 ${urgencyClass}`}>
        {/* Mobile layout: stacked */}
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          {/* Left: doc info */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="font-600 text-gray-900 text-sm">
                {item.document_name}
              </span>
              <span className="text-xs text-gray-500 font-medium">
                {versionLabel}
                {item.is_revised && (
                  <span className="ml-1 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-600 uppercase tracking-wide">
                    Revised
                  </span>
                )}
              </span>
              <StatusBadge status={item.review_status} />
            </div>

            {/* Client + Deal */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600 mb-2">
              {item.contact_id ? (
                <Link
                  href={`/admin/crm/contacts/${item.contact_id}`}
                  className="font-medium text-eb-green-700 hover:underline"
                >
                  {name}
                </Link>
              ) : (
                <span className="font-medium">{name}</span>
              )}
              {item.company_name && (
                <>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-500">{item.company_name}</span>
                </>
              )}
            </div>

            {/* Property address */}
            {item.property_address && (
              <Link
                href={url}
                className="text-xs text-gray-500 hover:text-eb-green-700 transition-colors flex items-center gap-1"
              >
                <Icon name="MapPinIcon" size={12} className="flex-shrink-0" />
                {item.property_address}
              </Link>
            )}

            {/* Revision message (visible to Admin for context) */}
            {isRevisionRequested && item.client_revision_message && (
              <p className="mt-1.5 text-xs text-slate-600 italic line-clamp-2">
                "{item.client_revision_message}"
              </p>
            )}

            {/* Action error */}
            {actionError && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                <Icon name="ExclamationTriangleIcon" size={12} className="flex-shrink-0" />
                {actionError}
              </div>
            )}

            {/* ── Inline Review Actions ── */}
            <div className="mt-3 pt-2.5 border-t border-gray-100">
              {isApprovedFinal ? (
                /* Approved: show Open Deal as primary */
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-700 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg">
                    <Icon name="CheckBadgeIcon" size={11} />
                    Approved / Final
                  </span>
                  <Link
                    href={url}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-600 text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <Icon name="ArrowTopRightOnSquareIcon" size={12} />
                    Open Deal
                  </Link>
                </div>
              ) : isRevisionRequested ? (
                /* Waiting on Client: primary = Open Deal, secondary = Approve Final override */
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 text-slate-600 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">
                    <Icon name="ClockIcon" size={11} />
                    Waiting on Client
                  </span>
                  <Link
                    href={url}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-eb-green-700 text-white text-xs font-600 hover:bg-eb-green-800 transition-colors"
                  >
                    <Icon name="ArrowTopRightOnSquareIcon" size={12} />
                    Open Deal
                  </Link>
                  {/* Approve Final override — retains existing confirmation */}
                  <button
                    onClick={() => setReviewModal({ type: 'approve_final', item })}
                    disabled={submittingAction !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 rounded-lg transition-all"
                  >
                    {submittingAction === 'approved_final' ? (
                      <Icon name="ArrowPathIcon" size={11} className="animate-spin" />
                    ) : (
                      <Icon name="CheckBadgeIcon" size={11} />
                    )}
                    Approve Final
                  </button>
                </div>
              ) : (
                /* uploaded / under_review: full action set */
                <ReviewActionButtons
                  reviewStatus={reviewStatus}
                  hasFile={true}
                  submittingAction={submittingAction}
                  onMarkUnderReview={() => performReviewAction('under_review')}
                  onRequestRevision={() => setReviewModal({ type: 'request_revision', item })}
                  onApproveFinal={() => setReviewModal({ type: 'approve_final', item })}
                />
              )}
            </div>
          </div>

          {/* Right: meta */}
          <div className="flex sm:flex-col items-center sm:items-end gap-2 sm:gap-1.5 flex-shrink-0 flex-wrap">
            <OwnerBadge owner={item.eb_assigned_owner} />

            {/* Wait time for uploaded */}
            {wait && (
              <span className={`text-xs font-medium ${
                wait.urgency === 'high' ? 'text-red-600'
                  : wait.urgency === 'mild' ? 'text-amber-600' : 'text-gray-500'
              }`}>
                Waiting {wait.label}
              </span>
            )}

            {/* Requested ago for revision_requested */}
            {requestedAgo && (
              <span className="text-xs text-slate-500">
                Requested {requestedAgo}
              </span>
            )}

            {/* Uploaded timestamp for others */}
            {!wait && !isRevisionRequested && item.uploaded_at && (
              <span className="text-xs text-gray-400">
                {timeAgo(item.uploaded_at)}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type StatusFilter = 'needs_attention' | 'uploaded' | 'under_review' | 'revision_requested' | 'approved_final' | 'all';
type OwnerFilter = 'All' | 'Eric' | 'Dan' | 'Tucker' | 'Unassigned';

export default function AdminDocumentsContent() {
  const [items, setItems] = useState<DocumentQueueItem[]>([]);
  const [counters, setCounters] = useState<DocumentQueueCounters>({
    awaiting_review: 0,
    under_review: 0,
    waiting_on_client: 0,
    approved: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('needs_attention');
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('All');
  const [search, setSearch] = useState('');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/documents-queue');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items ?? []);
      setCounters(data.counters ?? { awaiting_review: 0, under_review: 0, waiting_on_client: 0, approved: 0 });
    } catch (err) {
      console.error('[AdminDocumentsContent] fetch error:', err);
      setError('Failed to load document queue. Please refresh.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  /**
   * Called by DocumentRow when a review action succeeds.
   * Updates the item in local state immediately (optimistic) and recalculates counters.
   * Preserves search/filter state — the row moves between sections gracefully.
   */
  const handleReviewSuccess = useCallback((updatedItem: DocumentQueueItem) => {
    setItems(prev => prev.map(i =>
      i.id === updatedItem.id && i.source === updatedItem.source ? updatedItem : i
    ));
    // Recalculate counters from updated items
    setItems(prev => {
      const all = prev.map(i =>
        i.id === updatedItem.id && i.source === updatedItem.source ? updatedItem : i
      );
      setCounters({
        awaiting_review: all.filter(i => i.review_status === 'uploaded').length,
        under_review: all.filter(i => i.review_status === 'under_review').length,
        waiting_on_client: all.filter(i => i.review_status === 'revision_requested').length,
        approved: all.filter(i => i.review_status === 'approved_final').length,
      });
      return all;
    });
  }, []);

  // ── Filtered items ──
  const filtered = useMemo(() => {
    let result = items;

    // Status filter
    if (statusFilter === 'needs_attention') {
      result = result.filter(i => i.review_status === 'uploaded' || i.review_status === 'under_review');
    } else if (statusFilter !== 'all') {
      result = result.filter(i => i.review_status === statusFilter);
    }

    // Owner filter
    if (ownerFilter !== 'All') {
      result = result.filter(i => (i.eb_assigned_owner ?? 'Unassigned') === ownerFilter);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(i =>
        (i.document_name ?? '').toLowerCase().includes(q) ||
        (i.document_type ?? '').toLowerCase().includes(q) ||
        (i.contact_first_name ?? '').toLowerCase().includes(q) ||
        (i.contact_last_name ?? '').toLowerCase().includes(q) ||
        (i.contact_email ?? '').toLowerCase().includes(q) ||
        (i.property_address ?? '').toLowerCase().includes(q) ||
        (i.company_name ?? '').toLowerCase().includes(q) ||
        clientName(i).toLowerCase().includes(q)
      );
    }

    return result;
  }, [items, statusFilter, ownerFilter, search]);

  // ── Waiting on client section (shown in needs_attention view) ──
  const waitingOnClient = useMemo(() => {
    if (statusFilter !== 'needs_attention') return [];
    return items.filter(i => {
      if (i.review_status !== 'revision_requested') return false;
      if (ownerFilter !== 'All' && (i.eb_assigned_owner ?? 'Unassigned') !== ownerFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          (i.document_name ?? '').toLowerCase().includes(q) ||
          (i.contact_first_name ?? '').toLowerCase().includes(q) ||
          (i.contact_last_name ?? '').toLowerCase().includes(q) ||
          (i.contact_email ?? '').toLowerCase().includes(q) ||
          (i.property_address ?? '').toLowerCase().includes(q) ||
          clientName(i).toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [items, statusFilter, ownerFilter, search]);

  const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
    { value: 'needs_attention', label: 'Needs Attention' },
    { value: 'uploaded',        label: 'Awaiting Review' },
    { value: 'under_review',    label: 'Under Review' },
    { value: 'revision_requested', label: 'Waiting on Client' },
    { value: 'approved_final',  label: 'Approved / Final' },
    { value: 'all',             label: 'All Current' },
  ];

  const OWNERS: OwnerFilter[] = ['All', 'Eric', 'Dan', 'Tucker', 'Unassigned'];

  const isEmpty = filtered.length === 0 && waitingOnClient.length === 0;

  const emptyMessage = () => {
    if (search.trim()) return 'No documents match your search.';
    if (statusFilter === 'needs_attention') return 'No documents are waiting for review.';
    if (statusFilter === 'revision_requested') return 'No outstanding document revision requests.';
    return 'No documents found for the selected filters.';
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-700 text-gray-900">Document Queue</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Current documents requiring EarnestBridge attention
            </p>
          </div>
          <button
            onClick={fetchQueue}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Icon name="ArrowPathIcon" size={15} />
            Refresh
          </button>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-5 space-y-5">
        {/* ── Summary counters ── */}
        <div className="flex flex-wrap gap-3">
          <CounterCard
            label="Awaiting Review"
            count={counters.awaiting_review}
            icon="InboxArrowDownIcon"
            color="bg-amber-500"
            active={statusFilter === 'uploaded'}
            onClick={() => setStatusFilter('uploaded')}
          />
          <CounterCard
            label="Under Review"
            count={counters.under_review}
            icon="MagnifyingGlassIcon"
            color="bg-blue-500"
            active={statusFilter === 'under_review'}
            onClick={() => setStatusFilter('under_review')}
          />
          <CounterCard
            label="Waiting on Client"
            count={counters.waiting_on_client}
            icon="ClockIcon"
            color="bg-slate-500"
            active={statusFilter === 'revision_requested'}
            onClick={() => setStatusFilter('revision_requested')}
          />
          <CounterCard
            label="Approved"
            count={counters.approved}
            icon="CheckCircleIcon"
            color="bg-emerald-500"
            active={statusFilter === 'approved_final'}
            onClick={() => setStatusFilter('approved_final')}
          />
        </div>

        {/* ── Filters + Search ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          {/* Search */}
          <div className="relative">
            <Icon name="MagnifyingGlassIcon" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by client, email, property, document…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-700/20 focus:border-eb-green-700"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <Icon name="XMarkIcon" size={15} />
              </button>
            )}
          </div>

          {/* Desktop filters */}
          <div className="hidden sm:flex flex-wrap gap-3">
            {/* Status */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 font-medium">Status:</span>
              <div className="flex flex-wrap gap-1">
                {STATUS_FILTERS.map(f => (
                  <button
                    key={f.value}
                    onClick={() => setStatusFilter(f.value)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      statusFilter === f.value
                        ? 'bg-eb-green-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Owner */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 font-medium">Owner:</span>
              <div className="flex gap-1">
                {OWNERS.map(o => (
                  <button
                    key={o}
                    onClick={() => setOwnerFilter(o)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      ownerFilter === o
                        ? 'bg-eb-green-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Mobile filter toggle */}
          <div className="sm:hidden">
            <button
              onClick={() => setMobileFiltersOpen(v => !v)}
              className="flex items-center gap-2 text-sm text-gray-600 font-medium"
            >
              <Icon name="FunnelIcon" size={15} />
              Filters
              <Icon name={mobileFiltersOpen ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={14} />
            </button>
            {mobileFiltersOpen && (
              <div className="mt-3 space-y-3">
                <div>
                  <p className="text-xs text-gray-500 font-medium mb-1.5">Status</p>
                  <div className="flex flex-wrap gap-1.5">
                    {STATUS_FILTERS.map(f => (
                      <button
                        key={f.value}
                        onClick={() => { setStatusFilter(f.value); setMobileFiltersOpen(false); }}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                          statusFilter === f.value
                            ? 'bg-eb-green-700 text-white' : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500 font-medium mb-1.5">Owner</p>
                  <div className="flex flex-wrap gap-1.5">
                    {OWNERS.map(o => (
                      <button
                        key={o}
                        onClick={() => { setOwnerFilter(o); setMobileFiltersOpen(false); }}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                          ownerFilter === o
                            ? 'bg-eb-green-700 text-white' : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Loading ── */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">Loading document queue…</p>
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {!loading && error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
            <Icon name="ExclamationTriangleIcon" size={18} className="text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
            <button onClick={fetchQueue} className="ml-auto text-sm text-red-600 underline">Retry</button>
          </div>
        )}

        {/* ── Queue ── */}
        {!loading && !error && (
          <>
            {/* Primary queue */}
            {filtered.length > 0 && (
              <div className="space-y-2">
                {statusFilter === 'needs_attention' && (
                  <div className="flex items-center gap-2 mb-3">
                    <h2 className="text-sm font-600 text-gray-700">
                      Needs Attention
                    </h2>
                    <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-600">
                      {filtered.length}
                    </span>
                  </div>
                )}
                {filtered.map(item => (
                  <DocumentRow
                    key={`${item.source}-${item.id}`}
                    item={item}
                    onReviewSuccess={handleReviewSuccess}
                  />
                ))}
              </div>
            )}

            {/* Waiting on Client section (only in needs_attention view) */}
            {statusFilter === 'needs_attention' && waitingOnClient.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 pt-2">
                  <div className="flex-1 h-px bg-gray-200" />
                  <div className="flex items-center gap-2">
                    <Icon name="ClockIcon" size={14} className="text-slate-400" />
                    <h2 className="text-xs font-600 text-slate-500 uppercase tracking-wider">
                      Waiting on Client
                    </h2>
                    <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-600">
                      {waitingOnClient.length}
                    </span>
                  </div>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
                <p className="text-xs text-slate-500 text-center pb-1">
                  These documents are awaiting client action — no immediate Admin action required.
                </p>
                {waitingOnClient.map(item => (
                  <DocumentRow
                    key={`${item.source}-${item.id}`}
                    item={item}
                    onReviewSuccess={handleReviewSuccess}
                  />
                ))}
              </div>
            )}

            {/* Empty state */}
            {isEmpty && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
                  <Icon name="DocumentCheckIcon" size={28} className="text-gray-400" />
                </div>
                <p className="text-base font-600 text-gray-700 mb-1">
                  {statusFilter === 'needs_attention' ? 'No documents are waiting for review.' : 'No documents found.'}
                </p>
                <p className="text-sm text-gray-400">{emptyMessage()}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
