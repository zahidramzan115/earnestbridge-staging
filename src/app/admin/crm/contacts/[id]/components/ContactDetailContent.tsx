'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import CreateDealModal from '@/app/admin/deals/components/CreateDealModal';
import EmailAttachmentPicker, { AttachmentDescriptor, cleanupAttachments } from '@/components/EmailAttachmentPicker';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  phone: string | null;
  job_title: string | null;
  website: string | null;
  lead_status: string;
  assigned_owner: string;
  lead_source: string | null;
  referral_source: string | null;
  estimated_deal_volume: number | null;
  estimated_emd_need: number | null;
  client_type: string | null;
  last_contacted_at: string | null;
  next_follow_up_at: string | null;
  notes: string | null;
  tags: string[];
  portal_user_id: string | null;
  portal_link_status: string;
  portal_linked_at: string | null;
  portal_approved_at: string | null;
  original_lead_source: string | null;
  original_campaign: string | null;
  latest_lead_source: string | null;
  latest_campaign: string | null;
  has_potential_duplicate: boolean;
  created_at: string;
  updated_at: string;
  crm_companies?: { id: string; company_name: string; website: string | null; phone: string | null; city: string | null; state: string | null } | null;
  crm_contact_emails?: { id: string; email: string; label: string; is_primary: boolean }[];
  crm_deal_contacts?: {
    id: string;
    role: string;
    borrower_applications: {
      id: string;
      user_id: string;
      first_name: string;
      last_name: string;
      property_address: string | null;
      property_type: string | null;
      purchase_price: number | null;
      deposit_amount: number | null;
      due_diligence_days?: number | null;
      app_status: string;
      created_at: string;
      submitted_at: string | null;
    };
  }[];
}

interface Activity {
  id: string;
  event_type: string;
  title: string;
  detail: string | null;
  actor: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  priority: string;
  task_status: string;
  assigned_to: string;
  created_at: string;
}

