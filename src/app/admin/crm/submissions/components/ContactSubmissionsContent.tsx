'use client';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Submission {
  id: string;
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  company_name: string | null;
  message: string | null;
  inquiry_type: string | null;
  property_address: string | null;
  property_type: string | null;
  purchase_price: number | null;
  deposit_amount: number | null;
  estimated_emd_amount: number | null;
  closing_date: string | null;
  target_closing_date: string | null;
  lead_source: string | null;
  landing_page: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  promo_code: string | null;
  promo_code_used: string | null;
  is_new_contact: boolean;
  submitted_at: string;
  // joined from crm_contacts
  crm_contacts?: {
    id: string;
    first_name: string;
    last_name: string;
    lead_status: string;
    assigned_owner: string;
    portal_link_status: string;
  } | null;
}

interface FilterState {
  search: string;
  dateFrom: string;
  dateTo: string;
  contactType: 'all' | 'new' | 'existing';
  leadStatus: string;
  owner: string;
  leadSource: string;
  utmCampaign: string;
  promoCode: string;
  view: 'all' | 'new_leads' | 'repeat' | 'this_week' | 'this_month';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OWNERS = ['All', 'Dan', 'Tucker', 'Eric', 'Unassigned'];
const LEAD_STATUSES = ['All', 'New Lead', 'Contacted', 'Qualified', 'Deal Submitted', 'Client', 'Nurture', 'Lost', 'Not Qualified'];

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
  none:     { label: 'No Portal',       color: 'bg-gray-100 text-gray-500' },
  pending:  { label: 'Portal Pending',  color: 'bg-amber-100 text-amber-700' },
  approved: { label: 'Portal Active',   color: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: 'Portal Rejected', color: 'bg-red-100 text-red-700' },
};

