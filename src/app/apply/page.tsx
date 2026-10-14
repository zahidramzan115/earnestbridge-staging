import React, { Suspense } from 'react';
import AppLayout from '@/components/AppLayout';
import BorrowerApplicationForm from './components/BorrowerApplicationForm';

export default function ApplyPage() {
  return (
    <AppLayout activePath="/apply">
      <Suspense fallback={
        <div className="max-w-3xl mx-auto py-20 flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
        </div>
      }>
        <BorrowerApplicationForm />
      </Suspense>
    </AppLayout>
  );
}
