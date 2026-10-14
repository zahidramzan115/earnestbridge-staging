'use client';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';

type EventType = 'view' | 'edit' | 'create' | 'delete' | 'status_change' | 'document_access' | 'login' | 'export';

interface AuditLog {
  id: string;
  admin_id: string;
  admin_email: string;
  event_type: EventType;
  resource_type: string;
  resource_id: string | null;
  borrower_id: string | null;
  borrower_email: string | null;
  description: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

const EVENT_CONFIG: Record<EventType, { label: string; color: string; bg: string; border: string; icon: string }> = {
  view:            { label: 'View',            color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200',    icon: 'EyeIcon' },
  edit:            { label: 'Edit',            color: 'text-amber-700',   bg: 'bg-amber-50',   border: 'border-amber-200',   icon: 'PencilSquareIcon' },
  create:          { label: 'Create',          color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'PlusCircleIcon' },
  delete:          { label: 'Delete',          color: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200',     icon: 'TrashIcon' },
  status_change:   { label: 'Status Change',   color: 'text-purple-700',  bg: 'bg-purple-50',  border: 'border-purple-200',  icon: 'ArrowPathIcon' },
  document_access: { label: 'Document Access', color: 'text-teal-700',    bg: 'bg-teal-50',    border: 'border-teal-200',    icon: 'DocumentTextIcon' },
  login:           { label: 'Login',           color: 'text-gray-700',    bg: 'bg-gray-50',    border: 'border-gray-200',    icon: 'ArrowRightOnRectangleIcon' },
  export:          { label: 'Export',          color: 'text-indigo-700',  bg: 'bg-indigo-50',  border: 'border-indigo-200',  icon: 'ArrowDownTrayIcon' },
};

const ALL_EVENT_TYPES: EventType[] = ['view', 'edit', 'create', 'delete', 'status_change', 'document_access', 'login', 'export'];

function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  const hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  return `${month} ${day}, ${year} · ${h12}:${mins} ${ampm}`;
}

function formatRelative(dateStr: string) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface ExpandedRowProps {
  log: AuditLog;
  onClose: () => void;
}

function ExpandedRow({ log, onClose }: ExpandedRowProps) {
  const cfg = EVENT_CONFIG[log.event_type];
  return (
    <div className="bg-gray-50 border-t border-gray-100 px-4 sm:px-6 py-4">
      <div className="flex items-start justify-between mb-3">
        <h4 className="text-sm font-600 text-gray-800">Event Details</h4>
        <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 transition-colors">
          <Icon name="XMarkIcon" size={16} />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">Event ID</p>
          <p className="text-gray-700 font-mono break-all">{log.id}</p>
        </div>
        <div>
          <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">Admin</p>
          <p className="text-gray-700">{log.admin_email}</p>
        </div>
        <div>
          <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">Timestamp</p>
          <p className="text-gray-700">{formatDateTime(log.created_at)}</p>
        </div>
        <div>
          <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">Resource Type</p>
          <p className="text-gray-700 capitalize">{log.resource_type.replace(/_/g, ' ')}</p>
        </div>
        {log.resource_id && (
          <div>
            <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">Resource ID</p>
            <p className="text-gray-700 font-mono break-all">{log.resource_id}</p>
          </div>
        )}
        {log.borrower_email && (
          <div>
            <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">Borrower</p>
            <p className="text-gray-700">{log.borrower_email}</p>
          </div>
        )}
        {log.ip_address && (
          <div>
            <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">IP Address</p>
            <p className="text-gray-700 font-mono">{log.ip_address}</p>
          </div>
        )}
        <div>
          <p className="text-gray-400 font-500 uppercase tracking-wider mb-1">Event Type</p>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-600 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
            {cfg.label}
          </span>
        </div>
      </div>

      {(log.old_value || log.new_value) && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {log.old_value && (
            <div>
              <p className="text-gray-400 text-xs font-500 uppercase tracking-wider mb-1.5">Before</p>
              <pre className="bg-red-50 border border-red-100 rounded-lg p-3 text-xs text-red-800 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(log.old_value, null, 2)}
              </pre>
            </div>
          )}
          {log.new_value && (
            <div>
              <p className="text-gray-400 text-xs font-500 uppercase tracking-wider mb-1.5">After</p>
              <pre className="bg-emerald-50 border border-emerald-100 rounded-lg p-3 text-xs text-emerald-800 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(log.new_value, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AuditLogContent() {
  const supabase = useMemo(() => createClient(), []);

  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterEvent, setFilterEvent] = useState<EventType | 'all'>('all');
  const [filterResource, setFilterResource] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (error) throw error;
      setLogs(data || []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const resourceTypes = useMemo(() => {
    const types = new Set(logs.map((l) => l.resource_type));
    return Array.from(types).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return logs.filter((l) => {
      if (filterEvent !== 'all' && l.event_type !== filterEvent) return false;
      if (filterResource !== 'all' && l.resource_type !== filterResource) return false;
      if (q) {
        return (
          l.admin_email.toLowerCase().includes(q) ||
          (l.borrower_email ?? '').toLowerCase().includes(q) ||
          l.description.toLowerCase().includes(q) ||
          l.resource_type.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [logs, filterEvent, filterResource, searchQuery]);

  const stats = useMemo(() => {
    const total = logs.length;
    const views = logs.filter((l) => l.event_type === 'view').length;
    const edits = logs.filter((l) => l.event_type === 'edit' || l.event_type === 'status_change' || l.event_type === 'create').length;
    const uniqueAdmins = new Set(logs.map((l) => l.admin_id)).size;
    return { total, views, edits, uniqueAdmins };
  }, [logs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading audit logs…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-eb-green-900 flex items-center justify-center">
              <Icon name="ShieldCheckIcon" size={16} className="text-eb-gold-400" />
            </div>
            <h1 className="font-display font-700 text-gray-900 text-2xl sm:text-3xl">Audit Log</h1>
          </div>
          <p className="text-sm text-gray-400 mt-1">
            Compliance &amp; security event trail — all admin data access and changes
          </p>
        </div>
        <button
          onClick={fetchLogs}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-eb-green-900 text-white text-sm font-medium hover:bg-eb-green-800 transition-colors self-start sm:self-auto"
        >
          <Icon name="ArrowPathIcon" size={15} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Events', value: stats.total, icon: 'ClipboardDocumentListIcon', color: 'text-gray-700', bg: 'bg-gray-100' },
          { label: 'View Events', value: stats.views, icon: 'EyeIcon', color: 'text-blue-700', bg: 'bg-blue-50' },
          { label: 'Write Events', value: stats.edits, icon: 'PencilSquareIcon', color: 'text-amber-700', bg: 'bg-amber-50' },
          { label: 'Active Admins', value: stats.uniqueAdmins, icon: 'UserGroupIcon', color: 'text-eb-green-700', bg: 'bg-eb-green-50' },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
            <div className={`w-8 h-8 rounded-lg ${s.bg} flex items-center justify-center mb-2`}>
              <Icon name={s.icon as Parameters<typeof Icon>[0]['name']} size={16} className={s.color} />
            </div>
            <p className="text-2xl font-700 text-gray-900 font-display">{s.value}</p>
            <p className="text-xs text-gray-400 font-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm mb-4 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Icon name="MagnifyingGlassIcon" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by admin, borrower, or description…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-eb-green-700/20 focus:border-eb-green-700 transition-all"
            />
          </div>

          {/* Event type filter */}
          <select
            value={filterEvent}
            onChange={(e) => setFilterEvent(e.target.value as EventType | 'all')}
            className="px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-eb-green-700/20 focus:border-eb-green-700 bg-white text-gray-700 transition-all"
          >
            <option value="all">All Event Types</option>
            {ALL_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{EVENT_CONFIG[t].label}</option>
            ))}
          </select>

          {/* Resource type filter */}
          <select
            value={filterResource}
            onChange={(e) => setFilterResource(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-eb-green-700/20 focus:border-eb-green-700 bg-white text-gray-700 transition-all"
          >
            <option value="all">All Resources</option>
            {resourceTypes.map((r) => (
              <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        {(searchQuery || filterEvent !== 'all' || filterResource !== 'all') && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-gray-400">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</span>
            <button
              onClick={() => { setSearchQuery(''); setFilterEvent('all'); setFilterResource('all'); }}
              className="text-xs text-eb-green-700 hover:text-eb-green-900 font-500 transition-colors"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center mb-3">
              <Icon name="ClipboardDocumentListIcon" size={22} className="text-gray-400" />
            </div>
            <p className="text-sm font-600 text-gray-700 mb-1">No audit events found</p>
            <p className="text-xs text-gray-400">
              {searchQuery || filterEvent !== 'all' || filterResource !== 'all' ?'Try adjusting your filters' :'Audit events will appear here as admins interact with borrower data'}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/60">
                    <th className="text-left px-5 py-3 text-xs font-600 text-gray-400 uppercase tracking-wider">Timestamp</th>
                    <th className="text-left px-5 py-3 text-xs font-600 text-gray-400 uppercase tracking-wider">Admin</th>
                    <th className="text-left px-5 py-3 text-xs font-600 text-gray-400 uppercase tracking-wider">Event</th>
                    <th className="text-left px-5 py-3 text-xs font-600 text-gray-400 uppercase tracking-wider">Resource</th>
                    <th className="text-left px-5 py-3 text-xs font-600 text-gray-400 uppercase tracking-wider">Borrower</th>
                    <th className="text-left px-5 py-3 text-xs font-600 text-gray-400 uppercase tracking-wider">Description</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filtered.map((log) => {
                    const cfg = EVENT_CONFIG[log.event_type];
                    const isExpanded = expandedId === log.id;
                    return (
                      <React.Fragment key={log.id}>
                        <tr
                          className={`hover:bg-gray-50/60 transition-colors cursor-pointer ${isExpanded ? 'bg-gray-50/60' : ''}`}
                          onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        >
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            <p className="text-gray-800 font-500 text-xs">{formatRelative(log.created_at)}</p>
                            <p className="text-gray-400 text-[11px] mt-0.5">{formatDateTime(log.created_at).split('·')[1]?.trim()}</p>
                          </td>
                          <td className="px-5 py-3.5">
                            <p className="text-gray-800 font-500 text-xs truncate max-w-[160px]">{log.admin_email}</p>
                          </td>
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-600 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                              <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                              {cfg.label}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <p className="text-gray-700 text-xs capitalize">{log.resource_type.replace(/_/g, ' ')}</p>
                          </td>
                          <td className="px-5 py-3.5">
                            <p className="text-gray-600 text-xs truncate max-w-[160px]">{log.borrower_email ?? '—'}</p>
                          </td>
                          <td className="px-5 py-3.5">
                            <p className="text-gray-600 text-xs truncate max-w-[240px]">{log.description}</p>
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <Icon
                              name={isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'}
                              size={14}
                              className="text-gray-400 inline-block"
                            />
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={7} className="p-0">
                              <ExpandedRow log={log} onClose={() => setExpandedId(null)} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="lg:hidden divide-y divide-gray-50">
              {filtered.map((log) => {
                const cfg = EVENT_CONFIG[log.event_type];
                const isExpanded = expandedId === log.id;
                return (
                  <div key={log.id}>
                    <button
                      className="w-full text-left px-4 py-4 hover:bg-gray-50/60 transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : log.id)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-600 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                              <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={10} />
                              {cfg.label}
                            </span>
                            <span className="text-[11px] text-gray-400">{formatRelative(log.created_at)}</span>
                          </div>
                          <p className="text-xs font-500 text-gray-800 truncate">{log.description}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5 truncate">{log.admin_email}</p>
                        </div>
                        <Icon
                          name={isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'}
                          size={14}
                          className="text-gray-400 flex-shrink-0 mt-1"
                        />
                      </div>
                    </button>
                    {isExpanded && (
                      <ExpandedRow log={log} onClose={() => setExpandedId(null)} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            <div className="border-t border-gray-100 px-5 py-3 flex items-center justify-between">
              <p className="text-xs text-gray-400">
                Showing {filtered.length} of {logs.length} events
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 text-xs font-500 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-500 px-1">Page {page + 1}</span>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={logs.length < PAGE_SIZE}
                  className="px-3 py-1.5 text-xs font-500 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Compliance note */}
      <div className="mt-4 flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-100">
        <Icon name="InformationCircleIcon" size={15} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-700">
          Audit logs are <strong>immutable</strong> — entries cannot be edited or deleted. All admin interactions with borrower data are recorded for compliance and security accountability.
        </p>
      </div>
    </div>
  );
}
