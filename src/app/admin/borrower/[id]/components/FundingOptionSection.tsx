'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OptionCycle {
  id: string;
  application_id: string;
  cycle_number: number;
  deposit_goes_hard_date: string;
  option_exercise_deadline: string;
  status: 'active' | 'exercised' | 'extended' | 'missed';
  option_exercised_at: string | null;
  actual_option_exercised_at: string | null;
  extension_psa_amendment_received_at: string | null;
  actual_amendment_received_at: string | null;
  extension_fee_paid_at: string | null;
  extended_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  // Server-derived enrichment fields
  option_deadline_cutoff_iso?: string;
  amendment_is_timely?: boolean | null;
  exercise_is_timely?: boolean | null;
  effective_amendment_received_at?: string | null;
  effective_option_exercised_at?: string | null;
}

interface FundingOptionSectionProps {
  applicationId: string;
  appStatus: string;
  isMockId?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const raw = dateStr.split('T')[0];
  const [y, m, d] = raw.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function formatDateTimeET(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return formatter.format(d) + ' ET';
}

function getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + 'T00:00:00');
  return Math.ceil((due.getTime() - today.getTime()) / 86400000);
}

// Format deadline date as "Sep 24, 2026 at 5:00 PM ET"
function formatDeadlineCutoffDisplay(deadlineDateStr: string): string {
  const [y, m, d] = deadlineDateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y} at 5:00 PM ET`;
}

// Today's date as YYYY-MM-DD for date input defaults
function todayDateStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Current time as HH:MM for time input defaults (local, but we label it ET)
function currentTimeStr(): string {
  // We want the current time in America/New_York for the default
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const h = parts.find(p => p.type === 'hour')?.value ?? '00';
  const min = parts.find(p => p.type === 'minute')?.value ?? '00';
  return `${h}:${min}`;
}

// ── Derived admin attention state ─────────────────────────────────────────────

type AttentionState =
  | 'hard_date_missing' |'active' |'exercised_timely' |'exercised_late' |'extension_protected_fee_pending' |'extension_complete' |'amendment_late' |'extended_historical' | 'missed_no_amendment' | 'missed_late_amendment' | 'missed_override_ready';

function getAttentionState(cycle: OptionCycle): AttentionState {
  if (cycle.status === 'exercised') {
    return cycle.exercise_is_timely === false ? 'exercised_late' : 'exercised_timely';
  }
  if (cycle.status === 'extended') return 'extended_historical';
  if (cycle.status === 'missed') {
    const hasAmendment = !!(cycle.effective_amendment_received_at ?? cycle.extension_psa_amendment_received_at);
    if (!hasAmendment) return 'missed_no_amendment';
    // Has amendment — may be eligible for override
    return 'missed_override_ready';
  }
  if (cycle.status === 'active') {
    const hasAmendment = !!(cycle.effective_amendment_received_at ?? cycle.extension_psa_amendment_received_at);
    if (hasAmendment) {
      const timely = cycle.amendment_is_timely;
      if (timely === false) return 'amendment_late';
      if (!cycle.extension_fee_paid_at) return 'extension_protected_fee_pending';
      return 'extension_complete';
    }
    return 'active';
  }
  return 'active';
}

// ── Mock data for demo IDs ────────────────────────────────────────────────────

function getMockCycles(applicationId: string): OptionCycle[] {
  const hardDate = new Date(Date.now() + 13 * 86400000).toISOString().split('T')[0];
  const deadline = new Date(Date.now() + 11 * 86400000).toISOString().split('T')[0];
  return [
    {
      id: 'mock-cycle-1',
      application_id: applicationId,
      cycle_number: 1,
      deposit_goes_hard_date: hardDate,
      option_exercise_deadline: deadline,
      status: 'active',
      option_exercised_at: null,
      actual_option_exercised_at: null,
      extension_psa_amendment_received_at: null,
      actual_amendment_received_at: null,
      extension_fee_paid_at: null,
      extended_at: null,
      created_by: null,
      updated_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      amendment_is_timely: null,
      exercise_is_timely: null,
      effective_amendment_received_at: null,
      effective_option_exercised_at: null,
    },
  ];
}

// ── Confirm Modal ─────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

function ConfirmModal({ title, message, confirmLabel, confirmClass, onConfirm, onCancel, loading }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center flex-shrink-0">
            <Icon name="ExclamationTriangleIcon" size={18} className="text-amber-600" />
          </div>
          <div>
            <h3 className="font-display font-700 text-sm text-gray-900">{title}</h3>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">{message}</p>
          </div>
        </div>
        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} disabled={loading} className="flex-1 px-4 py-2.5 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-all disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={loading} className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-display font-700 text-white rounded-xl transition-all disabled:opacity-50 ${confirmClass ?? 'bg-eb-green-900 hover:bg-eb-green-800'}`}>
            {loading ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : null}
            {loading ? 'Processing…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Set Hard Date Modal ───────────────────────────────────────────────────────

interface SetHardDateModalProps {
  title: string;
  description: string;
  onSubmit: (date: string) => void;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
}

function SetHardDateModal({ title, description, onSubmit, onCancel, loading, error }: SetHardDateModalProps) {
  const [date, setDate] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-eb-green-50 border border-eb-green-200 flex items-center justify-center flex-shrink-0">
            <Icon name="CalendarDaysIcon" size={18} className="text-eb-green-700" />
          </div>
          <div>
            <h3 className="font-display font-700 text-sm text-gray-900">{title}</h3>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">{description}</p>
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Deposit Goes Hard Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all" />
          <p className="text-[11px] text-gray-400 mt-1.5">The Option Exercise Deadline will be calculated automatically (2 Federal Reserve business days before this date).</p>
        </div>
        {error && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} disabled={loading} className="flex-1 px-4 py-2.5 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-all disabled:opacity-50">Cancel</button>
          <button onClick={() => date && onSubmit(date)} disabled={!date || loading} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-display font-700 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            {loading ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : null}
            {loading ? 'Calculating…' : 'Set Hard Date'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Timestamp Modal (for amendment received / option exercised) ───────────────
// Admin records actual date + time (interpreted as America/New_York).
// Default is current date/time in ET.

interface TimestampModalProps {
  title: string;
  description: string;
  confirmLabel: string;
  confirmClass?: string;
  onSubmit: (date: string, time: string) => void;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
  warningNote?: string;
}

function TimestampModal({ title, description, confirmLabel, confirmClass, onSubmit, onCancel, loading, error, warningNote }: TimestampModalProps) {
  const [date, setDate] = useState(todayDateStr);
  const [time, setTime] = useState(currentTimeStr);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-eb-green-50 border border-eb-green-200 flex items-center justify-center flex-shrink-0">
            <Icon name="ClockIcon" size={18} className="text-eb-green-700" />
          </div>
          <div>
            <h3 className="font-display font-700 text-sm text-gray-900">{title}</h3>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">{description}</p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Date (Eastern Time)</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all" />
          </div>
          <div>
            <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Time (Eastern Time)</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all" />
          </div>
          <p className="text-[11px] text-gray-400">
            Enter the actual time EarnestBridge received this. Defaults to now (Eastern Time). The server will determine whether this is before or after the 5:00 PM ET deadline.
          </p>
        </div>

        {warningNote && (
          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationTriangleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{warningNote}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} disabled={loading} className="flex-1 px-4 py-2.5 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-all disabled:opacity-50">Cancel</button>
          <button
            onClick={() => date && time && onSubmit(date, time)}
            disabled={!date || !time || loading}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-display font-700 text-white rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${confirmClass ?? 'bg-eb-green-900 hover:bg-eb-green-800'}`}
          >
            {loading ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : null}
            {loading ? 'Recording…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Cycle Status Badge ────────────────────────────────────────────────────────

function CycleStatusBadge({ cycle }: { cycle: OptionCycle }) {
  const state = getAttentionState(cycle);

  const configs: Record<AttentionState, { label: string; color: string; bg: string; border: string; icon: string }> = {
    hard_date_missing:               { label: 'Action Required',                  color: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200',     icon: 'ExclamationCircleIcon' },
    active:                          { label: 'Active',                           color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'CheckCircleIcon' },
    exercised_timely:                { label: 'Option Exercised',                 color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200',    icon: 'CheckBadgeIcon' },
    exercised_late:                  { label: 'Option Exercise Recorded Late',    color: 'text-orange-700',  bg: 'bg-orange-50',  border: 'border-orange-200',  icon: 'ExclamationTriangleIcon' },
    extension_protected_fee_pending: { label: 'Extension Protected — Fee Pending', color: 'text-amber-700', bg: 'bg-amber-50',   border: 'border-amber-200',   icon: 'ShieldCheckIcon' },
    extension_complete:              { label: 'Extension Requirements Complete',  color: 'text-teal-700',    bg: 'bg-teal-50',    border: 'border-teal-200',    icon: 'CheckBadgeIcon' },
    amendment_late:                  { label: 'Late Amendment — Deal Not Protected', color: 'text-red-700', bg: 'bg-red-50',     border: 'border-red-200',     icon: 'XCircleIcon' },
    extended_historical:             { label: 'Extended (Historical)',            color: 'text-gray-500',    bg: 'bg-gray-50',    border: 'border-gray-200',    icon: 'ArchiveBoxIcon' },
    missed_no_amendment:             { label: 'Missed — No Amendment',            color: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200',     icon: 'XCircleIcon' },
    missed_late_amendment:           { label: 'Missed — Late Amendment',          color: 'text-orange-700',  bg: 'bg-orange-50',  border: 'border-orange-200',  icon: 'ExclamationTriangleIcon' },
    missed_override_ready:           { label: 'Missed — Override Available',      color: 'text-indigo-700',  bg: 'bg-indigo-50',  border: 'border-indigo-200',  icon: 'ShieldCheckIcon' },
  };

  const cfg = configs[state];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-display font-600 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
      <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={11} />
      {cfg.label}
    </span>
  );
}

// ── Active Cycle Card ─────────────────────────────────────────────────────────

interface ActiveCycleCardProps {
  cycle: OptionCycle;
  onExercise: () => void;
  onAmendmentReceived: () => void;
  onFeePaid: () => void;
  onNewExtension: () => void;
  actionLoading: string | null;
}

function ActiveCycleCard({ cycle, onExercise, onAmendmentReceived, onFeePaid, onNewExtension, actionLoading }: ActiveCycleCardProps) {
  const daysUntilDeadline = getDaysUntil(cycle.option_exercise_deadline);
  const deadlineIsOverdue = daysUntilDeadline < 0;
  const deadlineIsUrgent = daysUntilDeadline >= 0 && daysUntilDeadline <= 3;
  const state = getAttentionState(cycle);

  const deadlineColor = deadlineIsOverdue ? 'text-red-700' : deadlineIsUrgent ? 'text-amber-700' : 'text-gray-900';
  const deadlineBg = deadlineIsOverdue ? 'bg-red-50 border-red-200' : deadlineIsUrgent ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-100';

  const effectiveAmendmentTs = cycle.effective_amendment_received_at ?? cycle.extension_psa_amendment_received_at;
  const effectiveExerciseTs = cycle.effective_option_exercised_at ?? cycle.option_exercised_at;

  return (
    <div className="space-y-4">
      {/* Key dates */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
          <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide mb-1">Deposit Goes Hard</p>
          <p className="text-base font-display font-700 text-gray-900">{formatDate(cycle.deposit_goes_hard_date)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">Cycle {cycle.cycle_number}</p>
        </div>

        <div className={`border rounded-xl p-4 ${deadlineBg}`}>
          <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide mb-1">Option Exercise Deadline</p>
          <p className={`text-base font-display font-700 ${deadlineColor}`}>{formatDate(cycle.option_exercise_deadline)}</p>
          <p className="text-[11px] text-gray-500 mt-0.5 font-600">Cutoff: 5:00 PM ET</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {deadlineIsOverdue
              ? `${Math.abs(daysUntilDeadline)} day${Math.abs(daysUntilDeadline) !== 1 ? 's' : ''} overdue`
              : daysUntilDeadline === 0
              ? 'Due today'
              : `${daysUntilDeadline} day${daysUntilDeadline !== 1 ? 's' : ''} remaining`}
            {' · '}2 business days before funds go hard
          </p>
        </div>
      </div>

      {/* Attention state banners */}
      {state === 'extension_protected_fee_pending' && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <Icon name="ShieldCheckIcon" size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-display font-700 text-amber-800">Extension Protected — Fee Pending</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              Signed PSA amendment received before the deadline. Extension fee is still outstanding. This Deal is protected from automatic closeout.
            </p>
          </div>
        </div>
      )}
      {state === 'extension_complete' && (
        <div className="flex items-start gap-3 bg-teal-50 border border-teal-200 rounded-xl px-4 py-3">
          <Icon name="CheckBadgeIcon" size={16} className="text-teal-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-display font-700 text-teal-800">Extension Requirements Complete</p>
            <p className="text-[11px] text-teal-700 mt-0.5">Both signed PSA amendment and extension fee have been recorded.</p>
          </div>
        </div>
      )}
      {state === 'amendment_late' && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <Icon name="XCircleIcon" size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-display font-700 text-red-800">Late Amendment — Deal Not Protected</p>
            <p className="text-[11px] text-red-700 mt-0.5">
              The signed PSA amendment was received after the 5:00 PM ET Option Exercise Deadline. This amendment does not protect the Deal from future automatic closeout. A new extension cycle cannot be created from a late amendment.
            </p>
          </div>
        </div>
      )}
      {state === 'exercised_late' && (
        <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
          <Icon name="ExclamationTriangleIcon" size={16} className="text-orange-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-display font-700 text-orange-800">Option Exercise Recorded Late</p>
            <p className="text-[11px] text-orange-700 mt-0.5">
              The option exercise was recorded after the 5:00 PM ET deadline. Step 5D-2 automatic closeout will not consider this a timely exercise.
            </p>
          </div>
        </div>
      )}
      {deadlineIsOverdue && state === 'active' && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <Icon name="ExclamationCircleIcon" size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-display font-700 text-red-800">Option Exercise Deadline Passed</p>
            <p className="text-[11px] text-red-700 mt-0.5">No amendment received. Automatic closeout logic will be handled in Step 5D-2.</p>
          </div>
        </div>
      )}

      {/* Option Status */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide mb-1">Option Status</p>
          <CycleStatusBadge cycle={cycle} />
        </div>
      </div>

      {/* Exercised display */}
      {cycle.status === 'exercised' && effectiveExerciseTs && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
          <p className="text-[10px] font-display font-600 text-blue-400 uppercase tracking-wide mb-1">Option Exercised At</p>
          <p className="text-sm font-display font-700 text-blue-800">{formatDateTimeET(effectiveExerciseTs)}</p>
          {cycle.exercise_is_timely === false && (
            <p className="text-[11px] text-orange-700 mt-1 font-600">Recorded after Option Exercise Deadline</p>
          )}
        </div>
      )}

      {/* Actions — only show for active non-exercised cycles */}
      {cycle.status === 'active' && (
        <div className="border-t border-gray-100 pt-4 space-y-3">
          <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide">Actions</p>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={onExercise}
              disabled={!!actionLoading}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px]"
            >
              {actionLoading === 'exercise' ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="CheckBadgeIcon" size={12} />}
              Mark Option Exercised
            </button>
          </div>

          {/* Extension section */}
          <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 space-y-3">
            <p className="text-xs font-display font-700 text-gray-700">Extension Requirements</p>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              Both a signed PSA amendment and the extension deal fee are required for an extension. The signed PSA amendment must be received by EarnestBridge no later than 5:00 PM Eastern on the Option Exercise Deadline.
            </p>

            {/* Requirement 1: Signed PSA Amendment */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-display font-600 text-gray-700">1. Signed PSA Amendment</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {effectiveAmendmentTs ? (
                    <span className={cycle.amendment_is_timely === false ? 'text-red-700 font-600' : 'text-emerald-700 font-600'}>
                      {cycle.amendment_is_timely === false ? 'Late — ' : 'Received — '}
                      {formatDateTimeET(effectiveAmendmentTs)}
                    </span>
                  ) : (
                    <span className="text-red-600">Not received — required before 5:00 PM ET on Option Exercise Deadline</span>
                  )}
                </p>
              </div>
              {!effectiveAmendmentTs && (
                <button
                  onClick={onAmendmentReceived}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px] flex-shrink-0"
                >
                  {actionLoading === 'amendment_received' ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="DocumentCheckIcon" size={12} />}
                  Mark Received
                </button>
              )}
              {effectiveAmendmentTs && (
                <span className={`flex items-center gap-1 text-[11px] flex-shrink-0 ${cycle.amendment_is_timely === false ? 'text-red-600' : 'text-emerald-700'}`}>
                  <Icon name={cycle.amendment_is_timely === false ? 'XCircleIcon' : 'CheckCircleIcon'} size={13} />
                  {cycle.amendment_is_timely === false ? 'Late' : 'Received'}
                </span>
              )}
            </div>

            {/* Requirement 2: Extension Deal Fee */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-display font-600 text-gray-700">2. Extension Deal Fee</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {cycle.extension_fee_paid_at
                    ? <span className="text-emerald-700 font-600">Paid — {formatDateTimeET(cycle.extension_fee_paid_at)}</span>
                    : <span className="text-amber-700">Pending</span>
                  }
                </p>
              </div>
              {!cycle.extension_fee_paid_at && (
                <button
                  onClick={onFeePaid}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px] flex-shrink-0"
                >
                  {actionLoading === 'fee_paid' ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="BanknotesIcon" size={12} />}
                  Mark Fee Paid
                </button>
              )}
              {cycle.extension_fee_paid_at && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-700 flex-shrink-0">
                  <Icon name="CheckCircleIcon" size={13} />
                  Paid
                </span>
              )}
            </div>

            {/* Set New Hard Date — only if amendment was TIMELY */}
            {effectiveAmendmentTs && cycle.amendment_is_timely !== false && (
              <div className="pt-2 border-t border-gray-200">
                {!cycle.extension_fee_paid_at && (
                  <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                    <Icon name="ExclamationTriangleIcon" size={12} className="flex-shrink-0 mt-0.5" />
                    <span>Extension Fee Outstanding — you may still set a new hard date, but the fee must be collected.</span>
                  </div>
                )}
                <button
                  onClick={onNewExtension}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px]"
                >
                  {actionLoading === 'new_extension' ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="ArrowPathRoundedSquareIcon" size={12} />}
                  Set New Deposit Goes Hard Date
                </button>
              </div>
            )}

            {/* Late amendment — cannot create new cycle */}
            {effectiveAmendmentTs && cycle.amendment_is_timely === false && (
              <div className="pt-2 border-t border-gray-200">
                <div className="flex items-start gap-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <Icon name="XCircleIcon" size={12} className="flex-shrink-0 mt-0.5" />
                  <span>Late amendment — a new extension cycle cannot be created. Contact EarnestBridge management for a business exception.</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Historical Cycle Row ──────────────────────────────────────────────────────

function HistoricalCycleRow({ cycle }: { cycle: OptionCycle }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveAmendmentTs = cycle.effective_amendment_received_at ?? cycle.extension_psa_amendment_received_at;
  const effectiveExerciseTs = cycle.effective_option_exercised_at ?? cycle.option_exercised_at;

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[11px] font-display font-600 text-gray-400 bg-gray-200 rounded-full px-2 py-0.5">Cycle {cycle.cycle_number}</span>
          <span className="text-xs font-display font-600 text-gray-600">Hard: {formatDate(cycle.deposit_goes_hard_date)}</span>
          <CycleStatusBadge cycle={cycle} />
        </div>
        <Icon name={expanded ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={14} className="text-gray-400 flex-shrink-0" />
      </button>

      {expanded && (
        <div className="px-4 py-3 space-y-2 bg-white">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Deposit Goes Hard</p>
              <p className="text-gray-800 font-600 mt-0.5">{formatDate(cycle.deposit_goes_hard_date)}</p>
            </div>
            <div>
              <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Option Exercise Deadline</p>
              <p className="text-gray-800 font-600 mt-0.5">{formatDate(cycle.option_exercise_deadline)} at 5:00 PM ET</p>
            </div>
            {effectiveExerciseTs && (
              <div>
                <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Option Exercised</p>
                <p className={`font-600 mt-0.5 ${cycle.exercise_is_timely === false ? 'text-orange-700' : 'text-emerald-700'}`}>
                  {formatDateTimeET(effectiveExerciseTs)}
                  {cycle.exercise_is_timely === false && ' (Late)'}
                </p>
              </div>
            )}
            {effectiveAmendmentTs && (
              <div>
                <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Amendment Received</p>
                <p className={`font-600 mt-0.5 ${cycle.amendment_is_timely === false ? 'text-red-700' : 'text-emerald-700'}`}>
                  {formatDateTimeET(effectiveAmendmentTs)}
                  {cycle.amendment_is_timely === false && ' (Late)'}
                </p>
              </div>
            )}
            {cycle.extension_fee_paid_at && (
              <div>
                <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Extension Fee Paid</p>
                <p className="text-emerald-700 font-600 mt-0.5">{formatDateTimeET(cycle.extension_fee_paid_at)}</p>
              </div>
            )}
            {cycle.extended_at && (
              <div>
                <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Extended At</p>
                <p className="text-gray-600 font-600 mt-0.5">{formatDateTimeET(cycle.extended_at)}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Extension Override Modal ──────────────────────────────────────────────────
// Admin must explicitly attest and provide new hard date.

interface ExtensionOverrideModalProps {
  missedCycle: OptionCycle;
  onSubmit: (hardDate: string, attestation: boolean) => void;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
}

function ExtensionOverrideModal({ missedCycle, onSubmit, onCancel, loading, error }: ExtensionOverrideModalProps) {
  const [hardDate, setHardDate] = useState('');
  const [attested, setAttested] = useState(false);

  const effectiveAmendmentTs = missedCycle.effective_amendment_received_at ?? missedCycle.extension_psa_amendment_received_at;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center flex-shrink-0">
            <Icon name="ShieldCheckIcon" size={18} className="text-indigo-700" />
          </div>
          <div>
            <h3 className="font-display font-700 text-sm text-gray-900">Accept Extension Override</h3>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              This action is for missed cycles only. The prior missed cycle will be preserved. A new active cycle will be created and the Deal will be reopened (Closed → Funded).
            </p>
          </div>
        </div>

        {/* Amendment info */}
        {effectiveAmendmentTs && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
            <p className="text-[11px] font-display font-600 text-amber-800">Signed Amendment on Record</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              Received: {new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(effectiveAmendmentTs))} ET
            </p>
            {missedCycle.amendment_is_timely === false && (
              <p className="text-[11px] text-red-700 mt-0.5 font-600">Note: Recorded after EarnestBridge Option Exercise Deadline</p>
            )}
          </div>
        )}

        {/* Fee status */}
        {!missedCycle.extension_fee_paid_at && (
          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationTriangleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span><strong>Extension Fee Outstanding</strong> — override may proceed, but fee must be collected.</span>
          </div>
        )}

        {/* New hard date */}
        <div>
          <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">New Deposit Goes Hard Date</label>
          <input
            type="date"
            value={hardDate}
            onChange={(e) => setHardDate(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-all"
          />
          <p className="text-[11px] text-gray-400 mt-1.5">The new Option Exercise Deadline will be calculated automatically (2 Federal Reserve business days before this date).</p>
        </div>

        {/* Admin attestation */}
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              className="mt-0.5 flex-shrink-0 w-4 h-4 accent-red-600"
            />
            <span className="text-xs text-red-800 leading-relaxed font-600">
              I have verified that the signed PSA amendment was received before the applicable due-diligence period expired.
            </span>
          </label>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <button onClick={onCancel} disabled={loading} className="flex-1 px-4 py-2.5 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-all disabled:opacity-50">Cancel</button>
          <button
            onClick={() => hardDate && attested && onSubmit(hardDate, attested)}
            disabled={!hardDate || !attested || loading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-display font-700 text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : null}
            {loading ? 'Processing…' : 'Accept Override'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const FundingOptionSection: React.FC<FundingOptionSectionProps> = ({
  applicationId,
  appStatus,
  isMockId = false,
}) => {
  const [cycles, setCycles] = useState<OptionCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Modals
  const [showExerciseModal, setShowExerciseModal] = useState(false);
  const [showAmendmentModal, setShowAmendmentModal] = useState(false);
  const [showFeeConfirm, setShowFeeConfirm] = useState(false);
  const [showSetHardDate, setShowSetHardDate] = useState(false);
  const [showNewExtension, setShowNewExtension] = useState(false);
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [hardDateError, setHardDateError] = useState<string | null>(null);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [timestampError, setTimestampError] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const isFunded = appStatus === 'funded';

  const loadCycles = useCallback(async () => {
    if (isMockId) {
      setCycles(getMockCycles(applicationId));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/option-cycles?application_id=${applicationId}`);
      if (!res.ok) throw new Error('Failed to load option cycles');
      const json = await res.json();
      setCycles(json.cycles ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load option cycles');
    } finally {
      setLoading(false);
    }
  }, [applicationId, isMockId]);

  useEffect(() => { loadCycles(); }, [loadCycles]);

  const activeCycle = cycles.find((c) => c.status === 'active') ?? null;
  const historicalCycles = cycles.filter((c) => c.status !== 'active').sort((a, b) => b.cycle_number - a.cycle_number);

  // ── Create initial cycle ─────────────────────────────────────────────────────

  async function handleSetHardDate(date: string) {
    if (isMockId) { setShowSetHardDate(false); return; }
    setActionLoading('set_hard_date');
    setHardDateError(null);
    try {
      const res = await fetch('/api/admin/option-cycles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ application_id: applicationId, deposit_goes_hard_date: date }),
      });
      const json = await res.json();
      if (!res.ok) { setHardDateError(json.error ?? 'Failed to set hard date'); return; }
      setShowSetHardDate(false);
      await loadCycles();
    } catch {
      setHardDateError('Network error. Please try again.');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Exercise with actual timestamp ───────────────────────────────────────────

  async function handleExercise(date: string, time: string) {
    if (!activeCycle) return;
    if (isMockId) { setShowExerciseModal(false); return; }
    setActionLoading('exercise');
    setTimestampError(null);
    try {
      const res = await fetch(`/api/admin/option-cycles?id=${activeCycle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'exercise', actual_date: date, actual_time: time }),
      });
      const json = await res.json();
      if (!res.ok) { setTimestampError(json.error ?? 'Action failed'); return; }
      setShowExerciseModal(false);
      await loadCycles();
    } catch {
      setTimestampError('Network error. Please try again.');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Amendment received with actual timestamp ─────────────────────────────────
  // Works for both active cycles and missed cycles (late amendment recording)

  async function handleAmendmentReceived(date: string, time: string) {
    // Target: active cycle first, then missed cycle
    const targetCycle = activeCycle ?? cycles.find((c) => c.status === 'missed');
    if (!targetCycle) return;
    if (isMockId) { setShowAmendmentModal(false); return; }
    setActionLoading('amendment_received');
    setTimestampError(null);
    try {
      const res = await fetch(`/api/admin/option-cycles?id=${targetCycle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'amendment_received', actual_date: date, actual_time: time }),
      });
      const json = await res.json();
      if (!res.ok) { setTimestampError(json.error ?? 'Action failed'); return; }
      setShowAmendmentModal(false);
      await loadCycles();
    } catch {
      setTimestampError('Network error. Please try again.');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Fee paid ─────────────────────────────────────────────────────────────────

  async function handleFeePaid() {
    if (!activeCycle) return;
    if (isMockId) { setShowFeeConfirm(false); return; }
    setActionLoading('fee_paid');
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/option-cycles?id=${activeCycle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fee_paid' }),
      });
      const json = await res.json();
      if (!res.ok) { setActionError(json.error ?? 'Action failed'); setShowFeeConfirm(false); return; }
      setShowFeeConfirm(false);
      await loadCycles();
    } catch {
      setActionError('Network error. Please try again.');
      setShowFeeConfirm(false);
    } finally {
      setActionLoading(null);
    }
  }

  // ── New extension cycle ──────────────────────────────────────────────────────

  async function handleNewExtension(date: string) {
    if (!activeCycle) return;
    if (isMockId) { setShowNewExtension(false); return; }
    setActionLoading('new_extension');
    setExtensionError(null);
    try {
      const res = await fetch(`/api/admin/option-cycles?id=${activeCycle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'new_extension', deposit_goes_hard_date: date }),
      });
      const json = await res.json();
      if (!res.ok) { setExtensionError(json.error ?? 'Failed to create extension cycle'); return; }
      setShowNewExtension(false);
      await loadCycles();
    } catch {
      setExtensionError('Network error. Please try again.');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Extension override (missed cycle) ────────────────────────────────────────

  async function handleExtensionOverride(hardDate: string, attestation: boolean) {
    // Find the missed cycle to override
    const missedCycle = cycles.find((c) => c.status === 'missed');
    if (!missedCycle) return;
    if (isMockId) { setShowOverrideModal(false); return; }
    setActionLoading('extension_override');
    setOverrideError(null);
    try {
      const res = await fetch(`/api/admin/option-cycles?id=${missedCycle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'extension_override',
          deposit_goes_hard_date: hardDate,
          admin_attestation: attestation,
        }),
      });
      const json = await res.json();
      if (!res.ok) { setOverrideError(json.error ?? 'Override failed'); return; }
      setShowOverrideModal(false);
      await loadCycles();
    } catch {
      setOverrideError('Network error. Please try again.');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Icon name="BanknotesIcon" size={16} className="text-eb-green-700" />
          <h3 className="font-display font-700 text-sm text-gray-900">Funding &amp; Option</h3>
        </div>
        {activeCycle && <CycleStatusBadge cycle={activeCycle} />}
      </div>

      {!isFunded && (
        <div className="flex items-start gap-3 bg-gray-50 border border-gray-100 rounded-xl px-4 py-4">
          <Icon name="InformationCircleIcon" size={16} className="text-gray-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-display font-700 text-gray-600">Deal Not Yet Funded</p>
            <p className="text-[11px] text-gray-400 mt-0.5">The Funding &amp; Option lifecycle becomes available once this Deal is marked as Funded.</p>
          </div>
        </div>
      )}

      {isFunded && !loading && cycles.length === 0 && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-4">
            <Icon name="ExclamationCircleIcon" size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-display font-700 text-red-800">Action Required — Enter Deposit Goes Hard Date</p>
              <p className="text-[11px] text-red-700 mt-0.5">This Deal is funded but no Deposit Goes Hard Date has been set. The Option Exercise Deadline cannot be calculated until this date is entered.</p>
            </div>
          </div>
          <button
            onClick={() => { setHardDateError(null); setShowSetHardDate(true); }}
            className="flex items-center gap-2 px-4 py-2.5 text-xs font-display font-700 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-xl transition-all min-h-[40px]"
          >
            <Icon name="CalendarDaysIcon" size={13} />
            Set Hard Date
          </button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Icon name="ArrowPathIcon" size={20} className="animate-spin text-gray-300" />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {actionError && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0 mt-0.5" />
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="ml-auto flex-shrink-0">
            <Icon name="XMarkIcon" size={12} className="text-red-400 hover:text-red-600" />
          </button>
        </div>
      )}

      {isFunded && !loading && activeCycle && (
        <ActiveCycleCard
          cycle={activeCycle}
          onExercise={() => { setTimestampError(null); setShowExerciseModal(true); }}
          onAmendmentReceived={() => { setTimestampError(null); setShowAmendmentModal(true); }}
          onFeePaid={() => setShowFeeConfirm(true)}
          onNewExtension={() => { setExtensionError(null); setShowNewExtension(true); }}
          actionLoading={actionLoading}
        />
      )}

      {historicalCycles.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide">Prior Cycles</p>
          {historicalCycles.map((c) => (
            <HistoricalCycleRow key={c.id} cycle={c} />
          ))}
        </div>
      )}

      {/* Missed cycle — Admin override section */}
      {(() => {
        const missedCycle = cycles.find((c) => c.status === 'missed');
        if (!missedCycle) return null;
        const hasAmendment = !!(missedCycle.effective_amendment_received_at ?? missedCycle.extension_psa_amendment_received_at);
        return (
          <div className="border border-red-200 rounded-xl overflow-hidden">
            <div className="bg-red-50 px-4 py-3 flex items-center gap-2">
              <Icon name="XCircleIcon" size={14} className="text-red-600 flex-shrink-0" />
              <p className="text-xs font-display font-700 text-red-800">Missed Option Deadline — Cycle {missedCycle.cycle_number}</p>
            </div>
            <div className="px-4 py-3 space-y-3 bg-white">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Option Exercise Deadline</p>
                  <p className="text-gray-800 font-600 mt-0.5">{formatDate(missedCycle.option_exercise_deadline)} at 5:00 PM ET</p>
                </div>
                <div>
                  <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Deposit Goes Hard</p>
                  <p className="text-gray-800 font-600 mt-0.5">{formatDate(missedCycle.deposit_goes_hard_date)}</p>
                </div>
              </div>

              {/* Amendment status on missed cycle */}
              {!hasAmendment ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-500">No signed PSA amendment recorded. Record an amendment to enable the override option.</p>
                  <button
                    onClick={() => { setTimestampError(null); setShowAmendmentModal(true); }}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition-all disabled:opacity-50 min-h-[36px]"
                  >
                    {actionLoading === 'amendment_received' ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="DocumentCheckIcon" size={12} />}
                    Record Signed Amendment
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 text-[11px] bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <Icon name="ExclamationTriangleIcon" size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-600 text-amber-800">Received After EarnestBridge Option Deadline — Manual Review Required</p>
                      <p className="text-amber-700 mt-0.5">
                        Amendment received: {formatDateTimeET(missedCycle.effective_amendment_received_at ?? missedCycle.extension_psa_amendment_received_at)}
                      </p>
                    </div>
                  </div>
                  {!missedCycle.extension_fee_paid_at && (
                    <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <Icon name="ExclamationTriangleIcon" size={12} className="flex-shrink-0 mt-0.5" />
                      <span>Extension Fee Outstanding</span>
                    </div>
                  )}
                  <button
                    onClick={() => { setOverrideError(null); setShowOverrideModal(true); }}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-700 text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-all disabled:opacity-50 min-h-[36px]"
                  >
                    {actionLoading === 'extension_override' ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="ShieldCheckIcon" size={12} />}
                    Accept Extension Override
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Exercise timestamp modal */}
      {showExerciseModal && activeCycle && (
        <TimestampModal
          title="Mark Option Exercised"
          description={`Record when EarnestBridge received the option exercise. The server will determine whether this is before or after the ${formatDeadlineCutoffDisplay(activeCycle.option_exercise_deadline)} cutoff.`}
          confirmLabel="Mark Exercised"
          confirmClass="bg-eb-green-900 hover:bg-eb-green-800"
          onSubmit={handleExercise}
          onCancel={() => { setShowExerciseModal(false); setTimestampError(null); }}
          loading={actionLoading === 'exercise'}
          error={timestampError}
          warningNote="If EarnestBridge received the exercise before you entered it in the CRM, correct the date and time to the actual receipt time."
        />
      )}

      {/* Amendment timestamp modal — also used for missed cycles */}
      {showAmendmentModal && (activeCycle || cycles.find(c => c.status === 'missed')) && (() => {
        const targetCycle = activeCycle ?? cycles.find(c => c.status === 'missed')!;
        return (
          <TimestampModal
            title="Record Signed Amendment Received"
            description={`Record when EarnestBridge received the signed PSA amendment. The cutoff is ${formatDeadlineCutoffDisplay(targetCycle.option_exercise_deadline)}. The server will determine timeliness.`}
            confirmLabel="Record Amendment"
            confirmClass="bg-eb-green-900 hover:bg-eb-green-800"
            onSubmit={handleAmendmentReceived}
            onCancel={() => { setShowAmendmentModal(false); setTimestampError(null); }}
            loading={actionLoading === 'amendment_received'}
            error={timestampError}
            warningNote="If EarnestBridge received the amendment before you entered it in the CRM, correct the date and time to the actual receipt time. Timeliness is determined by the server."
          />
        );
      })()}

      {/* Fee paid confirm */}
      {showFeeConfirm && activeCycle && (
        <ConfirmModal
          title="Mark Extension Fee Paid"
          message="Confirm that the Extension Deal Fee has been received."
          confirmLabel="Mark Fee Paid"
          confirmClass="bg-eb-green-900 hover:bg-eb-green-800"
          onConfirm={handleFeePaid}
          onCancel={() => setShowFeeConfirm(false)}
          loading={actionLoading === 'fee_paid'}
        />
      )}

      {showSetHardDate && (
        <SetHardDateModal
          title="Set Deposit Goes Hard Date"
          description="Enter the date the EMD deposit goes hard. The Option Exercise Deadline will be automatically calculated as 2 Federal Reserve business days before this date."
          onSubmit={handleSetHardDate}
          onCancel={() => setShowSetHardDate(false)}
          loading={actionLoading === 'set_hard_date'}
          error={hardDateError}
        />
      )}

      {showNewExtension && activeCycle && (
        <SetHardDateModal
          title="Set New Deposit Goes Hard Date"
          description={`Enter the new hard date for the extension. The current cycle (Cycle ${activeCycle.cycle_number}) will be marked as Extended and a new cycle will be created. The new Option Exercise Deadline will be calculated automatically.`}
          onSubmit={handleNewExtension}
          onCancel={() => setShowNewExtension(false)}
          loading={actionLoading === 'new_extension'}
          error={extensionError}
        />
      )}

      {/* Extension override modal — for missed cycles */}
      {showOverrideModal && (() => {
        const missedCycle = cycles.find((c) => c.status === 'missed');
        if (!missedCycle) return null;
        return (
          <ExtensionOverrideModal
            missedCycle={missedCycle}
            onSubmit={handleExtensionOverride}
            onCancel={() => { setShowOverrideModal(false); setOverrideError(null); }}
            loading={actionLoading === 'extension_override'}
            error={overrideError}
          />
        );
      })()}
    </div>
  );
};

export default FundingOptionSection;
