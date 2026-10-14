import AdminLayout from '@/components/AdminLayout';
import ContactSubmissionsContent from './components/ContactSubmissionsContent';

export default function ContactSubmissionsPage() {
  return (
    <AdminLayout activePath="/admin/crm/submissions">
      <ContactSubmissionsContent />
    </AdminLayout>
  );
}
