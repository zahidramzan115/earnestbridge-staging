'use client';
import React from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';

interface TopbarProps {
  onMenuClick: () => void;
}

export default function Topbar({ onMenuClick }: TopbarProps) {
  const { user } = useAuth();

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';
  const initials = fullName
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 sm:px-6 gap-4 flex-shrink-0 z-10">
      {/* Mobile menu button */}
      <button
        onClick={onMenuClick}
        className="lg:hidden p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-all"
      >
        <Icon name="Bars3Icon" size={20} />
      </button>

      {/* Breadcrumb / page context */}
      <div className="hidden sm:flex items-center gap-1.5 text-sm text-gray-500">
        <span className="text-eb-green-900 font-medium font-display">EarnestBridge</span>
        <Icon name="ChevronRightIcon" size={14} className="text-gray-300" />
        <span>Borrower Portal</span>
      </div>

      <div className="flex-1" />

      {/* Right actions */}
      <div className="flex items-center gap-1">
        {/* Notifications link */}
        <Link
          href="/notifications"
          className="relative p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-all"
          title="Notifications"
        >
          <Icon name="BellIcon" size={18} />
        </Link>

        {/* User avatar */}
        <Link
          href="/profile-account-settings"
          className="flex items-center gap-2 ml-1 p-1.5 rounded-lg hover:bg-gray-100 transition-all"
        >
          <div className="w-7 h-7 rounded-full bg-eb-green-900 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-[11px] font-display font-700">{initials}</span>
          </div>
          <span className="hidden md:block text-sm font-medium text-gray-700">{fullName}</span>
          <Icon name="ChevronDownIcon" size={14} className="hidden md:block text-gray-400" />
        </Link>
      </div>
    </header>
  );
}