interface Submission {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  company_name: string | null;
  message: string | null;
  lead_source: string | null;
  utm_campaign: string | null;
  utm_source: string | null;
  promo_code: string | null;
  is_new_contact: boolean;
  submitted_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LEAD_STATUSES = [
  'New Lead', 'Contacted', 'Qualified', 'Deal Submitted',
  'Client', 'Nurture', 'Lost', 'Not Qualified',
];
const OWNERS = ['Dan', 'Tucker', 'Eric', 'Unassigned'];

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

const PORTAL_CONFIG: Record<string, { label: string; color: string; icon: string; badgeColor: string }> = {
  none:     { label: 'No Portal Account',       color: 'bg-gray-100 text-gray-500 border-gray-200',    icon: 'UserIcon',         badgeColor: 'bg-gray-100 text-gray-500 border-gray-200' },
  pending:  { label: 'Portal Access Pending',   color: 'bg-amber-100 text-amber-700 border-amber-200', icon: 'ClockIcon',        badgeColor: 'bg-amber-100 text-amber-700 border-amber-200' },
  approved: { label: 'Portal Account Active',   color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: 'CheckCircleIcon', badgeColor: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  rejected: { label: 'Portal Access Rejected',  color: 'bg-red-100 text-red-700 border-red-200',       icon: 'XCircleIcon',      badgeColor: 'bg-red-100 text-red-700 border-red-200' },
};

const DEAL_STATUS_COLORS: Record<string, string> = {
  application:  'bg-gray-100 text-gray-600',
  under_review: 'bg-amber-100 text-amber-700',
  approved:     'bg-green-100 text-green-700',
  in_progress:  'bg-blue-100 text-blue-700',
  funded:       'bg-emerald-100 text-emerald-700',
  closed:       'bg-gray-200 text-gray-700',
  rejected:     'bg-red-100 text-red-700',
};

const ACTIVITY_ICONS: Record<string, string> = {
  contact_created:           'UserPlusIcon',
  status_changed:            'ArrowPathIcon',
  owner_assigned:            'UserCircleIcon',
  portal_account_registered: 'ComputerDesktopIcon',
  portal_access_approved:    'CheckCircleIcon',
  repeat_inquiry:            'ArrowUturnLeftIcon',
  task_created:              'ClipboardDocumentListIcon',
  deal_created:              'BriefcaseIcon',
  admin_note:                'ChatBubbleLeftIcon',
  alternate_email_added:     'EnvelopeIcon',
  alternate_email_removed:   'EnvelopeIcon',
  contact_merged:            'ArrowsRightLeftIcon',
  email_sent:                'PaperAirplaneIcon',
  company_assigned:          'BuildingOfficeIcon',
  call_logged:               'PhoneIcon',
  default:                   'BoltIcon',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function formatDateTime(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatCurrency(v: number | null) {
  if (!v) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

// ─── Company Assignment Sub-Component ────────────────────────────────────────

function CompanyAssignSection({
  currentCompany,
  onAssign,
}: {
  currentCompany: { id: string; company_name: string } | null;
  onAssign: (companyId: string | null) => Promise<void>;
}) {
  const supabase = createClient();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<{ id: string; company_name: string }[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState('');
  const [similarCompanies, setSimilarCompanies] = useState<{ id: string; company_name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const searchCompanies = async (q: string) => {
    setSearch(q);
    if (q.length < 2) { setResults([]); return; }
    const { data } = await supabase.from('crm_companies').select('id, company_name').ilike('company_name', `%${q}%`).limit(8);
    setResults(data || []);
  };

  const checkSimilar = async (name: string) => {
    if (name.length < 3) { setSimilarCompanies([]); return; }
    const words = name.split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return;
    const { data } = await supabase.from('crm_companies').select('id, company_name').ilike('company_name', `%${words[0]}%`).limit(5);
    setSimilarCompanies((data || []).filter((c: { id: string; company_name: string }) => c.company_name.toLowerCase() !== name.toLowerCase()));
  };

  const handleAssign = async (companyId: string) => {
    setAssigning(true);
    await onAssign(companyId);
    setSearch('');
    setResults([]);
    setAssigning(false);
  };

  const handleCreateAndLink = async () => {
    if (!newCompanyName.trim()) return;
    setCreating(true);
    const { data } = await supabase.from('crm_companies').insert({ company_name: newCompanyName.trim(), assigned_owner: 'Unassigned' }).select('id').single();
    if (data) await onAssign(data.id);
    setShowCreate(false);
    setNewCompanyName('');
    setSimilarCompanies([]);
    setCreating(false);
  };

  return (
    <div className="border-t border-gray-100 pt-4">
      <div className="flex items-center justify-between mb-2">
        <label className="block text-xs font-600 text-gray-500">Company</label>
        {currentCompany && (
          <button onClick={() => onAssign(null)} className="text-xs text-red-500 hover:underline">Remove</button>
        )}
      </div>
      {currentCompany ? (
        <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
          <Icon name="BuildingOfficeIcon" size={14} className="text-gray-400" />
          <span className="text-sm font-600 text-gray-700">{currentCompany.company_name}</span>
          <span className="ml-auto text-xs text-gray-400">Linked</span>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <input type="text" placeholder="Search companies…" value={search} onChange={e => searchCompanies(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
            {results.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                {results.map(c => (
                  <button key={c.id} type="button" onClick={() => handleAssign(c.id)} disabled={assigning}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-eb-green-50 transition-colors flex items-center gap-2">
                    <Icon name="BuildingOfficeIcon" size={13} className="text-gray-400" />
                    {c.company_name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={() => { setShowCreate(!showCreate); setNewCompanyName(''); setSimilarCompanies([]); }}
            className="text-xs text-eb-green-700 font-600 hover:underline flex items-center gap-1">
            <Icon name="PlusIcon" size={12} />
            Create & Link New Company
          </button>
          {showCreate && (
            <div className="p-3 border border-dashed border-gray-200 rounded-lg space-y-2">
              <input type="text" placeholder="Company name…" value={newCompanyName}
                onChange={e => { setNewCompanyName(e.target.value); checkSimilar(e.target.value); }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
              {similarCompanies.length > 0 && (
                <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-xs font-600 text-amber-700 mb-1">⚠ Possible Existing Company</p>
                  {similarCompanies.map(c => (
                    <div key={c.id} className="flex items-center justify-between py-1">
                      <span className="text-xs text-amber-800">{c.company_name}</span>
                      <button type="button" onClick={() => handleAssign(c.id)} className="text-xs text-eb-green-700 font-600 hover:underline">Use Existing</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={handleCreateAndLink} disabled={!newCompanyName.trim() || creating}
                  className="px-3 py-1.5 text-xs font-600 bg-eb-green-700 text-white rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors">
                  {creating ? 'Creating…' : 'Create New Company'}
                </button>
                <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ContactDetailContent({ contactId }: { contactId: string }) {
  const supabase = createClient();
  const router = useRouter();

  const [contact, setContact] = useState<Contact | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'activity' | 'deals' | 'tasks' | 'submissions' | 'portal' | 'emails'>('overview');

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Contact>>({});
  const [saving, setSaving] = useState(false);

  // Note state
  const [noteText, setNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);

  // Task creation
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: '', due_date: '', priority: 'Normal', assigned_to: 'Unassigned' });

  // Alternate email state
  const [newEmail, setNewEmail] = useState('');
  const [newEmailLabel, setNewEmailLabel] = useState('alternate');
  const [addingEmail, setAddingEmail] = useState(false);
  const [emailError, setEmailError] = useState('');

  // Merge state
  const [showMerge, setShowMerge] = useState(false);
  const [mergeSearch, setMergeSearch] = useState('');
  const [mergeResults, setMergeResults] = useState<{ id: string; first_name: string; last_name: string; primary_email: string; lead_status: string }[]>([]);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');

  // Send email state
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailForm, setEmailForm] = useState({ to: '', subject: '', body: '' });
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailSendError, setEmailSendError] = useState<string | null>(null);
  // Attachment state
  const [emailAttachments, setEmailAttachments] = useState<AttachmentDescriptor[]>([]);
  const [attachmentsUploading, setAttachmentsUploading] = useState(false);
  const [attachmentPickerKey, setAttachmentPickerKey] = useState(0);

  // Create Deal modal state
  const [showCreateDeal, setShowCreateDeal] = useState(false);

  // Inline status/owner editing
  const [savingStatus, setSavingStatus] = useState(false);
  const [savingOwner, setSavingOwner] = useState(false);

  // Log Call modal
  const [showLogCall, setShowLogCall] = useState(false);
  const [callForm, setCallForm] = useState({
    direction: 'Outbound',
    note: '',
    outcome: '',
  });
  const [loggingCall, setLoggingCall] = useState(false);
  const [callLogged, setCallLogged] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: contactData } = await supabase
      .from('crm_contacts')
      .select(`
        *,
        crm_companies(id, company_name, website, phone, city, state),
        crm_contact_emails(id, email, label, is_primary),
        crm_deal_contacts(
          id, role,
          borrower_applications(
            id, user_id, first_name, last_name, property_address, property_type,
            purchase_price, deposit_amount, due_diligence_days, app_status, created_at, submitted_at
          )
        )
      `)
      .eq('id', contactId)
      .single();

    if (contactData) {
      setContact(contactData as Contact);
      setEditForm(contactData as Contact);
    }

    const results = await Promise.all([
      supabase.from('crm_activities').select('*').eq('contact_id', contactId).order('created_at', { ascending: false }).limit(100),
      supabase.from('crm_tasks').select('*').eq('contact_id', contactId).order('due_date', { ascending: true }),
      supabase.from('crm_contact_submissions').select('*').eq('contact_id', contactId).order('submitted_at', { ascending: false }),
    ]);

    setActivities((results[0].data as Activity[]) || []);
    setTasks((results[1].data as Task[]) || []);
    setSubmissions((results[2].data as Submission[]) || []);
    setLoading(false);
  }, [contactId, supabase]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!contact) return;
    setSaving(true);
    await supabase.from('crm_contacts').update({
      first_name: editForm.first_name,
      last_name: editForm.last_name,
      phone: editForm.phone,
      job_title: editForm.job_title,
      lead_status: editForm.lead_status,
      assigned_owner: editForm.assigned_owner,
      lead_source: editForm.lead_source,
      next_follow_up_at: editForm.next_follow_up_at || null,
      notes: editForm.notes,
      estimated_deal_volume: editForm.estimated_deal_volume,
      estimated_emd_need: editForm.estimated_emd_need,
      client_type: editForm.client_type,
      updated_at: new Date().toISOString(),
    }).eq('id', contact.id);
    await load();
    setEditing(false);
    setSaving(false);
  };

  // Inline status change — reuses PATCH API which logs activity
  const handleStatusChange = async (newStatus: string) => {
    if (!contact || newStatus === contact.lead_status) return;
    setSavingStatus(true);
    await fetch(`/api/crm/contacts/${contact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_status: newStatus }),
    });
    await load();
    setSavingStatus(false);
  };

  // Inline owner change — reuses PATCH API which logs activity
  const handleOwnerChange = async (newOwner: string) => {
    if (!contact || newOwner === contact.assigned_owner) return;
    setSavingOwner(true);
    await fetch(`/api/crm/contacts/${contact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_owner: newOwner }),
    });
    await load();
    setSavingOwner(false);
  };

  const handleAddNote = async () => {
    if (!noteText.trim() || !contact) return;
    setAddingNote(true);
    await supabase.from('crm_activities').insert({
      contact_id: contact.id,
      event_type: 'admin_note',
      title: 'Admin note added',
      detail: noteText.trim(),
      actor: 'Admin',
    });
    setNoteText('');
    setShowNoteModal(false);
    await load();
    setAddingNote(false);
  };

  const handlePortalAction = async (action: 'approved' | 'rejected') => {
    if (!contact) return;
    await supabase.from('crm_contacts').update({
      portal_link_status: action,
      portal_approved_at: action === 'approved' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('id', contact.id);
    await load();
  };

  const handleCreateTask = async () => {
    if (!taskForm.title.trim() || !contact) return;
    await supabase.from('crm_tasks').insert({
      title: taskForm.title,
      contact_id: contact.id,
      due_date: taskForm.due_date || null,
      priority: taskForm.priority,
      assigned_to: taskForm.assigned_to,
      task_status: 'Open',
    });
    setTaskForm({ title: '', due_date: '', priority: 'Normal', assigned_to: 'Unassigned' });
    setShowTaskForm(false);
    await load();
  };

  // ── Alternate Email Handlers ──────────────────────────────────────────────

  const handleAddEmail = async () => {
    if (!newEmail.trim() || !contact) return;
    setAddingEmail(true);
    setEmailError('');
    const res = await fetch(`/api/crm/contacts/${contact.id}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail.trim(), label: newEmailLabel }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEmailError(data.error || 'Failed to add email');
    } else {
      setNewEmail('');
      await load();
    }
    setAddingEmail(false);
  };

  const handleRemoveEmail = async (emailId: string) => {
    if (!contact) return;
    await fetch(`/api/crm/contacts/${contact.id}/emails?email_id=${emailId}`, { method: 'DELETE' });
    await load();
  };

  const handleSetPrimaryEmail = async (emailId: string) => {
    if (!contact) return;
    await fetch(`/api/crm/contacts/${contact.id}/emails`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email_id: emailId }),
    });
    await load();
  };

  // ── Merge Handlers ────────────────────────────────────────────────────────

  const handleMergeSearch = async (q: string) => {
    setMergeSearch(q);
    if (q.length < 2) { setMergeResults([]); return; }
    const { data } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, lead_status')
      .eq('is_merged', false)
      .neq('id', contactId)
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,primary_email.ilike.%${q}%`)
      .limit(8);
    setMergeResults(data || []);
  };

  const handleMerge = async () => {
    if (!mergeTarget || !contact) return;
    setMerging(true);
    setMergeError('');
    const res = await fetch('/api/crm/contacts/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: mergeTarget, source_id: contact.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMergeError(data.error || 'Merge failed');
      setMerging(false);
    } else {
      router.push(`/admin/crm/contacts/${mergeTarget}`);
    }
  };

  // ── Send Email Handler ────────────────────────────────────────────────────

  const handleSendEmail = async () => {
    if (!emailForm.to || !emailForm.subject || !emailForm.body || !contact) return;
    if (attachmentsUploading) return;
    setSendingEmail(true);
    setEmailSendError(null);
    const payload: Record<string, unknown> = {
      to: emailForm.to,
      subject: emailForm.subject,
      body: emailForm.body,
    };
    if (emailAttachments.length > 0) {
      payload.attachments = emailAttachments;
    }
    const res = await fetch(`/api/crm/contacts/${contact.id}/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      // On success: clear attachment state, do NOT delete storage objects (they are now audit records)
      setEmailSent(true);
      setEmailForm({ to: '', subject: '', body: '' });
      setEmailAttachments([]);
      setAttachmentPickerKey(k => k + 1);
      setShowEmailForm(false);
      await load();
    } else {
      // Do NOT close the form or clear subject/body on failure
      let errorMsg = 'Email could not be sent. Please try again.';
      let responseBody: Record<string, unknown> = {};
      try {
        responseBody = await res.json();
        if (responseBody?.error && typeof responseBody.error === 'string') {
          errorMsg = responseBody.error;
        }
      } catch { /* ignore parse error */ }

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
    setSendingEmail(false);
  };

  // ── Close/Cancel email composer with cleanup ──────────────────────────────

  const handleCloseEmailForm = async () => {
    // Best-effort cleanup of any uploaded-but-unsent attachments
    if (emailAttachments.length > 0 && contact) {
      await cleanupAttachments(contact.id, emailAttachments);
    }
    setEmailAttachments([]);
    setAttachmentPickerKey(k => k + 1);
    setShowEmailForm(false);
    setEmailSendError(null);
  };

  // ── Log Call Handler ──────────────────────────────────────────────────────

  const handleLogCall = async () => {
    if (!contact) return;
    setLoggingCall(true);
    const detail = [
      `Direction: ${callForm.direction}`,
      callForm.outcome ? `Outcome: ${callForm.outcome}` : null,
      callForm.note ? callForm.note : null,
    ].filter(Boolean).join(' · ');

    await supabase.from('crm_activities').insert({
      contact_id: contact.id,
      event_type: 'call_logged',
      title: `${callForm.direction} call logged`,
      detail: detail || null,
      actor: 'Admin',
      metadata: {
        direction: callForm.direction,
        outcome: callForm.outcome || null,
        note: callForm.note || null,
      },
    });
    setCallForm({ direction: 'Outbound', note: '', outcome: '' });
    setShowLogCall(false);
    setCallLogged(true);
    await load();
    setLoggingCall(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-7 h-7 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Icon name="ExclamationCircleIcon" size={32} className="text-gray-300" />
        <p className="text-gray-500">Contact not found</p>
        <Link href="/admin/crm/contacts" className="text-sm text-eb-green-700 hover:underline">← Back to Contacts</Link>
      </div>
    );
  }

  const portalCfg = PORTAL_CONFIG[contact.portal_link_status] || PORTAL_CONFIG.none;
  const deals = contact.crm_deal_contacts || [];
  const altEmails = contact.crm_contact_emails || [];
  const company = contact.crm_companies as { id: string; company_name: string } | null | undefined;

  const TABS = [
    { key: 'overview',    label: 'Overview' },
    { key: 'activity',    label: `Activity (${activities.length})` },
    { key: 'deals',       label: `Deals (${deals.length})` },
    { key: 'tasks',       label: `Tasks (${tasks.filter(t => t.task_status === 'Open').length})` },
    { key: 'submissions', label: `Submissions (${submissions.length})` },
    { key: 'emails',      label: `Emails (${altEmails.length})` },
    { key: 'portal',      label: 'Portal' },
  ] as const;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-screen-xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/admin/crm" className="hover:text-gray-600">CRM</Link>
        <span>/</span>
        <Link href="/admin/crm/contacts" className="hover:text-gray-600">Contacts</Link>
        <span>/</span>
        <span className="text-gray-700 font-500">{contact.first_name} {contact.last_name}</span>
      </div>

      {/* Duplicate Warning */}
      {contact.has_potential_duplicate && (
        <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <Icon name="ExclamationTriangleIcon" size={16} className="text-amber-600 flex-shrink-0" />
          <span>Potential duplicate contact detected. Review and merge if needed.</span>
          <button onClick={() => setShowMerge(true)} className="ml-auto text-xs font-600 text-amber-700 hover:underline">Merge Contact</button>
        </div>
      )}

      {emailSent && (
        <div className="flex items-center gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800">
          <Icon name="CheckCircleIcon" size={16} className="text-emerald-600" />
          Email sent successfully and logged to activity.
          <button onClick={() => setEmailSent(false)} className="ml-auto"><Icon name="XMarkIcon" size={14} /></button>
        </div>
      )}

      {callLogged && (
        <div className="flex items-center gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800">
          <Icon name="CheckCircleIcon" size={16} className="text-emerald-600" />
          Call logged to activity timeline.
          <button onClick={() => setCallLogged(false)} className="ml-auto"><Icon name="XMarkIcon" size={14} /></button>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          ENHANCED CONTACT HEADER
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">

        {/* ── Identity Row ── */}
        <div className="px-5 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-start gap-4">
            {/* Avatar */}
            <div className="w-14 h-14 rounded-full bg-eb-green-100 flex items-center justify-center flex-shrink-0">
              <span className="text-xl font-700 text-eb-green-700">
                {(contact.first_name?.[0] || '?').toUpperCase()}{(contact.last_name?.[0] || '').toUpperCase()}
              </span>
            </div>

            {/* Name + Company + Contact Info */}
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-700 text-gray-900 font-display leading-tight">
                {contact.first_name} {contact.last_name}
              </h1>
              {contact.job_title && (
                <p className="text-sm text-gray-500 mt-0.5">{contact.job_title}</p>
              )}

              {/* Company */}
              <div className="flex items-center gap-1.5 mt-1">
                <Icon name="BuildingOfficeIcon" size={13} className="text-gray-400 flex-shrink-0" />
                {company?.company_name ? (
                  <Link
                    href={`/admin/crm/companies/${company.id}`}
                    className="text-sm font-600 text-eb-green-700 hover:underline"
                  >
                    {company.company_name}
                  </Link>
                ) : (
                  <span className="text-sm text-gray-400 italic">No Company</span>
                )}
              </div>

              {/* Contact Info */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
                <button
                  onClick={() => { setShowEmailForm(true); setEmailForm(f => ({ ...f, to: contact.primary_email })); }}
                  className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-eb-green-700 transition-colors group"
                  title="Send email"
                >
                  <Icon name="EnvelopeIcon" size={14} className="text-gray-400 group-hover:text-eb-green-600" />
                  <span className="group-hover:underline">{contact.primary_email}</span>
                </button>
                {contact.phone && (
                  <a
                    href={`tel:${contact.phone}`}
                    className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-eb-green-700 transition-colors group"
                  >
                    <Icon name="PhoneIcon" size={14} className="text-gray-400 group-hover:text-eb-green-600" />
                    <span className="group-hover:underline">{contact.phone}</span>
                  </a>
                )}
                {contact.lead_source && (
                  <span className="flex items-center gap-1.5 text-xs text-gray-400">
                    <Icon name="FunnelIcon" size={12} className="text-gray-300" />
                    {contact.lead_source}
                  </span>
                )}
              </div>
            </div>

            {/* Merge button — secondary, top-right */}
            <button
              onClick={() => setShowMerge(true)}
              className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-500 text-gray-400 border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-gray-600 transition-colors flex-shrink-0"
              title="Merge contact"
            >
              <Icon name="ArrowsRightLeftIcon" size={13} />
              Merge
            </button>
          </div>
        </div>

        {/* ── Status / Owner / Portal Row ── */}
        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3 bg-gray-50/50">

          {/* Lead Status — inline dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-600 text-gray-400 uppercase tracking-wide">Status</span>
            <div className="relative">
              <select
                value={contact.lead_status}
                onChange={e => handleStatusChange(e.target.value)}
                disabled={savingStatus}
                className={`appearance-none pl-2.5 pr-7 py-1 text-xs font-600 rounded-full border cursor-pointer focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 transition-colors ${STATUS_COLORS[contact.lead_status] || 'bg-gray-100 text-gray-600 border-gray-200'} ${savingStatus ? 'opacity-60' : ''}`}
              >
                {LEAD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                {savingStatus
                  ? <div className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin opacity-60" />
                  : <Icon name="ChevronDownIcon" size={10} className="opacity-60" />
                }
              </div>
            </div>
          </div>

          <span className="text-gray-200 hidden sm:block">|</span>

          {/* Owner — inline dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-600 text-gray-400 uppercase tracking-wide">Owner</span>
            <div className="relative">
              <select
                value={contact.assigned_owner}
                onChange={e => handleOwnerChange(e.target.value)}
                disabled={savingOwner}
                className={`appearance-none pl-2.5 pr-7 py-1 text-xs font-600 rounded-full border cursor-pointer focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 bg-white border-gray-200 text-gray-700 transition-colors ${savingOwner ? 'opacity-60' : ''}`}
              >
                {OWNERS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                {savingOwner
                  ? <div className="w-2.5 h-2.5 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                  : <Icon name="ChevronDownIcon" size={10} className="text-gray-400" />
                }
              </div>
            </div>
          </div>

          <span className="text-gray-200 hidden sm:block">|</span>

          {/* Portal Status badge */}
          <div className="flex items-center gap-1.5">
            {contact.portal_link_status === 'pending' ? (
              <button
                onClick={() => setActiveTab('portal')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-600 border transition-colors hover:opacity-80 ${portalCfg.badgeColor}`}
                title="Review portal access request"
              >
                <Icon name={portalCfg.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                {portalCfg.label}
                <span className="ml-0.5 text-[10px] opacity-70">→ Review</span>
              </button>
            ) : (
              <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-600 border ${portalCfg.badgeColor}`}>
                <Icon name={portalCfg.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                {portalCfg.label}
              </span>
            )}
          </div>

          {/* Created date — pushed right */}
          <span className="ml-auto text-xs text-gray-400 hidden md:block">
            Created {formatDate(contact.created_at)}
          </span>
        </div>

        {/* ── Quick Action Bar ── */}
        <div className="px-5 py-3 flex flex-wrap items-center gap-2">
          {/* PRIMARY ACTIONS */}
          <button
            onClick={() => { setShowEmailForm(true); setEmailForm(f => ({ ...f, to: contact.primary_email })); }}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-600 bg-eb-green-700 text-white rounded-lg hover:bg-eb-green-800 transition-colors"
          >
            <Icon name="EnvelopeIcon" size={15} />
            Email
          </button>

          <button
            onClick={() => setShowCreateDeal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-600 bg-eb-green-700 text-white rounded-lg hover:bg-eb-green-800 transition-colors"
          >
            <Icon name="BriefcaseIcon" size={15} />
            Create Deal
          </button>

          <button
            onClick={() => { setActiveTab('tasks'); setShowTaskForm(true); }}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-600 bg-eb-green-700 text-white rounded-lg hover:bg-eb-green-800 transition-colors"
          >
            <Icon name="ClipboardDocumentListIcon" size={15} />
            Add Task
          </button>

          {/* SECONDARY ACTIONS */}
          <div className="w-px h-6 bg-gray-200 hidden sm:block" />

          <button
            onClick={() => setShowNoteModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-600 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Icon name="ChatBubbleLeftIcon" size={15} />
            Add Note
          </button>

          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-600 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Icon name="PencilIcon" size={15} />
            Edit Contact
          </button>

          <button
            onClick={() => setShowLogCall(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-600 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Icon name="PhoneIcon" size={15} />
            Log Call
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex border-b border-gray-100 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-5 py-3 text-sm font-600 whitespace-nowrap transition-colors border-b-2 ${
                activeTab === tab.key
                  ? 'border-eb-green-700 text-eb-green-700' :'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {/* ── Overview Tab ── */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400">CRM Details</h3>
                <div className="space-y-3">
                  {[
                    { label: 'Status', value: contact.lead_status },
                    { label: 'Owner', value: contact.assigned_owner },
                    { label: 'Lead Source', value: contact.lead_source },
                    { label: 'Client Type', value: contact.client_type },
                    { label: 'Est. Deal Volume', value: formatCurrency(contact.estimated_deal_volume) },
                    { label: 'Est. EMD Need', value: formatCurrency(contact.estimated_emd_need) },
                    { label: 'Last Contacted', value: formatDate(contact.last_contacted_at) },
                    { label: 'Next Follow-Up', value: formatDate(contact.next_follow_up_at) },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex items-start gap-3">
                      <span className="text-xs text-gray-400 w-32 flex-shrink-0 pt-0.5">{label}</span>
                      <span className="text-sm text-gray-700 font-500">{value || '—'}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400">Attribution</h3>
                <div className="space-y-3">
                  {[
                    { label: 'Original Source', value: contact.original_lead_source },
                    { label: 'Original Campaign', value: contact.original_campaign },
                    { label: 'Latest Source', value: contact.latest_lead_source },
                    { label: 'Latest Campaign', value: contact.latest_campaign },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex items-start gap-3">
                      <span className="text-xs text-gray-400 w-32 flex-shrink-0 pt-0.5">{label}</span>
                      <span className="text-sm text-gray-700 font-500">{value || '—'}</span>
                    </div>
                  ))}
                </div>

                {contact.notes && (
                  <div className="mt-4">
                    <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-2">Notes</h3>
                    <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3 leading-relaxed">{contact.notes}</p>
                  </div>
                )}
              </div>

              {/* Add Note inline (overview tab) */}
              <div className="md:col-span-2">
                <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-2">Add Note</h3>
                <div className="flex gap-2">
                  <textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Add an internal note…"
                    rows={2}
                    className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500 resize-none"
                  />
                  <button
                    onClick={handleAddNote}
                    disabled={!noteText.trim() || addingNote}
                    className="px-4 py-2 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors self-end"
                  >
                    {addingNote ? '…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Activity Tab ── */}
          {activeTab === 'activity' && (
            <div className="space-y-1">
              {activities.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No activity recorded yet</p>
              ) : (
                activities.map((a) => (
                  <div key={a.id} className="flex gap-3 py-3 border-b border-gray-50 last:border-0">
                    <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Icon name={(ACTIVITY_ICONS[a.event_type] || ACTIVITY_ICONS.default) as Parameters<typeof Icon>[0]['name']} size={13} className="text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-500 text-gray-800">{a.title}</p>
                      {a.detail && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{a.detail}</p>}
                      <p className="text-[10px] text-gray-400 mt-1">{a.actor} · {formatDateTime(a.created_at)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ── Deals Tab ── */}
          {activeTab === 'deals' && (
            <div className="space-y-3">
              {deals.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-gray-400 mb-3">No deals associated with this contact</p>
                  <button
                    onClick={() => setShowCreateDeal(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors"
                  >
                    <Icon name="PlusIcon" size={14} />
                    Create Deal
                  </button>
                </div>
              ) : (
                deals.map((dc) => {
                  const deal = dc.borrower_applications;
                  if (!deal) return null;
                  return (
                    <Link
                      key={dc.id}
                      href={`/admin/borrower/${deal.user_id}/application/${deal.id}`}
                      className="block p-4 border border-gray-200 rounded-xl hover:border-eb-green-300 hover:shadow-sm transition-all"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-600 text-gray-900">{deal.property_address || 'Unnamed Deal'}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {deal.property_type || 'Property'} · {deal.purchase_price ? formatCurrency(deal.purchase_price) : '—'}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">
                            Due Diligence Period: {deal.due_diligence_days != null ? `${deal.due_diligence_days} ${deal.due_diligence_days === 1 ? 'Day' : 'Days'}` : '—'} · Role: {dc.role}
                          </p>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 ${DEAL_STATUS_COLORS[deal.app_status] || 'bg-gray-100 text-gray-600'}`}>
                          {deal.app_status?.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          )}

          {/* ── Tasks Tab ── */}
          {activeTab === 'tasks' && (
            <div className="space-y-3">
              {showTaskForm && (
                <div className="p-4 border border-eb-green-200 bg-eb-green-50 rounded-xl space-y-3">
                  <h4 className="text-sm font-700 text-gray-800">New Task</h4>
                  <input
                    type="text"
                    placeholder="Task title…"
                    value={taskForm.title}
                    onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20"
                  />
                  <div className="flex gap-2 flex-wrap">
                    <input
                      type="date"
                      value={taskForm.due_date}
                      onChange={(e) => setTaskForm((f) => ({ ...f, due_date: e.target.value }))}
                      className="flex-1 min-w-[120px] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none"
                    />
                    <select
                      value={taskForm.priority}
                      onChange={(e) => setTaskForm((f) => ({ ...f, priority: e.target.value }))}
                      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white"
                    >
                      <option>Low</option>
                      <option>Normal</option>
                      <option>High</option>
                    </select>
                    <select
                      value={taskForm.assigned_to}
                      onChange={(e) => setTaskForm((f) => ({ ...f, assigned_to: e.target.value }))}
                      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white"
                    >
                      {OWNERS.map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleCreateTask} className="px-4 py-2 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors">
                      Create Task
                    </button>
                    <button onClick={() => setShowTaskForm(false)} className="px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {!showTaskForm && (
                <button onClick={() => setShowTaskForm(true)} className="flex items-center gap-2 text-sm text-eb-green-700 font-600 hover:underline">
                  <Icon name="PlusIcon" size={14} />
                  Add Task
                </button>
              )}
              {tasks.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No tasks yet</p>
              ) : (
                tasks.map((t) => (
                  <div key={t.id} className={`flex items-start gap-3 p-3 rounded-xl border ${t.task_status === 'Completed' ? 'border-gray-100 bg-gray-50 opacity-60' : 'border-gray-200'}`}>
                    <button
                      onClick={() => t.task_status === 'Open' && (async () => {
                        await supabase.from('crm_tasks').update({ task_status: 'Completed', completed_at: new Date().toISOString() }).eq('id', t.id);
                        await load();
                      })()}
                      className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                        t.task_status === 'Completed' ? 'border-emerald-400 bg-emerald-400' : 'border-gray-300 hover:border-eb-green-500'
                      }`}
                    >
                      {t.task_status === 'Completed' && <Icon name="CheckIcon" size={10} className="text-white" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-600 ${t.task_status === 'Completed' ? 'line-through text-gray-400' : 'text-gray-800'}`}>{t.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {t.due_date ? formatDate(t.due_date) : 'No due date'} · {t.assigned_to} ·
                        <span className={`ml-1 ${t.priority === 'High' ? 'text-red-500' : t.priority === 'Normal' ? 'text-amber-500' : 'text-gray-400'}`}>
                          {t.priority}
                        </span>
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ── Submissions Tab ── */}
          {activeTab === 'submissions' && (
            <div className="space-y-3">
              {submissions.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No form submissions</p>
              ) : (
                submissions.map((s) => (
                  <div key={s.id} className="p-4 border border-gray-200 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-600 text-gray-800">{formatDateTime(s.submitted_at)}</p>
                      <div className="flex gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 border ${s.is_new_contact ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                          {s.is_new_contact ? 'NEW LEAD' : 'EXISTING CONTACT'}
                        </span>
                        {s.promo_code && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-600 border bg-purple-100 text-purple-700 border-purple-200">
                            {s.promo_code}
                          </span>
                        )}
                      </div>
                    </div>
                    {s.message && <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-2">{s.message}</p>}
                    <div className="flex flex-wrap gap-3 text-xs text-gray-400">
                      {s.lead_source && <span>Source: {s.lead_source}</span>}
                      {s.utm_campaign && <span>Campaign: {s.utm_campaign}</span>}
                      {s.utm_source && <span>UTM: {s.utm_source}</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ── Emails / Alternate Emails Tab ── */}
          {activeTab === 'emails' && (
            <div className="space-y-5">
              {/* Primary Email */}
              <div>
                <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-3">Primary Email</h3>
                <div className="flex items-center gap-3 p-3 bg-eb-green-50 border border-eb-green-200 rounded-xl">
                  <Icon name="EnvelopeIcon" size={16} className="text-eb-green-600 flex-shrink-0" />
                  <span className="text-sm font-600 text-gray-800">{contact.primary_email}</span>
                  <span className="ml-auto px-2 py-0.5 rounded-full text-[10px] font-700 bg-eb-green-100 text-eb-green-700">PRIMARY</span>
                </div>
              </div>

              {/* Alternate Emails */}
              <div>
                <h3 className="text-xs font-700 uppercase tracking-wider text-gray-400 mb-3">Alternate Emails</h3>
                {altEmails.length === 0 ? (
                  <p className="text-sm text-gray-400 mb-3">No alternate emails added yet.</p>
                ) : (
                  <div className="space-y-2 mb-4">
                    {altEmails.map(ae => (
                      <div key={ae.id} className="flex items-center gap-3 p-3 border border-gray-200 rounded-xl">
                        <Icon name="EnvelopeIcon" size={14} className="text-gray-400 flex-shrink-0" />
                        <span className="text-sm text-gray-700 flex-1">{ae.email}</span>
                        <span className="text-xs text-gray-400 capitalize">{ae.label}</span>
                        {ae.is_primary && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-600 bg-blue-100 text-blue-700">Primary Alt</span>
                        )}
                        {!ae.is_primary && (
                          <button
                            onClick={() => handleSetPrimaryEmail(ae.id)}
                            className="text-xs text-gray-400 hover:text-eb-green-700 transition-colors"
                            title="Set as primary alternate"
                          >
                            Set Primary
                          </button>
                        )}
                        <button
                          onClick={() => handleRemoveEmail(ae.id)}
                          className="p-1 rounded hover:bg-red-50 transition-colors"
                          title="Remove email"
                        >
                          <Icon name="XMarkIcon" size={13} className="text-gray-400 hover:text-red-500" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add Alternate Email */}
                <div className="p-4 border border-dashed border-gray-200 rounded-xl space-y-3">
                  <h4 className="text-xs font-600 text-gray-500">Add Alternate Email</h4>
                  {emailError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{emailError}</p>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <input
                      type="email"
                      placeholder="email@example.com"
                      value={newEmail}
                      onChange={e => { setNewEmail(e.target.value); setEmailError(''); }}
                      className="flex-1 min-w-[180px] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20"
                    />
                    <select
                      value={newEmailLabel}
                      onChange={e => setNewEmailLabel(e.target.value)}
                      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white"
                    >
                      <option value="alternate">Alternate</option>
                      <option value="work">Work</option>
                      <option value="personal">Personal</option>
                      <option value="business">Business</option>
                    </select>
                    <button
                      onClick={handleAddEmail}
                      disabled={!newEmail.trim() || addingEmail}
                      className="px-4 py-2 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors"
                    >
                      {addingEmail ? '…' : 'Add'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400">
                    Warning: If this email is already associated with another active Contact, you will be notified.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Portal Tab ── */}
          {activeTab === 'portal' && (
            <div className="space-y-5">
              <div className={`p-4 rounded-xl border ${portalCfg.color}`}>
                <div className="flex items-center gap-3">
                  <Icon name={portalCfg.icon as Parameters<typeof Icon>[0]['name']} size={20} />
                  <div>
                    <p className="font-700 text-sm">{portalCfg.label}</p>
                    {contact.portal_linked_at && (
                      <p className="text-xs mt-0.5 opacity-70">Linked: {formatDateTime(contact.portal_linked_at)}</p>
                    )}
                    {contact.portal_approved_at && (
                      <p className="text-xs opacity-70">Approved: {formatDateTime(contact.portal_approved_at)}</p>
                    )}
                  </div>
                </div>
              </div>

              {contact.portal_link_status === 'pending' && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="text-sm font-600 text-amber-800 mb-1">Portal Access Pending Review</p>
                  <p className="text-xs text-amber-700 mb-3">
                    A portal account was registered using <strong>{contact.primary_email}</strong> and matches this CRM Contact.
                    Review and approve or reject portal access.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => handlePortalAction('approved')} className="px-4 py-2 bg-emerald-600 text-white text-sm font-600 rounded-lg hover:bg-emerald-700 transition-colors">
                      Approve Portal Access
                    </button>
                    <button onClick={() => handlePortalAction('rejected')} className="px-4 py-2 bg-red-600 text-white text-sm font-600 rounded-lg hover:bg-red-700 transition-colors">
                      Reject / Unlink
                    </button>
                  </div>
                </div>
              )}

              {contact.portal_link_status === 'approved' && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    This contact has an active portal account. They can view all deals where their Contact record is explicitly associated.
                  </p>
                  <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                    <p className="text-xs text-gray-500 font-600 uppercase tracking-wider mb-1">Portal Email</p>
                    <p className="text-sm text-gray-800">{contact.primary_email}</p>
                  </div>
                  <button onClick={() => handlePortalAction('rejected')} className="text-xs text-red-600 hover:underline">
                    Revoke portal access
                  </button>
                </div>
              )}

              {contact.portal_link_status === 'none' && (
                <p className="text-sm text-gray-500">
                  This contact does not have a portal account. When they register at app.earnestbridge.com using <strong>{contact.primary_email}</strong>, the system will automatically flag it for Admin review.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          MODALS
      ═══════════════════════════════════════════════════════════════════ */}

      {/* Add Note Modal */}
      {showNoteModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h2 className="text-lg font-700 text-gray-900 font-display">Add Note</h2>
              <button onClick={() => setShowNoteModal(false)} className="p-2 rounded-lg hover:bg-gray-100">
                <Icon name="XMarkIcon" size={18} />
              </button>
            </div>
            <div className="p-6">
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                placeholder="Add an internal note about this contact…"
                rows={5}
                autoFocus
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 resize-none"
              />
              <p className="text-xs text-gray-400 mt-2">Notes are logged to the activity timeline.</p>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button
                onClick={handleAddNote}
                disabled={!noteText.trim() || addingNote}
                className="flex-1 py-2.5 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors"
              >
                {addingNote ? 'Saving…' : 'Save Note'}
              </button>
              <button onClick={() => setShowNoteModal(false)} className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log Call Modal */}
      {showLogCall && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-700 text-gray-900 font-display">Log Call</h2>
                <p className="text-xs text-gray-500 mt-0.5">{contact.first_name} {contact.last_name}</p>
              </div>
              <button onClick={() => setShowLogCall(false)} className="p-2 rounded-lg hover:bg-gray-100">
                <Icon name="XMarkIcon" size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {/* Direction */}
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-2">Direction</label>
                <div className="flex gap-2">
                  {['Outbound', 'Inbound'].map(dir => (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => setCallForm(f => ({ ...f, direction: dir }))}
                      className={`flex-1 py-2 text-sm font-600 rounded-lg border transition-colors ${
                        callForm.direction === dir
                          ? 'bg-eb-green-700 text-white border-eb-green-700' :'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {dir === 'Outbound' ? '↗ Outbound' : '↙ Inbound'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Outcome */}
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Outcome <span className="font-400 text-gray-400">(optional)</span></label>
                <select
                  value={callForm.outcome}
                  onChange={e => setCallForm(f => ({ ...f, outcome: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white"
                >
                  <option value="">— Select outcome —</option>
                  <option value="Connected">Connected</option>
                  <option value="Left voicemail">Left voicemail</option>
                  <option value="No answer">No answer</option>
                  <option value="Wrong number">Wrong number</option>
                  <option value="Scheduled follow-up">Scheduled follow-up</option>
                </select>
              </div>

              {/* Note */}
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Note <span className="font-400 text-gray-400">(optional)</span></label>
                <textarea
                  value={callForm.note}
                  onChange={e => setCallForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="Brief note about the call…"
                  rows={3}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 resize-none"
                />
              </div>

              <p className="text-xs text-gray-400">Call will be logged to the activity timeline with current timestamp.</p>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button
                onClick={handleLogCall}
                disabled={loggingCall}
                className="flex-1 py-2.5 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors"
              >
                {loggingCall ? 'Logging…' : 'Log Call'}
              </button>
              <button onClick={() => setShowLogCall(false)} className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h2 className="text-lg font-700 text-gray-900 font-display">Edit Contact</h2>
              <button onClick={() => setEditing(false)} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
                <Icon name="XMarkIcon" size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">First Name</label>
                  <input type="text" value={editForm.first_name || ''} onChange={(e) => setEditForm((f) => ({ ...f, first_name: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Last Name</label>
                  <input type="text" value={editForm.last_name || ''} onChange={(e) => setEditForm((f) => ({ ...f, last_name: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Phone</label>
                  <input type="text" value={editForm.phone || ''} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Job Title</label>
                  <input type="text" value={editForm.job_title || ''} onChange={(e) => setEditForm((f) => ({ ...f, job_title: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Lead Status</label>
                  <select value={editForm.lead_status || ''} onChange={(e) => setEditForm((f) => ({ ...f, lead_status: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
                    {LEAD_STATUSES.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Assigned Owner</label>
                  <select value={editForm.assigned_owner || ''} onChange={(e) => setEditForm((f) => ({ ...f, assigned_owner: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
                    {OWNERS.map((o) => <option key={o}>{o}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Lead Source</label>
                  <input type="text" value={editForm.lead_source || ''} onChange={(e) => setEditForm((f) => ({ ...f, lead_source: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
                </div>
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Next Follow-Up</label>
                  <input type="date" value={editForm.next_follow_up_at?.split('T')[0] || ''} onChange={(e) => setEditForm((f) => ({ ...f, next_follow_up_at: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Notes</label>
                <textarea value={editForm.notes || ''} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} rows={3}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 resize-none" />
              </div>
              {/* Company Assignment */}
              <CompanyAssignSection
                currentCompany={(contact.crm_companies as any) || null}
                onAssign={async (companyId: string | null) => {
                  await supabase.from('crm_contacts').update({ company_id: companyId, updated_at: new Date().toISOString() }).eq('id', contact.id);
                  if (companyId) {
                    await supabase.from('crm_activities').insert({ contact_id: contact.id, event_type: 'company_assigned', title: 'Company assigned', actor: 'Admin' });
                  }
                  await load();
                }}
              />
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button onClick={handleSave} disabled={saving}
                className="flex-1 py-2.5 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button onClick={() => setEditing(false)}
                className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Merge Modal */}
      {showMerge && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-700 text-gray-900 font-display">Merge Contact</h2>
                <p className="text-xs text-gray-500 mt-0.5">Select the surviving contact. This contact will be merged into it.</p>
              </div>
              <button onClick={() => { setShowMerge(false); setMergeTarget(null); setMergeError(''); }} className="p-2 rounded-lg hover:bg-gray-100">
                <Icon name="XMarkIcon" size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                <strong>Source (will be merged away):</strong> {contact.first_name} {contact.last_name} — {contact.primary_email}
              </div>

              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Search for surviving contact</label>
                <input
                  type="text"
                  placeholder="Name or email…"
                  value={mergeSearch}
                  onChange={e => handleMergeSearch(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20"
                />
              </div>

              {mergeResults.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {mergeResults.map(r => (
                    <button
                      key={r.id}
                      onClick={() => setMergeTarget(r.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                        mergeTarget === r.id ? 'border-eb-green-500 bg-eb-green-50' : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-xs font-700 text-gray-600">{r.first_name?.[0]}{r.last_name?.[0]}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-600 text-gray-800">{r.first_name} {r.last_name}</p>
                        <p className="text-xs text-gray-400">{r.primary_email}</p>
                      </div>
                      <span className="text-xs text-gray-400">{r.lead_status}</span>
                      {mergeTarget === r.id && <Icon name="CheckCircleIcon" size={16} className="text-eb-green-600 flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              )}

              {mergeError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{mergeError}</p>
              )}

              {mergeTarget && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
                  <strong>Warning:</strong> This action will merge {contact.first_name} {contact.last_name} into the selected contact. All submissions, activities, tasks, deals, and emails will be transferred. This cannot be undone.
                </div>
              )}
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button
                onClick={handleMerge}
                disabled={!mergeTarget || merging}
                className="flex-1 py-2.5 bg-red-600 text-white text-sm font-600 rounded-lg hover:bg-red-700 disabled:opacity-40 transition-colors"
              >
                {merging ? 'Merging…' : 'Confirm Merge'}
              </button>
              <button
                onClick={() => { setShowMerge(false); setMergeTarget(null); setMergeError(''); }}
                className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send Email Modal */}
      {showEmailForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h2 className="text-lg font-700 text-gray-900 font-display">Send Email</h2>
              <button onClick={handleCloseEmailForm} className="p-2 rounded-lg hover:bg-gray-100">
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
              {/* Attachments */}
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-2">Attachments</label>
                {contact && (
                  <EmailAttachmentPicker
                    key={attachmentPickerKey}
                    contactId={contact.id}
                    onChange={setEmailAttachments}
                    onUploadingChange={setAttachmentsUploading}
                    disabled={sendingEmail}
                  />
                )}
              </div>
              <p className="text-xs text-gray-400">Email is sent server-side and logged to the contact activity timeline.</p>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button
                onClick={handleSendEmail}
                disabled={!emailForm.to || !emailForm.subject || !emailForm.body || sendingEmail || attachmentsUploading}
                className="flex-1 py-2.5 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors"
              >
                {sendingEmail ? 'Sending…' : attachmentsUploading ? 'Uploading…' : 'Send Email'}
              </button>
              <button onClick={handleCloseEmailForm} className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Deal Modal */}
      {showCreateDeal && contact && (
        <CreateDealModal
          open={showCreateDeal}
          onClose={() => setShowCreateDeal(false)}
          onCreated={() => { setShowCreateDeal(false); load(); }}
          prefillContactId={contact.id}
          prefillContactName={`${contact.first_name} ${contact.last_name}`}
          prefillContactEmail={contact.primary_email}
          prefillContactPhone={contact.phone || ''}
          prefillCompanyName={(contact.crm_companies as any)?.company_name || ''}
          prefillCompanyId={(contact.crm_companies as any)?.id || ''}
        />
      )}
    </div>
  );
}
