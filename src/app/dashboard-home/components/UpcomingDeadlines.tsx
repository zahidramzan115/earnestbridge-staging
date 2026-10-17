'use client';
import React, { useEffect, useState } from 'react';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface PendingDoc {
  id: string;
  document_name: string;
  doc_status: string;
  application_id: string | null;
  dealName: string;
}

export default function UpcomingDeadlines() {
  const { user } = useAuth();
  const [pendingDocs, setPendingDocs] = useState<PendingDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const fetchData = async () => {
      const docsRes = await supabase
        .from('borrower_documents')
        .select('id, document_name, doc_status, application_id')
        .eq('user_id', user.id)
        .in('doc_status', ['pending', 'rejected', 'resubmit_requested'])
        .limit(4);

      if (docsRes.data) {
        // Fetch application names for docs
        const appIds = [...new Set(docsRes.data.map((d: any) => d.application_id).filter(Boolean))];
        let appNames: Record<string, string> = {};
        if (appIds.length > 0) {
          const { data: appsData } = await supabase
            .from('borrower_applications')
            .select('id, company_name, property_address')
            .in('id', appIds);
          if (appsData) {
            appsData.forEach((a: any) => {
              appNames[a.id] = a.company_name || a.property_address || `Application ${a.id.slice(0, 6)}`;
            });
          }
        }
        setPendingDocs(
          docsRes.data.map((d: any) => ({
            ...d,
            dealName: d.application_id ? (appNames[d.application_id] || 'Unknown Deal') : 'Unknown Deal',
          }))
        );
      }

      setLoading(false);
    };
    fetchData();
  }, [user]);

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 flex flex-col gap-6">
        <div className="animate-pulse space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={`skel-${i}`} className="h-12 bg-gray-100 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 flex flex-col gap-6">
      {/* Pending Documents */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Icon name="ExclamationTriangleIcon" size={16} className="text-red-500" />
          <h3 className="font-display font-600 text-gray-900 text-sm">Documents Needed</h3>
          {pendingDocs.length > 0 && (
            <span className="ml-auto bg-red-100 text-red-600 text-[10px] font-display font-700 px-1.5 py-0.5 rounded-full">{pendingDocs.length}</span>
          )}
        </div>
        {pendingDocs.length === 0 ? (
          <div className="text-center py-4">
            <Icon name="CheckCircleIcon" size={24} className="text-emerald-400 mx-auto mb-2" />
            <p className="text-sm text-gray-400">No documents needed</p>
          </div>
        ) : (
          <div className="space-y-2">
            {pendingDocs.map((doc) => {
              const isRejected = doc.doc_status === 'rejected';
              const isResubmit = doc.doc_status === 'resubmit_requested';
              return (
                <div key={`doc-${doc.id}`} className={`flex items-start gap-2.5 p-3 rounded-xl border ${
                  isRejected ? 'bg-red-50 border-red-100' : isResubmit ? 'bg-orange-50 border-orange-100' : 'bg-amber-50 border-amber-100'
                }`}>
                  <Icon
                    name="DocumentArrowUpIcon"
                    size={14}
                    className={`flex-shrink-0 mt-0.5 ${isRejected ? 'text-red-500' : isResubmit ? 'text-orange-500' : 'text-amber-500'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-800 leading-tight">{doc.document_name}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 truncate">{doc.dealName}</p>
                  </div>
                  <span className={`text-[10px] font-display font-700 flex-shrink-0 ${isRejected ? 'text-red-600' : isResubmit ? 'text-orange-600' : 'text-amber-600'}`}>
                    {isRejected ? 'Rejected' : isResubmit ? 'Resubmit' : 'Pending'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}