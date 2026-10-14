'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

type DocStatus = 'pending' | 'uploaded' | 'approved' | 'rejected' | 'expired' | 'resubmit_requested';

interface ComplianceDoc {
  id: string;
  user_id: string;
  application_id: string | null;
  document_name: string;
  document_type: string;
  compliance_type: string | null;
  checklist_step: number | null;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  doc_status: DocStatus;
  admin_notes: string | null;
  resubmit_reason: string | null;
  client_revision_message: string | null;
  review_status: string | null;
  uploaded_at: string | null;
  created_at: string;
}

interface Application {
  id: string;
  label: string;
  app_status: string;
}

// The 3 required compliance documents linked to checklist steps
const COMPLIANCE_REQUIREMENTS = [
  {
    type: 'w9',
    name: 'W-9 Tax Form',
    document_type: 'w9',
    category: 'financial',
    checklistStep: 8,
    stepLabel: 'Step 8: Upload W-9',
    description: 'IRS W-9 form required for tax compliance. Must be signed and dated.',
    icon: 'DocumentTextIcon',
    color: 'text-blue-600',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    accentBg: 'bg-blue-600',
    instructions: [
      'Download the W-9 form from IRS.gov',
      'Fill in your legal name and TIN/SSN',
      'Sign and date the form',
      'Upload the completed PDF below',
    ],
  },
  {
    type: 'psa',
    name: 'Purchase & Sale Agreement (PSA)',
    document_type: 'psa',
    category: 'legal',
    checklistStep: 4,
    stepLabel: 'Step 4: PSA Review',
    description: 'Your executed Purchase & Sale Agreement for EarnestBridge review before you sign with the seller.',
    icon: 'ClipboardDocumentCheckIcon',
    color: 'text-violet-600',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
    accentBg: 'bg-violet-600',
    instructions: [
      'Obtain the draft PSA from the seller or your agent',
      'Do NOT sign with the seller yet',
      'Upload the draft PSA for EarnestBridge review',
      'We will provide a "green light" before you proceed',
    ],
  },
  {
    type: 'mou',
    name: 'Memorandum of Understanding (MOU)',
    document_type: 'mou',
    category: 'legal',
    checklistStep: 3,
    stepLabel: 'Step 3: Review MOU',
    description: 'Signed MOU outlining EarnestBridge program standards and your obligations as a borrower.',
    icon: 'DocumentMagnifyingGlassIcon',
    color: 'text-amber-600',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    accentBg: 'bg-amber-600',
    instructions: [
      'Review the MOU document sent to your email',
      'Ensure you understand the program standards',
      'Sign the MOU electronically or by hand',
      'Upload the signed copy below',
    ],
  },
];

const STATUS_CONFIG: Record<DocStatus, { label: string; color: string; bg: string; border: string; icon: string }> = {
  pending:            { label: 'Pending Upload',    color: 'text-gray-500',    bg: 'bg-gray-100',    border: 'border-gray-200',   icon: 'ClockIcon' },
  uploaded:           { label: 'Under Review',      color: 'text-blue-600',    bg: 'bg-blue-50',     border: 'border-blue-200',   icon: 'ArrowPathIcon' },
  approved:           { label: 'Approved',          color: 'text-emerald-600', bg: 'bg-emerald-50',  border: 'border-emerald-200',icon: 'CheckCircleIcon' },
  rejected:           { label: 'Rejected',          color: 'text-red-600',     bg: 'bg-red-50',      border: 'border-red-200',    icon: 'XCircleIcon' },
  expired:            { label: 'Expired',           color: 'text-orange-600',  bg: 'bg-orange-50',   border: 'border-orange-200', icon: 'ExclamationCircleIcon' },
  resubmit_requested: { label: 'Resubmit Required', color: 'text-amber-600',   bg: 'bg-amber-50',    border: 'border-amber-200',  icon: 'ArrowUpTrayIcon' },
};

