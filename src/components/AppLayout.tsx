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
  const [accessCheckFailed, setAccessCheckFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
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

    let cancelled = false;
    setAccessChecked(false);
    setAccessCheckFailed(false);

    const supabase = createClient();
    (async () => {
      try {
        const { data, error } = await supabase
          .from('borrower_access')
          .select('is_disabled')
          .eq('user_id', user.id)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          // FAIL CLOSED: an unverifiable access state must never render the portal.
          setAccessCheckFailed(true);
          setIsDisabled(false);
        } else {
          setIsDisabled(data?.is_disabled === true);
        }
      } catch {
        if (cancelled) return;
        setAccessCheckFailed(true);
        setIsDisabled(false);
      } finally {
        if (!cancelled) setAccessChecked(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, retryNonce]);

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

  // Access could not be verified — fail closed with a neutral message
  if (accessCheckFailed) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          <h1 className="font-display font-700 text-2xl text-gray-900 mb-3">
            Unable to verify portal access
          </h1>
          <p className="text-gray-500 text-sm leading-relaxed mb-8">
            Unable to verify portal access. Please try again.
          </p>
          <button
            type="button"
            onClick={() => setRetryNonce((n) => n + 1)}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-eb-green-900 text-white text-sm font-medium hover:bg-eb-green-800 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
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