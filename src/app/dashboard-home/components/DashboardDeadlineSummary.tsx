'use client';
import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';

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

interface ClientOptionCycleItem {
  type: 'option_cycle';
  id: string;
  application_id: string;
  cycle_number: number;
  // NOTE: deposit_goes_hard_date is intentionally absent — Admin only, never returned to client
  option_exercise_deadline: string;
  option_deadline_cutoff_display: string;
  option_status: 'active' | 'exercised' | 'extended';
  has_timely_amendment: boolean;
  extension_fee_paid: boolean;
  option_exercised_at: string | null;
  property_address: string | null;
  deal_display_name: string | null;
}

interface DisplayItem {
  key: string;
  title: string;
  due_date: string;
  responsible_party: string;
  deal_display_name: string | null;
  daysLeft: number;
  isClosing: boolean;
  isOptionCycle: boolean;
  isActionRequired: boolean;
  // Option cycle extras
  // NOTE: depositGoesHardDate intentionally absent — Admin only, never shown to client
  optionCutoffDisplay?: string;
  optionStatus?: 'active' | 'exercised' | 'extended';
  optionHasTimelyAmendment?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateShort(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  return `${MONTHS[parts[1] - 1]} ${parts[2]}`;
}

// UTC-safe days calculation
function daysUntil(dateStr: string): number {
  const now = new Date();
  const todayMidnight = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const parts = dateStr.split('-').map(Number);
  const targetMidnight = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  return Math.round((targetMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
}

export default function DashboardDeadlineSummary() {
  const { user } = useAuth();
  const [deadlines, setDeadlines] = useState<ClientDeadlineItem[]>([]);
  const [optionCycles, setOptionCycles] = useState<ClientOptionCycleItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) { setLoading(false); return; }

    const fetchDeadlines = async () => {
      try {
        const res = await fetch('/api/client/deadlines');
        if (!res.ok) { setLoading(false); return; }
        const data = await res.json();
        setDeadlines(data.deadlines || []);
        setOptionCycles(data.optionCycles || []);
      } catch {
        // silent fail — dashboard should not break if deadlines fail
      } finally {
        setLoading(false);
      }
    };

    fetchDeadlines();
  }, [user]);

  // Build compact display list with correct priority ordering:
  // 1. Active unresolved Option Exercise Deadlines (highest priority — never displaced)
  // 2. Overdue client-responsible deadlines
  // 3. Due-today client-responsible deadlines
  // 4. Upcoming client-responsible deadlines
  // 5. Informational closing/deal dates (only if space remains after actions)
  //
  // Informational items must NOT push genuine Action Required items out of view.
  // The 5-item cap applies to informational items only AFTER all action items are shown.
  //
  // SECURITY: Deposit Goes Hard Date is never included in any display item.
  // It is an Admin-only internal date.

