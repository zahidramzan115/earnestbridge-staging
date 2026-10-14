import AdminLayout from '@/components/AdminLayout';
import TasksContent from './components/TasksContent';

export default function TasksPage() {
  return (
    <AdminLayout activePath="/admin/crm/tasks">
      <TasksContent />
    </AdminLayout>
  );
}
