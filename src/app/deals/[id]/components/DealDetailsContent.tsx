'use client';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deal {
  id: string;
  user_id?: string;
  company_name: string | null;
  property_address: string | null;
  property_type: string | null;
  purchase_price: number | null;
  deposit_amount: number | null;
  emd_funded_cents?: number | null;
  due_diligence_days?: number | null;
  app_status: string;
  submitted_at?: string | null;
  created_at?: string;
  days_to_funding?: number | null;
  llc_name: string | null;
  llc_state: string | null;
  transaction_description: string | null;
  psa_file_url?: string | null;
  psa_file_name?: string | null;
  deal_workflow_stage?: number | null;
  w9_signed?: boolean;
  mou_signed?: boolean;
  option_agreement_signed?: boolean;
  psa_signed?: boolean;
  llc_formed?: boolean;
  escrow_funded?: boolean;
  option_exercised?: boolean;
}

interface AdminFeedback {
  id: string;
  message: string;
  created_at: string;
  admin_name?: string;
  feedback_type?: string;
}

type PortalOptionStatus =
  | 'action_required' |'extension_in_process' |'extension_requirements_received' |'option_exercised' |'deadline_not_met';

interface PortalOptionCycle {
  cycle_number: number;
  deposit_goes_hard_date: string;
  option_exercise_deadline: string;
  option_deadline_cutoff_display: string;
  client_status: PortalOptionStatus;
  has_timely_amendment: boolean;
  extension_fee_paid: boolean;
}

const DEADLINE_NOT_MET_DESCRIPTION =
  'The Option Exercise Deadline was not met. Please contact EarnestBridge for next steps.';

const OPTION_STATUS_UI: Record<PortalOptionStatus, { label: string; chip: string; guidance: string }> = {
  action_required: {
    label: 'Action Required',
    chip: 'bg-amber-50 text-amber-700 border-amber-200',
    guidance: 'Complete any required option or extension action by the Option Exercise Deadline.',
  },
  extension_in_process: {
    label: 'Extension in Process',
    chip: 'bg-blue-50 text-blue-700 border-blue-200',
    guidance: 'Your signed amendment has been received. The Extension Deal Fee is still pending.',
  },
  extension_requirements_received: {
    label: 'Extension Requirements Received',
    chip: 'bg-teal-50 text-teal-700 border-teal-200',
    guidance: 'Your signed amendment and Extension Deal Fee have been received.',
  },
  option_exercised: {
    label: 'Option Exercised',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    guidance: 'Your option exercise has been recorded.',
  },
  deadline_not_met: {
    label: 'Deadline Not Met',
    chip: 'bg-gray-100 text-gray-700 border-gray-200',
    guidance: DEADLINE_NOT_MET_DESCRIPTION,
  },
};

// Whole calendar days from `todayYmd` to `deadlineYmd` (both YYYY-MM-DD).
function calendarDaysBetween(todayYmd: string, deadlineYmd: string): number {
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const [dy, dm, dd] = deadlineYmd.split('-').map(Number);
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

// Current America/New_York calendar date (YYYY-MM-DD) and minutes since ET midnight.
function getEtNow(): { ymd: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  };
}

// 5:00 PM ET option exercise cutoff, expressed in minutes since ET midnight.
const OPTION_CUTOFF_MINUTES_ET = 17 * 60;

interface BorrowerDoc {
  id: string;
  document_name: string;
  document_type: string;
  compliance_type: string | null;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  doc_status: string;
  admin_notes: string | null;
  resubmit_reason: string | null;
  uploaded_at: string | null;
  created_at: string;
}

// ─── Portal Invoice Types ─────────────────────────────────────────────────────

interface PortalReceipt {
  payment_id: string;
  receipt_number: string;
  receipt_pdf_generated_at: string;
}

