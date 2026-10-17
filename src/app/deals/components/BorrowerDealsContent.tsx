'use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';

// All statuses — applications are step 1-2, deals are step 3+
const ALL_STATUSES = ['application', 'under_review', 'approved', 'in_progress', 'funded', 'closed', 'rejected'];

interface Deal {
  id: string;
  company_name: string | null;
  property_address: string | null;
  property_type: string | null;
  purchase_price: number | null;
  deposit_amount: number | null;
  due_diligence_days?: number | null;
  app_status: string;
  submitted_at: string | null;
  created_at: string;
  days_to_funding?: number | null;
  deal_workflow_stage?: number | null;
  w9_signed?: boolean;
  mou_signed?: boolean;
  option_agreement_signed?: boolean;
  psa_signed?: boolean;
  llc_formed?: boolean;
  escrow_funded?: boolean;
  option_exercised?: boolean;
}

// ─── 6-Stage Deal Flow ────────────────────────────────────────────────────────

const DEAL_STEPS = [
  { step: 1,  key: 'application',   label: 'Application',   icon: 'DocumentTextIcon',    description: 'You have submitted your application. EarnestBridge will review it shortly.',                                group: 'application' },
  { step: 2,  key: 'under_review',  label: 'Under Review',  icon: 'MagnifyingGlassIcon', description: 'EarnestBridge is reviewing your application details.',                                                      group: 'application' },
  { step: 3,  key: 'approved',      label: 'Approved',      icon: 'CheckCircleIcon',     description: 'Your application has been approved. Documents are being prepared for your review.',                         group: 'deal' },
  { step: 4,  key: 'in_progress',   label: 'In Progress',   icon: 'ArrowPathIcon',       description: 'Your deal is actively in progress. PSA review, LLC formation, and document exchanges are underway.',       group: 'deal' },
  { step: 5,  key: 'funded',        label: 'Funded',        icon: 'BanknotesIcon',       description: 'Your EMD has been transferred to escrow. Congratulations!',                                                 group: 'deal' },
  { step: 6,  key: 'closed',        label: 'Closed',        icon: 'CheckBadgeIcon',      description: 'The option agreement has been exercised and the deal is complete.',                                         group: 'deal' },
];

const FUNDING_CONDITIONS = [
  { key: 'w9_signed',                label: 'W-9 Signed',                icon: 'DocumentCheckIcon' },
  { key: 'mou_signed',               label: 'MOU Signed',                icon: 'PencilSquareIcon' },
  { key: 'option_agreement_signed',  label: 'Option Agreement Signed',   icon: 'ClipboardDocumentCheckIcon' },
  { key: 'llc_formed',               label: 'LLC Formed',                icon: 'BuildingOfficeIcon' },
  { key: 'psa_signed',               label: 'PSA Signed',                icon: 'DocumentTextIcon' },
];

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; icon: string }> = {
  application:  { label: 'Application',  color: 'text-gray-600',    bg: 'bg-gray-100',    border: 'border-gray-200',    icon: 'DocumentTextIcon' },
  under_review: { label: 'Under Review', color: 'text-amber-700',   bg: 'bg-amber-100',   border: 'border-amber-200',   icon: 'MagnifyingGlassIcon' },
  approved:     { label: 'Approved',     color: 'text-green-700',   bg: 'bg-green-100',   border: 'border-green-200',   icon: 'CheckCircleIcon' },
  in_progress:  { label: 'In Progress',  color: 'text-blue-700',    bg: 'bg-blue-100',    border: 'border-blue-200',    icon: 'ArrowPathIcon' },
  funded:       { label: 'Funded',       color: 'text-emerald-700', bg: 'bg-emerald-100', border: 'border-emerald-200', icon: 'BanknotesIcon' },
  closed:       { label: 'Closed',       color: 'text-gray-700',    bg: 'bg-gray-200',    border: 'border-gray-300',    icon: 'LockClosedIcon' },
  rejected:     { label: 'Rejected',     color: 'text-red-700',     bg: 'bg-red-100',     border: 'border-red-200',     icon: 'XCircleIcon' },
};

const STATUS_FILTERS = [
  { label: 'All Deals', value: 'all' },
  { label: 'Application', value: 'application' },
  { label: 'Active', value: 'active' },
  { label: 'Funded', value: 'funded' },
  { label: 'Closed', value: 'closed' },
];

function getWorkflowStep(deal: Deal): number {
  const stage = deal.deal_workflow_stage;
  if (stage != null && stage > 0) return stage;
  const map: Record<string, number> = {
    application: 1,
    under_review: 2,
    approved: 3,
    in_progress: 4,
    funded: 5,
    closed: 6,
    rejected: 0,
  };
  return map[deal.app_status] ?? 0;
}

function isApplicationStatus(status: string) {
  return ['application', 'under_review', 'rejected'].includes(status);
}

