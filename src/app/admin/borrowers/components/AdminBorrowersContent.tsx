'use client';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';
import PortalAccessDialog from '@/components/PortalAccessDialog';

type AppStatus = 'application' | 'under_review' | 'approved' | 'in_progress' | 'funded' | 'closed' | 'rejected';

interface BorrowerApplication {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_name: string | null;
  deposit_amount: number | null;
  app_status: AppStatus;
  created_at: string;
}

interface AuthUserRecord {
  id: string;
  email: string;
  created_at: string;
  full_name?: string;
  email_confirmed_at?: string | null;
  email_verified?: boolean;
}

interface UserRow {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_name: string | null;
  numberOfApplications: number;
  numberOfDeals: number;
  activeEmdFunded: number;
  lifetimeEmdFunded: number;
  dateJoined: string;
  latestAppId: string;
  // true = Email Verified, false = Pending Email Verification, null = Auth record unavailable
  emailVerified: boolean | null;
}

// Statuses that are "Applications" (not yet a deal)
const APPLICATION_STATUSES: AppStatus[] = [
  'application',
  'under_review',
  'rejected',
];

// Statuses that are "Deals" (approved or beyond)
const DEAL_STATUSES: AppStatus[] = ['approved', 'in_progress', 'funded', 'closed'];


