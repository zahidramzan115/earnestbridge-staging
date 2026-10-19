'use client';
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import {
  ReviewStatus,
  ReviewActionButtons,
  RequestRevisionModal,
  ApproveFinalModal,
} from '@/components/DocumentReviewActions';
import DealDeadlinesSection from './DealDeadlinesSection';
import FundingOptionSection from './FundingOptionSection';
import FundingBillingSection from './FundingBillingSection';
import DealInvoicesSection from './DealInvoicesSection';
import DealCrmContactsSection from './DealCrmContactsSection';
import EmailAttachmentPicker, { AttachmentDescriptor, cleanupAttachments } from '@/components/EmailAttachmentPicker';

type AppStatus = 'draft' | 'application' | 'submitted' | 'under_review' | 'in_review' | 'approved' | 'conditionally_approved' | 'in_progress' | 'funded' | 'closed' | 'rejected' | 'expired';

interface BorrowerApplication {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_name: string | null;
  company_type: string | null;
  property_address: string | null;
  property_type: string | null;
  purchase_price: number | null;
  deposit_amount: number | null;
  emd_funded_cents?: number | null;
  closing_date?: string | null;
  due_diligence_days?: number | null;
  app_status: AppStatus;
  submitted_at: string | null;
  created_at: string;
  identity_verified: boolean;
  agreed_to_terms?: boolean;
  loi_file_url?: string | null;
  loi_file_name?: string | null;
  psa_file_url?: string | null;
  psa_file_name?: string | null;
  identity_method?: string | null;
  transaction_description?: string | null;
  llc_name?: string | null;
  llc_state?: string | null;
  llc_ein?: string | null;
  attorney_name?: string | null;
  attorney_email?: string | null;
  attorney_phone?: string | null;
  attorney_firm?: string | null;
  days_to_funding?: number | null;
  driver_license_url?: string | null;
  selfie_url?: string | null;
}

interface ActivityItem {
  id: string;
  event_type: string;
  title: string;
  detail: string;
  actor: string;
  created_at: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  draft:                  { label: 'Draft',                color: 'text-gray-500',    bg: 'bg-gray-50',     border: 'border-gray-200' },
  submitted:              { label: 'Submitted',            color: 'text-blue-700',    bg: 'bg-blue-100',    border: 'border-blue-200' },
  application:            { label: 'Application',          color: 'text-gray-600',    bg: 'bg-gray-100',    border: 'border-gray-200' },
  under_review:           { label: 'Under Review',         color: 'text-amber-700',   bg: 'bg-amber-100',   border: 'border-amber-200' },
  in_review:              { label: 'In Review',            color: 'text-amber-700',   bg: 'bg-amber-100',   border: 'border-amber-200' },
  approved:               { label: 'Approved',             color: 'text-green-700',   bg: 'bg-green-100',   border: 'border-green-200' },
  conditionally_approved: { label: 'Cond. Approved',       color: 'text-teal-700',    bg: 'bg-teal-100',    border: 'border-teal-200' },
  in_progress:            { label: 'In Progress',          color: 'text-blue-700',    bg: 'bg-blue-100',    border: 'border-blue-200' },
  funded:                 { label: 'Funded',               color: 'text-emerald-700', bg: 'bg-emerald-100', border: 'border-emerald-200' },
  closed:                 { label: 'Closed',               color: 'text-gray-700',    bg: 'bg-gray-200',    border: 'border-gray-300' },
  rejected:               { label: 'Rejected',             color: 'text-red-700',     bg: 'bg-red-100',     border: 'border-red-200' },
  expired:                { label: 'Expired',              color: 'text-gray-600',    bg: 'bg-gray-100',    border: 'border-gray-200' },
};

const ALL_STATUSES: AppStatus[] = ['application', 'submitted', 'under_review', 'approved', 'in_progress', 'funded', 'closed', 'rejected'];

const APPLICATION_PHASES = [
  { phase: 'Phase 1', label: 'Application Submitted', icon: 'DocumentTextIcon', steps: [
    { id: 1, label: 'Contact Information', description: 'Borrower name, email, phone, and company details collected.' },
    { id: 2, label: 'Deposit Details', description: 'EMD amount, deposit type, and funding source confirmed.' },
    { id: 3, label: 'Document Upload', description: 'LOI (required) and PSA (optional) uploaded and reviewed.' },
    { id: 4, label: 'Identity Verification', description: 'Government-issued ID verified and KYC checks completed.' },
    { id: 5, label: 'Submission', description: 'Application formally submitted for review.' },
  ]},
  { phase: 'Phase 2', label: 'Under Review', icon: 'MagnifyingGlassIcon', steps: [
    { id: 7, label: 'Initial Screening', description: 'Application reviewed for completeness and eligibility.' },
    { id: 8, label: 'Document Verification', description: 'All submitted documents authenticated and validated.' },
    { id: 9, label: 'Credit & Background Check', description: 'Borrower credit history and background screening completed.' },
    { id: 10, label: 'Property Assessment', description: 'Property details and market value assessed.' },
  ]},
  { phase: 'Phase 3', label: 'Approval Decision', icon: 'ClipboardDocumentCheckIcon', steps: [
    { id: 11, label: 'Underwriting Review', description: 'Full underwriting analysis performed by the credit team.' },
    { id: 12, label: 'Commitment Letter Issued', description: 'Conditional approval commitment letter sent to borrower.' },
    { id: 13, label: 'Conditions Satisfied', description: 'All outstanding conditions and stipulations cleared.' },
    { id: 14, label: 'Final Approval', description: 'Application fully approved and ready for funding.' },
  ]},
  { phase: 'Phase 4', label: 'EMD Funding', icon: 'BanknotesIcon', steps: [
    { id: 15, label: 'Loan Agreement Executed', description: 'EarnestBridge loan agreement signed by all parties.' },
    { id: 16, label: 'Wire Instructions Confirmed', description: 'Escrow wire instructions verified and confirmed.' },
    { id: 17, label: 'Funds Disbursed', description: 'EMD funds wired to escrow/title company.' },
    { id: 18, label: 'Funding Confirmed', description: 'Escrow confirms receipt of EMD funds.' },
  ]},
  { phase: 'Phase 5', label: 'Closing', icon: 'HomeModernIcon', steps: [
    { id: 19, label: 'Title & Escrow Review', description: 'Title report reviewed and escrow instructions finalized.' },
    { id: 20, label: 'Closing Documents Signed', description: 'All closing documents executed by buyer and seller.' },
    { id: 21, label: 'Transaction Closed', description: 'Property transfer recorded and transaction officially closed.' },
    { id: 22, label: 'EMD Applied / Returned', description: 'EMD applied to purchase or returned per agreement terms.' },
  ]},
];

function getPhaseIndexForStatus(status: AppStatus | string): number {
  switch (status) {
    case 'draft': case 'application': case 'submitted': return 0;
    case 'under_review': case 'in_review': return 1;
    case 'approved': case 'conditionally_approved': case 'in_progress': return 2;
    case 'funded': return 3;
    case 'closed': return 4;
    case 'rejected': case 'expired': return 2;
    default: return 0;
  }
}

