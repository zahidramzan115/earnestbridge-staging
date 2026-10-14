'use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';

interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  phone: string | null;
  lead_status: string;
  assigned_owner: string;
  lead_source: string | null;
  next_follow_up_at: string | null;
  last_contacted_at: string | null;
  portal_link_status: string;
  created_at: string;
  crm_companies?: { id: string; company_name: string } | null;
  crm_deal_contacts?: { count: number }[];
}

const LEAD_STATUSES = [
  'New Lead', 'Contacted', 'Qualified', 'Deal Submitted',
  'Client', 'Nurture', 'Lost', 'Not Qualified',
];

const OWNERS = ['Dan', 'Tucker', 'Eric', 'Unassigned'];

const STATUS_COLORS: Record<string, string> = {
  'New Lead':       'bg-blue-100 text-blue-700 border-blue-200',
  'Contacted':      'bg-purple-100 text-purple-700 border-purple-200',
  'Qualified':      'bg-amber-100 text-amber-700 border-amber-200',
  'Deal Submitted': 'bg-orange-100 text-orange-700 border-orange-200',
  'Client':         'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Nurture':        'bg-teal-100 text-teal-700 border-teal-200',
  'Lost':           'bg-red-100 text-red-700 border-red-200',
  'Not Qualified':  'bg-gray-100 text-gray-600 border-gray-200',
};

