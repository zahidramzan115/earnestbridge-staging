'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminPage() {
  const router = useRouter();

  useEffect(() => {
    router?.replace('/admin/overview');
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-500">Redirecting…</p>
      </div>
    </div>
  );
}
