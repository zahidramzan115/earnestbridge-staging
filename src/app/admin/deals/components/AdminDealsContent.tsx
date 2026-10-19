'use client';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
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
  emd_funded_cents?: number | null;
  due_diligence_days?: number | null;
  eb_assigned_owner?: string | null;
  primary_contact_id?: string | null;
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
  crm_contacts?: { id: string; portal_link_status: string | null } | null;
  crm_deal_contacts?: { contact_id: string }[] | null;
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
// Active / non-terminal pipeline Deals (same predicate as CRM Deals "Active Deals"):
// approved, in_progress, funded. 'closed' and 'rejected' are terminal; 'application'
// and 'under_review' are pre-deal intake.
const ACTIVE_PIPELINE_STATUSES: AppStatus[] = ['approved', 'in_progress', 'funded'];
// Requested EMD Pipeline stages (independent of Active Deals): unfunded upcoming EMD demand.
// Sourced from the full non-purged Deal list, NOT from activeDeals.
const REQUESTED_EMD_PIPELINE_STATUSES: AppStatus[] = ['application', 'under_review', 'approved', 'in_progress'];

const OWNER_OPTIONS = ['All', 'Dan', 'Tucker', 'Eric', 'Unassigned'];
const PORTAL_FILTERS: { label: string; value: string }[] = [
  { label: 'All Portal / CRM', value: 'all' },
  { label: 'Portal Linked', value: 'has_portal' },
  { label: 'No Portal', value: 'no_portal' },
  { label: 'No CRM Contact', value: 'no_contact' },
];

function hasNoCrmContact(d: BorrowerApplication): boolean {
  return !d.primary_contact_id && (!d.crm_deal_contacts || d.crm_deal_contacts.length === 0);
}

function isFundedEmd(d: BorrowerApplication): boolean {
  return d.emd_funded_cents != null && d.emd_funded_cents > 0;
}

