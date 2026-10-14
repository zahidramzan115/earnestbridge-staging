'use client';
import React, { useState, useRef, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

interface VoidInvoiceDialogProps {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceTotalCents: number;
  onSuccess: () => void;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}

// ── Format cents as USD ───────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

// ── Submit state machine ──────────────────────────────────────────────────────
//
// idle          — waiting for user input
// submitting    — request in-flight
// network_failure — uncertain outcome (network error or 5xx); exact payload preserved
// error         — definite 4xx error; lock released
//
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'network_failure'; retryPayload: RetryPayload }
  | { kind: 'error'; message: string };

interface RetryPayload {
  void_reason: string; // normalized (trimmed) reason — never modified after creation
}

// ── Component ─────────────────────────────────────────────────────────────────

const VoidInvoiceDialog: React.FC<VoidInvoiceDialogProps> = ({
  invoiceId,
  invoiceNumber,
  invoiceTotalCents,
  onSuccess,
  onRefresh,
  onClose,
}) => {
  // Void reason textarea
  const [voidReason, setVoidReason] = useState('');

  // Inline validation error (client-side only — shown before any POST)
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Submit state machine
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });

  // ── Synchronous in-flight submission lock ─────────────────────────────────
  // React state updates are asynchronous. This ref is set SYNCHRONOUSLY before
  // payload construction and fetch, preventing two rapid clicks from starting
  // two concurrent requests. Mirrors the pattern used in RecordPaymentDialog.
  const submissionInFlightRef = useRef<boolean>(false);

  // ── Derived booleans ──────────────────────────────────────────────────────
  const isSubmitting = submitState.kind === 'submitting';
  // Uncertain state: close, cancel, and X must be blocked
  const isUncertain = submitState.kind === 'network_failure';
  const isCloseDisabled = isSubmitting || isUncertain;

  // ── Handle close / cancel ─────────────────────────────────────────────────
  // Blocked during uncertain state — Admin must use Retry to resolve.
  function handleClose() {
    if (isCloseDisabled) return;
    onClose();
  }

  // ── Execute the void POST ─────────────────────────────────────────────────
  const executeVoid = useCallback(
    async (payload: RetryPayload) => {
      setSubmitState({ kind: 'submitting' });
      setFieldError(null);

      let res: Response;
      try {
        res = await fetch(`/api/admin/invoices/${invoiceId}/void`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Send ONLY void_reason — never invoice_id, admin_user_id, status, etc.
          body: JSON.stringify({ void_reason: payload.void_reason }),
        });
      } catch {
        // fetch threw — network failure, connection closed, or no response.
        // Outcome is UNCERTAIN. Preserve exact payload for retry.
        submissionInFlightRef.current = false;
        setSubmitState({ kind: 'network_failure', retryPayload: payload });
        return;
      }

      let json: Record<string, unknown> = {};
      try {
        json = await res.json();
      } catch {
        // Non-JSON response — outcome is UNCERTAIN. Preserve exact payload.
        submissionInFlightRef.current = false;
        setSubmitState({ kind: 'network_failure', retryPayload: payload });
        return;
      }

      // ── HTTP 5xx → UNCERTAIN outcome ──────────────────────────────────────
      // A 5xx may occur after the server processed the request but before the
      // browser received a reliable response. Preserve exact payload for retry.
      if (res.status >= 500) {
        submissionInFlightRef.current = false;
        setSubmitState({ kind: 'network_failure', retryPayload: payload });
        return;
      }

      // ── HTTP 200 — true success ───────────────────────────────────────────
      // Only success === true AND status === 'void' is true success.
      // idempotent_replay === true is treated identically as success.
      if (res.ok) {
        const invoiceObj = json.invoice as Record<string, unknown> | undefined;
        if (
          json.success === true &&
          invoiceObj &&
          invoiceObj.status === 'void'
        ) {
          submissionInFlightRef.current = false;
          setSubmitState({ kind: 'idle' });
          // onSuccess: close dialog + show success toast + call loadInvoice()
          onSuccess();
          return;
        }
        // Unexpected 200 body — treat as uncertain to be safe
        submissionInFlightRef.current = false;
        setSubmitState({ kind: 'network_failure', retryPayload: payload });
        return;
      }

      // ── Definite 4xx / 409 errors — release lock ──────────────────────────
      // For state-related 409s (invoice_not_voidable, active_revision_exists,
      // invoice_has_received_payments, invoice_already_void), refresh the
      // authoritative invoice state via onRefresh — NOT onSuccess.
      // This is the same separation used in RecordPaymentDialog.
      submissionInFlightRef.current = false;

      const errorMessage =
        typeof json.error === 'string'
          ? json.error
          : 'An unexpected error occurred. Please try again.';

      setSubmitState({ kind: 'error', message: errorMessage });

      // For state-related 409 errors, refresh invoice state without success toast
      if (res.status === 409) {
        await onRefresh();
      }
    },
    [invoiceId, onSuccess, onRefresh]
  );

  // ── Handle form submit ────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Explicit submit-state guard — fail closed at the handler level.
    // Normal form submission is allowed ONLY from idle or error states.
    // Blocks submission during 'submitting' and 'network_failure' regardless
    // of UI-level disabling (protects against programmatic or future UI triggers).
    if (
      submitState.kind !== 'idle' &&
      submitState.kind !== 'error'
    ) {
      return;
    }

    // Synchronous in-flight lock — set BEFORE payload construction
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;

    // Client-side validation
    setFieldError(null);
    const normalizedReason = voidReason.trim();
    if (!normalizedReason) {
      submissionInFlightRef.current = false;
      setFieldError('Void reason is required.');
      return;
    }

    // Build exact payload — only void_reason, normalized
    const payload: RetryPayload = { void_reason: normalizedReason };
    executeVoid(payload);
  }

  // ── Handle retry (network failure / uncertain state) ──────────────────────
  function handleRetry() {
    if (submitState.kind !== 'network_failure') return;

    // Synchronous in-flight lock for Retry — prevent double-clicking
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;

    // Reuse the EXACT same payload — do NOT modify the reason
    executeVoid(submitState.retryPayload);
  }

  const displayInvoiceNumber = invoiceNumber ?? '—';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="void-dialog-title"
    >
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-lg w-full p-6 space-y-5 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-full bg-red-50 border border-red-200 flex items-center justify-center">
              <Icon name="NoSymbolIcon" size={16} className="text-red-600" />
            </div>
            <div>
              <h2
                id="void-dialog-title"
                className="text-sm font-display font-700 text-gray-900"
              >
                Void Invoice
              </h2>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                This action marks the issued invoice as VOID and cannot be undone.
              </p>
            </div>
          </div>
          {/* X/close disabled during submitting AND uncertain state */}
          <button
            type="button"
            onClick={handleClose}
            disabled={isCloseDisabled}
            className="flex-shrink-0 p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Close dialog"
          >
            <Icon name="XMarkIcon" size={16} />
          </button>
        </div>

        {/* Invoice summary */}
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500 font-display font-600">Invoice Number</span>
            <span className="text-gray-900 font-display font-700">{displayInvoiceNumber}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500 font-display font-600">Invoice Total</span>
            <span className="text-gray-900 font-display font-700">{formatCents(invoiceTotalCents)}</span>
          </div>
        </div>

        {/* Void consequences */}
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-2">
          <p className="text-xs font-display font-700 text-red-800">Before you continue</p>
          <div className="space-y-1.5">
            <div className="flex items-start gap-2 text-[11px] text-red-700">
              <Icon name="ExclamationTriangleIcon" size={12} className="flex-shrink-0 mt-0.5" />
              <span>This action marks the issued invoice as <strong>VOID</strong>.</span>
            </div>
            <div className="flex items-start gap-2 text-[11px] text-red-700">
              <Icon name="DocumentTextIcon" size={12} className="flex-shrink-0 mt-0.5" />
              <span>The existing invoice PDF and history will be preserved.</span>
            </div>
            <div className="flex items-start gap-2 text-[11px] text-red-700">
              <Icon name="LockClosedIcon" size={12} className="flex-shrink-0 mt-0.5" />
              <span>This action cannot be undone through the current CRM workflow.</span>
            </div>
          </div>
        </div>

        {/* Network failure / uncertain state banner */}
        {submitState.kind === 'network_failure' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Icon name="ExclamationTriangleIcon" size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-display font-700 text-amber-800">Void Status Uncertain</p>
                <p className="text-[11px] text-amber-700 mt-0.5 leading-relaxed">
                  {"We couldn't confirm whether the void completed. Retry the same request."}
                </p>
                <p className="text-[11px] text-amber-600 mt-1 leading-relaxed">
                  The void reason has been preserved. This dialog cannot be closed until the void is retried or confirmed.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleRetry}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-600 text-white text-xs font-display font-700 rounded-lg hover:bg-amber-500 transition-all"
            >
              <Icon name="ArrowPathIcon" size={13} />
              Retry Same Request
            </button>
          </div>
        )}

        {/* Definite error banner */}
        {submitState.kind === 'error' && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{submitState.message}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Void Reason */}
          <div>
            <label
              htmlFor="void-reason-input"
              className="block text-[11px] font-display font-600 text-gray-500 mb-1.5"
            >
              Void Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              id="void-reason-input"
              value={voidReason}
              onChange={(e) => {
                setVoidReason(e.target.value);
                setFieldError(null);
                if (submitState.kind === 'error') {
                  setSubmitState({ kind: 'idle' });
                }
              }}
              // Reason is locked during uncertain state — exact payload must be preserved
              disabled={isSubmitting || isUncertain}
              rows={4}
              placeholder="Enter the reason this invoice is being voided"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-red-400 focus:ring-1 focus:ring-red-200 resize-none transition-all disabled:bg-gray-50 disabled:text-gray-500"
              aria-describedby={fieldError ? 'void-reason-error' : undefined}
            />
            {/* Inline validation error */}
            {fieldError && (
              <p
                id="void-reason-error"
                className="flex items-center gap-1.5 text-[11px] text-red-600 mt-1"
                role="alert"
              >
                <Icon name="ExclamationCircleIcon" size={11} />
                {fieldError}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            {/* Cancel disabled during submitting AND uncertain state */}
            <button
              type="button"
              onClick={handleClose}
              disabled={isCloseDisabled}
              className="flex-1 px-4 py-2.5 text-sm font-display font-600 text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Cancel
            </button>
            {/* Void confirm — destructive, disabled during submission */}
            <button
              type="submit"
              disabled={isSubmitting || isUncertain}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-display font-700 text-white bg-red-600 rounded-xl hover:bg-red-500 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
            >
              {isSubmitting ? (
                <>
                  <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                  Voiding…
                </>
              ) : (
                <>
                  <Icon name="NoSymbolIcon" size={13} />
                  Void Invoice
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default VoidInvoiceDialog;
