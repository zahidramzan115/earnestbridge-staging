'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecordPaymentDialogProps {
  invoiceId: string;
  invoiceTotalCents: number;
  balanceRemainingCents: number;
  onSuccess: () => void;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}

// ── Safe dollar-to-cent conversion ────────────────────────────────────────────
//
// Accepts: "100", "100.5", "100.50", "0.01"
// Rejects: "0", "-1", "12.345", "abc", "$100.00", "1,000.00"
//
// Does NOT use floating-point multiplication.
// Parses integer and fractional parts independently.
//
function parseDollarsToCents(raw: string): number | null {
  // Reject any string containing $, comma, or whitespace
  if (/[$,\s]/.test(raw)) return null;
  if (!raw) return null;

  // Must match: digits, optionally followed by exactly 1 or 2 decimal digits
  const match = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;

  const dollars = parseInt(match[1], 10);
  const centsStr = (match[2] ?? '00').padEnd(2, '0').slice(0, 2);
  const cents = parseInt(centsStr, 10);

  const result = dollars * 100 + cents;

  if (!Number.isSafeInteger(result)) return null;
  if (result <= 0) return null;

  return result;
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

// ── Get local datetime-local default value ────────────────────────────────────

function getLocalDateTimeValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

// ── Convert datetime-local value to ISO timestamp with timezone ───────────────

function localDateTimeToISO(value: string): string | null {
  if (!value) return null;
  // datetime-local gives "YYYY-MM-DDTHH:mm" — parse as local time
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString(); // UTC ISO string — valid ISO-8601 with timezone (Z)
}

// ── Submit state machine ──────────────────────────────────────────────────────

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'network_failure'; retryPayload: RetryPayload }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

