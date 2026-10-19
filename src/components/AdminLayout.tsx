'use client';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';
import CRMGlobalSearch from '@/components/CRMGlobalSearch';
import { createClient } from '@/lib/supabase/client';

interface AdminNavItem {
  label: string;
  icon: string;
  href: string;
  /** Additional path prefixes that should activate this item */
  matchPrefixes?: string[];
  description?: string;
  badge?: number;
}

// WORKSPACE — primary destinations
const WORKSPACE_NAV: AdminNavItem[] = [
  {
    label: 'Home',
    icon: 'Squares2X2Icon',
    href: '/admin/overview',
    description: 'Overview & KPIs',
  },
  {
    label: 'Deals',
    icon: 'BriefcaseIcon',
    href: '/admin/deals',
    // Deal detail pages (/admin/borrower/[id]/application/[appId]) also highlight Deals
    description: 'Deals pipeline',
  },
  {
    label: 'Clients',
    icon: 'UsersIcon',
    href: '/admin/borrowers',
    matchPrefixes: ['/admin/borrowers', '/admin/borrower'],
    description: 'Client portal accounts',
  },
];

// CRM — contacts, tasks and submissions
const CRM_NAV: AdminNavItem[] = [
  {
    label: 'Contacts',
    icon: 'UserGroupIcon',
    href: '/admin/crm/contacts',
    description: 'CRM contacts & leads',
  },
  {
    label: 'Tasks',
    icon: 'CheckCircleIcon',
    href: '/admin/crm/tasks',
    description: 'Follow-ups & tasks',
  },
  {
    label: 'Submissions',
    icon: 'InboxArrowDownIcon',
    href: '/admin/crm/submissions',
    description: 'Contact form submissions',
  },
];

// OPERATIONS — secondary / audit views
const OPERATIONS_NAV: AdminNavItem[] = [
  {
    label: 'Documents',
    icon: 'DocumentMagnifyingGlassIcon',
    href: '/admin/documents',
    description: 'Document review queue',
  },
];

// SYSTEM — admin configuration
const SYSTEM_NAV: AdminNavItem[] = [
  {
    label: 'Audit Log',
    icon: 'ClipboardDocumentListIcon',
    href: '/admin/audit-log',
    description: 'Compliance & access trail',
  },
  {
    label: 'Settings',
    icon: 'Cog6ToothIcon',
    href: '/admin/settings',
    description: 'Invoice & payment settings',
  },
];

interface AdminLayoutProps {
  children: React.ReactNode;
  activePath?: string;
}

