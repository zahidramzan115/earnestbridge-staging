'use client';
import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AdminLayout from '@/components/AdminLayout';
import AdminDealsContent from './components/AdminDealsContent';
import { useAuth } from '@/contexts/AuthContext';

export default function AdminDealsPage() {
  const { user, loading, isAdmin } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router?.replace('/login');
      return;
    }
    if (!isAdmin()) {
      router?.replace('/dashboard-home');
    }
  }, [user, loading, isAdmin, router]);

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

  return (
    <AdminLayout activePath="/admin/deals">
      <AdminDealsContent />
    </AdminLayout>
  );
}