interface RetryPayload {
  amount_cents: number;
  received_at: string | null;
  reference_number: string | null;
  notes: string | null;
  idempotency_key: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

const RecordPaymentDialog: React.FC<RecordPaymentDialogProps> = ({
  invoiceId,
  invoiceTotalCents,
  balanceRemainingCents,
  onSuccess,
  onRefresh,
  onClose,
}) => {
  // Form fields
  const [amountStr, setAmountStr] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');

  // Validation error
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Submit state machine
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });

  // Success notification (brief)
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Idempotency key — generated once per payment attempt, retained on network failure
  // Ref so it doesn't trigger re-renders
  const idempotencyKeyRef = useRef<string | null>(null);

  // ── FIX 3: Synchronous in-flight submission lock ──────────────────────────
  // React state updates are not a synchronous mutex. This ref is set
  // SYNCHRONOUSLY before crypto.randomUUID() / payload construction / fetch,
  // preventing two rapid clicks from generating two separate keys or starting
  // two concurrent requests.
  const submissionInFlightRef = useRef<boolean>(false);

  // Initialize datetime-local default on mount (client-only, avoids hydration mismatch)
  useEffect(() => {
    setReceivedAt(getLocalDateTimeValue());
  }, []);

  // ── Generate a fresh idempotency key for a new payment attempt ──────────────
  function generateFreshKey(): string {
    const key = crypto.randomUUID();
    idempotencyKeyRef.current = key;
    return key;
  }

  // ── Discard the current idempotency key ─────────────────────────────────────
  function discardKey() {
    idempotencyKeyRef.current = null;
  }

  // ── Handle close / cancel ───────────────────────────────────────────────────
  // FIX 2: Close/Cancel is blocked during network_failure (uncertain state).
  // The Admin must use Retry Same Payment to resolve the uncertain outcome.
  function handleClose() {
    // Do not allow close during uncertain payment state — key/payload must be preserved
    if (submitState.kind === 'network_failure') return;
    discardKey();
    onClose();
  }

  // ── Validate form and build payload ─────────────────────────────────────────
  function buildPayload(key: string): RetryPayload | null {
    setFieldError(null);

    // Amount
    const cents = parseDollarsToCents(amountStr.trim());
    if (cents === null) {
      setFieldError(
        'Enter a valid payment amount (e.g. 1250.00). Do not include $ or commas.'
      );
      return null;
    }

    // Received at — convert to ISO if provided
    let receivedAtISO: string | null = null;
    if (receivedAt.trim()) {
      receivedAtISO = localDateTimeToISO(receivedAt.trim());
      if (!receivedAtISO) {
        setFieldError('Received date/time is not valid.');
        return null;
      }
    }

    // Reference number
    const ref = referenceNumber.trim() || null;
    if (ref && ref.length > 255) {
      setFieldError('Wire reference must not exceed 255 characters.');
      return null;
    }

    // Notes
    const notesVal = notes.trim() || null;
    if (notesVal && notesVal.length > 2000) {
      setFieldError('Internal notes must not exceed 2000 characters.');
      return null;
    }

    return {
      amount_cents: cents,
      received_at: receivedAtISO,
      reference_number: ref,
      notes: notesVal,
      idempotency_key: key,
    };
  }

  // ── Submit payment ───────────────────────────────────────────────────────────
  const submitPayment = useCallback(
    async (payload: RetryPayload) => {
      setSubmitState({ kind: 'submitting' });
      setFieldError(null);

      let res: Response;
      try {
        res = await fetch(`/api/admin/invoices/${invoiceId}/payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount_cents: payload.amount_cents,
            received_at: payload.received_at,
            reference_number: payload.reference_number,
            notes: payload.notes,
            idempotency_key: payload.idempotency_key,
          }),
        });
      } catch {
        // fetch threw — network failure, connection closed, or no response.
        // Outcome is UNCERTAIN. Preserve key and payload for retry.
        submissionInFlightRef.current = false;
        setSubmitState({ kind: 'network_failure', retryPayload: payload });
        return;
      }

      let json: Record<string, unknown> = {};
      try {
        json = await res.json();
      } catch {
        // Non-JSON response — outcome is UNCERTAIN. Preserve key and payload.
        submissionInFlightRef.current = false;
        setSubmitState({ kind: 'network_failure', retryPayload: payload });
        return;
      }

      if (res.ok) {
        // HTTP 200 — success (including idempotent_replay: true)
        submissionInFlightRef.current = false;
        discardKey();
        setSuccessMessage('Payment recorded successfully.');
        setSubmitState({ kind: 'idle' });
        // Notify parent: actual payment success — close dialog, show success toast, refresh
        onSuccess();
        return;
      }

      // ── FIX 1: HTTP 5xx → UNCERTAIN outcome ────────────────────────────────
      // A 5xx response may occur after the server or financial RPC processed
      // the request but before the browser received a reliable response.
      // Do NOT discard the key. Preserve the exact payload for retry.
      if (res.status >= 500) {
        submissionInFlightRef.current = false;
        setSubmitState({ kind: 'network_failure', retryPayload: payload });
        return;
      }

      // HTTP 409 idempotency conflict — definite outcome, do not retry automatically
      if (res.status === 409) {
        const errorMsg = typeof json.error === 'string' ? json.error : null;
        if (
          errorMsg &&
          errorMsg.includes('conflicts with an earlier submission')
        ) {
          submissionInFlightRef.current = false;
          discardKey();
          setSubmitState({ kind: 'conflict' });
          // Use onRefresh — NOT onSuccess — so no success toast is shown.
          // The dialog stays open with the conflict message visible.
          // The Admin may close the dialog afterward to review Payment History.
          onRefresh();
          return;
        }
        // Other 409 (invoice_not_payable)
        submissionInFlightRef.current = false;
        discardKey();
        setSubmitState({
          kind: 'error',
          message:
            typeof json.error === 'string'
              ? json.error
              : 'This invoice is not available for payment.',
        });
        // Use onRefresh — NOT onSuccess — so no success toast is shown.
        onRefresh();
        return;
      }

      // Definite validation error (4xx) — discard key so a corrected submission
      // cannot accidentally reuse a key that was never committed
      submissionInFlightRef.current = false;
      discardKey();
      setSubmitState({
        kind: 'error',
        message:
          typeof json.error === 'string'
            ? json.error
            : 'An unexpected error occurred. Please try again.',
      });
    },
    [invoiceId, onSuccess, onRefresh]
  );

  // ── Handle form submit ───────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // ── FIX 3: Synchronous in-flight lock ──────────────────────────────────
    // Check and set the lock SYNCHRONOUSLY before any key generation or
    // payload construction. This prevents two rapid clicks within the same
    // render cycle from generating two separate idempotency keys.
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;

    // Generate a fresh key for this new submission attempt.
    // This happens AFTER the synchronous lock is acquired.
    const key = generateFreshKey();
    const payload = buildPayload(key);
    if (!payload) {
      // Validation failed — release lock and discard key (no financial request made)
      submissionInFlightRef.current = false;
      discardKey();
      return;
    }

    submitPayment(payload);
  }

  // ── Handle retry (network failure) ──────────────────────────────────────────
  function handleRetry() {
    if (submitState.kind !== 'network_failure') return;

    // ── FIX 3: Synchronous in-flight lock for Retry ────────────────────────
    // Prevent double-clicking Retry from starting two concurrent requests.
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;

    // Reuse the SAME payload and key — do NOT generate a new UUID.
    submitPayment(submitState.retryPayload);
  }

  const isSubmitting = submitState.kind === 'submitting';
  // FIX 2: Uncertain state — close and cancel must be blocked
  const isUncertain = submitState.kind === 'network_failure';
  const isCloseDisabled = isSubmitting || isUncertain;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-lg w-full p-6 space-y-5 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-full bg-eb-green-50 border border-eb-green-200 flex items-center justify-center">
              <Icon name="BanknotesIcon" size={16} className="text-eb-green-800" />
            </div>
            <div>
              <h2 className="text-sm font-display font-700 text-gray-900">Record Payment</h2>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                Record a bank wire payment that EarnestBridge has already received.
              </p>
            </div>
          </div>
          {/* FIX 2: X/close disabled during submitting AND uncertain state */}
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

        {/* Balance info */}
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500 font-display font-600">Invoice Total</span>
            <span className="text-gray-900 font-display font-700">{formatCents(invoiceTotalCents)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500 font-display font-600">Balance Remaining</span>
            <span className="text-eb-green-900 font-display font-700">{formatCents(balanceRemainingCents)}</span>
          </div>
        </div>

        {/* Network failure / uncertain state banner */}
        {submitState.kind === 'network_failure' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Icon name="ExclamationTriangleIcon" size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-display font-700 text-amber-800">Payment Status Uncertain</p>
                <p className="text-[11px] text-amber-700 mt-0.5 leading-relaxed">
                  Payment status is uncertain. Do not submit a new payment. Retry the same payment to safely confirm the result.
                </p>
                <p className="text-[11px] text-amber-600 mt-1 leading-relaxed">
                  The previous request may have been processed. This dialog cannot be closed until the payment is retried or confirmed.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleRetry}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-600 text-white text-xs font-display font-700 rounded-lg hover:bg-amber-500 transition-all"
            >
              <Icon name="ArrowPathIcon" size={13} />
              Retry Same Payment
            </button>
          </div>
        )}

        {/* Conflict banner */}
        {submitState.kind === 'conflict' && (
          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationTriangleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              This payment request conflicts with an earlier submission. Review the invoice and payment history before trying again.
            </span>
          </div>
        )}

        {/* Error banner */}
        {submitState.kind === 'error' && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{submitState.message}</span>
          </div>
        )}

        {/* Success message */}
        {successMessage && (
          <div className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5">
            <Icon name="CheckCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Payment Amount */}
          <div>
            <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
              Payment Amount <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">$</span>
              <input
                type="text"
                value={amountStr}
                onChange={(e) => {
                  setAmountStr(e.target.value);
                  setFieldError(null);
                  // If a definite error was shown, clear it on edit
                  if (submitState.kind === 'error') {
                    setSubmitState({ kind: 'idle' });
                  }
                }}
                disabled={isSubmitting || isUncertain}
                placeholder={`e.g. ${(balanceRemainingCents / 100).toFixed(2)}`}
                className="w-full pl-7 pr-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
                autoComplete="off"
                inputMode="decimal"
              />
            </div>
            <p className="text-[11px] text-gray-400 mt-1">
              Enter dollar amount (e.g. 1250.00). Maximum: {formatCents(balanceRemainingCents)}.
              Server enforces the balance limit.
            </p>
          </div>

          {/* Received Date & Time */}
          <div>
            <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
              Received Date &amp; Time
              <span className="ml-1.5 text-[10px] text-gray-400 font-400">(Optional — defaults to now)</span>
            </label>
            <input
              type="datetime-local"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
              disabled={isSubmitting || isUncertain}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Leave blank to omit. You may enter a past date for historical payment entry.
            </p>
          </div>

          {/* Wire Reference */}
          <div>
            <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
              Wire Reference
              <span className="ml-1.5 text-[10px] text-gray-400 font-400">(Optional)</span>
            </label>
            <input
              type="text"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              disabled={isSubmitting || isUncertain}
              maxLength={255}
              placeholder="e.g. WIRE-2026-0930"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>

          {/* Internal Notes */}
          <div>
            <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
              Internal Notes
              <span className="ml-1.5 text-[10px] text-gray-400 font-400">(Optional — Admin only)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isSubmitting || isUncertain}
              maxLength={2000}
              rows={3}
              placeholder="Internal notes about this payment. Never shown to the client."
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 resize-none transition-all disabled:bg-gray-50 disabled:text-gray-500"
            />
            {notes.length > 1900 && (
              <p className="text-[11px] text-amber-600 mt-1">{2000 - notes.length} characters remaining.</p>
            )}
          </div>

          {/* Field validation error */}
          {fieldError && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
              <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
              <span>{fieldError}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            {/* FIX 2: Cancel disabled during submitting AND uncertain/network_failure state */}
            <button
              type="button"
              onClick={handleClose}
              disabled={isCloseDisabled}
              className="flex-1 px-4 py-2.5 text-sm font-display font-600 text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || isUncertain}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-display font-700 text-white bg-eb-green-900 rounded-xl hover:bg-eb-green-800 disabled:opacity-60 transition-all"
            >
              {isSubmitting ? (
                <>
                  <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                  Recording…
                </>
              ) : (
                <>
                  <Icon name="BanknotesIcon" size={13} />
                  Record Payment
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RecordPaymentDialog;
