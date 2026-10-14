'use client';
import React from 'react';
import AppLayout from '@/components/AppLayout';
import DealDetailsContent from './components/DealDetailsContent';

export default function DealDetailsPage() {
  return (
    <AppLayout activePath="/deals">
      <DealDetailsContent />
    </AppLayout>
  );
}
