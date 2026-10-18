'use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';

type AppStatus = 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'funded' | 'closed' | 'conditionally_approved' | 'in_review' | 'expired';
type DocRequestStatus = 'pending' | 'uploaded' | 'approved' | 'rejected' | 'expired';
type RealDocStatus = 'pending' | 'uploaded' | 'approved' | 'rejected' | 'resubmit_requested';

interface BorrowerApplication {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_name: string | null;
  property_address: string | null;
  property_type: string | null;
  purchase_price: number | null;
  deposit_amount: number | null;
  closing_date?: string | null;
  due_diligence_days?: number | null;
  app_status: AppStatus;
  submitted_at: string | null;
  created_at: string;
  identity_verified: boolean;
}

interface DocRequest {
  id: string;
  borrower_name: string;
  borrower_email: string;
  document_type: string;
  requested_at: string;
  due_date: string;
  status: DocRequestStatus;
  notes: string | null;
  property_address: string;
}

// Real document from borrower_documents table
interface RealBorrowerDoc {
  id: string;
  application_id: string | null;
  user_id: string;
  document_name: string;
  document_type: string;
  category: string;
  doc_status: RealDocStatus;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  admin_notes: string | null;
  resubmit_reason: string | null;
  uploaded_at: string | null;
  created_at: string;
  // joined from borrower_applications
  borrower_first_name?: string;
  borrower_last_name?: string;
  borrower_email?: string;
  property_address?: string | null;
}