function isDealStatus(status: string) {
  return ['approved', 'in_progress', 'funded', 'closed'].includes(status);
}

function formatCurrency(val: number | null) {
  if (val == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('T')[0].split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

// ─── Mini Stepper for card ────────────────────────────────────────────────────

function MiniWorkflowStepper({ deal }: { deal: Deal }) {
  const currentStep = getWorkflowStep(deal);
  const totalSteps = DEAL_STEPS.length;
  // Clamp to valid range 0–totalSteps
  const clampedStep = Math.max(0, Math.min(currentStep, totalSteps));
  const pct = Math.round((clampedStep / totalSteps) * 100);
  const currentStepInfo = DEAL_STEPS[clampedStep - 1] ?? DEAL_STEPS[0];

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-display font-600 text-gray-500 uppercase tracking-wide">
          Step {clampedStep} of {totalSteps}
        </span>
        <span className="text-[11px] font-display font-700 text-eb-green-900">{pct}% complete</span>
      </div>
      <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden mb-1.5">
        <div
          className="h-full bg-gradient-to-r from-eb-green-700 to-emerald-500 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] text-gray-500">
        Current: <span className="font-600 text-eb-green-900">{currentStepInfo.label}</span>
      </p>
    </div>
  );
}

// ─── Funding Conditions ───────────────────────────────────────────────────────

function FundingConditionsPanel({ deal }: { deal: Deal }) {
  const conditions = FUNDING_CONDITIONS.map(c => ({
    ...c,
    met: !!(deal as Record<string, unknown>)[c.key],
  }));
  const metCount = conditions.filter(c => c.met).length;

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-display font-600 text-gray-500 uppercase tracking-wide">Funding Conditions</span>
        <span className={`text-[11px] font-700 ${metCount === conditions.length ? 'text-emerald-600' : 'text-amber-600'}`}>
          {metCount}/{conditions.length} met
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {conditions.map(c => (
          <span
            key={c.key}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-display font-700 border ${
              c.met
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :'bg-gray-50 text-gray-400 border-gray-200'
            }`}
          >
            <Icon name={c.met ? 'CheckIcon' : 'MinusIcon'} size={9} />
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function BorrowerDealsContent() {
  const { user, loading: authLoading } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterGroup, setFilterGroup] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchDeals = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    try {
      // The RLS policy handles security: users see deals where user_id matches
      // OR where their approved CRM contact is explicitly associated.
      // We query without user_id filter to let RLS enforce visibility.
      const { data, error } = await supabase
        .from('borrower_applications')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && data) {
        setDeals(data as Deal[]);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    if (!authLoading) fetchDeals();
  }, [fetchDeals, authLoading]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('borrower-deals-unified-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'borrower_applications', filter: `user_id=eq.${user.id}` }, fetchDeals)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, supabase, fetchDeals]);

  const filtered = useMemo(() => {
    let data = [...deals];
    if (filterGroup === 'application') data = data.filter(d => isApplicationStatus(d.app_status));
    else if (filterGroup === 'active') data = data.filter(d => ['approved', 'in_progress'].includes(d.app_status));
    else if (filterGroup === 'funded') data = data.filter(d => d.app_status === 'funded');
    else if (filterGroup === 'closed') data = data.filter(d => d.app_status === 'closed');
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      data = data.filter(d =>
        (d.company_name || '').toLowerCase().includes(q) ||
        (d.property_address || '').toLowerCase().includes(q)
      );
    }
    return data;
  }, [deals, filterGroup, searchQuery]);

  const counts = useMemo(() => ({
    all: deals.length,
    application: deals.filter(d => isApplicationStatus(d.app_status)).length,
    active: deals.filter(d => ['approved', 'in_progress'].includes(d.app_status)).length,
    funded: deals.filter(d => d.app_status === 'funded').length,
    closed: deals.filter(d => d.app_status === 'closed').length,
  }), [deals]);

  if (loading || authLoading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse space-y-3">
          <div className="h-8 bg-gray-200 rounded w-48" />
          {[1,2,3].map(i => <div key={i} className="h-40 bg-gray-100 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-eb-green-100 flex items-center justify-center">
            <Icon name="BriefcaseIcon" size={18} className="text-eb-green-900" />
          </div>
          <div>
            <h1 className="text-xl font-display font-700 text-gray-900">My Deals</h1>
            <p className="text-sm text-gray-500">Track your deals from application to funding</p>
          </div>
        </div>
        <Link
          href="/apply"
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-display font-700 text-white bg-eb-green-900 rounded-xl hover:bg-eb-green-800 transition-all shadow-sm"
        >
          <Icon name="PlusIcon" size={15} />
          Submit New Deal
        </Link>
      </div>

      {/* KPI strip */}
      {deals.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
            <p className="text-xs text-gray-500 mb-1">Total Deals</p>
            <p className="text-2xl font-display font-700 text-gray-900">{deals.length}</p>
          </div>
          <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
            <p className="text-xs text-gray-500 mb-1">In Progress</p>
            <p className="text-2xl font-display font-700 text-amber-700">{counts.application + counts.active}</p>
          </div>
          <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
            <p className="text-xs text-gray-500 mb-1">Funded</p>
            <p className="text-2xl font-display font-700 text-emerald-700">{counts.funded}</p>
          </div>
          <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
            <p className="text-xs text-gray-500 mb-1">Closed</p>
            <p className="text-2xl font-display font-700 text-gray-700">{counts.closed}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilterGroup(f.value)}
            className={`px-3 py-1.5 text-xs font-display font-600 rounded-full border transition-all ${
              filterGroup === f.value
                ? 'bg-eb-green-900 text-white border-eb-green-900' :'bg-white text-gray-600 border-gray-200 hover:border-eb-green-900/40 hover:text-eb-green-900'
            }`}
          >
            {f.label}
            <span className="ml-1 opacity-60">({counts[f.value as keyof typeof counts] ?? 0})</span>
          </button>
        ))}
        <div className="relative ml-auto">
          <Icon name="MagnifyingGlassIcon" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-full outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all w-40"
          />
        </div>
      </div>

      {/* Deal cards */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 py-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-eb-green-50 flex items-center justify-center mx-auto mb-3">
            <Icon name="BriefcaseIcon" size={22} className="text-eb-green-400" />
          </div>
          <p className="text-gray-600 font-display font-600">No deals found</p>
          {deals.length === 0 ? (
            <>
              <p className="text-sm text-gray-400 mt-1 mb-4">Submit your first deal application to get started.</p>
              <Link href="/apply" className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-display font-700 text-white bg-eb-green-900 rounded-xl hover:bg-eb-green-800 transition-all">
                <Icon name="PlusIcon" size={14} />
                Submit New Deal
              </Link>
            </>
          ) : (
            <p className="text-sm text-gray-400 mt-1">Try adjusting your filters</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(deal => {
            const cfg = STATUS_CONFIG[deal.app_status] ?? STATUS_CONFIG.application;
            const isActiveDeal = isDealStatus(deal.app_status);

            return (
              <div key={deal.id} className={`bg-white rounded-2xl border shadow-sm transition-all ${isActiveDeal ? 'border-eb-green-200' : 'border-gray-100'} hover:shadow-md`}>
                <div className="p-5">
                  <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                    <div className="flex-1 min-w-0">
                      {/* Title row */}
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-display font-700 text-gray-900 truncate">
                              {deal.company_name || deal.property_address || `Deal ${deal.id.slice(0, 6).toUpperCase()}`}
                            </h3>
                            {isActiveDeal && (
                              <span className="flex-shrink-0 text-[10px] font-display font-700 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 px-2 py-0.5 rounded-full uppercase tracking-wide">
                                Active Deal
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 mt-0.5 truncate">{deal.property_address || '—'}</p>
                        </div>
                        <span className={`flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-display font-700 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                          <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                          {cfg.label}
                        </span>
                      </div>

                      {/* Metrics */}
                      <div className="flex flex-wrap gap-4 text-sm mt-2">
                        <div>
                          <span className="text-xs text-gray-400">Purchase Price</span>
                          <p className="font-display font-700 text-gray-900">{formatCurrency(deal.purchase_price)}</p>
                        </div>
                        <div>
                          <span className="text-xs text-gray-400">EMD</span>
                          <p className="font-display font-700 text-gray-900">{formatCurrency(deal.deposit_amount)}</p>
                        </div>
                        <div>
                          <span className="text-xs text-gray-400">Due Diligence Period</span>
                          <p className="font-display font-700 text-gray-900">
                            {deal.due_diligence_days != null ? `${deal.due_diligence_days} ${deal.due_diligence_days === 1 ? 'Day' : 'Days'}` : '—'}
                          </p>
                        </div>
                      </div>

                      {/* Workflow progress */}
                      {deal.app_status !== 'rejected' && (
                        <MiniWorkflowStepper deal={deal} />
                      )}

                      {/* Funding conditions for active deals */}
                      {isActiveDeal && (
                        <FundingConditionsPanel deal={deal} />
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex sm:flex-col gap-2 sm:items-end flex-shrink-0">
                      {isActiveDeal ? (
                        <Link
                          href={`/deals/${deal.id}`}
                          className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-700 text-white bg-eb-green-900 rounded-lg hover:bg-eb-green-800 transition-all whitespace-nowrap"
                        >
                          Manage Deal <Icon name="ArrowRightIcon" size={12} />
                        </Link>
                      ) : (
                        <Link
                          href={`/application-status`}
                          className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-700 text-eb-green-900 bg-eb-green-50 border border-eb-green-200 rounded-lg hover:bg-eb-green-100 transition-all whitespace-nowrap"
                        >
                          View Status <Icon name="ArrowRightIcon" size={12} />
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
