'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import StatusBadge from '@/components/ui/StatusBadge';
import ActivityFeed from './ActivityFeed';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { ApplicationStatus } from '@/lib/mockData';

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

function statusLabel(dbStatus: string): string {
  const map: Record<string, string> = {
    draft: 'Application',
    submitted: 'Application',
    application: 'Application',
    under_review: 'Under Review',
    in_review: 'Under Review',
    conditionally_approved: 'Approved',
    approved: 'Approved',
    in_progress: 'In Progress',
    rejected: 'Rejected',
    funded: 'Funded',
    closed: 'Closed',
  };
  return map[dbStatus] ?? dbStatus;
}

function statusDescription(dbStatus: string): string {
  const map: Record<string, string> = {
    draft: 'Your application has been saved. Submit it when ready.',
    submitted: 'Your application has been received and is in the queue for review.',
    application: 'Your application has been received and is in the queue for review.',
    under_review: 'Our team is actively reviewing your application. We may reach out if additional information is needed.',
    in_review: 'Our team is actively reviewing your application.',
    conditionally_approved: 'Your application has been approved. See admin feedback below for any outstanding requirements.',
    approved: 'Congratulations! Your application has been approved and is now a deal.',
    in_progress: 'Your deal is actively in progress. PSA review, LLC formation, and document exchanges are underway.',
    rejected: 'Your application was not approved at this time. See admin feedback below for details.',
    funded: 'Your deal has been funded. Congratulations!',
    closed: 'This deal has been closed.',
  };
  return map[dbStatus] ?? '';
}

interface AdminFeedback {
  id: string;
  message: string;
  created_at: string;
  admin_name?: string;
  feedback_type?: string;
}

interface RealApplication {
  id: string;
  dealName: string;
  propertyAddress: string;
  propertyType: string;
  emdAmount: number;
  purchasePrice: number;
  status: ApplicationStatus;
  dbStatus: string;
  submittedDate: string;
  dueDiligenceDays: number | null;
}

