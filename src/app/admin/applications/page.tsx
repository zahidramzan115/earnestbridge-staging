'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminApplicationsPage() {
  const router = useRouter();
  useEffect(() => {
    router?.replace('/admin/deals');
  }, [router]);
  return null;
}