const PORTAL_BADGES: Record<string, { label: string; color: string }> = {
  none:     { label: 'No Portal Account', color: 'bg-gray-100 text-gray-500 border-gray-200' },
  pending:  { label: 'Pending Approval',  color: 'bg-amber-100 text-amber-700 border-amber-200' },
  approved: { label: 'Portal Active',     color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  rejected: { label: 'Access Rejected',   color: 'bg-red-100 text-red-700 border-red-200' },
};

function formatDate(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function isOverdue(d: string | null) {
  if (!d) return false;
  return new Date(d) < new Date();
}

export default function ContactsListContent() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const LIMIT = 50;

  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [ownerFilter, setOwnerFilter] = useState(searchParams.get('owner') || '');
  const [portalFilter, setPortalFilter] = useState(searchParams.get('portal_status') || '');
  const [showNewModal, setShowNewModal] = useState(false);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    const offset = (page - 1) * LIMIT;

    let query = supabase
      .from('crm_contacts')
      .select(`
        id, first_name, last_name, primary_email, phone, lead_status,
        assigned_owner, lead_source, next_follow_up_at, last_contacted_at,
        portal_link_status, created_at,
        crm_companies(id, company_name),
        crm_deal_contacts(count)
      `, { count: 'exact' })
      .eq('is_merged', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + LIMIT - 1);

    if (search) {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,primary_email.ilike.%${search}%,phone.ilike.%${search}%`
      );
    }
    if (statusFilter) query = query.eq('lead_status', statusFilter);
    if (ownerFilter) query = query.eq('assigned_owner', ownerFilter);
    if (portalFilter) query = query.eq('portal_link_status', portalFilter);

    const { data, count, error } = await query;
    if (!error) {
      setContacts((data as Contact[]) || []);
      setTotal(count || 0);
    }
    setLoading(false);
  }, [search, statusFilter, ownerFilter, portalFilter, page]);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  const quickFilters = useMemo(() => [
    { label: 'All', value: '', count: null },
    { label: 'New Leads', value: 'New Lead', count: null },
    { label: 'Qualified', value: 'Qualified', count: null },
    { label: 'Clients', value: 'Client', count: null },
    { label: 'Nurture', value: 'Nurture', count: null },
  ], []);

  return (
    <div className="p-6 space-y-5 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-700 text-gray-900 font-display tracking-tight">Contacts</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total.toLocaleString()} total contacts</p>
        </div>
        <Link
          href="/admin/crm/contacts/new"
          className="flex items-center gap-2 px-4 py-2 bg-eb-green-700 text-white rounded-lg text-sm font-600 hover:bg-eb-green-800 transition-colors"
        >
          <Icon name="PlusIcon" size={16} />
          New Contact
        </Link>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        {/* Quick filters */}
        <div className="flex flex-wrap gap-2">
          {quickFilters.map((f) => (
            <button
              key={f.label}
              onClick={() => { setStatusFilter(f.value); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-600 border transition-all ${
                statusFilter === f.value
                  ? 'bg-eb-green-700 text-white border-eb-green-700' :'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
          {statusFilter && !['', 'New Lead', 'Qualified', 'Client', 'Nurture'].includes(statusFilter) && (
            <span className={`px-3 py-1.5 rounded-lg text-xs font-600 border bg-eb-green-700 text-white border-eb-green-700`}>
              {statusFilter}
            </span>
          )}
        </div>

        {/* Search + Advanced Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-48">
            <Icon name="MagnifyingGlassIcon" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search name, email, phone…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 bg-white text-gray-700"
          >
            <option value="">All Statuses</option>
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={ownerFilter}
            onChange={(e) => { setOwnerFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 bg-white text-gray-700"
          >
            <option value="">All Owners</option>
            {OWNERS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <select
            value={portalFilter}
            onChange={(e) => { setPortalFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 bg-white text-gray-700"
          >
            <option value="">All Portal Status</option>
            <option value="none">No Portal Account</option>
            <option value="pending">Pending Approval</option>
            <option value="approved">Portal Active</option>
            <option value="rejected">Access Rejected</option>
          </select>
          {(search || statusFilter || ownerFilter || portalFilter) && (
            <button
              onClick={() => { setSearch(''); setStatusFilter(''); setOwnerFilter(''); setPortalFilter(''); setPage(1); }}
              className="px-3 py-2 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-6 h-6 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <Icon name="UsersIcon" size={32} className="text-gray-300" />
            <p className="text-sm text-gray-400">No contacts found</p>
            <Link href="/admin/crm/contacts/new" className="text-xs text-eb-green-700 font-600 hover:underline">
              Create your first contact →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden md:table-cell">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden lg:table-cell">Email</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden xl:table-cell">Owner</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden xl:table-cell">Deals</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden lg:table-cell">Follow-Up</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden md:table-cell">Portal</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider hidden xl:table-cell">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {contacts.map((c) => {
                  const dealCount = (c.crm_deal_contacts as any)?.[0]?.count || 0;
                  const portal = PORTAL_BADGES[c.portal_link_status] || PORTAL_BADGES.none;
                  const followUpOverdue = isOverdue(c.next_follow_up_at);
                  return (
                    <tr key={c.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => router.push(`/admin/crm/contacts/${c.id}`)}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-eb-green-100 flex items-center justify-center flex-shrink-0">
                            <span className="text-xs font-700 text-eb-green-700">
                              {(c.first_name?.[0] || '?').toUpperCase()}{(c.last_name?.[0] || '').toUpperCase()}
                            </span>
                          </div>
                          <div>
                            <p className="font-600 text-gray-900 text-sm">{c.first_name} {c.last_name}</p>
                            <p className="text-xs text-gray-400 md:hidden">{(c.crm_companies as any)?.company_name || c.primary_email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-sm text-gray-600">{(c.crm_companies as any)?.company_name || '—'}</span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-sm text-gray-500">{c.primary_email}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 border whitespace-nowrap ${STATUS_COLORS[c.lead_status] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                          {c.lead_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <span className="text-sm text-gray-600">{c.assigned_owner}</span>
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <span className={`text-sm font-600 ${dealCount > 0 ? 'text-eb-green-700' : 'text-gray-400'}`}>
                          {dealCount > 0 ? dealCount : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className={`text-xs ${followUpOverdue ? 'text-red-600 font-600' : 'text-gray-500'}`}>
                          {c.next_follow_up_at ? formatDate(c.next_follow_up_at) : '—'}
                          {followUpOverdue && <span className="ml-1 text-red-500">!</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 border whitespace-nowrap ${portal.color}`}>
                          {portal.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell">
                        <span className="text-xs text-gray-400">{formatDate(c.created_at)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > LIMIT && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50">
            <p className="text-xs text-gray-500">
              Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} of {total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-white transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * LIMIT >= total}
                className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-white transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
