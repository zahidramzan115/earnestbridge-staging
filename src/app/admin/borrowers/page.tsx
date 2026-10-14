'use client';
import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AdminLayout from '@/components/AdminLayout';
import AdminBorrowersContent from './components/AdminBorrowersContent';
import { useAuth } from '@/contexts/AuthContext';

export default function AdminBorrowersPage() {
  const { isAdmin, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !isAdmin()) {
      router?.replace('/dashboard-home');
    }
  }, [loading, isAdmin, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAdmin()) return null;

  return (
    <AdminLayout activePath="/admin/borrowers">
      <AdminBorrowersContent />
    </AdminLayout>
  );
}
