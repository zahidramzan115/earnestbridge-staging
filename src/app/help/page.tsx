'use client';
import React from 'react';
import AppLayout from '@/components/AppLayout';
import HelpContent from './components/HelpContent';

export default function HelpPage() {
  return (
    <AppLayout activePath="/help">
      <HelpContent />
    </AppLayout>
  );
}
