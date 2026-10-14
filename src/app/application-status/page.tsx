import React from 'react';
import AppLayout from '@/components/AppLayout';
import ApplicationStatusContent from './components/ApplicationStatusContent';

export default function ApplicationStatusPage() {
  return (
    <AppLayout activePath="/application-status">
      <ApplicationStatusContent />
    </AppLayout>
  );
}