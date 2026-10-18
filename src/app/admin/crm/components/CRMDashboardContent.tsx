'use client';
import React, { useEffect, useState, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';

interface CRMStats {
  newLeadsThisMonth: number;
  uncontactedLeads: number;
  qualifiedLeads: number;
  activeDealContacts: number;
  followUpsDueToday: number;
  overdueFollowUps: number;
  unassignedLeads: number;
  pendingPortalApprovals: number;
}

interface RecentContact {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  lead_status: string;
  assigned_owner: string;
  created_at: string;
  crm_companies?: { company_name: string } | null;
}

interface RecentActivity {
  id: string;
  event_type: string;
  title: string;
  detail: string | null;
  actor: string;
  created_at: string;
  crm_contacts?: { first_name: string; last_name: string } | null;
}

interface UpcomingTask {
  id: string;
  title: string;
  due_date: string | null;
  priority: string;
  assigned_to: string;
  crm_contacts?: { first_name: string; last_name: string } | null;
}

const STATUS_COLORS: Record<string, string> = {
  'New Lead':       'bg-blue-100 text-blue-700 border-blue-200',
  'Contacted':      'bg-purple-100 text-purple-700 border-purple-200',
  'Qualified':      'bg-amber-100 text-amber-700 border-amber-200',
  'Deal Submitted': 'bg-orange-100 text-orange-700 border-orange-200',
  'Client':         'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Nurture':        'bg-teal-100 text-teal-700 border-teal-200',
  'Lost':           'bg-red-100 text-red-700 border-red-200',
  'Not Qualified':  'bg-gray-100 text-gray-600 border-gray-200',
};

const ACTIVITY_ICONS: Record<string, string> = {
  contact_created:          'UserPlusIcon',
  status_changed:           'ArrowPathIcon',
  owner_assigned:           'UserCircleIcon',
  portal_account_registered:'ComputerDesktopIcon',
  portal_access_approved:   'CheckCircleIcon',
  repeat_inquiry:           'ArrowUturnLeftIcon',
  task_created:             'ClipboardDocumentListIcon',
  deal_created:             'BriefcaseIcon',
  admin_note:               'ChatBubbleLeftIcon',
  default:                  'BoltIcon',
};

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDate(d: string | null) {
  if (!d) return '—';
  const [y, m, day] = d.split('T')[0].split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m)-1]} ${parseInt(day)}, ${y}`;
}

export default function CRMDashboardContent() {
  const supabase = createClient();
  const [stats, setStats] = useState<CRMStats>({
    newLeadsThisMonth: 0,
    uncontactedLeads: 0,
    qualifiedLeads: 0,
    activeDealContacts: 0,
    followUpsDueToday: 0,
    overdueFollowUps: 0,
    unassignedLeads: 0,
    pendingPortalApprovals: 0,
  });
  const [recentContacts, setRecentContacts] = useState<RecentContact[]>([]);
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [upcomingTasks, setUpcomingTasks] = useState<UpcomingTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const today = new Date().toISOString().split('T')[0];
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

      const [
        newLeadsResult,
        uncontactedResult,
        qualifiedResult,
        unassignedResult,
        pendingPortalResult,
        followUpsTodayResult,
        overdueFollowUpsResult,
        contactsResult,
        activitiesResult,
        tasksResult,
      ] = await Promise.all([
        supabase.from('crm_contacts').select('*', { count: 'exact', head: true })
          .eq('is_merged', false).is('purged_at', null).eq('lead_status', 'New Lead').gte('created_at', monthStart),
        supabase.from('crm_contacts').select('*', { count: 'exact', head: true })
          .eq('is_merged', false).is('purged_at', null).eq('lead_status', 'New Lead').is('last_contacted_at', null),
        supabase.from('crm_contacts').select('*', { count: 'exact', head: true })
          .eq('is_merged', false).is('purged_at', null).eq('lead_status', 'Qualified'),
        supabase.from('crm_contacts').select('*', { count: 'exact', head: true })
          .eq('is_merged', false).is('purged_at', null).eq('assigned_owner', 'Unassigned'),
        supabase.from('crm_contacts').select('*', { count: 'exact', head: true })
          .eq('is_merged', false).is('purged_at', null).eq('portal_link_status', 'pending'),
        supabase.from('crm_tasks').select('*', { count: 'exact', head: true })
          .eq('task_status', 'Open').eq('due_date', today),
        supabase.from('crm_tasks').select('*', { count: 'exact', head: true })
          .eq('task_status', 'Open').lt('due_date', today),
        supabase.from('crm_contacts').select('id, first_name, last_name, primary_email, lead_status, assigned_owner, created_at, crm_companies(company_name)')
          .eq('is_merged', false).is('purged_at', null).order('created_at', { ascending: false }).limit(8),
        supabase.from('crm_activities').select('id, event_type, title, detail, actor, created_at, crm_contacts(first_name, last_name)')
          .order('created_at', { ascending: false }).limit(12),
        supabase.from('crm_tasks').select('id, title, due_date, priority, assigned_to, crm_contacts(first_name, last_name)')
          .eq('task_status', 'Open').gte('due_date', today).order('due_date', { ascending: true }).limit(8),
      ]);

      // Active deal contacts: contacts linked to active deals (separate query to avoid subquery complexity)
      const { data: activeDeals } = await supabase
        .from('borrower_applications')
        .select('id')
        .is('purged_at', null)
        .in('app_status', ['approved', 'in_progress', 'funded']);

      let activeDealContactCount = 0;
      if (activeDeals && activeDeals.length > 0) {
        const activeDealIds = activeDeals.map((d: { id: string }) => d.id);
        const { count: adcCount } = await supabase
          .from('crm_deal_contacts')
          .select('contact_id', { count: 'exact', head: true })
          .in('deal_id', activeDealIds);
        activeDealContactCount = adcCount || 0;
      }

      const newLeads = newLeadsResult.count;
      const uncontacted = uncontactedResult.count;
      const qualified = qualifiedResult.count;
      const unassigned = unassignedResult.count;
      const pendingPortal = pendingPortalResult.count;
      const followUpsToday = followUpsTodayResult.count;
      const overdueFollowUps = overdueFollowUpsResult.count;
      const contacts = contactsResult.data;
      const activities = activitiesResult.data;
      const tasks = tasksResult.data;

      setStats({
        newLeadsThisMonth: newLeads || 0,
        uncontactedLeads: uncontacted || 0,
        qualifiedLeads: qualified || 0,
        activeDealContacts: activeDealContactCount,
        followUpsDueToday: followUpsToday || 0,
        overdueFollowUps: overdueFollowUps || 0,
        unassignedLeads: unassigned || 0,
        pendingPortalApprovals: pendingPortal || 0,
      });
      setRecentContacts((contacts as RecentContact[]) || []);
      setRecentActivity((activities as RecentActivity[]) || []);
      setUpcomingTasks((tasks as UpcomingTask[]) || []);
      setLoading(false);
    }
    load();
  }, []);

  const statCards = useMemo(() => [
    { label: 'New Leads This Month', value: stats.newLeadsThisMonth, icon: 'UserPlusIcon', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', href: '/admin/crm/contacts?status=New+Lead' },
    { label: 'Uncontacted Leads',    value: stats.uncontactedLeads,  icon: 'EnvelopeOpenIcon', color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', href: '/admin/crm/contacts?status=New+Lead' },
    { label: 'Qualified Leads',      value: stats.qualifiedLeads,    icon: 'StarIcon', color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', href: '/admin/crm/contacts?status=Qualified' },
    { label: 'Unassigned Leads',     value: stats.unassignedLeads,   icon: 'UserCircleIcon', color: 'text-gray-600', bg: 'bg-gray-50', border: 'border-gray-200', href: '/admin/crm/contacts?owner=Unassigned' },
    { label: 'Follow-Ups Due Today', value: stats.followUpsDueToday, icon: 'CalendarDaysIcon', color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-200', href: '/admin/crm/tasks?view=due_today' },
    { label: 'Overdue Follow-Ups',   value: stats.overdueFollowUps,  icon: 'ExclamationCircleIcon', color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', href: '/admin/crm/tasks?view=overdue' },
    { label: 'Pending Portal Approvals', value: stats.pendingPortalApprovals, icon: 'ShieldExclamationIcon', color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200', href: '/admin/crm/contacts?portal_status=pending' },
  ], [stats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-7 h-7 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-700 text-gray-900 font-display tracking-tight">CRM Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Lead pipeline, follow-ups, and recent activity</p>
        </div>
        <Link
          href="/admin/crm/contacts/new"
          className="flex items-center gap-2 px-4 py-2 bg-eb-green-700 text-white rounded-lg text-sm font-600 hover:bg-eb-green-800 transition-colors"
        >
          <Icon name="PlusIcon" size={16} />
          New Contact
        </Link>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {statCards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className={`group p-4 rounded-xl border ${card.border} ${card.bg} hover:shadow-md transition-all duration-150`}
          >
            <div className="flex items-start justify-between mb-2">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${card.bg} border ${card.border}`}>
                <Icon name={card.icon as any} size={16} className={card.color} />
              </div>
            </div>
            <p className={`text-2xl font-700 ${card.color} font-display`}>{card.value}</p>
            <p className="text-xs text-gray-500 mt-0.5 leading-tight">{card.label}</p>
          </Link>
        ))}
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Leads */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-700 text-gray-900 font-display">Recent Leads</h2>
            <Link href="/admin/crm/contacts" className="text-xs text-eb-green-700 font-600 hover:underline">
              View all →
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {recentContacts.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-400">No contacts yet</div>
            ) : (
              recentContacts.map((c) => (
                <Link
                  key={c.id}
                  href={`/admin/crm/contacts/${c.id}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-eb-green-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-700 text-eb-green-700">
                      {(c.first_name?.[0] || '?').toUpperCase()}{(c.last_name?.[0] || '').toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-600 text-gray-900 truncate">
                      {c.first_name} {c.last_name}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      {(c.crm_companies as any)?.company_name || c.primary_email}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 border ${STATUS_COLORS[c.lead_status] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                      {c.lead_status}
                    </span>
                    <span className="text-[10px] text-gray-400">{formatRelativeTime(c.created_at)}</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-4">
          {/* Upcoming Tasks */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-700 text-gray-900 font-display">Upcoming Tasks</h2>
              <Link href="/admin/crm/tasks" className="text-xs text-eb-green-700 font-600 hover:underline">
                View all →
              </Link>
            </div>
            <div className="divide-y divide-gray-50">
              {upcomingTasks.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-gray-400">No upcoming tasks</div>
              ) : (
                upcomingTasks.slice(0, 5).map((t) => (
                  <div key={t.id} className="px-5 py-3">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${t.priority === 'High' ? 'bg-red-500' : t.priority === 'Normal' ? 'bg-amber-400' : 'bg-gray-300'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-600 text-gray-800 truncate">{t.title}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          {(t.crm_contacts as any) ? `${(t.crm_contacts as any).first_name} ${(t.crm_contacts as any).last_name} · ` : ''}
                          {t.due_date ? formatDate(t.due_date) : 'No due date'}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="text-sm font-700 text-gray-900 font-display">Recent CRM Activity</h2>
            </div>
            <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
              {recentActivity.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-gray-400">No activity yet</div>
              ) : (
                recentActivity.map((a) => (
                  <div key={a.id} className="flex items-start gap-3 px-5 py-3">
                    <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Icon name={(ACTIVITY_ICONS[a.event_type] || ACTIVITY_ICONS.default) as any} size={12} className="text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-700 leading-snug">{a.title}</p>
                      {(a.crm_contacts as any) && (
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          {(a.crm_contacts as any).first_name} {(a.crm_contacts as any).last_name}
                        </p>
                      )}
                      <p className="text-[10px] text-gray-400">{formatRelativeTime(a.created_at)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Pipeline Summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-700 text-gray-900 font-display mb-4">Lead Pipeline</h2>
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'New Lead', color: 'bg-blue-500' },
            { label: 'Contacted', color: 'bg-purple-500' },
            { label: 'Qualified', color: 'bg-amber-500' },
            { label: 'Deal Submitted', color: 'bg-orange-500' },
            { label: 'Client', color: 'bg-emerald-500' },
            { label: 'Nurture', color: 'bg-teal-500' },
            { label: 'Lost', color: 'bg-red-400' },
            { label: 'Not Qualified', color: 'bg-gray-400' },
          ].map((stage) => (
            <Link
              key={stage.label}
              href={`/admin/crm/contacts?status=${encodeURIComponent(stage.label)}`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all text-xs font-500 text-gray-700"
            >
              <span className={`w-2 h-2 rounded-full ${stage.color}`} />
              {stage.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
