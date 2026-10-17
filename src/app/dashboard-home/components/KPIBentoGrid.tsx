'use client';
import React, { useEffect, useState } from 'react';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

function formatCurrency(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

interface AppRow {
  id: string;
  app_status: string;
  deposit_amount: number | null;
  purchase_price: number | null;
  submitted_at: string | null;
  days_to_funding: number | null;
}

interface KPIBentoGridProps {
  /** Number of active document revision requests — passed from DashboardContent */
  revisionActionCount?: number;
}

export default function KPIBentoGrid({ revisionActionCount = 0 }: KPIBentoGridProps) {
  const { user } = useAuth();
  const [apps, setApps] = useState<AppRow[]>([]);
  const [legacyPendingDocs, setLegacyPendingDocs] = useState(0);
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
          .select('id, app_status, deposit_amount, purchase_price, submitted_at, days_to_funding')
          .eq('user_id', user.id),
        supabase
          .from('borrower_documents')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('doc_status', ['pending', 'rejected', 'resubmit_requested'])
          .is('review_status', null),
      ]);
      if (appsRes.data) setApps(appsRes.data as AppRow[]);
      setLegacyPendingDocs(docsRes.count ?? 0);
      setLoading(false);
    };
    fetchData();
  }, [user]);

  // Pending Actions = legacy doc statuses + active revision requests
  // Revision requests are counted separately (passed from parent) to avoid double-counting
  const pendingActions = legacyPendingDocs + revisionActionCount;

  // New 6-stage status groupings
  const active = apps.filter((a) => ['application', 'under_review', 'approved', 'in_progress'].includes(a.app_status));
  const funded = apps.filter((a) => a.app_status === 'funded' || a.app_status === 'closed');
  const totalFunded = funded.reduce((s, a) => s + (a.deposit_amount ?? 0), 0);

  const fundedWithDays = funded.filter((a) => !!a.days_to_funding);
  const avgDays = fundedWithDays.length > 0
    ? Math.round(
        fundedWithDays.reduce((s, a) => s + (a.days_to_funding ?? 0), 0) / fundedWithDays.length
      )
    : 0;

  const totalPortfolio = apps.reduce((s, a) => s + (a.purchase_price ?? 0), 0);
  const underReviewCount = apps.filter((a) => a.app_status === 'under_review').length;
  const approvedCount = apps.filter((a) => a.app_status === 'approved').length;

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {[...Array(6)].map((_, i) => (
          <div key={`kpi-skel-${i}`} className={`rounded-2xl bg-gray-100 animate-pulse min-h-[130px] ${i === 0 ? 'sm:col-span-2' : ''}`} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-4 gap-3 sm:gap-4 mb-6">
      {/* Hero: Active Deals — spans 2 cols */}
      <div className="sm:col-span-2 bg-eb-green-900 rounded-2xl p-5 sm:p-6 shadow-card flex flex-col justify-between min-h-[130px] sm:min-h-[140px]">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-eb-green-300 text-xs font-display font-600 uppercase tracking-widest mb-1">Active Deals</p>
            <p className="tabular-nums text-white font-display text-4xl sm:text-5xl font-800 leading-none">{active.length}</p>
          </div>
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-white/10 flex items-center justify-center">
            <Icon name="BriefcaseIcon" size={20} className="text-eb-gold-400" />
          </div>
        </div>
        {active.length > 0 ? (
          <div className="flex items-center gap-3 sm:gap-4 mt-4">
            <div className="flex-1">
              <div className="flex justify-between text-xs text-eb-green-300 mb-1">
                <span>Under Review</span>
                <span>{underReviewCount}</span>
              </div>
              <div className="h-1.5 bg-eb-green-800 rounded-full overflow-hidden">
                <div className="h-full bg-eb-gold-400 rounded-full" style={{ width: `${active.length > 0 ? (underReviewCount / active.length) * 100 : 0}%` }} />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex justify-between text-xs text-eb-green-300 mb-1">
                <span>Approved</span>
                <span>{approvedCount}</span>
              </div>
              <div className="h-1.5 bg-eb-green-800 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${active.length > 0 ? (approvedCount / active.length) * 100 : 0}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-eb-green-400 text-xs mt-4">No active deals yet</p>
        )}
      </div>

      {/* Total EMD Funded */}
      <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-card border border-gray-100 flex flex-col justify-between min-h-[120px] sm:min-h-[140px]">
        <div className="flex items-start justify-between">
          <p className="text-gray-500 text-xs font-display font-600 uppercase tracking-widest">Total EMD Funded</p>
          <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
            <Icon name="BanknotesIcon" size={17} className="text-emerald-600" />
          </div>
        </div>
        <div>
          <p className="tabular-nums text-gray-900 font-display text-2xl sm:text-3xl font-800 mt-2">{funded.length > 0 ? formatCurrency(totalFunded) : '$0'}</p>
          <p className="text-xs text-emerald-600 font-medium mt-1 flex items-center gap-1">
            <Icon name="ArrowTrendingUpIcon" size={12} />
            {funded.length} deal{funded.length !== 1 ? 's' : ''} funded
          </p>
        </div>
      </div>

      {/* Pending Action Items — alert state */}
      <div className={`rounded-2xl p-4 sm:p-5 shadow-card border flex flex-col justify-between min-h-[120px] sm:min-h-[140px] ${pendingActions > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'}`}>
        <div className="flex items-start justify-between">
          <p className={`text-xs font-display font-600 uppercase tracking-widest ${pendingActions > 0 ? 'text-red-500' : 'text-gray-500'}`}>Pending Actions</p>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${pendingActions > 0 ? 'bg-red-100' : 'bg-gray-100'}`}>
            <Icon name="ExclamationTriangleIcon" size={17} className={pendingActions > 0 ? 'text-red-500' : 'text-gray-400'} />
          </div>
        </div>
        <div>
          <p className={`tabular-nums font-display text-2xl sm:text-3xl font-800 mt-2 ${pendingActions > 0 ? 'text-red-600' : 'text-gray-900'}`}>{pendingActions}</p>
          <p className={`text-xs font-medium mt-1 ${pendingActions > 0 ? 'text-red-500' : 'text-gray-400'}`}>
            {pendingActions > 0 ? 'Requires your attention' : 'All caught up'}
          </p>
        </div>
      </div>

      {/* Avg Days to Funding */}
      <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-card border border-gray-100 flex flex-col justify-between min-h-[110px] sm:min-h-[130px]">
        <div className="flex items-start justify-between">
          <p className="text-gray-500 text-xs font-display font-600 uppercase tracking-widest">Avg. Days to Fund</p>
          <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
            <Icon name="ClockIcon" size={17} className="text-blue-500" />
          </div>
        </div>
        <div>
          <p className="tabular-nums text-gray-900 font-display text-2xl sm:text-3xl font-800 mt-2">{avgDays > 0 ? avgDays : '—'}</p>
          <p className="text-xs text-blue-500 font-medium mt-1">{avgDays > 0 ? 'days from submission' : 'No funded deals yet'}</p>
        </div>
      </div>

      {/* Total Portfolio Value */}
      <div className="sm:col-span-2 bg-white rounded-2xl p-4 sm:p-5 shadow-card border border-gray-100 flex flex-col justify-between min-h-[110px] sm:min-h-[130px]">
        <div className="flex items-start justify-between">
          <p className="text-gray-500 text-xs font-display font-600 uppercase tracking-widest">Portfolio Value</p>
          <div className="w-9 h-9 rounded-lg bg-eb-gold-100 flex items-center justify-center">
            <Icon name="BuildingOffice2Icon" size={17} className="text-eb-gold-600" />
          </div>
        </div>
        <div>
          <p className="tabular-nums text-gray-900 font-display text-2xl sm:text-3xl font-800 mt-2">{totalPortfolio > 0 ? formatCurrency(totalPortfolio) : '$0'}</p>
          <p className="text-xs text-gray-400 font-medium mt-1">across {apps.length} deal{apps.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
    </div>
  );
}