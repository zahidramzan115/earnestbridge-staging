'use client';
import React, { useEffect, useState, useMemo } from 'react';

import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClientDeadlineItem {
  id: string;
  application_id: string;
  title: string;
  deadline_type: string;
  due_date: string;
  responsible_party: 'client' | 'earnestbridge' | 'third_party';
  status: 'open' | 'completed' | 'cancelled';
  property_address: string | null;
  deal_display_name: string | null;
}

interface ClosingDateItem {
  type: 'closing';
  application_id: string;
  title: string;
  due_date: string;
  responsible_party: 'system';
  status: 'open' | 'completed';
  property_address: string | null;
  deal_display_name: string | null;
}

interface ClientOptionCycleItem {
  type: 'option_cycle';
  id: string;
  application_id: string;
  deposit_goes_hard_date: string | null;
  cycle_number: number;
  // NOTE: deposit_goes_hard_date is intentionally absent — Admin only, never returned to client
  option_exercise_deadline: string;
  option_deadline_cutoff_display: string;
  option_status: 'active' | 'exercised' | 'extended' | 'missed';
  has_timely_amendment: boolean;
  extension_fee_paid: boolean;
  option_exercised_at: string | null;
  property_address: string | null;
  deal_display_name: string | null;
}

// Unified display item
interface DisplayDeadline {
  key: string;
  application_id: string;
  title: string;
  due_date: string;
  responsible_party: string;
  status: string;
  property_address: string | null;
  deal_display_name: string | null;
  isClosing: boolean;
  isOptionCycle: boolean;
  daysLeft: number;
  derivedState: 'overdue' | 'today' | 'upcoming' | 'completed';
  // Option cycle specific
  // NOTE: depositGoesHardDate is intentionally absent — Admin only, never shown to client
  optionCutoffDisplay?: string;
  optionStatus?: 'active' | 'exercised' | 'extended' | 'missed';
  optionHasTimelyAmendment?: boolean;
  optionFeePaid?: boolean;
  depositGoesHardDate?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Safe UTC-based days calculation to avoid timezone day-shifting
function daysUntil(dateStr: string): number {
  const todayUTC = new Date();
  const todayMidnight = Date.UTC(todayUTC.getFullYear(), todayUTC.getMonth(), todayUTC.getDate());
  const parts = dateStr.split('-').map(Number);
  const targetMidnight = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  return Math.round((targetMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
}

function derivedState(status: string, daysLeft: number): 'overdue' | 'today' | 'upcoming' | 'completed' {
  if (status === 'completed' || status === 'exercised' || status === 'missed') return 'completed';
  if (daysLeft < 0) return 'overdue';
  if (daysLeft === 0) return 'today';
  return 'upcoming';
}

function responsiblePartyLabel(rp: string): string {
  if (rp === 'client') return 'Your Action';
  if (rp === 'earnestbridge') return 'EarnestBridge';
  if (rp === 'third_party') return 'Third Party';
  return 'Informational';
}

function responsiblePartyStyle(rp: string): string {
  if (rp === 'client') return 'bg-amber-100 text-amber-800';
  if (rp === 'earnestbridge') return 'bg-blue-100 text-blue-800';
  if (rp === 'third_party') return 'bg-purple-100 text-purple-800';
  return 'bg-gray-100 text-gray-600';
}

// ─── Option Cycle Status for Client ──────────────────────────────────────────
// Maps server-derived option state to client-safe display language.
// Do NOT expose internal fee-leniency language.
// Do NOT expose manual override policy.

function getClientOptionStatusLabel(cycle: DisplayDeadline): { label: string; color: string; bg: string } {
  if (cycle.optionStatus === 'missed') {
    return { label: 'Deadline Not Met', color: 'text-gray-700', bg: 'bg-gray-100' };
  }
  if (cycle.optionStatus === 'exercised') {
    return { label: 'Option Exercised', color: 'text-blue-700', bg: 'bg-blue-50' };
  }
  if (cycle.optionHasTimelyAmendment && cycle.optionFeePaid) {
    return { label: 'Extension Requirements Received', color: 'text-teal-700', bg: 'bg-teal-50' };
  }
  if (cycle.optionHasTimelyAmendment && !cycle.optionFeePaid) {
    return { label: 'Extension in Process', color: 'text-amber-700', bg: 'bg-amber-50' };
  }
  return { label: 'Action Required', color: 'text-red-700', bg: 'bg-red-50' };
}

// ─── Option Cycle Card ────────────────────────────────────────────────────────
// SECURITY: This card must NEVER display:
//   - Internal buffer language
//   - Manual override policy
//   - Internal leniency language
//   - Late amendment status (client sees only the Option Exercise Deadline as firm)
// Deposit Goes Hard is shown as a neutral, secondary date only (no countdown/urgency).

function OptionCycleCard({ item }: { item: DisplayDeadline }) {
  const state = item.derivedState;
  const statusInfo = getClientOptionStatusLabel(item);
  const isMissed = item.optionStatus === 'missed';
  const isResolved = item.optionStatus === 'exercised' || (item.optionHasTimelyAmendment && item.optionFeePaid);
  const isExercised = item.optionStatus === 'exercised';

  const urgencyBorder = state === 'overdue' ? 'border-red-300' : state === 'today' ? 'border-red-200' : item.daysLeft <= 7 ? 'border-amber-200' : 'border-indigo-200';
  const urgencyBg = state === 'overdue' ? 'bg-red-50' : state === 'today' ? 'bg-red-50' : item.daysLeft <= 7 ? 'bg-amber-50' : 'bg-indigo-50';

  if (isMissed) {
    return (
      <div className="rounded-2xl border-2 border-gray-200 bg-gray-50 p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-start gap-2 justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
              <Icon name="ClockIcon" size={16} className="text-gray-500" />
            </div>
            <div>
              <h3 className="font-display font-700 text-gray-900 text-sm sm:text-base leading-tight">Option Exercise Deadline</h3>
              {item.deal_display_name && (
                <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                  <Icon name="BuildingOffice2Icon" size={11} className="text-gray-400 flex-shrink-0" />
                  {item.deal_display_name}
                </p>
              )}
            </div>
          </div>
          <span className={`text-[11px] font-display font-700 px-2.5 py-1 rounded-full border border-gray-200 ${statusInfo.color} ${statusInfo.bg}`}>
            {statusInfo.label}
          </span>
        </div>
        <div className="bg-white/70 rounded-xl px-3 py-2.5 border border-white/50">
          <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Option Exercise Deadline</p>
          <p className="text-sm font-display font-700 text-gray-700">{item.optionCutoffDisplay}</p>
        </div>
        <p className="text-[11px] text-gray-600 leading-relaxed">
          The Option Exercise Deadline was not completed, so this deal has been closed in EarnestBridge. Contact EarnestBridge if you believe required extension documentation was submitted.
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border-2 ${isResolved ? 'border-teal-200 bg-teal-50' : urgencyBorder + ' ' + urgencyBg} p-4 sm:p-5 space-y-3`}>
      {/* Header row */}
      <div className="flex flex-wrap items-start gap-2 justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <Icon name="ClockIcon" size={16} className="text-indigo-700" />
          </div>
          <div>
            <h3 className="font-display font-700 text-gray-900 text-sm sm:text-base leading-tight">Option Exercise Deadline</h3>
            {item.deal_display_name && (
              <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                <Icon name="BuildingOffice2Icon" size={11} className="text-gray-400 flex-shrink-0" />
                {item.deal_display_name}
              </p>
            )}
          </div>
        </div>
        <span className={`text-[11px] font-display font-700 px-2.5 py-1 rounded-full border ${statusInfo.color} ${statusInfo.bg} ${isResolved ? 'border-teal-200' : 'border-current border-opacity-20'}`}>
          {statusInfo.label}
        </span>
      </div>

      {/* Key date — Option Exercise Deadline is PRIMARY */}
      <div className="grid grid-cols-1 gap-2">
        <div className="bg-white/70 rounded-xl px-3 py-2.5 border border-white/50">
          <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Option Exercise Deadline</p>
          <p className={`text-sm font-display font-700 ${isResolved ? 'text-gray-600' : state === 'overdue' ? 'text-red-700' : state === 'today' ? 'text-red-700' : 'text-gray-900'}`}>
            {item.optionCutoffDisplay}
          </p>
          {!isResolved && (
            <p className="text-[11px] text-gray-500 mt-0.5">
              {state === 'overdue'
                ? `${Math.abs(item.daysLeft)} day${Math.abs(item.daysLeft) !== 1 ? 's' : ''} overdue`
                : state === 'today' ? 'Due today — 5:00 PM ET'
                : `${item.daysLeft} day${item.daysLeft !== 1 ? 's' : ''} remaining`}
            </p>
          )}
        </div>
        {/* Deposit Goes Hard — neutral secondary date, no countdown or urgency */}
        {item.depositGoesHardDate && (
          <div className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200">
            <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">Deposit Goes Hard</p>
            <p className="text-xs font-display font-600 text-gray-600">{formatDateShort(item.depositGoesHardDate)}</p>
          </div>
        )}
      </div>

      {/* Extension in process sub-status */}
      {item.optionHasTimelyAmendment && !item.optionFeePaid && !isExercised && (
        <div className="flex items-start gap-2 bg-amber-100/60 border border-amber-200 rounded-xl px-3 py-2.5">
          <Icon name="ClockIcon" size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-display font-700 text-amber-800">Extension in Process</p>
            <p className="text-[11px] text-amber-700 mt-0.5">Extension Deal Fee Pending</p>
          </div>
        </div>
      )}

      {/* Action guidance — only when unresolved and active */}
      {!isResolved && item.optionStatus === 'active' && (
        <div className="bg-white/80 border border-gray-200 rounded-xl px-3 py-3 space-y-2">
          <p className="text-xs font-display font-700 text-gray-800">Your Action</p>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Exercise your option by the deadline above, or if you need additional due-diligence time, <strong>both</strong> of the following are required:
          </p>
          <ol className="space-y-1.5 ml-1">
            <li className="flex items-start gap-2 text-[11px] text-gray-700">
              <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[9px] font-700 flex-shrink-0 mt-0.5">1</span>
              <span><strong>Signed amendment to the Purchase &amp; Sale Agreement</strong> extending the due-diligence period — must be received by EarnestBridge no later than 5:00 PM Eastern on the Option Exercise Deadline</span>
            </li>
            <li className="flex items-start gap-2 text-[11px] text-gray-700">
              <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[9px] font-700 flex-shrink-0 mt-0.5">2</span>
              <span><strong>Extension Deal Fee payment</strong></span>
            </li>
          </ol>
        </div>
      )}

      {/* Exercised confirmation */}
      {isExercised && (
        <div className="flex items-center gap-2 text-[11px] text-blue-700">
          <Icon name="CheckBadgeIcon" size={14} className="text-blue-600" />
          <span>Option exercised — no further action required.</span>
        </div>
      )}
    </div>
  );
}

// ─── Deadline Card ────────────────────────────────────────────────────────────

function DeadlineCard({ item }: { item: DisplayDeadline }) {
  // Target Closing is informational only — neutral styling, no countdown/urgency.
  const state = item.isClosing ? (item.derivedState === 'completed' ? 'completed' : 'informational') : item.derivedState;

  const stateConfig = {
    overdue: {
      border: 'border-red-200', bg: 'bg-red-50',
      badge: 'bg-red-100 text-red-700', badgeLabel: 'Overdue',
      numColor: 'text-red-600', numBg: 'bg-red-100',
    },
    today: {
      border: 'border-red-200', bg: 'bg-red-50',
      badge: 'bg-red-100 text-red-700', badgeLabel: 'Due Today',
      numColor: 'text-red-600', numBg: 'bg-red-100',
    },
    upcoming: {
      border: item.daysLeft <= 7 ? 'border-amber-200' : 'border-blue-200',
      bg: item.daysLeft <= 7 ? 'bg-amber-50' : 'bg-blue-50',
      badge: item.daysLeft <= 7 ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700',
      badgeLabel: item.daysLeft <= 7 ? `Due in ${item.daysLeft} day${item.daysLeft !== 1 ? 's' : ''}` : `${item.daysLeft} days`,
      numColor: item.daysLeft <= 7 ? 'text-amber-600' : 'text-blue-600',
      numBg: item.daysLeft <= 7 ? 'bg-amber-100' : 'bg-blue-100',
    },
    informational: {
      border: 'border-gray-200', bg: 'bg-gray-50',
      badge: 'bg-gray-100 text-gray-600', badgeLabel: 'Informational',
      numColor: 'text-gray-500', numBg: 'bg-gray-100',
    },
    completed: {
      border: 'border-gray-200', bg: 'bg-gray-50',
      badge: 'bg-emerald-100 text-emerald-700', badgeLabel: 'Completed',
      numColor: 'text-gray-400', numBg: 'bg-gray-100',
    },
  }[state];

  return (
    <div className={`rounded-2xl border ${stateConfig.border} ${stateConfig.bg} p-4 sm:p-5 flex flex-col sm:flex-row sm:items-start gap-4 transition-all`}>
      <div className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center flex-shrink-0 ${stateConfig.numBg} border ${stateConfig.border}`}>
        {state === 'informational' ? (
          <Icon name="HomeModernIcon" size={22} className={stateConfig.numColor} />
        ) : state === 'overdue' ? (
          <><Icon name="ExclamationTriangleIcon" size={18} className={stateConfig.numColor} /><span className={`text-[9px] font-700 uppercase mt-0.5 ${stateConfig.numColor}`}>Overdue</span></>
        ) : state === 'today' ? (
          <><span className={`text-xl font-display font-800 leading-none ${stateConfig.numColor}`}>!</span><span className={`text-[9px] font-700 uppercase mt-0.5 ${stateConfig.numColor}`}>Today</span></>
        ) : state === 'completed' ? (
          <Icon name="CheckCircleIcon" size={22} className="text-emerald-500" />
        ) : (
          <><span className={`text-xl font-display font-800 tabular-nums leading-none ${stateConfig.numColor}`}>{item.daysLeft}</span><span className={`text-[9px] font-700 uppercase tracking-wide mt-0.5 ${stateConfig.numColor}`}>days</span></>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h3 className="font-display font-700 text-gray-900 text-sm sm:text-base leading-tight">{item.title}</h3>
          <span className={`text-[10px] font-display font-700 px-2 py-0.5 rounded-full ${stateConfig.badge}`}>{stateConfig.badgeLabel}</span>
        </div>
        {item.deal_display_name && (
          <p className="text-xs text-gray-500 truncate mb-1.5 flex items-center gap-1">
            <Icon name="BuildingOffice2Icon" size={11} className="text-gray-400 flex-shrink-0" />
            {item.deal_display_name}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <Icon name="CalendarDaysIcon" size={11} className="text-gray-400" />
            {formatDateShort(item.due_date)}
          </span>
          <span className={`text-[10px] font-display font-600 px-2 py-0.5 rounded-full ${responsiblePartyStyle(item.responsible_party)}`}>
            {responsiblePartyLabel(item.responsible_party)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({ icon, title, count, color }: { icon: string; title: string; count?: number; color: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon name={icon as Parameters<typeof Icon>[0]['name']} size={16} className={color} />
      <h2 className="font-display font-700 text-gray-900 text-sm sm:text-base">{title}</h2>
      {count !== undefined && count > 0 && (
        <span className="ml-1 bg-gray-100 text-gray-600 text-[10px] font-display font-700 px-1.5 py-0.5 rounded-full">{count}</span>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DeadlinesContent() {
  const { user } = useAuth();
  const [deadlines, setDeadlines] = useState<ClientDeadlineItem[]>([]);
  const [closingDates, setClosingDates] = useState<ClosingDateItem[]>([]);
  const [optionCycles, setOptionCycles] = useState<ClientOptionCycleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    if (!user) { setLoading(false); return; }

    const fetchDeadlines = async () => {
      try {
        const res = await fetch('/api/client/deadlines');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'Failed to load deadlines');
          setLoading(false);
          return;
        }
        const data = await res.json();
        setDeadlines(data.deadlines || []);
        setClosingDates(data.closingDates || []);
        setOptionCycles(data.optionCycles || []);
      } catch {
        setError('Failed to load deadlines');
      } finally {
        setLoading(false);
      }
    };

    fetchDeadlines();
  }, [user]);

  // ── Normalize option cycles into DisplayDeadline items ────────────────────
  // SECURITY: depositGoesHardDate is intentionally absent from DisplayDeadline.
  // The Deposit Goes Hard Date is Admin-only and must not appear in client UI.
  const optionCycleItems = useMemo((): DisplayDeadline[] => {
    return optionCycles.map((oc) => {
      const dl = daysUntil(oc.option_exercise_deadline);
      const isResolved = oc.option_status === 'exercised' || oc.option_status === 'missed' || (oc.has_timely_amendment && oc.extension_fee_paid);
      const statusStr = oc.option_status === 'missed' ? 'missed' : isResolved ? 'completed' : 'open';
      return {
        key: `option-cycle-${oc.id}`,
        application_id: oc.application_id,
        title: 'Option Exercise Deadline',
        due_date: oc.option_exercise_deadline,
        responsible_party: 'client',
        status: statusStr,
        property_address: oc.property_address,
        deal_display_name: oc.deal_display_name,
        isClosing: false,
        isOptionCycle: true,
        daysLeft: dl,
        derivedState: derivedState(statusStr, dl),
        optionCutoffDisplay: oc.option_deadline_cutoff_display,
        optionStatus: oc.option_status,
        optionHasTimelyAmendment: oc.has_timely_amendment,
        optionFeePaid: oc.extension_fee_paid,
        depositGoesHardDate: oc.deposit_goes_hard_date ?? null,
        // depositGoesHardDate: intentionally excluded — Admin only
      };
    });
  }, [optionCycles]);

  // ── Normalize all custom deadline items ───────────────────────────────────
  const allCustomItems = useMemo((): DisplayDeadline[] => {
    const items: DisplayDeadline[] = [];

    deadlines.forEach((d) => {
      const dl = daysUntil(d.due_date);
      items.push({
        key: `deadline-${d.id}`,
        application_id: d.application_id,
        title: d.title,
        due_date: d.due_date,
        responsible_party: d.responsible_party,
        status: d.status,
        property_address: d.property_address,
        deal_display_name: d.deal_display_name,
        isClosing: false,
        isOptionCycle: false,
        daysLeft: dl,
        derivedState: derivedState(d.status, dl),
      });
    });

    closingDates.forEach((c) => {
      const dl = daysUntil(c.due_date);
      items.push({
        key: `closing-${c.application_id}`,
        application_id: c.application_id,
        title: 'Target Closing',
        due_date: c.due_date,
        responsible_party: 'system',
        status: c.status,
        property_address: c.property_address,
        deal_display_name: c.deal_display_name,
        isClosing: true,
        isOptionCycle: false,
        daysLeft: dl,
        derivedState: derivedState(c.status, dl),
      });
    });

    return items;
  }, [deadlines, closingDates]);

  // ── Priority ordering per spec ────────────────────────────────────────────
  // 1. Active unresolved Option Exercise Deadlines (top of Action Required)
  // 2. Overdue client-responsible deadlines
  // 3. Due-today client-responsible deadlines
  // 4. Upcoming client-responsible deadlines
  // 5. Informational closing/deal dates

  // Active unresolved option cycles (highest priority)
  const activeOptionItems = useMemo(() =>
    optionCycleItems.filter((i) => i.derivedState !== 'completed').sort((a, b) => a.daysLeft - b.daysLeft),
    [optionCycleItems]
  );

  // Resolved option cycles (go to completed section)
  const resolvedOptionItems = useMemo(() =>
    optionCycleItems.filter((i) => i.derivedState === 'completed'),
    [optionCycleItems]
  );

  // Client-responsible custom deadlines (not option cycles)
  const actionRequired = useMemo(() =>
    allCustomItems
      .filter((i) => i.responsible_party === 'client' && (i.derivedState === 'overdue' || i.derivedState === 'today' || i.derivedState === 'upcoming'))
      .sort((a, b) => a.daysLeft - b.daysLeft),
    [allCustomItems]
  );

  // Upcoming / Deal Dates: closing + EB/third-party (not already in action required)
  const actionRequiredKeys = useMemo(() => new Set(actionRequired.map((i) => i.key)), [actionRequired]);

  const upcomingDealDates = useMemo(() =>
    allCustomItems
      .filter((i) =>
        !actionRequiredKeys.has(i.key) &&
        (i.derivedState === 'upcoming' || i.derivedState === 'today' || i.derivedState === 'overdue')
      )
      .sort((a, b) => a.daysLeft - b.daysLeft),
    [allCustomItems, actionRequiredKeys]
  );

  // Completed: completed custom deadlines + resolved option cycles
  const completedItems = useMemo(() =>
    [
      ...resolvedOptionItems,
      ...allCustomItems.filter((i) => i.derivedState === 'completed'),
    ].sort((a, b) => a.due_date.localeCompare(b.due_date)),
    [allCustomItems, resolvedOptionItems]
  );

  const totalActionRequired = activeOptionItems.length + actionRequired.length;
  const hasAnyContent = activeOptionItems.length > 0 || actionRequired.length > 0 || upcomingDealDates.length > 0 || completedItems.length > 0;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={`sk-${i}`} className="h-20 bg-gray-100 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
          <Icon name="ExclamationTriangleIcon" size={24} className="text-red-500" />
        </div>
        <h2 className="font-display font-700 text-gray-900 text-lg mb-2">Unable to load deadlines</h2>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  if (!hasAnyContent) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-16 h-16 rounded-2xl bg-eb-green-50 flex items-center justify-center mb-4">
          <Icon name="CalendarDaysIcon" size={28} className="text-eb-green-600" />
        </div>
        <h2 className="font-display font-700 text-gray-900 text-lg mb-2">No deadlines yet</h2>
        <p className="text-sm text-gray-500 max-w-xs">
          Your deal deadlines will appear here once EarnestBridge sets them up for your active deals.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">

      {/* ── Action Required ──────────────────────────────────────────────── */}
      {totalActionRequired > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
              <Icon name="ExclamationTriangleIcon" size={14} className="text-white" />
            </div>
            <h2 className="font-display font-700 text-gray-900 text-base">Action Required</h2>
            <span className="ml-1 bg-amber-100 text-amber-700 text-[10px] font-display font-700 px-1.5 py-0.5 rounded-full">
              {totalActionRequired}
            </span>
          </div>
          <div className="space-y-3">
            {/* Option Exercise Deadlines first — highest priority */}
            {activeOptionItems.map((item) => (
              <OptionCycleCard key={item.key} item={item} />
            ))}
            {/* Then client-responsible custom deadlines */}
            {actionRequired.map((item) => (
              <DeadlineCard key={item.key} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* ── Upcoming / Deal Dates ─────────────────────────────────────────── */}
      {upcomingDealDates.length > 0 && (
        <section>
          <SectionHeader icon="CalendarDaysIcon" title="Upcoming / Deal Dates" count={upcomingDealDates.length} color="text-blue-600" />
          <div className="space-y-3">
            {upcomingDealDates.map((item) => (
              <DeadlineCard key={item.key} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* ── No open items ─────────────────────────────────────────────────── */}
      {totalActionRequired === 0 && upcomingDealDates.length === 0 && completedItems.length > 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="w-14 h-14 rounded-2xl bg-emerald-50 flex items-center justify-center mb-3">
            <Icon name="CheckCircleIcon" size={26} className="text-emerald-500" />
          </div>
          <h3 className="font-display font-700 text-gray-900 text-base mb-1">All caught up!</h3>
          <p className="text-sm text-gray-500">No open deadlines at this time.</p>
        </div>
      )}

      {/* ── Completed ────────────────────────────────────────────────────── */}
      {completedItems.length > 0 && (
        <section>
          <button
            onClick={() => setShowCompleted((v) => !v)}
            className="flex items-center gap-2 mb-3 text-left group"
          >
            <Icon name={showCompleted ? 'ChevronDownIcon' : 'ChevronRightIcon'} size={14} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
            <span className="font-display font-600 text-gray-500 text-sm group-hover:text-gray-700 transition-colors">
              Completed ({completedItems.length})
            </span>
          </button>
          {showCompleted && (
            <div className="space-y-3">
              {completedItems.map((item) => (
                item.isOptionCycle
                  ? <OptionCycleCard key={item.key} item={item} />
                  : <DeadlineCard key={item.key} item={item} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
