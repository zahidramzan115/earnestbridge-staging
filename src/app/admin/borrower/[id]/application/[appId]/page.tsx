'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AdminLayout from '@/components/AdminLayout';
import BorrowerDetailContent from '../../components/BorrowerDetailContent';
import { createClient } from '@/lib/supabase/client';

export default function BorrowerApplicationDetailPage() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const checkAdmin = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase?.auth?.getUser();

      if (!user) {
        router?.replace('/login');
        return;
      }

      const isAdmin =
        user?.app_metadata?.role === 'admin';

      if (!isAdmin) {
        router?.replace('/dashboard-home');
        return;
      }

      setAuthorized(true);
      setChecking(false);
    };

    checkAdmin();
  }, [router]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Verifying access…</p>
        </div>
      </div>
    );
  }

  if (!authorized) return null;

  return (
    <AdminLayout activePath="/admin/deals">
      <BorrowerDetailContent />
    </AdminLayout>
  );
}
