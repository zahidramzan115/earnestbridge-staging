import React from 'react';
import AppLayout from '@/components/AppLayout';
import DashboardContent from './components/DashboardContent';

export default function DashboardHomePage() {
  return (
    <AppLayout activePath="/dashboard-home">
      <DashboardContent />
    </AppLayout>
  );
}