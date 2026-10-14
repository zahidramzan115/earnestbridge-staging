'use client';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CRMContact {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  phone: string | null;
  lead_status: string;
  assigned_owner: string;
  lead_source: string | null;
  created_at: string;
  crm_companies?: { company_name: string } | null;
}

interface CRMTask {
  id: string;
  title: string;
  due_date: string | null;
  priority: string;
  task_status: string;
  assigned_to: string;
  crm_contacts?: { id: string; first_name: string; last_name: string } | null;
}

interface CRMDeal {
  id: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  deposit_amount: number | null;
  closing_date: string | null;
  app_status: string;
  eb_assigned_owner: string | null;
  primary_contact_id: string | null;
  crm_contacts?: { first_name: string; last_name: string } | null;
}

interface CRMActivity {
  id: string;
  event_type: string;
  title: string;
  detail: string | null;
  actor: string;
  created_at: string;
  crm_contacts?: { id: string; first_name: string; last_name: string } | null;
}

interface AttentionItem {
  id: string;
  type: 'overdue_task' | 'task_due_today' | 'new_lead' | 'unassigned_lead' | 'closing_soon';
  priority: number;
  label: string;
  subLabel: string;
  owner: string;
  dateLabel: string;
  href: string;
  icon: string;
  iconColor: string;
  iconBg: string;
}

// NEW: Submitted deal awaiting triage
interface SubmittedDeal {
  id: string;
  user_id: string | null;
  first_name: string;
  last_name: string;
  property_address: string | null;
  deposit_amount: number | null;
  closing_date: string | null;
  eb_assigned_owner: string | null;
  submitted_at: string | null;
  created_at: string;
  primary_contact_id: string | null;
  crm_contacts?: { id: string; first_name: string; last_name: string } | null;
}

