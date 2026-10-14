'use client';
import React, { useEffect, useState } from 'react';
import Icon from '@/components/ui/AppIcon';
import StatusBadge from '@/components/ui/StatusBadge';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { ApplicationStatus } from '@/lib/mockData';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateStable(dateStr: string): string {
  const d = new Date(dateStr);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function mapDbStatus(dbStatus: string): ApplicationStatus {
  const map: Record<string, ApplicationStatus> = {
    draft: 'application',
    submitted: 'application',
    under_review: 'under_review',
    in_review: 'under_review',
    conditionally_approved: 'approved',
    approved: 'approved',
    in_progress: 'in_progress',
    funded: 'funded',
    closed: 'closed',
    rejected: 'rejected',
    expired: 'rejected',
  };
  return map[dbStatus] ?? 'application';
}

interface ClosingDeal {
  id: string;
  dealName: string;
  closingDate: string;
  status: ApplicationStatus;
  daysLeft: number;
}

interface PendingDoc {
  id: string;
  document_name: string;
  doc_status: string;
  application_id: string | null;
  dealName: string;
}

export default function UpcomingDeadlines() {
  const { user } = useAuth();
  const [closingDeals, setClosingDeals] = useState<ClosingDeal[]>([]);
  const [pendingDocs, setPendingDocs] = useState<PendingDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const fetchData = async () => {
      const [appsRes, docsRes] = await Promise.all([
        supabase
          .from('borrower_applications')
          .select('id, company_name, property_address, app_status, closing_date')
          .eq('user_id', user.id)
          .not('closing_date', 'is', null)
          .not('app_status', 'in', '("closed","expired","draft","funded")'),
        supabase
          .from('borrower_documents')
          .select('id, document_name, doc_status, application_id')
          .eq('user_id', user.id)
          .in('doc_status', ['pending', 'rejected', 'resubmit_requested'])
          .limit(4),
      ]);

      if (appsRes.data) {
        const deals: ClosingDeal[] = appsRes.data
          .map((a: any) => ({
            id: a.id,
            dealName: a.company_name || a.property_address || `Application ${a.id.slice(0, 6)}`,
            closingDate: a.closing_date,
            status: mapDbStatus(a.app_status),
            daysLeft: daysUntil(a.closing_date),
          }))
          .filter((d) => d.daysLeft >= 0)
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .slice(0, 5);
        setClosingDeals(deals);
      }

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
      {/* Upcoming Closings */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Icon name="CalendarDaysIcon" size={16} className="text-eb-green-700" />
          <h3 className="font-display font-600 text-gray-900 text-sm">Upcoming Closings</h3>
        </div>
        {closingDeals.length === 0 ? (
          <div className="text-center py-4">
            <Icon name="CalendarDaysIcon" size={24} className="text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-400">No upcoming closings</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {closingDeals.map((deal) => (
              <div key={`closing-${deal.id}`} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className={`w-10 h-10 rounded-lg flex flex-col items-center justify-center flex-shrink-0 text-center ${
                  deal.daysLeft <= 7 ? 'bg-amber-50' : deal.daysLeft <= 14 ? 'bg-blue-50' : 'bg-gray-50'
                }`}>
                  <span className={`tabular-nums text-base font-display font-800 leading-none ${
                    deal.daysLeft <= 7 ? 'text-amber-600' : deal.daysLeft <= 14 ? 'text-blue-600' : 'text-gray-600'
                  }`}>{deal.daysLeft}</span>
                  <span className={`text-[9px] font-600 uppercase tracking-wide ${
                    deal.daysLeft <= 7 ? 'text-amber-500' : deal.daysLeft <= 14 ? 'text-blue-400' : 'text-gray-400'
                  }`}>days</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{deal.dealName}</p>
                  <p className="text-xs text-gray-400 truncate mt-0.5">{formatDateStable(deal.closingDate)}</p>
                </div>
                <StatusBadge status={deal.status} size="sm" />
              </div>
            ))}
          </div>
        )}
      </div>

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