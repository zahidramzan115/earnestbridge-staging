'use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deal {
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
  app_status: string;
  submitted_at: string | null;
  created_at: string;
  eb_assigned_owner: string | null;
  primary_contact_id: string | null;
  crm_company_id: string | null;
  deal_workflow_stage: number | null;
  crm_contacts?: {
    id: string;
    first_name: string;
    last_name: string;
    lead_status: string;
    portal_link_status: string;
  } | null;
  crm_companies?: {
    id: string;
    company_name: string;
  } | null;
  crm_deal_contacts?: {
    contact_id: string;
    role: string;
    crm_contacts: {
      id: string;
      first_name: string;
      last_name: string;
    };
  }[];
}

interface CRMContact {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  phone: string | null;
  lead_status: string;
  portal_link_status: string;
  crm_companies?: { id: string; company_name: string } | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  application:  { label: 'Application',  color: 'text-gray-600',    bg: 'bg-gray-100' },
  under_review: { label: 'Under Review', color: 'text-amber-700',   bg: 'bg-amber-100' },
  approved:     { label: 'Approved',     color: 'text-green-700',   bg: 'bg-green-100' },
  in_progress:  { label: 'In Progress',  color: 'text-blue-700',    bg: 'bg-blue-100' },
  funded:       { label: 'Funded',       color: 'text-emerald-700', bg: 'bg-emerald-100' },
  closed:       { label: 'Closed',       color: 'text-gray-700',    bg: 'bg-gray-200' },
  rejected:     { label: 'Rejected',     color: 'text-red-700',     bg: 'bg-red-100' },
};

const OWNERS = ['All', 'Dan', 'Tucker', 'Eric', 'Unassigned'];
const ALL_STATUSES = ['all', 'application', 'under_review', 'approved', 'in_progress', 'funded', 'closed', 'rejected'];

