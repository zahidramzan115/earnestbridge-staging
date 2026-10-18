'use client';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';
import PortalAccessDialog from '@/components/PortalAccessDialog';

type AppStatus =
  | 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' |'funded' | 'closed' | 'conditionally_approved' | 'in_review' | 'expired';

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
  closing_date?: string | null;
  due_diligence_days?: number | null;
  app_status: AppStatus;
  submitted_at: string | null;
  created_at: string;
  identity_verified: boolean;
  days_to_funding?: number | null;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  draft:                  { label: 'Draft',           color: 'text-gray-600',    bg: 'bg-gray-100',    border: 'border-gray-200' },
  submitted:              { label: 'Submitted',       color: 'text-blue-700',    bg: 'bg-blue-100',    border: 'border-blue-200' },
  under_review:           { label: 'Under Review',    color: 'text-amber-700',   bg: 'bg-amber-100',   border: 'border-amber-200' },
  in_review:              { label: 'In Review',       color: 'text-amber-700',   bg: 'bg-amber-100',   border: 'border-amber-200' },
  conditionally_approved: { label: 'Cond. Approved',  color: 'text-teal-700',    bg: 'bg-teal-100',    border: 'border-teal-200' },
  approved:               { label: 'Approved',        color: 'text-green-700',   bg: 'bg-green-100',   border: 'border-green-200' },
  funded:                 { label: 'Funded',          color: 'text-emerald-700', bg: 'bg-emerald-100', border: 'border-emerald-200' },
  closed:                 { label: 'Closed',          color: 'text-purple-700',  bg: 'bg-purple-100',  border: 'border-purple-200' },
  rejected:               { label: 'Rejected',        color: 'text-red-700',     bg: 'bg-red-100',     border: 'border-red-200' },
  expired:                { label: 'Expired',         color: 'text-gray-500',    bg: 'bg-gray-100',    border: 'border-gray-200' },
};

const APPLICATION_STATUSES: AppStatus[] = ['draft', 'submitted', 'under_review', 'in_review', 'conditionally_approved', 'rejected', 'expired'];
const DEAL_STATUSES: AppStatus[] = ['approved', 'funded', 'closed'];

// Demo data keyed by user_id
const DEMO_USERS: Record<string, BorrowerApplication[]> = {
  'u1': [
    { id: 'demo-1', user_id: 'u1', first_name: 'Marcus', last_name: 'Thompson', email: 'marcus.thompson@email.com', phone: '(212) 555-0101', company_name: 'Thompson Capital LLC', property_address: '142 West 57th St, New York, NY 10019', property_type: 'Commercial', purchase_price: 4200000, deposit_amount: 420000, closing_date: '2026-05-15', app_status: 'under_review', submitted_at: '2026-04-01T10:30:00Z', created_at: '2026-03-28T09:00:00Z', identity_verified: true, days_to_funding: 14 },
    { id: 'demo-1b', user_id: 'u1', first_name: 'Marcus', last_name: 'Thompson', email: 'marcus.thompson@email.com', phone: '(212) 555-0101', company_name: 'Thompson Capital LLC', property_address: '350 Park Ave, New York, NY 10022', property_type: 'Commercial', purchase_price: 7800000, deposit_amount: 780000, closing_date: '2026-07-01', app_status: 'approved', submitted_at: '2026-02-10T09:00:00Z', created_at: '2026-02-08T08:00:00Z', identity_verified: true, days_to_funding: 30 },
  ],
  'u2': [
    { id: 'demo-2', user_id: 'u2', first_name: 'Priya', last_name: 'Sharma', email: 'priya.sharma@realty.com', phone: '(415) 555-0202', company_name: null, property_address: '88 Lombard St, San Francisco, CA 94111', property_type: 'Residential', purchase_price: 1850000, deposit_amount: 185000, closing_date: '2026-04-30', app_status: 'approved', submitted_at: '2026-03-20T14:00:00Z', created_at: '2026-03-18T08:00:00Z', identity_verified: true, days_to_funding: 5 },
  ],
};

