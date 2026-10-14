import AdminLayout from '@/components/AdminLayout';
import CRMDealsContent from './components/CRMDealsContent';

export default function CRMDealsPage() {
  return (
    <AdminLayout activePath="/admin/crm/deals">
      <CRMDealsContent />
    </AdminLayout>
  );
}