const ACCEPTED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const MAX_FILE_SIZE = 50 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ComplianceDocumentsContent() {
  const { user, loading: authLoading } = useAuth();
  const [docs, setDocs] = useState<ComplianceDoc[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [dragOverType, setDragOverType] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchData = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    const supabase = createClient();
    try {
      const [docsRes, appsRes] = await Promise.all([
        supabase
          .from('borrower_documents')
          .select('*')
          .eq('user_id', user.id)
          .in('document_type', ['w9', 'psa', 'mou'])
          .order('created_at', { ascending: false }),
        supabase
          .from('borrower_applications')
          .select('id, property_address, company_name, app_status, created_at')
          .eq('user_id', user.id)
          .neq('app_status', 'draft')
          .order('created_at', { ascending: false }),
      ]);

      if (docsRes.data) setDocs(docsRes.data as ComplianceDoc[]);
      if (appsRes.data) {
        setApplications(appsRes.data.map((a: any) => ({
          id: a.id,
          label: a.property_address || a.company_name || `Application ${new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`,
          app_status: a.app_status,
        })));
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!authLoading) fetchData();
  }, [authLoading, fetchData]);

  // Real-time subscription
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    const channel = supabase
      .channel('compliance-docs-realtime')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'borrower_documents',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        const newDoc = payload.new as ComplianceDoc;
        if (!['w9', 'psa', 'mou'].includes(newDoc?.document_type ?? '')) return;
        if (payload.eventType === 'INSERT') {
          setDocs((prev) => [newDoc, ...prev]);
        } else if (payload.eventType === 'UPDATE') {
          setDocs((prev) => prev.map((d) => d.id === newDoc.id ? newDoc : d));
        } else if (payload.eventType === 'DELETE') {
          setDocs((prev) => prev.filter((d) => d.id !== (payload.old as ComplianceDoc).id));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  // Get the latest doc for a compliance type
  const getDocForType = (type: string): ComplianceDoc | null => {
    return docs.find((d) => d.document_type === type || d.compliance_type === type) ?? null;
  };

  const handleFileUpload = async (complianceType: string, file: File, applicationId?: string) => {
    if (!user) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      showToast('File type not supported. Use PDF, JPG, PNG, or DOCX.', 'error');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      showToast('File exceeds 50MB limit.', 'error');
      return;
    }

    const req = COMPLIANCE_REQUIREMENTS.find((r) => r.type === complianceType);
    if (!req) return;

    setUploadingType(complianceType);
    setUploadProgress((prev) => ({ ...prev, [complianceType]: 0 }));

    const supabase = createClient();
    const ext = file.name.split('.').pop();
    const tempId = crypto.randomUUID();
    const filePath = `${user.id}/${tempId}/${Date.now()}.${ext}`;

    try {
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          const current = prev[complianceType] || 0;
          if (current >= 80) { clearInterval(progressInterval); return prev; }
          return { ...prev, [complianceType]: current + 15 };
        });
      }, 200);

      const { error: uploadError } = await supabase.storage
        .from('borrower-documents')
        .upload(filePath, file, { upsert: true });

      clearInterval(progressInterval);
      if (uploadError) throw uploadError;

      setUploadProgress((prev) => ({ ...prev, [complianceType]: 90 }));

      // Check if a record already exists for this compliance type
      const existingDoc = getDocForType(complianceType);
      const appId = applicationId || applications[0]?.id || null;

      if (existingDoc) {
        // Update existing record
        const { error: updateError } = await supabase
          .from('borrower_documents')
          .update({
            file_url: filePath,
            file_name: file.name,
            file_size: file.size,
            mime_type: file.type,
            doc_status: 'uploaded',
            uploaded_at: new Date().toISOString(),
            resubmit_reason: null,
            resubmit_requested_at: null,
            compliance_type: complianceType,
            checklist_step: req.checklistStep,
          })
          .eq('id', existingDoc.id)
          .eq('user_id', user.id);
        if (updateError) throw updateError;
      } else {
        // Insert new record
        const { error: insertError } = await supabase
          .from('borrower_documents')
          .insert({
            user_id: user.id,
            application_id: appId,
            document_name: req.name,
            document_type: req.document_type,
            category: req.category,
            compliance_type: complianceType,
            checklist_step: req.checklistStep,
            file_url: filePath,
            file_name: file.name,
            file_size: file.size,
            mime_type: file.type,
            doc_status: 'uploaded',
            uploaded_at: new Date().toISOString(),
          });
        if (insertError) throw insertError;
      }

      setUploadProgress((prev) => ({ ...prev, [complianceType]: 100 }));
      showToast(`${req.name} uploaded successfully. Under review.`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Upload failed. Please try again.', 'error');
    } finally {
      setTimeout(() => {
        setUploadingType(null);
        setUploadProgress((prev) => { const n = { ...prev }; delete n[complianceType]; return n; });
      }, 800);
    }
  };

  const handleDrop = (e: React.DragEvent, complianceType: string) => {
    e.preventDefault();
    setDragOverType(null);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(complianceType, file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>, complianceType: string) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(complianceType, file);
    e.target.value = '';
  };

  const completedCount = COMPLIANCE_REQUIREMENTS.filter((r) => {
    const doc = getDocForType(r.type);
    return doc?.doc_status === 'approved';
  }).length;

  const uploadedCount = COMPLIANCE_REQUIREMENTS.filter((r) => {
    const doc = getDocForType(r.type);
    return doc && doc.doc_status !== 'pending';
  }).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading compliance documents…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <Icon name={toast.type === 'success' ? 'CheckCircleIcon' : 'XCircleIcon'} size={18} />
          {toast.message}
        </div>
      )}

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 mb-6">
        <div className="flex-1">
          <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Compliance Documents</h1>
          <p className="text-sm text-gray-400 mt-0.5">Upload required compliance files linked to your deal checklist stages.</p>
        </div>
        <Link
          href="/application-status"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-eb-green-900 transition-colors self-start sm:self-auto flex-shrink-0"
        >
          <Icon name="ClipboardDocumentListIcon" size={14} />
          View Checklist
        </Link>
      </div>

      {/* Progress summary */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="ShieldCheckIcon" size={16} className="text-eb-green-700" />
              <span className="font-display font-600 text-sm text-gray-900">Compliance Progress</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-eb-green-900 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round((completedCount / COMPLIANCE_REQUIREMENTS.length) * 100)}%` }}
                />
              </div>
              <span className="text-xs font-display font-700 text-eb-green-900 tabular-nums whitespace-nowrap">
                {completedCount}/{COMPLIANCE_REQUIREMENTS.length} approved
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="text-center">
              <p className="text-lg font-display font-700 text-gray-900 tabular-nums">{uploadedCount}</p>
              <p className="text-[11px] text-gray-400">Uploaded</p>
            </div>
            <div className="w-px h-8 bg-gray-100" />
            <div className="text-center">
              <p className="text-lg font-display font-700 text-emerald-600 tabular-nums">{completedCount}</p>
              <p className="text-[11px] text-gray-400">Approved</p>
            </div>
            <div className="w-px h-8 bg-gray-100" />
            <div className="text-center">
              <p className="text-lg font-display font-700 text-gray-400 tabular-nums">{COMPLIANCE_REQUIREMENTS.length - uploadedCount}</p>
              <p className="text-[11px] text-gray-400">Pending</p>
            </div>
          </div>
        </div>
      </div>

      {/* Compliance document cards */}
      <div className="space-y-4">
        {COMPLIANCE_REQUIREMENTS.map((req) => {
          const doc = getDocForType(req.type);
          const status = doc?.doc_status ?? 'pending';
          const statusCfg = STATUS_CONFIG[status];
          const isUploading = uploadingType === req.type;
          const progress = uploadProgress[req.type] ?? 0;
          const isDragOver = dragOverType === req.type;
          const isExpanded = expandedType === req.type;
          const canUpload = status !== 'approved';

          return (
            <div
              key={req.type}
              className={`bg-white rounded-2xl border shadow-card overflow-hidden transition-all duration-200 ${
                status === 'approved' ?'border-emerald-200'
                  : status === 'resubmit_requested'|| status === 'rejected' ?'border-red-200'
                  : status === 'uploaded' ?'border-blue-200' :'border-gray-100'
              }`}
            >
              {/* Card header */}
              <div className="flex items-center gap-4 px-5 py-4">
                {/* Icon */}
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${req.bg}`}>
                  <Icon name={req.icon as Parameters<typeof Icon>[0]['name']} size={20} className={req.color} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-display font-700 text-sm text-gray-900">{req.name}</h3>
                    <span className={`text-[10px] font-display font-600 px-2 py-0.5 rounded-full border ${statusCfg.bg} ${statusCfg.color} ${statusCfg.border}`}>
                      {statusCfg.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-0.5">{req.stepLabel}</p>
                  {doc?.uploaded_at && (
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      Uploaded {formatDate(doc.uploaded_at)}
                      {doc.file_name && <span className="ml-1">· {doc.file_name}</span>}
                      {doc.file_size && <span className="ml-1">· {formatBytes(doc.file_size)}</span>}
                    </p>
                  )}
                </div>

                {/* Status icon + expand toggle */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {status === 'approved' && (
                    <div className="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center">
                      <Icon name="CheckIcon" size={14} className="text-emerald-600" />
                    </div>
                  )}
                  {canUpload && (
                    <button
                      onClick={() => setExpandedType(isExpanded ? null : req.type)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 rounded-lg border transition-all ${
                        status === 'resubmit_requested' || status === 'rejected' ?'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'
                          : status === 'uploaded' ?'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100' :'text-eb-green-800 bg-eb-green-50 border-eb-green-200 hover:bg-eb-green-100'
                      }`}
                    >
                      <Icon name="ArrowUpTrayIcon" size={12} />
                      {status === 'resubmit_requested' || status === 'rejected' ? 'Resubmit' : status === 'uploaded' ? 'Replace' : 'Upload'}
                    </button>
                  )}
                  <button
                    onClick={() => setExpandedType(isExpanded ? null : req.type)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
                  >
                    <Icon name={isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={14} />
                  </button>
                </div>
              </div>

              {/* Admin feedback */}
              {(doc?.admin_notes || doc?.resubmit_reason) && (
                <div className={`mx-5 mb-3 px-4 py-3 rounded-xl border text-xs ${
                  status === 'rejected' ? 'bg-red-50 border-red-200 text-red-700' :
                  status === 'resubmit_requested' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                  status === 'approved'? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-600'
                }`}>
                  <div className="flex items-start gap-2">
                    <Icon name="ChatBubbleLeftEllipsisIcon" size={13} className="flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-display font-600 mb-0.5">Admin Note</p>
                      <p className="leading-relaxed">{doc.resubmit_reason || doc.admin_notes}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Revision Required banner — shown when review_status = revision_requested */}
              {doc?.review_status === 'revision_requested' && doc?.client_revision_message && (
                <div className="mx-5 mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon name="ArrowPathIcon" size={12} className="text-amber-600 flex-shrink-0" />
                    <span className="text-[11px] font-display font-700 text-amber-700 uppercase tracking-wide">Revision Required</span>
                  </div>
                  <p className="text-xs text-amber-800 leading-relaxed">{doc.client_revision_message}</p>
                </div>
              )}

              {/* Expanded: instructions + upload zone */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-5 py-4 bg-gray-50/50">
                  {/* Instructions */}
                  <div className="mb-4">
                    <p className="text-xs font-display font-600 text-gray-700 mb-2">Instructions</p>
                    <ol className="space-y-1.5">
                      {req.instructions.map((step, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-gray-500">
                          <span className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-[10px] font-display font-700 text-white ${req.accentBg}`}>
                            {i + 1}
                          </span>
                          {step}
                        </li>
                      ))}
                    </ol>
                  </div>

                  {/* Upload zone */}
                  <div>
                    <p className="text-xs font-display font-600 text-gray-700 mb-2">
                      {status === 'uploaded' ? 'Replace File' : 'Upload File'}
                      <span className="text-gray-400 font-400 ml-1">PDF, JPG, PNG, DOCX · Max 50MB</span>
                    </p>

                    <input
                      ref={(el) => { fileInputRefs.current[req.type] = el; }}
                      type="file"
                      accept={ACCEPTED_TYPES.join(',')}
                      className="hidden"
                      onChange={(e) => handleFileInputChange(e, req.type)}
                    />

                    {isUploading ? (
                      <div className="border-2 border-dashed border-gray-200 rounded-xl p-5 bg-white">
                        <div className="flex flex-col items-center gap-3">
                          <div className="w-10 h-10 border-4 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
                          <p className="text-sm font-display font-600 text-gray-700">Uploading…</p>
                          <div className="w-full max-w-xs">
                            <div className="flex justify-between text-[11px] text-gray-400 mb-1">
                              <span>Progress</span>
                              <span>{progress}%</span>
                            </div>
                            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-eb-green-900 rounded-full transition-all duration-300"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`border-2 border-dashed rounded-xl transition-all cursor-pointer ${
                          isDragOver
                            ? 'border-eb-green-900 bg-eb-green-50' :'border-gray-200 hover:border-gray-300 bg-white hover:bg-gray-50'
                        }`}
                        onDragOver={(e) => { e.preventDefault(); setDragOverType(req.type); }}
                        onDragLeave={() => setDragOverType(null)}
                        onDrop={(e) => handleDrop(e, req.type)}
                        onClick={() => fileInputRefs.current[req.type]?.click()}
                      >
                        <div className="flex flex-col items-center justify-center py-8 gap-2">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isDragOver ? 'bg-eb-green-100' : 'bg-gray-100'}`}>
                            <Icon name="ArrowUpTrayIcon" size={22} className={isDragOver ? 'text-eb-green-900' : 'text-gray-400'} />
                          </div>
                          <p className="text-sm text-gray-600 font-display font-500">
                            <span className="text-eb-green-900 font-600 underline">Browse</span> or drag & drop
                          </p>
                          <p className="text-xs text-gray-400">PDF, JPG, PNG, DOCX · Max 50MB</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Progress bar for uploading (shown in collapsed state too) */}
              {isUploading && !isExpanded && (
                <div className="px-5 pb-4">
                  <div className="flex justify-between text-[11px] text-gray-400 mb-1">
                    <span>Uploading…</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-eb-green-900 rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Help note */}
      <div className="mt-6 flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
        <Icon name="InformationCircleIcon" size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-blue-700">
          <p className="font-display font-600 mb-0.5">Need help with a document?</p>
          <p className="leading-relaxed">
            Contact your EarnestBridge representative if you have questions about any required document.
            Documents are reviewed within 1–2 business days.
          </p>
        </div>
      </div>
    </div>
  );
}