function getTodayETDateStr(offsetDays = 0): string {
  const base = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const y = parts.find(p => p.type === 'year')?.value ?? '';
  const m = parts.find(p => p.type === 'month')?.value ?? '';
  const d = parts.find(p => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${d}`;
}

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
  const [ownerFilter, setOwnerFilter] = useState<string>('All');
  const [portalFilter, setPortalFilter] = useState<string>('all');
  const [hardDateDealIds, setHardDateDealIds] = useState<Set<string>>(new Set());
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { isSuperAdmin } = useAuth();
  const canPurge = isSuperAdmin();
  const [purgeTargetId, setPurgeTargetId] = useState<string | null>(null);
  const [purgeReason, setPurgeReason] = useState('');
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const purgeLockRef = useRef(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 6000);
  }, []);

  const fetchDeals = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('borrower_applications')
        .select('*, crm_contacts:primary_contact_id(id, portal_link_status), crm_deal_contacts(contact_id)')
        .is('purged_at', null)
        .order('submitted_at', { ascending: false });

      if (error) {
        console.error('Error fetching deals:', error);
        setDeals([]);
        setHardDateDealIds(new Set());
      } else {
        const rows = (data as unknown as BorrowerApplication[]) || [];
        setDeals(rows);

        // Hard dates ≤ 7 days: active option cycle (crm_deal_option_cycles) for funded active Deals
        const fundedActiveIds = rows
          .filter(d => ACTIVE_PIPELINE_STATUSES.includes(d.app_status) && isFundedEmd(d))
          .map(d => d.id);
        if (fundedActiveIds.length > 0) {
          const today = getTodayETDateStr(0);
          const horizon = getTodayETDateStr(7);
          const { data: cycles, error: cycleError } = await supabase
            .from('crm_deal_option_cycles')
            .select('application_id, deposit_goes_hard_date')
            .in('application_id', fundedActiveIds)
            .eq('status', 'active')
            .gte('deposit_goes_hard_date', today)
            .lte('deposit_goes_hard_date', horizon);
          if (cycleError) {
            console.error('Error fetching option cycles:', cycleError);
            setHardDateDealIds(new Set());
          } else {
            setHardDateDealIds(new Set((cycles || []).map((c: { application_id: string }) => c.application_id)));
          }
        } else {
          setHardDateDealIds(new Set());
        }
      }
    } catch (err) {
      console.error('Unexpected error fetching deals:', err);
      setDeals([]);
      setHardDateDealIds(new Set());
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

  const closePurgeDialog = () => {
    if (purgeLockRef.current) return;
    setPurgeTargetId(null);
    setPurgeReason('');
    setPurgeConfirmText('');
    setPurgeError(null);
  };

  const handlePurgeDeal = async () => {
    if (purgeLockRef.current) return;
    if (!purgeTargetId) return;
    const reason = purgeReason.trim();
    if (!reason || purgeConfirmText !== 'PURGE') return;
    purgeLockRef.current = true;
    const idToPurge = purgeTargetId;
    setPurging(true);
    setPurgeError(null);
    try {
      const res = await fetch(`/api/admin/deals/${idToPurge}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purge_reason: reason }),
      });
      if (res.ok) {
        setDeals(prev => prev.filter(d => d.id !== idToPurge));
        setPurgeTargetId(null);
        setPurgeReason('');
        setPurgeConfirmText('');
        showToast('success', 'Deal purged. It is now hidden from Admin and Client views.');
      } else if (res.status === 401) {
        setPurgeError('Your session has expired. Please sign in again.');
      } else if (res.status === 403) {
        setPurgeError('Only a SuperAdmin can purge a Deal.');
      } else if (res.status === 404) {
        setDeals(prev => prev.filter(d => d.id !== idToPurge));
        setPurgeTargetId(null);
        setPurgeReason('');
        setPurgeConfirmText('');
        showToast('error', 'Deal not found. It may already have been removed.');
      } else if (res.status === 400) {
        const j = await res.json().catch(() => null);
        setPurgeError(j?.error || 'Invalid request.');
      } else {
        setPurgeError('The purge could not be confirmed. Please refresh the list to check the Deal status before retrying.');
      }
    } catch {
      setPurgeError('A network error occurred. The purge may or may not have completed. Please refresh the list before retrying.');
    } finally {
      purgeLockRef.current = false;
      setPurging(false);
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
    if (ownerFilter !== 'All') {
      data = data.filter(d => (d.eb_assigned_owner || 'Unassigned') === ownerFilter);
    }
    if (portalFilter === 'has_portal') data = data.filter(d => d.crm_contacts?.portal_link_status === 'approved');
    else if (portalFilter === 'no_portal') data = data.filter(d => !d.crm_contacts || d.crm_contacts.portal_link_status === 'none');
    else if (portalFilter === 'no_contact') data = data.filter(d => hasNoCrmContact(d));
    return data;
  }, [deals, filterValue, searchQuery, ownerFilter, portalFilter]);

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

  const activeDeals = useMemo(() => deals.filter(d => ACTIVE_PIPELINE_STATUSES.includes(d.app_status)), [deals]);
  const unfundedActive = useMemo(
    () => deals.filter(d => REQUESTED_EMD_PIPELINE_STATUSES.includes(d.app_status) && !isFundedEmd(d)),
    [deals]
  );
  const fundedActive = useMemo(() => activeDeals.filter(d => isFundedEmd(d)), [activeDeals]);
  // deposit_amount is stored in DOLLARS
  const requestedPipeline = useMemo(() => unfundedActive.reduce((s, d) => s + (d.deposit_amount ?? 0), 0), [unfundedActive]);
  // emd_funded_cents is stored in CENTS → convert to dollars
  const actualFundedTotal = useMemo(() => fundedActive.reduce((s, d) => s + (d.emd_funded_cents ?? 0), 0) / 100, [fundedActive]);
  const hardDateCount = useMemo(() => fundedActive.filter(d => hardDateDealIds.has(d.id)).length, [fundedActive, hardDateDealIds]);

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
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Active Deals</p>
          <p className="text-2xl font-display font-700 text-gray-900">{activeDeals.length}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">Approved · In Progress · Funded</p>
        </div>
        <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Requested EMD Pipeline</p>
          <p className="text-xl font-display font-700 text-amber-700">{formatCurrency(requestedPipeline)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{unfundedActive.length} unfunded Deal{unfundedActive.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Actual EMD Funded</p>
          <p className="text-xl font-display font-700 text-emerald-700">{formatCurrency(actualFundedTotal)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{fundedActive.length} funded Deal{fundedActive.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Hard Dates ≤ 7 Days</p>
          <p className={`text-2xl font-display font-700 ${hardDateCount > 0 ? 'text-red-600' : 'text-gray-900'}`}>{hardDateCount}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">Funded Deals · Deposit Goes Hard</p>
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
          <select
            value={ownerFilter}
            onChange={e => setOwnerFilter(e.target.value)}
            aria-label="Filter by owner"
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none bg-white text-gray-700 focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          >
            {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o === 'All' ? 'All Owners' : o}</option>)}
          </select>
          <select
            value={portalFilter}
            onChange={e => setPortalFilter(e.target.value)}
            aria-label="Filter by portal or CRM status"
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none bg-white text-gray-700 focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          >
            {PORTAL_FILTERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div className="px-4 pt-3 flex flex-wrap gap-1.5">
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
        <div className="pb-3 border-b border-gray-100" />

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
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Requested EMD</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Actual EMD Funded</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">DD</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Stage</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Funding Conditions</th>
                  <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wider">Actions</th>
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
                              {hasNoCrmContact(deal) && (
                                <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-600 bg-red-50 text-red-600 border border-red-100">
                                  No CRM Contact
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="text-gray-700 max-w-[160px] truncate">{deal.property_address || '—'}</p>
                          <p className="text-xs text-gray-400">{deal.property_type || '—'}</p>
                          <p className="text-[11px] text-gray-400 tabular-nums">Purchase Price: {formatCurrency(deal.purchase_price)}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="font-600 text-amber-700 tabular-nums whitespace-nowrap">{formatCurrency(deal.deposit_amount)}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          {isFundedEmd(deal) ? (
                            <p className="font-600 text-emerald-700 tabular-nums whitespace-nowrap">{formatCurrency((deal.emd_funded_cents ?? 0) / 100)}</p>
                          ) : (
                            <p className="text-gray-400" title="Not funded">—</p>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="text-sm font-600 whitespace-nowrap text-gray-700">
                            {deal.due_diligence_days != null ? `${deal.due_diligence_days} ${deal.due_diligence_days === 1 ? 'day' : 'days'}` : '—'}
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
                            {canPurge && (
                              <button
                                onClick={() => setPurgeTargetId(deal.id)}
                                title="Purge deal"
                                className="flex items-center gap-1 text-xs font-600 text-red-500 hover:text-red-700 whitespace-nowrap disabled:opacity-40"
                              >
                                <Icon name="TrashIcon" size={12} />
                                Purge Deal
                              </button>
                            )}
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
          <p className="text-xs text-gray-400">Requested EMD Pipeline: <span className="font-600 text-gray-600">{formatCurrency(requestedPipeline)}</span></p>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-xl shadow-lg text-sm font-medium border ${
            toast.type === 'success' ?'bg-emerald-50 text-emerald-800 border-emerald-200' :'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          {toast.message}
        </div>
      )}

      {canPurge && purgeTargetId !== null && (() => {
        const target = deals.find(d => d.id === purgeTargetId);
        const canSubmit = !purging && purgeReason.trim().length > 0 && purgeConfirmText === 'PURGE';
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={closePurgeDialog} />
            <div className="relative bg-white rounded-2xl shadow-modal w-full max-w-md p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-red-100">
                  <Icon name="ExclamationTriangleIcon" size={20} className="text-red-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-display font-700 text-gray-900 text-base">Purge Deal</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    {target ? `Deal: ${target.first_name} ${target.last_name}${target.property_address ? ` — ${target.property_address}` : ''}. ` : ''}
                    This hides the Deal from Admin and Client views but preserves its database history. Recovery can be added later.
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label htmlFor="purge-reason" className="block text-xs font-600 text-gray-700 mb-1">Purge reason (required)</label>
                  <textarea
                    id="purge-reason"
                    value={purgeReason}
                    onChange={e => setPurgeReason(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    disabled={purging}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
                  />
                </div>
                <div>
                  <label htmlFor="purge-confirm" className="block text-xs font-600 text-gray-700 mb-1">
                    Type <span className="font-mono font-700">PURGE</span> to confirm
                  </label>
                  <input
                    id="purge-confirm"
                    type="text"
                    value={purgeConfirmText}
                    onChange={e => setPurgeConfirmText(e.target.value)}
                    disabled={purging}
                    autoComplete="off"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
                  />
                </div>
                {purgeError && <p className="text-sm text-red-600" role="alert">{purgeError}</p>}
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={closePurgeDialog}
                  disabled={purging}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePurgeDeal}
                  disabled={!canSubmit}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {purging ? 'Purging…' : 'Purge Deal'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <CreateDealModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => { fetchDeals(); }}
      />
    </div>
  );
}
