import AdminLayout from '@/components/AdminLayout';
import CompaniesListContent from './components/CompaniesListContent';

export default function CompaniesPage() {
  return (
    <AdminLayout activePath="/admin/crm/companies">
      <CompaniesListContent />
    </AdminLayout>
  );
}
