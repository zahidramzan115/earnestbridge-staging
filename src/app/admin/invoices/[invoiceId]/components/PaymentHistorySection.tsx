'use client';
import React, { useState } from 'react';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaymentRecord {
  id: string;
  invoice_id: string;
  payment_method: string | null;
  status: string | null;
  amount_cents: number;
  currency: string | null;
  received_at: string | null;
  reference_number: string | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
  receipt_number: string | null;
  receipt_pdf_generated_at: string | null;
}

interface PaymentHistorySectionProps {
  payments: PaymentRecord[];
  invoiceId: string;
  onReceiptGenerated: () => Promise<void> | void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatPaymentMethod(method: string | null): string {
  if (!method) return '—';
  if (method === 'bank_wire') return 'Bank Wire';
  // Capitalize first letter of each word as fallback
  return method.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPaymentStatus(status: string | null): string {
  if (!status) return '—';
  if (status === 'received') return 'Received';
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function isReceiptComplete(payment: PaymentRecord): boolean {
  return payment.receipt_number != null && payment.receipt_pdf_generated_at != null;
}

// ── Component ─────────────────────────────────────────────────────────────────

const PaymentHistorySection: React.FC<PaymentHistorySectionProps> = ({
  payments,
  invoiceId,
  onReceiptGenerated,
}) => {
  // Per-payment generating state keyed by payment.id
  const [generatingMap, setGeneratingMap] = useState<Record<string, boolean>>({});
  // Per-payment error state keyed by payment.id
  const [errorMap, setErrorMap] = useState<Record<string, string | null>>({});
  // Per-payment success message keyed by payment.id
  const [successMap, setSuccessMap] = useState<Record<string, string | null>>({});

  async function handleGenerateReceipt(paymentId: string) {
    // Prevent double submission
    if (generatingMap[paymentId]) return;

    setGeneratingMap((prev) => ({ ...prev, [paymentId]: true }));
    setErrorMap((prev) => ({ ...prev, [paymentId]: null }));
    setSuccessMap((prev) => ({ ...prev, [paymentId]: null }));

    try {
      const res = await fetch(
        `/api/admin/invoices/${invoiceId}/payment/${paymentId}/receipt`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      if (!res.ok) {
        let errMsg = 'Receipt generation failed. Please try again.';
        try {
          const json = await res.json();
          if (typeof json.error === 'string' && json.error.trim()) {
            errMsg = json.error;
          } else if (typeof json.message === 'string' && json.message.trim()) {
            errMsg = json.message;
          }
        } catch {
          // non-JSON — use generic message
        }
        setErrorMap((prev) => ({ ...prev, [paymentId]: errMsg }));
        return;
      }

      // Success — do not fabricate local state; await the authoritative refresh
      setSuccessMap((prev) => ({ ...prev, [paymentId]: 'Receipt generated successfully.' }));
      await onReceiptGenerated();
      // Auto-clear success after 5s
      setTimeout(() => {
        setSuccessMap((prev) => ({ ...prev, [paymentId]: null }));
      }, 5000);
    } catch {
      setErrorMap((prev) => ({
        ...prev,
        [paymentId]: 'Receipt generation failed. Please try again.',
      }));
    } finally {
      setGeneratingMap((prev) => ({ ...prev, [paymentId]: false }));
    }
  }

  function handleDownloadReceipt(paymentId: string) {
    window.open(
      `/api/admin/invoices/${invoiceId}/payment/${paymentId}/receipt?disposition=attachment`,
      '_blank',
      'noopener,noreferrer'
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
        <Icon name="ClockIcon" size={14} className="text-gray-400" />
        <h2 className="font-display font-700 text-sm text-gray-900">Payment History</h2>
        {payments.length > 0 && (
          <span className="ml-auto text-[10px] font-display font-600 text-gray-400">
            {payments.length} payment{payments.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {payments.length === 0 ? (
        <p className="text-xs text-gray-400 font-display font-600">No payments recorded.</p>
      ) : (
        <div className="space-y-4">
          {payments.map((payment, index) => {
            const isGenerating = generatingMap[payment.id] ?? false;
            const rowError = errorMap[payment.id] ?? null;
            const rowSuccess = successMap[payment.id] ?? null;
            const receiptComplete = isReceiptComplete(payment);
            const showReceiptActions = payment.status === 'received';

            return (
              <div
                key={payment.id}
                className={`space-y-2 ${index < payments.length - 1 ? 'pb-4 border-b border-gray-50' : ''}`}
              >
                {/* Amount + Status row */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-display font-700 text-eb-green-900">
                    {formatCents(payment.amount_cents)}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] font-display font-600 px-2 py-0.5 rounded-full border text-emerald-700 bg-emerald-50 border-emerald-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                    {formatPaymentStatus(payment.status)}
                  </span>
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                  <div>
                    <span className="text-gray-400 font-display font-600">Received</span>
                    <p className="text-gray-700 font-display font-600 mt-0.5">
                      {formatDateTime(payment.received_at)}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400 font-display font-600">Method</span>
                    <p className="text-gray-700 font-display font-600 mt-0.5">
                      {formatPaymentMethod(payment.payment_method)}
                    </p>
                  </div>
                  {payment.reference_number && (
                    <div>
                      <span className="text-gray-400 font-display font-600">Wire Reference</span>
                      <p className="text-gray-700 font-display font-600 mt-0.5 break-all">
                        {payment.reference_number}
                      </p>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-400 font-display font-600">Recorded By</span>
                    <p className="text-gray-700 font-display font-600 mt-0.5">
                      {/* Never expose raw UUID — display safe label */}
                      EarnestBridge Admin
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400 font-display font-600">Recorded At</span>
                    <p className="text-gray-700 font-display font-600 mt-0.5">
                      {formatDateTime(payment.created_at)}
                    </p>
                  </div>
                </div>

                {/* Notes */}
                {payment.notes && (
                  <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                    <p className="text-[10px] text-gray-400 font-display font-600 mb-0.5">Notes</p>
                    <p className="text-[11px] text-gray-700 leading-relaxed">{payment.notes}</p>
                  </div>
                )}

                {/* Receipt actions — only for received payments */}
                {showReceiptActions && (
                  <div className="pt-1">
                    {receiptComplete ? (
                      /* Download Receipt */
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleDownloadReceipt(payment.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-display font-600 text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
                          >
                            <Icon name="ArrowDownTrayIcon" size={12} className="text-gray-500" />
                            Download Receipt
                          </button>
                          {payment.receipt_number && (
                            <span className="text-[10px] font-display font-600 text-gray-400">
                              {payment.receipt_number}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      /* Generate Receipt */
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => handleGenerateReceipt(payment.id)}
                          disabled={isGenerating}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-display font-600 text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
                        >
                          {isGenerating ? (
                            <>
                              <Icon name="ArrowPathIcon" size={12} className="animate-spin text-gray-500" />
                              Generating…
                            </>
                          ) : (
                            <>
                              <Icon name="DocumentTextIcon" size={12} className="text-gray-500" />
                              Generate Receipt
                            </>
                          )}
                        </button>
                      </div>
                    )}

                    {/* Per-row success message */}
                    {rowSuccess && (
                      <p className="text-[10px] font-display font-600 text-emerald-700 mt-1">
                        {rowSuccess}
                      </p>
                    )}

                    {/* Per-row error message */}
                    {rowError && (
                      <p className="text-[10px] font-display font-600 text-red-600 mt-1">
                        {rowError}
                      </p>
                    )}
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

export default PaymentHistorySection;
