'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FundingBillingSectionProps {
  applicationId: string;
  depositAmount: number | null; // borrower_applications.deposit_amount (read-only)
  isMockId?: boolean;
  onFundingSaved?: (emdFundedCents: number | null) => void;
}

interface FundingData {
  emd_funded_cents: number | null;
  funded_date: string | null;
  credit_card_payment_enabled: boolean;
}

interface FeePreview {
  billable_days: number;
  deal_fee_cents: number;
}

const DEFAULT_ADMIN_FEE_CENTS = 250000; // $2,500.00

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrencyFromCents(cents: number | null): string {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatCurrencyFromDollars(dollars: number | null): string {
  if (dollars == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const raw = dateStr.split('T')[0];
  const [y, m, d] = raw.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

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

function formatCurrencyInput(raw: string): string | null {
  const stripped = raw.replace(/[$,]/g, '');
  if (stripped === '') return '';
  if (!/^\d*\.?\d{0,2}$/.test(stripped)) return null;
  const dotIndex = stripped.indexOf('.');
  if (dotIndex === -1) {
    return stripped.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } else {
    const intPart = stripped.slice(0, dotIndex);
    const decPart = stripped.slice(dotIndex);
    const formattedInt = intPart === '' ? '' : intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return formattedInt + decPart;
  }
}

function centsToInputString(cents: number | null): string {
  if (cents == null) return '';
  const dollars = Math.floor(cents / 100);
  const centsRemainder = cents % 100;
  const dollarsFormatted = dollars.toLocaleString('en-US');
  return `${dollarsFormatted}.${String(centsRemainder).padStart(2, '0')}`;
}

// ── Mock data for demo IDs ────────────────────────────────────────────────────

function getMockFundingData(): FundingData {
  return {
    emd_funded_cents: null,
    funded_date: null,
    credit_card_payment_enabled: false,
  };
}

function getMockHardDate(): string | null {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
}

// ── Section ───────────────────────────────────────────────────────────────────

const FundingBillingSection: React.FC<FundingBillingSectionProps> = ({
  applicationId,
  depositAmount,
  isMockId = false,
  onFundingSaved,
}) => {
  // ── Data state ──────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [fundingData, setFundingData] = useState<FundingData>({
    emd_funded_cents: null,
    funded_date: null,
    credit_card_payment_enabled: false,
  });
  const [originalHardDate, setOriginalHardDate] = useState<string | null>(null);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [emdInput, setEmdInput] = useState('');
  const [fundedDate, setFundedDate] = useState('');
  const [ccEnabled, setCcEnabled] = useState(false);

  // ── Hard date edit state ────────────────────────────────────────────────────
  const [hardDateInput, setHardDateInput] = useState('');
  const [savingHardDate, setSavingHardDate] = useState(false);
  const [hardDateError, setHardDateError] = useState<string | null>(null);
  const [hardDateSuccess, setHardDateSuccess] = useState(false);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // ── Fee preview state ───────────────────────────────────────────────────────
  const [feePreview, setFeePreview] = useState<FeePreview | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);

  // ── Load existing data ──────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (isMockId) {
        const mock = getMockFundingData();
        setFundingData(mock);
        setEmdInput(centsToInputString(mock.emd_funded_cents));
        setFundedDate(mock.funded_date ?? '');
        setCcEnabled(mock.credit_card_payment_enabled);
        const mockHard = getMockHardDate();
        setOriginalHardDate(mockHard);
        setHardDateInput(mockHard ?? '');
        setLoading(false);
        return;
      }

      const res = await fetch(`/api/admin/funding-billing?application_id=${applicationId}`);
      if (!res.ok) {
        console.error('[FundingBillingSection] Failed to load funding data');
        setLoading(false);
        return;
      }
      const json = await res.json();
      const data: FundingData = {
        emd_funded_cents: json.emd_funded_cents ?? null,
        funded_date: json.funded_date ?? null,
        credit_card_payment_enabled: json.credit_card_payment_enabled ?? false,
      };
      setFundingData(data);
      setEmdInput(centsToInputString(data.emd_funded_cents));
      setFundedDate(data.funded_date ?? '');
      setCcEnabled(data.credit_card_payment_enabled);
      const hardDate = json.original_hard_date ?? null;
      setOriginalHardDate(hardDate);
      setHardDateInput(hardDate ?? '');
    } catch (err) {
      console.error('[FundingBillingSection] Load error:', err);
    } finally {
      setLoading(false);
    }
  }, [applicationId, isMockId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Fee preview ─────────────────────────────────────────────────────────────
  const fetchFeePreview = useCallback(async () => {
    const parsedCents = parseCurrencyToCents(emdInput);
    if (!parsedCents || parsedCents <= 0 || !fundedDate || !originalHardDate) {
      setFeePreview(null);
      setFeeError(null);
      return;
    }

    const fundedTs = new Date(fundedDate + 'T00:00:00');
    const hardTs = new Date(originalHardDate + 'T00:00:00');
    if (hardTs <= fundedTs) {
      setFeePreview(null);
      setFeeError('Original Deposit Goes Hard Date must be after the Funding Date.');
      return;
    }

    setFeeLoading(true);
    setFeeError(null);
    try {
      const res = await fetch('/api/admin/funding-fee-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emd_funded_cents: parsedCents,
          funded_date: fundedDate,
          hard_date: originalHardDate,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setFeeError(json.error ?? 'Failed to calculate fee preview.');
        setFeePreview(null);
        return;
      }
      const json = await res.json();
      setFeePreview({
        billable_days: json.billable_days,
        deal_fee_cents: json.deal_fee_cents,
      });
    } catch {
      setFeeError('Failed to calculate fee preview.');
      setFeePreview(null);
    } finally {
      setFeeLoading(false);
    }
  }, [emdInput, fundedDate, originalHardDate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchFeePreview();
    }, 600);
    return () => clearTimeout(timer);
  }, [fetchFeePreview]);

  // ── Validation for funding fields ───────────────────────────────────────────
  function validate(): string | null {
    const parsedCents = parseCurrencyToCents(emdInput);
    const hasAmount = emdInput.trim() !== '' && parsedCents !== null;
    const hasDate = fundedDate.trim() !== '';

    if (hasAmount && !hasDate) {
      return 'EarnestBridge Funding Date is required when Actual EMD Funded is entered.';
    }
    if (hasDate && !hasAmount) {
      return 'Actual EMD Funded is required when EarnestBridge Funding Date is entered.';
    }
    if (hasAmount && parsedCents !== null && parsedCents <= 0) {
      return 'Actual EMD Funded must be greater than $0.';
    }

    // If hard date is set, validate pair ordering
    if (hasDate && originalHardDate) {
      const fundedTs = new Date(fundedDate + 'T00:00:00');
      const hardTs = new Date(originalHardDate + 'T00:00:00');
      if (hardTs <= fundedTs) {
        return 'Original Deposit Goes Hard Date must be after the Funding Date.';
      }
    }

    return null;
  }

  // ── Save funding details ────────────────────────────────────────────────────
  async function handleSave() {
    const validationError = validate();
    if (validationError) {
      setSaveError(validationError);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const parsedCents = parseCurrencyToCents(emdInput);

    try {
      const res = await fetch('/api/admin/funding-billing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          emd_funded_cents: parsedCents ?? null,
          funded_date: fundedDate.trim() || null,
          credit_card_payment_enabled: ccEnabled,
        }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setSaveError(json.error ?? 'Failed to save funding details.');
        return;
      }

      setSaveSuccess(true);
      setFundingData({
        emd_funded_cents: parsedCents ?? null,
        funded_date: fundedDate.trim() || null,
        credit_card_payment_enabled: ccEnabled,
      });
      onFundingSaved?.(parsedCents ?? null);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch {
      setSaveError('An unexpected error occurred. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Save hard date ──────────────────────────────────────────────────────────
  async function handleSaveHardDate() {
    if (!hardDateInput.trim()) {
      setHardDateError('Please enter a date.');
      return;
    }

    // Client-side pair validation: if funding date is set, hard date must be after it
    if (fundedDate.trim()) {
      const fundedTs = new Date(fundedDate + 'T00:00:00');
      const hardTs = new Date(hardDateInput + 'T00:00:00');
      if (hardTs <= fundedTs) {
        setHardDateError('Original Deposit Goes Hard Date must be after the Funding Date.');
        return;
      }
    }

    setSavingHardDate(true);
    setHardDateError(null);
    setHardDateSuccess(false);

    try {
      const res = await fetch('/api/admin/option-cycles/hard-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: applicationId,
          deposit_goes_hard_date: hardDateInput,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setHardDateError(json.error ?? 'Failed to save Original Deposit Goes Hard Date.');
        return;
      }

      setOriginalHardDate(hardDateInput);
      setHardDateSuccess(true);
      setTimeout(() => setHardDateSuccess(false), 4000);
    } catch {
      setHardDateError('An unexpected error occurred. Please try again.');
    } finally {
      setSavingHardDate(false);
    }
  }

  // ── Derived display values ──────────────────────────────────────────────────
  const parsedEmdCents = parseCurrencyToCents(emdInput);
  const emdDiffers =
    parsedEmdCents !== null &&
    depositAmount !== null &&
    parsedEmdCents !== depositAmount * 100;

  const canCalculateFee =
    parsedEmdCents !== null &&
    parsedEmdCents > 0 &&
    fundedDate.trim() !== '' &&
    originalHardDate !== null;

  const defaultInitialTotal =
    feePreview !== null
      ? feePreview.deal_fee_cents + DEFAULT_ADMIN_FEE_CENTS
      : null;

  const hardDateChanged = hardDateInput !== (originalHardDate ?? '');

  // ── Loading state ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Icon name="ArrowPathIcon" size={20} className="animate-spin text-gray-300" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div className="flex items-center gap-2 pb-4 border-b border-gray-100">
        <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center flex-shrink-0">
          <Icon name="BanknotesIcon" size={15} className="text-emerald-700" />
        </div>
        <div>
          <h3 className="font-display font-700 text-sm text-gray-900">Funding &amp; Billing</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">Admin-only. Record actual funding details and preview the initial Deal fee.</p>
        </div>
      </div>

      {/* ── Requested EMD (read-only) ── */}
      <div className="bg-gray-50 rounded-xl border border-gray-100 p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-display font-600 text-gray-500 uppercase tracking-wide">Requested EMD</span>
          <span className="text-[10px] bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded font-display font-600">Read Only</span>
        </div>
        <p className="text-lg font-display font-700 text-gray-900">
          {depositAmount != null ? formatCurrencyFromDollars(depositAmount) : '—'}
        </p>
        <p className="text-[11px] text-gray-400 mt-1">Amount requested in the original application.</p>
      </div>

      {/* ── Original Deposit Goes Hard Date (editable) ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Icon name="CalendarDaysIcon" size={14} className="text-eb-green-700" />
          <span className="text-xs font-display font-700 text-gray-900">Original Deposit Goes Hard Date</span>
        </div>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          The date the original EMD deposit goes hard (non-refundable). Stored in Option Cycle 1.
          Admin may set this before funding details are entered.
        </p>

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-[11px] font-display font-600 text-gray-600 mb-1.5">
              Hard Date
            </label>
            <input
              type="date"
              value={hardDateInput}
              onChange={(e) => {
                setHardDateInput(e.target.value);
                setHardDateError(null);
              }}
              disabled={isMockId}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all font-display disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>
          <button
            onClick={handleSaveHardDate}
            disabled={savingHardDate || isMockId || !hardDateInput.trim() || !hardDateChanged}
            className="flex items-center gap-2 px-4 py-2.5 bg-eb-green-900 hover:bg-eb-green-800 text-white text-xs font-display font-700 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm flex-shrink-0"
          >
            {savingHardDate ? (
              <>
                <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Icon name="CheckIcon" size={13} />
                Save Hard Date
              </>
            )}
          </button>
        </div>

        {hardDateError && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{hardDateError}</span>
          </div>
        )}

        {hardDateSuccess && (
          <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <Icon name="CheckCircleIcon" size={13} />
            <span>Original Deposit Goes Hard Date saved.</span>
          </div>
        )}

        {originalHardDate && !hardDateChanged && (
          <p className="text-[11px] text-gray-400">
            Saved: {formatDate(originalHardDate)}
          </p>
        )}

        {!originalHardDate && (
          <p className="text-[11px] text-amber-600">
            Not set. Enter a date and click Save Hard Date. This can be done before funding details are entered.
          </p>
        )}
      </div>

      {/* ── Editable funding fields ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Actual EMD Funded */}
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-600 mb-1.5">
            Actual EMD Funded
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-display font-600 pointer-events-none">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={emdInput}
              onChange={(e) => {
                const formatted = formatCurrencyInput(e.target.value);
                if (formatted !== null) {
                  setEmdInput(formatted);
                  setSaveError(null);
                }
              }}
              onBlur={() => {
                const cents = parseCurrencyToCents(emdInput);
                if (cents !== null) {
                  setEmdInput(centsToInputString(cents));
                }
              }}
              placeholder="250,000.00"
              className="w-full pl-7 pr-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all font-display"
            />
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Stored as integer cents. Enter the exact funded amount.</p>
          {emdDiffers && (
            <div className="flex items-start gap-1.5 mt-2 text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-2">
              <Icon name="InformationCircleIcon" size={12} className="flex-shrink-0 mt-0.5" />
              <span>Actual funded amount differs from the requested EMD.</span>
            </div>
          )}
        </div>

        {/* Funding Date */}
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-600 mb-1.5">
            EarnestBridge Funding Date
          </label>
          <input
            type="date"
            value={fundedDate}
            onChange={(e) => {
              setFundedDate(e.target.value);
              setSaveError(null);
            }}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all font-display"
          />
          <p className="text-[11px] text-gray-400 mt-1">Calendar date EarnestBridge wired the EMD.</p>
        </div>
      </div>

      {/* Pair validation note */}
      {saveError && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
          <span>{saveError}</span>
        </div>
      )}

      {/* ── Initial Deal Fee Preview ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 bg-gray-50/60">
          <Icon name="CalculatorIcon" size={14} className="text-gray-500" />
          <span className="text-xs font-display font-700 text-gray-700">Initial Deal Fee Preview</span>
          <span className="ml-auto text-[10px] text-gray-400 font-display font-600">Read Only · Not saved</span>
        </div>

        <div className="p-4 space-y-3">
          {/* Missing hard date warning */}
          {!originalHardDate && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
              <Icon name="ExclamationTriangleIcon" size={13} className="flex-shrink-0 mt-0.5" />
              <span>Original Deposit Goes Hard Date is required to calculate the Deal Fee.</span>
            </div>
          )}

          {/* Fee error (e.g. hard date <= funding date) */}
          {feeError && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
              <span>{feeError}</span>
            </div>
          )}

          {/* Preview rows */}
          <div className="space-y-2">
            <div className="flex items-center justify-between py-2 border-b border-gray-50">
              <div>
                <p className="text-xs font-display font-600 text-gray-700">Billable Calendar Days</p>
                <p className="text-[11px] text-gray-400">Hard Date − Funding Date (calendar days)</p>
              </div>
              <div className="text-right">
                {feeLoading ? (
                  <Icon name="ArrowPathIcon" size={13} className="animate-spin text-gray-300" />
                ) : feePreview ? (
                  <span className="text-sm font-display font-700 text-gray-900">{feePreview.billable_days}</span>
                ) : (
                  <span className="text-sm font-display font-600 text-gray-300">—</span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between py-2 border-b border-gray-50">
              <div>
                <p className="text-xs font-display font-600 text-gray-700">Deal Fee</p>
                {!canCalculateFee && (
                  <p className="text-[11px] text-gray-400">
                    Enter funded amount and funding date to calculate.
                  </p>
                )}
              </div>
              <div className="text-right">
                {feeLoading ? (
                  <Icon name="ArrowPathIcon" size={13} className="animate-spin text-gray-300" />
                ) : feePreview ? (
                  <span className="text-sm font-display font-700 text-emerald-700">
                    {formatCurrencyFromCents(feePreview.deal_fee_cents)}
                  </span>
                ) : (
                  <span className="text-sm font-display font-600 text-gray-300">—</span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between py-2 border-b border-gray-50">
              <div>
                <p className="text-xs font-display font-600 text-gray-700">Default Admin Fee</p>
              </div>
              <span className="text-sm font-display font-600 text-gray-600">
                {formatCurrencyFromCents(DEFAULT_ADMIN_FEE_CENTS)}
              </span>
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-xs font-display font-700 text-gray-900">Default Initial Invoice Total</p>
                <p className="text-[11px] text-gray-400">Deal Fee + Admin Fee. Before any Admin Fee discount or waiver.</p>
              </div>
              <div className="text-right">
                {feeLoading ? (
                  <Icon name="ArrowPathIcon" size={13} className="animate-spin text-gray-300" />
                ) : defaultInitialTotal !== null ? (
                  <span className="text-sm font-display font-700 text-eb-green-900">
                    {formatCurrencyFromCents(defaultInitialTotal)}
                  </span>
                ) : (
                  <span className="text-sm font-display font-600 text-gray-300">—</span>
                )}
              </div>
            </div>
          </div>

          <p className="text-[11px] text-gray-400 pt-1 border-t border-gray-50">
            This is a preview only. No invoice is created. Future invoices can discount or waive the Admin Fee.
          </p>
        </div>
      </div>

      {/* ── Credit Card Payment Eligibility ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="text-xs font-display font-700 text-gray-900 mb-0.5">Allow Credit Card Payment for this Deal</p>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              Future payment option only. Bank wire remains the preferred/default payment method. Enabling this does not create a payment link.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCcEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-eb-green-500 focus:ring-offset-2 ${ccEnabled ? 'bg-eb-green-900' : 'bg-gray-200'}`}
            role="switch"
            aria-checked={ccEnabled}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${ccEnabled ? 'translate-x-5' : 'translate-x-0'}`}
            />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${ccEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
          <span className={`text-[11px] font-display font-600 ${ccEnabled ? 'text-emerald-700' : 'text-gray-400'}`}>
            {ccEnabled ? 'Credit card payment enabled' : 'Credit card payment disabled (default)'}
          </span>
        </div>
      </div>

      {/* ── Save funding details button ── */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex-1">
          {saveSuccess && (
            <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <Icon name="CheckCircleIcon" size={13} />
              <span>Funding details saved successfully.</span>
            </div>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saving || isMockId}
          className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 hover:bg-eb-green-800 text-white text-xs font-display font-700 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        >
          {saving ? (
            <>
              <Icon name="ArrowPathIcon" size={13} className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Icon name="CheckIcon" size={13} />
              Save Funding Details
            </>
          )}
        </button>
      </div>

      {isMockId && (
        <p className="text-[11px] text-gray-400 text-center">
          Save is disabled for demo Deals.
        </p>
      )}
    </div>
  );
};

export default FundingBillingSection;
