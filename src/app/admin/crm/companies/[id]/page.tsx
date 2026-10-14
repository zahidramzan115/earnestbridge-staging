import AdminLayout from '@/components/AdminLayout';
import CompanyDetailContent from './components/CompanyDetailContent';

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminLayout activePath="/admin/crm/companies">
      <CompanyDetailContent companyId={id} />
    </AdminLayout>
  );
}