function formatDate(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function formatDateTime(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const h = dt.getHours();
  const m = dt.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()} ${h % 12 || 12}:${m} ${ampm}`;
}

function formatCurrency(v: number | null) {
  if (!v) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

// ─── Submission Detail Drawer ─────────────────────────────────────────────────

interface SubmissionDrawerProps {
  submission: Submission;
  onClose: () => void;
  canPurge: boolean;
  onPurged: (id: string) => void;
}

function SubmissionDrawer({ submission, onClose, canPurge, onPurged }: SubmissionDrawerProps) {
  const contact = submission.crm_contacts;
  const portalBadge = PORTAL_BADGES[contact?.portal_link_status || 'none'];

  const [showPurge, setShowPurge] = useState(false);
  const [purgeReason, setPurgeReason] = useState('');
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const purgeLockRef = useRef(false);

  const handleClose = () => {
    if (purgeLockRef.current) return;
    onClose();
  };

  const closePurgeDialog = () => {
    if (purgeLockRef.current) return;
    setShowPurge(false);
    setPurgeReason('');
    setPurgeConfirmText('');
    setPurgeError(null);
  };

  const handlePurge = async () => {
    if (purgeLockRef.current) return;
    const reason = purgeReason.trim();
    if (!reason || purgeConfirmText !== 'PURGE') return;
    purgeLockRef.current = true;
    setPurging(true);
    setPurgeError(null);
    let succeeded = false;
    try {
      const res = await fetch(`/api/admin/contact-submissions/${submission.id}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purge_reason: reason }),
      });
      if (res.ok) {
        succeeded = true;
      } else if (res.status === 401) {
        setPurgeError('Your session has expired. Please sign in again.');
      } else if (res.status === 403) {
        setPurgeError('Only a SuperAdmin can purge a Contact Submission.');
      } else if (res.status === 404) {
        setPurgeError('This submission could not be found. It may have already been removed.');
      } else if (res.status === 400) {
        const j = await res.json().catch(() => null);
        setPurgeError(j?.error || 'Invalid request.');
      } else {
        setPurgeError('Something went wrong while purging the submission. Please try again.');
      }
    } catch {
      setPurgeError('Network error. Please check your connection and try again.');
    } finally {
      purgeLockRef.current = false;
      setPurging(false);
    }
    if (succeeded) {
      onPurged(submission.id);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={handleClose} />
      <div className="w-full max-w-xl bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div>
            <h2 className="text-base font-700 text-gray-900 font-display">Submission Detail</h2>
            <p className="text-xs text-gray-500 mt-0.5">{formatDateTime(submission.submitted_at)}</p>
          </div>
          <div className="flex items-center gap-2">
            {canPurge && (
              <button
                onClick={() => setShowPurge(true)}
                disabled={purging}
                className="px-3 py-1.5 rounded-lg text-xs font-600 border border-red-200 text-red-700 bg-white hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                Purge Submission
              </button>
            )}
            <button
              onClick={handleClose}
              disabled={purging}
              className="p-1.5 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              <Icon name="XMarkIcon" size={18} className="text-gray-500" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Badges */}
          <div className="flex flex-wrap gap-2">
            {submission.is_new_contact ? (
              <span className="px-2.5 py-1 rounded-full text-xs font-700 bg-blue-600 text-white">NEW LEAD</span>
            ) : (
              <span className="px-2.5 py-1 rounded-full text-xs font-700 bg-purple-100 text-purple-700 border border-purple-200">EXISTING CONTACT</span>
            )}
            {contact && (
              <span className={`px-2.5 py-1 rounded-full text-xs font-600 ${portalBadge.color}`}>
                {portalBadge.label.toUpperCase()}
              </span>
            )}
          </div>

          {/* Contact Info */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-3">Contact Information</h3>
            <Row label="Name" value={`${submission.first_name || ''} ${submission.last_name || ''}`.trim() || '—'} />
            <Row label="Email" value={submission.email} />
            <Row label="Phone" value={submission.phone} />
            <Row label="Company" value={submission.company_name} />
            {contact && (
              <div className="pt-2 border-t border-gray-200">
                <Link
                  href={`/admin/crm/contacts/${contact.id}`}
                  className="text-xs text-eb-green-700 font-600 hover:underline flex items-center gap-1"
                >
                  <Icon name="UserCircleIcon" size={13} />
                  View CRM Contact → {contact.first_name} {contact.last_name}
                </Link>
              </div>
            )}
          </div>

          {/* Message */}
          {submission.message && (
            <div className="bg-gray-50 rounded-xl p-4">
              <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-2">Message / Inquiry</h3>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{submission.message}</p>
            </div>
          )}

          {/* Deal Info */}
          {(submission.property_address || submission.purchase_price || submission.deposit_amount || submission.estimated_emd_amount || submission.closing_date || submission.target_closing_date) && (
            <div className="bg-gray-50 rounded-xl p-4 space-y-2">
              <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-3">Deal Information</h3>
              <Row label="Property Address" value={submission.property_address} />
              <Row label="Property Type" value={submission.property_type} />
              <Row label="Purchase Price" value={formatCurrency(submission.purchase_price)} />
              <Row label="Deposit Amount" value={formatCurrency(submission.deposit_amount)} />
              <Row label="Est. EMD Amount" value={formatCurrency(submission.estimated_emd_amount)} />
              <Row label="Closing Date" value={formatDate(submission.closing_date || submission.target_closing_date)} />
            </div>
          )}

          {/* Attribution */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-3">Attribution</h3>
            <Row label="Lead Source" value={submission.lead_source} />
            <Row label="Landing Page" value={submission.landing_page} />
            <Row label="Referrer" value={submission.referrer} />
            <Row label="UTM Source" value={submission.utm_source} />
            <Row label="UTM Medium" value={submission.utm_medium} />
            <Row label="UTM Campaign" value={submission.utm_campaign} />
            <Row label="UTM Content" value={submission.utm_content} />
            <Row label="UTM Term" value={submission.utm_term} />
            <Row label="Promo Code" value={submission.promo_code || submission.promo_code_used} />
          </div>

          {/* CRM Status */}
          {contact && (
            <div className="bg-gray-50 rounded-xl p-4 space-y-2">
              <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-3">CRM Status</h3>
              <Row label="Lead Status" value={contact.lead_status} />
              <Row label="Assigned Owner" value={contact.assigned_owner} />
              <Row label="Portal Status" value={portalBadge.label} />
            </div>
          )}
        </div>
      </div>

      {/* Purge confirmation dialog (SuperAdmin only) */}
      {canPurge && showPurge && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-2xl p-6 space-y-4">
            <div>
              <h3 className="text-base font-700 text-red-700 font-display">Purge Contact Submission</h3>
              <p className="text-sm text-gray-600 mt-2">
                This will hide the submission from all Admin views and future Analytics. The record
                is retained in the database for audit purposes. The CRM Contact, any Deals and
                Client Portal access are not affected. This action cannot be undone from the Admin UI.
              </p>
            </div>
            <div>
              <label className="block text-xs font-600 text-gray-600 mb-1">Reason for purge (required)</label>
              <textarea
                value={purgeReason}
                onChange={e => setPurgeReason(e.target.value)}
                disabled={purging}
                maxLength={1000}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 disabled:bg-gray-50"
              />
            </div>
            <div>
              <label className="block text-xs font-600 text-gray-600 mb-1">
                Type <span className="font-700">PURGE</span> to confirm
              </label>
              <input
                type="text"
                value={purgeConfirmText}
                onChange={e => setPurgeConfirmText(e.target.value)}
                disabled={purging}
                autoComplete="off"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 disabled:bg-gray-50"
              />
            </div>
            {purgeError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{purgeError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={closePurgeDialog}
                disabled={purging}
                className="px-4 py-2 rounded-lg text-sm font-600 border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handlePurge}
                disabled={purging || !purgeReason.trim() || purgeConfirmText !== 'PURGE'}
                className="px-4 py-2 rounded-lg text-sm font-600 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {purging ? 'Purging…' : 'Purge Submission'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value === '—') return null;
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-gray-400 w-32 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-gray-700 font-500 flex-1 break-all">{value}</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ContactSubmissionsContent() {
  const supabase = createClient();
  const { isSuperAdmin } = useAuth();
  const canPurge = isSuperAdmin();
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSubmission, setSelectedSubmission] = useState<Submission | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    search: '',
    dateFrom: '',
    dateTo: '',
    contactType: 'all',
    leadStatus: 'All',
    owner: 'All',
    leadSource: '',
    utmCampaign: '',
    promoCode: '',
    view: 'all',
  });
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('crm_contact_submissions')
      .select(`
        *,
        crm_contacts(id, first_name, last_name, lead_status, assigned_owner, portal_link_status)
      `)
      .is('purged_at', null)
      .order('submitted_at', { ascending: false })
      .limit(500);

    if (!error && data) {
      setSubmissions(data as Submission[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const setView = (view: FilterState['view']) => {
    setFilters(f => ({ ...f, view, dateFrom: '', dateTo: '' }));
  };

  const filtered = useMemo(() => {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    return submissions.filter(s => {
      const submittedAt = new Date(s.submitted_at);
      const name = `${s.first_name || ''} ${s.last_name || ''}`.toLowerCase();
      const email = s.email.toLowerCase();
      const company = (s.company_name || '').toLowerCase();
      const q = filters.search.toLowerCase();

      if (q && !name.includes(q) && !email.includes(q) && !company.includes(q)) return false;

      if (filters.view === 'new_leads' && !s.is_new_contact) return false;
      if (filters.view === 'repeat' && s.is_new_contact) return false;
      if (filters.view === 'this_week' && submittedAt < startOfWeek) return false;
      if (filters.view === 'this_month' && submittedAt < startOfMonth) return false;

      if (filters.dateFrom && submittedAt < new Date(filters.dateFrom)) return false;
      if (filters.dateTo && submittedAt > new Date(filters.dateTo + 'T23:59:59')) return false;

      if (filters.contactType === 'new' && !s.is_new_contact) return false;
      if (filters.contactType === 'existing' && s.is_new_contact) return false;

      if (filters.leadStatus !== 'All' && s.crm_contacts?.lead_status !== filters.leadStatus) return false;
      if (filters.owner !== 'All' && s.crm_contacts?.assigned_owner !== filters.owner) return false;
      if (filters.leadSource && !(s.lead_source || '').toLowerCase().includes(filters.leadSource.toLowerCase())) return false;
      if (filters.utmCampaign && !(s.utm_campaign || '').toLowerCase().includes(filters.utmCampaign.toLowerCase())) return false;
      if (filters.promoCode && !(s.promo_code || s.promo_code_used || '').toLowerCase().includes(filters.promoCode.toLowerCase())) return false;

      return true;
    });
  }, [submissions, filters]);

  const handlePurged = useCallback((id: string) => {
    setSubmissions(prev => prev.filter(s => s.id !== id));
    setSelectedSubmission(null);
    setToast('Submission purged. It is now hidden from Admin views.');
  }, []);

  const VIEW_TABS = [
    { key: 'all',        label: 'All Submissions' },
    { key: 'new_leads',  label: 'New Leads' },
    { key: 'repeat',     label: 'Repeat Inquiries' },
    { key: 'this_week',  label: 'This Week' },
    { key: 'this_month', label: 'This Month' },
  ] as const;

  return (
    <div className="p-6 space-y-5 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-700 text-gray-900 font-display">Contact Submissions</h1>
          <p className="text-sm text-gray-500 mt-0.5">All form submissions from earnestbridge.com/contact</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">{filtered.length} of {submissions.length}</span>
          <button onClick={load} className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
            <Icon name="ArrowPathIcon" size={15} className="text-gray-500" />
          </button>
        </div>
      </div>

      {/* View Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {VIEW_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setView(tab.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-600 transition-all ${
              filters.view === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <div className="col-span-2">
            <div className="relative">
              <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search name, email, company…"
                value={filters.search}
                onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
                className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
              />
            </div>
          </div>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          />
          <input
            type="date"
            value={filters.dateTo}
            onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          />
          <select
            value={filters.contactType}
            onChange={e => setFilters(f => ({ ...f, contactType: e.target.value as FilterState['contactType'] }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          >
            <option value="all">All Contacts</option>
            <option value="new">New Contacts</option>
            <option value="existing">Existing Contacts</option>
          </select>
          <select
            value={filters.leadStatus}
            onChange={e => setFilters(f => ({ ...f, leadStatus: e.target.value }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          >
            {LEAD_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
          <select
            value={filters.owner}
            onChange={e => setFilters(f => ({ ...f, owner: e.target.value }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          >
            {OWNERS.map(o => <option key={o}>{o}</option>)}
          </select>
          <input
            type="text"
            placeholder="Lead source…"
            value={filters.leadSource}
            onChange={e => setFilters(f => ({ ...f, leadSource: e.target.value }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          />
          <input
            type="text"
            placeholder="UTM Campaign…"
            value={filters.utmCampaign}
            onChange={e => setFilters(f => ({ ...f, utmCampaign: e.target.value }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          />
          <input
            type="text"
            placeholder="Promo code…"
            value={filters.promoCode}
            onChange={e => setFilters(f => ({ ...f, promoCode: e.target.value }))}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-7 h-7 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <Icon name="InboxIcon" size={32} className="text-gray-300" />
            <p className="text-sm text-gray-400">No submissions found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Contact</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Company</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Message</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Deal Info</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Source</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Owner</th>
                  <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wider">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(s => {
                  const contact = s.crm_contacts;
                  const portalBadge = PORTAL_BADGES[contact?.portal_link_status || 'none'];
                  const name = `${s.first_name || ''} ${s.last_name || ''}`.trim() || s.email;

                  return (
                    <tr
                      key={s.id}
                      onClick={() => setSelectedSubmission(s)}
                      className="hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-xs text-gray-500">{formatDateTime(s.submitted_at)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          {contact ? (
                            <Link
                              href={`/admin/crm/contacts/${contact.id}`}
                              onClick={e => e.stopPropagation()}
                              className="text-sm font-600 text-eb-green-700 hover:underline"
                            >
                              {name}
                            </Link>
                          ) : (
                            <span className="text-sm font-600 text-gray-800">{name}</span>
                          )}
                          <p className="text-xs text-gray-400">{s.email}</p>
                          {s.phone && <p className="text-xs text-gray-400">{s.phone}</p>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-600">{s.company_name || '—'}</span>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="text-xs text-gray-600 truncate">{s.message || '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-0.5">
                          {s.estimated_emd_amount && (
                            <p className="text-xs text-gray-600">EMD: {formatCurrency(s.estimated_emd_amount)}</p>
                          )}
                          {(s.closing_date || s.target_closing_date) && (
                            <p className="text-xs text-gray-500">Close: {formatDate(s.closing_date || s.target_closing_date)}</p>
                          )}
                          {!s.estimated_emd_amount && !s.closing_date && !s.target_closing_date && (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-0.5">
                          <p className="text-xs text-gray-600">{s.lead_source || '—'}</p>
                          {s.utm_source && <p className="text-xs text-gray-400">{s.utm_source}</p>}
                          {s.utm_campaign && <p className="text-xs text-gray-400">{s.utm_campaign}</p>}
                          {(s.promo_code || s.promo_code_used) && (
                            <span className="text-xs bg-eb-gold-100 text-eb-gold-700 px-1.5 py-0.5 rounded font-600">
                              {s.promo_code || s.promo_code_used}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {contact ? (
                          <div className="space-y-1">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-600 border ${STATUS_COLORS[contact.lead_status] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                              {contact.lead_status}
                            </span>
                            <div>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-500 ${portalBadge.color}`}>
                                {portalBadge.label}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">No contact</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-600">{contact?.assigned_owner || '—'}</span>
                      </td>
                      <td className="px-4 py-3">
                        {s.is_new_contact ? (
                          <span className="px-2 py-1 rounded-full text-xs font-700 bg-blue-600 text-white">NEW LEAD</span>
                        ) : (
                          <span className="px-2 py-1 rounded-full text-xs font-600 bg-purple-100 text-purple-700 border border-purple-200">EXISTING</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Submission Detail Drawer */}
      {selectedSubmission && (
        <SubmissionDrawer
          submission={selectedSubmission}
          onClose={() => setSelectedSubmission(null)}
          canPurge={canPurge}
          onPurged={handlePurged}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] px-4 py-3 rounded-lg bg-gray-900 text-white text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
