import AdminLayout from '@/components/AdminLayout';
import ContactDetailContent from './components/ContactDetailContent';

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminLayout activePath="/admin/crm/contacts">
      <ContactDetailContent contactId={id} />
    </AdminLayout>
  );
}
