'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Consolidated into /deals — this component is no longer used
export default function BorrowerApplicationsContent() {
  const router = useRouter();
  useEffect(() => {
    router?.replace('/deals');
  }, [router]);
  return null;
}
