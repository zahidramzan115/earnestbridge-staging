'use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';
import ConfirmModal from '@/components/ui/ConfirmModal';
import CreateDealModal from './CreateDealModal';

type AppStatus = 'application' | 'under_review' | 'approved' | 'in_progress' | 'funded' | 'closed' | 'rejected';

interface BorrowerApplication {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_name: string | null;
  property_address: string | null;
  property_type: string | null;
  purchase_price: number | null;
  deposit_amount: number | null;
  due_diligence_days?: number | null;
  app_status: AppStatus;
  submitted_at: string | null;
  created_at: string;
  identity_verified: boolean;
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

const ALL_STATUSES: AppStatus[] = ['application', 'under_review', 'approved', 'in_progress', 'funded', 'closed', 'rejected'];

// ─── 6-Stage Deal Flow ────────────────────────────────────────────────────────

const DEAL_STEPS = [
  { step: 1,  key: 'application',   label: 'Application',   group: 'application' },
  { step: 2,  key: 'under_review',  label: 'Under Review',  group: 'application' },
  { step: 3,  key: 'approved',      label: 'Approved',      group: 'deal' },
  { step: 4,  key: 'in_progress',   label: 'In Progress',   group: 'deal' },
  { step: 5,  key: 'funded',        label: 'Funded',        group: 'deal' },
  { step: 6,  key: 'closed',        label: 'Closed',        group: 'deal' },
];

const FUNDING_CONDITIONS = [
  { key: 'w9_signed',               label: 'W-9' },
  { key: 'mou_signed',              label: 'MOU' },
  { key: 'option_agreement_signed', label: 'Option Agmt' },
  { key: 'llc_formed',              label: 'LLC' },
  { key: 'psa_signed',              label: 'PSA' },
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

const STATUS_FILTERS: { label: string; value: AppStatus | 'all' | 'application' | 'active' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Application', value: 'application' },
  { label: 'Under Review', value: 'under_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Funded', value: 'funded' },
  { label: 'Closed', value: 'closed' },
  { label: 'Rejected', value: 'rejected' },
];

const APPLICATION_STATUSES: AppStatus[] = ['application', 'under_review', 'rejected'];
const DEAL_STATUSES: AppStatus[] = ['approved', 'in_progress', 'funded', 'closed'];

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getDaysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function getWorkflowStep(deal: BorrowerApplication): number {
  return deal.deal_workflow_stage ?? 0;
}

function WorkflowStageSelector({
  deal,
  onUpdate,
  disabled,
}: {
  deal: BorrowerApplication;
  onUpdate: (id: string, newStage: number, newStatus: AppStatus) => void;
  disabled: boolean;
}) {
  const currentStep = deal.deal_workflow_stage ?? 0;

  const stageToStatus = (stage: number): AppStatus => {
    const map: Record<number, AppStatus> = {
      1: 'application',
      2: 'under_review',
      3: 'approved',
      4: 'in_progress',
      5: 'funded',
      6: 'closed',
    };
    return map[stage] ?? deal.app_status;
  };

  return (
    <select
      value={currentStep}
      disabled={disabled}
      onChange={e => {
        const newStage = Number(e.target.value);
        onUpdate(deal.id, newStage, stageToStatus(newStage));
      }}
      className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white text-gray-700 outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 disabled:opacity-50"
    >
      {DEAL_STEPS.map(s => (
        <option key={s.key} value={s.step}>
          {s.step}. {s.label}
        </option>
      ))}
    </select>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AdminDealsContent() {
  const supabase = useMemo(() => createClient(), []);
  const [deals, setDeals] = useState<BorrowerApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterValue, setFilterValue] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchDeals = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('borrower_applications')
        .select('*')
        .order('submitted_at', { ascending: false });

      if (error) {
        console.error('Error fetching deals:', error);
        setDeals([]);
      } else {
        setDeals((data as BorrowerApplication[]) || []);
      }
    } catch (err) {
      console.error('Unexpected error fetching deals:', err);
      setDeals([]);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => { fetchDeals(); }, [fetchDeals]);

  const handleWorkflowUpdate = async (id: string, newStage: number, newStatus: AppStatus) => {
    setUpdatingId(id);
    try {
      const { error } = await supabase
        .from('borrower_applications')
        .update({ deal_workflow_stage: newStage, app_status: newStatus })
        .eq('id', id);
      if (!error) {
        setDeals(prev => prev.map(d => d.id === id ? { ...d, deal_workflow_stage: newStage, app_status: newStatus } : d));

        // ── Fire transactional email on key stage transitions ──────────────────
        const EMAIL_STAGES: AppStatus[] = ['application', 'under_review', 'approved', 'funded'];
        if (EMAIL_STAGES.includes(newStatus)) {
          const deal = deals.find(d => d.id === id);
          if (deal?.email) {
            // Fire-and-forget — never block the UI
            fetch('/api/send-status-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                borrowerEmail: deal.email,
                borrowerFirstName: deal.first_name,
                borrowerLastName: deal.last_name,
                newStatus,
                propertyAddress: deal.property_address ?? '',
                milestoneLabel: DEAL_STEPS.find(s => s.key === newStatus)?.label ?? '',
              }),
            }).catch(() => { /* non-fatal */ });
          }
        }
      }
    } catch { /* silent */ } finally {
      setUpdatingId(null);
    }
  };

  const handleConditionToggle = async (id: string, field: string, current: boolean) => {
    setUpdatingId(id);
    try {
      const { error } = await supabase
        .from('borrower_applications')
        .update({ [field]: !current })
        .eq('id', id);
      if (!error) {
        setDeals(prev => prev.map(d => d.id === id ? { ...d, [field]: !current } : d));
      }
    } catch { /* silent */ } finally {
      setUpdatingId(null);
    }
  };

  const handleDeleteDeal = async () => {
    if (!confirmDeleteId) return;
    const idToDelete = confirmDeleteId;
    setDeletingId(idToDelete);
    setConfirmDeleteId(null);
    try {
      const { error } = await supabase
        .from('borrower_applications')
        .delete()
        .eq('id', idToDelete);
      if (!error) {
        setDeals(prev => prev.filter(d => d.id !== idToDelete));
      }
    } catch { /* silent */ } finally {
      setDeletingId(null);
    }
  };

  const filtered = useMemo(() => {
    let data = [...deals];
    if (filterValue === 'application') data = data.filter(d => APPLICATION_STATUSES.includes(d.app_status));
    else if (filterValue === 'funded') data = data.filter(d => d.app_status === 'funded');
    else if (filterValue === 'closed') data = data.filter(d => d.app_status === 'closed');
    else if (filterValue === 'rejected') data = data.filter(d => d.app_status === 'rejected');
    else if (filterValue !== 'all') data = data.filter(d => d.app_status === filterValue);

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      data = data.filter(d =>
        `${d.first_name} ${d.last_name}`.toLowerCase().includes(q) ||
        (d.email || '').toLowerCase().includes(q) ||
        (d.property_address || '').toLowerCase().includes(q) ||
        (d.company_name || '').toLowerCase().includes(q)
      );
    }
    return data;
  }, [deals, filterValue, searchQuery]);

  const counts = useMemo(() => ({
    all: deals.length,
    application: deals.filter(d => APPLICATION_STATUSES.includes(d.app_status)).length,
    under_review: deals.filter(d => d.app_status === 'under_review').length,
    approved: deals.filter(d => d.app_status === 'approved').length,
    in_progress: deals.filter(d => d.app_status === 'in_progress').length,
    funded: deals.filter(d => d.app_status === 'funded').length,
    closed: deals.filter(d => d.app_status === 'closed').length,
    rejected: deals.filter(d => d.app_status === 'rejected').length,
  }), [deals]);

  const totalValue = useMemo(() => deals.filter(d => DEAL_STATUSES.includes(d.app_status)).reduce((s, d) => s + (d.purchase_price ?? 0), 0), [deals]);
  const totalEMD = useMemo(() => deals.filter(d => DEAL_STATUSES.includes(d.app_status)).reduce((s, d) => s + (d.deposit_amount ?? 0), 0), [deals]);

  if (loading) {
    return (
      <div className="p-6 lg:p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-100 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-eb-green-100 flex items-center justify-center">
            <Icon name="BriefcaseIcon" size={18} className="text-eb-green-900" />
          </div>
          <div>
            <h1 className="text-xl font-display font-700 text-gray-900">Deals</h1>
            <p className="text-sm text-gray-500">Manage all deals from application to funding</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-eb-green-900 text-white text-sm font-display font-600 rounded-xl hover:bg-eb-green-800 transition-all shadow-sm"
        >
          <Icon name="PlusIcon" size={15} />
          Create Deal for Client
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Total Deals</p>
          <p className="text-2xl font-display font-700 text-gray-900">{deals.length}</p>
        </div>
        <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Applications</p>
          <p className="text-2xl font-display font-700 text-blue-700">{counts.application}</p>
        </div>
        <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Pipeline Value</p>
          <p className="text-xl font-display font-700 text-gray-900">{formatCurrency(totalValue)}</p>
        </div>
        <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Total EMD</p>
          <p className="text-xl font-display font-700 text-emerald-700">{formatCurrency(totalEMD)}</p>
        </div>
      </div>

      {/* Filters + Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
        <div className="p-4 border-b border-gray-100 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name, email, or address..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => setFilterValue(f.value)}
                className={`px-3 py-1.5 text-xs font-display font-600 rounded-full border transition-all ${
                  filterValue === f.value
                    ? 'bg-eb-green-900 text-white border-eb-green-900' :'bg-white text-gray-600 border-gray-200 hover:border-eb-green-900/40 hover:text-eb-green-900'
                }`}
              >
                {f.label}
                <span className="ml-1 opacity-60">({counts[f.value as keyof typeof counts] ?? 0})</span>
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <div className="w-12 h-12 rounded-2xl bg-eb-green-50 flex items-center justify-center mx-auto mb-3">
              <Icon name="BriefcaseIcon" size={22} className="text-eb-green-400" />
            </div>
            <p className="text-gray-500 font-medium">No deals found</p>
            <p className="text-sm text-gray-400 mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Borrower</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Property</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Value</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Due Diligence Period</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Stage / Status</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Funding Conditions</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(deal => {
                  const cfg = STATUS_CONFIG[deal.app_status] ?? STATUS_CONFIG.application;
                  const isActiveDeal = DEAL_STATUSES.includes(deal.app_status);
                  const currentStep = getWorkflowStep(deal);
                  const conditions = FUNDING_CONDITIONS.map(c => ({ ...c, met: !!(deal as Record<string, unknown>)[c.key] }));
                  const metCount = conditions.filter(c => c.met).length;

                  return (
                    <React.Fragment key={deal.id}>
                      <tr className={`hover:bg-gray-50/50 transition-colors group`}>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isActiveDeal ? 'bg-eb-green-100' : 'bg-gray-100'}`}>
                              <span className={`text-xs font-700 ${isActiveDeal ? 'text-eb-green-800' : 'text-gray-600'}`}>
                                {deal.first_name[0]}{deal.last_name[0]}
                              </span>
                            </div>
                            <div>
                              <p className="font-600 text-gray-900">{deal.first_name} {deal.last_name}</p>
                              <p className="text-xs text-gray-400">{deal.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="text-gray-700 max-w-[160px] truncate">{deal.property_address || '—'}</p>
                          <p className="text-xs text-gray-400">{deal.property_type || '—'}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="font-600 text-gray-900 tabular-nums">{formatCurrency(deal.purchase_price)}</p>
                          <p className="text-xs text-gray-400 tabular-nums">EMD: {formatCurrency(deal.deposit_amount)}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="text-sm font-600 whitespace-nowrap text-gray-700">
                            {deal.due_diligence_days != null ? `${deal.due_diligence_days} ${deal.due_diligence_days === 1 ? 'Day' : 'Days'}` : '—'}
                          </p>
                        </td>
                        <td className="px-4 py-3.5">
                          <WorkflowStageSelector
                            deal={deal}
                            onUpdate={handleWorkflowUpdate}
                            disabled={updatingId === deal.id}
                          />
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-display font-700 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                              <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={9} />
                              {cfg.label}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          {isActiveDeal ? (
                            <div>
                              <div className="flex flex-wrap gap-1">
                                {conditions.map(c => (
                                  <button
                                    key={c.key}
                                    disabled={updatingId === deal.id}
                                    onClick={() => handleConditionToggle(deal.id, c.key, c.met)}
                                    title={`Toggle ${c.label}`}
                                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-display font-700 border transition-all ${
                                      c.met
                                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' :'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'
                                    }`}
                                  >
                                    <Icon name={c.met ? 'CheckIcon' : 'MinusIcon'} size={8} />
                                    {c.label}
                                  </button>
                                ))}
                              </div>
                              <p className={`text-[10px] mt-1 font-600 ${metCount === conditions.length ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {metCount}/{conditions.length} met
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400 italic">N/A</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-all">
                            <Link
                              href={`/admin/borrower/${deal.user_id}/application/${deal.id}`}
                              className="flex items-center gap-1 text-xs font-600 text-eb-green-900 hover:text-eb-green-700 whitespace-nowrap"
                            >
                              View <Icon name="ArrowRightIcon" size={12} />
                            </Link>
                            <button
                              onClick={() => setConfirmDeleteId(deal.id)}
                              disabled={deletingId === deal.id}
                              title="Delete deal"
                              className="flex items-center gap-1 text-xs font-600 text-red-500 hover:text-red-700 whitespace-nowrap disabled:opacity-40"
                            >
                              <Icon name="TrashIcon" size={12} />
                              {deletingId === deal.id ? 'Deleting…' : 'Delete'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
          <p className="text-xs text-gray-400">{filtered.length} deal{filtered.length !== 1 ? 's' : ''}</p>
          <p className="text-xs text-gray-400">Pipeline: <span className="font-600 text-gray-600">{formatCurrency(totalValue)}</span></p>
        </div>
      </div>

      <ConfirmModal
        open={confirmDeleteId !== null}
        title="Delete Deal"
        message={(() => {
          const deal = deals.find(d => d.id === confirmDeleteId);
          return deal
            ? `Are you sure you want to permanently delete the deal for ${deal.first_name} ${deal.last_name}? This action cannot be undone and all associated data will be lost forever.`
            : 'Are you sure you want to permanently delete this deal? This action cannot be undone.';
        })()}
        confirmLabel="Yes, Delete Forever"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleDeleteDeal}
        onCancel={() => setConfirmDeleteId(null)}
      />

      <CreateDealModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => { fetchDeals(); }}
      />
    </div>
  );
}
