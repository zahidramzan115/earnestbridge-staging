'use client';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
  uploaded_at: string | null;
  created_at: string;
}

interface Props {
  dealId: string;
  dealLabel: string;
}

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

export default function DealComplianceDocuments({ dealId, dealLabel }: Props) {
  const { user } = useAuth();
  const supabase = React.useMemo(() => createClient(), []);
  const [docs, setDocs] = useState<ComplianceDoc[]>([]);
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

  const fetchDocs = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    try {
      const { data } = await supabase
        .from('borrower_documents')
        .select('*')
        .eq('user_id', user.id)
        .eq('application_id', dealId)
        .in('document_type', ['w9', 'psa', 'mou'])
        .order('created_at', { ascending: false });
      if (data) setDocs(data as ComplianceDoc[]);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [user, supabase, dealId]);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  // Real-time subscription scoped to this deal
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`deal-compliance-${dealId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'borrower_documents',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        const newDoc = payload.new as ComplianceDoc;
        if (newDoc?.application_id !== dealId) return;
        if (!['w9', 'psa', 'mou'].includes(newDoc?.document_type ?? '')) return;
        if (payload.eventType === 'INSERT') {
          setDocs((prev) => [newDoc, ...prev.filter(d => d.document_type !== newDoc.document_type)]);
        } else if (payload.eventType === 'UPDATE') {
          setDocs((prev) => prev.map((d) => d.id === newDoc.id ? newDoc : d));
        } else if (payload.eventType === 'DELETE') {
          setDocs((prev) => prev.filter((d) => d.id !== (payload.old as ComplianceDoc).id));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, supabase, dealId]);

  const getDocForType = (type: string): ComplianceDoc | null => {
    return docs.find((d) => d.document_type === type || d.compliance_type === type) ?? null;
  };

  const handleFileUpload = async (complianceType: string, file: File) => {
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

      const existingDoc = getDocForType(complianceType);

      if (existingDoc) {
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
            compliance_type: complianceType,
            checklist_step: req.checklistStep,
          })
          .eq('id', existingDoc.id)
          .eq('user_id', user.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase
          .from('borrower_documents')
          .insert({
            user_id: user.id,
            application_id: dealId,
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

  const completedCount = COMPLIANCE_REQUIREMENTS.filter((r) => getDocForType(r.type)?.doc_status === 'approved').length;
  const uploadedCount = COMPLIANCE_REQUIREMENTS.filter((r) => {
    const doc = getDocForType(r.type);
    return doc && doc.doc_status !== 'pending';
  }).length;

  if (loading) {
    return (
      <div className="mt-4 pt-4 border-t border-gray-100">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-gray-100 rounded w-40" />
          <div className="h-16 bg-gray-50 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-100 relative">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <Icon name={toast.type === 'success' ? 'CheckCircleIcon' : 'XCircleIcon'} size={18} />
          {toast.message}
        </div>
      )}

      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon name="ShieldCheckIcon" size={14} className="text-eb-green-700" />
          <p className="text-xs font-display font-700 text-gray-700 uppercase tracking-wide">Compliance Documents</p>
          <span className="text-[10px] font-display font-600 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
            Required
          </span>
        </div>
        {/* Progress summary */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="flex-1 w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-eb-green-900 rounded-full transition-all duration-500"
                style={{ width: `${Math.round((completedCount / COMPLIANCE_REQUIREMENTS.length) * 100)}%` }}
              />
            </div>
            <span className="text-[10px] font-display font-600 text-eb-green-900 tabular-nums whitespace-nowrap">
              {completedCount}/{COMPLIANCE_REQUIREMENTS.length} approved
            </span>
          </div>
        </div>
      </div>

      {/* Compliance document rows */}
      <div className="space-y-2">
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
              className={`rounded-xl border overflow-hidden transition-all duration-200 ${
                status === 'approved' ?'border-emerald-200 bg-emerald-50/30'
                  : status === 'resubmit_requested'|| status === 'rejected' ?'border-red-200 bg-red-50/20'
                  : status === 'uploaded' ?'border-blue-200 bg-blue-50/20' :'border-gray-100 bg-white'
              }`}
            >
              {/* Row header */}
              <div className="flex items-center gap-3 px-4 py-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${req.bg}`}>
                  <Icon name={req.icon as Parameters<typeof Icon>[0]['name']} size={15} className={req.color} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-display font-600 text-xs text-gray-900">{req.name}</span>
                    <span className={`text-[10px] font-display font-600 px-1.5 py-0.5 rounded-full border ${statusCfg.bg} ${statusCfg.color} ${statusCfg.border}`}>
                      {statusCfg.label}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">{req.stepLabel}</p>
                  {doc?.uploaded_at && (
                    <p className="text-[10px] text-gray-400">
                      {formatDate(doc.uploaded_at)}
                      {doc.file_name && <span className="ml-1">· {doc.file_name}</span>}
                      {doc.file_size && <span className="ml-1">· {formatBytes(doc.file_size)}</span>}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {status === 'approved' && (
                    <div className="w-6 h-6 bg-emerald-100 rounded-full flex items-center justify-center">
                      <Icon name="CheckIcon" size={11} className="text-emerald-600" />
                    </div>
                  )}
                  {canUpload && (
                    <button
                      onClick={() => setExpandedType(isExpanded ? null : req.type)}
                      className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-display font-600 rounded-lg border transition-all ${
                        status === 'resubmit_requested' || status === 'rejected' ?'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'
                          : status === 'uploaded' ?'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100' :'text-eb-green-800 bg-eb-green-50 border-eb-green-200 hover:bg-eb-green-100'
                      }`}
                    >
                      <Icon name="ArrowUpTrayIcon" size={11} />
                      {status === 'resubmit_requested' || status === 'rejected' ? 'Resubmit' : status === 'uploaded' ? 'Replace' : 'Upload'}
                    </button>
                  )}
                  <button
                    onClick={() => setExpandedType(isExpanded ? null : req.type)}
                    className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
                  >
                    <Icon name={isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={12} />
                  </button>
                </div>
              </div>

              {/* Admin feedback */}
              {(doc?.admin_notes || doc?.resubmit_reason) && (
                <div className={`mx-4 mb-2 px-3 py-2 rounded-lg border text-[11px] ${
                  status === 'rejected' ? 'bg-red-50 border-red-200 text-red-700' :
                  status === 'resubmit_requested' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                  status === 'approved' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-600'
                }`}>
                  <div className="flex items-start gap-1.5">
                    <Icon name="ChatBubbleLeftEllipsisIcon" size={11} className="flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-display font-600 mb-0.5">Admin Note</p>
                      <p className="leading-relaxed">{doc.resubmit_reason || doc.admin_notes}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Expanded: instructions + upload zone */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50">
                  {/* Instructions */}
                  <div className="mb-3">
                    <p className="text-[11px] font-display font-600 text-gray-700 mb-1.5">Instructions</p>
                    <ol className="space-y-1">
                      {req.instructions.map((step, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] text-gray-500">
                          <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-[9px] font-display font-700 text-white ${req.accentBg}`}>
                            {i + 1}
                          </span>
                          {step}
                        </li>
                      ))}
                    </ol>
                  </div>

                  {/* Upload zone */}
                  <div>
                    <p className="text-[11px] font-display font-600 text-gray-700 mb-1.5">
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
                      <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 bg-white">
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-8 h-8 border-4 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
                          <p className="text-xs font-display font-600 text-gray-700">Uploading…</p>
                          <div className="w-full max-w-xs">
                            <div className="flex justify-between text-[10px] text-gray-400 mb-1">
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
                        <div className="flex flex-col items-center justify-center py-5 gap-1.5">
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${isDragOver ? 'bg-eb-green-100' : 'bg-gray-100'}`}>
                            <Icon name="ArrowUpTrayIcon" size={18} className={isDragOver ? 'text-eb-green-900' : 'text-gray-400'} />
                          </div>
                          <p className="text-xs text-gray-600 font-display font-500">
                            <span className="text-eb-green-900 font-600 underline">Browse</span> or drag & drop
                          </p>
                          <p className="text-[10px] text-gray-400">PDF, JPG, PNG, DOCX · Max 50MB</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Inline progress bar when uploading collapsed */}
              {isUploading && !isExpanded && (
                <div className="px-4 pb-3">
                  <div className="flex justify-between text-[10px] text-gray-400 mb-1">
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
    </div>
  );
}
