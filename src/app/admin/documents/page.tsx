import AdminLayout from '@/components/AdminLayout';
import AdminDocumentsContent from './components/AdminDocumentsContent';

export const metadata = {
  title: 'Documents Queue — EarnestBridge Admin',
};

export default function AdminDocumentsPage() {
  return (
    <AdminLayout activePath="/admin/documents">
      <AdminDocumentsContent />
    </AdminLayout>
  );
}