export default function AdminLayout({ children, activePath }: AdminLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, loading, isAdmin, isSuperAdmin } = useAuth();
  const router = useRouter();

  // Submitted deal count for Home badge
  const [submittedCount, setSubmittedCount] = useState(0);

  useEffect(() => {
    if (loading) return;
    if (!user || !isAdmin()) return;
    const supabase = createClient();
    supabase
      .from('borrower_applications')
      .select('*', { count: 'exact', head: true })
      .is('purged_at', null)
      .eq('app_status', 'submitted')
      .then(({ count }) => {
        setSubmittedCount(count ?? 0);
      });
  }, [user, loading, isAdmin]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!isAdmin()) {
      router.replace('/dashboard-home');
    }
  }, [user, loading, isAdmin, router]);

  const isActive = (item: AdminNavItem) => {
    if (!activePath) return false;
    const prefixes = item.matchPrefixes ?? [item.href];
    return prefixes.some(
      (prefix) => activePath === prefix || activePath.startsWith(prefix + '/')
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Verifying access…</p>
        </div>
      </div>
    );
  }

  if (!user || !isAdmin()) return null;

  const adminName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Admin';

  const NavLink = ({
    item,
    mobile = false,
    activeStyle = 'workspace',
    badgeCount = 0,
  }: {
    item: AdminNavItem;
    mobile?: boolean;
    activeStyle?: 'workspace' | 'default';
    badgeCount?: number;
  }) => {
    const active = isActive(item);
    const activeClass =
      activeStyle === 'workspace' ?'bg-eb-gold-500/15 text-eb-gold-300' :'bg-white/10 text-white';
    return (
      <Link
        href={item.href}
        onClick={mobile ? () => setMobileOpen(false) : undefined}
        className={`
          group flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-all duration-150
          ${active ? activeClass : 'text-eb-green-200 hover:bg-white/5 hover:text-white'}
          ${sidebarCollapsed && !mobile ? 'justify-center' : ''}
        `}
        title={sidebarCollapsed && !mobile ? item.label : undefined}
      >
        <Icon
          name={item.icon as Parameters<typeof Icon>[0]['name']}
          size={18}
          className={`flex-shrink-0 transition-colors ${
            active ? 'text-eb-gold-400' : 'text-eb-green-300 group-hover:text-eb-gold-400'
          }`}
        />
        {(!sidebarCollapsed || mobile) && (
          <>
            <span className="flex-1 truncate">{item.label}</span>
            {badgeCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-500 text-white text-[10px] font-700 tabular-nums leading-none">
                {badgeCount}
              </span>
            )}
          </>
        )}
        {sidebarCollapsed && !mobile && badgeCount > 0 && (
          <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-orange-500 rounded-full" />
        )}
      </Link>
    );
  };

  const SectionLabel = ({ label, mobile = false }: { label: string; mobile?: boolean }) => {
    if (sidebarCollapsed && !mobile) {
      return <div className="px-2 mb-1.5 flex justify-center"><div className="w-4 h-px bg-eb-green-700" /></div>;
    }
    return (
      <p className="px-2 mb-1.5 text-[10px] font-600 uppercase tracking-widest text-eb-green-400 font-display">
        {label}
      </p>
    );
  };

  const SidebarContent = ({ mobile = false }: { mobile?: boolean }) => (
    <>
      {/* Logo / Header */}
      <div
        className={`flex items-center h-16 border-b border-eb-green-800 px-3 flex-shrink-0 ${
          sidebarCollapsed && !mobile ? 'justify-center' : 'gap-2'
        }`}
      >
        <AppLogo size={32} className="flex-shrink-0" />
        {(!sidebarCollapsed || mobile) && (
          <div className="flex flex-col min-w-0">
            <span className="font-display text-white font-700 text-sm tracking-tight truncate leading-tight">
              EarnestBridge
            </span>
            <span className="text-eb-gold-400 text-[10px] font-600 uppercase tracking-widest leading-tight">
              CRM
            </span>
          </div>
        )}
        {mobile && (
          <button
            onClick={() => setMobileOpen(false)}
            className="ml-auto p-1.5 rounded-lg text-eb-green-300 hover:bg-white/5 hover:text-white transition-all"
          >
            <Icon name="XMarkIcon" size={20} />
          </button>
        )}
      </div>

      {/* Admin badge */}
      {(!sidebarCollapsed || mobile) && (
        <div className="mx-3 mt-4 mb-2 px-3 py-2 rounded-xl bg-eb-gold-500/10 border border-eb-gold-500/20 flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-eb-gold-500/20 flex items-center justify-center flex-shrink-0">
            <Icon name="ShieldCheckIcon" size={14} className="text-eb-gold-400" />
          </div>
          <div className="min-w-0">
            <p className="text-eb-gold-300 text-[10px] font-600 uppercase tracking-widest leading-tight">
              Admin Access
            </p>
            <p className="text-white text-xs font-medium truncate leading-tight mt-0.5">
              {adminName}
            </p>
          </div>
        </div>
      )}
      {sidebarCollapsed && !mobile && (
        <div className="mx-auto mt-4 mb-2 w-8 h-8 rounded-full bg-eb-gold-500/20 flex items-center justify-center">
          <Icon name="ShieldCheckIcon" size={14} className="text-eb-gold-400" />
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin py-3 px-2">
        {/* Global search */}
        {(!sidebarCollapsed || mobile) && (
          <div className="mb-3">
            <CRMGlobalSearch />
          </div>
        )}

        {/* ── WORKSPACE ── */}
        <SectionLabel label="Workspace" mobile={mobile} />
        <ul className="space-y-0.5 mb-4">
          {WORKSPACE_NAV.map((item) => (
            <li key={item.href} className="relative">
              <NavLink
                item={item}
                mobile={mobile}
                activeStyle="workspace"
                badgeCount={item.href === '/admin/overview' ? submittedCount : 0}
              />
            </li>
          ))}
        </ul>

        {/* ── CRM ── */}
        <div className="my-3 border-t border-eb-green-800" />
        <SectionLabel label="CRM" mobile={mobile} />
        <ul className="space-y-0.5 mb-4">
          {CRM_NAV.map((item) => (
            <li key={item.href}>
              <NavLink item={item} mobile={mobile} activeStyle="workspace" />
            </li>
          ))}
        </ul>

        {/* ── OPERATIONS ── */}
        <div className="my-3 border-t border-eb-green-800" />
        <SectionLabel label="Operations" mobile={mobile} />
        <ul className="space-y-0.5 mb-4">
          {OPERATIONS_NAV.map((item) => (
            <li key={item.href}>
              <NavLink item={item} mobile={mobile} activeStyle="workspace" />
            </li>
          ))}
        </ul>

        {/* ── SYSTEM ── */}
        <div className="my-3 border-t border-eb-green-800" />
        <SectionLabel label="System" mobile={mobile} />
        <ul className="space-y-0.5">
          {SYSTEM_NAV.map((item) => (
            <li key={item.href}>
              <NavLink item={item} mobile={mobile} activeStyle="default" />
            </li>
          ))}
          {isSuperAdmin() && (
            <li>
              <NavLink
                item={{
                  label: 'Admin Users',
                  icon: 'UsersIcon',
                  href: '/admin/users',
                  description: 'Manage Admin access',
                }}
                mobile={mobile}
                activeStyle="default"
              />
            </li>
          )}
          <li>
            <Link
              href="/dashboard-home"
              onClick={mobile ? () => setMobileOpen(false) : undefined}
              className={`group flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium text-eb-green-200 hover:bg-white/5 hover:text-white transition-all duration-150 ${
                sidebarCollapsed && !mobile ? 'justify-center' : ''
              }`}
              title={sidebarCollapsed && !mobile ? 'Borrower View' : undefined}
            >
              <Icon
                name="ArrowLeftCircleIcon"
                size={18}
                className="flex-shrink-0 text-eb-green-300 group-hover:text-eb-gold-400 transition-colors"
              />
              {(!sidebarCollapsed || mobile) && (
                <span className="truncate">Borrower View</span>
              )}
            </Link>
          </li>
          <li>
            <SignOutButton collapsed={sidebarCollapsed} mobile={mobile} />
          </li>
        </ul>
      </nav>

      {/* Collapse toggle (desktop only) */}
      {!mobile && (
        <div className="border-t border-eb-green-800 p-2">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-full flex items-center justify-center p-2 rounded-lg text-eb-green-300 hover:bg-white/5 hover:text-white transition-all duration-150"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <Icon
              name={sidebarCollapsed ? 'ChevronRightIcon' : 'ChevronLeftIcon'}
              size={16}
            />
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:flex flex-col bg-eb-green-900 border-r border-eb-green-800 transition-all duration-300 ease-in-out flex-shrink-0 z-20 ${
          sidebarCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-eb-green-900 flex flex-col lg:hidden transition-transform duration-300 ease-in-out ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarContent mobile />
      </aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Admin topbar */}
        <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 sm:px-6 flex-shrink-0 z-10">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-all"
            >
              <Icon name="Bars3Icon" size={20} />
            </button>
            <div className="hidden sm:flex items-center gap-2">
              <span className="text-xs font-600 uppercase tracking-widest text-gray-400 font-display">
                Admin CRM
              </span>
              <span className="text-gray-300">·</span>
              <span className="text-xs text-gray-500 font-medium">EarnestBridge</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-eb-gold-50 border border-eb-gold-200">
              <div className="w-5 h-5 rounded-full bg-eb-gold-500/20 flex items-center justify-center">
                <Icon name="ShieldCheckIcon" size={11} className="text-eb-gold-600" />
              </div>
              <span className="text-xs font-600 text-eb-gold-700 hidden sm:block">
                {adminName}
              </span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto scrollbar-thin">{children}</main>
      </div>
    </div>
  );
}

function SignOutButton({ collapsed, mobile }: { collapsed: boolean; mobile: boolean }) {
  const { signOut } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch {
      // ignore
    } finally {
      router.replace('/login');
    }
  };

  return (
    <button
      onClick={handleSignOut}
      className={`w-full group flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium text-eb-green-200 hover:bg-red-500/10 hover:text-red-300 transition-all duration-150 ${
        collapsed && !mobile ? 'justify-center' : ''
      }`}
      title={collapsed && !mobile ? 'Sign Out' : undefined}
    >
      <Icon
        name="ArrowRightOnRectangleIcon"
        size={18}
        className="flex-shrink-0 text-eb-green-300 group-hover:text-red-400 transition-colors"
      />
      {(!collapsed || mobile) && <span className="truncate">Sign Out</span>}
    </button>
  );
}
