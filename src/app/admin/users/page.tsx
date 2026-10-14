'use client';
import React from 'react';
import AdminLayout from '@/components/AdminLayout';
import AdminUsersContent from './components/AdminUsersContent';

export default function AdminUsersPage() {
  return (
    <AdminLayout activePath="/admin/users">
      <AdminUsersContent />
    </AdminLayout>
  );
}
