import AdminLayout from '@/components/AdminLayout';
import ContactsListContent from './components/ContactsListContent';

export default function ContactsPage() {
  return (
    <AdminLayout activePath="/admin/crm/contacts">
      <ContactsListContent />
    </AdminLayout>
  );
}