function formatCurrency(val: number) {
  if (val === 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(val);
}

function formatDate(dateStr: string) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('T')[0].split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function getInitials(first: string, last: string) {
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

function splitFullName(fullName: string | undefined, email: string): { first: string; last: string } {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return { first: email.split('@')[0] ?? email, last: '' };
  const parts = trimmed.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function aggregateByUser(apps: BorrowerApplication[], authUsers: AuthUserRecord[]): UserRow[] {
  const map = new Map<string, BorrowerApplication[]>();
  apps.forEach((a) => {
    if (!map.has(a.user_id)) map.set(a.user_id, []);
    map.get(a.user_id)!.push(a);
  });

  const rows: UserRow[] = [];

  // Build a set of auth user IDs for quick lookup
  const authUserMap = new Map<string, AuthUserRecord>();
  authUsers.forEach((u) => authUserMap.set(u.id, u));

  // Collect all unique user IDs: from auth users + from applications
  const allUserIds = new Set<string>([
    ...authUsers.map((u) => u.id),
    ...apps.map((a) => a.user_id).filter(Boolean),
  ]);

  allUserIds.forEach((userId) => {
    const userApps = map.get(userId) ?? [];
    const authUser = authUserMap.get(userId);

    if (userApps.length === 0 && authUser) {
      // Auth user with no applications — Auth is authoritative for registered accounts
      const { first, last } = splitFullName(authUser.full_name, authUser.email);
      rows.push({
        user_id: authUser.id,
        first_name: first,
        last_name: last,
        email: authUser.email,
        phone: '',
        company_name: null,
        numberOfApplications: 0,
        numberOfDeals: 0,
        activeEmdFunded: 0,
        lifetimeEmdFunded: 0,
        dateJoined: authUser.created_at,
        latestAppId: '',
        emailVerified: !!authUser.email_confirmed_at || authUser.email_verified === true,
      });
      return;
    }

    if (userApps.length === 0) return; // No apps and no auth record — skip

    // Sort by created_at ascending to find earliest (date joined)
    const sorted = [...userApps].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const earliest = sorted[0];
    // Latest app for navigation
    const latest = [...userApps].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];

    const numberOfApplications = userApps.filter((a) =>
      APPLICATION_STATUSES.includes(a.app_status)
    ).length;

    const numberOfDeals = userApps.filter((a) =>
      DEAL_STATUSES.includes(a.app_status)
    ).length;

    // Active EMD Funded = deals with status "funded"
    const activeEmdFunded = userApps
      .filter((a) => a.app_status === 'funded' && a.deposit_amount)
      .reduce((sum, a) => sum + (a.deposit_amount ?? 0), 0);

    // Lifetime EMD Funded = deals with status "closed"
    const lifetimeEmdFunded = userApps
      .filter((a) => a.app_status === 'closed' && a.deposit_amount)
      .reduce((sum, a) => sum + (a.deposit_amount ?? 0), 0);

    rows.push({
      user_id: userId,
      first_name: earliest.first_name,
      last_name: earliest.last_name,
      email: earliest.email,
      phone: earliest.phone,
      company_name: earliest.company_name,
      numberOfApplications,
      numberOfDeals,
      activeEmdFunded,
      lifetimeEmdFunded,
      dateJoined: authUser?.created_at ?? earliest.created_at,
      latestAppId: latest.id,
      emailVerified: authUser
        ? !!authUser.email_confirmed_at || authUser.email_verified === true
        : null,
    });
  });

  // Sort by date joined descending (newest users first)
  return rows.sort(
    (a, b) => new Date(b.dateJoined).getTime() - new Date(a.dateJoined).getTime()
  );
}

export default function AdminBorrowersContent() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { isSuperAdmin } = useAuth();
  const canManageAccess = isSuperAdmin();

  const [applications, setApplications] = useState<BorrowerApplication[]>([]);
  const [authUsers, setAuthUsers] = useState<AuthUserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Map of user_id -> is_disabled
  const [disabledMap, setDisabledMap] = useState<Record<string, boolean>>({});
  const [accessDialog, setAccessDialog] = useState<{ userId: string; name: string; mode: 'revoke' | 'reinstate' } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchBorrowers = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [appsResult, accessResult, usersResult] = await Promise.all([
        supabase
          .from('borrower_applications')
          .select(
            'id, user_id, first_name, last_name, email, phone, company_name, deposit_amount, app_status, created_at'
          )
          .is('purged_at', null)
          .order('created_at', { ascending: false }),
        supabase
          .from('borrower_access')
          .select('user_id, is_disabled'),
        // Do NOT swallow failures: a failed Auth lookup must surface as an error,
        // never as an apparently valid empty user list.
        fetch('/api/admin/list-users').then(async (r) => {
          const json = await r.json().catch(() => null);
          if (!r.ok || !json || !Array.isArray(json.users)) {
            throw new Error(
              (json && typeof json.error === 'string' && json.error) ||
                'Unable to load registered users.'
            );
          }
          return json as { users: AuthUserRecord[] };
        }),
      ]);

      if (appsResult.error) throw appsResult.error;
      setApplications(appsResult.data || []);
      setAuthUsers(usersResult.users);

      // Build disabled map
      const map: Record<string, boolean> = {};
      (accessResult.data || []).forEach((row: { user_id: string; is_disabled: boolean }) => {
        map[row.user_id] = row.is_disabled;
      });
      setDisabledMap(map);
    } catch (err: unknown) {
      setApplications([]);
      setAuthUsers([]);
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : 'Unable to load borrowers. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    fetchBorrowers();
  }, [fetchBorrowers]);

  // Account-wide portal access changes go through the SuperAdmin-only server API
  // (PortalAccessDialog -> POST /api/admin/portal-access/[userId]).
  const handleToggleDisable = useCallback(
    (e: React.MouseEvent, userId: string, currentlyDisabled: boolean, name: string) => {
      e.stopPropagation();
      setAccessDialog({ userId, name, mode: currentlyDisabled ? 'reinstate' : 'revoke' });
    },
    []
  );

  const userRows = useMemo(() => aggregateByUser(applications, authUsers), [applications, authUsers]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return userRows;
    return userRows.filter(
      (u) =>
        `${u.first_name} ${u.last_name}`.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.company_name ?? '').toLowerCase().includes(q)
    );
  }, [userRows, searchQuery]);

  const handleViewUser = useCallback(
    (row: UserRow) => {
      router.push(`/admin/borrower/${row.user_id}`);
    },
    [router]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading borrowers…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display font-700 text-gray-900 text-2xl sm:text-3xl">Clients</h1>
          <p className="text-sm text-gray-400 mt-1">
            {userRows.length} borrower{userRows.length !== 1 ? 's' : ''} · {applications.filter(a => APPLICATION_STATUSES.includes(a.app_status)).length} application{applications.filter(a => APPLICATION_STATUSES.includes(a.app_status)).length !== 1 ? 's' : ''} · {applications.filter(a => DEAL_STATUSES.includes(a.app_status)).length} deal{applications.filter(a => DEAL_STATUSES.includes(a.app_status)).length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={fetchBorrowers}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-eb-green-900 text-white text-sm font-medium hover:bg-eb-green-800 transition-colors self-start sm:self-auto"
        >
          <Icon name="ArrowPathIcon" size={15} />
          Refresh
        </button>
      </div>

      {/* Search Bar */}
      {loadError && (
        <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 flex items-start gap-3" role="alert">
          <Icon name="ExclamationTriangleIcon" size={18} className="text-red-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-display font-600 text-red-800">Could not load borrowers</p>
            <p className="text-xs text-red-700 mt-0.5">{loadError} The list shown below may be incomplete.</p>
          </div>
          <button
            onClick={fetchBorrowers}
            className="text-xs font-medium text-red-700 hover:text-red-900 underline flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 mb-5">
        <div className="relative">
          <Icon
            name="MagnifyingGlassIcon"
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search by name, email, or company…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-eb-green-700/20 focus:border-eb-green-700 transition-all placeholder-gray-400"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <Icon name="XMarkIcon" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Results count */}
      {searchQuery && (
        <p className="text-xs text-gray-400 mb-3 px-1">
          Showing {filtered.length} of {userRows.length} borrowers
        </p>
      )}

      {/* Table */}
      {filtered.length === 0 && loadError ? null : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-12 text-center">
          <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <Icon name="UserGroupIcon" size={22} className="text-gray-400" />
          </div>
          <p className="font-display font-600 text-gray-700 mb-1">No borrowers found</p>
          <p className="text-sm text-gray-400">
            {searchQuery ? 'Try adjusting your search.' : 'No borrower accounts yet.'}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden lg:block bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="text-left px-5 py-3.5 text-xs font-display font-600 uppercase tracking-wider text-gray-500">
                    Borrower
                  </th>
                  <th className="text-center px-4 py-3.5 text-xs font-display font-600 uppercase tracking-wider text-gray-500">
                    Applications
                  </th>
                  <th className="text-center px-4 py-3.5 text-xs font-display font-600 uppercase tracking-wider text-gray-500">
                    Deals
                  </th>
                  <th className="text-right px-4 py-3.5 text-xs font-display font-600 uppercase tracking-wider text-gray-500">
                    Active EMD Funded
                  </th>
                  <th className="text-right px-4 py-3.5 text-xs font-display font-600 uppercase tracking-wider text-gray-500">
                    Lifetime EMD Funded
                  </th>
                  <th className="text-left px-4 py-3.5 text-xs font-display font-600 uppercase tracking-wider text-gray-500">
                    Date Joined
                  </th>
                  <th className="text-right px-5 py-3.5 text-xs font-display font-600 uppercase tracking-wider text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((u) => {
                  const isDisabled = disabledMap[u.user_id] === true;
                  const isToggling = togglingId === u.user_id;
                  return (
                    <tr
                      key={u.user_id}
                      onClick={() => handleViewUser(u)}
                      className={`hover:bg-eb-green-50/40 cursor-pointer transition-colors group ${isDisabled ? 'opacity-60' : ''}`}
                    >
                      {/* Borrower */}
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isDisabled ? 'bg-gray-400' : 'bg-eb-green-900'}`}>
                            <span className="text-xs font-display font-700 text-white">
                              {getInitials(u.first_name, u.last_name)}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="font-medium text-gray-900 truncate group-hover:text-eb-green-900 transition-colors">
                                {u.first_name} {u.last_name}
                              </p>
                              {isDisabled && (
                                <span className="text-[10px] font-display font-600 px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 border border-red-200 flex-shrink-0">
                                  Portal Access Disabled
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-400 truncate">{u.email}</p>
                            {u.company_name && (
                              <p className="text-xs text-gray-400 truncate">{u.company_name}</p>
                            )}
                            <EmailStatusBadge verified={u.emailVerified} />
                          </div>
                        </div>
                      </td>

                      {/* Applications */}
                      <td className="px-4 py-4 text-center">
                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50 text-blue-700 font-display font-700 text-sm tabular-nums">
                          {u.numberOfApplications}
                        </span>
                      </td>

                      {/* Deals */}
                      <td className="px-4 py-4 text-center">
                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-eb-green-900/10 text-eb-green-900 font-display font-700 text-sm tabular-nums">
                          {u.numberOfDeals}
                        </span>
                      </td>

                      {/* Active EMD Funded */}
                      <td className="px-4 py-4 text-right">
                        {u.activeEmdFunded > 0 ? (
                          <span className="font-display font-600 text-emerald-700 tabular-nums">
                            {formatCurrency(u.activeEmdFunded)}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </td>

                      {/* Lifetime EMD Funded */}
                      <td className="px-4 py-4 text-right">
                        {u.lifetimeEmdFunded > 0 ? (
                          <span className="font-display font-600 text-gray-900 tabular-nums">
                            {formatCurrency(u.lifetimeEmdFunded)}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </td>

                      {/* Date Joined */}
                      <td className="px-4 py-4 text-gray-600 tabular-nums text-xs">
                        {formatDate(u.dateJoined)}
                      </td>

                      {/* Actions */}
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleViewUser(u);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-eb-green-900 text-white text-xs font-medium hover:bg-eb-green-800 transition-colors"
                            title="View borrower details"
                          >
                            <Icon name="EyeIcon" size={13} />
                            View
                            <Icon name="ChevronRightIcon" size={11} className="opacity-70" />
                          </button>
                          {canManageAccess && (
                          <button
                            onClick={(e) => handleToggleDisable(e, u.user_id, isDisabled, `${u.first_name} ${u.last_name}`)}
                            disabled={isToggling}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                              isDisabled
                                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200' :'bg-red-50 text-red-700 hover:bg-red-100 border border-red-200'
                            }`}
                            title={isDisabled ? 'Reinstate Portal Access' : 'Revoke Portal Access'}
                          >
                            {isToggling ? (
                              <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Icon name={isDisabled ? 'LockOpenIcon' : 'LockClosedIcon'} size={13} />
                            )}
                            {isDisabled ? 'Reinstate' : 'Revoke'}
                          </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3">
            {filtered.map((u) => {
              const isDisabled = disabledMap[u.user_id] === true;
              const isToggling = togglingId === u.user_id;
              return (
                <div
                  key={u.user_id}
                  onClick={() => handleViewUser(u)}
                  className={`bg-white rounded-2xl shadow-card border border-gray-100 p-4 cursor-pointer hover:border-eb-green-200 hover:shadow-md transition-all ${isDisabled ? 'opacity-70' : ''}`}
                >
                  {/* Top row */}
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isDisabled ? 'bg-gray-400' : 'bg-eb-green-900'}`}>
                      <span className="text-xs font-display font-700 text-white">
                        {getInitials(u.first_name, u.last_name)}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-medium text-gray-900 truncate">
                          {u.first_name} {u.last_name}
                        </p>
                        {isDisabled && (
                          <span className="text-[10px] font-display font-600 px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 border border-red-200 flex-shrink-0">
                            Portal Access Disabled
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 truncate">{u.email}</p>
                      {u.company_name && (
                        <p className="text-xs text-gray-400 truncate">{u.company_name}</p>
                      )}
                      <EmailStatusBadge verified={u.emailVerified} />
                    </div>
                    <Icon name="ChevronRightIcon" size={16} className="text-gray-300 flex-shrink-0" />
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4 text-xs">
                    <div>
                      <p className="text-gray-400 font-medium mb-0.5">Applications</p>
                      <p className="font-display font-700 text-blue-700 tabular-nums text-base">
                        {u.numberOfApplications}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-400 font-medium mb-0.5">Deals</p>
                      <p className="font-display font-700 text-eb-green-900 tabular-nums text-base">
                        {u.numberOfDeals}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-400 font-medium mb-0.5">Date Joined</p>
                      <p className="text-gray-700 tabular-nums">{formatDate(u.dateJoined)}</p>
                    </div>
                    <div>
                      <p className="text-gray-400 font-medium mb-0.5">Active EMD Funded</p>
                      <p className={`font-display font-600 tabular-nums ${u.activeEmdFunded > 0 ? 'text-emerald-700' : 'text-gray-400'}`}>
                        {u.activeEmdFunded > 0 ? formatCurrency(u.activeEmdFunded) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-400 font-medium mb-0.5">Lifetime EMD Funded</p>
                      <p className={`font-display font-600 tabular-nums ${u.lifetimeEmdFunded > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                        {u.lifetimeEmdFunded > 0 ? formatCurrency(u.lifetimeEmdFunded) : '—'}
                      </p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="pt-3 border-t border-gray-100 flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleViewUser(u);
                      }}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-eb-green-900 text-white text-xs font-medium hover:bg-eb-green-800 transition-colors"
                    >
                      <Icon name="EyeIcon" size={13} />
                      View Details
                    </button>
                    {canManageAccess && (
                    <button
                      onClick={(e) => handleToggleDisable(e, u.user_id, isDisabled, `${u.first_name} ${u.last_name}`)}
                      disabled={isToggling}
                      className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        isDisabled
                          ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200' :'bg-red-50 text-red-700 hover:bg-red-100 border border-red-200'
                      }`}
                    >
                      {isToggling ? (
                        <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Icon name={isDisabled ? 'LockOpenIcon' : 'LockClosedIcon'} size={13} />
                      )}
                      {isDisabled ? 'Reinstate Access' : 'Revoke Access'}
                    </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {accessDialog && (
        <PortalAccessDialog
          mode={accessDialog.mode}
          userId={accessDialog.userId}
          displayName={accessDialog.name}
          onClose={() => setAccessDialog(null)}
          onSuccess={(disabled) => {
            setDisabledMap((prev) => ({ ...prev, [accessDialog.userId]: disabled }));
            setAccessDialog(null);
          }}
        />
      )}

      {/* Footer summary */}
      {filtered.length > 0 && (
        <p className="text-xs text-gray-400 text-center mt-4">
          {filtered.length} borrower{filtered.length !== 1 ? 's' : ''} displayed
        </p>
      )}
    </div>
  );
}

// Email Status is derived from Supabase Auth email_confirmed_at and is independent of
// Portal Link Status and Portal Access (Active/Disabled).
function EmailStatusBadge({ verified }: { verified: boolean | null }) {
  if (verified === null) return null;
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className="text-[10px] text-gray-400">Email Status:</span>
      {verified ? (
        <span className="text-[10px] font-display font-600 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex-shrink-0">
          Email Verified
        </span>
      ) : (
        <span className="text-[10px] font-display font-600 px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 flex-shrink-0">
          Pending Email Verification
        </span>
      )}
    </div>
  );
}