  const displayItems = useMemo((): DisplayItem[] => {
    // ── 1. Active unresolved option cycles (always shown, highest priority) ──
    const activeOptionItems: DisplayItem[] = optionCycles
      .filter((oc) => {
        const isResolved = oc.option_status === 'exercised' || (oc.has_timely_amendment && oc.extension_fee_paid);
        return !isResolved;
      })
      .map((oc) => ({
        key: `option-cycle-${oc.id}`,
        title: 'Option Exercise Deadline',
        due_date: oc.option_exercise_deadline,
        responsible_party: 'client',
        deal_display_name: oc.deal_display_name,
        daysLeft: daysUntil(oc.option_exercise_deadline),
        isClosing: false,
        isOptionCycle: true,
        isActionRequired: true,
        optionCutoffDisplay: oc.option_deadline_cutoff_display,
        optionStatus: oc.option_status,
        optionHasTimelyAmendment: oc.has_timely_amendment,
        // depositGoesHardDate: intentionally excluded — Admin only
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft);

    // ── 2. Client-responsible custom deadlines (action required) ──────────
    const clientActionItems: DisplayItem[] = deadlines
      .filter((d) => d.responsible_party === 'client' && d.status === 'open')
      .map((d) => ({
        key: `deadline-${d.id}`,
        title: d.title,
        due_date: d.due_date,
        responsible_party: d.responsible_party,
        deal_display_name: d.deal_display_name,
        daysLeft: daysUntil(d.due_date),
        isClosing: false,
        isOptionCycle: false,
        isActionRequired: true,
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft);

    // ── Priority assembly ─────────────────────────────────────────────────
    return [...activeOptionItems, ...clientActionItems];
  }, [deadlines, optionCycles]);

  const actionRequiredCount = useMemo(
    () => displayItems.filter((i) => i.isActionRequired).length,
    [displayItems]
  );

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-100 rounded w-1/2" />
          {[...Array(3)].map((_, i) => (
            <div key={`sk-${i}`} className="h-12 bg-gray-100 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (displayItems.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="CalendarDaysIcon" size={16} className="text-eb-green-700" />
        <h3 className="font-display font-600 text-gray-900 text-sm">Upcoming Deadlines</h3>
        {actionRequiredCount > 0 && (
          <span className="ml-1 bg-amber-100 text-amber-700 text-[10px] font-display font-700 px-1.5 py-0.5 rounded-full">
            {actionRequiredCount} action{actionRequiredCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Items */}
      <div className="space-y-2.5">
        {displayItems.map((item) => {
          const isOverdue = item.daysLeft < 0;
          const isToday = item.daysLeft === 0;
          const isUrgent = item.daysLeft > 0 && item.daysLeft <= 7;

          // Option cycle items get special indigo styling
          const numBg = item.isOptionCycle
            ? (isOverdue || isToday ? 'bg-red-50' : isUrgent ? 'bg-amber-50' : 'bg-indigo-50')
            : item.isClosing
            ? 'bg-gray-50'
            : isOverdue || isToday
            ? 'bg-red-50'
            : isUrgent
            ? 'bg-amber-50' :'bg-blue-50';

          const numColor = item.isOptionCycle
            ? (isOverdue || isToday ? 'text-red-600' : isUrgent ? 'text-amber-600' : 'text-indigo-700')
            : item.isClosing
            ? 'text-gray-500'
            : isOverdue || isToday
            ? 'text-red-600'
            : isUrgent
            ? 'text-amber-600' :'text-blue-600';

          return (
            <div key={item.key} className={`flex items-center gap-3 py-2 border-b border-gray-50 last:border-0 ${item.isOptionCycle ? 'bg-indigo-50/30 rounded-lg px-2 -mx-2' : ''}`}>
              {/* Days counter */}
              <div className={`w-10 h-10 rounded-lg flex flex-col items-center justify-center flex-shrink-0 ${numBg}`}>
                {item.isClosing ? (
                  <Icon name="HomeModernIcon" size={16} className={numColor} />
                ) : isOverdue ? (
                  <Icon name="ExclamationTriangleIcon" size={16} className={numColor} />
                ) : isToday ? (
                  <span className={`text-base font-display font-800 leading-none ${numColor}`}>!</span>
                ) : (
                  <>
                    <span className={`text-sm font-display font-800 tabular-nums leading-none ${numColor}`}>{item.daysLeft}</span>
                    <span className={`text-[8px] font-700 uppercase tracking-wide ${numColor}`}>days</span>
                  </>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className={`text-xs font-display font-700 truncate ${item.isActionRequired ? 'text-gray-900' : 'text-gray-600'}`}>
                    {item.title}
                  </p>
                  {item.isOptionCycle && (
                    <span className="text-[9px] font-display font-700 px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 flex-shrink-0">
                      Option
                    </span>
                  )}
                  {item.isActionRequired && !item.isOptionCycle && (
                    <span className="text-[9px] font-display font-700 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 flex-shrink-0">
                      Action
                    </span>
                  )}
                </div>
                {item.deal_display_name && (
                  <p className="text-[10px] text-gray-400 truncate mt-0.5">{item.deal_display_name}</p>
                )}
                <p className={`text-[10px] mt-0.5 ${item.isOptionCycle ? 'text-indigo-600 font-600' : 'text-gray-400'}`}>
                  {item.isOptionCycle && item.optionCutoffDisplay
                    ? item.optionCutoffDisplay
                    : formatDateShort(item.due_date)}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* CTA */}
      <div className="mt-4 pt-3 border-t border-gray-50">
        <Link
          href="/deadlines"
          className="flex items-center justify-center gap-1.5 w-full py-2 text-xs font-display font-600 text-eb-green-700 hover:text-eb-green-900 hover:bg-eb-green-50 rounded-xl transition-all"
        >
          View Deadlines
          <Icon name="ArrowRightIcon" size={12} />
        </Link>
      </div>
    </div>
  );
}
