'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { Toaster } from 'sonner';
import { toast } from 'sonner';
import Icon from '@/components/ui/AppIcon';
import KPIBentoGrid from './KPIBentoGrid';
import ActivityChart from './ActivityChart';
import UpcomingDeadlines from './UpcomingDeadlines';
import DashboardDeadlineSummary from './DashboardDeadlineSummary';
import DealsTable from './DealsTable';
import DashboardNotificationsPanel from './DashboardNotificationsPanel';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import Link from 'next/link';
import RevisionUploadModal, { RevisionUploadTarget } from '@/components/RevisionUploadModal';

interface RevisionAction {
  tableTarget: 'borrower_documents' | 'application_documents';
  documentGroupId: string;
  applicationId: string;
  documentName: string;
  currentVersion: number;
  clientRevisionMessage: string;
  documentType?: string;
  category?: string;
  dealLabel?: string;
}

export default function DashboardContent() {
  const { user } = useAuth();
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [isLive, setIsLive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [revisionActions, setRevisionActions] = useState<RevisionAction[]>([]);
  const [revisionModalTarget, setRevisionModalTarget] = useState<RevisionUploadTarget | null>(null);

  // Stable "last updated" timestamp — set only on client to avoid hydration mismatch
  useEffect(() => {
    const now = new Date();
    setLastUpdated(
      now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    );
  }, [refreshKey]);

  // ── Fetch active revision requests ────────────────────────────────────────
  const fetchRevisionActions = useCallback(async () => {
    if (!user) return;
    const supabase = createClient();
    const actions: RevisionAction[] = [];

    // Fetch applications for this user to get deal labels
    const { data: apps } = await supabase
      .from('borrower_applications')
      .select('id, property_address, company_name')
      .eq('user_id', user.id);

    const appLabelMap: Record<string, string> = {};
    (apps || []).forEach((a: any) => {
      appLabelMap[a.id] = a.property_address || a.company_name || 'Deal';
    });

    // borrower_documents: current version with revision_requested
    const { data: borrowerDocs } = await supabase
      .from('borrower_documents')
      .select('id, document_name, document_type, category, document_group_id, application_id, version_number, client_revision_message')
      .eq('user_id', user.id)
      .eq('review_status', 'revision_requested')
      .eq('is_current_version', true)
      .not('client_revision_message', 'is', null);

    (borrowerDocs || []).forEach((doc: any) => {
      if (!doc.client_revision_message) return;
      actions.push({
        tableTarget: 'borrower_documents',
        documentGroupId: doc.document_group_id,
        applicationId: doc.application_id,
        documentName: doc.document_name,
        currentVersion: doc.version_number ?? 1,
        clientRevisionMessage: doc.client_revision_message,
        documentType: doc.document_type,
        category: doc.category,
        dealLabel: doc.application_id ? appLabelMap[doc.application_id] : undefined,
      });
    });

    // application_documents: current version with revision_requested
    const { data: appDocs } = await supabase
      .from('application_documents')
      .select('id, document_name, thread_id, application_id, revision_number, client_revision_message')
      .eq('user_id', user.id)
      .eq('review_status', 'revision_requested')
      .eq('is_current_version', true)
      .not('client_revision_message', 'is', null);

    (appDocs || []).forEach((doc: any) => {
      if (!doc.client_revision_message) return;
      actions.push({
        tableTarget: 'application_documents',
        documentGroupId: doc.thread_id,
        applicationId: doc.application_id,
        documentName: doc.document_name,
        currentVersion: doc.revision_number ?? 1,
        clientRevisionMessage: doc.client_revision_message,
        dealLabel: doc.application_id ? appLabelMap[doc.application_id] : undefined,
      });
    });

    setRevisionActions(actions);
  }, [user]);

  useEffect(() => {
    fetchRevisionActions();
  }, [fetchRevisionActions, refreshKey]);

  // ── Real-time subscription ─────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();

    const channel = supabase.
    channel('dashboard-realtime').
    on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'borrower_applications',
        filter: `user_id=eq.${user.id}`
      },
      (payload) => {
        const now = new Date();
        setLastUpdated(
          now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
          ' ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        );
        if (payload.eventType === 'UPDATE') {
          toast.info('Deal updated', {
            description: 'Your deal status has changed. Refresh to see the latest.'
          });
        } else if (payload.eventType === 'INSERT') {
          toast.success('New deal received', {
            description: 'A new deal has been submitted.'
          });
        }
      }
    ).
    on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'borrower_documents',
        filter: `user_id=eq.${user.id}`
      },
      () => {
        fetchRevisionActions();
      }
    ).
    on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'application_documents',
        filter: `user_id=eq.${user.id}`
      },
      () => {
        fetchRevisionActions();
      }
    ).
    on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`
      },
      (payload) => {
        const row = payload.new as any;
        toast.info(row.title ?? 'New notification', {
          description: row.message
        });
      }
    ).
    subscribe((status) => {
      setIsLive(status === 'SUBSCRIBED');
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchRevisionActions]);

  const handleRevisionSuccess = () => {
    fetchRevisionActions();
    setRefreshKey(k => k + 1);
  };

  return (
    <>
      <Toaster position="bottom-right" richColors />

      {/* Revision Upload Modal */}
      {revisionModalTarget && (
        <RevisionUploadModal
          target={revisionModalTarget}
          onClose={() => setRevisionModalTarget(null)}
          onSuccess={handleRevisionSuccess}
        />
      )}

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <div className="flex-1">
          <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Portfolio Overview</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {user?.user_metadata?.full_name ?
            `Welcome back, ${user.user_metadata.full_name.split(' ')[0]} — here is where your deals stand today.` :
            'Here is where your deals stand today.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setRefreshKey(k => k + 1)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all active:scale-95 min-h-[40px]">

            <Icon name="ArrowPathIcon" size={14} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          {/* Live indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white border border-gray-200">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'}`} />
            <span className="text-xs text-gray-500 hidden sm:inline">{isLive ? 'Live' : 'Connecting…'}</span>
          </div>
          {lastUpdated &&
          <span className="text-xs text-gray-400 hidden sm:block">Last updated: {lastUpdated}</span>
          }
        </div>
      </div>

      {/* ── ACTION REQUIRED — Document Revision Requests ─────────────────── */}
      {revisionActions.length > 0 && (
        <div className="mb-6 rounded-2xl border-2 border-amber-300 bg-amber-50 overflow-hidden shadow-sm">
          {/* Section header */}
          <div className="flex items-center gap-3 px-5 py-3.5 bg-amber-100 border-b border-amber-200">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
              <Icon name="ExclamationTriangleIcon" size={16} className="text-white" />
            </div>
            <div className="flex-1">
              <p className="font-display font-700 text-amber-900 text-sm">
                Action Required
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                {revisionActions.length === 1
                  ? '1 document needs your attention'
                  : `${revisionActions.length} documents need your attention`}
              </p>
            </div>
          </div>

          {/* Revision action cards */}
          <div className="divide-y divide-amber-200">
            {revisionActions.map((action, idx) => (
              <div key={`${action.documentGroupId}-${idx}`} className="px-5 py-4">
                <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Document name + deal */}
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <p className="font-display font-700 text-gray-900 text-sm">{action.documentName}</p>
                      {action.dealLabel && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-eb-green-900 bg-eb-green-50 border border-eb-green-200 px-2 py-0.5 rounded-full font-display font-600">
                          <Icon name="BuildingOfficeIcon" size={10} />
                          {action.dealLabel}
                        </span>
                      )}
                    </div>
                    {/* Action label */}
                    <p className="text-xs font-display font-600 text-amber-700 mb-1.5">
                      Upload a revised document
                    </p>
                    {/* Client revision message */}
                    <p className="text-xs text-amber-800 leading-relaxed bg-amber-100 rounded-lg px-3 py-2 border border-amber-200">
                      {action.clientRevisionMessage}
                    </p>
                  </div>
                  {/* CTA */}
                  <button
                    onClick={() => setRevisionModalTarget({
                      tableTarget: action.tableTarget,
                      documentGroupId: action.documentGroupId,
                      applicationId: action.applicationId,
                      documentName: action.documentName,
                      currentVersion: action.currentVersion,
                      clientRevisionMessage: action.clientRevisionMessage,
                      documentType: action.documentType,
                      category: action.category,
                    })}
                    className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 text-sm font-display font-700 text-white bg-amber-500 hover:bg-amber-600 rounded-xl transition-all active:scale-95 min-h-[40px] w-full sm:w-auto justify-center"
                  >
                    <Icon name="ArrowUpTrayIcon" size={15} />
                    Upload Revised Document
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Submit New Deal CTA Banner */}
      <div className="mb-6 flex flex-col sm:flex-row items-center justify-between gap-4 px-5 py-4 sm:px-6 sm:py-4 bg-eb-green-900 rounded-xl border border-eb-green-800">
        <div className="flex items-center gap-3 text-center sm:text-left">
          <div className="hidden sm:flex items-center justify-center w-9 h-9 rounded-lg bg-eb-gold-500/20 flex-shrink-0">
            <Icon name="PlusCircleIcon" size={18} className="text-eb-gold-400" />
          </div>
          <div>
            <p className="font-display font-700 text-white text-sm">Ready to secure your next deal?</p>
            <p className="text-xs mt-0.5 text-eb-green-300">Submit a new EMD financing application in minutes.</p>
          </div>
        </div>
        <Link
          href="/apply"
          className="w-full sm:w-auto flex-shrink-0 flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg font-700 text-sm bg-eb-gold-500 hover:bg-eb-gold-400 text-gray-900 transition-all duration-150 active:scale-95 min-h-[40px]"
        >
          <Icon name="PlusIcon" size={15} />
          Submit New Deal
        </Link>
      </div>

      {/* KPI Bento Grid */}
      <KPIBentoGrid revisionActionCount={revisionActions.length} />
      {/* Chart + Deadlines row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2">
          <ActivityChart />
        </div>
        <div className="lg:col-span-1 flex flex-col gap-4">
          <DashboardDeadlineSummary />
          <UpcomingDeadlines />
        </div>
      </div>
      {/* Deals table + Notifications panel */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <DealsTable />
        </div>
        <div className="xl:col-span-1 min-h-[420px]">
          <DashboardNotificationsPanel />
        </div>
      </div>
    </>);

}