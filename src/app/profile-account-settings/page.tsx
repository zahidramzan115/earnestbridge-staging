import React from 'react';
import AppLayout from '@/components/AppLayout';
import ProfileSettingsContent from './components/ProfileSettingsContent';

export default function ProfileAccountSettingsPage() {
  return (
    <AppLayout activePath="/profile-account-settings">
      <ProfileSettingsContent />
    </AppLayout>
  );
}