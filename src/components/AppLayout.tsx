'use client';
import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import PortalAccessDisabledScreen from './PortalAccessDisabledScreen';
import { useAuth } from '@/contexts/AuthContext';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

interface AppLayoutProps {
  children: React.ReactNode;
  activePath?: string;
}

export default function AppLayout({ children, activePath }: AppLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isDisabled, setIsDisabled] = useState(false);
  const [accessChecked, setAccessChecked] = useState(false);
  const { user, loading } = useAuth();
  const router = useRouter();

  // Client-side auth guard (belt-and-suspenders behind middleware)
  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) {
      setAccessChecked(true);
      return;
    }

    const supabase = createClient();
    supabase
      .from('borrower_access')
      .select('is_disabled')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setIsDisabled(data?.is_disabled === true);
        setAccessChecked(true);
      })
      .catch(() => {
        setAccessChecked(true);
      });
  }, [user]);

  // Show spinner while auth is loading or access check is pending
  if (loading || !accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Redirect in progress — render nothing
  if (!user) return null;

  // Show restricted screen if disabled
  if (isDisabled) {
    return <PortalAccessDisabledScreen />;
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile overlay */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden animate-fade-in"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        onMobileClose={() => setMobileSidebarOpen(false)}
        activePath={activePath}
      />

      {/* Main content area */}
      <div
        className="flex flex-col flex-1 min-w-0 transition-all duration-300 ease-in-out"
      >
        <Topbar
          onMenuClick={() => setMobileSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 2xl:px-12 py-6 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}