function formatCurrency(val: number | null) {
  if (val == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('T')[0].split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function getInitials(first: string, last: string) {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase();
}

interface ApplicationRowProps {
  app: BorrowerApplication;
  type: 'application' | 'deal';
  onClick: () => void;
}

function ApplicationRow({ app, type, onClick }: ApplicationRowProps) {
  const statusCfg = STATUS_CONFIG[app.app_status] ?? STATUS_CONFIG.draft;
  return (
    <button
      onClick={onClick}
      className="w-full text-left group flex items-center gap-4 px-4 py-4 rounded-xl border border-gray-100 bg-white hover:border-eb-green-200 hover:bg-eb-green-50/30 hover:shadow-sm transition-all duration-150"
    >
      {/* Icon */}
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${type === 'deal' ? 'bg-emerald-100' : 'bg-blue-50'}`}>
        <Icon
          name={type === 'deal' ? 'BanknotesIcon' : 'DocumentTextIcon'}
          size={18}
          className={type === 'deal' ? 'text-emerald-700' : 'text-blue-600'}
        />
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-0.5">
          <p className="text-sm font-display font-600 text-gray-900 truncate">
            {app.property_address || 'No address provided'}
          </p>
          <span className={`text-[11px] font-display font-600 px-2 py-0.5 rounded-full border flex-shrink-0 ${statusCfg.color} ${statusCfg.bg} ${statusCfg.border}`}>
            {statusCfg.label}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-400">
          {app.property_type && <span>{app.property_type}</span>}
          {app.purchase_price && <span>Purchase: {formatCurrency(app.purchase_price)}</span>}
          {app.deposit_amount && <span>EMD: {formatCurrency(app.deposit_amount)}</span>}
          {app.due_diligence_days != null && <span>Due Diligence: {app.due_diligence_days} {app.due_diligence_days === 1 ? 'Day' : 'Days'}</span>}
        </div>
        <p className="text-[11px] text-gray-300 mt-0.5">
          {app.submitted_at ? `Submitted ${formatDate(app.submitted_at)}` : `Created ${formatDate(app.created_at)}`}
          {' · '}ID: {app.id.slice(0, 8).toUpperCase()}
        </p>
      </div>

      {/* Right: EMD + chevron */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="text-right hidden sm:block">
          <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide">EMD</p>
          <p className="text-sm font-display font-700 text-eb-green-900">{formatCurrency(app.deposit_amount)}</p>
        </div>
        <Icon name="ChevronRightIcon" size={16} className="text-gray-300 group-hover:text-eb-green-600 transition-colors" />
      </div>
    </button>
  );
}

const BorrowerProfileContent: React.FC = () => {
  const params = useParams();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const userId = params?.id as string;
  const isDemoId = userId?.startsWith('u') && DEMO_USERS[userId];

  const [allApps, setAllApps] = useState<BorrowerApplication[]>([]);
  const [authUser, setAuthUser] = useState<{ id: string; email: string; created_at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDisabled, setIsDisabled] = useState(false);
  const [accessDialogMode, setAccessDialogMode] = useState<'revoke' | 'reinstate' | null>(null);
  const { isSuperAdmin } = useAuth();
  const canManageAccess = isSuperAdmin();
  const [activeTab, setActiveTab] = useState<'applications' | 'deals'>('applications');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (isDemoId) {
        setAllApps(DEMO_USERS[userId] ?? []);
        setLoading(false);
        return;
      }

      const [appsResult, accessResult] = await Promise.all([
        supabase
          .from('borrower_applications')
          .select('id, user_id, first_name, last_name, email, phone, company_name, property_address, property_type, purchase_price, deposit_amount, due_diligence_days, app_status, submitted_at, created_at, identity_verified, days_to_funding')
          .eq('user_id', userId)
          .is('purged_at', null)
          .order('created_at', { ascending: false }),
        supabase
          .from('borrower_access')
          .select('is_disabled')
          .eq('user_id', userId)
          .maybeSingle(),
      ]);

      const apps = (appsResult.data as BorrowerApplication[]) ?? [];
      setAllApps(apps);
      setIsDisabled(accessResult.data?.is_disabled ?? false);

      // If no applications, try to fetch auth user info so we can still show the profile
      if (apps.length === 0) {
        try {
          const res = await fetch('/api/admin/list-users');
          if (res.ok) {
            const json = await res.json();
            const found = (json.users as { id: string; email: string; created_at: string }[])?.find((u) => u.id === userId) ?? null;
            setAuthUser(found);
          }
        } catch {
          // silently ignore — we'll show what we have
        }
      }
    } catch {
      setAllApps([]);
    } finally {
      setLoading(false);
    }
  }, [userId, isDemoId, supabase]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Account-wide portal access changes go through the SuperAdmin-only server API
  // (PortalAccessDialog -> POST /api/admin/portal-access/[userId]).
  const handleToggleAccess = useCallback(() => {
    setAccessDialogMode(isDisabled ? 'reinstate' : 'revoke');
  }, [isDisabled]);

  const applications = useMemo(() => allApps.filter((a) => APPLICATION_STATUSES.includes(a.app_status)), [allApps]);
  const deals = useMemo(() => allApps.filter((a) => DEAL_STATUSES.includes(a.app_status)), [allApps]);

  const borrower = allApps[0] ?? null;

  // Stats
  const totalEMD = useMemo(() => allApps.reduce((sum, a) => sum + (a.deposit_amount ?? 0), 0), [allApps]);
  const activeEMD = useMemo(() => allApps.filter((a) => a.app_status === 'funded').reduce((sum, a) => sum + (a.deposit_amount ?? 0), 0), [allApps]);
  const closedDeals = useMemo(() => allApps.filter((a) => a.app_status === 'closed').length, [allApps]);

  // Derived display values — use borrower data if available, fall back to auth user
  const displayEmail = borrower?.email ?? authUser?.email ?? '';
  const displayCreatedAt = borrower?.created_at ?? authUser?.created_at ?? '';
  const displayFirstName = borrower?.first_name ?? (authUser?.email?.split('@')[0] ?? 'Unknown');
  const displayLastName = borrower?.last_name ?? '';
  const displayPhone = borrower?.phone ?? null;
  const displayCompany = borrower?.company_name ?? null;
  const displayIdentityVerified = borrower?.identity_verified ?? false;

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading borrower profile…</p>
        </div>
      </div>
    );
  }

  // Only show "not found" if there's truly no data at all
  if (!borrower && !authUser) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <Icon name="ExclamationTriangleIcon" size={40} className="text-gray-200 mx-auto mb-3" />
          <p className="text-sm text-gray-500 font-600">Borrower not found</p>
          <button onClick={() => router.push('/admin/borrowers')} className="mt-4 text-xs text-eb-green-700 hover:underline">← Back to Borrowers</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Back nav */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => router.push('/admin/borrowers')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors"
        >
          <Icon name="ChevronLeftIcon" size={14} />
          Back to Borrowers
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-xs text-gray-400 truncate max-w-[200px]">{displayFirstName} {displayLastName}</span>
      </div>

      {/* Profile Header */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-5 flex flex-col sm:flex-row sm:items-start gap-4">
          {/* Avatar */}
          <div className="relative flex-shrink-0">
            <div className="w-16 h-16 rounded-2xl bg-eb-green-900 flex items-center justify-center">
              <span className="text-2xl font-display font-700 text-white">
                {getInitials(displayFirstName, displayLastName)}
              </span>
            </div>
            {isDisabled && (
              <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center border-2 border-white">
                <Icon name="LockClosedIcon" size={9} className="text-white" />
              </div>
            )}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h1 className="text-xl font-display font-700 text-gray-900">{displayFirstName} {displayLastName}</h1>
              {displayIdentityVerified && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                  <Icon name="ShieldCheckIcon" size={11} />
                  ID Verified
                </span>
              )}
              {isDisabled && (
                <span className="flex items-center gap-1 text-[11px] text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
                  <Icon name="LockClosedIcon" size={11} />
                  Portal Access Disabled
                </span>
              )}
              {!isDisabled && !isDemoId && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                  <Icon name="CheckCircleIcon" size={11} />
                  Portal Access Active
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              {displayEmail && <span className="flex items-center gap-1"><Icon name="EnvelopeIcon" size={11} />{displayEmail}</span>}
              {displayPhone && <span className="flex items-center gap-1"><Icon name="PhoneIcon" size={11} />{displayPhone}</span>}
              {displayCompany && <span className="flex items-center gap-1"><Icon name="BuildingOfficeIcon" size={11} />{displayCompany}</span>}
            </div>
            {displayCreatedAt && <p className="text-[11px] text-gray-400 mt-1">Member since {formatDate(displayCreatedAt)}</p>}
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 flex-shrink-0">
            {displayEmail && (
              <a
                href={`mailto:${displayEmail}`}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-all"
              >
                <Icon name="EnvelopeIcon" size={13} />
                Email Borrower
              </a>
            )}
            {canManageAccess && !isDemoId && (
            <button
              onClick={handleToggleAccess}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 rounded-xl border transition-all disabled:opacity-50 ${
                isDisabled
                  ? 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100' : 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'
              }`}
            >
              <Icon name={isDisabled ? 'LockOpenIcon' : 'LockClosedIcon'} size={13} />
              {isDisabled ? 'Reinstate Portal Access' : 'Revoke Portal Access'}
            </button>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="border-t border-gray-100 grid grid-cols-2 sm:grid-cols-4 divide-x divide-gray-100">
          {[
            { label: 'Applications', value: applications.length, icon: 'DocumentTextIcon', color: 'text-blue-600' },
            { label: 'Deals', value: deals.length, icon: 'BanknotesIcon', color: 'text-emerald-600' },
            { label: 'Active EMD', value: formatCurrency(activeEMD), icon: 'CurrencyDollarIcon', color: 'text-eb-green-700' },
            { label: 'Closed Deals', value: closedDeals, icon: 'CheckCircleIcon', color: 'text-purple-600' },
          ].map((stat) => (
            <div key={stat.label} className="flex items-center gap-3 px-5 py-4">
              <div className={`w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0`}>
                <Icon name={stat.icon as Parameters<typeof Icon>[0]['name']} size={15} className={stat.color} />
              </div>
              <div>
                <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide">{stat.label}</p>
                <p className="text-base font-display font-700 text-gray-900">{stat.value}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
        <button
          onClick={() => setActiveTab('applications')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-display font-600 transition-all ${activeTab === 'applications' ? 'bg-white text-eb-green-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <Icon name="DocumentTextIcon" size={13} />
          Applications
          {applications.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-700 ${activeTab === 'applications' ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-500'}`}>
              {applications.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('deals')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-display font-600 transition-all ${activeTab === 'deals' ? 'bg-white text-eb-green-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <Icon name="BanknotesIcon" size={13} />
          Deals
          {deals.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-700 ${activeTab === 'deals' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-500'}`}>
              {deals.length}
            </span>
          )}
        </button>
      </div>

      {/* Applications list */}
      {activeTab === 'applications' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon name="DocumentTextIcon" size={15} className="text-blue-600" />
              <h2 className="font-display font-700 text-sm text-gray-900">Applications</h2>
              <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{applications.length}</span>
            </div>
            <p className="text-xs text-gray-400">Click any row to view full details</p>
          </div>

          {applications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 bg-white rounded-2xl border border-gray-100">
              <Icon name="DocumentTextIcon" size={36} className="text-gray-200 mb-3" />
              <p className="text-sm text-gray-400 font-600">No applications yet</p>
              <p className="text-xs text-gray-300 mt-1">This borrower has no active applications.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {applications.map((app) => (
                <ApplicationRow
                  key={app.id}
                  app={app}
                  type="application"
                  onClick={() => router.push(`/admin/borrower/${userId}/application/${app.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Deals list */}
      {activeTab === 'deals' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon name="BanknotesIcon" size={15} className="text-emerald-600" />
              <h2 className="font-display font-700 text-sm text-gray-900">Deals</h2>
              <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{deals.length}</span>
            </div>
            <p className="text-xs text-gray-400">Click any row to view full details</p>
          </div>

          {deals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 bg-white rounded-2xl border border-gray-100">
              <Icon name="BanknotesIcon" size={36} className="text-gray-200 mb-3" />
              <p className="text-sm text-gray-400 font-600">No deals found</p>
              <p className="text-xs text-gray-300 mt-1">Deals appear here once an application is approved.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {deals.map((deal) => (
                <ApplicationRow
                  key={deal.id}
                  app={deal}
                  type="deal"
                  onClick={() => router.push(`/admin/borrower/${userId}/application/${deal.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {accessDialogMode && canManageAccess && (
        <PortalAccessDialog
          mode={accessDialogMode}
          userId={userId}
          displayName={`${displayFirstName} ${displayLastName}`.trim()}
          onClose={() => setAccessDialogMode(null)}
          onSuccess={(disabled) => {
            setIsDisabled(disabled);
            setAccessDialogMode(null);
          }}
        />
      )}
    </div>
  );
};

export default BorrowerProfileContent;
