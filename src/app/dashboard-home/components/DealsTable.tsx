'use client';
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import StatusBadge from '@/components/ui/StatusBadge';
import { ApplicationStatus } from '@/lib/mockData';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface DealRow {
  id: string;
  dealName: string;
  propertyAddress: string;
  propertyType: string;
  emdAmount: number;
  purchasePrice: number;
  status: ApplicationStatus;
  submittedDate: string;
  dueDiligenceDays: number;
  createdAt: string;
}

type SortKey = 'dealName' | 'emdAmount' | 'purchasePrice' | 'dueDiligenceDays' | 'submittedDate' | 'status';
type SortDir = 'asc' | 'desc';

const STATUS_FILTERS: { label: string; value: ApplicationStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Application', value: 'application' },
  { label: 'Under Review', value: 'under_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Funded', value: 'funded' },
  { label: 'Closed', value: 'closed' },
  { label: 'Rejected', value: 'rejected' },
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDateStable(dateStr: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function formatCurrency(n: number) {
  if (!n) return '—';
  return `$${n.toLocaleString()}`;
}

function mapRow(row: any): DealRow {
  const dealName = row.company_name || row.property_address || `Deal ${row.id.slice(0, 6)}`;
  const statusMap: Record<string, ApplicationStatus> = {
    // legacy DB values → new statuses
    draft: 'application',
    submitted: 'application',
    under_review: 'under_review',
    in_review: 'under_review',
    conditionally_approved: 'approved',
    approved: 'approved',
    in_progress: 'in_progress',
    funded: 'funded',
    closed: 'closed',
    rejected: 'rejected',
    expired: 'rejected',
  };
  return {
    id: row.id,
    dealName,
    propertyAddress: row.property_address || '—',
    propertyType: row.property_type || '—',
    emdAmount: row.deposit_amount || 0,
    purchasePrice: row.purchase_price || 0,
    status: statusMap[row.app_status] ?? (row.app_status as ApplicationStatus) ?? 'draft',
    submittedDate: row.submitted_at || row.created_at,
    // -1 = not set (sorts before real values; rendered as "—")
    dueDiligenceDays: typeof row.due_diligence_days === 'number' ? row.due_diligence_days : -1,
    createdAt: row.created_at,
  };
}

export default function DealsTable() {
  const { user, loading: authLoading } = useAuth();
  const [deals, setDeals] = useState<DealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ApplicationStatus | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('submittedDate');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 6;

  const fetchDeals = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase
      .from('borrower_applications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setDeals(data.map(mapRow));
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!authLoading) {
      fetchDeals();
    }
  }, [fetchDeals, authLoading]);

  // Real-time subscription
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    const channel = supabase
      .channel('deals-table-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'borrower_applications', filter: `user_id=eq.${user.id}` },
        () => { fetchDeals(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, fetchDeals]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const filtered = useMemo(() => {
    let data = [...deals];
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((a) => a.dealName.toLowerCase().includes(q) || a.propertyAddress.toLowerCase().includes(q));
    }
    if (statusFilter !== 'all') data = data.filter((a) => a.status === statusFilter);
    if (dateFrom) data = data.filter((a) => new Date(a.submittedDate) >= new Date(dateFrom));
    if (dateTo) data = data.filter((a) => new Date(a.submittedDate) <= new Date(dateTo));
    data.sort((a, b) => {
      let av: string | number = a[sortKey] as string | number;
      let bv: string | number = b[sortKey] as string | number;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return data;
  }, [deals, search, statusFilter, sortKey, sortDir, dateFrom, dateTo]);

  const draftCount = deals.filter(a => a.status === 'draft').length;
  const totalPages = Math.ceil(filtered.length / perPage);
  const paged = filtered.slice((page - 1) * perPage, page * perPage);

  const SortIcon = ({ col }: { col: SortKey }) => (
    <span className="ml-1 inline-flex flex-col gap-0">
      <Icon name="ChevronUpIcon" size={10} className={`${sortKey === col && sortDir === 'asc' ? 'text-eb-green-900' : 'text-gray-300'}`} />
      <Icon name="ChevronDownIcon" size={10} className={`${sortKey === col && sortDir === 'desc' ? 'text-eb-green-900' : 'text-gray-300'} -mt-1`} />
    </span>
  );

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100">
      {/* Table header / filters */}
      <div className="p-4 sm:p-5 border-b border-gray-100">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-display font-600 text-gray-900">My Deals</h3>
              <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
                {deals.length} total
              </span>
              {draftCount > 0 && (
                <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full tabular-nums font-600">
                  {draftCount} draft{draftCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">{filtered.length} deal{filtered.length !== 1 ? 's' : ''} found</p>
          </div>
          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
            {/* New Deal CTA */}
            <Link
              href="/apply"
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-600 text-white bg-eb-green-900 rounded-lg hover:bg-eb-green-800 transition-all min-h-[40px] whitespace-nowrap"
            >
              <Icon name="PlusIcon" size={14} />
              New Deal
            </Link>
            {/* Search */}
            <div className="relative">
              <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search deals or address..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="pl-8 pr-3 py-2.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 w-full sm:w-52 transition-all min-h-[40px]"
              />
            </div>
            {/* Date range */}
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                className="px-3 py-2.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all text-gray-600 flex-1 sm:flex-none min-h-[40px]"
                title="Filter from date"
              />
              <span className="text-gray-300 text-xs flex-shrink-0">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                className="px-3 py-2.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all text-gray-600 flex-1 sm:flex-none min-h-[40px]"
                title="Filter to date"
              />
            </div>
          </div>
        </div>

        {/* Status filter chips */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {STATUS_FILTERS.map((f) => (
            <button
              key={`chip-${f.value}`}
              onClick={() => { setStatusFilter(f.value); setPage(1); }}
              className={`px-3 py-1.5 text-xs font-display font-600 rounded-full border transition-all duration-150 min-h-[32px] ${
                statusFilter === f.value
                  ? 'bg-eb-green-900 text-white border-eb-green-900' :'bg-white text-gray-600 border-gray-200 hover:border-eb-green-900/40 hover:text-eb-green-900'
              }`}
            >
              {f.label}
              {f.value !== 'all' && (
                <span className="ml-1 opacity-60">
                  ({deals.filter((a) => a.status === f.value).length})
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/50">
              {[
                { label: 'Deal Name', key: 'dealName' as SortKey },
                { label: 'Property Type', key: null },
                { label: 'EMD Amount', key: 'emdAmount' as SortKey },
                { label: 'Purchase Price', key: 'purchasePrice' as SortKey },
                { label: 'Status', key: 'status' as SortKey },
                { label: 'Submitted', key: 'submittedDate' as SortKey },
                { label: 'Due Diligence Period', key: 'dueDiligenceDays' as SortKey },
                { label: 'Actions', key: null },
              ].map((col, i) => (
                <th
                  key={`th-${i}`}
                  onClick={() => col.key && handleSort(col.key)}
                  className={`text-left px-4 py-3 text-[11px] font-display font-600 uppercase tracking-wider text-gray-500 whitespace-nowrap ${col.key ? 'cursor-pointer hover:text-eb-green-900 select-none' : ''}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.key && <SortIcon col={col.key} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr>
                <td colSpan={8} className="text-center py-16">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-gray-400">Loading your deals…</p>
                  </div>
                </td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-16 text-gray-400">
                  <Icon name="DocumentMagnifyingGlassIcon" size={32} className="mx-auto mb-3 text-gray-200" />
                  {deals.length === 0 ? (
                    <>
                      <p className="font-medium text-gray-500">No deals yet</p>
                      <p className="text-xs mt-1 mb-4">Start your first EMD financing deal</p>
                      <Link
                        href="/apply"
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-600 text-white bg-eb-green-900 rounded-lg hover:bg-eb-green-800 transition-all"
                      >
                        <Icon name="PlusIcon" size={14} />
                        Start New Deal
                      </Link>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-gray-500">No deals match your filters</p>
                      <p className="text-xs mt-1">Try adjusting your search or clearing status filters</p>
                    </>
                  )}
                </td>
              </tr>
            ) : (
              paged.map((deal) => {
                const isDraft = deal.status === 'draft';
                const isActiveDeal = ['approved', 'funded', 'closed'].includes(deal.status);
                return (
                  <tr
                    key={`row-${deal.id}`}
                    className={`hover:bg-gray-50/70 transition-colors group ${isDraft ? 'bg-amber-50/30' : ''}`}
                  >
                    <td className="px-4 py-3.5">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-gray-900 truncate max-w-[200px]">{deal.dealName}</p>
                          {isDraft && (
                            <span className="flex-shrink-0 text-[10px] font-700 text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded-full">
                              DRAFT
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate max-w-[200px] mt-0.5">{deal.propertyAddress}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {deal.propertyType && deal.propertyType !== '—' ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded-full">
                          <Icon name="BuildingOffice2Icon" size={11} className="text-gray-400" />
                          {deal.propertyType}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="tabular-nums font-medium text-gray-900">{formatCurrency(deal.emdAmount)}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="tabular-nums text-gray-600">{formatCurrency(deal.purchasePrice)}</span>
                    </td>
                    <td className="px-4 py-3.5">
                      <StatusBadge status={deal.status} size="sm" />
                    </td>
                    <td className="px-4 py-3.5 text-xs text-gray-500 tabular-nums whitespace-nowrap">
                      {isDraft ? (
                        <span className="text-gray-400 italic">Not submitted</span>
                      ) : (
                        formatDateStable(deal.submittedDate)
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      {deal.dueDiligenceDays >= 0 ? (
                        <div>
                          <span className="text-xs text-gray-600 tabular-nums whitespace-nowrap">
                            {deal.dueDiligenceDays} {deal.dueDiligenceDays === 1 ? 'Day' : 'Days'}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1">
                        {isDraft ? (
                          <Link
                            href={`/apply?draft=${deal.id}`}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-600 text-white bg-eb-green-900 rounded-lg hover:bg-eb-green-800 transition-all whitespace-nowrap"
                            title="Resume this draft"
                          >
                            <Icon name="PencilSquareIcon" size={12} />
                            Resume
                          </Link>
                        ) : (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {isActiveDeal ? (
                              <Link
                                href={`/deals/${deal.id}`}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-eb-green-900 hover:bg-eb-green-50 transition-all"
                                title="Manage deal"
                              >
                                <Icon name="EyeIcon" size={15} />
                              </Link>
                            ) : (
                              <Link
                                href="/deals"
                                className="p-1.5 rounded-lg text-gray-400 hover:text-eb-green-900 hover:bg-eb-green-50 transition-all"
                                title="View deal status"
                              >
                                <Icon name="EyeIcon" size={15} />
                              </Link>
                            )}
                            <Link
                              href="/documents"
                              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-all"
                              title="Manage documents"
                            >
                              <Icon name="ArrowUpTrayIcon" size={15} />
                            </Link>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
          <p className="text-xs text-gray-400">
            Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(p - 1, 1))}
              disabled={page === 1}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-all"
            >
              <Icon name="ChevronLeftIcon" size={14} />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button
                key={`page-${p}`}
                onClick={() => setPage(p)}
                className={`w-7 h-7 text-xs rounded-lg font-600 transition-all ${
                  page === p ? 'bg-eb-green-900 text-white' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => setPage(p => Math.min(p + 1, totalPages))}
              disabled={page === totalPages}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-all"
            >
              <Icon name="ChevronRightIcon" size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}