const REAL_DOC_STATUS_CONFIG: Record<RealDocStatus, {label: string;color: string;bg: string;border: string;icon: string;}> = {
  pending: { label: 'Pending', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', icon: 'ClockIcon' },
  uploaded: { label: 'Submitted', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200', icon: 'ArrowUpTrayIcon' },
  approved: { label: 'Approved', color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'CheckCircleIcon' },
  rejected: { label: 'Rejected', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', icon: 'XCircleIcon' },
  resubmit_requested: { label: 'Resubmit Needed', color: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200', icon: 'ArrowPathIcon' }
};

const STATUS_CONFIG: Record<AppStatus, {label: string;color: string;bg: string;}> = {
  draft: { label: 'Draft', color: 'text-gray-600', bg: 'bg-gray-100' },
  submitted: { label: 'Submitted', color: 'text-blue-700', bg: 'bg-blue-100' },
  under_review: { label: 'Under Review', color: 'text-amber-700', bg: 'bg-amber-100' },
  approved: { label: 'Approved', color: 'text-green-700', bg: 'bg-green-100' },
  rejected: { label: 'Rejected', color: 'text-red-700', bg: 'bg-red-100' },
  funded: { label: 'Funded', color: 'text-emerald-700', bg: 'bg-emerald-100' },
  closed: { label: 'Closed', color: 'text-gray-700', bg: 'bg-gray-200' },
  conditionally_approved: { label: 'Cond. Approved', color: 'text-teal-700', bg: 'bg-teal-100' },
  in_review: { label: 'In Review', color: 'text-amber-700', bg: 'bg-amber-100' },
  expired: { label: 'Expired', color: 'text-gray-500', bg: 'bg-gray-100' }
};

const DOC_STATUS_CONFIG: Record<DocRequestStatus, {label: string;color: string;bg: string;icon: string;}> = {
  pending: { label: 'Pending', color: 'text-amber-700', bg: 'bg-amber-100', icon: 'ClockIcon' },
  uploaded: { label: 'Uploaded', color: 'text-blue-700', bg: 'bg-blue-100', icon: 'ArrowUpTrayIcon' },
  approved: { label: 'Approved', color: 'text-green-700', bg: 'bg-green-100', icon: 'CheckCircleIcon' },
  rejected: { label: 'Rejected', color: 'text-red-700', bg: 'bg-red-100', icon: 'XCircleIcon' },
  expired: { label: 'Expired', color: 'text-gray-600', bg: 'bg-gray-100', icon: 'ExclamationTriangleIcon' }
};

const ALL_STATUSES: AppStatus[] = ['draft', 'submitted', 'under_review', 'in_review', 'conditionally_approved', 'approved', 'funded', 'closed', 'rejected', 'expired'];

// ── Demo / fallback data ───────────────────────────────────────────────────
const DEMO_APPLICATIONS: BorrowerApplication[] = [
{
  id: 'demo-1', user_id: 'u1', first_name: 'Marcus', last_name: 'Thompson', email: 'marcus.thompson@email.com',
  phone: '(212) 555-0101', company_name: 'Thompson Capital LLC', property_address: '142 West 57th St, New York, NY 10019',
  property_type: 'Commercial', purchase_price: 4200000, deposit_amount: 420000, closing_date: '2026-05-15',
  app_status: 'under_review', submitted_at: '2026-04-01T10:30:00Z', created_at: '2026-03-28T09:00:00Z', identity_verified: true
},
{
  id: 'demo-2', user_id: 'u2', first_name: 'Priya', last_name: 'Sharma', email: 'priya.sharma@realty.com',
  phone: '(415) 555-0202', company_name: null, property_address: '88 Lombard St, San Francisco, CA 94111',
  property_type: 'Residential', purchase_price: 1850000, deposit_amount: 185000, closing_date: '2026-04-30',
  app_status: 'approved', submitted_at: '2026-03-20T14:00:00Z', created_at: '2026-03-18T08:00:00Z', identity_verified: true
},
{
  id: 'demo-3', user_id: 'u3', first_name: 'Derek', last_name: 'Okafor', email: 'derek.okafor@ventures.io',
  phone: '(312) 555-0303', company_name: 'Okafor Ventures', property_address: '500 N Michigan Ave, Chicago, IL 60611',
  property_type: 'Mixed Use', purchase_price: 6750000, deposit_amount: 675000, closing_date: '2026-06-01',
  app_status: 'submitted', submitted_at: '2026-04-05T09:15:00Z', created_at: '2026-04-03T11:00:00Z', identity_verified: false
},
{
  id: 'demo-4', user_id: 'u4', first_name: 'Sophia', last_name: 'Reyes', email: 'sophia.reyes@gmail.com',
  phone: '(305) 555-0404', company_name: null, property_address: '1200 Brickell Ave, Miami, FL 33131',
  property_type: 'Residential', purchase_price: 980000, deposit_amount: 98000, closing_date: '2026-05-20',
  app_status: 'approved', submitted_at: '2026-03-15T16:45:00Z', created_at: '2026-03-12T10:00:00Z', identity_verified: true
},
{
  id: 'demo-5', user_id: 'u5', first_name: 'James', last_name: 'Whitfield', email: 'j.whitfield@whitfieldgroup.com',
  phone: '(713) 555-0505', company_name: 'Whitfield Group', property_address: '3200 Post Oak Blvd, Houston, TX 77056',
  property_type: 'Commercial', purchase_price: 9100000, deposit_amount: 910000, closing_date: '2026-07-10',
  app_status: 'under_review', submitted_at: '2026-04-08T11:00:00Z', created_at: '2026-04-06T09:30:00Z', identity_verified: true
},
{
  id: 'demo-6', user_id: 'u6', first_name: 'Aisha', last_name: 'Patel', email: 'aisha.patel@proptech.co',
  phone: '(617) 555-0606', company_name: 'Patel PropTech', property_address: '1 Financial Center, Boston, MA 02111',
  property_type: 'Commercial', purchase_price: 3300000, deposit_amount: 330000, closing_date: '2026-05-28',
  app_status: 'rejected', submitted_at: '2026-03-25T13:00:00Z', created_at: '2026-03-22T08:00:00Z', identity_verified: true
},
{
  id: 'demo-7', user_id: 'u7', first_name: 'Liam', last_name: 'Nguyen', email: 'liam.nguyen@email.com',
  phone: '(206) 555-0707', company_name: null, property_address: '400 Broad St, Seattle, WA 98109',
  property_type: 'Residential', purchase_price: 1250000, deposit_amount: 125000, closing_date: '2026-06-15',
  app_status: 'draft', submitted_at: null, created_at: '2026-04-10T14:00:00Z', identity_verified: false
},
{
  id: 'demo-8', user_id: 'u8', first_name: 'Elena', last_name: 'Castillo', email: 'elena.castillo@realestate.com',
  phone: '(602) 555-0808', company_name: 'Castillo RE Group', property_address: '2501 E Camelback Rd, Phoenix, AZ 85016',
  property_type: 'Mixed Use', purchase_price: 2800000, deposit_amount: 280000, closing_date: '2026-05-10',
  app_status: 'submitted', submitted_at: '2026-04-09T10:00:00Z', created_at: '2026-04-07T09:00:00Z', identity_verified: true
}];


const DEMO_DOC_REQUESTS: DocRequest[] = [
{
  id: 'dr-1', borrower_name: 'Marcus Thompson', borrower_email: 'marcus.thompson@email.com',
  document_type: 'Bank Statement (Last 3 Months)', requested_at: '2026-04-02T09:00:00Z',
  due_date: '2026-04-16', status: 'pending', notes: 'Please provide statements from primary business account.',
  property_address: '142 West 57th St, New York, NY'
},
{
  id: 'dr-2', borrower_name: 'Derek Okafor', borrower_email: 'derek.okafor@ventures.io',
  document_type: 'Proof of Funds', requested_at: '2026-04-06T10:30:00Z',
  due_date: '2026-04-20', status: 'uploaded', notes: null,
  property_address: '500 N Michigan Ave, Chicago, IL'
},
{
  id: 'dr-3', borrower_name: 'James Whitfield', borrower_email: 'j.whitfield@whitfieldgroup.com',
  document_type: 'Entity Formation Documents', requested_at: '2026-04-08T14:00:00Z',
  due_date: '2026-04-22', status: 'pending', notes: 'LLC operating agreement and articles of organization required.',
  property_address: '3200 Post Oak Blvd, Houston, TX'
},
{
  id: 'dr-4', borrower_name: 'Sophia Reyes', borrower_email: 'sophia.reyes@gmail.com',
  document_type: 'Purchase & Sale Agreement', requested_at: '2026-03-16T09:00:00Z',
  due_date: '2026-03-30', status: 'approved', notes: null,
  property_address: '1200 Brickell Ave, Miami, FL'
},
{
  id: 'dr-5', borrower_name: 'Elena Castillo', borrower_email: 'elena.castillo@realestate.com',
  document_type: 'Government-Issued ID', requested_at: '2026-04-09T11:00:00Z',
  due_date: '2026-04-23', status: 'uploaded', notes: null,
  property_address: '2501 E Camelback Rd, Phoenix, AZ'
},
{
  id: 'dr-6', borrower_name: 'Aisha Patel', borrower_email: 'aisha.patel@proptech.co',
  document_type: 'Tax Returns (2 Years)', requested_at: '2026-03-26T08:00:00Z',
  due_date: '2026-04-09', status: 'expired', notes: 'Application was rejected; document no longer required.',
  property_address: '1 Financial Center, Boston, MA'
},
{
  id: 'dr-7', borrower_name: 'Priya Sharma', borrower_email: 'priya.sharma@realty.com',
  document_type: 'Title Report', requested_at: '2026-03-21T10:00:00Z',
  due_date: '2026-04-04', status: 'approved', notes: null,
  property_address: '88 Lombard St, San Francisco, CA'
},
{
  id: 'dr-8', borrower_name: 'Marcus Thompson', borrower_email: 'marcus.thompson@email.com',
  document_type: 'Environmental Assessment', requested_at: '2026-04-03T09:00:00Z',
  due_date: '2026-04-17', status: 'rejected', notes: 'Document was incomplete. Please resubmit with Phase I report.',
  property_address: '142 West 57th St, New York, NY'
}];


function formatCurrency(val: number | null) {
  if (val == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('T')[0].split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function AdminContent() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [applications, setApplications] = useState<BorrowerApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingDemoData, setUsingDemoData] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<AppStatus | 'all'>('all');
  const [filterPropertyType, setFilterPropertyType] = useState<string>('all');
  const [filterBorrower, setFilterBorrower] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkStatus, setBulkStatus] = useState<AppStatus>('under_review');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [docFilter, setDocFilter] = useState<DocRequestStatus | 'all'>('all');
  const [docRequests, setDocRequests] = useState<DocRequest[]>(DEMO_DOC_REQUESTS);
  const [activeTab, setActiveTab] = useState<'applications' | 'documents'>('applications');

  // Real documents state
  const [realDocs, setRealDocs] = useState<RealBorrowerDoc[]>([]);
  const [realDocsLoading, setRealDocsLoading] = useState(false);
  const [realDocsError, setRealDocsError] = useState<string | null>(null);
  const [realDocFilter, setRealDocFilter] = useState<RealDocStatus | 'all'>('all');
  const [updatingDocId, setUpdatingDocId] = useState<string | null>(null);
  const [usingRealDocs, setUsingRealDocs] = useState(false);

  // Read borrower filter from URL on mount
  useEffect(() => {
    const borrowerParam = searchParams?.get('borrower');
    if (borrowerParam) {
      setFilterBorrower(borrowerParam);
      setActiveTab('applications');
    }
  }, [searchParams]);

  const fetchApplications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase.
      from('borrower_applications').
      select('id, user_id, first_name, last_name, email, phone, company_name, property_address, property_type, purchase_price, deposit_amount, due_diligence_days, app_status, submitted_at, created_at, identity_verified').
      is('purged_at', null).
      order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      // Always use real data — show empty state if no submissions yet
      setApplications(data || []);
      setUsingDemoData(false);
    } catch (err: any) {
      setError(err.message || 'Failed to load applications');
      setApplications([]);
      setUsingDemoData(false);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  // ── Fetch real borrower documents ─────────────────────────────────────────
  const fetchRealDocs = useCallback(async () => {
    setRealDocsLoading(true);
    setRealDocsError(null);
    try {
      const { data: docsData, error: docsError } = await supabase.
      from('borrower_documents').
      select('*').
      order('created_at', { ascending: false });

      if (docsError) throw docsError;

      if (!docsData || docsData.length === 0) {
        setRealDocs([]);
        setUsingRealDocs(false);
        setRealDocsLoading(false);
        return;
      }

      const appIds = [...new Set(docsData.map((d: any) => d.application_id).filter(Boolean))];
      let appMap: Record<string, {first_name: string;last_name: string;email: string;property_address: string | null;}> = {};

      if (appIds.length > 0) {
        const { data: appsData } = await supabase.
        from('borrower_applications').
        select('id, first_name, last_name, email, property_address').
        is('purged_at', null).
        in('id', appIds);

        if (appsData) {
          appsData.forEach((a: any) => {
            appMap[a.id] = { first_name: a.first_name, last_name: a.last_name, email: a.email, property_address: a.property_address };
          });
        }
      }

      const enriched: RealBorrowerDoc[] = docsData.filter((d: any) => !d.application_id || appMap[d.application_id]).map((d: any) => {
        const app = d.application_id ? appMap[d.application_id] : null;
        return {
          ...d,
          borrower_first_name: app?.first_name ?? 'Unknown',
          borrower_last_name: app?.last_name ?? '',
          borrower_email: app?.email ?? '',
          property_address: app?.property_address ?? null
        };
      });

      setRealDocs(enriched);
      setUsingRealDocs(true);
    } catch (err: any) {
      setRealDocsError(err.message || 'Failed to load documents');
      setUsingRealDocs(false);
    } finally {
      setRealDocsLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    fetchApplications();
  }, [fetchApplications]);

  useEffect(() => {
    if (activeTab === 'documents') {
      fetchRealDocs();
    }
  }, [activeTab, fetchRealDocs]);

  // ── Real-time subscription ─────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase.
    channel('admin-applications-realtime').
    on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'borrower_applications'
      },
      (payload) => {
        if (payload.eventType === 'INSERT') {
          setApplications((prev) => [payload.new as BorrowerApplication, ...prev]);
          setUsingDemoData(false);
        } else if (payload.eventType === 'UPDATE') {
          setApplications((prev) =>
          prev.map((a) =>
          a.id === (payload.new as BorrowerApplication).id ?
          payload.new as BorrowerApplication :
          a
          )
          );
        } else if (payload.eventType === 'DELETE') {
          setApplications((prev) =>
          prev.filter((a) => a.id !== (payload.old as {id: string;}).id)
          );
        }
      }
    ).
    subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  // Real-time subscription for borrower_documents
  useEffect(() => {
    const channel = supabase.
    channel('admin-docs-realtime').
    on('postgres_changes', { event: '*', schema: 'public', table: 'borrower_documents' }, (payload) => {
      if (payload.eventType === 'INSERT') {
        fetchRealDocs();
      } else if (payload.eventType === 'UPDATE') {
        setRealDocs((prev) =>
        prev.map((d) => d.id === (payload.new as RealBorrowerDoc).id ?
        { ...d, ...(payload.new as RealBorrowerDoc) } :
        d
        )
        );
      } else if (payload.eventType === 'DELETE') {
        setRealDocs((prev) => prev.filter((d) => d.id !== (payload.old as {id: string;}).id));
      }
    }).
    subscribe();
    return () => {supabase.removeChannel(channel);};
  }, [supabase, fetchRealDocs]);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const totalApplications = applications.length;
  const totalDepositVolume = applications.reduce((sum, a) => sum + (a.deposit_amount ?? 0), 0);
  const totalPurchaseVolume = applications.reduce((sum, a) => sum + (a.purchase_price ?? 0), 0);
  const statusCounts = ALL_STATUSES.reduce<Record<AppStatus, number>>((acc, s) => {
    acc[s] = applications.filter((a) => a.app_status === s).length;
    return acc;
  }, {} as Record<AppStatus, number>);

  // Applications vs Deals split
  const DEAL_STATUSES: AppStatus[] = ['approved', 'funded', 'closed'];
  const APPLICATION_STATUSES: AppStatus[] = ['draft', 'submitted', 'under_review', 'in_review', 'conditionally_approved', 'rejected', 'expired'];
  const deals = applications.filter((a) => DEAL_STATUSES.includes(a.app_status));
  const appOnly = applications.filter((a) => APPLICATION_STATUSES.includes(a.app_status));
  const totalDeals = deals.length;
  const totalAppOnly = appOnly.length;
  const dealDepositVolume = deals.reduce((sum, a) => sum + (a.deposit_amount ?? 0), 0);
  const dealPurchaseVolume = deals.reduce((sum, a) => sum + (a.purchase_price ?? 0), 0);
  const activeApplications = appOnly.filter((a) => ['submitted', 'under_review', 'in_review', 'conditionally_approved'].includes(a.app_status)).length;

  const propertyTypes = useMemo(() => {
    const types = new Set(applications.map((a) => a.property_type).filter(Boolean) as string[]);
    return Array.from(types).sort();
  }, [applications]);

  // Unique borrower names for the dropdown
  const borrowerNames = useMemo(() => {
    const names = new Set(applications.map((a) => `${a.first_name} ${a.last_name}`));
    return Array.from(names).sort();
  }, [applications]);

  // ── Filtered list ──────────────────────────────────────────────────────────
  const filtered = applications.filter((a) => {
    const matchesStatus = filterStatus === 'all' || a.app_status === filterStatus;
    const matchesPropType = filterPropertyType === 'all' || a.property_type === filterPropertyType;
    const q = searchQuery.toLowerCase();
    const matchesSearch =
    !q ||
    `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
    (a.email ?? '').toLowerCase().includes(q) ||
    (a.property_address ?? '').toLowerCase().includes(q) ||
    (a.company_name ?? '').toLowerCase().includes(q);
    const bq = filterBorrower.toLowerCase().trim();
    const matchesBorrower =
    !bq || `${a.first_name} ${a.last_name}`.toLowerCase().includes(bq);
    return matchesStatus && matchesPropType && matchesSearch && matchesBorrower;
  });

  // ── Filtered doc requests ──────────────────────────────────────────────────
  const filteredDocs = docRequests.filter((d) => docFilter === 'all' || d.status === docFilter);
  const docStatusCounts = (['pending', 'uploaded', 'approved', 'rejected', 'expired'] as DocRequestStatus[]).reduce<Record<DocRequestStatus, number>>((acc, s) => {
    acc[s] = docRequests.filter((d) => d.status === s).length;
    return acc;
  }, {} as Record<DocRequestStatus, number>);

  // ── Real doc counts (after filtered is defined) ────────────────────────────
  const realDocCounts = (['pending', 'uploaded', 'approved', 'rejected', 'resubmit_requested'] as RealDocStatus[]).reduce<Record<RealDocStatus, number>>((acc, s) => {
    acc[s] = realDocs.filter((d) => d.doc_status === s).length;
    return acc;
  }, {} as Record<RealDocStatus, number>);

  const filteredRealDocs = realDocFilter === 'all' ? realDocs : realDocs.filter((d) => d.doc_status === realDocFilter);

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id));
  const someSelected = selectedIds.size > 0;

  function toggleSelectAll() {
    if (allFilteredSelected) setSelectedIds(new Set());else
    setSelectedIds(new Set(filtered.map((a) => a.id)));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── Single status update ───────────────────────────────────────────────────
  async function updateStatus(id: string, status: AppStatus) {
    setUpdatingId(id);
    try {
      const { error: updateError } = await supabase.
      from('borrower_applications').
      update({ app_status: status, updated_at: new Date().toISOString() }).
      eq('id', id);
      if (updateError) throw updateError;
      setApplications((prev) => prev.map((a) => a.id === id ? { ...a, app_status: status } : a));

      const app = applications.find((a) => a.id === id);

      // Insert activity event so borrower's feed updates in real-time
      if (app) {
        await supabase.from('application_activity').insert({
          application_id: id,
          user_id: app.user_id,
          event_type: 'status_change',
          title: `Status Changed to ${STATUS_CONFIG[status].label}`,
          detail: `Your application status has been updated by EarnestBridge.`,
          actor: 'EarnestBridge Admin',
          metadata: { dealName: app.property_address }
        }).catch(() => {/* non-blocking */});
      }

      if (app?.email) {
        const statusLabels: Record<AppStatus, string> = {
          draft: 'Draft', submitted: 'Phase 1: Application Submitted',
          under_review: 'Phase 2: Under Review', approved: 'Phase 3: Approved', rejected: 'Application Decision Made'
        };
        fetch('/api/send-status-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            borrowerEmail: app.email,
            borrowerFirstName: app.first_name,
            borrowerLastName: app.last_name,
            newStatus: status,
            propertyAddress: app.property_address || '',
            milestoneLabel: statusLabels[status] || ''
          })
        }).catch(() => {});
      }
    } catch (err: any) {
      alert(`Update failed: ${err.message}`);
    } finally {
      setUpdatingId(null);
    }
  }

  // ── Bulk status update ─────────────────────────────────────────────────────
  async function applyBulkAction() {
    if (!someSelected) return;
    setBulkLoading(true);
    try {
      const ids = Array.from(selectedIds);
      const { error: bulkError } = await supabase.
      from('borrower_applications').
      update({ app_status: bulkStatus, updated_at: new Date().toISOString() }).
      in('id', ids);
      if (bulkError) throw bulkError;
      setApplications((prev) =>
      prev.map((a) => selectedIds.has(a.id) ? { ...a, app_status: bulkStatus } : a)
      );

      const statusLabels: Record<AppStatus, string> = {
        draft: 'Draft', submitted: 'Phase 1: Application Submitted',
        under_review: 'Phase 2: Under Review', approved: 'Phase 3: Approved', rejected: 'Application Decision Made'
      };
      const affectedApps = applications.filter((a) => selectedIds.has(a.id) && a.email);
      affectedApps.forEach((app) => {
        fetch('/api/send-status-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            borrowerEmail: app.email,
            borrowerFirstName: app.first_name,
            borrowerLastName: app.last_name,
            newStatus: bulkStatus,
            propertyAddress: app.property_address || '',
            milestoneLabel: statusLabels[bulkStatus] || ''
          })
        }).catch(() => {});
      });
      setSelectedIds(new Set());
    } catch (err: any) {
      alert(`Bulk update failed: ${err.message}`);
    } finally {
      setBulkLoading(false);
    }
  }

  // ── Doc request status update ──────────────────────────────────────────────
  function updateDocStatus(id: string, status: DocRequestStatus) {
    setDocRequests((prev) => prev.map((d) => d.id === id ? { ...d, status } : d));
  }

  // ── Real doc status update ──────────────────────────────────────────────────
  async function updateRealDocStatus(docId: string, newStatus: RealDocStatus) {
    setUpdatingDocId(docId);
    setRealDocs((prev) => prev.map((d) => d.id === docId ? { ...d, doc_status: newStatus } : d));
    try {
      await supabase.
      from('borrower_documents').
      update({ doc_status: newStatus, updated_at: new Date().toISOString() }).
      eq('id', docId);
    } catch {


      // optimistic update stays
    } finally {setUpdatingDocId(null);}
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Admin Dashboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">Review, manage, and update all borrower applications and documents.</p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={fetchApplications}
            className="flex items-center gap-1.5 px-3 py-2.5 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all active:scale-95 min-h-[40px]">

            <Icon name="ArrowPathIcon" size={14} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* ── Applications vs Deals KPI Row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* Applications */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400 font-display font-600 uppercase tracking-wide">Applications</p>
            <span className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
              <Icon name="DocumentTextIcon" size={14} className="text-blue-600" />
            </span>
          </div>
          <p className="text-xl sm:text-2xl font-display font-700 text-gray-900">{totalAppOnly}</p>
          <p className="text-xs text-blue-600 font-medium mt-1">{activeApplications} in progress</p>
        </div>

        {/* Deals */}
        <div className="bg-eb-green-900 rounded-xl p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-eb-green-300 font-display font-600 uppercase tracking-wide">Deals</p>
            <span className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
              <Icon name="BriefcaseIcon" size={14} className="text-eb-gold-400" />
            </span>
          </div>
          <p className="text-xl sm:text-2xl font-display font-700 text-white">{totalDeals}</p>
          <p className="text-xs text-eb-green-300 font-medium mt-1">
            {statusCounts.funded} funded · {statusCounts.closed} closed
          </p>
        </div>

        {/* Deal Deposit Volume */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400 font-display font-600 uppercase tracking-wide">TOTAL EMD FUNDED</p>
            <span className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
              <Icon name="CurrencyDollarIcon" size={14} className="text-emerald-600" />
            </span>
          </div>
          <p className="text-xl sm:text-2xl font-display font-700 text-eb-green-700">{formatCurrency(dealDepositVolume)}</p>
          <p className="text-xs text-gray-400 mt-1">across {totalDeals} deal{totalDeals !== 1 ? 's' : ''}</p>
        </div>

        {/* Deal Purchase Volume */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400 font-display font-600 uppercase tracking-wide">TOTAL PURCHASE VOLUME</p>
            <span className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
              <Icon name="BuildingOffice2Icon" size={14} className="text-amber-600" />
            </span>
          </div>
          <p className="text-xl sm:text-2xl font-display font-700 text-gray-900">{formatCurrency(dealPurchaseVolume)}</p>
          <p className="text-xs text-gray-400 mt-1">total deal portfolio value</p>
        </div>
      </div>

      {/* ── Status Breakdown: Applications vs Deals ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {/* Applications breakdown */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                <Icon name="DocumentTextIcon" size={14} className="text-blue-600" />
              </div>
              <p className="text-xs font-display font-700 text-gray-800 uppercase tracking-widest">Applications</p>
            </div>
            <span className="text-[11px] text-gray-400 font-medium bg-gray-50 px-2.5 py-1 rounded-full border border-gray-100">Non-approved statuses</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {APPLICATION_STATUSES.map((s) => {
              const cfg = STATUS_CONFIG[s] ?? { label: s, color: 'text-gray-600', bg: 'bg-gray-100' };
              const count = statusCounts[s];
              const pct = totalAppOnly > 0 ? Math.round(count / totalAppOnly * 100) : 0;
              const isActive = filterStatus === s;
              return (
                <button
                  key={s}
                  onClick={() => {setFilterStatus(filterStatus === s ? 'all' : s);setActiveTab('applications');}}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all min-h-[52px] text-left w-full ${
                  isActive ?
                  'border-blue-400 bg-blue-50/60 ring-1 ring-blue-400 shadow-sm' :
                  'border-gray-100 bg-gray-50/50 hover:border-gray-200 hover:bg-gray-50'}`
                  }>
                  <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-700 font-display flex-shrink-0 ${cfg.bg} ${cfg.color}`}>
                    {count}
                  </span>
                  <div className="min-w-0">
                    <p className={`text-xs font-600 truncate ${isActive ? 'text-blue-700' : 'text-gray-700'}`}>{cfg.label}</p>
                    <p className="text-[10px] text-gray-400 font-medium">{pct}%</p>
                  </div>
                </button>);

            })}
          </div>
        </div>

        {/* Deals breakdown */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-eb-green-50 flex items-center justify-center flex-shrink-0">
                <Icon name="BriefcaseIcon" size={14} className="text-eb-green-700" />
              </div>
              <p className="text-xs font-display font-700 text-gray-800 uppercase tracking-widest">Deals</p>
            </div>
            <span className="text-[11px] text-gray-400 font-medium bg-gray-50 px-2.5 py-1 rounded-full border border-gray-100">Approved → Funded → Closed</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {DEAL_STATUSES.map((s) => {
              const cfg = STATUS_CONFIG[s] ?? { label: s, color: 'text-gray-600', bg: 'bg-gray-100' };
              const count = statusCounts[s];
              const pct = totalDeals > 0 ? Math.round(count / totalDeals * 100) : 0;
              const isActive = filterStatus === s;
              return (
                <button
                  key={s}
                  onClick={() => {setFilterStatus(filterStatus === s ? 'all' : s);setActiveTab('applications');}}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all min-h-[52px] text-left w-full ${
                  isActive ?
                  'border-eb-green-500 bg-eb-green-50/60 ring-1 ring-eb-green-500 shadow-sm' :
                  'border-gray-100 bg-gray-50/50 hover:border-gray-200 hover:bg-gray-50'}`
                  }>
                  <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-700 font-display flex-shrink-0 ${cfg.bg} ${cfg.color}`}>
                    {count}
                  </span>
                  <div className="min-w-0">
                    <p className={`text-xs font-600 truncate ${isActive ? 'text-eb-green-700' : 'text-gray-700'}`}>{cfg.label}</p>
                    <p className="text-[10px] text-gray-400 font-medium">{pct}%</p>
                  </div>
                </button>);

            })}
            {totalDeals === 0 &&
            <p className="col-span-3 text-xs text-gray-400 py-3 px-1">No deals yet — approve an application to create a deal.</p>
            }
          </div>
        </div>
      </div>

      {/* ── Tab Navigation ── */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setActiveTab('applications')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-600 rounded-lg transition-all ${
          activeTab === 'applications' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`
          }>

          <Icon name="UsersIcon" size={15} />
          Borrower List
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-700 ${activeTab === 'applications' ? 'bg-eb-green-100 text-eb-green-700' : 'bg-gray-200 text-gray-500'}`}>
            {totalApplications}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('documents')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-600 rounded-lg transition-all ${
          activeTab === 'documents' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`
          }>

          <Icon name="DocumentTextIcon" size={15} />
          Document Queue
          {(usingRealDocs ? realDocCounts.uploaded : docStatusCounts.pending) > 0 &&
          <span className="text-xs px-1.5 py-0.5 rounded-full font-700 bg-amber-100 text-amber-700">
              {usingRealDocs ? realDocCounts.uploaded : docStatusCounts.pending}
            </span>
          }
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── APPLICATIONS TAB ── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'applications' &&
      <div className="space-y-4">
          {/* ── Search + Filters + Bulk Actions Bar ── */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Icon name="MagnifyingGlassIcon" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
              type="text"
              placeholder="Search by name, email, property…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500 focus:border-transparent min-h-[44px]" />

            </div>
            {/* Borrower filter */}
            <div className="relative">
              <select
              value={filterBorrower}
              onChange={(e) => setFilterBorrower(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg pl-3 pr-8 py-2.5 focus:outline-none focus:ring-2 focus:ring-eb-green-500 bg-white min-h-[44px] text-gray-700 appearance-none">

                <option value="">All Borrowers</option>
                {borrowerNames.map((name) =>
              <option key={name} value={name}>{name}</option>
              )}
              </select>
              {filterBorrower &&
            <button
              onClick={() => setFilterBorrower('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5"
              title="Clear borrower filter">

                  <Icon name="XMarkIcon" size={13} />
                </button>
            }
            </div>
            {propertyTypes.length > 0 &&
          <select
            value={filterPropertyType}
            onChange={(e) => setFilterPropertyType(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-eb-green-500 bg-white min-h-[44px] text-gray-700">

                <option value="all">All Property Types</option>
                {propertyTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
          }
            {someSelected &&
          <div className="flex flex-wrap items-center gap-2 bg-eb-green-50 border border-eb-green-200 rounded-lg px-3 py-2">
                <span className="text-xs text-eb-green-700 font-600">{selectedIds.size} selected</span>
                <span className="text-gray-300 hidden sm:inline">|</span>
                <span className="text-xs text-gray-500 hidden sm:inline">Set to:</span>
                <select
              value={bulkStatus}
              onChange={(e) => setBulkStatus(e.target.value as AppStatus)}
              className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-eb-green-500 min-h-[36px]">

                  {ALL_STATUSES.map((s) =>
              <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
              )}
                </select>
                <button
              onClick={applyBulkAction}
              disabled={bulkLoading}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-eb-green-700 text-white rounded-lg hover:bg-eb-green-800 disabled:opacity-50 transition-all min-h-[36px]">

                  {bulkLoading ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="CheckIcon" size={12} />}
                  Apply
                </button>
                <button
              onClick={() => setSelectedIds(new Set())}
              className="text-gray-400 hover:text-gray-600 transition-colors p-1 min-h-[36px] min-w-[36px] flex items-center justify-center">

                  <Icon name="XMarkIcon" size={14} />
                </button>
              </div>
          }
          </div>

          {/* ── Applications Table ── */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {loading ?
          <div className="flex items-center justify-center py-16">
                <Icon name="ArrowPathIcon" size={24} className="animate-spin text-eb-green-600" />
                <span className="ml-2 text-sm text-gray-500">Loading applications…</span>
              </div> :
          filtered.length === 0 ?
          <div className="flex flex-col items-center justify-center py-16 gap-2">
                <Icon name="DocumentTextIcon" size={32} className="text-gray-300" />
                <p className="text-sm text-gray-400">No applications found.</p>
              </div> :

          <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="w-10 px-4 py-3">
                        <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-gray-300 text-eb-green-600 focus:ring-eb-green-500" />

                      </th>
                      <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wide">Borrower</th>
                      <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wide hidden md:table-cell">Property</th>
                      <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wide hidden lg:table-cell">Deposit</th>
                      <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wide hidden lg:table-cell">Purchase Price</th>
                      <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wide hidden xl:table-cell">Due Diligence Period</th>
                      <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wide">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-600 text-gray-500 uppercase tracking-wide hidden sm:table-cell">Submitted</th>
                      <th className="px-4 py-3 text-right text-xs font-600 text-gray-500 uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filtered.map((app) => {
                  const cfg = STATUS_CONFIG[app.app_status] ?? { label: app.app_status, color: 'text-gray-600', bg: 'bg-gray-100' };
                  const isUpdating = updatingId === app.id;
                  return (
                    <tr
                      key={app.id}
                      className={`hover:bg-gray-50 transition-colors cursor-pointer ${selectedIds.has(app.id) ? 'bg-eb-green-50/40' : ''}`}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.closest('select') || target.closest('input')) return;
                        router.push(`/admin/borrower/${app.user_id}/application/${app.id}`);
                      }}>

                          <td className="px-4 py-3">
                            <input
                          type="checkbox"
                          checked={selectedIds.has(app.id)}
                          onChange={() => toggleSelect(app.id)}
                          className="rounded border-gray-300 text-eb-green-600 focus:ring-eb-green-500" />

                          </td>
                          <td className="px-4 py-3">
                            <div>
                              <div className="flex items-center gap-1.5">
                                <p className="font-600 text-gray-900 hover:text-eb-green-700 transition-colors">{app.first_name} {app.last_name}</p>
                                {app.identity_verified &&
                            <Icon name="CheckBadgeIcon" size={14} className="text-eb-green-600 flex-shrink-0" />
                            }
                              </div>
                              <p className="text-xs text-gray-400">{app.email}</p>
                              {app.company_name && <p className="text-xs text-gray-400">{app.company_name}</p>}
                            </div>
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            <p className="text-gray-700 max-w-[200px] truncate">{app.property_address ?? '—'}</p>
                            {app.property_type && <p className="text-xs text-gray-400">{app.property_type}</p>}
                          </td>
                          <td className="px-4 py-3 hidden lg:table-cell font-600 text-eb-green-700">
                            {formatCurrency(app.deposit_amount)}
                          </td>
                          <td className="px-4 py-3 hidden lg:table-cell text-gray-700">
                            {formatCurrency(app.purchase_price)}
                          </td>
                          <td className="px-4 py-3 hidden xl:table-cell text-gray-500 text-xs">
                            {app.due_diligence_days != null ? `${app.due_diligence_days} ${app.due_diligence_days === 1 ? 'Day' : 'Days'}` : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center text-xs font-600 font-display px-2 py-1 rounded-full ${cfg.bg} ${cfg.color}`}>
                              {cfg.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell text-xs text-gray-400">
                            {formatDate(app.submitted_at ?? app.created_at)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {isUpdating ?
                        <Icon name="ArrowPathIcon" size={16} className="animate-spin text-eb-green-600 ml-auto" /> :

                        <select
                          value={app.app_status}
                          onChange={(e) => updateStatus(app.id, e.target.value as AppStatus)}
                          className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-eb-green-500 bg-white">

                                {ALL_STATUSES.map((s) =>
                          <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                          )}
                              </select>
                        }
                          </td>
                        </tr>);

                })}
                  </tbody>
                </table>
                <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 text-xs text-gray-400 flex items-center justify-between">
                  <span>Showing {filtered.length} of {totalApplications} application{totalApplications !== 1 ? 's' : ''}</span>
                  {(filterStatus !== 'all' || filterPropertyType !== 'all' || searchQuery) &&
              <button
                onClick={() => {setFilterStatus('all');setFilterPropertyType('all');setSearchQuery('');}}
                className="text-eb-green-600 hover:text-eb-green-700 font-600 transition-colors">

                      Clear all filters
                    </button>
              }
                </div>
              </div>
          }
          </div>
        </div>
      }

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* ── DOCUMENT QUEUE TAB ── */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'documents' &&
      <div className="space-y-4">
          {usingRealDocs ? (
        /* ── Real Documents from Supabase ── */
        <>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-400 font-display font-600 uppercase tracking-wide">Filter by Status</p>
                  <button
                onClick={fetchRealDocs}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-all">

                    <Icon name="ArrowPathIcon" size={12} />
                    Refresh
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                onClick={() => setRealDocFilter('all')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all min-h-[40px] text-xs font-600 ${
                realDocFilter === 'all' ? 'border-eb-green-600 ring-1 ring-eb-green-600 text-eb-green-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`
                }>

                    All
                    <span className="bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded-full font-700">{realDocs.length}</span>
                  </button>
                  {(['uploaded', 'pending', 'approved', 'rejected', 'resubmit_requested'] as RealDocStatus[]).map((s) => {
                const cfg = REAL_DOC_STATUS_CONFIG[s];
                return (
                  <button
                    key={s}
                    onClick={() => setRealDocFilter(realDocFilter === s ? 'all' : s)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all min-h-[40px] text-xs font-600 ${
                    realDocFilter === s ? 'border-eb-green-600 ring-1 ring-eb-green-600' : 'border-gray-200 hover:border-gray-300'}`
                    }>

                        <span className={`inline-flex items-center gap-1 text-xs font-600 px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
                          {realDocCounts[s]}
                        </span>
                        <span className="text-gray-700">{cfg.label}</span>
                      </button>);

              })}
                </div>
              </div>

              {realDocsLoading ?
          <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center py-16 gap-2">
                  <Icon name="ArrowPathIcon" size={20} className="animate-spin text-eb-green-600" />
                  <span className="text-sm text-gray-400">Loading documents…</span>
                </div> :
          realDocsError ?
          <div className="bg-white rounded-xl border border-red-200 flex flex-col items-center justify-center py-12 gap-2">
                  <Icon name="ExclamationCircleIcon" size={28} className="text-red-400" />
                  <p className="text-sm text-red-600">{realDocsError}</p>
                </div> :
          filteredRealDocs.length === 0 ?
          <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-16 gap-2">
                  <Icon name="FolderOpenIcon" size={32} className="text-gray-300" />
                  <p className="text-sm text-gray-400">No documents found.</p>
                </div> :

          <div className="space-y-3">
                  {filteredRealDocs.map((doc) => {
              const cfg = REAL_DOC_STATUS_CONFIG[doc.doc_status] ?? REAL_DOC_STATUS_CONFIG.pending;
              const isUpdating = updatingDocId === doc.id;
              return (
                <div
                  key={doc.id}
                  className={`bg-white rounded-xl border p-4 transition-all ${
                  doc.doc_status === 'uploaded' ? 'border-blue-200 bg-blue-50/20' :
                  doc.doc_status === 'approved' ? 'border-emerald-100 bg-emerald-50/20' :
                  doc.doc_status === 'rejected' ? 'border-red-100 bg-red-50/20' :
                  doc.doc_status === 'resubmit_requested' ? 'border-orange-100 bg-orange-50/20' : 'border-gray-200'}`
                  }>

                        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1.5">
                              <p className="font-600 text-gray-900 text-sm">{doc.document_name}</p>
                              <span className={`inline-flex items-center gap-1 text-xs font-600 px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
                                <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                                {cfg.label}
                              </span>
                              <span className="text-xs text-gray-400 capitalize bg-gray-100 px-2 py-0.5 rounded-full">
                                {doc.document_type.replace(/_/g, ' ')}
                              </span>
                            </div>

                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                              <span className="flex items-center gap-1">
                                <Icon name="UserIcon" size={11} />
                                {doc.borrower_first_name} {doc.borrower_last_name}
                              </span>
                              {doc.borrower_email &&
                        <span className="flex items-center gap-1">
                                  <Icon name="EnvelopeIcon" size={11} />
                                  {doc.borrower_email}
                                </span>
                        }
                              {doc.property_address &&
                        <span className="flex items-center gap-1">
                                  <Icon name="MapPinIcon" size={11} />
                                  {doc.property_address}
                                </span>
                        }
                            </div>

                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400 mt-1">
                              <span className="capitalize">{doc.category} document</span>
                              {doc.uploaded_at &&
                        <span>Uploaded: {new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        }
                              {doc.file_name &&
                        <span className="flex items-center gap-1">
                                  <Icon name="PaperClipIcon" size={10} />
                                  {doc.file_name}
                                </span>
                        }
                            </div>

                            {doc.admin_notes &&
                      <p className="mt-2 text-xs text-gray-500 bg-white border border-gray-100 rounded-lg px-3 py-2">
                                <span className="font-600 text-gray-600">Note: </span>{doc.admin_notes}
                              </p>
                      }
                          </div>

                          <div className="flex items-center gap-2 flex-shrink-0">
                            {/* View file button */}
                            {doc.file_url &&
                      <a
                        href={doc.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 hover:bg-gray-100 rounded-lg transition-all">

                                <Icon name="EyeIcon" size={12} />
                                View File
                              </a>
                      }

                            {/* View borrower button */}
                            {doc.application_id &&
                      <button
                        onClick={() => router.push(`/admin/borrower/${doc.user_id}/application/${doc.application_id}`)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 rounded-lg transition-all">

                                <Icon name="UserIcon" size={12} />
                                View Borrower
                              </button>
                      }

                            {/* Status update */}
                            {isUpdating ?
                      <Icon name="ArrowPathIcon" size={16} className="animate-spin text-eb-green-600" /> :

                      <select
                        value={doc.doc_status}
                        onChange={(e) => updateRealDocStatus(doc.id, e.target.value as RealDocStatus)}
                        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-eb-green-500 bg-white min-h-[36px]">

                                {(['pending', 'uploaded', 'approved', 'rejected', 'resubmit_requested'] as RealDocStatus[]).map((s) =>
                        <option key={s} value={s}>{REAL_DOC_STATUS_CONFIG[s].label}</option>
                        )}
                              </select>
                      }
                          </div>
                        </div>
                      </div>);

            })}
                </div>
          }

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 font-display font-600 uppercase tracking-wide mb-3">Document Summary</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {(['uploaded', 'pending', 'approved', 'rejected', 'resubmit_requested'] as RealDocStatus[]).map((s) => {
                const cfg = REAL_DOC_STATUS_CONFIG[s];
                return (
                  <div key={s} className="text-center">
                        <p className={`text-2xl font-display font-700 ${cfg.color}`}>{realDocCounts[s]}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{cfg.label}</p>
                      </div>);

              })}
                </div>
              </div>
            </>) : (

        /* ── Demo / Fallback Document Queue ── */
        <>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 font-display font-600 uppercase tracking-wide mb-3">Document Request Status</p>
                <div className="flex flex-wrap gap-2">
                  <button
                onClick={() => setDocFilter('all')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all min-h-[40px] text-xs font-600 ${
                docFilter === 'all' ? 'border-eb-green-600 ring-1 ring-eb-green-600 text-eb-green-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`
                }>

                    All
                    <span className="bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded-full font-700">{docRequests.length}</span>
                  </button>
                  {(['pending', 'uploaded', 'approved', 'rejected', 'expired'] as DocRequestStatus[]).map((s) => {
                const cfg = DOC_STATUS_CONFIG[s];
                return (
                  <button
                    key={s}
                    onClick={() => setDocFilter(docFilter === s ? 'all' : s)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all min-h-[40px] text-xs font-600 ${
                    docFilter === s ? 'border-eb-green-600 ring-1 ring-eb-green-600' : 'border-gray-200 hover:border-gray-300'}`
                    }>

                        <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-700 ${cfg.bg} ${cfg.color}`}>
                          {docStatusCounts[s]}
                        </span>
                        <span className="text-gray-700">{cfg.label}</span>
                      </button>);

              })}
                </div>
              </div>

              <div className="space-y-3">
                {filteredDocs.length === 0 ?
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-16 gap-2">
                    <Icon name="DocumentTextIcon" size={32} className="text-gray-300" />
                    <p className="text-sm text-gray-400">No document requests found.</p>
                  </div> :

            filteredDocs.map((doc) => {
              const cfg = DOC_STATUS_CONFIG[doc.status];
              const daysUntil = getDaysUntil(doc.due_date);
              const isOverdue = daysUntil < 0 && doc.status === 'pending';
              const isDueSoon = daysUntil >= 0 && daysUntil <= 3 && doc.status === 'pending';
              return (
                <div
                  key={doc.id}
                  className={`bg-white rounded-xl border p-4 transition-all ${
                  isOverdue ? 'border-red-200 bg-red-50/30' : isDueSoon ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200'}`
                  }>

                        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <p className="font-600 text-gray-900 text-sm">{doc.document_type}</p>
                              <span className={`inline-flex items-center gap-1 text-xs font-600 px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.color}`}>
                                <Icon name={cfg.icon} size={11} />
                                {cfg.label}
                              </span>
                              {isOverdue &&
                        <span className="inline-flex items-center gap-1 text-xs font-600 px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                                  <Icon name="ExclamationCircleIcon" size={11} />
                                  Overdue
                                </span>
                        }
                              {isDueSoon &&
                        <span className="inline-flex items-center gap-1 text-xs font-600 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                  <Icon name="ClockIcon" size={11} />
                                  Due in {daysUntil}d
                                </span>
                        }
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                              <span className="flex items-center gap-1">
                                <Icon name="UserIcon" size={11} />
                                {doc.borrower_name}
                              </span>
                              <span className="flex items-center gap-1">
                                <Icon name="EnvelopeIcon" size={11} />
                                {doc.borrower_email}
                              </span>
                              <span className="flex items-center gap-1">
                                <Icon name="MapPinIcon" size={11} />
                                {doc.property_address}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400 mt-1">
                              <span>Requested: {formatDate(doc.requested_at)}</span>
                              <span className={isOverdue ? 'text-red-600 font-600' : isDueSoon ? 'text-amber-600 font-600' : ''}>
                                Due: {formatDate(doc.due_date)}
                              </span>
                            </div>
                            {doc.notes &&
                      <p className="mt-2 text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                                <span className="font-600 text-gray-600">Note: </span>{doc.notes}
                              </p>
                      }
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <select
                        value={doc.status}
                        onChange={(e) => updateDocStatus(doc.id, e.target.value as DocRequestStatus)}
                        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-eb-green-500 bg-white min-h-[36px]">

                              {(['pending', 'uploaded', 'approved', 'rejected', 'expired'] as DocRequestStatus[]).map((s) =>
                        <option key={s} value={s}>{DOC_STATUS_CONFIG[s].label}</option>
                        )}
                            </select>
                          </div>
                        </div>
                      </div>);

            })
            }
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 font-display font-600 uppercase tracking-wide mb-3">Queue Summary</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {(['pending', 'uploaded', 'approved', 'rejected', 'expired'] as DocRequestStatus[]).map((s) => {
                const cfg = DOC_STATUS_CONFIG[s];
                return (
                  <div key={s} className="text-center">
                        <p className={`text-2xl font-display font-700 ${cfg.color}`}>{docStatusCounts[s]}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{cfg.label}</p>
                      </div>);

              })}
                </div>
              </div>
            </>)
        }
        </div>
      }
    </div>);

}