function mapRow(row: any): RealApplication {
  return {
    id: row.id,
    dealName: row.company_name || row.property_address || `Application ${row.id.slice(0, 6)}`,
    propertyAddress: row.property_address || '—',
    propertyType: row.property_type || '—',
    emdAmount: row.deposit_amount || 0,
    purchasePrice: row.purchase_price || 0,
    status: mapDbStatus(row.app_status),
    dbStatus: row.app_status,
    submittedDate: row.submitted_at || row.created_at,
    dueDiligenceDays: typeof row.due_diligence_days === 'number' ? row.due_diligence_days : null,
  };
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ApplicationStatusContent() {
  const { user, loading: authLoading } = useAuth();
  const [allApplications, setAllApplications] = useState<RealApplication[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingApps, setLoadingApps] = useState(true);
  const [adminFeedback, setAdminFeedback] = useState<AdminFeedback[]>([]);
  const [loadingFeedback, setLoadingFeedback] = useState(false);
  const [liveStatus, setLiveStatus] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null);

  const application = allApplications.find(a => a.id === selectedId) ?? allApplications[0] ?? null;

  const fetchApplications = useCallback(async () => {
    if (!user) { setLoadingApps(false); return; }
    const supabase = createClient();
    const { data, error } = await supabase
      .from('borrower_applications')
      .select('*')
      .eq('user_id', user.id)
      .neq('app_status', 'draft')
      .order('created_at', { ascending: false });

    if (!error && data && data.length > 0) {
      const mapped = data.map(mapRow);
      setAllApplications(mapped);
      // Default to the most recent non-approved/funded app, or just the first
      const active = mapped.find(a => !['approved', 'funded', 'closed'].includes(a.dbStatus));
      setSelectedId(active?.id ?? mapped[0].id);
    }
    setLoadingApps(false);
  }, [user]);

  const fetchFeedback = useCallback(async (appId: string) => {
    setLoadingFeedback(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('application_feedback')
      .select('*')
      .eq('application_id', appId)
      .order('created_at', { ascending: false });
    if (data) setAdminFeedback(data);
    setLoadingFeedback(false);
  }, []);

  useEffect(() => {
    if (!authLoading) fetchApplications();
  }, [fetchApplications, authLoading]);

  useEffect(() => {
    if (application?.id) fetchFeedback(application.id);
  }, [application?.id, fetchFeedback]);

  // Real-time subscription
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    const channel = supabase
      .channel('app-status-realtime')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'borrower_applications',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        setLiveStatus(true);
        setTimeout(() => setLiveStatus(false), 3000);
        if (payload.new) {
          setAllApplications(prev => prev.map(a => a.id === payload.new.id ? mapRow(payload.new) : a));
        }
      })
      .subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  if (authLoading || loadingApps) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Icon name="ArrowPathIcon" size={24} className="animate-spin text-eb-green-600" />
        <span className="ml-3 text-sm text-gray-500">Loading your application…</span>
      </div>
    );
  }

  if (!application) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center">
          <Icon name="DocumentTextIcon" size={32} className="text-gray-300" />
        </div>
        <div className="text-center">
          <p className="font-display font-600 text-gray-900">No submitted applications yet</p>
          <p className="text-sm text-gray-400 mt-1">Start an application to track its progress here.</p>
        </div>
        <Link
          href="/apply"
          className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors"
        >
          <Icon name="PlusIcon" size={14} />
          Start an Application
        </Link>
      </div>
    );
  }

  const isApproved = application.dbStatus === 'approved';
  const isRejected = application.dbStatus === 'rejected';

  const statusColors: Record<string, string> = {
    submitted: 'bg-blue-50 border-blue-200',
    under_review: 'bg-amber-50 border-amber-200',
    conditionally_approved: 'bg-teal-50 border-teal-200',
    approved: 'bg-emerald-50 border-emerald-200',
    funded: 'bg-emerald-50 border-emerald-200',
    rejected: 'bg-red-50 border-red-200',
    closed: 'bg-gray-50 border-gray-200',
    draft: 'bg-gray-50 border-gray-200',
  };

  const statusIconColors: Record<string, string> = {
    submitted: 'text-blue-500',
    under_review: 'text-amber-500',
    conditionally_approved: 'text-teal-500',
    approved: 'text-emerald-500',
    funded: 'text-emerald-500',
    rejected: 'text-red-500',
    closed: 'text-gray-400',
    draft: 'text-gray-400',
  };

  const statusIcons: Record<string, string> = {
    submitted: 'PaperAirplaneIcon',
    under_review: 'MagnifyingGlassIcon',
    conditionally_approved: 'ClipboardDocumentCheckIcon',
    approved: 'CheckCircleIcon',
    funded: 'CheckBadgeIcon',
    rejected: 'XCircleIcon',
    closed: 'ArchiveBoxIcon',
    draft: 'DocumentTextIcon',
  };

  const feedbackTypeConfig: Record<string, { icon: string; label: string; color: string }> = {
    action_required: { icon: 'ExclamationTriangleIcon', label: 'Action Required', color: 'text-red-600 bg-red-50 border-red-200' },
    info: { icon: 'InformationCircleIcon', label: 'Information', color: 'text-blue-600 bg-blue-50 border-blue-200' },
    approval: { icon: 'CheckCircleIcon', label: 'Approval Note', color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
    rejection: { icon: 'XCircleIcon', label: 'Rejection Note', color: 'text-red-600 bg-red-50 border-red-200' },
    general: { icon: 'ChatBubbleLeftEllipsisIcon', label: 'Admin Note', color: 'text-gray-600 bg-gray-50 border-gray-200' },
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Deal Status</h1>
            {liveStatus && (
              <span className="flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-display font-600 animate-pulse">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full inline-block" />
                Updated
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-0.5">Overview of your application and current review status.</p>
        </div>
        <Link
          href="/deals"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-eb-green-900 transition-colors"
        >
          <Icon name="ChevronLeftIcon" size={14} />
          All Deals
        </Link>
      </div>

      {/* Approved → Deal banner */}
      {isApproved && (
        <div className="mb-5 flex items-center gap-4 p-4 bg-emerald-50 border border-emerald-200 rounded-2xl">
          <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
            <Icon name="CheckBadgeIcon" size={20} className="text-emerald-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-display font-700 text-emerald-800 text-sm">Application Approved — Now a Deal</p>
            <p className="text-xs text-emerald-600 mt-0.5">This application has been approved and moved to your Deals area.</p>
          </div>
          <Link
            href="/deals"
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-600 rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap flex-shrink-0"
          >
            View Deal
            <Icon name="ArrowRightIcon" size={13} />
          </Link>
        </div>
      )}

      {/* Application details card */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 mb-4">
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-xl bg-eb-green-900 flex items-center justify-center flex-shrink-0">
            <Icon name="BuildingOffice2Icon" size={20} className="text-eb-gold-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h2 className="font-display font-700 text-lg text-gray-900">{application.dealName}</h2>
              <StatusBadge status={application.status} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
              {application.propertyAddress !== '—' && (
                <span className="flex items-center gap-1">
                  <Icon name="MapPinIcon" size={13} className="text-gray-400" />
                  {application.propertyAddress}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Icon name="HashtagIcon" size={13} className="text-gray-400" />
                EB-{application.id.slice(0, 8).toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        {/* Key details grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t border-gray-100">
          <div>
            <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Property Type</p>
            <p className="text-sm font-600 text-gray-800">{application.propertyType}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">EMD Amount</p>
            <p className="text-sm font-700 text-eb-green-900 tabular-nums">${application.emdAmount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Purchase Price</p>
            <p className="text-sm font-600 text-gray-800 tabular-nums">${application.purchasePrice.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Submitted</p>
            <p className="text-sm font-600 text-gray-800">{formatDate(application.submittedDate)}</p>
          </div>
        </div>
      </div>

      {/* Current status card */}
      <div className={`rounded-2xl border p-5 mb-4 ${statusColors[application.dbStatus] ?? 'bg-gray-50 border-gray-200'}`}>
        <div className="flex items-start gap-3">
          <Icon
            name={(statusIcons[application.dbStatus] ?? 'ClockIcon') as Parameters<typeof Icon>[0]['name']}
            size={20}
            className={`flex-shrink-0 mt-0.5 ${statusIconColors[application.dbStatus] ?? 'text-gray-400'}`}
          />
          <div>
            <p className="font-display font-700 text-gray-900 text-sm">{statusLabel(application.dbStatus)}</p>
            <p className="text-sm text-gray-600 mt-0.5">{statusDescription(application.dbStatus)}</p>
            {application.dueDiligenceDays != null && (
              <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
                <Icon name="CalendarIcon" size={12} />
                Due Diligence Period: {application.dueDiligenceDays} {application.dueDiligenceDays === 1 ? 'Day' : 'Days'}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Admin feedback / action required */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Icon name="ChatBubbleLeftEllipsisIcon" size={16} className="text-gray-500" />
          <h3 className="font-display font-700 text-gray-900 text-sm">Admin Feedback & Actions</h3>
        </div>

        {loadingFeedback ? (
          <div className="flex items-center gap-2 py-6 justify-center">
            <Icon name="ArrowPathIcon" size={16} className="animate-spin text-gray-400" />
            <span className="text-sm text-gray-400">Loading feedback…</span>
          </div>
        ) : adminFeedback.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center mb-3">
              <Icon name="CheckCircleIcon" size={22} className="text-emerald-400" />
            </div>
            <p className="font-display font-600 text-gray-700 text-sm">No feedback yet</p>
            <p className="text-xs text-gray-400 mt-1 max-w-xs">
              {isRejected
                ? 'No specific feedback was provided. Contact support for more information.'
                : 'Our team will leave notes here if any action is required from you.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {adminFeedback.map((fb) => {
              const cfg = feedbackTypeConfig[fb.feedback_type ?? 'general'] ?? feedbackTypeConfig.general;
              return (
                <div key={fb.id} className={`flex items-start gap-3 p-4 rounded-xl border ${cfg.color}`}>
                  <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={16} className="flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[11px] font-display font-700 uppercase tracking-wide opacity-70">{cfg.label}</span>
                      <span className="text-[11px] text-gray-400 whitespace-nowrap">{formatDate(fb.created_at)}</span>
                    </div>
                    <p className="text-sm leading-relaxed">{fb.message}</p>
                    {fb.admin_name && (
                      <p className="text-[11px] text-gray-400 mt-1.5">— {fb.admin_name}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Activity feed (collapsible) */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <button
          onClick={() => setShowActivity((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Icon name="ClockIcon" size={15} className="text-gray-500" />
            <span className="font-display font-600 text-sm text-gray-900">Activity History</span>
            <span className="text-[10px] bg-eb-green-100 text-eb-green-800 px-1.5 py-0.5 rounded-full font-700">Live</span>
          </div>
          <Icon name={showActivity ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={15} className="text-gray-400" />
        </button>
        {showActivity && (
          <div className="px-5 pb-5 border-t border-gray-100 pt-4">
            <ActivityFeed applicationId={application.id} />
          </div>
        )}
      </div>

      {/* Documents summary — full workspace lives at /documents */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 mt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-eb-green-50 flex items-center justify-center flex-shrink-0">
              <Icon name="FolderOpenIcon" size={14} className="text-eb-green-700" />
            </div>
            <div>
              <h3 className="font-display font-700 text-sm text-gray-900">Documents</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">View and manage all deal documents in one place</p>
            </div>
          </div>
          <Link
            href="/documents"
            className="flex items-center gap-1.5 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-600 rounded-lg hover:bg-eb-green-800 transition-colors whitespace-nowrap flex-shrink-0"
          >
            View Documents
            <Icon name="ArrowRightIcon" size={12} />
          </Link>
        </div>
      </div>
    </div>
  );
}