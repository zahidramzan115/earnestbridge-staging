'use client';
import React from 'react';
import AppLayout from '@/components/AppLayout';
import BorrowerDealsContent from './components/BorrowerDealsContent';

export default function DealsPage() {
  return (
    <AppLayout activePath="/deals">
      <BorrowerDealsContent />
    </AppLayout>
  );
}
