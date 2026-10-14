import { Suspense } from 'react';
import AdminInvoiceDetailContent from './components/AdminInvoiceDetailContent';

export default function AdminInvoicePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-sm text-gray-400">Loading invoice…</div>
      </div>
    }>
      <AdminInvoiceDetailContent />
    </Suspense>
  );
}