// NEW: Deal status change from application_activity
interface DealStatusChange {
  id: string;
  application_id: string;
  title: string;
  detail: string | null;
  actor: string;
  created_at: string;
  metadata: Record<string, any> | null;
  // Joined from borrower_applications
  deal_user_id: string | null;
  deal_first_name: string;
  deal_last_name: string;
  deal_property_address: string | null;
  deal_primary_contact_id: string | null;
  deal_contact_first_name: string | null;
  deal_contact_last_name: string | null;
  deal_contact_crm_id: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OWNERS = ['Eric', 'Dan', 'Tucker'];
const OWNER_EMAIL_MAP: Record<string, string> = {
  'admin@earnestbridge.com': 'Eric',
  'deals@earnestbridge.com': 'Dan',
  'legal@earnestbridge.com': 'Tucker',
};

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

const PRIORITY_COLORS: Record<string, string> = {
  High:   'bg-red-100 text-red-700',
  Normal: 'bg-amber-100 text-amber-700',
  Low:    'bg-gray-100 text-gray-500',
};

const DEAL_STATUS_LABELS: Record<string, string> = {
  draft:                 'Draft',
  application:           'Application',
  submitted:             'Submitted',
  under_review:          'Under Review',
  in_review:             'In Review',
  approved:              'Approved',
  conditionally_approved:'Conditionally Approved',
  in_progress:           'In Progress',
  funded:                'Funded',
  closed:                'Closed',
  rejected:              'Rejected',
  expired:               'Expired',
};

const ACTIVITY_ICONS: Record<string, string> = {
  contact_created:           'UserPlusIcon',
  status_changed:            'ArrowPathIcon',
  owner_assigned:            'UserCircleIcon',
  portal_account_registered: 'ComputerDesktopIcon',
  portal_access_approved:    'CheckCircleIcon',
  repeat_inquiry:            'ArrowUturnLeftIcon',
  task_created:              'ClipboardDocumentListIcon',
  task_completed:            'CheckCircleIcon',
  deal_created:              'BriefcaseIcon',
  admin_note:                'ChatBubbleLeftIcon',
  bpcon26_promo_claimed:     'TagIcon',
  bpcon26_promo_resent:      'EnvelopeIcon',
  default:                   'BoltIcon',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function formatCurrency(v: number | null) {
  if (!v) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

function getDaysUntil(d: string | null): number | null {
  if (!d) return null;
  const diff = new Date(d + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.ceil(diff / 86400000);
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function mapEmailToOwner(email: string | undefined): string | null {
  if (!email) return null;
  const lower = email.toLowerCase().trim();
  return OWNER_EMAIL_MAP[lower] ?? null;
}

// NEW: Extract old→new status from activity metadata/detail
function parseStatusChange(activity: DealStatusChange): { oldStatus: string | null; newStatus: string | null } {
  const meta = activity.metadata;
  if (meta && typeof meta === 'object') {
    const oldS = meta.old_status || meta.from_status || meta.previous_status || null;
    const newS = meta.new_status || meta.to_status || meta.status || null;
    if (oldS || newS) {
      return {
        oldStatus: oldS ? (DEAL_STATUS_LABELS[oldS] || oldS) : null,
        newStatus: newS ? (DEAL_STATUS_LABELS[newS] || newS) : null,
      };
    }
  }
  return { oldStatus: null, newStatus: null };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, viewAllHref, viewAllLabel = 'View All' }: { title: string; viewAllHref: string; viewAllLabel?: string }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-base font-700 text-gray-900 font-display">{title}</h2>
      <Link href={viewAllHref} className="text-xs text-eb-green-700 font-600 hover:underline flex items-center gap-1">
        {viewAllLabel} <Icon name="ChevronRightIcon" size={12} />
      </Link>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-8 text-center text-sm text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
      {message}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AdminOverviewContent() {
  const supabase = useMemo(() => createClient(), []);
  const { user } = useAuth();

  // Determine owner from logged-in user
  const detectedOwner = useMemo(() => mapEmailToOwner(user?.email), [user]);
  // Default to 'my' only when owner is reliably mapped; otherwise 'all'
  const [scope, setScope] = useState<'my' | 'all'>(() => detectedOwner ? 'my' : 'all');

  // Quick Create menu state
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const quickCreateRef = React.useRef<HTMLDivElement>(null);

  // Close Quick Create on outside click
  useEffect(() => {
    if (!quickCreateOpen) return;
    function handleClick(e: MouseEvent) {
      if (quickCreateRef.current && !quickCreateRef.current.contains(e.target as Node)) {
        setQuickCreateOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setQuickCreateOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [quickCreateOpen]);

  // Resolve effective owner for filtering
  const effectiveOwner = useMemo(() => {
    if (scope === 'all') return null;
    return detectedOwner; // null if can't map → effectively shows all
  }, [scope, detectedOwner]);

  // Data state
  const [loading, setLoading] = useState(true);
  const [newLeadsCount, setNewLeadsCount] = useState(0);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [dueTodayCount, setDueTodayCount] = useState(0);
  const [overdueCount, setOverdueCount] = useState(0);
  const [closingSoonCount, setClosingSoonCount] = useState(0);

  const [newLeads, setNewLeads] = useState<CRMContact[]>([]);
  const [tasks, setTasks] = useState<CRMTask[]>([]);
  const [closingDeals, setClosingDeals] = useState<CRMDeal[]>([]);
  const [activities, setActivities] = useState<CRMActivity[]>([]);
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);

  // NEW state for deal sections
  const [submittedDeals, setSubmittedDeals] = useState<SubmittedDeal[]>([]);
  const [submittedDealsCount, setSubmittedDealsCount] = useState(0);
  const [dealStatusChanges, setDealStatusChanges] = useState<DealStatusChange[]>([]);

  // Owner assignment state
  const [ownerUpdating, setOwnerUpdating] = useState<Record<string, boolean>>({});
  const [ownerError, setOwnerError] = useState<Record<string, string>>({});

  // Inline owner assignment handler — routes through Admin-only server endpoint.
  // Direct client-side update is intentionally NOT used here because the borrower
  // RLS policy (FOR ALL / user_id = auth.uid()) would permit a borrower session to
  // also update eb_assigned_owner on their own row. The server endpoint authenticates
  // the session, verifies Admin role, validates the owner value, and logs activity.
  const handleOwnerChange = useCallback(async (dealId: string, newOwner: string) => {
    setOwnerUpdating((prev) => ({ ...prev, [dealId]: true }));
    setOwnerError((prev) => { const next = { ...prev }; delete next[dealId]; return next; });

    try {
      const res = await fetch('/api/admin/update-deal-owner', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: dealId, newOwner }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const msg = json?.error ?? 'Failed to update owner. Please try again.';
        setOwnerError((prev) => ({ ...prev, [dealId]: msg }));
        setOwnerUpdating((prev) => ({ ...prev, [dealId]: false }));
        return;
      }

      const ownerValue = newOwner === 'Unassigned' ? null : newOwner;
      // Update local state on confirmed server success
      setSubmittedDeals((prev) =>
        prev.map((d) =>
          d.id === dealId ? { ...d, eb_assigned_owner: ownerValue } : d
        )
      );
    } catch {
      setOwnerError((prev) => ({ ...prev, [dealId]: 'Network error. Please try again.' }));
    }

    setOwnerUpdating((prev) => ({ ...prev, [dealId]: false }));
  }, [submittedDeals]);

  const load = useCallback(async () => {
    setLoading(true);
    const today = new Date().toISOString().split('T')[0];
    const in14Days = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];

    // Build owner filter helper
    const applyOwner = (q: any, ownerField: string) => {
      if (effectiveOwner) return q.eq(ownerField, effectiveOwner);
      return q;
    };

    const [
      newLeadsCountRes,
      unassignedCountRes,
      dueTodayCountRes,
      overdueCountRes,
      closingSoonCountRes,
      newLeadsListRes,
      overdueTasksRes,
      dueTodayTasksRes,
      upcomingTasksRes,
      closingDealsRes,
      activitiesRes,
      // NEW: submitted deals (always team-wide)
      submittedDealsCountRes,
      submittedDealsListRes,
      // NEW: recent deal status changes from application_activity
      dealStatusChangesRes,
    ] = await Promise.all([
      // Action card counts
      applyOwner(
        supabase.from('crm_contacts').select('*', { count: 'exact', head: true })
          .eq('is_merged', false).eq('lead_status', 'New Lead'),
        'assigned_owner'
      ),
      supabase.from('crm_contacts').select('*', { count: 'exact', head: true })
        .eq('is_merged', false).eq('assigned_owner', 'Unassigned'),
      applyOwner(
        supabase.from('crm_tasks').select('*', { count: 'exact', head: true })
          .eq('task_status', 'Open').eq('due_date', today),
        'assigned_to'
      ),
      applyOwner(
        supabase.from('crm_tasks').select('*', { count: 'exact', head: true })
          .eq('task_status', 'Open').lt('due_date', today),
        'assigned_to'
      ),
      applyOwner(
        supabase.from('borrower_applications').select('*', { count: 'exact', head: true })
          .in('app_status', ['application', 'under_review', 'approved', 'in_progress'])
          .not('closing_date', 'is', null)
          .gte('closing_date', today)
          .lte('closing_date', in14Days),
        'eb_assigned_owner'
      ),

      // New Leads list (5 most recent)
      applyOwner(
        supabase.from('crm_contacts')
          .select('id, first_name, last_name, primary_email, phone, lead_status, assigned_owner, lead_source, created_at, crm_companies(company_name)')
          .eq('is_merged', false).eq('lead_status', 'New Lead')
          .order('created_at', { ascending: false }).limit(5),
        'assigned_owner'
      ),

      // Overdue tasks (for Needs Attention + Tasks section)
      applyOwner(
        supabase.from('crm_tasks')
          .select('id, title, due_date, priority, task_status, assigned_to, crm_contacts(id, first_name, last_name)')
          .eq('task_status', 'Open').lt('due_date', today)
          .order('due_date', { ascending: true }).limit(10),
        'assigned_to'
      ),

      // Due today tasks
      applyOwner(
        supabase.from('crm_tasks')
          .select('id, title, due_date, priority, task_status, assigned_to, crm_contacts(id, first_name, last_name)')
          .eq('task_status', 'Open').eq('due_date', today)
          .order('priority', { ascending: false }).limit(10),
        'assigned_to'
      ),

      // Upcoming tasks (after today)
      applyOwner(
        supabase.from('crm_tasks')
          .select('id, title, due_date, priority, task_status, assigned_to, crm_contacts(id, first_name, last_name)')
          .eq('task_status', 'Open').gt('due_date', today)
          .order('due_date', { ascending: true }).limit(10),
        'assigned_to'
      ),

      // Closing soon deals
      applyOwner(
        supabase.from('borrower_applications')
          .select('id, first_name, last_name, company_name, deposit_amount, closing_date, app_status, eb_assigned_owner, primary_contact_id, crm_contacts(first_name, last_name)')
          .in('app_status', ['application', 'under_review', 'approved', 'in_progress'])
          .not('closing_date', 'is', null)
          .gte('closing_date', today)
          .lte('closing_date', in14Days)
          .order('closing_date', { ascending: true }),
        'eb_assigned_owner'
      ),

      // Recent CRM activity (unchanged)
      supabase.from('crm_activities')
        .select('id, event_type, title, detail, actor, created_at, crm_contacts(id, first_name, last_name)')
        .order('created_at', { ascending: false }).limit(10),

      // NEW: Count of currently submitted deals (team-wide, always)
      supabase.from('borrower_applications')
        .select('*', { count: 'exact', head: true })
        .eq('app_status', 'submitted'),

      // NEW: List of submitted deals (team-wide, newest first)
      supabase.from('borrower_applications')
        .select('id, user_id, first_name, last_name, property_address, deposit_amount, closing_date, eb_assigned_owner, submitted_at, created_at, primary_contact_id, crm_contacts(id, first_name, last_name)')
        .eq('app_status', 'submitted')
        .order('submitted_at', { ascending: false, nullsFirst: false })
        .limit(10),

      // NEW: Recent deal status changes from application_activity (team-wide or scoped)
      // application_activity.application_id is text, so we fetch and join in JS
      supabase.from('application_activity')
        .select('id, application_id, title, detail, actor, created_at, metadata')
        .eq('event_type', 'status_change')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    setNewLeadsCount(newLeadsCountRes.count ?? 0);
    setUnassignedCount(unassignedCountRes.count ?? 0);
    setDueTodayCount(dueTodayCountRes.count ?? 0);
    setOverdueCount(overdueCountRes.count ?? 0);
    setClosingSoonCount(closingSoonCountRes.count ?? 0);

    const newLeadsList = (newLeadsListRes.data as CRMContact[]) || [];
    const overdueTasks = (overdueTasksRes.data as CRMTask[]) || [];
    const dueTodayTasks = (dueTodayTasksRes.data as CRMTask[]) || [];
    const upcomingTasks = (upcomingTasksRes.data as CRMTask[]) || [];
    const closingDealsList = (closingDealsRes.data as CRMDeal[]) || [];
    const activitiesList = (activitiesRes.data as CRMActivity[]) || [];

    setNewLeads(newLeadsList);
    setClosingDeals(closingDealsList);
    setActivities(activitiesList);

    // NEW: Submitted deals
    setSubmittedDealsCount(submittedDealsCountRes.count ?? 0);
    setSubmittedDeals((submittedDealsListRes.data as SubmittedDeal[]) || []);

    // NEW: Deal status changes — join deal info
    const rawStatusChanges = (dealStatusChangesRes.data as any[]) || [];
    if (rawStatusChanges.length > 0) {
      // Collect unique application IDs
      const appIds = [...new Set(rawStatusChanges.map((a) => a.application_id))];
      // Batch fetch deal info for those IDs
      const { data: dealsForActivity } = await supabase
        .from('borrower_applications')
        .select('id, user_id, first_name, last_name, property_address, primary_contact_id, eb_assigned_owner, crm_contacts(id, first_name, last_name)')
        .in('id', appIds);

      const dealMap = new Map<string, any>();
      (dealsForActivity || []).forEach((d: any) => dealMap.set(d.id, d));

      // Build normalized status change rows
      let normalized: DealStatusChange[] = rawStatusChanges.map((a) => {
        const deal = dealMap.get(a.application_id);
        const contact = deal?.crm_contacts as any;
        return {
          id: a.id,
          application_id: a.application_id,
          title: a.title,
          detail: a.detail,
          actor: a.actor,
          created_at: a.created_at,
          metadata: a.metadata,
          deal_user_id: deal?.user_id ?? null,
          deal_first_name: deal?.first_name ?? '',
          deal_last_name: deal?.last_name ?? '',
          deal_property_address: deal?.property_address ?? null,
          deal_primary_contact_id: deal?.primary_contact_id ?? null,
          deal_contact_first_name: contact?.first_name ?? null,
          deal_contact_last_name: contact?.last_name ?? null,
          deal_contact_crm_id: contact?.id ?? null,
        };
      });

      // Apply scope filter for Recent Status Changes:
      // My Work: changes on deals assigned to current admin + unassigned deals
      // All Team: all changes
      if (scope === 'my' && effectiveOwner) {
        // Fetch owner info for the deals
        const { data: ownerDeals } = await supabase
          .from('borrower_applications')
          .select('id, eb_assigned_owner')
          .in('id', appIds);
        const ownerMap = new Map<string, string>();
        (ownerDeals || []).forEach((d: any) => ownerMap.set(d.id, d.eb_assigned_owner || 'Unassigned'));
        normalized = normalized.filter((sc) => {
          const owner = ownerMap.get(sc.application_id) || 'Unassigned';
          return owner === effectiveOwner || owner === 'Unassigned';
        });
      }

      // Exclude submission events (app_status = submitted) from status changes
      // to avoid duplication with the New Deal Submissions widget.
      // We identify submission events by checking metadata.new_status === 'submitted'
      normalized = normalized.filter((sc) => {
        const meta = sc.metadata;
        if (meta && typeof meta === 'object') {
          const newS = meta.new_status || meta.to_status || meta.status;
          if (newS === 'submitted') return false;
        }
        return true;
      });

      setDealStatusChanges(normalized.slice(0, 10));
    } else {
      setDealStatusChanges([]);
    }

    // Merge tasks: overdue first, then due today, then upcoming
    const allTasks = [
      ...overdueTasks,
      ...dueTodayTasks,
      ...upcomingTasks,
    ];
    // Deduplicate by id
    const seen = new Set<string>();
    const dedupedTasks = allTasks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    setTasks(dedupedTasks.slice(0, 15));

    // Build Needs Attention items
    const attention: AttentionItem[] = [];

    // 1. Overdue tasks
    overdueTasks.slice(0, 3).forEach((t) => {
      const contact = t.crm_contacts as any;
      const daysAgo = t.due_date ? Math.abs(getDaysUntil(t.due_date) ?? 0) : 0;
      attention.push({
        id: `task-overdue-${t.id}`,
        type: 'overdue_task',
        priority: 1,
        label: t.title,
        subLabel: contact ? `${contact.first_name} ${contact.last_name}` : 'No contact',
        owner: t.assigned_to,
        dateLabel: `${daysAgo}d overdue`,
        href: '/admin/crm/tasks?view=overdue',
        icon: 'ExclamationCircleIcon',
        iconColor: 'text-red-600',
        iconBg: 'bg-red-50',
      });
    });

    // 2. Tasks due today
    dueTodayTasks.slice(0, 3).forEach((t) => {
      const contact = t.crm_contacts as any;
      attention.push({
        id: `task-today-${t.id}`,
        type: 'task_due_today',
        priority: 2,
        label: t.title,
        subLabel: contact ? `${contact.first_name} ${contact.last_name}` : 'No contact',
        owner: t.assigned_to,
        dateLabel: 'Due today',
        href: '/admin/crm/tasks?view=due_today',
        icon: 'ClockIcon',
        iconColor: 'text-amber-600',
        iconBg: 'bg-amber-50',
      });
    });

    // 3. New leads (uncontacted)
    newLeadsList.slice(0, 2).forEach((c) => {
      const company = (c.crm_companies as any)?.company_name;
      attention.push({
        id: `lead-new-${c.id}`,
        type: 'new_lead',
        priority: 3,
        label: `${c.first_name} ${c.last_name}`,
        subLabel: company || c.primary_email,
        owner: c.assigned_owner,
        dateLabel: formatRelativeTime(c.created_at),
        href: `/admin/crm/contacts/${c.id}`,
        icon: 'UserPlusIcon',
        iconColor: 'text-blue-600',
        iconBg: 'bg-blue-50',
      });
    });

    // 4. Unassigned leads (only in All Team scope)
    if (scope === 'all') {
      const { data: unassignedLeads } = await supabase
        .from('crm_contacts')
        .select('id, first_name, last_name, primary_email, lead_status, assigned_owner, created_at, crm_companies(company_name)')
        .eq('is_merged', false)
        .eq('assigned_owner', 'Unassigned')
        .not('lead_status', 'in', '("Lost","Not Qualified")')
        .order('created_at', { ascending: false })
        .limit(2);

      (unassignedLeads || []).forEach((c: any) => {
        const company = c.crm_companies?.company_name;
        attention.push({
          id: `lead-unassigned-${c.id}`,
          type: 'unassigned_lead',
          priority: 4,
          label: `${c.first_name} ${c.last_name}`,
          subLabel: company || c.primary_email,
          owner: 'Unassigned',
          dateLabel: formatRelativeTime(c.created_at),
          href: `/admin/crm/contacts/${c.id}`,
          icon: 'UserCircleIcon',
          iconColor: 'text-gray-500',
          iconBg: 'bg-gray-100',
        });
      });
    }

    // 5. Deals closing soon
    closingDealsList.slice(0, 2).forEach((d) => {
      const daysUntil = getDaysUntil(d.closing_date);
      const contact = d.crm_contacts as any;
      const name = contact
        ? `${contact.first_name} ${contact.last_name}`
        : `${d.first_name} ${d.last_name}`;
      attention.push({
        id: `deal-closing-${d.id}`,
        type: 'closing_soon',
        priority: 5,
        label: name,
        subLabel: d.company_name || 'No company',
        owner: d.eb_assigned_owner || 'Unassigned',
        dateLabel: daysUntil === 0 ? 'Closing today' : daysUntil === 1 ? 'Closing tomorrow' : `Closing in ${daysUntil}d`,
        href: `/admin/crm/deals`,
        icon: 'CalendarDaysIcon',
        iconColor: 'text-emerald-600',
        iconBg: 'bg-emerald-50',
      });
    });

    setAttentionItems(attention.slice(0, 10));
    setLoading(false);
  }, [supabase, effectiveOwner, scope]);

  useEffect(() => { load(); }, [load]);

  // Greeting
  const adminFirstName = useMemo(() => {
    if (!user) return null;
    const full = user?.user_metadata?.full_name || '';
    return full.split(' ')[0] || detectedOwner || null;
  }, [user, detectedOwner]);

  const greeting = useMemo(() => {
    const base = getGreeting();
    return adminFirstName ? `${base}, ${adminFirstName}` : base;
  }, [adminFirstName]);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 sm:space-y-8">

      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="font-display font-700 text-gray-900 text-2xl sm:text-3xl">Home</h1>
          <p className="text-sm text-gray-500 mt-1">{greeting} — your EarnestBridge CRM workspace</p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Scope Selector */}
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5 text-sm">
            <button
              onClick={() => setScope('my')}
              className={`px-3 py-1.5 rounded-md font-600 transition-all ${
                scope === 'my' ?'bg-white text-gray-900 shadow-sm' :'text-gray-500 hover:text-gray-700'
              }`}
            >
              My Work
            </button>
            <button
              onClick={() => setScope('all')}
              className={`px-3 py-1.5 rounded-md font-600 transition-all ${
                scope === 'all' ?'bg-white text-gray-900 shadow-sm' :'text-gray-500 hover:text-gray-700'
              }`}
            >
              All Team
            </button>
          </div>

          {/* Quick Create */}
          <div className="relative" ref={quickCreateRef}>
            <button
              onClick={() => setQuickCreateOpen((o) => !o)}
              aria-haspopup="true"
              aria-expanded={quickCreateOpen}
              className="flex items-center gap-1.5 px-3 py-2 bg-eb-green-700 text-white rounded-lg text-sm font-600 hover:bg-eb-green-800 transition-colors"
            >
              <Icon name="PlusIcon" size={16} />
              <span className="hidden sm:inline">New</span>
            </button>
            {quickCreateOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-20">
                <Link
                  href="/admin/crm/contacts/new"
                  onClick={() => setQuickCreateOpen(false)}
                  className="flex items-center gap-2 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 min-h-[44px]"
                >
                  <Icon name="UserPlusIcon" size={14} className="text-gray-400" /> Contact
                </Link>
                <Link
                  href="/admin/crm/deals"
                  onClick={() => setQuickCreateOpen(false)}
                  className="flex items-center gap-2 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 min-h-[44px]"
                >
                  <Icon name="BriefcaseIcon" size={14} className="text-gray-400" /> Deal
                </Link>
                <Link
                  href="/admin/crm/tasks"
                  onClick={() => setQuickCreateOpen(false)}
                  className="flex items-center gap-2 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 min-h-[44px]"
                >
                  <Icon name="ClipboardDocumentListIcon" size={14} className="text-gray-400" /> Task
                </Link>
                <Link
                  href="/admin/crm/companies"
                  onClick={() => setQuickCreateOpen(false)}
                  className="flex items-center gap-2 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 min-h-[44px]"
                >
                  <Icon name="BuildingOfficeIcon" size={14} className="text-gray-400" /> Company
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Action Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <ActionCard
          label="New Leads"
          count={newLeadsCount}
          icon="UserPlusIcon"
          iconColor="text-blue-600"
          iconBg="bg-blue-50"
          borderColor="border-blue-200"
          href="/admin/crm/contacts?status=New+Lead"
        />
        <ActionCard
          label="Unassigned"
          count={unassignedCount}
          icon="UserCircleIcon"
          iconColor="text-gray-500"
          iconBg="bg-gray-100"
          borderColor="border-gray-200"
          href="/admin/crm/contacts?owner=Unassigned"
          highlight={unassignedCount > 0}
        />
        <ActionCard
          label="Due Today"
          count={dueTodayCount}
          icon="ClockIcon"
          iconColor="text-amber-600"
          iconBg="bg-amber-50"
          borderColor="border-amber-200"
          href="/admin/crm/tasks?view=due_today"
          highlight={dueTodayCount > 0}
        />
        <ActionCard
          label="Overdue"
          count={overdueCount}
          icon="ExclamationCircleIcon"
          iconColor="text-red-600"
          iconBg="bg-red-50"
          borderColor="border-red-200"
          href="/admin/crm/tasks?view=overdue"
          highlight={overdueCount > 0}
          urgent={overdueCount > 0}
        />
        <ActionCard
          label="Closing Soon"
          count={closingSoonCount}
          icon="CalendarDaysIcon"
          iconColor="text-emerald-600"
          iconBg="bg-emerald-50"
          borderColor="border-emerald-200"
          href="/admin/crm/deals"
          highlight={closingSoonCount > 0}
        />
      </div>

      {/* ── NEW: New Deal Submissions (always team-wide) ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-700 text-gray-900 font-display">New Deal Submissions</h2>
            {submittedDealsCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-orange-500 text-white text-xs font-700 tabular-nums">
                {submittedDealsCount}
              </span>
            )}
          </div>
          <Link href="/admin/applications" className="text-xs text-eb-green-700 font-600 hover:underline flex items-center gap-1">
            View All Deals <Icon name="ChevronRightIcon" size={12} />
          </Link>
        </div>
        <p className="text-xs text-gray-400 mb-3 -mt-1">Team-wide · Deals awaiting initial review</p>
        {submittedDeals.length === 0 ? (
          <EmptyState message="No new Deal submissions are waiting for review." />
        ) : (
          <div className="bg-white rounded-xl border border-orange-200 overflow-hidden shadow-sm">
            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-orange-50">
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Property / Deal</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Client</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Submitted</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">EMD</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Closing</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Owner</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {submittedDeals.map((d) => {
                    const contact = d.crm_contacts as any;
                    const clientName = contact
                      ? `${contact.first_name} ${contact.last_name}`
                      : `${d.first_name} ${d.last_name}`;
                    const clientCrmId = contact?.id ?? null;
                    const dealLink = d.user_id
                      ? `/admin/borrower/${d.user_id}/application/${d.id}`
                      : null;
                    const submittedTs = d.submitted_at || d.created_at;
                    const currentOwner = d.eb_assigned_owner || 'Unassigned';
                    const isUpdating = ownerUpdating[d.id] ?? false;
                    const errMsg = ownerError[d.id] ?? null;
                    return (
                      <tr key={d.id} className="hover:bg-orange-50/40 transition-colors">
                        <td className="px-4 py-3">
                          {dealLink ? (
                            <Link href={dealLink} className="font-600 text-gray-900 hover:text-eb-green-700 transition-colors">
                              {d.property_address || `${d.first_name} ${d.last_name} — Deal`}
                            </Link>
                          ) : (
                            <span className="font-600 text-gray-900">
                              {d.property_address || `${d.first_name} ${d.last_name} — Deal`}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {clientCrmId ? (
                            <Link href={`/admin/crm/contacts/${clientCrmId}`} className="text-eb-green-700 hover:underline font-500">
                              {clientName}
                            </Link>
                          ) : (
                            <span className="text-gray-700">{clientName}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{formatRelativeTime(submittedTs)}</td>
                        <td className="px-4 py-3 text-gray-700 font-500">{formatCurrency(d.deposit_amount)}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{d.closing_date ? formatDate(d.closing_date) : '—'}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-1">
                            <div className="relative">
                              <select
                                value={currentOwner}
                                disabled={isUpdating}
                                onChange={(e) => handleOwnerChange(d.id, e.target.value)}
                                className={`
                                  appearance-none text-xs font-600 pl-2 pr-6 py-1 rounded-lg border cursor-pointer
                                  focus:outline-none focus:ring-2 focus:ring-eb-green-500 focus:border-transparent
                                  transition-colors min-h-[32px]
                                  ${isUpdating ? 'opacity-50 cursor-not-allowed' : ''}
                                  ${currentOwner === 'Unassigned' ?'bg-gray-50 border-gray-200 text-gray-500 hover:border-gray-300' :'bg-eb-green-50 border-eb-green-200 text-eb-green-700 hover:border-eb-green-300'
                                  }
                                `}
                                aria-label="Assign owner"
                              >
                                <option value="Unassigned">Unassigned</option>
                                {OWNERS.map((o) => (
                                  <option key={o} value={o}>{o}</option>
                                ))}
                              </select>
                              <div className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center">
                                {isUpdating ? (
                                  <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <Icon name="ChevronDownIcon" size={10} className="text-gray-400" />
                                )}
                              </div>
                            </div>
                            {errMsg && (
                              <p className="text-[10px] text-red-600 leading-tight max-w-[140px]">{errMsg}</p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {dealLink ? (
                            <Link
                              href={dealLink}
                              className="inline-flex items-center gap-1 text-xs font-600 text-eb-green-700 hover:text-eb-green-800 hover:underline whitespace-nowrap"
                            >
                              Review Deal <Icon name="ArrowRightIcon" size={12} />
                            </Link>
                          ) : (
                            <span className="text-xs text-gray-300">No link</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="sm:hidden divide-y divide-gray-100">
              {submittedDeals.map((d) => {
                const contact = d.crm_contacts as any;
                const clientName = contact
                  ? `${contact.first_name} ${contact.last_name}`
                  : `${d.first_name} ${d.last_name}`;
                const clientCrmId = contact?.id ?? null;
                const dealLink = d.user_id
                  ? `/admin/borrower/${d.user_id}/application/${d.id}`
                  : null;
                const submittedTs = d.submitted_at || d.created_at;
                const currentOwner = d.eb_assigned_owner || 'Unassigned';
                const isUpdating = ownerUpdating[d.id] ?? false;
                const errMsg = ownerError[d.id] ?? null;
                return (
                  <div key={d.id} className="px-4 py-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        {dealLink ? (
                          <Link href={dealLink} className="text-sm font-600 text-gray-900 hover:text-eb-green-700 transition-colors block truncate">
                            {d.property_address || `${d.first_name} ${d.last_name} — Deal`}
                          </Link>
                        ) : (
                          <p className="text-sm font-600 text-gray-900 truncate">
                            {d.property_address || `${d.first_name} ${d.last_name} — Deal`}
                          </p>
                        )}
                        {clientCrmId ? (
                          <Link href={`/admin/crm/contacts/${clientCrmId}`} className="text-xs text-eb-green-700 hover:underline font-500 mt-0.5 block">
                            {clientName}
                          </Link>
                        ) : (
                          <p className="text-xs text-gray-500 mt-0.5">{clientName}</p>
                        )}
                      </div>
                      {/* Inline owner selector — mobile */}
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <div className="relative">
                          <select
                            value={currentOwner}
                            disabled={isUpdating}
                            onChange={(e) => handleOwnerChange(d.id, e.target.value)}
                            className={`
                              appearance-none text-xs font-600 pl-2 pr-6 py-1 rounded-lg border cursor-pointer
                              focus:outline-none focus:ring-2 focus:ring-eb-green-500 focus:border-transparent
                              transition-colors min-h-[36px]
                              ${isUpdating ? 'opacity-50 cursor-not-allowed' : ''}
                              ${currentOwner === 'Unassigned' ?'bg-gray-50 border-gray-200 text-gray-500' :'bg-eb-green-50 border-eb-green-200 text-eb-green-700'
                              }
                            `}
                            aria-label="Assign owner"
                          >
                            <option value="Unassigned">Unassigned</option>
                            {OWNERS.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center">
                            {isUpdating ? (
                              <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Icon name="ChevronDownIcon" size={10} className="text-gray-400" />
                            )}
                          </div>
                        </div>
                        {errMsg && (
                          <p className="text-[10px] text-red-600 leading-tight text-right max-w-[120px]">{errMsg}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 text-xs text-gray-400">
                        <span>{formatRelativeTime(submittedTs)}</span>
                        {d.deposit_amount && <span>EMD: {formatCurrency(d.deposit_amount)}</span>}
                        {d.closing_date && <span>Closes {formatDate(d.closing_date)}</span>}
                      </div>
                      {dealLink && (
                        <Link
                          href={dealLink}
                          className="inline-flex items-center gap-1 text-xs font-600 text-eb-green-700 hover:underline min-h-[44px] flex-shrink-0"
                        >
                          Review <Icon name="ArrowRightIcon" size={12} />
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── NEW: Recent Deal Status Changes ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-700 text-gray-900 font-display">Recent Deal Status Changes</h2>
          <Link href="/admin/applications" className="text-xs text-eb-green-700 font-600 hover:underline flex items-center gap-1">
            View All Deals <Icon name="ChevronRightIcon" size={12} />
          </Link>
        </div>
        <p className="text-xs text-gray-400 mb-3 -mt-1">
          {scope === 'my' && effectiveOwner
            ? `${effectiveOwner}'s deals + unassigned`
            : 'All team · Most recent first'}
        </p>
        {dealStatusChanges.length === 0 ? (
          <EmptyState message="No recent Deal status changes." />
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50 overflow-hidden">
            {dealStatusChanges.map((sc) => {
              const { oldStatus, newStatus } = parseStatusChange(sc);
              const dealLink = sc.deal_user_id
                ? `/admin/borrower/${sc.deal_user_id}/application/${sc.application_id}`
                : null;
              const dealLabel = sc.deal_property_address
                || (sc.deal_first_name ? `${sc.deal_first_name} ${sc.deal_last_name} — Deal` : 'Deal');
              const clientName = sc.deal_contact_first_name
                ? `${sc.deal_contact_first_name} ${sc.deal_contact_last_name}`
                : (sc.deal_first_name ? `${sc.deal_first_name} ${sc.deal_last_name}` : null);
              const showActor = sc.actor && sc.actor !== 'System' && sc.actor !== 'Borrower';

              return (
                <div key={sc.id} className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                  <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Icon name="ArrowPathIcon" size={13} className="text-blue-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Deal name */}
                    {dealLink ? (
                      <Link href={dealLink} className="text-sm font-600 text-gray-900 hover:text-eb-green-700 transition-colors truncate block">
                        {dealLabel}
                      </Link>
                    ) : (
                      <p className="text-sm font-600 text-gray-900 truncate">{dealLabel}</p>
                    )}
                    {/* Client */}
                    {clientName && (
                      sc.deal_contact_crm_id ? (
                        <Link href={`/admin/crm/contacts/${sc.deal_contact_crm_id}`} className="text-xs text-eb-green-700 hover:underline font-500">
                          {clientName}
                        </Link>
                      ) : (
                        <p className="text-xs text-gray-400">{clientName}</p>
                      )
                    )}
                    {/* Status change label */}
                    <div className="mt-1">
                      {oldStatus && newStatus ? (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-600 font-500">
                          <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{oldStatus}</span>
                          <Icon name="ArrowRightIcon" size={10} className="text-gray-400" />
                          <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">{newStatus}</span>
                        </span>
                      ) : (
                        <p className="text-xs text-gray-500">{sc.title}</p>
                      )}
                    </div>
                    {/* Actor */}
                    {showActor && (
                      <p className="text-[10px] text-gray-300 mt-0.5">by {sc.actor}</p>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <p className="text-xs text-gray-400 whitespace-nowrap">{formatRelativeTime(sc.created_at)}</p>
                    {dealLink && (
                      <Link href={dealLink} className="text-[10px] text-eb-green-700 hover:underline mt-1 block">
                        Open Deal
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Needs Attention ── */}
      <div>
        <SectionHeader title="Needs Attention" viewAllHref="/admin/crm/contacts" viewAllLabel="View Contacts" />
        {attentionItems.length === 0 ? (
          <EmptyState message="Nothing needs attention right now. Nice work! 🎉" />
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50 overflow-hidden">
            {attentionItems.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors group"
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${item.iconBg}`}>
                  <Icon name={item.icon as any} size={16} className={item.iconColor} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-600 text-gray-900 truncate group-hover:text-eb-green-700 transition-colors">
                    {item.label}
                  </p>
                  <p className="text-xs text-gray-400 truncate">{item.subLabel}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 text-right">
                  <div className="hidden sm:block">
                    <p className="text-xs text-gray-500">{item.owner}</p>
                  </div>
                  <span className={`text-xs font-600 px-2 py-0.5 rounded-full ${
                    item.type === 'overdue_task' ? 'bg-red-100 text-red-700' :
                    item.type === 'task_due_today' ? 'bg-amber-100 text-amber-700' :
                    item.type === 'closing_soon'? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                  }`}>
                    {item.dateLabel}
                  </span>
                  <Icon name="ChevronRightIcon" size={14} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ── Two-column layout for New Leads + Tasks ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* New Leads */}
        <div>
          <SectionHeader title="New Leads" viewAllHref="/admin/crm/contacts?status=New+Lead" viewAllLabel="View All Contacts" />
          {newLeads.length === 0 ? (
            <EmptyState message="No new leads right now." />
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50 overflow-hidden">
              {newLeads.map((c) => {
                const company = (c.crm_companies as any)?.company_name;
                return (
                  <Link
                    key={c.id}
                    href={`/admin/crm/contacts/${c.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors group"
                  >
                    <div className="w-8 h-8 rounded-full bg-eb-green-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-700 text-eb-green-700">
                        {(c.first_name?.[0] || '?').toUpperCase()}{(c.last_name?.[0] || '').toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-600 text-gray-900 truncate group-hover:text-eb-green-700 transition-colors">
                        {c.first_name} {c.last_name}
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        {company || c.primary_email}
                        {c.lead_source ? ` · ${c.lead_source}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-[10px] text-gray-400">{formatRelativeTime(c.created_at)}</span>
                      <span className="text-[10px] font-500 text-gray-500">{c.assigned_owner}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Tasks */}
        <div>
          <SectionHeader title="Tasks" viewAllHref="/admin/crm/tasks" viewAllLabel="View All Tasks" />
          {tasks.length === 0 ? (
            <EmptyState message="No open tasks." />
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50 overflow-hidden">
              {tasks.slice(0, 8).map((t) => {
                const contact = t.crm_contacts as any;
                const today = new Date().toISOString().split('T')[0];
                const isOverdue = t.due_date ? t.due_date < today : false;
                const isDueToday = t.due_date === today;
                return (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                    <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                      t.priority === 'High' ? 'bg-red-500' :
                      t.priority === 'Normal' ? 'bg-amber-400' : 'bg-gray-300'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-600 text-gray-900 truncate">{t.title}</p>
                      <p className="text-xs text-gray-400 truncate">
                        {contact ? `${contact.first_name} ${contact.last_name} · ` : ''}
                        {t.assigned_to}
                      </p>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      {t.due_date ? (
                        <span className={`text-xs font-600 px-2 py-0.5 rounded-full ${
                          isOverdue ? 'bg-red-100 text-red-700' : isDueToday ?'bg-amber-100 text-amber-700': 'bg-gray-100 text-gray-500'
                        }`}>
                          {isOverdue ? `${Math.abs(getDaysUntil(t.due_date) ?? 0)}d overdue` :
                           isDueToday ? 'Today' :
                           formatDate(t.due_date)}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">No date</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Upcoming Closings ── */}
      <div>
        <SectionHeader title="Upcoming Closings" viewAllHref="/admin/crm/deals" viewAllLabel="View All Deals" />
        {closingDeals.length === 0 ? (
          <EmptyState message="No deals closing in the next 14 days." />
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Client / Deal</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Company</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Owner</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">EMD</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Closing</th>
                    <th className="text-left px-4 py-3 text-xs font-600 text-gray-500 uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {closingDeals.map((d) => {
                    const contact = d.crm_contacts as any;
                    const name = contact
                      ? `${contact.first_name} ${contact.last_name}`
                      : `${d.first_name} ${d.last_name}`;
                    const daysUntil = getDaysUntil(d.closing_date);
                    return (
                      <tr key={d.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-600 text-gray-900">{name}</td>
                        <td className="px-4 py-3 text-gray-500">{d.company_name || '—'}</td>
                        <td className="px-4 py-3 text-gray-500">{d.eb_assigned_owner || 'Unassigned'}</td>
                        <td className="px-4 py-3 text-gray-700 font-500">{formatCurrency(d.deposit_amount)}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-600 px-2 py-0.5 rounded-full ${
                            daysUntil !== null && daysUntil <= 3 ? 'bg-red-100 text-red-700' :
                            daysUntil !== null && daysUntil <= 7 ? 'bg-amber-100 text-amber-700': 'bg-emerald-100 text-emerald-700'
                          }`}>
                            {daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `${daysUntil}d`}
                          </span>
                          <span className="ml-2 text-xs text-gray-400">{formatDate(d.closing_date)}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-gray-500">{DEAL_STATUS_LABELS[d.app_status] || d.app_status}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="sm:hidden divide-y divide-gray-50">
              {closingDeals.map((d) => {
                const contact = d.crm_contacts as any;
                const name = contact
                  ? `${contact.first_name} ${contact.last_name}`
                  : `${d.first_name} ${d.last_name}`;
                const daysUntil = getDaysUntil(d.closing_date);
                return (
                  <div key={d.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-600 text-gray-900">{name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{d.company_name || '—'} · {d.eb_assigned_owner || 'Unassigned'}</p>
                      </div>
                      <span className={`text-xs font-600 px-2 py-0.5 rounded-full flex-shrink-0 ${
                        daysUntil !== null && daysUntil <= 3 ? 'bg-red-100 text-red-700' :
                        daysUntil !== null && daysUntil <= 7 ? 'bg-amber-100 text-amber-700': 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `${daysUntil}d`}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                      <span>{formatDate(d.closing_date)}</span>
                      <span>·</span>
                      <span>{formatCurrency(d.deposit_amount)} EMD</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Recent Activity (CRM) ── */}
      <div>
        <SectionHeader title="Recent Activity" viewAllHref="/admin/crm/contacts" viewAllLabel="View Contacts" />
        {activities.length === 0 ? (
          <EmptyState message="No recent activity." />
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50 overflow-hidden">
            {activities.map((a) => {
              const contact = a.crm_contacts as any;
              const iconName = ACTIVITY_ICONS[a.event_type] || ACTIVITY_ICONS.default;
              return (
                <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Icon name={iconName as any} size={13} className="text-gray-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700 leading-snug">{a.title}</p>
                    {contact && (
                      <Link
                        href={`/admin/crm/contacts/${contact.id}`}
                        className="text-xs text-eb-green-700 hover:underline font-500"
                      >
                        {contact.first_name} {contact.last_name}
                      </Link>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <p className="text-xs text-gray-400">{formatRelativeTime(a.created_at)}</p>
                    <p className="text-[10px] text-gray-300 mt-0.5">{a.actor}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Action Card ──────────────────────────────────────────────────────────────

function ActionCard({
  label,
  count,
  icon,
  iconColor,
  iconBg,
  borderColor,
  href,
  highlight = false,
  urgent = false,
}: {
  label: string;
  count: number;
  icon: string;
  iconColor: string;
  iconBg: string;
  borderColor: string;
  href: string;
  highlight?: boolean;
  urgent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group flex flex-col gap-2 p-4 rounded-xl border transition-all duration-150 hover:shadow-md ${
        urgent && count > 0
          ? 'bg-red-50 border-red-200'
          : highlight && count > 0
          ? `bg-white ${borderColor}`
          : 'bg-white border-gray-200'
      }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconBg}`}>
        <Icon name={icon as any} size={18} className={iconColor} />
      </div>
      <div>
        <p className={`text-2xl font-800 font-display tabular-nums ${
          urgent && count > 0 ? 'text-red-700' : 'text-gray-900'
        }`}>{count}</p>
        <p className="text-xs text-gray-500 font-500 leading-tight mt-0.5">{label}</p>
      </div>
    </Link>
  );
}
