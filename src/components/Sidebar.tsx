'use client';
import React from 'react';
import Link from 'next/link';
import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';

interface NavItem {
  label: string;
  icon: string;
  href: string;
  badge?: number;
  group?: string;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', icon: 'Squares2X2Icon', href: '/dashboard-home', group: 'main' },
  { label: 'New Deal', icon: 'PlusCircleIcon', href: '/apply', group: 'main' },
  { label: 'Deals', icon: 'BriefcaseIcon', href: '/deals', group: 'main' },
  { label: 'Documents', icon: 'FolderOpenIcon', href: '/documents', group: 'main' },
  { label: 'Deadlines', icon: 'CalendarDaysIcon', href: '/deadlines', group: 'main' },
  { label: 'Notifications', icon: 'BellIcon', href: '/notifications', group: 'main' },
  { label: 'Admin Panel', icon: 'ShieldCheckIcon', href: '/admin/overview', group: 'main', adminOnly: true },
  { label: 'Account Settings', icon: 'UserCircleIcon', href: '/profile-account-settings', group: 'account' },
  { label: 'Help & Support', icon: 'QuestionMarkCircleIcon', href: '/help', group: 'account' },
];

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapse: () => void;
  onMobileClose: () => void;
  activePath?: string;
}

export default function Sidebar({
  collapsed,
  mobileOpen,
  onToggleCollapse,
  onMobileClose,
  activePath,
}: SidebarProps) {
  const isActive = (href: string) => {
    if (!activePath) return false;
    // For admin, match any /admin/* path
    if (href === '/admin/overview') return activePath.startsWith('/admin');
    return activePath === href;
  };
  const { isAdmin, signOut } = useAuth();
  const router = useRouter();
  const adminUser = isAdmin();

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch {
      // ignore
    } finally {
      router.replace('/login');
    }
  };

  const visibleItems = NAV_ITEMS.filter((i) => !i.adminOnly || adminUser);
  const mainItems = visibleItems.filter((i) => i.group === 'main');
  const accountItems = visibleItems.filter((i) => i.group === 'account');

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`
          hidden lg:flex flex-col bg-eb-green-900 border-r border-eb-green-800
          transition-all duration-300 ease-in-out flex-shrink-0 z-20
          ${collapsed ? 'w-16' : 'w-60'}
        `}
      >
        {/* Logo */}
        <div className={`flex items-center h-16 border-b border-eb-green-800 px-3 flex-shrink-0 ${collapsed ? 'justify-center' : 'gap-2'}`}>
          <AppLogo size={32} className="flex-shrink-0" />
          {!collapsed && (
            <span className="font-display text-white font-700 text-base tracking-tight truncate">
              EarnestBridge
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto scrollbar-thin py-4 px-2">
          {/* Main section */}
          {!collapsed && (
            <p className="px-2 mb-1 text-[10px] font-600 uppercase tracking-widest text-eb-green-300 font-display">
              Portfolio
            </p>
          )}
          <ul className="space-y-0.5 mb-6">
            {mainItems.map((item) => (
              <li key={`nav-${item.label}`}>
                <Link
                  href={item.href}
                  className={`
                    group flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium transition-all duration-150
                    ${isActive(item.href)
                      ? 'bg-white/10 text-white' :'text-eb-green-200 hover:bg-white/5 hover:text-white'
                    }
                    ${collapsed ? 'justify-center' : ''}
                  `}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon
                    name={item.icon as Parameters<typeof Icon>[0]['name']}
                    size={18}
                    className={`flex-shrink-0 ${isActive(item.href) ? 'text-eb-gold-400' : 'text-eb-green-300 group-hover:text-eb-gold-400'} transition-colors`}
                  />
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge !== undefined && item.badge > 0 && (
                        <span className="bg-eb-gold-500 text-white text-[10px] font-700 font-display px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none">
                          {item.badge}
                        </span>
                      )}
                    </>
                  )}
                  {collapsed && item.badge !== undefined && item.badge > 0 && (
                    <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-eb-gold-500 rounded-full" />
                  )}
                </Link>
              </li>
            ))}
          </ul>

          {/* Account section */}
          {!collapsed && (
            <p className="px-2 mb-1 text-[10px] font-600 uppercase tracking-widest text-eb-green-300 font-display">
              Account
            </p>
          )}
          <ul className="space-y-0.5">
            {accountItems.map((item) => (
              <li key={`nav-acct-${item.label}`}>
                <Link
                  href={item.href}
                  className={`
                    group flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium transition-all duration-150
                    ${isActive(item.href)
                      ? 'bg-white/10 text-white' :'text-eb-green-200 hover:bg-white/5 hover:text-white'
                    }
                    ${collapsed ? 'justify-center' : ''}
                  `}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon
                    name={item.icon as Parameters<typeof Icon>[0]['name']}
                    size={18}
                    className="flex-shrink-0 text-eb-green-300 group-hover:text-eb-gold-400 transition-colors"
                  />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Collapse toggle */}
        <div className="border-t border-eb-green-800 p-2 space-y-1">
          <button
            onClick={handleSignOut}
            className={`w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium text-eb-green-200 hover:bg-white/5 hover:text-red-400 transition-all duration-150 ${collapsed ? 'justify-center' : ''}`}
            title={collapsed ? 'Sign Out' : undefined}
          >
            <Icon name="ArrowRightOnRectangleIcon" size={18} className="flex-shrink-0 text-eb-green-300 group-hover:text-red-400 transition-colors" />
            {!collapsed && <span className="truncate">Sign Out</span>}
          </button>
          <button
            onClick={onToggleCollapse}
            className="w-full flex items-center justify-center p-2 rounded-lg text-eb-green-300 hover:bg-white/5 hover:text-white transition-all duration-150"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <Icon
              name={collapsed ? 'ChevronRightIcon' : 'ChevronLeftIcon'}
              size={16}
            />
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 w-64 bg-eb-green-900 flex flex-col lg:hidden
          transition-transform duration-300 ease-in-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="flex items-center justify-between h-16 border-b border-eb-green-800 px-4">
          <div className="flex items-center gap-2">
            <AppLogo size={28} />
            <span className="font-display text-white font-700 text-base">EarnestBridge</span>
          </div>
          <button
            onClick={onMobileClose}
            className="p-1.5 rounded-lg text-eb-green-300 hover:bg-white/5 hover:text-white transition-all"
          >
            <Icon name="XMarkIcon" size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-2">
          <p className="px-2 mb-1 text-[10px] font-600 uppercase tracking-widest text-eb-green-300 font-display">Portfolio</p>
          <ul className="space-y-0.5 mb-6">
            {mainItems.map((item) => (
              <li key={`mob-nav-${item.label}`}>
                <Link
                  href={item.href}
                  onClick={onMobileClose}
                  className={`flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-all
                    ${isActive(item.href) ? 'bg-white/10 text-white' : 'text-eb-green-200 hover:bg-white/5 hover:text-white'}
                  `}
                >
                  <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={18} className="text-eb-green-300 flex-shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="bg-eb-gold-500 text-white text-[10px] font-700 px-1.5 py-0.5 rounded-full">{item.badge}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <p className="px-2 mb-1 text-[10px] font-600 uppercase tracking-widest text-eb-green-300 font-display">Account</p>
          <ul className="space-y-0.5">
            {accountItems.map((item) => (
              <li key={`mob-acct-${item.label}`}>
                <Link href={item.href} onClick={onMobileClose} className="flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium text-eb-green-200 hover:bg-white/5 hover:text-white transition-all">
                  <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={18} className="text-eb-green-300 flex-shrink-0" />
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Mobile sign out */}
        <div className="border-t border-eb-green-800 p-2">
          <button
            onClick={() => { onMobileClose(); handleSignOut(); }}
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium text-eb-green-200 hover:bg-white/5 hover:text-red-400 transition-all"
          >
            <Icon name="ArrowRightOnRectangleIcon" size={18} className="text-eb-green-300 flex-shrink-0" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>
    </>
  );
}