'use client';
import React, { useState, useEffect } from 'react';
import Icon from '@/components/ui/AppIcon';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReviewStatus =
  | 'uploaded' |'under_review' |'revision_requested' |'approved_final' |'superseded';

export type TableTarget = 'borrower_documents' | 'application_documents';

// ─── RequestRevisionModal ─────────────────────────────────────────────────────

export interface RequestRevisionModalProps {
  open: boolean;
  documentName: string;
  versionLabel: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (clientMessage: string, internalNote: string) => void;
}

export function RequestRevisionModal({
  open,
  documentName,
  versionLabel,
  submitting,
  onClose,
  onSubmit,
}: RequestRevisionModalProps) {
  const [clientMessage, setClientMessage] = React.useState('');
  const [internalNote, setInternalNote] = React.useState('');
  const clientMessageRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (open) {
      setClientMessage('');
      setInternalNote('');
      setTimeout(() => clientMessageRef.current?.focus(), 100);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-orange-50/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-orange-100 border border-orange-200 flex items-center justify-center">
              <Icon name="ArrowPathIcon" size={15} className="text-orange-600" />
            </div>
            <div>
              <p className="text-sm font-display font-700 text-gray-900">Request Revision</p>
              <p className="text-[11px] text-gray-500 truncate max-w-[280px]">
                {documentName} — {versionLabel}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
          >
            <Icon name="XMarkIcon" size={14} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Client-facing message (required) */}
          <div>
            <label className="block text-xs font-display font-700 text-gray-800 mb-1">
              Message to Client <span className="text-red-500">*</span>
            </label>
            <textarea
              ref={clientMessageRef}
              value={clientMessage}
              onChange={(e) => setClientMessage(e.target.value)}
              placeholder="Please upload a revised copy with the seller signature included on page 8."
              rows={4}
              maxLength={2000}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 resize-none transition-all"
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-[11px] text-orange-600 flex items-center gap-1 font-600">
                <Icon name="EyeIcon" size={10} />
                Visible to client.
              </p>
              <span className="text-[10px] text-gray-400 tabular-nums">
                {clientMessage.length}/2000
              </span>
            </div>
          </div>

          <div className="border-t border-gray-100" />

          {/* Internal note (optional) */}
          <div>
            <label className="block text-xs font-display font-700 text-gray-700 mb-1 flex items-center gap-1.5">
              <Icon name="LockClosedIcon" size={11} className="text-violet-500" />
              Internal Note
              <span className="text-gray-400 font-400 text-[11px]">(optional)</span>
            </label>
            <textarea
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              placeholder="EarnestBridge internal notes only…"
              rows={3}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20 resize-none transition-all"
            />
            <p className="text-[11px] text-violet-600 mt-1 flex items-center gap-1">
              <Icon name="LockClosedIcon" size={10} />
              EarnestBridge internal only. Never visible to client.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 px-5 py-4 border-t border-gray-100 bg-gray-50/60">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(clientMessage.trim(), internalNote.trim())}
            disabled={submitting || !clientMessage.trim()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-display font-700 text-white bg-orange-500 rounded-xl hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {submitting ? (
              <Icon name="ArrowPathIcon" size={12} className="animate-spin" />
            ) : (
              <Icon name="ArrowPathIcon" size={12} />
            )}
            {submitting ? 'Saving…' : 'Request Revision'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ApproveFinalModal ────────────────────────────────────────────────────────

export interface ApproveFinalModalProps {
  open: boolean;
  documentName: string;
  versionLabel: string;
  isRevisionRequested: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ApproveFinalModal({
  open,
  documentName,
  versionLabel,
  isRevisionRequested,
  submitting,
  onClose,
  onConfirm,
}: ApproveFinalModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-emerald-50/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 border border-emerald-200 flex items-center justify-center">
              <Icon name="CheckBadgeIcon" size={15} className="text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-display font-700 text-gray-900">
                Approve this version as final?
              </p>
              <p className="text-[11px] text-gray-500 truncate max-w-[260px]">
                {documentName} — {versionLabel}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
          >
            <Icon name="XMarkIcon" size={14} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {isRevisionRequested && (
            <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl">
              <Icon
                name="ExclamationTriangleIcon"
                size={14}
                className="text-amber-600 flex-shrink-0 mt-0.5"
              />
              <p className="text-xs text-amber-800 leading-relaxed">
                This version is currently marked <strong>Revision Requested</strong>. Approving
                will override that status and mark this version as the final accepted document.
              </p>
            </div>
          )}
          <div className="flex items-start gap-2.5 p-3 bg-gray-50 border border-gray-100 rounded-xl">
            <Icon
              name="InformationCircleIcon"
              size={14}
              className="text-gray-400 flex-shrink-0 mt-0.5"
            />
            <p className="text-xs text-gray-600 leading-relaxed">
              Previous revisions will remain in version history.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 px-5 py-4 border-t border-gray-100 bg-gray-50/60">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-display font-700 text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {submitting ? (
              <Icon name="ArrowPathIcon" size={12} className="animate-spin" />
            ) : (
              <Icon name="CheckBadgeIcon" size={12} />
            )}
            {submitting ? 'Approving…' : 'Approve Final'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ReviewActionButtons ──────────────────────────────────────────────────────

export interface ReviewActionButtonsProps {
  reviewStatus: ReviewStatus;
  hasFile: boolean;
  onMarkUnderReview: () => void;
  onRequestRevision: () => void;
  onApproveFinal: () => void;
  onReopenReview?: () => void;
  /** The action currently being submitted: 'under_review' | 'revision_requested' | 'approved_final' | 'reopen' | null */
  submittingAction: string | null;
}

export function ReviewActionButtons({
  reviewStatus,
  hasFile,
  onMarkUnderReview,
  onRequestRevision,
  onApproveFinal,
  onReopenReview,
  submittingAction,
}: ReviewActionButtonsProps) {
  if (!hasFile) return null;

  if (reviewStatus === 'approved_final') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-700 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg">
          <Icon name="CheckBadgeIcon" size={11} />
          Approved / Final
        </span>
        {onReopenReview && (
          <button
            onClick={onReopenReview}
            disabled={submittingAction !== null}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-display font-600 text-gray-500 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all"
          >
            {submittingAction === 'reopen' ? (
              <Icon name="ArrowPathIcon" size={10} className="animate-spin" />
            ) : (
              <Icon name="ArrowUturnLeftIcon" size={10} />
            )}
            Reopen Review
          </button>
        )}
      </div>
    );
  }

  if (reviewStatus === 'revision_requested') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-display font-600 text-slate-600 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">
          <Icon name="ClockIcon" size={11} />
          Waiting on Client
        </span>
        {/* Approve Final override — retains existing confirmation that Admin is overriding a pending revision */}
        <button
          onClick={onApproveFinal}
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
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {reviewStatus === 'uploaded' && (
        <button
          onClick={onMarkUnderReview}
          disabled={submittingAction !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-50 rounded-lg transition-all"
        >
          {submittingAction === 'under_review' ? (
            <Icon name="ArrowPathIcon" size={11} className="animate-spin" />
          ) : (
            <Icon name="MagnifyingGlassIcon" size={11} />
          )}
          Mark Under Review
        </button>
      )}
      {(reviewStatus === 'uploaded' || reviewStatus === 'under_review') && (
        <button
          onClick={onRequestRevision}
          disabled={submittingAction !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-orange-700 bg-orange-50 border border-orange-200 hover:bg-orange-100 disabled:opacity-50 rounded-lg transition-all"
        >
          {submittingAction === 'revision_requested' ? (
            <Icon name="ArrowPathIcon" size={11} className="animate-spin" />
          ) : (
            <Icon name="ArrowPathIcon" size={11} />
          )}
          Request Revision
        </button>
      )}
      {(reviewStatus === 'uploaded' || reviewStatus === 'under_review') && (
        <button
          onClick={onApproveFinal}
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
      )}
    </div>
  );
}