function formatCurrency(v: number | null) {
  if (!v) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

function formatDate(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function getDaysUntil(d: string | null) {
  if (!d) return null;
  const diff = new Date(d).getTime() - new Date().setHours(0,0,0,0);
  return Math.ceil(diff / 86400000);
}

// ─── Associate Contact Panel ──────────────────────────────────────────────────

function AssociateContactPanel({ deal, onUpdated }: { deal: Deal; onUpdated: () => void }) {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CRMContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [error, setError] = useState('');
  const [dealContacts, setDealContacts] = useState<{ contact_id: string; role: string; crm_contacts: { id: string; first_name: string; last_name: string; primary_email: string; portal_link_status: string } }[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  const loadDealContacts = useCallback(async () => {
    setLoadingContacts(true);
    const { data } = await supabase
      .from('crm_deal_contacts')
      .select('contact_id, role, crm_contacts(id, first_name, last_name, primary_email, portal_link_status)')
      .eq('deal_id', deal.id);
    setDealContacts((data as any) || []);
    setLoadingContacts(false);
  }, [deal.id, supabase]);

  useEffect(() => {
    if (open) loadDealContacts();
  }, [open, loadDealContacts]);

  const searchContacts = async (q: string) => {
    setSearch(q);
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    const { data } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, phone, lead_status, portal_link_status, crm_companies(id, company_name)')
      .eq('is_merged', false)
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,primary_email.ilike.%${q}%`)
      .limit(8);
    setResults((data as CRMContact[]) || []);
    setLoading(false);
  };

  const associate = async (contactId: string, role: 'primary' | 'additional') => {
    setAssociating(true);
    setError('');
    const res = await fetch(`/api/crm/deals/${deal.id}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, role }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || 'Failed to associate contact');
    } else {
      setSearch('');
      setResults([]);
      await loadDealContacts();
      onUpdated();
    }
    setAssociating(false);
  };

  const removeContact = async (contactId: string) => {
    const res = await fetch(`/api/crm/deals/${deal.id}/contacts?contact_id=${contactId}`, { method: 'DELETE' });
    if (res.ok) {
      await loadDealContacts();
      onUpdated();
    }
  };

  const portalBadge = (status: string) => {
    if (status === 'approved') return <span className="px-1.5 py-0.5 rounded text-[9px] font-600 bg-emerald-100 text-emerald-700">Portal Active</span>;
    if (status === 'pending') return <span className="px-1.5 py-0.5 rounded text-[9px] font-600 bg-amber-100 text-amber-700">Portal Pending</span>;
    return <span className="px-1.5 py-0.5 rounded text-[9px] font-600 bg-gray-100 text-gray-500">No Portal</span>;
  };

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-eb-green-700 font-600 hover:underline"
      >
        <Icon name="UserPlusIcon" size={13} />
        {open ? 'Close' : 'Manage CRM Contacts'}
      </button>

      {open && (
        <div className="mt-3 p-4 border border-gray-200 rounded-xl space-y-4 bg-gray-50">
          {/* Current contacts */}
          <div>
            <p className="text-xs font-700 text-gray-500 uppercase tracking-wider mb-2">Associated Contacts</p>
            {loadingContacts ? (
              <p className="text-xs text-gray-400">Loading…</p>
            ) : dealContacts.length === 0 ? (
              <p className="text-xs text-gray-400">No CRM contacts associated yet.</p>
            ) : (
              <div className="space-y-1.5">
                {dealContacts.map((dc: any) => (
                  <div key={dc.contact_id} className="flex items-center gap-2 p-2 bg-white rounded-lg border border-gray-200">
                    <Link href={`/admin/crm/contacts/${dc.contact_id}`} className="flex-1 min-w-0">
                      <p className="text-xs font-600 text-gray-800 hover:text-eb-green-700">
                        {dc.crm_contacts?.first_name} {dc.crm_contacts?.last_name}
                      </p>
                      <p className="text-[10px] text-gray-400">{dc.crm_contacts?.primary_email}</p>
                    </Link>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-700 ${dc.role === 'primary' ? 'bg-eb-green-100 text-eb-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {dc.role}
                    </span>
                    {portalBadge(dc.crm_contacts?.portal_link_status || 'none')}
                    <button onClick={() => removeContact(dc.contact_id)} className="p-1 rounded hover:bg-red-50 transition-colors" title="Remove">
                      <Icon name="XMarkIcon" size={12} className="text-gray-400 hover:text-red-500" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search & add */}
          <div>
            <p className="text-xs font-700 text-gray-500 uppercase tracking-wider mb-2">Add Contact</p>
            <div className="relative">
              <Icon name="MagnifyingGlassIcon" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Search by name or email…"
                value={search}
                onChange={e => searchContacts(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 bg-white"
              />
            </div>
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
            {results.length > 0 && (
              <div className="mt-1 border border-gray-200 rounded-lg overflow-hidden bg-white">
                {results.map(c => {
                  const alreadyLinked = dealContacts.some((dc: any) => dc.contact_id === c.id);
                  return (
                    <div key={c.id} className="flex items-center gap-2 px-3 py-2 border-b border-gray-50 last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-600 text-gray-800">{c.first_name} {c.last_name}</p>
                        <p className="text-[10px] text-gray-400">{c.primary_email}</p>
                        {(c.crm_companies as any)?.company_name && (
                          <p className="text-[10px] text-gray-400">{(c.crm_companies as any).company_name}</p>
                        )}
                      </div>
                      {alreadyLinked ? (
                        <span className="text-[10px] text-gray-400">Already linked</span>
                      ) : (
                        <div className="flex gap-1">
                          <button
                            onClick={() => associate(c.id, 'primary')}
                            disabled={associating}
                            className="px-2 py-1 text-[10px] font-600 bg-eb-green-700 text-white rounded hover:bg-eb-green-800 disabled:opacity-40 transition-colors"
                          >
                            Primary
                          </button>
                          <button
                            onClick={() => associate(c.id, 'additional')}
                            disabled={associating}
                            className="px-2 py-1 text-[10px] font-600 border border-gray-200 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-40 transition-colors"
                          >
                            Additional
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CRMDealsContent() {
  const supabase = createClient();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('All');
  const [portalFilter, setPortalFilter] = useState('all');
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error, count } = await supabase
      .from('borrower_applications')
      .select(`
        id, user_id, first_name, last_name, email, phone, company_name,
        property_address, property_type, purchase_price, deposit_amount,
        due_diligence_days, app_status, submitted_at, created_at,
        eb_assigned_owner, primary_contact_id, crm_company_id, deal_workflow_stage,
        crm_contacts:primary_contact_id(id, first_name, last_name, lead_status, portal_link_status),
        crm_companies:crm_company_id(id, company_name),
        crm_deal_contacts(contact_id, role, crm_contacts(id, first_name, last_name))
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(100);

    setDeals((data as Deal[]) || []);
    setTotal(count || 0);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let d = deals;
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(deal =>
        `${deal.first_name} ${deal.last_name}`.toLowerCase().includes(q) ||
        deal.email?.toLowerCase().includes(q) ||
        deal.property_address?.toLowerCase().includes(q) ||
        deal.company_name?.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') d = d.filter(deal => deal.app_status === statusFilter);
    if (ownerFilter !== 'All') d = d.filter(deal => (deal.eb_assigned_owner || 'Unassigned') === ownerFilter);
    if (portalFilter === 'has_portal') d = d.filter(deal => deal.crm_contacts?.portal_link_status === 'approved');
    if (portalFilter === 'no_portal') d = d.filter(deal => !deal.crm_contacts || deal.crm_contacts.portal_link_status === 'none');
    if (portalFilter === 'no_contact') d = d.filter(deal => !deal.primary_contact_id && (!deal.crm_deal_contacts || deal.crm_deal_contacts.length === 0));
    return d;
  }, [deals, search, statusFilter, ownerFilter, portalFilter]);

  const stats = useMemo(() => ({
    total: deals.length,
    active: deals.filter(d => ['approved', 'in_progress', 'funded'].includes(d.app_status)).length,
    noCrmContact: deals.filter(d => !d.primary_contact_id && (!d.crm_deal_contacts || d.crm_deal_contacts.length === 0)).length,
  }), [deals]);

  return (
    <div className="p-6 space-y-5 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-700 text-gray-900 font-display tracking-tight">CRM Deals</h1>
          <p className="text-sm text-gray-500 mt-0.5">All deals with CRM contact relationships</p>
        </div>
        <Link href="/admin/deals" className="flex items-center gap-2 px-4 py-2 bg-eb-green-700 text-white rounded-lg text-sm font-600 hover:bg-eb-green-800 transition-colors">
          <Icon name="PlusIcon" size={16} />
          New Deal
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Total Deals', value: stats.total, color: 'text-gray-700', bg: 'bg-white' },
          { label: 'Active Deals', value: stats.active, color: 'text-blue-700', bg: 'bg-blue-50' },
          { label: 'No CRM Contact', value: stats.noCrmContact, color: 'text-red-700', bg: 'bg-red-50' },
        ].map(s => (
          <div key={s.label} className={`${s.bg} rounded-xl border border-gray-200 p-4`}>
            <p className={`text-2xl font-700 font-display ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search deals…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20"
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
          {ALL_STATUSES.map(s => <option key={s} value={s}>{s === 'all' ? 'All Statuses' : s.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
          {OWNERS.map(o => <option key={o}>{o}</option>)}
        </select>
        <select value={portalFilter} onChange={e => setPortalFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
          <option value="all">All Portal Status</option>
          <option value="has_portal">Has Portal User</option>
          <option value="no_portal">No Portal User</option>
          <option value="no_contact">No CRM Contact</option>
        </select>
      </div>

      {/* Deals Table */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-7 h-7 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Icon name="BriefcaseIcon" size={32} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No deals found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(deal => {
            const cfg = STATUS_CONFIG[deal.app_status] || STATUS_CONFIG.application;
            const allContacts = deal.crm_deal_contacts || [];
            const primaryContact = deal.crm_contacts;

            return (
              <div key={deal.id} className="bg-white rounded-xl border border-gray-200 p-5 hover:border-gray-300 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Link href={`/admin/borrower/${deal.user_id}/application/${deal.id}`} className="text-sm font-700 text-gray-900 hover:text-eb-green-700 transition-colors">
                        {deal.property_address || 'Unnamed Deal'}
                      </Link>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 ${cfg.bg} ${cfg.color}`}>
                        {cfg.label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      {deal.first_name} {deal.last_name} · {deal.property_type || '—'} · {formatCurrency(deal.deposit_amount)} EMD
                    </p>
                    <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-400">
                      <span>Due Diligence Period: {deal.due_diligence_days != null ? `${deal.due_diligence_days} ${deal.due_diligence_days === 1 ? 'Day' : 'Days'}` : '—'}</span>
                      {deal.eb_assigned_owner && <span>Owner: {deal.eb_assigned_owner}</span>}
                      {(deal.crm_companies as any)?.company_name && (
                        <Link href={`/admin/crm/companies/${(deal.crm_companies as any).id}`} className="text-eb-green-600 hover:underline">
                          {(deal.crm_companies as any).company_name}
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* CRM Contact badges */}
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    {primaryContact ? (
                      <Link href={`/admin/crm/contacts/${primaryContact.id}`}
                        className="flex items-center gap-1.5 px-2.5 py-1 bg-eb-green-50 border border-eb-green-200 rounded-lg hover:bg-eb-green-100 transition-colors">
                        <Icon name="UserCircleIcon" size={13} className="text-eb-green-600" />
                        <span className="text-xs font-600 text-eb-green-700">{primaryContact.first_name} {primaryContact.last_name}</span>
                      </Link>
                    ) : allContacts.length > 0 ? (
                      <Link href={`/admin/crm/contacts/${allContacts[0].contact_id}`}
                        className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors">
                        <Icon name="UserCircleIcon" size={13} className="text-gray-500" />
                        <span className="text-xs font-600 text-gray-600">{(allContacts[0].crm_contacts as any)?.first_name} {(allContacts[0].crm_contacts as any)?.last_name}</span>
                      </Link>
                    ) : (
                      <span className="text-[10px] text-gray-400 italic">No CRM contact</span>
                    )}
                    {allContacts.length > 1 && (
                      <span className="text-[10px] text-gray-400">+{allContacts.length - 1} more</span>
                    )}
                  </div>
                </div>

                {/* Associate Contact Panel */}
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <AssociateContactPanel deal={deal} onUpdated={load} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-400 text-center">
        Showing {filtered.length} of {total} deals
      </p>
    </div>
  );
}
