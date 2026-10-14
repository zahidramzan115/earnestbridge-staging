import React from 'react';
import AppLayout from '@/components/AppLayout';
import NotificationsContent from './components/NotificationsContent';

export default function NotificationsPage() {
  return (
    <AppLayout activePath="/notifications">
      <NotificationsContent />
    </AppLayout>
  );
}