interface PortalInvoice {
  id: string;
  invoice_number: string;
  status: string;
  issued_at: string;
  due_date: string | null;
  total_cents: number;
  currency: string;
  is_revision: boolean;
  // Payment aggregate fields — server-computed, no payment detail exposed.
  amount_paid_cents: number;
  balance_remaining_cents: number;
  // Minimal completed-receipt metadata (display only; never used to authorize).
  receipts?: PortalReceipt[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; icon: string; description: string }> = {
  draft:                  { label: 'Draft',                color: 'text-gray-600',    bg: 'bg-gray-50',     border: 'border-gray-200',    icon: 'PencilIcon',          description: 'Your application is saved as a draft. Submit when ready.' },
  submitted:              { label: 'Submitted',            color: 'text-blue-700',    bg: 'bg-blue-50',     border: 'border-blue-200',    icon: 'PaperAirplaneIcon',   description: 'Application submitted and received by EarnestBridge.' },
  under_review:           { label: 'Under Review',         color: 'text-indigo-700',  bg: 'bg-indigo-50',   border: 'border-indigo-200',  icon: 'MagnifyingGlassIcon', description: 'EarnestBridge is reviewing your application details.' },
  in_review:              { label: 'In Review',            color: 'text-indigo-700',  bg: 'bg-indigo-50',   border: 'border-indigo-200',  icon: 'MagnifyingGlassIcon', description: 'EarnestBridge is reviewing your application details.' },
  conditionally_approved: { label: 'Conditionally Approved', color: 'text-amber-700', bg: 'bg-amber-50',   border: 'border-amber-200',   icon: 'ClipboardDocumentCheckIcon', description: 'Conditionally approved — please complete all outstanding requirements.' },
  approved:               { label: 'Approved',             color: 'text-green-700',   bg: 'bg-green-50',    border: 'border-green-200',   icon: 'CheckCircleIcon',     description: 'Your application has been approved. Funding is in progress.' },
  funded:                 { label: 'Funded',               color: 'text-emerald-700', bg: 'bg-emerald-50',  border: 'border-emerald-200', icon: 'BanknotesIcon',       description: 'Funds have been disbursed. Proceed to closing.' },
  closed:                 { label: 'Closed',               color: 'text-gray-600',    bg: 'bg-gray-50',     border: 'border-gray-200',    icon: 'LockClosedIcon',      description: 'This deal has been successfully closed.' },
};

const REQUIRED_DOCS = [
  { type: 'w9',  name: 'W-9 Tax Form',                    icon: 'DocumentTextIcon',           color: 'text-blue-600',   bg: 'bg-blue-50',   border: 'border-blue-200',   description: 'IRS W-9 form required for tax compliance. Must be signed and dated.' },
  { type: 'psa', name: 'Purchase & Sale Agreement (PSA)', icon: 'ClipboardDocumentCheckIcon', color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-200', description: 'Your executed PSA for EarnestBridge review before signing with the seller.' },
  { type: 'mou', name: 'Memorandum of Understanding',     icon: 'DocumentMagnifyingGlassIcon', color: 'text-amber-600', bg: 'bg-amber-50',  border: 'border-amber-200',  description: 'Signed MOU outlining EarnestBridge program standards and your obligations.' },
];

const DOC_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string; icon: string }> = {
  pending:            { label: 'Pending Upload',    color: 'text-gray-500',    bg: 'bg-gray-100',    border: 'border-gray-200',    icon: 'ClockIcon' },
  uploaded:           { label: 'Under Review',      color: 'text-blue-600',    bg: 'bg-blue-50',     border: 'border-blue-200',    icon: 'ArrowPathIcon' },
  approved:           { label: 'Approved',          color: 'text-emerald-600', bg: 'bg-emerald-50',  border: 'border-emerald-200', icon: 'CheckCircleIcon' },
  rejected:           { label: 'Rejected',          color: 'text-red-600',     bg: 'bg-red-50',      border: 'border-red-200',     icon: 'XCircleIcon' },
  expired:            { label: 'Expired',           color: 'text-orange-600',  bg: 'bg-orange-50',   border: 'border-orange-200',  icon: 'ExclamationCircleIcon' },
  resubmit_requested: { label: 'Resubmit Required', color: 'text-amber-600',   bg: 'bg-amber-50',    border: 'border-amber-200',   icon: 'ArrowUpTrayIcon' },
};

const FEEDBACK_TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  action_required: { icon: 'ExclamationTriangleIcon', label: 'Action Required', color: 'text-red-600 bg-red-50 border-red-200' },
  info:            { icon: 'InformationCircleIcon',   label: 'Information',     color: 'text-blue-600 bg-blue-50 border-blue-200' },
  approval:        { icon: 'CheckCircleIcon',         label: 'Approval Note',   color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  rejection:       { icon: 'XCircleIcon',             label: 'Rejection Note',  color: 'text-red-600 bg-red-50 border-red-200' },
  general:         { icon: 'ChatBubbleLeftEllipsisIcon', label: 'Admin Note',   color: 'text-gray-600 bg-gray-50 border-gray-200' },
};

const ACCEPTED_TYPES = ['application/pdf','image/jpeg','image/png','image/webp','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(val: number | null) {
  if (val == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

// Dynamic EMD: FUNDED (cents → dollars) only when emd_funded_cents > 0, else REQUESTED (dollars).
function getDynamicEmd(deal: { deposit_amount: number | null; emd_funded_cents?: number | null }) {
  const cents = deal.emd_funded_cents;
  if (cents != null && cents > 0) {
    return { isFunded: true, label: 'Funded EMD', value: formatCurrency(cents / 100) };
  }
  return { isFunded: false, label: 'Requested EMD', value: formatCurrency(deal.deposit_amount) };
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Format a DATE-only string (YYYY-MM-DD) without timezone shifting.
// If the value contains a time component, fall back to formatDate.
function formatDateSafe(dateStr: string | null): string {
  if (!dateStr) return '—';
  // DATE-only: YYYY-MM-DD — parse as local date to avoid UTC shift
  const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;
  if (dateOnlyRe.test(dateStr)) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return formatDate(dateStr);
}

// Format invoice amount from cents using Intl.NumberFormat with the invoice currency.
function formatInvoiceAmount(totalCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(totalCents / 100);
  } catch {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(totalCents / 100);
  }
}

// Friendly portal status labels — only statuses the portal API returns.
function invoiceStatusLabel(status: string): string {
  switch (status) {
    case 'open':           return 'Open';
    case 'partially_paid': return 'Partially Paid';
    case 'paid':           return 'Paid';
    default: {
      // Neutral formatted fallback for any unexpected status — no eligibility logic.
      return status
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
  }
}

function invoiceStatusStyle(status: string): string {
  switch (status) {
    case 'open':           return 'bg-blue-50 border-blue-200 text-blue-700';
    case 'partially_paid': return 'bg-amber-50 border-amber-200 text-amber-700';
    case 'paid':           return 'bg-emerald-50 border-emerald-200 text-emerald-700';
    default:               return 'bg-gray-50 border-gray-200 text-gray-600';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (d > 30) return `${Math.floor(d / 30)}mo ago`;
  if (d > 1) return `${d}d ago`;
  if (d === 1) return '1d ago';
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'Just now';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface DocUploadRowProps {
  req: typeof REQUIRED_DOCS[number];
  doc: BorrowerDoc | null;
  dealId: string;
  onUploaded: () => void;
}

function DocUploadRow({ req, doc, dealId, onUploaded }: DocUploadRowProps) {
  const { user } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleFile = async (file: File) => {
    if (!user) return;
    if (!ACCEPTED_TYPES.includes(file.type)) { showToast('Unsupported file type. Use PDF, JPG, PNG, or DOCX.', 'error'); return; }
    if (file.size > MAX_FILE_SIZE) { showToast('File exceeds 50MB limit.', 'error'); return; }

    setUploading(true);
    setProgress(0);

    const ext = file.name.split('.').pop();
    const filePath = `${user.id}/${dealId}/${req.type}-${Date.now()}.${ext}`;

    try {
      const interval = setInterval(() => {
        setProgress(p => { if (p >= 80) { clearInterval(interval); return p; } return p + 15; });
      }, 200);

      const { error: uploadErr } = await supabase.storage.from('borrower-documents').upload(filePath, file, { upsert: true });
      clearInterval(interval);
      if (uploadErr) throw new Error(`Storage: ${uploadErr.message}`);
      setProgress(90);

      // Verify the application exists before attempting FK-constrained insert
      const { data: appCheck } = await supabase
        .from('borrower_applications')
        .select('id')
        .eq('id', dealId)
        .single();

      const applicationId = appCheck ? dealId : null;

      if (doc) {
        const { error: updateErr } = await supabase.from('borrower_documents').update({
          file_url: filePath, file_name: file.name, file_size: file.size, mime_type: file.type,
          doc_status: 'uploaded', uploaded_at: new Date().toISOString(), resubmit_reason: null,
          compliance_type: req.type,
        }).eq('id', doc.id).eq('user_id', user.id);
        if (updateErr) throw new Error(`Database: ${updateErr.message}`);
      } else {
        const { error: insertErr } = await supabase.from('borrower_documents').insert({
          user_id: user.id, application_id: applicationId,
          document_name: req.name, document_type: req.type, compliance_type: req.type,
          category: 'legal', file_url: filePath, file_name: file.name, file_size: file.size,
          mime_type: file.type, doc_status: 'uploaded', uploaded_at: new Date().toISOString(),
        });
        if (insertErr) throw new Error(`Database: ${insertErr.message}`);
      }

      setProgress(100);
      showToast(`${req.name} uploaded successfully.`, 'success');
      onUploaded();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[DocUpload] Upload failed:', message);
      if (message.includes('row-level security') || message.includes('policy')) {
        showToast('Permission denied. Please refresh and try again.', 'error');
      } else if (message.includes('Storage')) {
        showToast(`File upload failed: ${message.replace('Storage: ', '')}`, 'error');
      } else if (message.includes('Database')) {
        showToast(`Could not save document record: ${message.replace('Database: ', '')}`, 'error');
      } else {
        showToast('Upload failed. Please try again.', 'error');
      }
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  const statusCfg = doc ? (DOC_STATUS_CONFIG[doc.doc_status] ?? DOC_STATUS_CONFIG.pending) : DOC_STATUS_CONFIG.pending;
  const needsAction = doc?.doc_status === 'resubmit_requested' || doc?.doc_status === 'rejected' || !doc;
  const isApproved = doc?.doc_status === 'approved';

  return (
    <div className={`rounded-xl border transition-all ${needsAction && !isApproved ? `${req.border} ${req.bg}` : 'border-gray-100 bg-white'}`}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isApproved ? 'bg-emerald-100' : req.bg} border ${isApproved ? 'border-emerald-200' : req.border}`}>
            <Icon name={isApproved ? 'CheckCircleIcon' : req.icon as Parameters<typeof Icon>[0]['name']} size={17} className={isApproved ? 'text-emerald-600' : req.color} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-0.5">
              <p className="font-display font-700 text-gray-900 text-sm">{req.name}</p>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-display font-700 border ${statusCfg.color} ${statusCfg.bg} ${statusCfg.border}`}>
                <Icon name={statusCfg.icon as Parameters<typeof Icon>[0]['name']} size={9} />
                {statusCfg.label}
              </span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">{req.description}</p>

            {/* Resubmit reason */}
            {doc?.resubmit_reason && (
              <div className="mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-xs text-amber-700 font-display font-600">Reason: {doc.resubmit_reason}</p>
              </div>
            )}
            {doc?.admin_notes && doc.doc_status === 'rejected' && (
              <div className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-xs text-red-700 font-display font-600">Admin note: {doc.admin_notes}</p>
              </div>
            )}

            {/* Uploaded file info */}
            {doc?.file_name && (
              <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                <Icon name="PaperClipIcon" size={12} className="text-gray-400" />
                <span className="truncate max-w-[200px]">{doc.file_name}</span>
                {doc.file_size && <span className="text-gray-400 flex-shrink-0">({formatBytes(doc.file_size)})</span>}
                {doc.uploaded_at && <span className="text-gray-400 flex-shrink-0">{timeAgo(doc.uploaded_at)}</span>}
              </div>
            )}
          </div>

          {/* Upload button */}
          {!isApproved && (
            <div className="flex-shrink-0">
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-display font-700 rounded-lg border transition-all ${
                  uploading
                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                    : `${req.bg} ${req.color} ${req.border} hover:opacity-80`
                }`}
              >
                {uploading ? (
                  <><Icon name="ArrowPathIcon" size={12} className="animate-spin" /> Uploading…</>
                ) : doc?.file_name ? (
                  <><Icon name="ArrowUpTrayIcon" size={12} /> Replace</>
                ) : (
                  <><Icon name="ArrowUpTrayIcon" size={12} /> Upload</>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Upload progress */}
        {uploading && (
          <div className="mt-3">
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-eb-green-600 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-[10px] text-gray-400 mt-1">{progress}% uploaded</p>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div className={`mt-2 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-600 ${toast.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
            <Icon name={toast.type === 'success' ? 'CheckCircleIcon' : 'ExclamationCircleIcon'} size={13} />
            {toast.msg}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DealDetailsContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [optionCycle, setOptionCycle] = useState<PortalOptionCycle | null>(null);
  const [etNow, setEtNow] = useState<{ ymd: string; minutes: number } | null>(null);
  const [accessMode, setAccessMode] = useState<'owner' | 'contact' | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminFeedback, setAdminFeedback] = useState<AdminFeedback[]>([]);
  const [docs, setDocs] = useState<BorrowerDoc[]>([]);
  const [liveStatus, setLiveStatus] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'documents' | 'invoices' | 'feedback' | 'activity'>('overview');
  const [activityEvents, setActivityEvents] = useState<Array<{ id: string; title: string; detail: string | null; actor: string; event_type: string; created_at: string }>>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);

  // ── Invoice state ──────────────────────────────────────────────────────────
  const [invoices, setInvoices] = useState<PortalInvoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState(false);
  // Prevent duplicate fetches during the same mounted session
  const invoicesFetchedRef = useRef(false);
  // Monotonic request counter: ignores responses from superseded Deal fetches
  const dealRequestRef = useRef(0);
  // Always points at the latest background re-fetch (no effect dependency loops)
  const refetchDealRef = useRef<() => void>(() => {});

  const fetchDeal = useCallback(async (background: boolean = false) => {
    if (!user || !id) { if (!background) setLoading(false); return; }
    const requestId = ++dealRequestRef.current;
    try {
      const res = await fetch(`/api/portal/deals/${id}`, { cache: 'no-store' });
      if (requestId !== dealRequestRef.current) return;
      if (!res.ok) { router.push('/deals'); return; }
      const json = await res.json();
      if (requestId !== dealRequestRef.current) return;
      if (!json || !json.deal || (json.access_mode !== 'owner' && json.access_mode !== 'contact')) {
        router.push('/deals');
        return;
      }
      setAccessMode(json.access_mode as 'owner' | 'contact');
      setDeal(json.deal as Deal);
      setOptionCycle((json.option_cycle as PortalOptionCycle | null) ?? null);
      setLoading(false);
    } catch {
      if (requestId !== dealRequestRef.current) return;
      router.push('/deals');
    }
  }, [user, id, router]);

  const fetchFeedback = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('application_feedback')
      .select('*')
      .eq('application_id', id)
      .order('created_at', { ascending: false });
    if (data) setAdminFeedback(data);
  }, [id, supabase]);

  const fetchDocs = useCallback(async () => {
    if (!user || !id) return;
    const { data } = await supabase
      .from('borrower_documents')
      .select('*')
      .eq('user_id', user.id)
      .eq('application_id', id)
      .in('document_type', ['w9', 'psa', 'mou'])
      .order('created_at', { ascending: false });
    if (data) setDocs(data as BorrowerDoc[]);
  }, [user, id, supabase]);

  const fetchActivity = useCallback(async () => {
    if (!id) return;
    setLoadingActivity(true);
    const { data } = await supabase
      .from('application_activity')
      .select('id, title, detail, actor, event_type, created_at')
      .eq('application_id', id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (data) setActivityEvents(data);
    setLoadingActivity(false);
  }, [id, supabase]);

  // ── Fetch invoices from secure portal API ──────────────────────────────────
  // Fetches only when the Invoices tab is first opened.
  // Uses no-store to prevent caching of financial metadata.
  // Does NOT send user ID, Contact ID, or authorization data — the server
  // derives authorization from the authenticated session cookie.
  const fetchInvoices = useCallback(async () => {
    if (!id || invoicesFetchedRef.current) return;
    invoicesFetchedRef.current = true;
    setInvoicesLoading(true);
    setInvoicesError(false);
    try {
      const res = await fetch(`/api/portal/deals/${id}/invoices`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        setInvoicesError(true);
        return;
      }
      const json = await res.json();
      if (!json || !Array.isArray(json.invoices)) {
        setInvoicesError(true);
        return;
      }
      setInvoices(json.invoices as PortalInvoice[]);
    } catch {
      setInvoicesError(true);
    } finally {
      setInvoicesLoading(false);
    }
  }, [id]);

  const retryInvoices = useCallback(() => {
    invoicesFetchedRef.current = false;
    fetchInvoices();
  }, [fetchInvoices]);

  // Clear all prior-Deal state whenever the route id changes, before the new
  // Deal is rendered, so stale content / owner-only tabs never carry across.
  // Declared BEFORE the load effect so it runs first on mount / id change.
  useEffect(() => {
    dealRequestRef.current += 1;
    setDeal(null);
    setAccessMode(null);
    setActiveTab('overview');
    setLoading(true);
    setAdminFeedback([]);
    setDocs([]);
    setActivityEvents([]);
    setInvoices([]);
    setInvoicesError(false);
    setLiveStatus(false);
    invoicesFetchedRef.current = false;
  }, [id]);

  useEffect(() => {
    if (!authLoading) fetchDeal();
  }, [fetchDeal, authLoading]);

  useEffect(() => {
    refetchDealRef.current = () => { fetchDeal(true); };
  }, [fetchDeal]);

  useEffect(() => {
    if (deal && accessMode === 'owner') { fetchFeedback(); fetchDocs(); }
  }, [deal, accessMode, fetchFeedback, fetchDocs]);

  useEffect(() => {
    if (activeTab === 'activity' && deal && accessMode === 'owner') fetchActivity();
  }, [activeTab, deal, accessMode, fetchActivity]);

  useEffect(() => {
    if (activeTab === 'invoices' && deal) fetchInvoices();
  }, [activeTab, deal, fetchInvoices]);

  // Current ET date/time (client-only, avoids hydration mismatch). Refreshes about
  // once per minute so the deadline state updates across 5:00 PM ET and midnight ET
  // while the page stays open. Local state only — no API calls.
  useEffect(() => {
    const tick = () => setEtNow(getEtNow());
    tick();
    const timerId = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timerId);
  }, []);

  // Real-time deal status updates (owner access only; contact-only users use the
  // server-loaded snapshot because the Realtime stream is owner-RLS scoped).
  // The Realtime payload is used ONLY as a change signal — the Deal is re-fetched
  // through the authorized server endpoint so the response allow-list is preserved.
  useEffect(() => {
    if (!user || !id || accessMode !== 'owner') return;
    const channel = supabase
      .channel(`deal-detail-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'borrower_applications', filter: `id=eq.${id}` }, () => {
        setLiveStatus(true);
        setTimeout(() => setLiveStatus(false), 3000);
        refetchDealRef.current();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, id, supabase, accessMode]);

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Icon name="ArrowPathIcon" size={24} className="animate-spin text-eb-green-600" />
        <span className="ml-3 text-sm text-gray-500">Loading deal…</span>
      </div>
    );
  }

  if (!deal) return null;

  const baseCfg = STATUS_CONFIG[deal.app_status] ?? STATUS_CONFIG.approved;
  // A missed Option Cycle (deadline_not_met) drives the "Deadline Not Met" presentation,
  // independent of Deal status.
  const cfg =
    optionCycle?.client_status === 'deadline_not_met'
      ? { ...baseCfg, label: 'Deadline Not Met', description: DEADLINE_NOT_MET_DESCRIPTION }
      : baseCfg;
  const dealLabel = deal.company_name || deal.property_address || `Deal ${deal.id.slice(0, 6)}`;

  const isOwner = accessMode === 'owner';
  const actionRequiredFeedback = adminFeedback.filter(f => f.feedback_type === 'action_required');
  const pendingDocs = REQUIRED_DOCS.filter(r => {
    const d = docs.find(doc => doc.document_type === r.type || doc.compliance_type === r.type);
    return !d || d.doc_status === 'resubmit_requested' || d.doc_status === 'rejected';
  });

  const allTabs = [
    { key: 'overview',   label: 'Overview',   icon: 'Squares2X2Icon' },
    { key: 'documents',  label: 'Documents',  icon: 'FolderOpenIcon',  badge: pendingDocs.length },
    { key: 'invoices',   label: 'Invoices',   icon: 'DocumentTextIcon' },
    { key: 'feedback',   label: 'Feedback',   icon: 'ChatBubbleLeftEllipsisIcon', badge: actionRequiredFeedback.length },
    { key: 'activity',   label: 'Activity',   icon: 'ClockIcon' },
  ] as const;
  // Contact-only users see Overview + Invoices only (owner-only tabs hidden).
  const tabs = isOwner
    ? allTabs
    : allTabs.filter(t => t.key === 'overview' || t.key === 'invoices');

  const EVENT_TYPE_ICONS: Record<string, { icon: string; color: string }> = {
    status_change:   { icon: 'ArrowPathIcon',              color: 'text-indigo-500 bg-indigo-50' },
    document_upload: { icon: 'ArrowUpTrayIcon',            color: 'text-blue-500 bg-blue-50' },
    admin_note:      { icon: 'ChatBubbleLeftEllipsisIcon', color: 'text-violet-500 bg-violet-50' },
    deadline_shift:  { icon: 'CalendarDaysIcon',           color: 'text-orange-500 bg-orange-50' },
    system:          { icon: 'InformationCircleIcon',      color: 'text-gray-400 bg-gray-50' },
  };

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Back nav */}
      <div className="flex items-center gap-2">
        <Link href="/deals" className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-eb-green-900 transition-colors">
          <Icon name="ChevronLeftIcon" size={14} />
          Back to My Deals
        </Link>
      </div>

      {/* Header card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-eb-green-900 flex items-center justify-center flex-shrink-0">
            <Icon name="BuildingOffice2Icon" size={22} className="text-eb-gold-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h1 className="font-display text-xl font-700 text-gray-900">{dealLabel}</h1>
              {liveStatus && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-display font-600 animate-pulse">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full inline-block" />
                  Updated
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
              {deal.property_address && (
                <span className="flex items-center gap-1">
                  <Icon name="MapPinIcon" size={13} className="text-gray-400" />
                  {deal.property_address}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Icon name="HashtagIcon" size={13} className="text-gray-400" />
                EB-{deal.id.slice(0, 8).toUpperCase()}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-display font-700 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
              <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={12} />
              {cfg.label}
            </span>
          </div>
        </div>

        {/* Key metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t border-gray-100">
          <div>
            <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Purchase Price</p>
            <p className="text-sm font-700 text-gray-900 tabular-nums">{formatCurrency(deal.purchase_price)}</p>
          </div>
          <div>
            <p className={`text-[11px] font-display font-600 uppercase tracking-wide mb-1 ${getDynamicEmd(deal).isFunded ? 'text-eb-green-700' : 'text-amber-700'}`}>{getDynamicEmd(deal).label}</p>
            <p className={`text-sm font-700 tabular-nums ${getDynamicEmd(deal).isFunded ? 'text-eb-green-900' : 'text-amber-800'}`}>{getDynamicEmd(deal).value}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Due Diligence Period</p>
            <p className="text-sm font-700 tabular-nums text-gray-900">
              {deal.due_diligence_days != null ? `${deal.due_diligence_days} ${deal.due_diligence_days === 1 ? 'Day' : 'Days'}` : '—'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Property Type</p>
            <p className="text-sm font-700 text-gray-900">{deal.property_type || '—'}</p>
          </div>
        </div>
      </div>

      {/* Action required banner */}
      {isOwner && (actionRequiredFeedback.length > 0 || pendingDocs.length > 0) && (
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
          <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
            <Icon name="ExclamationTriangleIcon" size={18} className="text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-display font-700 text-amber-800 text-sm">Action Required</p>
            <ul className="mt-1 space-y-0.5">
              {actionRequiredFeedback.length > 0 && (
                <li className="text-xs text-amber-700">
                  {actionRequiredFeedback.length} admin message{actionRequiredFeedback.length > 1 ? 's' : ''} require{actionRequiredFeedback.length === 1 ? 's' : ''} your attention
                </li>
              )}
              {pendingDocs.length > 0 && (
                <li className="text-xs text-amber-700">
                  {pendingDocs.length} document{pendingDocs.length > 1 ? 's' : ''} pending: {pendingDocs.map(d => d.name).join(', ')}
                </li>
              )}
            </ul>
          </div>
          {actionRequiredFeedback.length > 0 ? (
            <button
              onClick={() => setActiveTab('feedback')}
              className="flex items-center gap-1 text-xs font-display font-700 text-amber-700 hover:text-amber-900 transition-colors flex-shrink-0"
            >
              View <Icon name="ArrowRightIcon" size={12} />
            </button>
          ) : (
            <Link
              href="/documents"
              className="flex items-center gap-1 text-xs font-display font-700 text-amber-700 hover:text-amber-900 transition-colors flex-shrink-0"
            >
              View <Icon name="ArrowRightIcon" size={12} />
            </Link>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-display font-700 transition-all ${
              activeTab === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon name={tab.icon as Parameters<typeof Icon>[0]['name']} size={13} />
            <span className="hidden sm:inline">{tab.label}</span>
            {'badge' in tab && tab.badge > 0 && (
              <span className="bg-amber-500 text-white text-[9px] font-700 px-1.5 py-0.5 rounded-full min-w-[16px] text-center leading-none">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* Status card */}
          <div className={`rounded-2xl border p-5 ${cfg.bg} ${cfg.border}`}>
            <div className="flex items-start gap-3">
              <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={20} className={`flex-shrink-0 mt-0.5 ${cfg.color}`} />
              <div>
                <p className="font-display font-700 text-gray-900 text-sm">{cfg.label}</p>
                <p className="text-sm text-gray-600 mt-0.5">{cfg.description}</p>
              </div>
            </div>
          </div>

          {/* Funding & Option — shown to owner and approved contact when an active cycle exists */}
          {optionCycle && (() => {
            const statusUi = OPTION_STATUS_UI[optionCycle.client_status] ?? OPTION_STATUS_UI.action_required;
            const exercised = optionCycle.client_status === 'option_exercised';
            const missed = optionCycle.client_status === 'deadline_not_met';
            const rawDaysLeft = etNow ? calendarDaysBetween(etNow.ymd, optionCycle.option_exercise_deadline) : null;
            // On the deadline date itself, at/after 5:00 PM ET the deadline has passed.
            const daysLeft =
              rawDaysLeft === 0 && etNow && etNow.minutes >= OPTION_CUTOFF_MINUTES_ET ? -1 : rawDaysLeft;
            const showUrgency = !exercised && !missed && daysLeft !== null && daysLeft <= 7;
            const countdown =
              exercised || missed || daysLeft === null
                ? null
                : daysLeft > 1
                  ? `${daysLeft} days remaining`
                  : daysLeft === 1
                    ? '1 day remaining'
                    : daysLeft === 0
                      ? 'Due today — 5:00 PM ET' :'Deadline passed';
            const urgent = !exercised && !missed && daysLeft !== null && daysLeft <= 0;
            return (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Icon name="ClockIcon" size={15} className="text-gray-500" />
                  <h3 className="font-display font-700 text-gray-900 text-sm">Funding &amp; Option</h3>
                  <span className={`ml-auto inline-flex items-center px-2.5 py-1 rounded-full border text-[11px] font-display font-700 ${statusUi.chip}`}>
                    {statusUi.label}
                  </span>
                </div>

                <div
                  className={`rounded-xl border p-4 ${
                    missed
                      ? 'bg-gray-50 border-gray-200'
                      : exercised
                      ? 'bg-emerald-50 border-emerald-200'
                      : urgent
                        ? 'bg-red-50 border-red-200'
                        : showUrgency
                          ? 'bg-amber-50 border-amber-200' :'bg-indigo-50 border-indigo-200'
                  }`}
                >
                  <p className="text-[11px] text-gray-500 font-display font-700 uppercase tracking-wide mb-1">Option Exercise Deadline</p>
                  <p className="text-xl font-display font-800 tabular-nums text-gray-900">
                    {formatDateSafe(optionCycle.option_exercise_deadline)}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">Cutoff: 5:00 PM ET</p>
                  {countdown && (
                    <p className={`text-sm font-display font-700 mt-2 ${urgent ? 'text-red-700' : showUrgency ? 'text-amber-700' : 'text-indigo-700'}`}>
                      {countdown}
                    </p>
                  )}
                </div>

                <p className="text-sm text-gray-600 mt-3">{statusUi.guidance}</p>

                {!missed && (
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Deposit Goes Hard</p>
                    <p className="text-sm font-600 tabular-nums text-gray-700">{formatDateSafe(optionCycle.deposit_goes_hard_date)}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Deal details */}
          {(deal.llc_name || deal.transaction_description) && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <Icon name="BuildingOfficeIcon" size={15} className="text-gray-500" />
                <h3 className="font-display font-700 text-gray-900 text-sm">Deal Details</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {deal.llc_name && (
                  <div>
                    <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">LLC Name</p>
                    <p className="text-sm font-600 text-gray-800">{deal.llc_name}</p>
                  </div>
                )}
                {deal.llc_state && (
                  <div>
                    <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">LLC State</p>
                    <p className="text-sm font-600 text-gray-800">{deal.llc_state}</p>
                  </div>
                )}
                {deal.transaction_description && (
                  <div className="sm:col-span-2">
                    <p className="text-[11px] text-gray-400 font-display font-600 uppercase tracking-wide mb-1">Transaction Description</p>
                    <p className="text-sm text-gray-700 leading-relaxed">{deal.transaction_description}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Funding conditions — shown for ALL deals */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-4">
              <Icon name="ShieldCheckIcon" size={15} className="text-gray-500" />
              <h3 className="font-display font-700 text-gray-900 text-sm">Funding Conditions</h3>
              <span className="ml-auto text-xs text-gray-400">All must be met before funds are released</span>
            </div>
            <div className="space-y-2">
              {[
                { key: 'w9_signed',               label: 'W-9 Signed',               icon: 'DocumentCheckIcon' },
                { key: 'mou_signed',              label: 'MOU Signed',               icon: 'PencilSquareIcon' },
                { key: 'option_agreement_signed', label: 'Option Agreement Signed',  icon: 'ClipboardDocumentCheckIcon' },
                { key: 'llc_formed',              label: 'LLC Formed',               icon: 'BuildingOfficeIcon' },
                { key: 'psa_signed',              label: 'PSA Signed',               icon: 'DocumentTextIcon' },
              ].map(c => {
                const met = !!(deal as Record<string, unknown>)[c.key];
                return (
                  <div key={c.key} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${met ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-gray-100'}`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${met ? 'bg-emerald-500' : 'bg-gray-200'}`}>
                      <Icon name={met ? 'CheckIcon' : c.icon as Parameters<typeof Icon>[0]['name']} size={13} className={met ? 'text-white' : 'text-gray-400'} />
                    </div>
                    <span className={`text-sm font-display font-600 ${met ? 'text-emerald-700' : 'text-gray-500'}`}>{c.label}</span>
                    <span className={`ml-auto text-xs font-display font-700 ${met ? 'text-emerald-600' : 'text-gray-400'}`}>{met ? 'Complete' : 'Pending'}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick actions */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-4">
              <Icon name="BoltIcon" size={15} className="text-gray-500" />
              <h3 className="font-display font-700 text-gray-900 text-sm">Quick Actions</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {isOwner && (
              <button
                onClick={() => setActiveTab('documents')}
                className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 hover:border-eb-green-200 hover:bg-eb-green-50 transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center group-hover:bg-blue-100 transition-colors">
                  <Icon name="ArrowUpTrayIcon" size={17} className="text-blue-600" />
                </div>
                <span className="text-xs font-display font-700 text-gray-700 text-center">Upload Documents</span>
              </button>
              )}
              {isOwner && (
              <button
                onClick={() => setActiveTab('feedback')}
                className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 hover:border-eb-green-200 hover:bg-eb-green-50 transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-violet-50 flex items-center justify-center group-hover:bg-violet-100 transition-colors">
                  <Icon name="ChatBubbleLeftEllipsisIcon" size={17} className="text-violet-600" />
                </div>
                <span className="text-xs font-display font-700 text-gray-700 text-center">View Feedback</span>
              </button>
              )}
              <Link
                href="/deadlines"
                className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 hover:border-eb-green-200 hover:bg-eb-green-50 transition-all group"
              >
                <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center group-hover:bg-amber-100 transition-colors">
                  <Icon name="CalendarDaysIcon" size={17} className="text-amber-600" />
                </div>
                <span className="text-xs font-display font-700 text-gray-700 text-center">Deadlines</span>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Documents */}
      {isOwner && activeTab === 'documents' && (
        <div className="space-y-4">
          {/* Document status summary */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-1">
              <Icon name="FolderOpenIcon" size={15} className="text-gray-500" />
              <h3 className="font-display font-700 text-gray-900 text-sm">Document Status</h3>
            </div>
            <p className="text-xs text-gray-400 mb-4">Current status of required documents for this deal.</p>
            <div className="space-y-2">
              {REQUIRED_DOCS.map(req => {
                const doc = docs.find(d => d.document_type === req.type || d.compliance_type === req.type);
                const statusCfg = doc ? (DOC_STATUS_CONFIG[doc.doc_status] ?? DOC_STATUS_CONFIG.pending) : DOC_STATUS_CONFIG.pending;
                return (
                  <div key={req.type} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${doc?.doc_status === 'approved' ? 'bg-emerald-500' : 'bg-gray-100'}`}>
                      <Icon name={doc?.doc_status === 'approved' ? 'CheckIcon' : 'MinusIcon'} size={10} className={doc?.doc_status === 'approved' ? 'text-white' : 'text-gray-400'} />
                    </div>
                    <span className="flex-1 text-sm text-gray-700">{req.name}</span>
                    <span className={`text-[10px] font-display font-700 px-2 py-0.5 rounded-full border ${statusCfg.color} ${statusCfg.bg} ${statusCfg.border}`}>
                      {statusCfg.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* CTA to unified Documents experience */}
          <div className="bg-eb-green-50 border border-eb-green-200 rounded-2xl p-5">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-eb-green-900 flex items-center justify-center flex-shrink-0">
                <Icon name="ArrowUpTrayIcon" size={18} className="text-eb-gold-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display font-700 text-eb-green-900 text-sm">Upload &amp; Manage Documents</p>
                <p className="text-xs text-eb-green-700 mt-0.5">Upload new documents, respond to revision requests, and view your full document history in one place.</p>
              </div>
              <Link
                href="/documents"
                className="flex items-center gap-1.5 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-lg hover:bg-eb-green-800 transition-colors whitespace-nowrap flex-shrink-0"
              >
                Go to Documents
                <Icon name="ArrowRightIcon" size={12} />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Invoices */}
      {activeTab === 'invoices' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-1">
            <Icon name="DocumentTextIcon" size={15} className="text-gray-500" />
            <h3 className="font-display font-700 text-gray-900 text-sm">Invoices</h3>
          </div>
          <p className="text-xs text-gray-400 mb-5">View and download invoices issued for this deal.</p>

          {/* Loading state */}
          {invoicesLoading && (
            <div className="flex items-center gap-2 py-10 justify-center">
              <Icon name="ArrowPathIcon" size={16} className="animate-spin text-gray-400" />
              <span className="text-sm text-gray-400">Loading invoices…</span>
            </div>
          )}

          {/* Error state */}
          {!invoicesLoading && invoicesError && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mb-3">
                <Icon name="ExclamationCircleIcon" size={22} className="text-red-400" />
              </div>
              <p className="font-display font-600 text-gray-700 text-sm">Unable to load invoices. Please try again.</p>
              <button
                onClick={retryInvoices}
                className="mt-3 flex items-center gap-1.5 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-lg hover:bg-eb-green-800 transition-colors"
              >
                <Icon name="ArrowPathIcon" size={12} />
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!invoicesLoading && !invoicesError && invoices.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center mb-3">
                <Icon name="DocumentTextIcon" size={22} className="text-gray-300" />
              </div>
              <p className="font-display font-600 text-gray-700 text-sm">No invoices have been issued for this deal yet.</p>
            </div>
          )}

          {/* Invoice list */}
          {!invoicesLoading && !invoicesError && invoices.length > 0 && (
            <div className="space-y-3">
              {invoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className="rounded-xl border border-gray-100 bg-gray-50 p-4"
                >
                  {/* Invoice header row */}
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <span className="font-display font-700 text-gray-900 text-sm tabular-nums">
                      {invoice.invoice_number}
                    </span>
                    {invoice.is_revision && (
                      <span className="text-[10px] font-display font-600 px-2 py-0.5 rounded-full bg-violet-50 border border-violet-200 text-violet-700">
                        Revision
                      </span>
                    )}
                    <span className={`text-[10px] font-display font-700 px-2 py-0.5 rounded-full border ${invoiceStatusStyle(invoice.status)}`}>
                      {invoiceStatusLabel(invoice.status)}
                    </span>
                  </div>

                  {/* Invoice metadata grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                    <div>
                      <p className="text-[10px] text-gray-400 font-display font-600 uppercase tracking-wide mb-0.5">Issued</p>
                      <p className="text-xs font-600 text-gray-800 tabular-nums">{formatDateSafe(invoice.issued_at)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 font-display font-600 uppercase tracking-wide mb-0.5">Due</p>
                      <p className="text-xs font-600 text-gray-800 tabular-nums">
                        {invoice.due_date ? formatDateSafe(invoice.due_date) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 font-display font-600 uppercase tracking-wide mb-0.5">Amount</p>
                      <p className="text-xs font-700 text-gray-900 tabular-nums">
                        {formatInvoiceAmount(invoice.total_cents, invoice.currency)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 font-display font-600 uppercase tracking-wide mb-0.5">Status</p>
                      <p className="text-xs font-600 text-gray-800">{invoiceStatusLabel(invoice.status)}</p>
                    </div>
                  </div>

                  {/* Payment breakdown — shown only for partially_paid and paid invoices */}
                  {(invoice.status === 'partially_paid' || invoice.status === 'paid') && (
                    <div className="mb-4 rounded-lg border border-gray-100 bg-white divide-y divide-gray-50">
                      <div className="flex justify-between items-center px-3 py-2">
                        <span className="text-[11px] text-gray-500 font-display font-600">Amount Paid</span>
                        <span className="text-[11px] text-emerald-700 font-display font-700 tabular-nums">
                          {formatInvoiceAmount(invoice.amount_paid_cents, invoice.currency)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-2">
                        <span className="text-[11px] text-gray-500 font-display font-600">Balance Remaining</span>
                        <span className="text-[11px] text-gray-900 font-display font-700 tabular-nums">
                          {formatInvoiceAmount(invoice.balance_remaining_cents, invoice.currency)}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap gap-2">
                    {/* View Invoice — opens PDF inline in a new tab */}
                    <a
                      href={`/api/portal/invoices/${invoice.id}/pdf?disposition=inline`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-lg hover:bg-eb-green-800 transition-colors"
                    >
                      <Icon name="EyeIcon" size={12} />
                      View Invoice
                    </a>
                    {/* Download PDF — triggers attachment download */}
                    <a
                      href={`/api/portal/invoices/${invoice.id}/pdf?disposition=attachment`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-2 bg-white text-eb-green-900 text-xs font-display font-700 rounded-lg border border-eb-green-200 hover:bg-eb-green-50 transition-colors"
                    >
                      <Icon name="ArrowDownTrayIcon" size={12} />
                      Download PDF
                    </a>
                    {/* Download Receipt — one link per completed receipt */}
                    {(invoice.receipts ?? []).map((receipt) => (
                      <a
                        key={receipt.payment_id}
                        href={`/api/portal/invoices/${invoice.id}/payment/${receipt.payment_id}/receipt?disposition=attachment`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-2 bg-white text-eb-green-900 text-xs font-display font-700 rounded-lg border border-eb-green-200 hover:bg-eb-green-50 transition-colors"
                      >
                        <Icon name="ArrowDownTrayIcon" size={12} />
                        {(invoice.receipts ?? []).length === 1
                          ? 'Download Receipt'
                          : `Download Receipt ${receipt.receipt_number}`}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Feedback */}
      {isOwner && activeTab === 'feedback' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-4">
            <Icon name="ChatBubbleLeftEllipsisIcon" size={15} className="text-gray-500" />
            <h3 className="font-display font-700 text-gray-900 text-sm">Admin Feedback & Actions</h3>
          </div>
          {adminFeedback.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center mb-3">
                <Icon name="CheckCircleIcon" size={22} className="text-emerald-400" />
              </div>
              <p className="font-display font-600 text-gray-700 text-sm">No feedback yet</p>
              <p className="text-xs text-gray-400 mt-1 max-w-xs">Our team will leave notes here if any action is required from you.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {adminFeedback.map(fb => {
                const fbCfg = FEEDBACK_TYPE_CONFIG[fb.feedback_type ?? 'general'] ?? FEEDBACK_TYPE_CONFIG.general;
                return (
                  <div key={fb.id} className={`flex items-start gap-3 p-4 rounded-xl border ${fbCfg.color}`}>
                    <Icon name={fbCfg.icon as Parameters<typeof Icon>[0]['name']} size={16} className="flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[11px] font-display font-700 uppercase tracking-wide opacity-70">{fbCfg.label}</span>
                        <span className="text-[11px] text-gray-400 whitespace-nowrap">{formatDate(fb.created_at)}</span>
                      </div>
                      <p className="text-sm leading-relaxed">{fb.message}</p>
                      {fb.admin_name && <p className="text-[11px] text-gray-400 mt-1.5">— {fb.admin_name}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab: Activity */}
      {isOwner && activeTab === 'activity' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-4">
            <Icon name="ClockIcon" size={15} className="text-gray-500" />
            <h3 className="font-display font-700 text-gray-900 text-sm">Activity History</h3>
            <span className="text-[10px] bg-eb-green-100 text-eb-green-800 px-1.5 py-0.5 rounded-full font-700">Live</span>
          </div>
          {loadingActivity ? (
            <div className="flex items-center gap-2 py-8 justify-center">
              <Icon name="ArrowPathIcon" size={16} className="animate-spin text-gray-400" />
              <span className="text-sm text-gray-400">Loading activity…</span>
            </div>
          ) : activityEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center mb-3">
                <Icon name="ClockIcon" size={22} className="text-gray-300" />
              </div>
              <p className="font-display font-600 text-gray-700 text-sm">No activity yet</p>
              <p className="text-xs text-gray-400 mt-1">Activity will appear here as your deal progresses.</p>
            </div>
          ) : (
            <div className="space-y-0">
              {activityEvents.map((event, idx) => {
                const evCfg = EVENT_TYPE_ICONS[event.event_type] ?? { icon: 'InformationCircleIcon', color: 'text-gray-400 bg-gray-50' };
                return (
                  <div key={event.id} className="flex gap-3 pb-4 relative">
                    {idx < activityEvents.length - 1 && (
                      <div className="absolute left-4 top-8 bottom-0 w-px bg-gray-100" />
                    )}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${evCfg.color}`}>
                      <Icon name={evCfg.icon as Parameters<typeof Icon>[0]['name']} size={14} />
                    </div>
                    <div className="flex-1 min-w-0 pt-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-display font-600 text-gray-900">{event.title}</p>
                        <span className="text-[10px] text-gray-400">{timeAgo(event.created_at)}</span>
                      </div>
                      {event.detail && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{event.detail}</p>}
                      <p className="text-[10px] text-gray-400 mt-1">by {event.actor}</p>
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
}
