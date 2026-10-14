'use client';
import AdminLayout from '@/components/AdminLayout';
import InvoiceSettingsContent from './components/InvoiceSettingsContent';

export default function AdminSettingsPage() {
  return (
    <AdminLayout activePath="/admin/settings">
      <InvoiceSettingsContent />
    </AdminLayout>
  );
}
