'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Consolidated into /admin/deals — this component is no longer used
export default function AdminApplicationsContent() {
  const router = useRouter();
  useEffect(() => {
    router?.replace('/admin/deals');
  }, [router]);
  return null;
}