function formatCurrency(val: number | null) {
  if (val == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

// Due Diligence Period is a number of calendar days (not a date).
function formatDueDiligenceDays(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return '—';
  return `${days} ${days === 1 ? 'Day' : 'Days'}`;
}

// Dynamic EMD: FUNDED (cents → dollars) only when emd_funded_cents > 0, else REQUESTED (dollars).
function getDynamicEmd(app: { deposit_amount: number | null; emd_funded_cents?: number | null }) {
  const cents = app.emd_funded_cents;
  if (cents != null && cents > 0) {
    return { isFunded: true, label: 'Funded EMD', value: formatCurrency(cents / 100) };
  }
  return { isFunded: false, label: 'Requested EMD', value: formatCurrency(app.deposit_amount) };
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('T')[0].split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function timeAgo(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffDays > 30) return `${Math.floor(diffDays / 30)}mo ago`;
  if (diffDays > 1) return `${diffDays}d ago`;
  if (diffDays === 1) return '1d ago';
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'Just now';
}

const EVENT_TYPE_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  status_change:   { icon: 'ArrowPathIcon',              color: 'text-indigo-500 bg-indigo-50',  label: 'Status Change' },
  document_upload: { icon: 'ArrowUpTrayIcon',            color: 'text-blue-500 bg-blue-50',      label: 'Document' },
  admin_note:      { icon: 'ChatBubbleLeftEllipsisIcon', color: 'text-violet-500 bg-violet-50',  label: 'Admin Note' },
  deadline_shift:  { icon: 'CalendarDaysIcon',           color: 'text-orange-500 bg-orange-50',  label: 'Deadline' },
  system:          { icon: 'InformationCircleIcon',      color: 'text-gray-400 bg-gray-50',      label: 'System' },
};

// Demo data
const DEMO_APPLICATIONS: BorrowerApplication[] = [
  { id: 'demo-1', user_id: 'u1', first_name: 'Marcus', last_name: 'Thompson', email: 'marcus.thompson@email.com', phone: '(212) 555-0101', company_name: 'Thompson Capital LLC', company_type: 'LLC', property_address: '142 West 57th St, New York, NY 10019', property_type: 'Commercial', purchase_price: 4200000, deposit_amount: 420000, closing_date: '2026-05-15', app_status: 'under_review', submitted_at: '2026-04-01T10:30:00Z', created_at: '2026-03-28T09:00:00Z', identity_verified: true, transaction_description: 'Commercial office acquisition in Midtown Manhattan.', llc_name: 'Thompson Capital LLC', llc_state: 'NY', attorney_name: 'Robert Chen', attorney_email: 'rchen@lawfirm.com', attorney_firm: 'Chen & Associates', days_to_funding: 14 },
  { id: 'demo-2', user_id: 'u2', first_name: 'Priya', last_name: 'Sharma', email: 'priya.sharma@realty.com', phone: '(415) 555-0202', company_name: null, company_type: null, property_address: '88 Lombard St, San Francisco, CA 94111', property_type: 'Residential', purchase_price: 1850000, deposit_amount: 185000, closing_date: '2026-04-30', app_status: 'approved', submitted_at: '2026-03-20T14:00:00Z', created_at: '2026-03-18T08:00:00Z', identity_verified: true, days_to_funding: 5 },
  { id: 'demo-3', user_id: 'u3', first_name: 'Derek', last_name: 'Okafor', email: 'derek.okafor@ventures.io', phone: '(312) 555-0303', company_name: 'Okafor Ventures', company_type: 'Corporation', property_address: '500 N Michigan Ave, Chicago, IL 60611', property_type: 'Mixed Use', purchase_price: 6750000, deposit_amount: 675000, closing_date: '2026-06-01', app_status: 'application', submitted_at: '2026-04-05T09:15:00Z', created_at: '2026-04-03T11:00:00Z', identity_verified: false },
  { id: 'demo-4', user_id: 'u4', first_name: 'Sophia', last_name: 'Reyes', email: 'sophia.reyes@gmail.com', phone: '(305) 555-0404', company_name: null, company_type: null, property_address: '1200 Brickell Ave, Miami, FL 33131', property_type: 'Residential', purchase_price: 980000, deposit_amount: 98000, closing_date: '2026-05-20', app_status: 'approved', submitted_at: '2026-03-15T16:45:00Z', created_at: '2026-03-12T10:00:00Z', identity_verified: true },
  { id: 'demo-5', user_id: 'u5', first_name: 'James', last_name: 'Whitfield', email: 'j.whitfield@whitfieldgroup.com', phone: '(713) 555-0505', company_name: 'Whitfield Group', company_type: 'LLC', property_address: '3200 Post Oak Blvd, Houston, TX 77056', property_type: 'Commercial', purchase_price: 9100000, deposit_amount: 910000, closing_date: '2026-07-10', app_status: 'under_review', submitted_at: '2026-04-08T11:00:00Z', created_at: '2026-04-06T09:30:00Z', identity_verified: true },
  { id: 'demo-6', user_id: 'u6', first_name: 'Aisha', last_name: 'Patel', email: 'aisha.patel@proptech.co', phone: '(617) 555-0606', company_name: 'Patel PropTech', company_type: 'Corporation', property_address: '1 Financial Center, Boston, MA 02111', property_type: 'Commercial', purchase_price: 3300000, deposit_amount: 330000, closing_date: '2026-05-28', app_status: 'rejected', submitted_at: '2026-03-25T13:00:00Z', created_at: '2026-03-22T08:00:00Z', identity_verified: true },
  { id: 'demo-7', user_id: 'u7', first_name: 'Liam', last_name: 'Nguyen', email: 'liam.nguyen@email.com', phone: '(206) 555-0707', company_name: null, company_type: null, property_address: '400 Broad St, Seattle, WA 98109', property_type: 'Residential', purchase_price: 1250000, deposit_amount: 125000, closing_date: '2026-06-15', app_status: 'application', submitted_at: null, created_at: '2026-04-10T14:00:00Z', identity_verified: false },
  { id: 'demo-8', user_id: 'u8', first_name: 'Elena', last_name: 'Castillo', email: 'elena.castillo@realestate.com', phone: '(602) 555-0808', company_name: 'Castillo RE Group', company_type: 'LLC', property_address: '2501 E Camelback Rd, Phoenix, AZ 85016', property_type: 'Mixed Use', purchase_price: 2800000, deposit_amount: 280000, closing_date: '2026-05-10', app_status: 'submitted', submitted_at: '2026-04-09T10:00:00Z', created_at: '2026-04-07T09:00:00Z', identity_verified: true },
];

function getDemoActivity(borrowerId: string): ActivityItem[] {
  return [
    { id: `${borrowerId}-a1`, event_type: 'status_change', title: 'Application Submitted', detail: 'Application received and assigned a reference number.', actor: 'System', created_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString() },
    { id: `${borrowerId}-a2`, event_type: 'document_upload', title: 'Document Uploaded', detail: 'Purchase & Sale Agreement uploaded by borrower.', actor: 'Borrower', created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() },
    { id: `${borrowerId}-a3`, event_type: 'status_change', title: 'Status Changed to Under Review', detail: 'Application moved to underwriting queue.', actor: 'EarnestBridge Underwriting', created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
    { id: `${borrowerId}-a4`, event_type: 'admin_note', title: 'Admin Note Added', detail: 'Borrower contacted to confirm entity structure. Awaiting response.', actor: 'Sarah M. (Underwriter)', created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
    { id: `${borrowerId}-a5`, event_type: 'deadline_shift', title: 'Closing Deadline Updated', detail: 'Closing date extended by 7 days per borrower request.', actor: 'EarnestBridge Admin', created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() },
  ];
}

// ── Admin-side inline reply thread ────────────────────────────────────────
interface AdminNoteReply {
  id: string;
  activity_id: string;
  application_id: string;
  user_id: string;
  actor: string;
  body: string;
  created_at: string;
}

interface AdminReplyThreadProps {
  eventId: string;
  applicationId: string;
  userId: string;
}

function AdminReplyThread({ eventId, applicationId, userId }: AdminReplyThreadProps) {
  const [replies, setReplies] = useState<AdminNoteReply[]>([]);
  const [replyText, setReplyText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    if (!open) return;
    supabase
      .from('deal_note_replies')
      .select('*')
      .eq('activity_id', eventId)
      .order('created_at', { ascending: true })
      .then(({ data }) => { if (data) setReplies(data as AdminNoteReply[]); });

    const channel = supabase
      .channel(`admin-replies-${eventId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deal_note_replies', filter: `activity_id=eq.${eventId}` }, (payload) => {
        setReplies((prev) => {
          const exists = prev.some((r) => r.id === (payload.new as AdminNoteReply).id);
          return exists ? prev : [...prev, payload.new as AdminNoteReply];
        });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [open, eventId, supabase]);

  async function handleSubmitReply() {
    if (!replyText.trim()) return;
    setSubmitting(true);
    const optimistic: AdminNoteReply = {
      id: `opt-${Date.now()}`,
      activity_id: eventId,
      application_id: applicationId,
      user_id: userId,
      actor: 'EarnestBridge Admin',
      body: replyText.trim(),
      created_at: new Date().toISOString(),
    };
    setReplies((prev) => [...prev, optimistic]);
    setReplyText('');
    try {
      await supabase.from('deal_note_replies').insert({
        activity_id: eventId,
        application_id: applicationId,
        user_id: userId,
        actor: 'EarnestBridge Admin',
        body: optimistic.body,
      });
    } catch { /* optimistic reply stays */ } finally { setSubmitting(false); }
  }

  const replyCount = replies.length;

  return (
    <div className="mt-2">
      <button
        onClick={() => { setOpen((v) => !v); if (!open) setTimeout(() => textareaRef.current?.focus(), 150); }}
        className="flex items-center gap-1.5 text-[11px] text-violet-600 hover:text-violet-800 font-display font-600 transition-colors"
      >
        <Icon name="ChatBubbleOvalLeftIcon" size={12} />
        {open ? 'Hide replies' : replyCount > 0 ? `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : 'Reply'}
      </button>
      {open && (
        <div className="mt-2 pl-3 border-l-2 border-violet-100 space-y-2">
          {replies.map((r) => (
            <div key={r.id} className="flex gap-2 items-start">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${r.actor === 'EarnestBridge Admin' ? 'bg-eb-green-900' : 'bg-gray-200'}`}>
                <Icon name="UserIcon" size={10} className={r.actor === 'EarnestBridge Admin' ? 'text-white' : 'text-gray-500'} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-[11px] font-display font-600 truncate max-w-[160px] ${r.actor === 'EarnestBridge Admin' ? 'text-eb-green-900' : 'text-gray-700'}`}>{r.actor}</span>
                  <span className="text-[10px] text-gray-400">{timeAgo(r.created_at)}</span>
                </div>
                <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{r.body}</p>
              </div>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <textarea
              ref={textareaRef}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitReply(); } }}
              placeholder="Reply to borrower…"
              rows={1}
              className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 resize-none transition-all"
            />
            <button
              onClick={handleSubmitReply}
              disabled={!replyText.trim() || submitting}
              className="px-3 py-1.5 bg-violet-600 text-white text-[11px] font-display font-600 rounded-lg hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0 min-h-[32px]"
            >
              {submitting ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Admin Document Management ─────────────────────────────────────────────
type DocApprovalStatus = 'pending' | 'uploaded' | 'approved' | 'rejected' | 'resubmit_requested';

// ── NEW: Review status types from Step 3A migration ──────────────────────
const REVIEW_STATUS_CONFIG: Record<ReviewStatus, { label: string; color: string; bg: string; border: string; icon: string }> = {
  uploaded:           { label: 'Uploaded',           color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200',    icon: 'ArrowUpTrayIcon' },
  under_review:       { label: 'Under Review',       color: 'text-amber-700',   bg: 'bg-amber-50',   border: 'border-amber-200',   icon: 'MagnifyingGlassIcon' },
  revision_requested: { label: 'Revision Requested', color: 'text-orange-700',  bg: 'bg-orange-50',  border: 'border-orange-200',  icon: 'ArrowPathIcon' },
  approved_final:     { label: 'Approved / Final',   color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'CheckBadgeIcon' },
  superseded:         { label: 'Superseded',         color: 'text-gray-500',    bg: 'bg-gray-50',    border: 'border-gray-200',    icon: 'ArchiveBoxIcon' },
};

interface BorrowerDoc {
  id: string;
  document_name: string;
  document_type: string;
  category: string;
  doc_status: DocApprovalStatus;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  admin_notes: string | null;
  resubmit_reason: string | null;
  uploaded_at: string | null;
  created_at: string;
  // Step 3A versioning fields
  document_group_id?: string | null;
  version_number?: number | null;
  is_current_version?: boolean | null;
  review_status?: ReviewStatus | null;
  review_notes?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
}

// ── NEW: Logical document group (borrower_documents) ─────────────────────
interface BorrowerDocGroup {
  groupId: string;
  currentDoc: BorrowerDoc;
  allVersions: BorrowerDoc[]; // newest first
}

// ── NEW: Application document (application_documents) ────────────────────
interface AppDoc {
  id: string;
  application_id: string;
  document_name: string;
  file_name: string;
  file_url: string | null;
  storage_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  description: string | null;
  feedback: string | null;
  uploaded_by_role: string;
  uploader_email: string | null;
  is_admin_response: boolean | null;
  created_at: string;
  parent_document_id: string | null;
  revision_number: number;
  thread_id: string | null;
  // Step 3A review fields
  is_current_version?: boolean | null;
  review_status?: ReviewStatus | null;
  review_notes?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
}

// ── NEW: Logical document group (application_documents) ──────────────────
interface AppDocThread {
  threadId: string;
  currentDoc: AppDoc;
  allVersions: AppDoc[]; // newest first
}

// ── Helper: group borrower_documents by document_group_id ────────────────
function groupBorrowerDocs(docs: BorrowerDoc[]): BorrowerDocGroup[] {
  const groupMap = new Map<string, BorrowerDoc[]>();

  for (const doc of docs) {
    const gid = doc.document_group_id ?? doc.id; // fallback: treat each doc as its own group
    if (!groupMap.has(gid)) groupMap.set(gid, []);
    groupMap.get(gid)!.push(doc);
  }

  const groups: BorrowerDocGroup[] = [];
  for (const [groupId, versions] of groupMap.entries()) {
    // Sort newest first (highest version_number first)
    const sorted = [...versions].sort((a, b) => (b.version_number ?? 1) - (a.version_number ?? 1));

    // Find current version
    let currentDoc = sorted.find((d) => d.is_current_version === true);
    if (!currentDoc) {
      // Fallback: highest version_number
      currentDoc = sorted[0];
      if (versions.length > 1) {
        console.warn(`[AdminVersionedDocuments] Group ${groupId} has no is_current_version=true row; using highest version as fallback.`);
      }
    }

    // Check for multiple current rows (data inconsistency)
    const currentRows = sorted.filter((d) => d.is_current_version === true);
    if (currentRows.length > 1) {
      console.error(`[AdminVersionedDocuments] Group ${groupId} has ${currentRows.length} rows with is_current_version=true. Using highest version.`);
      currentDoc = sorted[0]; // highest version_number
    }

    groups.push({ groupId, currentDoc, allVersions: sorted });
  }

  // Sort groups: revision_requested first, then newest upload
  groups.sort((a, b) => {
    const aStatus = a.currentDoc.review_status ?? 'uploaded';
    const bStatus = b.currentDoc.review_status ?? 'uploaded';
    const priority = (s: string) => s === 'revision_requested' ? 0 : s === 'under_review' ? 1 : 2;
    const pd = priority(aStatus) - priority(bStatus);
    if (pd !== 0) return pd;
    return new Date(b.currentDoc.uploaded_at ?? b.currentDoc.created_at).getTime() -
           new Date(a.currentDoc.uploaded_at ?? a.currentDoc.created_at).getTime();
  });

  return groups;
}

// ── Helper: group application_documents by thread_id ─────────────────────
function groupAppDocs(docs: AppDoc[]): AppDocThread[] {
  const threadMap = new Map<string, AppDoc[]>();

  for (const doc of docs) {
    const tid = doc.thread_id ?? doc.id;
    if (!threadMap.has(tid)) threadMap.set(tid, []);
    threadMap.get(tid)!.push(doc);
  }

  const threads: AppDocThread[] = [];
  for (const [threadId, versions] of threadMap.entries()) {
    const sorted = [...versions].sort((a, b) => (b.revision_number ?? 1) - (a.revision_number ?? 1));

    let currentDoc = sorted.find((d) => d.is_current_version === true);
    if (!currentDoc) {
      currentDoc = sorted[0];
      if (versions.length > 1) {
        console.warn(`[AdminVersionedAppDocuments] Thread ${threadId} has no is_current_version=true row; using highest revision as fallback.`);
      }
    }

    const currentRows = sorted.filter((d) => d.is_current_version === true);
    if (currentRows.length > 1) {
      console.error(`[AdminVersionedAppDocuments] Thread ${threadId} has ${currentRows.length} rows with is_current_version=true. Using highest revision.`);
      currentDoc = sorted[0];
    }

    threads.push({ threadId, currentDoc, allVersions: sorted });
  }

  // Sort: revision_requested first, then newest
  threads.sort((a, b) => {
    const aStatus = a.currentDoc.review_status ?? 'uploaded';
    const bStatus = b.currentDoc.review_status ?? 'uploaded';
    const priority = (s: string) => s === 'revision_requested' ? 0 : s === 'under_review' ? 1 : 2;
    const pd = priority(aStatus) - priority(bStatus);
    if (pd !== 0) return pd;
    return new Date(b.currentDoc.created_at).getTime() - new Date(a.currentDoc.created_at).getTime();
  });

  return threads;
}

const DOC_STATUS_CONFIG: Record<DocApprovalStatus, { label: string; color: string; bg: string; border: string; icon: string }> = {
  pending:             { label: 'Pending',          color: 'text-amber-700',   bg: 'bg-amber-50',   border: 'border-amber-200',   icon: 'ClockIcon' },
  uploaded:            { label: 'Submitted',        color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200',    icon: 'ArrowUpTrayIcon' },
  approved:            { label: 'Approved',         color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'CheckCircleIcon' },
  rejected:            { label: 'Rejected',         color: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200',     icon: 'XCircleIcon' },
  resubmit_requested:  { label: 'Resubmit Needed',  color: 'text-orange-700',  bg: 'bg-orange-50',  border: 'border-orange-200',  icon: 'ArrowPathIcon' },
};

const DOC_CATEGORY_ICONS: Record<string, string> = {
  identity:  'IdentificationIcon',
  financial: 'CalculatorIcon',
  property:  'HomeModernIcon',
  legal:     'DocumentTextIcon',
  other:     'FolderIcon',
};

const DEMO_DOCS: BorrowerDoc[] = [
  { id: 'ddoc-1', document_name: 'Government-Issued ID', document_type: 'identity_document', category: 'identity', doc_status: 'uploaded', file_url: null, file_name: 'passport_scan.pdf', admin_notes: null, resubmit_reason: null, uploaded_at: new Date(Date.now() - 5 * 86400000).toISOString(), created_at: new Date(Date.now() - 6 * 86400000).toISOString() },
  { id: 'ddoc-2', document_name: 'Purchase & Sale Agreement', document_type: 'psa', category: 'legal', doc_status: 'approved', file_url: null, file_name: 'psa_signed.pdf', admin_notes: 'Document verified and approved. All signatures present.', resubmit_reason: null, uploaded_at: new Date(Date.now() - 7 * 86400000).toISOString(), created_at: new Date(Date.now() - 8 * 86400000).toISOString() },
  { id: 'ddoc-3', document_name: 'Proof of Funds', document_type: 'proof_of_funds', category: 'financial', doc_status: 'pending', file_url: null, file_name: null, admin_notes: null, resubmit_reason: null, uploaded_at: null, created_at: new Date(Date.now() - 9 * 86400000).toISOString() },
  { id: 'ddoc-4', document_name: 'Bank Statement (Last 3 Months)', document_type: 'bank_statement', category: 'financial', doc_status: 'rejected', file_url: null, file_name: 'bank_statement_jan.pdf', admin_notes: 'Statement is older than 90 days. Please resubmit a current statement.', resubmit_reason: null, uploaded_at: new Date(Date.now() - 4 * 86400000).toISOString(), created_at: new Date(Date.now() - 4 * 86400000).toISOString() },
  { id: 'ddoc-5', document_name: 'LLC Operating Agreement', document_type: 'llc_agreement', category: 'legal', doc_status: 'resubmit_requested', file_url: null, file_name: 'llc_agreement_draft.pdf', admin_notes: null, resubmit_reason: 'Please provide the fully executed version with all member signatures and notarization.', uploaded_at: new Date(Date.now() - 3 * 86400000).toISOString(), created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
];

interface AdminDocumentsProps {
  applicationId: string;
  userId: string;
  borrowerEmail: string;
  borrowerFirstName: string;
  borrowerLastName: string;
  propertyAddress?: string;
}

// ── ReviewActionButtons, RequestRevisionModal, ApproveFinalModal are imported from @/components/DocumentReviewActions ──

// ── NEW: AdminVersionedDocuments — groups borrower_documents by document_group_id ──
function AdminVersionedDocuments({ applicationId, userId, borrowerEmail, borrowerFirstName, borrowerLastName, propertyAddress }: AdminDocumentsProps) {
  const supabase = useMemo(() => createClient(), []);
  const [docs, setDocs] = useState<BorrowerDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [showAdminUpload, setShowAdminUpload] = useState(false);
  const [adminUploadFile, setAdminUploadFile] = useState<File | null>(null);
  const [adminUploadName, setAdminUploadName] = useState('');
  const [adminUploadCategory, setAdminUploadCategory] = useState<string>('other');
  const [adminUploadFeedback, setAdminUploadFeedback] = useState('');
  const [adminUploading, setAdminUploading] = useState(false);
  const [adminUploadProgress, setAdminUploadProgress] = useState(0);
  const adminFileRef = useRef<HTMLInputElement | null>(null);

  // ── Review action state ──────────────────────────────────────────────────
  const [reviewModal, setReviewModal] = useState<{
    type: 'request_revision' | 'approve_final';
    docId: string;
    documentName: string;
    versionLabel: string;
    reviewStatus: ReviewStatus;
  } | null>(null);
  const [submittingReview, setSubmittingReview] = useState<string | null>(null); // docId being actioned
  const [reviewActionDocId, setReviewActionDocId] = useState<string | null>(null); // which doc's action spinner

  const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const isMockId = applicationId.startsWith('demo-') || applicationId.startsWith('app-') || applicationId.startsWith('mock-');

  useEffect(() => {
    if (isMockId) { setDocs(DEMO_DOCS); setLoading(false); return; }
    supabase.from('borrower_documents').select('*').eq('application_id', applicationId).order('created_at', { ascending: true })
      .then(({ data }) => { setDocs(data && data.length > 0 ? data as BorrowerDoc[] : []); setLoading(false); })
      .catch(() => { setDocs([]); setLoading(false); });

    const channel = supabase.channel(`admin-docs-v2-${applicationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'borrower_documents', filter: `application_id=eq.${applicationId}` }, (payload) => {
        if (payload.eventType === 'INSERT') setDocs((prev) => [...prev, payload.new as BorrowerDoc]);
        else if (payload.eventType === 'UPDATE') setDocs((prev) => prev.map((d) => d.id === (payload.new as BorrowerDoc).id ? (payload.new as BorrowerDoc) : d));
        else if (payload.eventType === 'DELETE') setDocs((prev) => prev.filter((d) => d.id !== (payload.old as BorrowerDoc).id));
      }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [applicationId, isMockId, supabase]);

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }

  function normalizeStoragePath(fileUrl: string): string {
    const publicMarker = '/object/public/borrower-documents/';
    const signedMarker = '/object/sign/borrower-documents/';
    if (fileUrl.includes(publicMarker)) return fileUrl.split(publicMarker)[1].split('?')[0];
    if (fileUrl.includes(signedMarker)) return fileUrl.split(signedMarker)[1].split('?')[0];
    return fileUrl;
  }

  async function getSignedUrl(fileUrl: string, expiresIn = 3600): Promise<string | null> {
    const storagePath = normalizeStoragePath(fileUrl);
    const { data, error } = await supabase.storage.from('borrower-documents').createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async function handleOpenFile(doc: BorrowerDoc) {
    if (!doc.file_url) return;
    setViewingId(doc.id);
    try { let url = await getSignedUrl(doc.file_url, 3600); window.open(url ?? doc.file_url, '_blank', 'noopener,noreferrer'); }
    catch { window.open(doc.file_url, '_blank', 'noopener,noreferrer'); } finally { setViewingId(null); }
  }

  async function handleDownloadFile(doc: BorrowerDoc) {
    if (!doc.file_url) return;
    setDownloadingId(doc.id);
    try {
      let url = await getSignedUrl(doc.file_url, 300);
      if (!url) return;
      const a = document.createElement('a'); a.href = url; a.download = doc.file_name || doc.document_name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } finally { setDownloadingId(null); }
  }

  async function handleAdminUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!adminUploadFile || !adminUploadName.trim()) return;
    if (!ACCEPTED_TYPES.includes(adminUploadFile.type) || adminUploadFile.size > MAX_FILE_SIZE) return;
    setAdminUploading(true); setAdminUploadProgress(0);
    try {
      const progressInterval = setInterval(() => {
        setAdminUploadProgress((prev) => { if (prev >= 80) { clearInterval(progressInterval); return prev; } return prev + 15; });
      }, 200);
      const fd = new FormData();
      fd.append('file', adminUploadFile);
      fd.append('applicationId', applicationId);
      fd.append('userId', userId);
      fd.append('documentName', adminUploadName.trim());
      fd.append('uploadedByRole', 'admin');
      if (adminUploadFeedback.trim()) fd.append('feedback', adminUploadFeedback.trim());
      const res = await fetch('/api/upload-document', { method: 'POST', body: fd });
      clearInterval(progressInterval);
      if (!res.ok) { const json = await res.json().catch(() => ({})); console.error('[AdminVersionedDocuments] Upload failed:', json.error); setAdminUploading(false); return; }
      setAdminUploadProgress(100);
      setShowAdminUpload(false); setAdminUploadFile(null); setAdminUploadName(''); setAdminUploadCategory('other'); setAdminUploadFeedback('');
    } catch (err) { console.error('[AdminVersionedDocuments] Upload error:', err); }
    finally { setAdminUploading(false); }
  }

  async function handleReviewAction(
    docId: string,
    tableTarget: 'borrower_documents',
    newStatus: ReviewStatus,
    reviewNotes?: string,
    clientRevisionMessage?: string
  ) {
    setSubmittingReview(docId);
    setReviewActionDocId(docId);
    try {
      const res = await fetch('/api/documents/revision', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: docId,
          tableTarget,
          newStatus,
          reviewNotes: reviewNotes ?? null,
          clientRevisionMessage: clientRevisionMessage ?? null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        console.error('[AdminVersionedDocuments] Review action failed:', json.error);
        return;
      }
      // Update local state with confirmed server response
      setDocs((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                review_status: newStatus,
                review_notes: reviewNotes !== undefined ? reviewNotes : d.review_notes,
              }
            : d
        )
      );
      // Re-fetch to get reviewed_by / reviewed_at from server
      const { data: updated } = await supabase
        .from('borrower_documents')
        .select('*')
        .eq('id', docId)
        .single();
      if (updated) {
        setDocs((prev) => prev.map((d) => (d.id === docId ? (updated as BorrowerDoc) : d)));
      }
    } catch (err) {
      console.error('[AdminVersionedDocuments] Review action error:', err);
    } finally {
      setSubmittingReview(null);
      setReviewActionDocId(null);
      setReviewModal(null);
    }
  }

  async function handleReopenReview(docId: string) {
    await handleReviewAction(docId, 'borrower_documents', 'under_review');
  }

  if (loading) return (
    <div className="flex items-center justify-center py-10">
      <Icon name="ArrowPathIcon" size={20} className="animate-spin text-gray-300" />
    </div>
  );

  const groups = groupBorrowerDocs(docs);

  if (groups.length === 0 && !showAdminUpload) return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon name="FolderOpenIcon" size={36} className="text-gray-200 mb-3" />
      <p className="text-sm text-gray-400">No documents uploaded yet</p>
      <p className="text-xs text-gray-300 mt-1">Documents will appear here once the borrower uploads them.</p>
      {!isMockId && (
        <button onClick={() => setShowAdminUpload(true)} className="mt-4 flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-600 rounded-lg hover:bg-eb-green-800 transition-all">
          <Icon name="ArrowUpTrayIcon" size={13} />Upload Document
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Request Revision Modal */}
      <RequestRevisionModal
        open={reviewModal?.type === 'request_revision'}
        documentName={reviewModal?.documentName ?? ''}
        versionLabel={reviewModal?.versionLabel ?? ''}
        submitting={submittingReview === reviewModal?.docId && reviewModal?.type === 'request_revision'}
        onClose={() => setReviewModal(null)}
        onSubmit={(clientMessage, internalNote) => {
          if (!reviewModal) return;
          handleReviewAction(reviewModal.docId, 'borrower_documents', 'revision_requested', internalNote || undefined, clientMessage);
        }}
      />

      {/* Approve Final Modal */}
      <ApproveFinalModal
        open={reviewModal?.type === 'approve_final'}
        documentName={reviewModal?.documentName ?? ''}
        versionLabel={reviewModal?.versionLabel ?? ''}
        isRevisionRequested={reviewModal?.reviewStatus === 'revision_requested'}
        submitting={submittingReview === reviewModal?.docId && reviewModal?.type === 'approve_final'}
        onClose={() => setReviewModal(null)}
        onConfirm={() => {
          if (!reviewModal) return;
          handleReviewAction(reviewModal.docId, 'borrower_documents', 'approved_final');
        }}
      />

      {/* Admin upload form */}
      {showAdminUpload && (
        <div className="bg-white rounded-xl border border-eb-green-900/20 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-eb-green-50/60">
            <div className="flex items-center gap-2"><Icon name="ArrowUpTrayIcon" size={14} className="text-eb-green-800" /><span className="text-xs font-display font-700 text-eb-green-900">Upload Document for Borrower</span></div>
            <button onClick={() => { setShowAdminUpload(false); setAdminUploadFile(null); setAdminUploadName(''); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"><Icon name="XMarkIcon" size={14} /></button>
          </div>
          <form onSubmit={handleAdminUpload} className="p-4 space-y-3">
            <div className={`border-2 border-dashed rounded-xl cursor-pointer transition-all ${adminUploadFile ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-gray-300 bg-gray-50'}`} onClick={() => adminFileRef.current?.click()}>
              <input ref={adminFileRef} type="file" accept={ACCEPTED_TYPES.join(',')} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setAdminUploadFile(f); if (!adminUploadName) setAdminUploadName(f.name.replace(/\.[^.]+$/, '')); } e.target.value = ''; }} />
              {adminUploadFile ? (
                <div className="flex items-center gap-3 px-4 py-3">
                  <Icon name="DocumentCheckIcon" size={16} className="text-emerald-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0"><p className="text-xs font-display font-600 text-gray-900 truncate">{adminUploadFile.name}</p><p className="text-[11px] text-gray-400">{(adminUploadFile.size / (1024 * 1024)).toFixed(1)} MB</p></div>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setAdminUploadFile(null); }} className="w-6 h-6 flex items-center justify-center rounded hover:bg-emerald-100 text-emerald-600 transition-colors"><Icon name="XMarkIcon" size={12} /></button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-5 gap-1.5">
                  <Icon name="ArrowUpTrayIcon" size={20} className="text-gray-400" />
                  <p className="text-sm text-gray-500 font-600">Browse or drag & drop</p>
                  <p className="text-[11px] text-gray-400">PDF, JPG, PNG, DOCX · Max 50MB</p>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[11px] font-display font-600 text-gray-600 mb-1">Document Name *</label><input type="text" value={adminUploadName} onChange={(e) => setAdminUploadName(e.target.value)} placeholder="e.g. Bank Statement" className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all" required /></div>
              <div><label className="block text-[11px] font-display font-600 text-gray-600 mb-1">Category</label><select value={adminUploadCategory} onChange={(e) => setAdminUploadCategory(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 bg-white transition-all"><option value="identity">Identity</option><option value="financial">Financial</option><option value="property">Property</option><option value="legal">Legal</option><option value="other">Other</option></select></div>
            </div>
            <div>
              <label className="block text-[11px] font-display font-600 text-gray-600 mb-1">Feedback / Instructions <span className="text-gray-400 font-400">(optional)</span></label>
              <textarea value={adminUploadFeedback} onChange={(e) => setAdminUploadFeedback(e.target.value)} placeholder="Add a note for the borrower…" rows={2} className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 resize-none transition-all" />
            </div>
            {adminUploading && (<div><div className="flex justify-between text-[11px] text-gray-500 mb-1"><span>Uploading…</span><span>{adminUploadProgress}%</span></div><div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-eb-green-900 rounded-full transition-all" style={{ width: `${adminUploadProgress}%` }} /></div></div>)}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => { setShowAdminUpload(false); setAdminUploadFile(null); setAdminUploadName(''); setAdminUploadFeedback(''); }} className="px-3 py-1.5 text-xs font-display font-600 text-gray-500 bg-gray-100 hover:bg-gray-200 transition-all rounded-lg">Cancel</button>
              <button type="submit" disabled={adminUploading || !adminUploadFile || !adminUploadName.trim()} className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-display font-600 text-white bg-eb-green-900 rounded-lg hover:bg-eb-green-800 transition-all disabled:opacity-50">
                {adminUploading ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="ArrowUpTrayIcon" size={12} />}
                {adminUploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Sub-header: upload button */}
      <div className="flex items-center justify-end">
        {!isMockId && (
          <button onClick={() => setShowAdminUpload((v) => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 rounded-lg hover:bg-eb-green-100 transition-all">
            <Icon name="ArrowUpTrayIcon" size={12} />Upload
          </button>
        )}
      </div>

      {/* Document groups */}
      <div className="space-y-3">
        {groups.map(({ groupId, currentDoc, allVersions }) => {
          const isExpanded = expandedGroups.has(groupId);
          const versionCount = allVersions.length;
          const reviewStatus = (currentDoc.review_status ?? 'uploaded') as ReviewStatus;
          const reviewCfg = REVIEW_STATUS_CONFIG[reviewStatus] ?? REVIEW_STATUS_CONFIG.uploaded;
          const isApprovedFinal = reviewStatus === 'approved_final';
          const isRevisionRequested = reviewStatus === 'revision_requested';
          const currentVersion = currentDoc.version_number ?? 1;
          const versionLabel = `Version ${currentVersion}`;
          const isActionSubmitting = reviewActionDocId === currentDoc.id ? submittingReview : null;

          return (
            <div
              key={groupId}
              className={`rounded-xl border overflow-hidden transition-all duration-200 ${
                isApprovedFinal ? 'border-emerald-200 bg-emerald-50/30' : isRevisionRequested ?'border-orange-200 bg-orange-50/30' :
                reviewStatus === 'under_review'? 'border-amber-200 bg-amber-50/30' : 'border-gray-100 bg-white'
              }`}
            >
              {/* Current version row */}
              <div className="p-4">
                <div className="flex items-start gap-3">
                  {/* Icon */}
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 border-2 ${
                    isApprovedFinal ? 'border-emerald-300 bg-emerald-50' : isRevisionRequested ?'border-orange-300 bg-orange-50' :
                    reviewStatus === 'under_review'? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'
                  }`}>
                    <Icon name={(DOC_CATEGORY_ICONS[currentDoc.category] || 'FolderIcon') as Parameters<typeof Icon>[0]['name']} size={16} className={
                      isApprovedFinal ? 'text-emerald-600': isRevisionRequested ?'text-orange-600' :
                      reviewStatus === 'under_review'? 'text-amber-600' : 'text-gray-500'
                    } />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        {/* Document name */}
                        <p className="text-sm font-display font-600 text-gray-800">{currentDoc.document_name}</p>
                        <p className="text-[11px] text-gray-400 mt-0.5 capitalize">{currentDoc.document_type.replace(/_/g, ' ')}</p>

                        {/* Version + Current badge */}
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className="inline-flex items-center gap-1 text-[11px] font-display font-700 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 px-2 py-0.5 rounded-full">
                            <Icon name="DocumentTextIcon" size={9} />
                            {versionLabel}
                          </span>
                          <span className="inline-flex items-center gap-1 text-[10px] font-600 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 px-1.5 py-0.5 rounded-full">
                            <Icon name="CheckCircleIcon" size={9} />
                            Current
                          </span>
                        </div>

                        {/* Upload metadata */}
                        <div className="flex flex-wrap items-center gap-2 mt-1.5">
                          {currentDoc.file_name && (
                            <div className="flex items-center gap-1">
                              <Icon name="PaperClipIcon" size={10} className="text-gray-400 flex-shrink-0" />
                              <span className="text-[11px] text-gray-500 truncate max-w-[180px]">{currentDoc.file_name}</span>
                            </div>
                          )}
                          {currentDoc.file_size && (
                            <span className="text-[11px] text-gray-400">
                              {currentDoc.file_size < 1024 * 1024 ? `${(currentDoc.file_size / 1024).toFixed(0)} KB` : `${(currentDoc.file_size / (1024 * 1024)).toFixed(1)} MB`}
                            </span>
                          )}
                          {currentDoc.uploaded_at && (
                            <span className="text-[11px] text-gray-400">
                              {new Date(currentDoc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Review status badge */}
                      <span className={`text-[11px] font-display font-700 px-2.5 py-1 rounded-full border flex-shrink-0 ${reviewCfg.color} ${reviewCfg.bg} ${reviewCfg.border}`}>
                        {reviewCfg.label}
                      </span>
                    </div>

                    {/* Admin review notes (Admin-only) */}
                    {currentDoc.review_notes && (
                      <div className="mt-2.5 flex items-start gap-2 text-xs rounded-lg px-3 py-2 border bg-violet-50 border-violet-100 text-violet-800">
                        <Icon name="LockClosedIcon" size={11} className="flex-shrink-0 mt-0.5 opacity-70" />
                        <div>
                          <span className="font-700 text-[10px] uppercase tracking-wide block mb-0.5">Internal Review Note</span>
                          <span className="leading-relaxed">{currentDoc.review_notes}</span>
                          {currentDoc.reviewed_by && (
                            <span className="block text-[10px] text-violet-600 mt-0.5">— {currentDoc.reviewed_by}{currentDoc.reviewed_at ? `, ${new Date(currentDoc.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Legacy admin notes / resubmit reason */}
                    {!currentDoc.review_notes && (currentDoc.admin_notes || currentDoc.resubmit_reason) && (
                      <div className={`mt-2.5 flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${
                        currentDoc.doc_status === 'rejected' ? 'bg-red-50 border-red-100 text-red-700' :
                        currentDoc.doc_status === 'resubmit_requested' ? 'bg-orange-50 border-orange-100 text-orange-700' :
                        currentDoc.doc_status === 'approved' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-white border-gray-100 text-gray-600'
                      }`}>
                        <Icon name="ChatBubbleLeftEllipsisIcon" size={12} className="flex-shrink-0 mt-0.5 opacity-70" />
                        <span className="leading-relaxed">{currentDoc.admin_notes || currentDoc.resubmit_reason}</span>
                      </div>
                    )}

                    {/* Actions row: View/Download + Review Actions */}
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      {currentDoc.file_url && (
                        <>
                          <button onClick={() => handleOpenFile(currentDoc)} disabled={viewingId === currentDoc.id} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all">
                            {viewingId === currentDoc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowTopRightOnSquareIcon" size={11} />}View
                          </button>
                          <button onClick={() => handleDownloadFile(currentDoc)} disabled={downloadingId === currentDoc.id} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 disabled:opacity-50 rounded-lg transition-all">
                            {downloadingId === currentDoc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowDownTrayIcon" size={11} />}Download
                          </button>
                        </>
                      )}
                      {!currentDoc.file_url && (
                        <span className="text-[11px] text-gray-400 italic">No file uploaded yet</span>
                      )}
                    </div>

                    {/* Review Actions — current version only, only if file exists */}
                    {!isMockId && currentDoc.file_url && reviewStatus !== 'superseded' && (
                      <div className="mt-2.5 pt-2.5 border-t border-gray-100">
                        <ReviewActionButtons
                          reviewStatus={reviewStatus}
                          hasFile={!!currentDoc.file_url}
                          submittingAction={isActionSubmitting ? reviewStatus : null}
                          onMarkUnderReview={() => handleReviewAction(currentDoc.id, 'borrower_documents', 'under_review')}
                          onRequestRevision={() =>
                            setReviewModal({
                              type: 'request_revision',
                              docId: currentDoc.id,
                              documentName: currentDoc.document_name,
                              versionLabel,
                              reviewStatus,
                            })
                          }
                          onApproveFinal={() =>
                            setReviewModal({
                              type: 'approve_final',
                              docId: currentDoc.id,
                              documentName: currentDoc.document_name,
                              versionLabel,
                              reviewStatus,
                            })
                          }
                          onReopenReview={() => handleReopenReview(currentDoc.id)}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Version history accordion */}
              {versionCount > 1 && (
                <div className="border-t border-gray-100">
                  <button
                    onClick={() => toggleGroup(groupId)}
                    className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-display font-600 text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon name="ClockIcon" size={12} className="text-gray-400" />
                      <span>Version History ({versionCount})</span>
                    </div>
                    <Icon name={isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={13} className="text-gray-400" />
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-100 bg-gray-50/60 divide-y divide-gray-100">
                      {allVersions.map((ver, idx) => {
                        const isCurrent = ver.is_current_version === true || (ver.id === currentDoc.id);
                        const verReviewStatus = (ver.review_status ?? 'uploaded') as ReviewStatus;
                        const verReviewCfg = REVIEW_STATUS_CONFIG[verReviewStatus] ?? REVIEW_STATUS_CONFIG.uploaded;
                        return (
                          <div key={ver.id} className={`px-4 py-3 ${isCurrent ? 'bg-eb-green-50/40' : ''}`}>
                            <div className="flex items-start gap-3">
                              <div className="flex-shrink-0 flex flex-col items-center gap-1 pt-0.5">
                                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-display font-700 ${isCurrent ? 'bg-eb-green-900 text-white' : 'bg-gray-200 text-gray-500'}`}>
                                  {ver.version_number ?? (allVersions.length - idx)}
                                </div>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-xs font-display font-600 text-gray-700">
                                    Version {ver.version_number ?? (allVersions.length - idx)}
                                  </span>
                                  {isCurrent && (
                                    <span className="text-[10px] font-600 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 px-1.5 py-0.5 rounded-full">Current</span>
                                  )}
                                  <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full border ${verReviewCfg.color} ${verReviewCfg.bg} ${verReviewCfg.border}`}>
                                    {verReviewCfg.label}
                                  </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 mt-1">
                                  {ver.uploaded_at && (
                                    <span className="text-[11px] text-gray-400">
                                      {new Date(ver.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                    </span>
                                  )}
                                  {ver.file_name && (
                                    <span className="text-[11px] text-gray-400 truncate max-w-[160px]">{ver.file_name}</span>
                                  )}
                                  {ver.file_size && (
                                    <span className="text-[11px] text-gray-400">
                                      {ver.file_size < 1024 * 1024 ? `${(ver.file_size / 1024).toFixed(0)} KB` : `${(ver.file_size / (1024 * 1024)).toFixed(1)} MB`}
                                    </span>
                                  )}
                                </div>
                                {/* Review notes for historical versions */}
                                {ver.review_notes && (
                                  <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-violet-700 bg-violet-50 border border-violet-100 rounded-lg px-2.5 py-1.5">
                                    <Icon name="LockClosedIcon" size={10} className="flex-shrink-0 mt-0.5" />
                                    <span>{ver.review_notes}</span>
                                  </div>
                                )}
                                {/* Actions for historical versions — no review actions, view/download only */}
                                {ver.file_url && (
                                  <div className="flex items-center gap-2 mt-2">
                                    <button onClick={() => handleOpenFile(ver)} disabled={viewingId === ver.id} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-display font-600 text-gray-500 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all">
                                      {viewingId === ver.id ? <Icon name="ArrowPathIcon" size={10} className="animate-spin" /> : <Icon name="ArrowTopRightOnSquareIcon" size={10} />}View
                                    </button>
                                    <button onClick={() => handleDownloadFile(ver)} disabled={downloadingId === ver.id} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-display font-600 text-gray-500 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all">
                                      {downloadingId === ver.id ? <Icon name="ArrowPathIcon" size={10} className="animate-spin" /> : <Icon name="ArrowDownTrayIcon" size={10} />}Download
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── NEW: AdminVersionedAppDocuments — groups application_documents by thread_id ──
interface AdminVersionedAppDocumentsProps {
  applicationId: string;
  userId: string;
}

function AdminVersionedAppDocuments({ applicationId, userId }: AdminVersionedAppDocumentsProps) {
  const supabase = useMemo(() => createClient(), []);
  const [docs, setDocs] = useState<AppDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // ── Review action state ──────────────────────────────────────────────────
  const [reviewModal, setReviewModal] = useState<{
    type: 'request_revision' | 'approve_final';
    docId: string;
    documentName: string;
    versionLabel: string;
    reviewStatus: ReviewStatus;
  } | null>(null);
  const [submittingReview, setSubmittingReview] = useState<string | null>(null);
  const [reviewActionDocId, setReviewActionDocId] = useState<string | null>(null);

  const isMockId = applicationId.startsWith('demo-') || applicationId.startsWith('app-') || applicationId.startsWith('mock-');

  useEffect(() => {
    if (isMockId) { setLoading(false); return; }
    supabase.from('application_documents').select('*').eq('application_id', applicationId).order('created_at', { ascending: true })
      .then(({ data }) => { setDocs(data && data.length > 0 ? data as AppDoc[] : []); setLoading(false); })
      .catch(() => { setDocs([]); setLoading(false); });

    const channel = supabase.channel(`admin-appdocs-v2-${applicationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'application_documents', filter: `application_id=eq.${applicationId}` }, (payload) => {
        if (payload.eventType === 'INSERT') setDocs((prev) => [...prev, payload.new as AppDoc]);
        else if (payload.eventType === 'UPDATE') setDocs((prev) => prev.map((d) => d.id === (payload.new as AppDoc).id ? (payload.new as AppDoc) : d));
        else if (payload.eventType === 'DELETE') setDocs((prev) => prev.filter((d) => d.id !== (payload.old as AppDoc).id));
      }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [applicationId, isMockId, supabase]);

  function toggleThread(threadId: string) {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId); else next.add(threadId);
      return next;
    });
  }

  async function getSignedUrl(storagePath: string, expiresIn = 3600): Promise<string | null> {
    const { data, error } = await supabase.storage.from('application-documents').createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async function handleOpenFile(doc: AppDoc) {
    if (!doc.file_url && !doc.storage_path) return;
    setViewingId(doc.id);
    try {
      let url = doc.file_url;
      if (doc.storage_path) {
        const signed = await getSignedUrl(doc.storage_path, 3600);
        if (signed) url = signed;
      }
      window.open(url ?? '', '_blank', 'noopener,noreferrer');
    } finally { setViewingId(null); }
  }

  async function handleDownloadFile(doc: AppDoc) {
    if (!doc.file_url && !doc.storage_path) return;
    setDownloadingId(doc.id);
    try {
      let url = doc.file_url;
      if (doc.storage_path) {
        const signed = await getSignedUrl(doc.storage_path, 300);
        if (signed) url = signed;
      }
      if (!url) return;
      const a = document.createElement('a'); a.href = url; a.download = doc.file_name || doc.document_name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } finally { setDownloadingId(null); }
  }

  async function handleReviewAction(
    docId: string,
    tableTarget: 'application_documents',
    newStatus: ReviewStatus,
    reviewNotes?: string,
    clientRevisionMessage?: string
  ) {
    setSubmittingReview(docId);
    setReviewActionDocId(docId);
    try {
      const res = await fetch('/api/documents/revision', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: docId,
          tableTarget,
          newStatus,
          reviewNotes: reviewNotes ?? null,
          clientRevisionMessage: clientRevisionMessage ?? null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        console.error('[AdminVersionedAppDocuments] Review action failed:', json.error);
        return;
      }
      // Update local state immediately
      setDocs((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                review_status: newStatus,
                review_notes: reviewNotes !== undefined ? reviewNotes : d.review_notes,
              }
            : d
        )
      );
      // Re-fetch to get reviewed_by / reviewed_at
      const { data: updated } = await supabase
        .from('application_documents')
        .select('*')
        .eq('id', docId)
        .single();
      if (updated) {
        setDocs((prev) => prev.map((d) => (d.id === docId ? (updated as AppDoc) : d)));
      }
    } catch (err) {
      console.error('[AdminVersionedAppDocuments] Review action error:', err);
    } finally {
      setSubmittingReview(null);
      setReviewActionDocId(null);
      setReviewModal(null);
    }
  }

  async function handleReopenReview(docId: string) {
    await handleReviewAction(docId, 'application_documents', 'under_review');
  }

  if (loading) return (
    <div className="flex items-center justify-center py-8">
      <Icon name="ArrowPathIcon" size={18} className="animate-spin text-gray-300" />
    </div>
  );

  const threads = groupAppDocs(docs);

  if (threads.length === 0) return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon name="FolderOpenIcon" size={28} className="text-gray-200 mb-2" />
      <p className="text-sm text-gray-400">No documents uploaded yet</p>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Request Revision Modal */}
      <RequestRevisionModal
        open={reviewModal?.type === 'request_revision'}
        documentName={reviewModal?.documentName ?? ''}
        versionLabel={reviewModal?.versionLabel ?? ''}
        submitting={submittingReview === reviewModal?.docId && reviewModal?.type === 'request_revision'}
        onClose={() => setReviewModal(null)}
        onSubmit={(clientMessage, internalNote) => {
          if (!reviewModal) return;
          handleReviewAction(reviewModal.docId, 'application_documents', 'revision_requested', internalNote || undefined, clientMessage);
        }}
      />

      {/* Approve Final Modal */}
      <ApproveFinalModal
        open={reviewModal?.type === 'approve_final'}
        documentName={reviewModal?.documentName ?? ''}
        versionLabel={reviewModal?.versionLabel ?? ''}
        isRevisionRequested={reviewModal?.reviewStatus === 'revision_requested'}
        submitting={submittingReview === reviewModal?.docId && reviewModal?.type === 'approve_final'}
        onClose={() => setReviewModal(null)}
        onConfirm={() => {
          if (!reviewModal) return;
          handleReviewAction(reviewModal.docId, 'application_documents', 'approved_final');
        }}
      />

      {threads.map(({ threadId, currentDoc, allVersions }) => {
        const isExpanded = expandedThreads.has(threadId);
        const versionCount = allVersions.length;
        const reviewStatus = (currentDoc.review_status ?? 'uploaded') as ReviewStatus;
        const reviewCfg = REVIEW_STATUS_CONFIG[reviewStatus] ?? REVIEW_STATUS_CONFIG.uploaded;
        const isApprovedFinal = reviewStatus === 'approved_final';
        const isRevisionRequested = reviewStatus === 'revision_requested';
        const currentRevision = currentDoc.revision_number ?? 1;
        const isAdminDoc = currentDoc.is_admin_response === true || currentDoc.uploaded_by_role === 'admin';
        const versionLabel = `Version ${currentRevision}`;
        const isActionSubmitting = reviewActionDocId === currentDoc.id ? submittingReview : null;

        return (
          <div
            key={threadId}
            className={`rounded-xl border overflow-hidden transition-all duration-200 ${
              isApprovedFinal ? 'border-emerald-200 bg-emerald-50/30' : isRevisionRequested ?'border-orange-200 bg-orange-50/30' :
              reviewStatus === 'under_review'? 'border-amber-200 bg-amber-50/30' : 'border-gray-100 bg-white'
            }`}
          >
            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 border-2 ${
                  isAdminDoc ? 'border-eb-green-200 bg-eb-green-50' : isApprovedFinal ?'border-emerald-300 bg-emerald-50': isRevisionRequested ?'border-orange-300 bg-orange-50': 'border-gray-200 bg-gray-50'
                }`}>
                  <Icon name={isAdminDoc ? 'BuildingOffice2Icon' : 'DocumentTextIcon'} size={16} className={
                    isAdminDoc ? 'text-eb-green-700': isApprovedFinal ?'text-emerald-600': isRevisionRequested ?'text-orange-600': 'text-gray-500'
                  } />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-display font-600 text-gray-800">{currentDoc.document_name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] text-gray-400 capitalize">{isAdminDoc ? 'Admin upload' : 'Borrower upload'}</span>
                      </div>

                      {/* Version + Current badge */}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 text-[11px] font-display font-700 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 px-2 py-0.5 rounded-full">
                          <Icon name="DocumentTextIcon" size={9} />
                          {versionLabel}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] font-600 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 px-1.5 py-0.5 rounded-full">
                          <Icon name="CheckCircleIcon" size={9} />
                          Current
                        </span>
                      </div>

                      {/* Upload metadata */}
                      <div className="flex flex-wrap items-center gap-2 mt-1.5">
                        {currentDoc.file_name && (
                          <div className="flex items-center gap-1">
                            <Icon name="PaperClipIcon" size={10} className="text-gray-400 flex-shrink-0" />
                            <span className="text-[11px] text-gray-500 truncate max-w-[180px]">{currentDoc.file_name}</span>
                          </div>
                        )}
                        {currentDoc.file_size && (
                          <span className="text-[11px] text-gray-400">
                            {currentDoc.file_size < 1024 * 1024 ? `${(currentDoc.file_size / 1024).toFixed(0)} KB` : `${(currentDoc.file_size / (1024 * 1024)).toFixed(1)} MB`}
                          </span>
                        )}
                        {currentDoc.created_at && (
                          <span className="text-[11px] text-gray-400">
                            {new Date(currentDoc.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        )}
                        {currentDoc.uploader_email && (
                          <span className="text-[11px] text-gray-400 truncate max-w-[140px]">{currentDoc.uploader_email}</span>
                        )}
                      </div>

                      {/* Feedback / description */}
                      {(currentDoc.feedback || currentDoc.description) && (
                        <div className="mt-2 flex items-start gap-1.5 text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1.5">
                          <Icon name="ChatBubbleLeftEllipsisIcon" size={11} className="flex-shrink-0 mt-0.5 text-gray-400" />
                          <span className="leading-relaxed">{currentDoc.feedback || currentDoc.description}</span>
                        </div>
                      )}

                      {/* Admin review notes */}
                      {currentDoc.review_notes && (
                        <div className="mt-2 flex items-start gap-1.5 text-xs text-violet-700 bg-violet-50 border border-violet-100 rounded-lg px-2.5 py-1.5">
                          <Icon name="LockClosedIcon" size={11} className="flex-shrink-0 mt-0.5" />
                          <div>
                            <span className="font-700 text-[10px] uppercase tracking-wide block mb-0.5">Internal Review Note</span>
                            <span className="leading-relaxed">{currentDoc.review_notes}</span>
                            {currentDoc.reviewed_by && (
                              <span className="block text-[10px] text-violet-600 mt-0.5">— {currentDoc.reviewed_by}{currentDoc.reviewed_at ? `, ${new Date(currentDoc.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Review status badge */}
                    <span className={`text-[11px] font-display font-700 px-2.5 py-1 rounded-full border flex-shrink-0 ${reviewCfg.color} ${reviewCfg.bg} ${reviewCfg.border}`}>
                      {reviewCfg.label}
                    </span>
                  </div>

                  {/* Actions row: View/Download */}
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {(currentDoc.file_url || currentDoc.storage_path) ? (
                      <>
                        <button onClick={() => handleOpenFile(currentDoc)} disabled={viewingId === currentDoc.id} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all">
                          {viewingId === currentDoc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowTopRightOnSquareIcon" size={11} />}View
                        </button>
                        <button onClick={() => handleDownloadFile(currentDoc)} disabled={downloadingId === currentDoc.id} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 disabled:opacity-50 rounded-lg transition-all">
                          {downloadingId === currentDoc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowDownTrayIcon" size={11} />}Download
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] text-gray-400 italic">No file available</span>
                    )}
                  </div>

                  {/* Review Actions — current version only */}
                  {!isMockId && (currentDoc.file_url || currentDoc.storage_path) && reviewStatus !== 'superseded' && (
                    <div className="mt-2.5 pt-2.5 border-t border-gray-100">
                      <ReviewActionButtons
                        reviewStatus={reviewStatus}
                        hasFile={!!(currentDoc.file_url || currentDoc.storage_path)}
                        submittingAction={isActionSubmitting ? reviewStatus : null}
                        onMarkUnderReview={() => handleReviewAction(currentDoc.id, 'application_documents', 'under_review')}
                        onRequestRevision={() =>
                          setReviewModal({
                            type: 'request_revision',
                            docId: currentDoc.id,
                            documentName: currentDoc.document_name,
                            versionLabel,
                            reviewStatus,
                          })
                        }
                        onApproveFinal={() =>
                          setReviewModal({
                            type: 'approve_final',
                            docId: currentDoc.id,
                            documentName: currentDoc.document_name,
                            versionLabel,
                            reviewStatus,
                          })
                        }
                        onReopenReview={() => handleReopenReview(currentDoc.id)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Version history accordion */}
            {versionCount > 1 && (
              <div className="border-t border-gray-100">
                <button
                  onClick={() => toggleThread(threadId)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-display font-600 text-gray-500 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <Icon name="ClockIcon" size={12} className="text-gray-400" />
                    <span>Version History ({versionCount})</span>
                  </div>
                  <Icon name={isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={13} className="text-gray-400" />
                </button>

                {isExpanded && (
                  <div className="border-t border-gray-100 bg-gray-50/60 divide-y divide-gray-100">
                    {allVersions.map((ver, idx) => {
                      const isCurrent = ver.is_current_version === true || (ver.id === currentDoc.id);
                      const verReviewStatus = (ver.review_status ?? 'uploaded') as ReviewStatus;
                      const verReviewCfg = REVIEW_STATUS_CONFIG[verReviewStatus] ?? REVIEW_STATUS_CONFIG.uploaded;
                      return (
                        <div key={ver.id} className={`px-4 py-3 ${isCurrent ? 'bg-eb-green-50/40' : ''}`}>
                          <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 pt-0.5">
                              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-display font-700 ${isCurrent ? 'bg-eb-green-900 text-white' : 'bg-gray-200 text-gray-500'}`}>
                                {ver.revision_number ?? (allVersions.length - idx)}
                              </div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-display font-600 text-gray-700">
                                  Version {ver.revision_number ?? (allVersions.length - idx)}
                                </span>
                                {isCurrent && (
                                  <span className="text-[10px] font-600 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 px-1.5 py-0.5 rounded-full">Current</span>
                                )}
                                <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full border ${verReviewCfg.color} ${verReviewCfg.bg} ${verReviewCfg.border}`}>
                                  {verReviewCfg.label}
                                </span>
                                <span className="text-[10px] text-gray-400 capitalize">{ver.uploaded_by_role}</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 mt-1">
                                {ver.created_at && (
                                  <span className="text-[11px] text-gray-400">
                                    {new Date(ver.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                  </span>
                                )}
                                {ver.file_name && (
                                  <span className="text-[11px] text-gray-400 truncate max-w-[160px]">{ver.file_name}</span>
                                )}
                              </div>
                              {ver.review_notes && (
                                <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-violet-700 bg-violet-50 border border-violet-100 rounded-lg px-2.5 py-1.5">
                                  <Icon name="LockClosedIcon" size={10} className="flex-shrink-0 mt-0.5" />
                                  <span>{ver.review_notes}</span>
                                </div>
                              )}
                              {(ver.file_url || ver.storage_path) && (
                                <div className="flex items-center gap-2 mt-2">
                                  <button onClick={() => handleOpenFile(ver)} disabled={viewingId === ver.id} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-display font-600 text-gray-500 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all">
                                    {viewingId === ver.id ? <Icon name="ArrowPathIcon" size={10} className="animate-spin" /> : <Icon name="ArrowTopRightOnSquareIcon" size={10} />}View
                                  </button>
                                  <button onClick={() => handleDownloadFile(ver)} disabled={downloadingId === ver.id} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-display font-600 text-gray-500 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all">
                                    {downloadingId === ver.id ? <Icon name="ArrowPathIcon" size={10} className="animate-spin" /> : <Icon name="ArrowDownTrayIcon" size={10} />}Download
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Keep original AdminDocuments for backward compatibility (used in compliance tab) ──
function AdminDocuments({ applicationId, userId, borrowerEmail, borrowerFirstName, borrowerLastName, propertyAddress }: AdminDocumentsProps) {
  const supabase = useMemo(() => createClient(), []);
  const [docs, setDocs] = useState<BorrowerDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<'approve' | 'reject' | 'flag' | null>(null);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<BorrowerDoc | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showAdminUpload, setShowAdminUpload] = useState(false);
  const [adminUploadFile, setAdminUploadFile] = useState<File | null>(null);
  const [adminUploadName, setAdminUploadName] = useState('');
  const [adminUploadCategory, setAdminUploadCategory] = useState<string>('other');
  const [adminUploadFeedback, setAdminUploadFeedback] = useState('');
  const [adminUploading, setAdminUploading] = useState(false);
  const [adminUploadProgress, setAdminUploadProgress] = useState(0);
  const [replacementPromptDocId, setReplacementPromptDocId] = useState<string | null>(null);
  const [replacementPromptDocName, setReplacementPromptDocName] = useState<string>('');
  const adminFileRef = useRef<HTMLInputElement | null>(null);

  const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const isMockId = applicationId.startsWith('demo-') || applicationId.startsWith('app-') || applicationId.startsWith('mock-');

  useEffect(() => {
    if (isMockId) { setDocs(DEMO_DOCS); setLoading(false); return; }
    supabase.from('borrower_documents').select('*').eq('application_id', applicationId).order('created_at', { ascending: true })
      .then(({ data }) => { setDocs(data && data.length > 0 ? data as BorrowerDoc[] : []); setLoading(false); })
      .catch(() => { setDocs([]); setLoading(false); });

    const channel = supabase.channel(`admin-docs-${applicationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'borrower_documents', filter: `application_id=eq.${applicationId}` }, (payload) => {
        if (payload.eventType === 'INSERT') setDocs((prev) => [...prev, payload.new as BorrowerDoc]);
        else if (payload.eventType === 'UPDATE') setDocs((prev) => prev.map((d) => d.id === (payload.new as BorrowerDoc).id ? (payload.new as BorrowerDoc) : d));
        else if (payload.eventType === 'DELETE') setDocs((prev) => prev.filter((d) => d.id !== (payload.old as BorrowerDoc).id));
      }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [applicationId, isMockId, supabase]);

  function openReview(docId: string, action: 'approve' | 'reject' | 'flag') { setReviewingId(docId); setReviewAction(action); setFeedbackNote(''); setReplacementPromptDocId(null); }
  function cancelReview() { setReviewingId(null); setReviewAction(null); setFeedbackNote(''); }

  async function submitReview(docId: string) {
    if (!reviewAction) return;
    setUpdatingId(docId);
    let newStatus: DocApprovalStatus;
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (reviewAction === 'approve') { newStatus = 'approved'; updates.doc_status = newStatus; if (feedbackNote.trim()) updates.admin_notes = feedbackNote.trim(); }
    else if (reviewAction === 'reject') { newStatus = 'rejected'; updates.doc_status = newStatus; updates.admin_notes = feedbackNote.trim() || 'Document rejected by admin.'; }
    else { newStatus = 'resubmit_requested'; updates.doc_status = newStatus; updates.resubmit_reason = feedbackNote.trim() || 'Please resubmit this document.'; updates.resubmit_requested_at = new Date().toISOString(); }

    const reviewedDoc = docs.find((d) => d.id === docId);
    setDocs((prev) => prev.map((d) => d.id === docId ? { ...d, doc_status: newStatus, admin_notes: (updates.admin_notes as string) ?? d.admin_notes, resubmit_reason: (updates.resubmit_reason as string) ?? d.resubmit_reason } : d));
    if (!isMockId) await supabase.from('borrower_documents').update(updates).eq('id', docId).catch(() => {});

    if (borrowerEmail && reviewedDoc) {
      const actionMap: Record<string, string> = { approve: 'approved', reject: 'rejected', flag: 'resubmit_requested' };
      const feedbackText = reviewAction === 'approve' ? (feedbackNote.trim() || '') : (feedbackNote.trim() || (reviewAction === 'reject' ? 'Document rejected by admin.' : 'Please resubmit this document.'));
      fetch('/api/send-document-review-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: actionMap[reviewAction], borrowerEmail, borrowerFirstName, borrowerLastName, documentName: reviewedDoc.document_name, feedbackNote: feedbackText, propertyAddress: propertyAddress || '' }) }).catch(() => {});
    }

    // After flag or reject, show replacement upload prompt
    if ((reviewAction === 'reject' || reviewAction === 'flag') && reviewedDoc) {
      setReplacementPromptDocId(docId);
      setReplacementPromptDocName(reviewedDoc.document_name);
    }

    setUpdatingId(null);
    cancelReview();
  }

  function normalizeStoragePath(fileUrl: string): string {
    const publicMarker = '/object/public/borrower-documents/';
    const signedMarker = '/object/sign/borrower-documents/';
    if (fileUrl.includes(publicMarker)) return fileUrl.split(publicMarker)[1].split('?')[0];
    if (fileUrl.includes(signedMarker)) return fileUrl.split(signedMarker)[1].split('?')[0];
    return fileUrl;
  }

  async function getSignedUrl(fileUrl: string, expiresIn = 3600): Promise<string | null> {
    const storagePath = normalizeStoragePath(fileUrl);
    const { data, error } = await supabase.storage.from('borrower-documents').createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async function handlePreviewFile(doc: BorrowerDoc) {
    if (!doc.file_url) return;
    setPreviewDoc(doc); setPreviewLoading(true); setPreviewUrl(null);
    try { let url = await getSignedUrl(doc.file_url, 3600); setPreviewUrl(url ?? doc.file_url); }
    catch { setPreviewUrl(doc.file_url); } finally { setPreviewLoading(false); }
  }

  async function handleOpenFile(doc: BorrowerDoc) {
    if (!doc.file_url) return;
    setViewingId(doc.id);
    try { let url = await getSignedUrl(doc.file_url, 3600); window.open(url ?? doc.file_url, '_blank', 'noopener,noreferrer'); }
    catch { window.open(doc.file_url, '_blank', 'noopener,noreferrer'); } finally { setViewingId(null); }
  }

  async function handleDownloadFile(doc: BorrowerDoc) {
    if (!doc.file_url) return;
    setDownloadingId(doc.id);
    try {
      let url = await getSignedUrl(doc.file_url, 300);
      if (!url) return;
      const a = document.createElement('a'); a.href = url; a.download = doc.file_name || doc.document_name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } finally { setDownloadingId(null); }
  }

  async function handleAdminUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!adminUploadFile || !adminUploadName.trim()) return;
    if (!ACCEPTED_TYPES.includes(adminUploadFile.type) || adminUploadFile.size > MAX_FILE_SIZE) return;
    setAdminUploading(true); setAdminUploadProgress(0);

    try {
      const progressInterval = setInterval(() => {
        setAdminUploadProgress((prev) => {
          if (prev >= 80) { clearInterval(progressInterval); return prev; }
          return prev + 15;
        });
      }, 200);

      const fd = new FormData();
      fd.append('file', adminUploadFile);
      fd.append('applicationId', applicationId);
      fd.append('userId', userId);
      fd.append('documentName', adminUploadName.trim());
      fd.append('uploadedByRole', 'admin');
      if (adminUploadFeedback.trim()) fd.append('feedback', adminUploadFeedback.trim());

      const res = await fetch('/api/upload-document', { method: 'POST', body: fd });
      clearInterval(progressInterval);

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        console.error('[AdminDocuments] Upload failed:', json.error);
        setAdminUploading(false);
        return;
      }

      setAdminUploadProgress(100);
      setShowAdminUpload(false);
      setAdminUploadFile(null);
      setAdminUploadName('');
      setAdminUploadCategory('other');
      setAdminUploadFeedback('');
    } catch (err) {
      console.error('[AdminDocuments] Upload error:', err);
    } finally {
      setAdminUploading(false);
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-10">
      <Icon name="ArrowPathIcon" size={20} className="animate-spin text-gray-300" />
    </div>
  );

  const approvedCount = docs.filter((d) => d.doc_status === 'approved').length;
  const submittedCount = docs.filter((d) => d.doc_status === 'uploaded').length;
  const rejectedCount = docs.filter((d) => d.doc_status === 'rejected').length;
  const pendingCount = docs.filter((d) => d.doc_status === 'pending').length;
  const resubmitCount = docs.filter((d) => d.doc_status === 'resubmit_requested').length;
  const total = docs.length;

  const grouped = docs.reduce<Record<string, BorrowerDoc[]>>((acc, doc) => {
    const cat = doc.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(doc);
    return acc;
  }, {});

  if (docs.length === 0 && !showAdminUpload) return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon name="FolderOpenIcon" size={36} className="text-gray-200 mb-3" />
      <p className="text-sm text-gray-400">No documents submitted yet</p>
      <p className="text-xs text-gray-300 mt-1">Documents will appear here once the borrower uploads them.</p>
      {!isMockId && (
        <button onClick={() => setShowAdminUpload(true)} className="mt-4 flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-600 rounded-lg hover:bg-eb-green-800 transition-all">
          <Icon name="ArrowUpTrayIcon" size={13} />Upload Document
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      {showAdminUpload && (
        <div className="bg-white rounded-xl border border-eb-green-900/20 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-eb-green-50/60">
            <div className="flex items-center gap-2"><Icon name="ArrowUpTrayIcon" size={14} className="text-eb-green-800" /><span className="text-xs font-display font-700 text-eb-green-900">Upload Document for Borrower</span></div>
            <button onClick={() => { setShowAdminUpload(false); setAdminUploadFile(null); setAdminUploadName(''); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"><Icon name="XMarkIcon" size={14} /></button>
          </div>
          <form onSubmit={handleAdminUpload} className="p-4 space-y-3">
            <div className={`border-2 border-dashed rounded-xl cursor-pointer transition-all ${adminUploadFile ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-gray-300 bg-gray-50'}`} onClick={() => adminFileRef.current?.click()}>
              <input ref={adminFileRef} type="file" accept={ACCEPTED_TYPES.join(',')} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setAdminUploadFile(f); if (!adminUploadName) setAdminUploadName(f.name.replace(/\.[^.]+$/, '')); } e.target.value = ''; }} />
              {adminUploadFile ? (
                <div className="flex items-center gap-3 px-4 py-3">
                  <Icon name="DocumentCheckIcon" size={16} className="text-emerald-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0"><p className="text-xs font-display font-600 text-gray-900 truncate">{adminUploadFile.name}</p><p className="text-[11px] text-gray-400">{(adminUploadFile.size / (1024 * 1024)).toFixed(1)} MB</p></div>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setAdminUploadFile(null); }} className="w-6 h-6 flex items-center justify-center rounded hover:bg-emerald-100 text-emerald-600 transition-colors"><Icon name="XMarkIcon" size={12} /></button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-5 gap-1.5">
                  <Icon name="ArrowUpTrayIcon" size={20} className="text-gray-400" />
                  <p className="text-sm text-gray-500 font-600">Browse or drag & drop</p>
                  <p className="text-[11px] text-gray-400">PDF, JPG, PNG, DOCX · Max 50MB</p>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[11px] font-display font-600 text-gray-600 mb-1">Document Name *</label><input type="text" value={adminUploadName} onChange={(e) => setAdminUploadName(e.target.value)} placeholder="e.g. Bank Statement" className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all" required /></div>
              <div><label className="block text-[11px] font-display font-600 text-gray-600 mb-1">Category</label><select value={adminUploadCategory} onChange={(e) => setAdminUploadCategory(e.target.value)} className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 bg-white transition-all"><option value="identity">Identity</option><option value="financial">Financial</option><option value="property">Property</option><option value="legal">Legal</option><option value="other">Other</option></select></div>
            </div>
            <div>
              <label className="block text-[11px] font-display font-600 text-gray-600 mb-1">Feedback / Instructions for Borrower <span className="text-gray-400 font-400">(optional)</span></label>
              <textarea value={adminUploadFeedback} onChange={(e) => setAdminUploadFeedback(e.target.value)} placeholder="Add a note or instructions for the borrower about this document…" rows={2} className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 resize-none transition-all" />
              <p className="text-[10px] text-gray-400 mt-1">This message will be visible to the borrower alongside the document.</p>
            </div>
            {adminUploading && (<div><div className="flex justify-between text-[11px] text-gray-500 mb-1"><span>Uploading…</span><span>{adminUploadProgress}%</span></div><div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-eb-green-900 rounded-full transition-all" style={{ width: `${adminUploadProgress}%` }} /></div></div>)}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => { setShowAdminUpload(false); setAdminUploadFile(null); setAdminUploadName(''); setAdminUploadFeedback(''); }} className="px-3 py-1.5 text-xs font-display font-600 text-gray-500 bg-gray-100 hover:bg-gray-200 transition-all">Cancel</button>
              <button type="submit" disabled={adminUploading || !adminUploadFile || !adminUploadName.trim()} className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-display font-600 text-white bg-eb-green-900 rounded-lg hover:bg-eb-green-800 transition-all">
                {adminUploading ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="ArrowUpTrayIcon" size={12} />}
                {adminUploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </form>
        </div>
      )}

      {previewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-9 h-9 rounded-lg bg-eb-green-100 flex items-center justify-center flex-shrink-0 ${previewDoc.doc_status === 'approved' ? 'bg-emerald-100' : previewDoc.doc_status === 'rejected' ? 'bg-red-100' : previewDoc.doc_status === 'resubmit_requested' ? 'bg-orange-100' : previewDoc.doc_status === 'uploaded' ? 'bg-blue-100' : 'bg-gray-100'}`}>
                  <Icon name={(DOC_CATEGORY_ICONS[previewDoc.category] || 'FolderIcon') as Parameters<typeof Icon>[0]['name']} size={16} className={previewDoc.doc_status === 'approved' ? 'text-emerald-600' : previewDoc.doc_status === 'rejected' ? 'text-red-600' : previewDoc.doc_status === 'resubmit_requested' ? 'text-orange-600' : previewDoc.doc_status === 'uploaded' ? 'text-blue-600' : 'text-gray-500'} />
                </div>
                <div className="min-w-0"><p className="font-display font-600 text-sm text-gray-900 truncate">{previewDoc.document_name}</p>{previewDoc.file_name && <p className="text-xs text-gray-400 truncate">{previewDoc.file_name}</p>}</div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {previewDoc.file_url && (<button onClick={() => handleOpenFile(previewDoc)} disabled={viewingId === previewDoc.id} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all"><Icon name="ArrowTopRightOnSquareIcon" size={12} />Open in Tab</button>)}
                <button onClick={() => { setPreviewDoc(null); setPreviewUrl(null); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-all"><Icon name="XMarkIcon" size={16} className="text-gray-500" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-gray-50 min-h-[300px] flex items-center justify-center">
              {previewLoading ? (<div className="flex flex-col items-center gap-3"><Icon name="ArrowPathIcon" size={24} className="animate-spin text-gray-400" /><p className="text-sm text-gray-400">Loading preview…</p></div>)
                : previewUrl ? (<iframe src={previewUrl} className="w-full h-full min-h-[400px] border-0" title={previewDoc.document_name} />)
                : (<div className="flex flex-col items-center gap-3 py-12"><div className="w-16 h-16 rounded-2xl bg-gray-200 flex items-center justify-center"><Icon name="DocumentTextIcon" size={28} className="text-gray-400" /></div><p className="text-sm text-gray-500 font-600">No file uploaded yet</p></div>)}
            </div>
            <div className="px-5 py-4 border-t border-gray-100 bg-gray-50/60 flex-shrink-0">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-display font-600 px-2.5 py-1 rounded-full border ${previewDoc.doc_status === 'approved' ? 'text-emerald-700 bg-emerald-100 border-emerald-200' : previewDoc.doc_status === 'rejected' ? 'text-red-700 bg-red-100 border-red-200' : previewDoc.doc_status === 'resubmit_requested' ? 'text-orange-700 bg-orange-100 border-orange-200' : previewDoc.doc_status === 'uploaded' ? 'text-blue-700 bg-blue-100 border-blue-200' : 'text-gray-600 bg-gray-100 border-gray-200'}`}>{DOC_STATUS_CONFIG[previewDoc.doc_status]?.label ?? 'Pending'}</span>
                  {previewDoc.uploaded_at && <span className="text-xs text-gray-400">Uploaded {new Date(previewDoc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {previewDoc.doc_status !== 'approved' && (<button onClick={() => { setPreviewDoc(null); setPreviewUrl(null); openReview(previewDoc.id, 'approve'); }} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-all"><Icon name="CheckIcon" size={11} />Approve</button>)}
                  {previewDoc.doc_status !== 'rejected' && (<button onClick={() => { setPreviewDoc(null); setPreviewUrl(null); openReview(previewDoc.id, 'reject'); }} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-white bg-red-600 hover:bg-red-700 rounded-lg transition-all"><Icon name="XMarkIcon" size={11} />Reject</button>)}
                  <button onClick={() => { setPreviewDoc(null); setPreviewUrl(null); openReview(previewDoc.id, 'flag'); }} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-orange-700 bg-orange-50 border border-orange-200 hover:bg-orange-100 rounded-lg transition-all"><Icon name="FlagIcon" size={11} />Flag</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="ClipboardDocumentCheckIcon" size={15} className="text-eb-green-700" />
          <h4 className="font-display font-600 text-sm text-gray-900">Document Review</h4>
          <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">{total} docs</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 hidden sm:block"><span className="font-600 text-emerald-700">Approve</span>, <span className="font-600 text-red-600">Reject</span>, or <span className="font-600 text-orange-600">Flag</span></span>
          {!isMockId && (<button onClick={() => setShowAdminUpload((v) => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 rounded-lg hover:bg-eb-green-100 transition-all"><Icon name="ArrowUpTrayIcon" size={12} />Upload</button>)}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /><span className="text-xs text-gray-600 tabular-nums">{approvedCount} Approved</span></div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-xs text-gray-600 tabular-nums">{submittedCount - approvedCount} Submitted</span></div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-xs text-gray-600 tabular-nums">{rejectedCount} Rejected</span></div>
        {resubmitCount > 0 && <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400" /><span className="text-xs text-gray-600 tabular-nums">{resubmitCount} Flagged</span></div>}
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" /><span className="text-xs text-gray-600 tabular-nums">{pendingCount} Pending</span></div>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-eb-green-900 rounded-full transition-all" style={{ width: `${total > 0 ? (approvedCount / total) * 100 : 0}%` }} /></div>
          <span className="text-xs font-display font-700 text-eb-green-900 tabular-nums">{total > 0 ? Math.round((approvedCount / total) * 100) : 0}% approved</span>
        </div>
      </div>

      {Object.entries(grouped).map(([category, categoryDocs]) => (
        <div key={`admin-cat-${category}`}>
          <div className="flex items-center gap-2 mb-2.5">
            <Icon name={(DOC_CATEGORY_ICONS[category] || 'FolderIcon') as Parameters<typeof Icon>[0]['name']} size={13} className="text-gray-400" />
            <p className="text-[11px] font-display font-600 uppercase tracking-widest text-gray-400">{category}</p>
          </div>
          <div className="space-y-3">
            {categoryDocs.map((doc) => {
              const isUpdating = updatingId === doc.id;
              const isReviewing = reviewingId === doc.id;
              return (
                <div key={`admin-doc-${doc.id}`} className={`rounded-xl border transition-all duration-200 overflow-hidden ${doc.doc_status === 'approved' ? 'border-emerald-200 bg-emerald-50/40' : doc.doc_status === 'rejected' ? 'border-red-200 bg-red-50/40' : doc.doc_status === 'resubmit_requested' ? 'border-orange-200 bg-orange-50/40' : doc.doc_status === 'uploaded' ? 'border-blue-200 bg-blue-50/40' : 'border-gray-100 bg-gray-50/30'}`}>
                  <div className="flex items-start gap-3 p-4">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 border-2 transition-all ${doc.doc_status === 'approved' ? 'border-emerald-300 bg-emerald-50' : doc.doc_status === 'rejected' ? 'border-red-300 bg-red-50' : doc.doc_status === 'resubmit_requested' ? 'border-orange-300 bg-orange-50' : doc.doc_status === 'uploaded' ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
                      {doc.doc_status === 'approved' ? <Icon name="CheckCircleIcon" size={16} className="text-emerald-600" /> : doc.doc_status === 'rejected' ? <Icon name="XCircleIcon" size={16} className="text-red-600" /> : doc.doc_status === 'resubmit_requested' ? <Icon name="ArrowPathIcon" size={16} className="text-orange-600" /> : doc.doc_status === 'uploaded' ? <Icon name="ArrowUpTrayIcon" size={16} className="text-blue-600" /> : <Icon name="ClockIcon" size={16} className="text-gray-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-display font-600 text-gray-800">{doc.document_name}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5 capitalize">{doc.document_type.replace(/_/g, ' ')}</p>
                          {doc.file_name && (<div className="flex items-center gap-1.5 mt-1.5"><Icon name="PaperClipIcon" size={11} className="text-gray-400 flex-shrink-0" /><span className="text-[11px] text-gray-500 truncate max-w-[200px]">{doc.file_name}</span></div>)}
                          {doc.uploaded_at && <p className="text-[11px] text-gray-400 mt-0.5">Submitted {new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>}
                        </div>
                        <span className={`text-[11px] font-display font-600 px-2.5 py-1 rounded-full border flex-shrink-0 ${doc.doc_status === 'approved' ? 'text-emerald-700 bg-emerald-100 border-emerald-200' : doc.doc_status === 'rejected' ? 'text-red-700 bg-red-100 border-red-200' : doc.doc_status === 'resubmit_requested' ? 'text-orange-700 bg-orange-100 border-orange-200' : doc.doc_status === 'uploaded' ? 'text-blue-700 bg-blue-100 border-blue-200' : 'text-gray-600 bg-gray-100 border-gray-200'}`}>{DOC_STATUS_CONFIG[doc.doc_status]?.label ?? 'Pending'}</span>
                      </div>
                      {(doc.admin_notes || doc.resubmit_reason) && (
                        <div className={`mt-2.5 flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${doc.doc_status === 'rejected' ? 'bg-red-50 border-red-100 text-red-700' : doc.doc_status === 'resubmit_requested' ? 'bg-orange-50 border-orange-100 text-orange-700' : doc.doc_status === 'approved' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-white border-gray-100 text-gray-600'}`}>
                          <Icon name="ChatBubbleLeftEllipsisIcon" size={12} className="flex-shrink-0 mt-0.5 opacity-70" />
                          <span className="leading-relaxed">{doc.admin_notes || doc.resubmit_reason}</span>
                        </div>
                      )}
                      {!isReviewing && (
                        <div className="flex items-center gap-2 mt-3 flex-wrap">
                          {doc.file_url && (<>
                            <button onClick={() => handlePreviewFile(doc)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition-all"><Icon name="EyeIcon" size={11} />Preview</button>
                            <button onClick={() => handleOpenFile(doc)} disabled={viewingId === doc.id} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all">{viewingId === doc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowTopRightOnSquareIcon" size={11} />}Open</button>
                            <button onClick={() => handleDownloadFile(doc)} disabled={downloadingId === doc.id} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 disabled:opacity-50 rounded-lg transition-all">{downloadingId === doc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowDownTrayIcon" size={11} />}Download</button>
                          </>)}
                          {doc.file_url && <span className="w-px h-4 bg-gray-200 mx-0.5" />}
                          {doc.doc_status !== 'approved' && (<button onClick={() => openReview(doc.id, 'approve')} disabled={isUpdating} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 rounded-lg transition-all active:scale-95">{isUpdating ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="CheckIcon" size={11} />}Approve</button>)}
                          {doc.doc_status !== 'rejected' && (<button onClick={() => openReview(doc.id, 'reject')} disabled={isUpdating} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 disabled:opacity-50 rounded-lg transition-all active:scale-95"><Icon name="XMarkIcon" size={11} />Reject</button>)}
                          <button onClick={() => openReview(doc.id, 'flag')} disabled={isUpdating} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-orange-700 bg-orange-50 border border-orange-200 hover:bg-orange-100 disabled:opacity-50 rounded-lg transition-all active:scale-95"><Icon name="FlagIcon" size={11} />Flag</button>
                        </div>
                      )}
                      {isReviewing && (
                        <div className={`mt-3 rounded-xl border p-4 space-y-3 ${reviewAction === 'approve' ? 'bg-emerald-50 border-emerald-200' : reviewAction === 'reject' ? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200'}`}>
                          <div className="flex items-center gap-2">
                            {reviewAction === 'approve' ? <Icon name="CheckCircleIcon" size={14} className="text-emerald-600" /> : reviewAction === 'reject' ? <Icon name="XCircleIcon" size={14} className="text-red-600" /> : <Icon name="FlagIcon" size={14} className="text-orange-600" />}
                            <span className={`text-xs font-display font-700 ${reviewAction === 'approve' ? 'text-emerald-800' : reviewAction === 'reject' ? 'text-red-800' : 'text-orange-800'}`}>{reviewAction === 'approve' ? 'Approve Document' : reviewAction === 'reject' ? 'Reject Document' : 'Send Flag'}</span>
                          </div>
                          <div>
                            <label className={`block text-[11px] font-display font-600 mb-1.5 ${reviewAction === 'approve' ? 'text-emerald-700' : reviewAction === 'reject' ? 'text-red-700' : 'text-orange-700'}`}>{reviewAction === 'approve' ? 'Approval note (optional)' : reviewAction === 'reject' ? 'Rejection reason (shown to borrower)' : 'Resubmission instructions (shown to borrower)'}</label>
                            <textarea value={feedbackNote} onChange={(e) => setFeedbackNote(e.target.value)} placeholder={reviewAction === 'approve' ? 'Add an optional note…' : reviewAction === 'reject' ? 'Explain why this document is being rejected…' : 'Describe what the borrower needs to fix or resubmit…'} rows={3} autoFocus className={`w-full text-xs border rounded-lg px-3 py-2 outline-none resize-none transition-all bg-white ${reviewAction === 'approve' ? 'border-emerald-200 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400' : reviewAction === 'reject' ? 'border-red-200 focus:ring-2 focus:ring-red-500/20 focus:border-red-400' : 'border-orange-200 focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400'}`} />
                            {reviewAction !== 'approve' && <p className="text-[10px] text-gray-400 mt-1">This note will be visible to the borrower in their document checklist.</p>}
                          </div>
                          <div className="flex items-center gap-2">
                            <button onClick={() => submitReview(doc.id)} disabled={isUpdating || (reviewAction !== 'approve' && !feedbackNote.trim())} className={`flex items-center gap-1.5 px-4 py-2 text-xs font-display font-600 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${reviewAction === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : reviewAction === 'reject' ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-600 hover:bg-orange-700'}`}>
                              {isUpdating ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : reviewAction === 'approve' ? <Icon name="CheckIcon" size={11} /> : reviewAction === 'reject' ? <Icon name="XMarkIcon" size={11} /> : <Icon name="FlagIcon" size={11} />}
                              {isUpdating ? 'Saving…' : reviewAction === 'approve' ? 'Confirm Approval' : reviewAction === 'reject' ? 'Confirm Rejection' : 'Send Flag'}
                            </button>
                            <button onClick={cancelReview} className="px-3 py-2 text-xs font-display font-600 text-gray-500 hover:text-gray-700 transition-all">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      {/* Replacement upload prompt shown after flag/reject */}
                      {replacementPromptDocId === doc.id && !isReviewing && !showAdminUpload && (
                        <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3.5 flex items-start gap-3">
                          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                            <Icon name="ArrowUpTrayIcon" size={14} className="text-blue-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-display font-700 text-blue-900">Upload a replacement document?</p>
                            <p className="text-[11px] text-blue-700 mt-0.5 leading-relaxed">You can send a corrected or replacement version of <span className="font-600">{replacementPromptDocName}</span> for the borrower to review.</p>
                            <div className="flex items-center gap-2 mt-2.5">
                              <button
                                onClick={() => {
                                  setAdminUploadName(replacementPromptDocName);
                                  setAdminUploadFeedback('');
                                  setAdminUploadFile(null);
                                  setAdminUploadCategory('other');
                                  setShowAdminUpload(true);
                                  setReplacementPromptDocId(null);
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-all"
                              >
                                <Icon name="ArrowUpTrayIcon" size={11} />Upload Replacement
                              </button>
                              <button
                                onClick={() => setReplacementPromptDocId(null)}
                                className="px-3 py-1.5 text-xs font-display font-600 text-blue-600 hover:text-blue-800 transition-all"
                              >
                                Skip
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Admin Compliance Documents ────────────────────────────────────────────
const COMPLIANCE_DOC_TYPES = [
  {
    type: 'w9',
    name: 'W-9 Tax Form',
    icon: 'DocumentTextIcon',
    color: 'text-blue-600',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    stepLabel: 'Step 8: Upload W-9',
  },
  {
    type: 'psa',
    name: 'Purchase & Sale Agreement (PSA)',
    icon: 'ClipboardDocumentCheckIcon',
    color: 'text-violet-600',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
    stepLabel: 'Step 4: PSA Review',
  },
  {
    type: 'mou',
    name: 'Memorandum of Understanding (MOU)',
    icon: 'DocumentMagnifyingGlassIcon',
    color: 'text-amber-600',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    stepLabel: 'Step 3: Review MOU',
  },
];

interface AdminComplianceDoc {
  id: string;
  document_name: string;
  document_type: string;
  compliance_type: string | null;
  doc_status: DocApprovalStatus;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  admin_notes: string | null;
  resubmit_reason: string | null;
  uploaded_at: string | null;
  created_at: string;
}

interface AdminComplianceDocsProps {
  userId: string;
  applicationId: string;
  borrowerEmail: string;
  borrowerFirstName: string;
  borrowerLastName: string;
  propertyAddress?: string;
}

function AdminComplianceDocs({ userId, applicationId, borrowerEmail, borrowerFirstName, borrowerLastName, propertyAddress }: AdminComplianceDocsProps) {
  const supabase = useMemo(() => createClient(), []);
  const [docs, setDocs] = useState<AdminComplianceDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<'approve' | 'reject' | 'flag' | null>(null);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const isMockId = applicationId.startsWith('demo-') || applicationId.startsWith('app-') || applicationId.startsWith('mock-');

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    if (isMockId) {
      // Demo compliance docs
      setDocs([
        { id: 'cdoc-1', document_name: 'W-9 Tax Form', document_type: 'w9', compliance_type: 'w9', doc_status: 'uploaded', file_url: null, file_name: 'w9_form_signed.pdf', file_size: 245000, admin_notes: null, resubmit_reason: null, uploaded_at: new Date(Date.now() - 3 * 86400000).toISOString(), created_at: new Date(Date.now() - 4 * 86400000).toISOString() },
        { id: 'cdoc-2', document_name: 'Purchase & Sale Agreement (PSA)', document_type: 'psa', compliance_type: 'psa', doc_status: 'approved', file_url: null, file_name: 'psa_draft_v2.pdf', file_size: 1240000, admin_notes: 'PSA reviewed and approved. Borrower may proceed to sign with seller.', resubmit_reason: null, uploaded_at: new Date(Date.now() - 7 * 86400000).toISOString(), created_at: new Date(Date.now() - 8 * 86400000).toISOString() },
        { id: 'cdoc-3', document_name: 'Memorandum of Understanding (MOU)', document_type: 'mou', compliance_type: 'mou', doc_status: 'pending', file_url: null, file_name: null, file_size: null, admin_notes: null, resubmit_reason: null, uploaded_at: null, created_at: new Date(Date.now() - 10 * 86400000).toISOString() },
      ]);
      setLoading(false);
      return;
    }

    supabase
      .from('borrower_documents')
      .select('*')
      .eq('user_id', userId)
      .eq('application_id', applicationId)
      .in('document_type', ['w9', 'psa', 'mou'])
      .order('uploaded_at', { ascending: false })
      .then(({ data }) => {
        setDocs((data ?? []) as AdminComplianceDoc[]);
        setLoading(false);
      });

    const channel = supabase
      .channel(`admin-compliance-${applicationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'borrower_documents', filter: `user_id=eq.${userId}` }, (payload) => {
        const newDoc = payload.new as AdminComplianceDoc;
        if (newDoc?.application_id !== applicationId) return;
        if (!['w9', 'psa', 'mou'].includes(newDoc?.document_type ?? '')) return;
        if (payload.eventType === 'INSERT') setDocs((prev) => [newDoc, ...prev]);
        else if (payload.eventType === 'UPDATE') setDocs((prev) => prev.map((d) => d.id === newDoc.id ? newDoc : d));
        else if (payload.eventType === 'DELETE') setDocs((prev) => prev.filter((d) => d.id !== (payload.old as AdminComplianceDoc).id));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, applicationId, isMockId, supabase]);

  function normalizeStoragePath(fileUrl: string): string {
    const publicMarker = '/object/public/borrower-documents/';
    const signedMarker = '/object/sign/borrower-documents/';
    if (fileUrl.includes(publicMarker)) return fileUrl.split(publicMarker)[1].split('?')[0];
    if (fileUrl.includes(signedMarker)) return fileUrl.split(signedMarker)[1].split('?')[0];
    return fileUrl;
  }

  async function getSignedUrl(fileUrl: string, expiresIn = 3600): Promise<string | null> {
    const storagePath = normalizeStoragePath(fileUrl);
    const { data, error } = await supabase.storage.from('borrower-documents').createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async function handleOpenFile(doc: AdminComplianceDoc) {
    if (!doc.file_url) return;
    setViewingId(doc.id);
    try {
      let url = await getSignedUrl(doc.file_url, 3600);
      window.open(url ?? doc.file_url, '_blank', 'noopener,noreferrer');
    } finally { setViewingId(null); }
  }

  async function handleDownloadFile(doc: AdminComplianceDoc) {
    if (!doc.file_url) return;
    setDownloadingId(doc.id);
    try {
      let url = await getSignedUrl(doc.file_url, 300);
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.file_name || doc.document_name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`${doc.document_name} downloaded.`, 'success');
    } catch {
      showToast('Download failed. Please try again.', 'error');
    } finally { setDownloadingId(null); }
  }

  function openReview(docId: string, action: 'approve' | 'reject' | 'flag') {
    setReviewingId(docId);
    setReviewAction(action);
    setFeedbackNote('');
  }

  function cancelReview() {
    setReviewingId(null);
    setReviewAction(null);
    setFeedbackNote('');
  }

  async function submitReview(doc: AdminComplianceDoc) {
    if (!reviewAction) return;
    setUpdatingId(doc.id);

    let newStatus: DocApprovalStatus;
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (reviewAction === 'approve') {
      newStatus = 'approved';
      updates.doc_status = newStatus;
      if (feedbackNote.trim()) updates.admin_notes = feedbackNote.trim();
    } else if (reviewAction === 'reject') {
      newStatus = 'rejected';
      updates.doc_status = newStatus;
      updates.admin_notes = feedbackNote.trim() || 'Document rejected by admin.';
    } else {
      newStatus = 'resubmit_requested';
      updates.doc_status = newStatus;
      updates.resubmit_reason = feedbackNote.trim() || 'Please resubmit this document.';
      updates.resubmit_requested_at = new Date().toISOString();
    }

    setDocs((prev) => prev.map((d) => d.id === doc.id ? {
      ...d,
      doc_status: newStatus,
      admin_notes: (updates.admin_notes as string) ?? d.admin_notes,
      resubmit_reason: (updates.resubmit_reason as string) ?? d.resubmit_reason,
    } : d));

    if (!isMockId) {
      await supabase.from('borrower_documents').update(updates).eq('id', doc.id).catch(() => {});

      if (borrowerEmail) {
        const actionMap: Record<string, string> = { approve: 'approved', reject: 'rejected', flag: 'resubmit_requested' };
        const feedbackText = reviewAction === 'approve' ? (feedbackNote.trim() ||'')
          : (feedbackNote.trim() || (reviewAction === 'reject' ? 'Document rejected by admin.' : 'Please resubmit this document.'));
        fetch('/api/send-document-review-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: actionMap[reviewAction],
            borrowerEmail,
            borrowerFirstName,
            borrowerLastName,
            documentName: doc.document_name,
            feedbackNote: feedbackText,
            propertyAddress: propertyAddress || '',
          }),
        }).catch(() => {});
      }
    }

    showToast(`${doc.document_name} ${reviewAction === 'approve' ? 'approved' : reviewAction === 'reject' ? 'rejected' : 'flagged for resubmission'}.`, 'success');
    setUpdatingId(null);
    cancelReview();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Icon name="ArrowPathIcon" size={20} className="animate-spin text-gray-300" />
      </div>
    );
  }

  const getDocForType = (type: string): AdminComplianceDoc | null =>
    docs.find((d) => d.document_type === type || d.compliance_type === type) ?? null;

  const approvedCount = COMPLIANCE_DOC_TYPES.filter((r) => getDocForType(r.type)?.doc_status === 'approved').length;
  const uploadedCount = COMPLIANCE_DOC_TYPES.filter((r) => {
    const d = getDocForType(r.type);
    return d && d.doc_status !== 'pending';
  }).length;

  return (
    <div className="space-y-5">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <Icon name={toast.type === 'success' ? 'CheckCircleIcon' : 'XCircleIcon'} size={18} />
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="ShieldCheckIcon" size={15} className="text-eb-green-700" />
          <h4 className="font-display font-600 text-sm text-gray-900">Compliance Documents</h4>
          <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
            {approvedCount}/{COMPLIANCE_DOC_TYPES.length} approved
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-eb-green-900 rounded-full transition-all"
              style={{ width: `${Math.round((approvedCount / COMPLIANCE_DOC_TYPES.length) * 100)}%` }}
            />
          </div>
          <span className="text-xs font-display font-700 text-eb-green-900 tabular-nums">
            {Math.round((approvedCount / COMPLIANCE_DOC_TYPES.length) * 100)}%
          </span>
        </div>
      </div>

      {/* Summary stats */}
      <div className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /><span className="text-xs text-gray-600 tabular-nums">{approvedCount} Approved</span></div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /><span className="text-xs text-gray-600 tabular-nums">{uploadedCount - approvedCount} Under Review</span></div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-gray-300" /><span className="text-xs text-gray-600 tabular-nums">{COMPLIANCE_DOC_TYPES.length - uploadedCount} Pending Upload</span></div>
      </div>

      {/* Compliance doc cards */}
      <div className="space-y-3">
        {COMPLIANCE_DOC_TYPES.map((req) => {
          const doc = getDocForType(req.type);
          const status = doc?.doc_status ?? 'pending';
          const statusCfg = DOC_STATUS_CONFIG[status as DocApprovalStatus] ?? DOC_STATUS_CONFIG.pending;
          const isReviewing = reviewingId === doc?.id;
          const isUpdating = updatingId === doc?.id;

          return (
            <div
              key={req.type}
              className={`rounded-xl border overflow-hidden transition-all ${
                status === 'approved' ? 'border-emerald-200 bg-emerald-50/30' :
                status === 'rejected' ? 'border-red-200 bg-red-50/30' :
                status === 'resubmit_requested' ? 'border-orange-200 bg-orange-50/30' :
                status === 'uploaded'? 'border-blue-200 bg-blue-50/30' : 'border-gray-100 bg-gray-50/30'
              }`}
            >
              <div className="flex items-start gap-3 p-4">
                {/* Icon */}
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${req.bg}`}>
                  <Icon name={req.icon as Parameters<typeof Icon>[0]['name']} size={18} className={req.color} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-display font-600 text-gray-800">{req.name}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">{req.stepLabel}</p>
                      {doc?.file_name && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <Icon name="PaperClipIcon" size={11} className="text-gray-400 flex-shrink-0" />
                          <span className="text-[11px] text-gray-500 truncate max-w-[200px]">{doc.file_name}</span>
                          {doc.file_size && (
                            <span className="text-[11px] text-gray-400">
                              · {doc.file_size < 1024 * 1024 ? `${(doc.file_size / 1024).toFixed(0)} KB` : `${(doc.file_size / (1024 * 1024)).toFixed(1)} MB`}
                            </span>
                          )}
                        </div>
                      )}
                      {doc?.uploaded_at && (
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          Uploaded {new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                      )}
                    </div>
                    <span className={`text-[11px] font-display font-600 px-2.5 py-1 rounded-full border flex-shrink-0 ${statusCfg.color} ${statusCfg.bg} ${statusCfg.border}`}>
                      {statusCfg.label}
                    </span>
                  </div>

                  {/* Admin notes */}
                  {(doc?.admin_notes || doc?.resubmit_reason) && (
                    <div className={`mt-2.5 flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${
                      status === 'rejected' ? 'bg-red-50 border-red-100 text-red-700' :
                      status === 'resubmit_requested' ? 'bg-orange-50 border-orange-100 text-orange-700' :
                      status === 'approved'? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-white border-gray-100 text-gray-600'
                    }`}>
                      <Icon name="ChatBubbleLeftEllipsisIcon" size={12} className="flex-shrink-0 mt-0.5 opacity-70" />
                      <span className="leading-relaxed">{doc.admin_notes || doc.resubmit_reason}</span>
                    </div>
                  )}

                  {/* Actions */}
                  {!isReviewing && (
                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                      {doc?.file_url ? (
                        <>
                          <button
                            onClick={() => handleOpenFile(doc)}
                            disabled={viewingId === doc.id}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg transition-all"
                          >
                            {viewingId === doc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowTopRightOnSquareIcon" size={11} />}
                            View
                          </button>
                          <button
                            onClick={() => handleDownloadFile(doc)}
                            disabled={downloadingId === doc.id}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 disabled:opacity-50 rounded-lg transition-all"
                          >
                            {downloadingId === doc.id ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowDownTrayIcon" size={11} />}
                            Download
                          </button>
                          <span className="w-px h-4 bg-gray-200 mx-0.5" />
                        </>
                      ) : (
                        <span className="text-[11px] text-gray-400 italic">No file uploaded yet</span>
                      )}

                      {doc && (
                        <>
                          {status !== 'approved' && (
                            <button
                              onClick={() => openReview(doc.id, 'approve')}
                              disabled={isUpdating}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 rounded-lg transition-all"
                            >
                              {isUpdating ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="CheckIcon" size={11} />}
                              Approve
                            </button>
                          )}
                          {status !== 'rejected' && (
                            <button
                              onClick={() => openReview(doc.id, 'reject')}
                              disabled={isUpdating}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 disabled:opacity-50 rounded-lg transition-all"
                            >
                              <Icon name="XMarkIcon" size={11} />
                              Reject
                            </button>
                          )}
                          <button
                            onClick={() => openReview(doc.id, 'flag')}
                            disabled={isUpdating}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-orange-700 bg-orange-50 border border-orange-200 hover:bg-orange-100 disabled:opacity-50 rounded-lg transition-all"
                          >
                            <Icon name="FlagIcon" size={11} />
                            Flag
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Review panel */}
                  {isReviewing && doc && (
                    <div className={`mt-3 rounded-xl border p-4 space-y-3 ${
                      reviewAction === 'approve' ? 'bg-emerald-50 border-emerald-200' :
                      reviewAction === 'reject'? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200'
                    }`}>
                      <div className="flex items-center gap-2">
                        {reviewAction === 'approve' ? <Icon name="CheckCircleIcon" size={14} className="text-emerald-600" /> :
                         reviewAction === 'reject' ? <Icon name="XCircleIcon" size={14} className="text-red-600" /> :
                         <Icon name="FlagIcon" size={14} className="text-orange-600" />}
                        <span className={`text-xs font-display font-700 ${
                          reviewAction === 'approve' ? 'text-emerald-800' :
                          reviewAction === 'reject' ? 'text-red-800' : 'text-orange-800'
                        }`}>
                          {reviewAction === 'approve' ? 'Approve Document' : reviewAction === 'reject' ? 'Reject Document' : 'Flag for Resubmission'}
                        </span>
                      </div>
                      <div>
                        <label className={`block text-[11px] font-display font-600 mb-1.5 ${
                          reviewAction === 'approve' ? 'text-emerald-700' :
                          reviewAction === 'reject' ? 'text-red-700' : 'text-orange-700'
                        }`}>
                          {reviewAction === 'approve' ? 'Approval note (optional)' :
                           reviewAction === 'reject' ? 'Rejection reason (shown to borrower)' :
                           'Resubmission instructions (shown to borrower)'}
                        </label>
                        <textarea
                          value={feedbackNote}
                          onChange={(e) => setFeedbackNote(e.target.value)}
                          placeholder={
                            reviewAction === 'approve' ? 'Add an optional note…' :
                            reviewAction === 'reject' ? 'Explain why this document is being rejected…' :
                            'Describe what the borrower needs to fix or resubmit…'
                          }
                          rows={3}
                          autoFocus
                          className={`w-full text-xs border rounded-lg px-3 py-2 outline-none resize-none transition-all bg-white ${
                            reviewAction === 'approve' ? 'border-emerald-200 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400' :
                            reviewAction === 'reject'? 'border-red-200 focus:ring-2 focus:ring-red-500/20 focus:border-red-400' : 'border-orange-200 focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400'
                          }`}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => submitReview(doc)}
                          disabled={isUpdating || (reviewAction !== 'approve' && !feedbackNote.trim())}
                          className={`flex items-center gap-1.5 px-4 py-2 text-xs font-display font-600 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                            reviewAction === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' :
                            reviewAction === 'reject'? 'bg-red-600 hover:bg-red-700' : 'bg-orange-600 hover:bg-orange-700'
                          }`}
                        >
                          {isUpdating ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> :
                           reviewAction === 'approve' ? <Icon name="CheckIcon" size={11} /> :
                           reviewAction === 'reject' ? <Icon name="XMarkIcon" size={11} /> :
                           <Icon name="FlagIcon" size={11} />}
                          {isUpdating ? 'Saving…' :
                           reviewAction === 'approve' ? 'Confirm Approval' :
                           reviewAction === 'reject' ? 'Confirm Rejection' : 'Send Flag'}
                        </button>
                        <button onClick={cancelReview} className="px-3 py-2 text-xs font-display font-600 text-gray-500 hover:text-gray-700 transition-all">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Application PSA Viewer ────────────────────────────────────────────────
function ApplicationPSAViewer({ fileUrl, fileName }: { fileUrl: string | null; fileName: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(false);

  function normalizeStoragePath(url: string): string {
    const publicMarker = '/object/public/borrower-documents/';
    const signedMarker = '/object/sign/borrower-documents/';
    if (url.includes(publicMarker)) return url.split(publicMarker)[1].split('?')[0];
    if (url.includes(signedMarker)) return url.split(signedMarker)[1].split('?')[0];
    return url;
  }

  async function getSignedUrl(url: string, expiresIn = 3600): Promise<string | null> {
    const storagePath = normalizeStoragePath(url);
    const { data, error } = await supabase.storage.from('borrower-documents').createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async function handleView() {
    if (!fileUrl) return;
    setLoading(true);
    try { let url = await getSignedUrl(fileUrl); window.open(url ?? fileUrl, '_blank', 'noopener,noreferrer'); }
    finally { setLoading(false); }
  }

  async function handleDownload() {
    if (!fileUrl) return;
    setLoading(true);
    try {
      let url = await getSignedUrl(fileUrl);
      if (!url) return;
      const a = document.createElement('a'); a.href = url; a.download = fileName || 'psa_document';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } finally { setLoading(false); }
  }

  return (
    <div className="flex items-center gap-3 p-3 bg-white rounded-lg border border-gray-200">
      <div className="w-8 h-8 rounded-lg bg-eb-green-50 flex items-center justify-center flex-shrink-0"><Icon name="DocumentTextIcon" size={16} className="text-eb-green-700" /></div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-display font-600 text-gray-800 truncate">{fileName || 'Document'}</p>
        <p className="text-xs text-gray-400 mt-0.5">{fileUrl ? 'File uploaded' : 'No file uploaded'}</p>
      </div>
      {fileUrl && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={handleView} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all disabled:opacity-50">{loading ? <Icon name="ArrowPathIcon" size={11} className="animate-spin" /> : <Icon name="ArrowTopRightOnSquareIcon" size={11} />}View</button>
          <button onClick={handleDownload} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 rounded-lg transition-all disabled:opacity-50"><Icon name="ArrowDownTrayIcon" size={11} />Download</button>
        </div>
      )}
    </div>
  );
}

// ── Main BorrowerDetailContent ────────────────────────────────────────────
const BorrowerDetailContent: React.FC = () => {
  const params = useParams();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  // Support both /admin/borrower/[id]/application/[appId] (new) and /admin/borrower/[id] (legacy)
  const applicationId = (params?.appId ?? params?.id) as string;
  const borrowerUserId = params?.id as string;
  const isMockId = applicationId?.startsWith('demo-') || applicationId?.startsWith('app-') || applicationId?.startsWith('mock-');

  const [application, setApplication] = useState<BorrowerApplication | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'compliance' | 'documents' | 'activity' | 'feedback' | 'deadlines' | 'funding' | 'invoices'>('overview');

  // Status update
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<AppStatus | ''>('');
  const [statusNote, setStatusNote] = useState('');
  const [statusSuccess, setStatusSuccess] = useState(false);

  // Activity
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Feedback / admin note
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [feedbackType, setFeedbackType] = useState<'admin_note' | 'status_change' | 'deadline_shift'>('admin_note');

  // ── NEW: CRM enrichment state ─────────────────────────────────────────
  interface CrmContact {
    id: string;
    first_name: string;
    last_name: string;
    primary_email: string;
    phone: string | null;
    portal_link_status: string;
  }
  interface CrmCompany {
    id: string;
    company_name: string;
  }
  interface CrmTask {
    id: string;
    title: string;
    due_date: string | null;
    task_status: string;
  }
  const [crmContact, setCrmContact] = useState<CrmContact | null>(null);
  const [additionalContactCount, setAdditionalContactCount] = useState(0);
  const [crmCompany, setCrmCompany] = useState<CrmCompany | null>(null);
  const [openTasks, setOpenTasks] = useState<CrmTask[]>([]);
  const [docCount, setDocCount] = useState<number | null>(null);

  // ── NEW: Inline header edit state ─────────────────────────────────────
  const [headerStatus, setHeaderStatus] = useState<AppStatus | ''>('');
  const [headerOwner, setHeaderOwner] = useState<string>('');
  const [updatingHeaderStatus, setUpdatingHeaderStatus] = useState(false);
  const [updatingHeaderOwner, setUpdatingHeaderOwner] = useState(false);

  // ── NEW: Quick action modals ───────────────────────────────────────────
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteSending, setNoteSending] = useState(false);
  const [noteSent, setNoteSent] = useState(false);

  const [showTaskModal, setShowTaskModal] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDueDate, setTaskDueDate] = useState('');
  const [taskPriority, setTaskPriority] = useState('Medium');
  const [taskAssignedTo, setTaskAssignedTo] = useState('Unassigned');
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskSaved, setTaskSaved] = useState(false);

  // ── NEW: Send Email modal state ────────────────────────────────────────
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailForm, setEmailForm] = useState({ to: '', subject: '', body: '' });
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailSendError, setEmailSendError] = useState<string | null>(null);
  // Attachment state
  const [emailAttachments, setEmailAttachments] = useState<AttachmentDescriptor[]>([]);
  const [attachmentsUploading, setAttachmentsUploading] = useState(false);
  const [attachmentPickerKey, setAttachmentPickerKey] = useState(0);

  // Load application
  useEffect(() => {
    if (!applicationId) return;

    if (isMockId) {
      const demo = DEMO_APPLICATIONS.find((a) => a.id === applicationId) ?? DEMO_APPLICATIONS[0];
      setApplication(demo);
      setSelectedStatus(demo.app_status);
      setHeaderStatus(demo.app_status);
      setHeaderOwner(demo.eb_assigned_owner ?? 'Unassigned');
      setLoading(false);
      return;
    }

    supabase
      .from('borrower_applications')
      .select('*')
      .eq('id', applicationId)
      .is('purged_at', null)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!error && !data) {
          // Missing or purged Deal — never render it as an active Deal
          router.replace('/admin/deals');
          return;
        }
        if (error || !data) {
          const demo = DEMO_APPLICATIONS[0];
          setApplication(demo);
          setSelectedStatus(demo.app_status);
          setHeaderStatus(demo.app_status);
          setHeaderOwner(demo.eb_assigned_owner ?? 'Unassigned');
        } else {
          setApplication(data as BorrowerApplication);
          setSelectedStatus((data as BorrowerApplication).app_status);
          setHeaderStatus((data as BorrowerApplication).app_status);
          setHeaderOwner((data as BorrowerApplication).eb_assigned_owner ?? 'Unassigned');
        }
        setLoading(false);
      });
  }, [applicationId, isMockId, supabase]);

  // ── NEW: Load CRM enrichment data ─────────────────────────────────────
  const loadCrmEnrichment = useCallback(async (app: BorrowerApplication) => {
    if (isMockId) return;

    // Load primary CRM contact
    if (app.primary_contact_id) {
      const { data: contact } = await supabase
        .from('crm_contacts')
        .select('id, first_name, last_name, primary_email, phone, portal_link_status')
        .eq('id', app.primary_contact_id)
        .single();
      if (contact) setCrmContact(contact as CrmContact);
    }

    // Load all deal contacts to count additional ones
    const { data: dealContacts } = await supabase
      .from('crm_deal_contacts')
      .select('contact_id, role')
      .eq('deal_id', applicationId);
    if (dealContacts) {
      const additional = dealContacts.filter((dc: any) => dc.role !== 'primary').length;
      setAdditionalContactCount(additional);
      // If no primary_contact_id but there are deal contacts, load the first one
      if (!app.primary_contact_id && dealContacts.length > 0) {
        const { data: firstContact } = await supabase
          .from('crm_contacts')
          .select('id, first_name, last_name, primary_email, phone, portal_link_status')
          .eq('id', dealContacts[0].contact_id)
          .single();
        if (firstContact) setCrmContact(firstContact as CrmContact);
      }
    }

    // Load CRM company
    if (app.crm_company_id) {
      const { data: company } = await supabase
        .from('crm_companies')
        .select('id, company_name')
        .eq('id', app.crm_company_id)
        .single();
      if (company) setCrmCompany(company as CrmCompany);
    }

    // Load open tasks for this deal (via application_id or contact_id)
    const today = new Date().toISOString().split('T')[0];
    if (app.primary_contact_id) {
      const { data: tasks } = await supabase
        .from('crm_tasks')
        .select('id, title, due_date, task_status')
        .eq('contact_id', app.primary_contact_id)
        .eq('task_status', 'Open')
        .order('due_date', { ascending: true })
        .limit(10);
      if (tasks) setOpenTasks(tasks as CrmTask[]);
    }

    // Count logical documents (distinct document groups = logical documents)
    // borrower_documents: count distinct document_group_id values where is_current_version = true
    // application_documents: count distinct thread_id values where is_current_version = true
    let logicalCount = 0;
    const { data: bdGroups } = await supabase
      .from('borrower_documents')
      .select('document_group_id')
      .eq('application_id', applicationId)
      .eq('is_current_version', true);
    if (bdGroups) {
      const uniqueGroups = new Set(bdGroups.map((r: any) => r.document_group_id).filter(Boolean));
      logicalCount += uniqueGroups.size;
    } else {
      // Fallback: count all rows if versioning fields not yet present
      const { count } = await supabase
        .from('borrower_documents')
        .select('id', { count: 'exact', head: true })
        .eq('application_id', applicationId);
      logicalCount += count ?? 0;
    }
    const { data: adThreads } = await supabase
      .from('application_documents')
      .select('thread_id')
      .eq('application_id', applicationId)
      .eq('is_current_version', true);
    if (adThreads) {
      const uniqueThreads = new Set(adThreads.map((r: any) => r.thread_id).filter(Boolean));
      logicalCount += uniqueThreads.size;
    } else {
      const { count } = await supabase
        .from('application_documents')
        .select('id', { count: 'exact', head: true })
        .eq('application_id', applicationId);
      logicalCount += count ?? 0;
    }
    setDocCount(logicalCount);
  }, [applicationId, isMockId, supabase]);

  useEffect(() => {
    if (application) loadCrmEnrichment(application);
  }, [application, loadCrmEnrichment]);

  // Load activity
  const loadActivity = useCallback(async () => {
    if (!applicationId) return;
    setActivityLoading(true);
    if (isMockId) {
      setActivity(getDemoActivity(applicationId));
      setActivityLoading(false);
      return;
    }
    const { data } = await supabase
      .from('application_activity')
      .select('*')
      .eq('application_id', applicationId)
      .order('created_at', { ascending: false });
    setActivity(data && data.length > 0 ? (data as ActivityItem[]) : getDemoActivity(applicationId));
    setActivityLoading(false);
  }, [applicationId, isMockId, supabase]);

  useEffect(() => {
    if (activeTab === 'activity') loadActivity();
  }, [activeTab, loadActivity]);

  // Update status
  async function handleStatusUpdate() {
    if (!selectedStatus || !application) return;
    setUpdatingStatus(true);
    let newStatus = selectedStatus as AppStatus;

    if (!isMockId) {
      try {
        await supabase
          .from('borrower_applications')
          .update({ app_status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', applicationId);
      } catch (_) {}

      // Log activity
      try {
        await supabase.from('application_activity').insert({
          application_id: applicationId,
          user_id: application.user_id,
          event_type: 'status_change',
          title: `Status changed to ${STATUS_CONFIG[newStatus]?.label ?? newStatus}`,
          detail: statusNote.trim() || `Application status updated by admin.`,
          actor: 'EarnestBridge Admin',
        });
      } catch (_) {}

      // Send email notification
      if (statusNote.trim()) {
        fetch('/api/send-status-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            borrowerEmail: application.email,
            borrowerFirstName: application.first_name,
            borrowerLastName: application.last_name,
            newStatus,
            note: statusNote.trim(),
            propertyAddress: application.property_address || '',
          }),
        }).catch(() => {});
      }
    }

    setApplication((prev) => prev ? { ...prev, app_status: newStatus } : prev);
    setHeaderStatus(newStatus);
    setStatusNote('');
    setStatusSuccess(true);
    setTimeout(() => setStatusSuccess(false), 3000);
    setUpdatingStatus(false);
  }

  // ── NEW: Inline header status update ──────────────────────────────────
  async function handleHeaderStatusUpdate(newStatus: AppStatus) {
    if (!application || newStatus === application.app_status) return;
    setUpdatingHeaderStatus(true);
    setHeaderStatus(newStatus);

    if (!isMockId) {
      try {
        await supabase
          .from('borrower_applications')
          .update({ app_status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', applicationId);
        await supabase.from('application_activity').insert({
          application_id: applicationId,
          user_id: application.user_id,
          event_type: 'status_change',
          title: `Status changed to ${STATUS_CONFIG[newStatus]?.label ?? newStatus}`,
          detail: 'Status updated from Deal header.',
          actor: 'EarnestBridge Admin',
        });
      } catch (_) {}
    }

    setApplication((prev) => prev ? { ...prev, app_status: newStatus } : prev);
    setSelectedStatus(newStatus);
    setUpdatingHeaderStatus(false);
  }

  // ── NEW: Inline header owner update ───────────────────────────────────
  // Routes through Admin-only server endpoint for consistent authorization
  // and activity logging (with previous owner context) matching Admin Home.
  async function handleHeaderOwnerUpdate(newOwner: string) {
    if (!application) return;
    setUpdatingHeaderOwner(true);
    setHeaderOwner(newOwner);

    if (!isMockId) {
      try {
        const res = await fetch('/api/admin/update-deal-owner', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applicationId, newOwner }),
        });
        if (!res.ok) {
          // Revert optimistic header update on failure
          setHeaderOwner(application.eb_assigned_owner ?? 'Unassigned');
          setUpdatingHeaderOwner(false);
          return;
        }
      } catch (_) {
        setHeaderOwner(application.eb_assigned_owner ?? 'Unassigned');
        setUpdatingHeaderOwner(false);
        return;
      }
    }

    setApplication((prev) => prev ? { ...prev, eb_assigned_owner: newOwner === 'Unassigned' ? null : newOwner } : prev);
    setUpdatingHeaderOwner(false);
  }

  // ── NEW: Quick Add Note ────────────────────────────────────────────────
  async function handleAddNote() {
    if (!noteText.trim() || !application) return;
    setNoteSending(true);

    if (!isMockId) {
      try {
        await supabase.from('application_activity').insert({
          application_id: applicationId,
          user_id: application.user_id,
          event_type: 'admin_note',
          title: 'Admin Note Added',
          detail: noteText.trim(),
          actor: 'EarnestBridge Admin',
        });
      } catch (_) {}
    }

    setNoteText('');
    setNoteSent(true);
    setTimeout(() => { setNoteSent(false); setShowNoteModal(false); }, 2000);
    setNoteSending(false);
  }

  // ── NEW: Quick Add Task ────────────────────────────────────────────────
  async function handleAddTask() {
    if (!taskTitle.trim() || !application) return;
    setTaskSaving(true);

    if (!isMockId) {
      try {
        const taskBody: Record<string, unknown> = {
          title: taskTitle.trim(),
          task_status: 'Open',
          priority: taskPriority,
          assigned_to: taskAssignedTo,
          deal_id: applicationId,
        };
        if (taskDueDate) taskBody.due_date = taskDueDate;
        if (crmContact?.id) taskBody.contact_id = crmContact.id;
        if (crmCompany?.id) taskBody.company_id = crmCompany.id;

        await fetch('/api/crm/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(taskBody),
        });

        // Log deal activity
        await supabase.from('application_activity').insert({
          application_id: applicationId,
          user_id: application.user_id,
          event_type: 'task_created',
          title: `Task created: ${taskTitle.trim()}`,
          detail: [
            taskDueDate ? `Due: ${taskDueDate}` : null,
            taskAssignedTo !== 'Unassigned' ? `Assigned to: ${taskAssignedTo}` : null,
          ].filter(Boolean).join(' · ') || 'Task added from Deal.',
          actor: 'EarnestBridge Admin',
        });
      } catch (_) {}
    }

    setTaskTitle('');
    setTaskDueDate('');
    setTaskPriority('Medium');
    setTaskAssignedTo('Unassigned');
    setTaskSaved(true);
    setTimeout(() => { setTaskSaved(false); setShowTaskModal(false); }, 2000);
    setTaskSaving(false);
  }

  // ── NEW: Send Email from Deal ──────────────────────────────────────────
  async function handleSendEmail() {
    if (!emailForm.to || !emailForm.subject || !emailForm.body || !application) return;
    if (attachmentsUploading) return;
    setSendingEmail(true);
    setEmailSendError(null);

    if (!isMockId) {
      if (crmContact?.id) {
        // Use existing CRM send-email API (logs to crm_email_log + crm_activities)
        try {
          const payload: Record<string, unknown> = {
            to: emailForm.to,
            subject: emailForm.subject,
            body: emailForm.body,
          };
          if (emailAttachments.length > 0) {
            payload.attachments = emailAttachments;
          }
          const res = await fetch(`/api/crm/contacts/${crmContact.id}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          let responseBody: Record<string, unknown> = {};
          try {
            responseBody = await res.json();
          } catch { /* ignore */ }

          if (res.ok) {
            // On success: clear attachment state, do NOT delete storage objects (now audit records)
            setEmailSent(true);
            setEmailForm({ to: '', subject: '', body: '' });
            setEmailAttachments([]);
            setAttachmentPickerKey(k => k + 1);
            setTimeout(() => { setEmailSent(false); setShowEmailModal(false); }, 2000);
          } else {
            // Failure — keep form open, show error, do NOT clear or close
            let errorMsg = 'Email could not be sent. Please try again.';
            if (typeof responseBody.error === 'string' && responseBody.error) {
              errorMsg = responseBody.error;
            }

            // Use attachmentState from the response to determine correct UI behavior
            const attachmentState = typeof responseBody?.attachmentState === 'string'
              ? responseBody.attachmentState
              : null;

            if (emailAttachments.length > 0) {
              if (attachmentState === 'audited') {
                // Attachments were consumed into audit records — must NOT be deleted or reused
                // Clear them from local state and prompt reattach
                setEmailAttachments([]);
                setAttachmentPickerKey(k => k + 1);
                errorMsg = 'Email was not sent. Please reattach files before retrying.';
              } else if (attachmentState === 'temporary') {
                // Attachments were NOT audited — preserve picker state for retry
                // (no state change needed — attachments remain in picker)
              } else {
                // No attachmentState in response — fall back to 409 detection as defense-in-depth
                if (res.status === 409 && typeof responseBody.error === 'string' && responseBody.error.includes('already been used')) {
                  errorMsg = 'Please reattach files before retrying this email.';
                  setEmailAttachments([]);
                  setAttachmentPickerKey(k => k + 1);
                }
                // For all other unknown failures, conservatively preserve attachments
              }
            }

            setEmailSendError(errorMsg);
          }
        } catch (_) {
          setEmailSendError('Email could not be sent. Please try again.');
        }
      } else {
        // No CRM contact linked — cannot send without a contact record
        setEmailSendError('No CRM contact is linked to this deal. Please link a contact before sending email.');
      }
    } else {
      // Mock/demo mode — simulate success
      setEmailSent(true);
      setEmailForm({ to: '', subject: '', body: '' });
      setEmailAttachments([]);
      setAttachmentPickerKey(k => k + 1);
      setTimeout(() => { setEmailSent(false); setShowEmailModal(false); }, 2000);
    }

    setSendingEmail(false);
  }

  function openEmailModal() {
    const recipientEmail = crmContact?.primary_email ?? application?.email ?? '';
    const propertyRef = application?.property_address ?? application?.company_name ?? '';
    const subject = propertyRef ? `EarnestBridge — ${propertyRef}` : 'EarnestBridge';
    setEmailForm({ to: recipientEmail, subject, body: '' });
    setEmailSent(false);
    setShowEmailModal(true);
  }

  // ── Close/Cancel email composer with cleanup ──────────────────────────────

  async function handleCloseEmailModal() {
    // Best-effort cleanup of any uploaded-but-unsent attachments
    if (emailAttachments.length > 0 && crmContact?.id) {
      await cleanupAttachments(crmContact.id, emailAttachments);
    }
    setEmailAttachments([]);
    setAttachmentPickerKey(k => k + 1);
    setShowEmailModal(false);
    setEmailSendError(null);
  }

  // Send feedback / admin note
  async function handleSendFeedback() {
    if (!feedbackText.trim() || !application) return;
    setFeedbackSending(true);

    if (!isMockId) {
      try {
        await supabase.from('application_activity').insert({
          application_id: applicationId,
          user_id: application.user_id,
          event_type: feedbackType,
          title: feedbackType === 'admin_note' ? 'Admin Note Added' : feedbackType === 'status_change' ? 'Status Update Note' : 'Deadline Update',
          detail: feedbackText.trim(),
          actor: 'EarnestBridge Admin',
        });
      } catch (_) {}

      // Also create a notification for the borrower
      try {
        await supabase.from('notifications').insert({
          user_id: application.user_id,
          type: 'admin_note',
          title: 'New message from EarnestBridge',
          message: feedbackText.trim(),
          action_url: '/application-status',
          action_label: 'View Application',
        });
      } catch (_) {}
    }

    setFeedbackText('');
    setFeedbackSent(true);
    setTimeout(() => setFeedbackSent(false), 3000);
    setFeedbackSending(false);
    if (activeTab === 'activity') loadActivity();
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading application…</p>
        </div>
      </div>
    );
  }

  if (!application) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <Icon name="ExclamationTriangleIcon" size={40} className="text-gray-200 mx-auto mb-3" />
          <p className="text-sm text-gray-500 font-600">Application not found</p>
          <button onClick={() => router.push('/admin')} className="mt-4 text-xs text-eb-green-700 hover:underline">← Back to Clients</button>
        </div>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[application.app_status] ?? STATUS_CONFIG.draft ?? { label: application.app_status ?? 'Unknown', color: 'text-gray-600', bg: 'bg-gray-100', border: 'border-gray-200' };
  const currentPhaseIdx = getPhaseIndexForStatus(application.app_status);

  // ── Attention items ────────────────────────────────────────────────────
  const attentionItems: string[] = [];
  if (!application.eb_assigned_owner) attentionItems.push('No assigned owner');
  const overdueTaskCount = openTasks.filter(t => {
    if (!t.due_date) return false;
    return new Date(t.due_date).getTime() < new Date().setHours(0,0,0,0);
  }).length;
  if (overdueTaskCount > 0) attentionItems.push(`${overdueTaskCount} overdue task${overdueTaskCount > 1 ? 's' : ''}`);

  const TABS = [
    { id: 'overview', label: 'Overview', icon: 'DocumentTextIcon' },
    { id: 'funding', label: 'Funding & Option', icon: 'BanknotesIcon' },
    { id: 'invoices', label: 'Invoices', icon: 'DocumentTextIcon' },
    { id: 'deadlines', label: 'Deadlines', icon: 'CalendarDaysIcon' },
    { id: 'compliance', label: 'Compliance Docs', icon: 'ShieldCheckIcon' },
    { id: 'documents', label: 'All Documents', icon: 'FolderOpenIcon' },
    { id: 'activity', label: 'Activity', icon: 'ClockIcon' },
    { id: 'feedback', label: 'Send Feedback', icon: 'ChatBubbleLeftEllipsisIcon' },
  ] as const;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Back nav */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => borrowerUserId ? router.push(`/admin/borrower/${borrowerUserId}`) : router.push('/admin/borrowers')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors"
        >
          <Icon name="ChevronLeftIcon" size={14} />
          {borrowerUserId ? `${application.first_name} ${application.last_name}` : 'Back to Clients'}
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-xs text-gray-400 truncate max-w-[200px]">{application.property_address || `App ${applicationId.slice(0, 8).toUpperCase()}`}</span>
      </div>

      {/* ── ENHANCED DEAL HEADER ─────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">

        {/* Attention banner */}
        {attentionItems.length > 0 && (
          <div className="flex items-center gap-2 px-5 py-2.5 bg-amber-50 border-b border-amber-200">
            <Icon name="ExclamationTriangleIcon" size={14} className="text-amber-600 flex-shrink-0" />
            <p className="text-xs font-600 text-amber-800">
              {attentionItems.length === 1
                ? attentionItems[0]
                : `${attentionItems.length} items need attention: ${attentionItems.join(' · ')}`}
            </p>
            {attentionItems.some(a => a.includes('task')) && (
              <button
                onClick={() => setActiveTab('activity')}
                className="ml-auto text-[11px] font-600 text-amber-700 hover:text-amber-900 underline whitespace-nowrap"
              >
                View Activity
              </button>
            )}
          </div>
        )}

        {/* Deal identity row */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            {/* Deal icon */}
            <div className="w-12 h-12 rounded-xl bg-eb-green-900 flex items-center justify-center flex-shrink-0">
              <Icon name="HomeModernIcon" size={22} className="text-white" />
            </div>

            {/* Deal title + contact + company */}
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-display font-700 text-gray-900 leading-tight">
                {application.property_address || `Deal ${applicationId.slice(0, 8).toUpperCase()}`}
              </h1>
              {application.property_type && (
                <p className="text-xs text-gray-400 mt-0.5">{application.property_type}</p>
              )}

              {/* Contact + Company row */}
              <div className="flex flex-wrap items-center gap-3 mt-2">
                {crmContact ? (
                  <a
                    href={`/admin/crm/contacts/${crmContact.id}`}
                    className="flex items-center gap-1.5 text-xs font-600 text-eb-green-700 hover:text-eb-green-900 hover:underline transition-colors"
                  >
                    <Icon name="UserCircleIcon" size={13} className="text-eb-green-600" />
                    {crmContact.first_name} {crmContact.last_name}
                  </a>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-gray-400 italic">
                    <Icon name="UserCircleIcon" size={13} />
                    {application.first_name} {application.last_name}
                  </span>
                )}

                {additionalContactCount > 0 && (
                  <button
                    onClick={() => setActiveTab('overview')}
                    className="text-[11px] text-gray-400 hover:text-gray-600 font-600 transition-colors"
                  >
                    +{additionalContactCount} more contact{additionalContactCount > 1 ? 's' : ''}
                  </button>
                )}

                {crmCompany ? (
                  <a
                    href={`/admin/crm/companies/${crmCompany.id}`}
                    className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-eb-green-700 hover:underline transition-colors"
                  >
                    <Icon name="BuildingOfficeIcon" size={12} className="text-gray-400" />
                    {crmCompany.company_name}
                  </a>
                ) : application.company_name ? (
                  <span className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Icon name="BuildingOfficeIcon" size={12} className="text-gray-400" />
                    {application.company_name}
                  </span>
                ) : null}

                {/* Portal status badge */}
                {crmContact && (
                  <span className={`inline-flex items-center gap-1 text-[10px] font-600 px-2 py-0.5 rounded-full border ${
                    crmContact.portal_link_status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                    crmContact.portal_link_status === 'pending'? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-500 border-gray-200'
                  }`}>
                    <Icon name={crmContact.portal_link_status === 'approved' ? 'CheckCircleIcon' : crmContact.portal_link_status === 'pending' ? 'ClockIcon' : 'UserIcon'} size={9} />
                    {crmContact.portal_link_status === 'approved' ? 'Portal Active' : crmContact.portal_link_status === 'pending' ? 'Portal Pending' : 'No Portal'}
                  </span>
                )}
              </div>
            </div>

            {/* ID + created date */}
            <div className="flex-shrink-0 text-right hidden sm:block">
              <p className="text-[10px] font-600 text-gray-400 uppercase tracking-wide">Deal ID</p>
              <p className="text-xs font-700 text-gray-500 font-mono">{applicationId.slice(0, 8).toUpperCase()}</p>
              <p className="text-[10px] text-gray-400 mt-1">{formatDate(application.created_at)}</p>
            </div>
          </div>

          {/* ── Key Facts Strip ─────────────────────────────────────── */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {/* EMD (dynamic: Requested / Funded) */}
            <div className={`rounded-xl p-3 border ${getDynamicEmd(application).isFunded ? 'bg-eb-green-50 border-eb-green-200' : 'bg-amber-50 border-amber-200'}`}>
              <p className={`text-[10px] font-700 uppercase tracking-wide mb-0.5 ${getDynamicEmd(application).isFunded ? 'text-eb-green-700' : 'text-amber-700'}`}>{getDynamicEmd(application).label}</p>
              <p className={`text-base font-display font-700 ${getDynamicEmd(application).isFunded ? 'text-eb-green-900' : 'text-amber-900'}`}>{getDynamicEmd(application).value}</p>
            </div>

            {/* Purchase Price */}
            {application.purchase_price && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                <p className="text-[10px] font-700 text-gray-500 uppercase tracking-wide mb-0.5">Purchase Price</p>
                <p className="text-base font-display font-700 text-gray-800">{formatCurrency(application.purchase_price)}</p>
              </div>
            )}

            {/* Due Diligence Period */}
            <div className="border rounded-xl p-3 bg-gray-50 border-gray-200">
              <p className="text-[10px] font-700 uppercase tracking-wide mb-0.5 text-gray-500">Due Diligence Period</p>
              <p className="text-sm font-display font-700 text-gray-800">{formatDueDiligenceDays(application.due_diligence_days)}</p>
            </div>

            {/* Stage — inline editable */}
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
              <p className="text-[10px] font-700 text-gray-500 uppercase tracking-wide mb-1">Stage</p>
              <div className="relative">
                <select
                  value={headerStatus}
                  onChange={e => handleHeaderStatusUpdate(e.target.value as AppStatus)}
                  disabled={updatingHeaderStatus}
                  className={`w-full text-xs font-600 border-0 bg-transparent outline-none cursor-pointer pr-4 appearance-none ${statusCfg.color} disabled:opacity-60`}
                  style={{ WebkitAppearance: 'none' }}
                >
                  {ALL_STATUSES.map(s => (
                    <option key={s} value={s}>{STATUS_CONFIG[s]?.label ?? s}</option>
                  ))}
                </select>
                <Icon name={updatingHeaderStatus ? 'ArrowPathIcon' : 'ChevronDownIcon'} size={10} className={`absolute right-0 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none ${updatingHeaderStatus ? 'animate-spin' : ''}`} />
              </div>
            </div>

            {/* Owner — inline editable */}
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
              <p className="text-[10px] font-700 text-gray-500 uppercase tracking-wide mb-1">Owner</p>
              <div className="relative">
                <select
                  value={headerOwner || 'Unassigned'}
                  onChange={e => handleHeaderOwnerUpdate(e.target.value)}
                  disabled={updatingHeaderOwner}
                  className="w-full text-xs font-600 text-gray-700 border-0 bg-transparent outline-none cursor-pointer pr-4 appearance-none disabled:opacity-60"
                  style={{ WebkitAppearance: 'none' }}
                >
                  {['Eric', 'Dan', 'Tucker', 'Unassigned'].map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
                <Icon name={updatingHeaderOwner ? 'ArrowPathIcon' : 'ChevronDownIcon'} size={10} className={`absolute right-0 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none ${updatingHeaderOwner ? 'animate-spin' : ''}`} />
              </div>
            </div>
          </div>

          {/* ── Quick Action Bar ─────────────────────────────────────── */}
          <div className="mt-4 flex flex-wrap gap-2">
            {/* Add Note */}
            <button
              onClick={() => setShowNoteModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-600 text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all"
            >
              <Icon name="ChatBubbleLeftEllipsisIcon" size={13} className="text-gray-500" />
              Add Note
            </button>

            {/* Add Task */}
            <button
              onClick={() => setShowTaskModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-600 text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all"
            >
              <Icon name="ClipboardDocumentListIcon" size={13} className="text-gray-500" />
              Add Task
            </button>

            {/* Edit Deal */}
            <button
              onClick={() => setActiveTab('overview')}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-600 text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all"
            >
              <Icon name="PencilSquareIcon" size={13} className="text-gray-500" />
              Edit Deal
            </button>

            {/* Documents quick access */}
            <button
              onClick={() => setActiveTab('documents')}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-600 text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all"
            >
              <Icon name="FolderOpenIcon" size={13} className="text-gray-500" />
              Documents{docCount !== null ? ` (${docCount})` : ''}
            </button>

            {/* Email borrower */}
            {(crmContact?.primary_email ?? application?.email) ? (
              <button
                onClick={openEmailModal}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-600 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 rounded-lg hover:bg-eb-green-100 transition-all"
              >
                <Icon name="EnvelopeIcon" size={13} className="text-eb-green-600" />
                Email Client
              </button>
            ) : (
              <span className="flex items-center gap-1.5 px-3 py-2 text-xs font-600 text-gray-400 bg-gray-50 border border-gray-200 rounded-lg cursor-not-allowed" title="No client email available">
                <Icon name="EnvelopeIcon" size={13} className="text-gray-300" />
                No client email available
              </span>
            )}

            {/* View CRM Contact */}
            {crmContact && (
              <a
                href={`/admin/crm/contacts/${crmContact.id}`}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-600 text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
              >
                <Icon name="UserCircleIcon" size={13} className="text-gray-400" />
                CRM Contact
              </a>
            )}
          </div>
        </div>

        {/* Progress phases */}
        <div className="px-5 pb-5 border-t border-gray-100 pt-4">
          <div className="flex items-center gap-0 overflow-x-auto pb-1">
            {APPLICATION_PHASES.map((phase, idx) => {
              const isCompleted = idx < currentPhaseIdx;
              const isCurrent = idx === currentPhaseIdx;
              const isRejected = (application.app_status === 'rejected' || application.app_status === 'expired') && idx === currentPhaseIdx;
              return (
                <React.Fragment key={phase.phase}>
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-lg flex-shrink-0 transition-all ${isCurrent && !isRejected ? 'bg-eb-green-50 border border-eb-green-200' : isCompleted ? 'opacity-80' : 'opacity-40'}`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${isCompleted ? 'bg-eb-green-900' : isCurrent && !isRejected ? 'bg-eb-green-900' : isRejected ? 'bg-red-500' : 'bg-gray-200'}`}>
                      {isCompleted ? <Icon name="CheckIcon" size={11} className="text-white" /> : isRejected ? <Icon name="XMarkIcon" size={11} className="text-white" /> : <span className="text-[10px] font-display font-700 text-white">{idx + 1}</span>}
                    </div>
                    <span className={`text-[11px] font-display font-600 whitespace-nowrap ${isCurrent && !isRejected ? 'text-eb-green-900' : isCompleted ? 'text-gray-600' : 'text-gray-400'}`}>{phase.label}</span>
                  </div>
                  {idx < APPLICATION_PHASES.length - 1 && (
                    <div className={`w-6 h-px flex-shrink-0 ${idx < currentPhaseIdx ? 'bg-eb-green-900' : 'bg-gray-200'}`} />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── ADD NOTE MODAL ───────────────────────────────────────────────── */}
      {showNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Icon name="ChatBubbleLeftEllipsisIcon" size={16} className="text-violet-600" />
                <h3 className="font-display font-700 text-sm text-gray-900">Add Internal Note</h3>
              </div>
              <button onClick={() => { setShowNoteModal(false); setNoteText(''); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-all">
                <Icon name="XMarkIcon" size={16} className="text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                placeholder="Add an internal note about this deal…"
                rows={4}
                autoFocus
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-500/10 resize-none transition-all"
              />
              <p className="text-[11px] text-gray-400">This note is Admin-only and will not be visible to the client.</p>
              {noteSent && (
                <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <Icon name="CheckCircleIcon" size={13} />
                  Note saved successfully
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddNote}
                  disabled={noteSending || !noteText.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 transition-all"
                >
                  {noteSending ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="CheckIcon" size={12} />}
                  {noteSending ? 'Saving…' : 'Save Note'}
                </button>
                <button onClick={() => { setShowNoteModal(false); setNoteText(''); }} className="px-4 py-2 text-xs font-600 text-gray-500 hover:text-gray-700 transition-all">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── SEND EMAIL MODAL ─────────────────────────────────────────────── */}
      {showEmailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h2 className="text-lg font-700 text-gray-900 font-display">Send Email</h2>
              <button onClick={handleCloseEmailModal} className="p-2 rounded-lg hover:bg-gray-100 transition-all">
                <Icon name="XMarkIcon" size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {/* Error banner — shown on delivery failure, form stays open */}
              {emailSendError && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg">
                  <Icon name="ExclamationCircleIcon" size={16} className="text-red-500 mt-0.5 shrink-0" />
                  <p className="text-sm text-red-700">{emailSendError}</p>
                </div>
              )}
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">To</label>
                <input
                  type="email"
                  value={emailForm.to}
                  onChange={e => setEmailForm(f => ({ ...f, to: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20"
                />
              </div>
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Subject</label>
                <input
                  type="text"
                  value={emailForm.subject}
                  onChange={e => setEmailForm(f => ({ ...f, subject: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20"
                />
              </div>
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Message</label>
                <textarea
                  value={emailForm.body}
                  onChange={e => setEmailForm(f => ({ ...f, body: e.target.value }))}
                  rows={5}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 resize-none"
                />
              </div>
              {/* Attachments — only available when a CRM contact is linked */}
              {crmContact?.id && (
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-2">Attachments</label>
                  <EmailAttachmentPicker
                    key={attachmentPickerKey}
                    contactId={crmContact.id}
                    onChange={setEmailAttachments}
                    onUploadingChange={setAttachmentsUploading}
                    disabled={sendingEmail}
                  />
                </div>
              )}
              <p className="text-xs text-gray-400">Email is sent server-side and logged to the CRM activity timeline.</p>
              {emailSent && (
                <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <Icon name="CheckCircleIcon" size={13} />
                  Email sent successfully
                </div>
              )}
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button
                onClick={handleSendEmail}
                disabled={!emailForm.to || !emailForm.subject || !emailForm.body || sendingEmail || attachmentsUploading}
                className="flex-1 py-2.5 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors"
              >
                {sendingEmail ? 'Sending…' : attachmentsUploading ? 'Uploading…' : 'Send Email'}
              </button>
              <button onClick={handleCloseEmailModal} className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ADD TASK MODAL ───────────────────────────────────────────────── */}
      {showTaskModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Icon name="ClipboardDocumentListIcon" size={16} className="text-blue-600" />
                <h3 className="font-display font-700 text-sm text-gray-900">Add Task</h3>
              </div>
              <button onClick={() => { setShowTaskModal(false); setTaskTitle(''); setTaskDueDate(''); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-all">
                <Icon name="XMarkIcon" size={16} className="text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-[11px] font-600 text-gray-500 mb-1.5">Task Title *</label>
                <input
                  type="text"
                  value={taskTitle}
                  onChange={e => setTaskTitle(e.target.value)}
                  placeholder="e.g. Follow up on closing documents"
                  autoFocus
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 transition-all"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-600 text-gray-500 mb-1.5">Due Date</label>
                  <input
                    type="date"
                    value={taskDueDate}
                    onChange={e => setTaskDueDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 bg-white transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-600 text-gray-500 mb-1.5">Priority</label>
                  <select
                    value={taskPriority}
                    onChange={e => setTaskPriority(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 bg-white transition-all"
                  >
                    {['Low', 'Medium', 'High', 'Urgent'].map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-600 text-gray-500 mb-1.5">Assign To</label>
                <select
                  value={taskAssignedTo}
                  onChange={e => setTaskAssignedTo(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 bg-white transition-all"
                >
                  {['Eric', 'Dan', 'Tucker', 'Unassigned'].map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
              {crmContact && (
                <p className="text-[11px] text-gray-400">
                  Task will be linked to <span className="font-600 text-gray-600">{crmContact.first_name} {crmContact.last_name}</span>
                </p>
              )}
              {taskSaved && (
                <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <Icon name="CheckCircleIcon" size={13} />
                  Task created successfully
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddTask}
                  disabled={taskSaving || !taskTitle.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 transition-all"
                >
                  {taskSaving ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="PlusIcon" size={12} />}
                  {taskSaving ? 'Creating…' : 'Create Task'}
                </button>
                <button onClick={() => { setShowTaskModal(false); setTaskTitle(''); setTaskDueDate(''); }} className="px-4 py-2 text-xs font-600 text-gray-500 hover:text-gray-700 transition-all">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-display font-600 transition-all whitespace-nowrap flex-shrink-0 ${activeTab === tab.id ? 'bg-white text-eb-green-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <Icon name={tab.icon as Parameters<typeof Icon>[0]['name']} size={13} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left: Application details */}
          <div className="lg:col-span-2 space-y-5">
            {/* Deal Details */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <Icon name="HomeModernIcon" size={15} className="text-eb-green-700" />
                <h3 className="font-display font-700 text-sm text-gray-900">Deal Details</h3>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: 'Property Address', value: application.property_address || '—', span: true },
                  { label: 'Property Type', value: application.property_type || '—' },
                  { label: 'Purchase Price', value: formatCurrency(application.purchase_price) },
                  { label: getDynamicEmd(application).label, value: getDynamicEmd(application).value },
                  { label: 'Due Diligence Period', value: formatDueDiligenceDays(application.due_diligence_days) },
                  { label: 'Days to Funding', value: application.days_to_funding ? `${application.days_to_funding} days` : '—' },
                  { label: 'Submitted', value: formatDate(application.submitted_at) },
                  { label: 'Application ID', value: application.id.slice(0, 8).toUpperCase() },
                ].map((item) => (
                  <div key={item.label} className={item.span ? 'col-span-2' : ''}>
                    <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">{item.label}</p>
                    <p className="text-sm text-gray-800 font-600">{item.value}</p>
                  </div>
                ))}
                {application.transaction_description && (
                  <div className="col-span-2">
                    <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Transaction Description</p>
                    <p className="text-sm text-gray-700 leading-relaxed">{application.transaction_description}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Entity / Legal */}
            {(application.company_name || application.llc_name || application.attorney_name) && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Icon name="BuildingOfficeIcon" size={15} className="text-eb-green-700" />
                  <h3 className="font-display font-700 text-sm text-gray-900">Entity & Legal</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {application.company_name && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Company</p><p className="text-sm text-gray-800 font-600">{application.company_name}</p></div>}
                  {application.company_type && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Entity Type</p><p className="text-sm text-gray-800 font-600">{application.company_type}</p></div>}
                  {application.llc_name && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">LLC Name</p><p className="text-sm text-gray-800 font-600">{application.llc_name}</p></div>}
                  {application.llc_state && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">LLC State</p><p className="text-sm text-gray-800 font-600">{application.llc_state}</p></div>}
                  {application.llc_ein && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">EIN</p><p className="text-sm text-gray-800 font-600">{application.llc_ein}</p></div>}
                  {application.attorney_name && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Attorney</p><p className="text-sm text-gray-800 font-600">{application.attorney_name}</p></div>}
                  {application.attorney_firm && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Law Firm</p><p className="text-sm text-gray-800 font-600">{application.attorney_firm}</p></div>}
                  {application.attorney_email && <div><p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Attorney Email</p><p className="text-sm text-gray-800 font-600">{application.attorney_email}</p></div>}
                </div>
              </div>
            )}

            {/* Submitted Documents (LOI / PSA) */}
            {(application.loi_file_url || application.psa_file_url) && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Icon name="PaperClipIcon" size={15} className="text-eb-green-700" />
                  <h3 className="font-display font-700 text-sm text-gray-900">Application Documents</h3>
                </div>
                <div className="space-y-2">
                  {application.loi_file_url && (
                    <div>
                      <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-1.5">Letter of Intent (LOI)</p>
                      <ApplicationPSAViewer fileUrl={application.loi_file_url} fileName={application.loi_file_name ?? null} />
                    </div>
                  )}
                  {application.psa_file_url && (
                    <div>
                      <p className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mb-1.5">Purchase & Sale Agreement (PSA)</p>
                      <ApplicationPSAViewer fileUrl={application.psa_file_url} fileName={application.psa_file_name ?? null} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* CRM Contacts */}
            <DealCrmContactsSection
              dealId={applicationId}
              isMockId={isMockId}
              onUpdated={async () => {
                if (isMockId) return;
                const { data: fresh } = await supabase
                  .from('borrower_applications')
                  .select('primary_contact_id')
                  .eq('id', applicationId)
                  .maybeSingle();
                const primaryId = (fresh as { primary_contact_id: string | null } | null)?.primary_contact_id ?? null;
                const { data: dcs } = await supabase
                  .from('crm_deal_contacts')
                  .select('contact_id, role')
                  .eq('deal_id', applicationId);
                const rows = (dcs as { contact_id: string; role: string }[] | null) ?? [];
                setAdditionalContactCount(rows.filter(r => r.role !== 'primary').length);
                const headerId = primaryId ?? rows[0]?.contact_id ?? null;
                if (headerId) {
                  const { data: c } = await supabase
                    .from('crm_contacts')
                    .select('id, first_name, last_name, primary_email, phone, portal_link_status')
                    .eq('id', headerId)
                    .maybeSingle();
                  setCrmContact((c as CrmContact | null) ?? null);
                } else {
                  setCrmContact(null);
                }
              }}
            />
          </div>

          {/* Right: Status update + borrower info */}
          <div className="space-y-5">
            {/* Status Update */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <Icon name="ArrowPathIcon" size={15} className="text-eb-green-700" />
                <h3 className="font-display font-700 text-sm text-gray-900">Update Status</h3>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Current Status</label>
                  <span className={`inline-flex text-xs font-display font-600 px-3 py-1.5 rounded-lg border ${statusCfg.color} ${statusCfg.bg} ${statusCfg.border}`}>{statusCfg.label}</span>
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">New Status</label>
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value as AppStatus)}
                    className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 bg-white transition-all"
                  >
                    {ALL_STATUSES.map((s) => (
                      <option key={s} value={s}>{STATUS_CONFIG[s]?.label ?? s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">Note (optional, sent to borrower)</label>
                  <textarea
                    value={statusNote}
                    onChange={(e) => setStatusNote(e.target.value)}
                    placeholder="Add a note about this status change…"
                    rows={3}
                    className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 resize-none transition-all"
                  />
                </div>
                {statusSuccess && (
                  <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                    <Icon name="CheckCircleIcon" size={13} />
                    Status updated successfully
                  </div>
                )}
                <button
                  onClick={handleStatusUpdate}
                  disabled={updatingStatus || !selectedStatus || selectedStatus === application.app_status}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {updatingStatus ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : <Icon name="CheckIcon" size={13} />}
                  {updatingStatus ? 'Updating…' : 'Update Status'}
                </button>
              </div>
            </div>

            {/* Borrower Contact */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <Icon name="UserCircleIcon" size={15} className="text-eb-green-700" />
                <h3 className="font-display font-700 text-sm text-gray-900">Borrower Contact</h3>
              </div>
              <div className="space-y-3">
                {[
                  { icon: 'UserIcon', label: 'Name', value: `${application.first_name} ${application.last_name}` },
                  { icon: 'EnvelopeIcon', label: 'Email', value: application.email },
                  { icon: 'PhoneIcon', label: 'Phone', value: application.phone || '—' },
                  { icon: 'CalendarDaysIcon', label: 'Applied', value: formatDate(application.created_at) },
                ].map((item) => (
                  <div key={item.label} className="flex items-start gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-gray-50 border border-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={12} className="text-gray-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide">{item.label}</p>
                      <p className="text-xs text-gray-800 font-600 truncate">{item.value}</p>
                    </div>
                  </div>
                ))}
                <button
                  onClick={openEmailModal}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-gray-200 text-xs font-display font-600 text-gray-600 rounded-xl hover:bg-gray-50 transition-all mt-1"
                >
                  <Icon name="EnvelopeIcon" size={12} />
                  Email Borrower
                </button>
              </div>
            </div>

            {/* Identity Verification */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <Icon name="ShieldCheckIcon" size={15} className="text-eb-green-700" />
                <h3 className="font-display font-700 text-sm text-gray-900">Identity Verification</h3>
              </div>
              <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${application.identity_verified ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                <Icon name={application.identity_verified ? 'CheckCircleIcon' : 'ExclamationTriangleIcon'} size={16} className={application.identity_verified ? 'text-emerald-600' : 'text-amber-600'} />
                <div>
                  <p className={`text-xs font-display font-700 ${application.identity_verified ? 'text-emerald-800' : 'text-amber-800'}`}>{application.identity_verified ? 'Identity Verified' : 'Not Yet Verified'}</p>
                  {application.identity_method && <p className="text-[11px] text-gray-500 mt-0.5 capitalize">Method: {application.identity_method.replace(/_/g, ' ')}</p>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'compliance' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <AdminComplianceDocs
            userId={application.user_id}
            applicationId={applicationId}
            borrowerEmail={application.email}
            borrowerFirstName={application.first_name}
            borrowerLastName={application.last_name}
            propertyAddress={application.property_address ?? undefined}
          />
        </div>
      )}

      {activeTab === 'documents' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          {/* ONE unified Documents section — both sources normalized, source table hidden */}
          <div className="flex items-center gap-2 mb-5 pb-4 border-b border-gray-100">
            <Icon name="FolderOpenIcon" size={16} className="text-eb-green-700" />
            <h3 className="font-display font-700 text-sm text-gray-900">
              Documents{docCount > 0 ? ` (${docCount})` : ''}
            </h3>
          </div>
          <div className="space-y-6">
            <AdminVersionedDocuments
              applicationId={applicationId}
              userId={application.user_id}
              borrowerEmail={application.email}
              borrowerFirstName={application.first_name}
              borrowerLastName={application.last_name}
              propertyAddress={application.property_address ?? undefined}
            />
            <AdminVersionedAppDocuments
              applicationId={applicationId}
              userId={application.user_id}
            />
          </div>
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <Icon name="ClockIcon" size={15} className="text-eb-green-700" />
              <h3 className="font-display font-700 text-sm text-gray-900">Activity Feed</h3>
            </div>
            <button onClick={loadActivity} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors">
              <Icon name="ArrowPathIcon" size={12} className={activityLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          {activityLoading ? (
            <div className="flex items-center justify-center py-10">
              <Icon name="ArrowPathIcon" size={20} className="animate-spin text-gray-300" />
            </div>
          ) : activity.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Icon name="ClockIcon" size={32} className="text-gray-200 mb-3" />
              <p className="text-sm text-gray-400">No activity recorded yet</p>
            </div>
          ) : (
            <div className="space-y-1">
              {activity.map((item, idx) => {
                const cfg = EVENT_TYPE_CONFIG[item.event_type] ?? EVENT_TYPE_CONFIG.system;
                // Detect legacy failed email entries: event_type=email_sent with "Status: failed" in detail
                const isFailedEmail = item.event_type === 'email_sent' && item.detail?.includes('Status: failed');
                // Derive display title: replace "Email sent to X" with "Email failed to X" for failed entries
                const displayTitle = isFailedEmail
                  ? item.title.replace(/^Email sent to /, 'Email failed to ')
                  : item.title;
                const failedCfg = isFailedEmail
                  ? { ...cfg, color: 'bg-red-50 text-red-600', label: 'Failed' }
                  : cfg;
                return (
                  <div key={item.id} className="flex gap-3 group">
                    <div className="flex flex-col items-center">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${failedCfg.color}`}>
                        <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={14} />
                      </div>
                      {idx < activity.length - 1 && <div className="w-px flex-1 bg-gray-100 my-1" />}
                    </div>
                    <div className="flex-1 min-w-0 pb-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-display font-600 text-gray-800">{displayTitle}</p>
                          {item.detail && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.detail}</p>}
                          <p className="text-[11px] text-gray-400 mt-1">{item.actor} · {timeAgo(item.created_at)}</p>
                        </div>
                        <span className={`text-[10px] font-display font-600 px-2 py-0.5 rounded-full flex-shrink-0 ${failedCfg.color}`}>{failedCfg.label}</span>
                      </div>
                      {item.event_type === 'admin_note' && (
                        <AdminReplyThread
                          eventId={item.id}
                          applicationId={applicationId}
                          userId={application.user_id}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'feedback' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 max-w-2xl">
          <div className="flex items-center gap-2 mb-5">
            <Icon name="ChatBubbleLeftEllipsisIcon" size={15} className="text-eb-green-700" />
            <h3 className="font-display font-700 text-sm text-gray-900">Send Feedback to Borrower</h3>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-[11px] font-display font-600 text-gray-500 mb-2">Message Type</label>
              <div className="flex flex-wrap gap-2">
                {([
                  { value: 'admin_note', label: 'General Note', icon: 'ChatBubbleLeftEllipsisIcon', color: 'violet' },
                  { value: 'status_change', label: 'Status Update', icon: 'ArrowPathIcon', color: 'indigo' },
                  { value: 'deadline_shift', label: 'Deadline Notice', icon: 'CalendarDaysIcon', color: 'orange' },
                ] as const).map((type) => (
                  <button
                    key={type.value}
                    onClick={() => setFeedbackType(type.value)}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-display font-600 rounded-lg border transition-all ${feedbackType === type.value ? `bg-${type.color}-50 border-${type.color}-300 text-${type.color}-800` : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'}`}
                  >
                    <Icon name={type.icon as Parameters<typeof Icon>[0]['name']} size={12} />
                    {type.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-display font-600 text-gray-500 mb-1.5">
                Message to {application.first_name}
              </label>
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder={
                  feedbackType === 'admin_note' ? `Write a note or message to ${application.first_name}…` :
                  feedbackType === 'status_change'? 'Describe the status update and what the borrower should expect…' : 'Describe the deadline change and any action required from the borrower…'
                }
                rows={5}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-500/10 resize-none transition-all"
              />
              <p className="text-[11px] text-gray-400 mt-1.5">This message will appear in the borrower's notification feed and activity log.</p>
            </div>

            {feedbackSent && (
              <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                <Icon name="CheckCircleIcon" size={14} />
                Feedback sent successfully to {application.first_name}
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={handleSendFeedback}
                disabled={feedbackSending || !feedbackText.trim()}
                className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 text-white text-xs font-display font-700 rounded-xl hover:bg-eb-green-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {feedbackSending ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : <Icon name="PaperAirplaneIcon" size={13} />}
                {feedbackSending ? 'Sending…' : 'Send to Borrower'}
              </button>
              <button
                onClick={() => setFeedbackText('')}
                disabled={!feedbackText}
                className="px-4 py-2.5 text-xs font-display font-600 text-gray-500 hover:text-gray-700 transition-all"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'deadlines' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <DealDeadlinesSection
            applicationId={applicationId}
            isMockId={isMockId}
          />
        </div>
      )}

      {activeTab === 'funding' && (
        <div className="space-y-5">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <FundingOptionSection
              applicationId={applicationId}
              appStatus={application.app_status}
              isMockId={isMockId}
            />
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <FundingBillingSection
              applicationId={applicationId}
              depositAmount={application.deposit_amount}
              dueDiligenceDays={application.due_diligence_days ?? null}
              isMockId={isMockId}
              onFundingSaved={(cents) =>
                setApplication((prev) => (prev ? { ...prev, emd_funded_cents: cents } : prev))
              }
            />
          </div>
        </div>
      )}

      {activeTab === 'invoices' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <DealInvoicesSection
            applicationId={applicationId}
            isMockId={isMockId}
          />
        </div>
      )}
    </div>
  );
};

export default BorrowerDetailContent;