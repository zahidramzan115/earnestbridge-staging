'use client';
import AdminLayout from '@/components/AdminLayout';
import AuditLogContent from './components/AuditLogContent';

export default function AuditLogPage() {
  return (
    <AdminLayout activePath="/admin/audit-log">
      <AuditLogContent />
    </AdminLayout>
  );
}
