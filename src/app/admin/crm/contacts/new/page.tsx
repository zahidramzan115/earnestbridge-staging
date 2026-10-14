import AdminLayout from '@/components/AdminLayout';
import NewContactContent from './components/NewContactContent';

export default function NewContactPage() {
  return (
    <AdminLayout activePath="/admin/crm/contacts">
      <NewContactContent />
    </AdminLayout>
  );
}
