'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { MOCK_DOCUMENTS, Document } from '@/lib/mockData';

// Map DB doc_status to borrower-friendly display
type DocStatus = 'pending' | 'uploaded' | 'approved' | 'rejected' | 'expired' | 'resubmit_requested';

const STATUS_CONFIG: Record<DocStatus, { label: string; color: string; icon: string; borrowerLabel: string; pillColor: string }> = {
  pending:             { label: 'Pending Upload',    borrowerLabel: 'Pending',      color: 'text-amber-600 bg-amber-50 border-amber-200',     icon: 'ClockIcon',             pillColor: 'text-amber-700 bg-amber-50 border-amber-200' },
  uploaded:            { label: 'Submitted',         borrowerLabel: 'Submitted',    color: 'text-blue-600 bg-blue-50 border-blue-200',         icon: 'ArrowUpTrayIcon',       pillColor: 'text-blue-700 bg-blue-50 border-blue-200' },
  approved:            { label: 'Approved',          borrowerLabel: 'Approved',     color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: 'CheckCircleIcon',       pillColor: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  rejected:            { label: 'Rejected',          borrowerLabel: 'Rejected',     color: 'text-red-600 bg-red-50 border-red-200',            icon: 'XCircleIcon',           pillColor: 'text-red-700 bg-red-50 border-red-200' },
  expired:             { label: 'Expired',           borrowerLabel: 'Expired',      color: 'text-gray-500 bg-gray-50 border-gray-200',         icon: 'ExclamationCircleIcon', pillColor: 'text-gray-600 bg-gray-50 border-gray-200' },
  resubmit_requested:  { label: 'Resubmit Required', borrowerLabel: 'Action Needed',color: 'text-orange-600 bg-orange-50 border-orange-200',   icon: 'ArrowPathIcon',         pillColor: 'text-orange-700 bg-orange-50 border-orange-200' },
};

const CATEGORY_ICONS: Record<string, string> = {
  identity:    'IdentificationIcon',
  financial:   'CalculatorIcon',
  property:    'HomeModernIcon',
  legal:       'DocumentTextIcon',
  other:       'FolderIcon',
  Transaction: 'DocumentTextIcon',
  Loan:        'BanknotesIcon',
  Entity:      'BuildingLibraryIcon',
  Financial:   'CalculatorIcon',
  Property:    'HomeModernIcon',
  Identity:    'IdentificationIcon',
};

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAX_FILE_SIZE = 52428800; // 50 MB

interface RealDocument {
  id: string;
  document_name: string;
  document_type: string;
  category: string;
  doc_status: DocStatus;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  admin_notes: string | null;
  resubmit_reason: string | null;
  client_revision_message: string | null;
  review_status: string | null;
  uploaded_at: string | null;
  created_at: string;
}

interface DocumentChecklistProps {
  applicationId: string;
}

interface PreviewDoc {
  name: string;
  fileUrl: string;
  fileType?: 'image' | 'pdf' | 'other';
}

interface UploadState {
  docId: string;
  progress: number; // 0-100
  status: 'uploading' | 'success' | 'error';
  errorMessage?: string;
}

function DocumentPreviewModal({ doc, onClose }: { doc: PreviewDoc; onClose: () => void }) {
  const handleDownload = () => {
    const link = window.document.createElement('a');
    link.href = doc.fileUrl;
    link.download = doc.name;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-eb-green-900/10 flex items-center justify-center flex-shrink-0">
              <Icon name={doc.fileType === 'image' ? 'PhotoIcon' : 'DocumentTextIcon'} size={16} className="text-eb-green-800" />
            </div>
            <p className="font-display font-600 text-gray-900 text-sm truncate">{doc.name}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-3">
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-lg transition-all active:scale-95"
            >
              <Icon name="ArrowDownTrayIcon" size={13} />
              Download
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-all"
              aria-label="Close preview"
            >
              <Icon name="XMarkIcon" size={18} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-gray-50 flex items-center justify-center p-4 min-h-0">
          {doc.fileType === 'image' ? (
            <img src={doc.fileUrl} alt={doc.name} className="max-w-full max-h-full object-contain rounded-lg shadow-md" />
          ) : doc.fileType === 'pdf' ? (
            <iframe src={doc.fileUrl} title={doc.name} className="w-full rounded-lg shadow-md bg-white" style={{ height: '60vh' }} />
          ) : (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center">
                <Icon name="DocumentIcon" size={32} className="text-gray-400" />
              </div>
              <p className="text-sm text-gray-500">Preview not available for this file type.</p>
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 px-4 py-2 text-sm font-display font-600 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-lg transition-all"
              >
                <Icon name="ArrowDownTrayIcon" size={14} />
                Download File
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Shared status legend shown to borrowers
function DocStatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4 p-3 bg-gray-50 rounded-xl border border-gray-100">
      <span className="text-[11px] font-display font-600 text-gray-400 uppercase tracking-wide mr-1">Status key:</span>
      {[
        { label: 'Submitted', pillColor: 'text-blue-700 bg-blue-50 border-blue-200', icon: 'ArrowUpTrayIcon' },
        { label: 'Approved', pillColor: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: 'CheckCircleIcon' },
        { label: 'Rejected', pillColor: 'text-red-700 bg-red-50 border-red-200', icon: 'XCircleIcon' },
        { label: 'Action Needed', pillColor: 'text-orange-700 bg-orange-50 border-orange-200', icon: 'ArrowPathIcon' },
      ].map((s) => (
        <span key={s.label} className={`flex items-center gap-1 text-[11px] font-display font-600 px-2 py-0.5 rounded-full border ${s.pillColor}`}>
          <Icon name={s.icon as Parameters<typeof Icon>[0]['name']} size={10} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// Upload progress bar component
function UploadProgressBar({ progress, status, errorMessage }: { progress: number; status: UploadState['status']; errorMessage?: string }) {
  if (status === 'error') {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-2.5 py-2">
        <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0" />
        <span>{errorMessage || 'Upload failed. Please try again.'}</span>
      </div>
    );
  }
  if (status === 'success') {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-2">
        <Icon name="CheckCircleIcon" size={13} className="flex-shrink-0" />
        <span>Upload complete! Document submitted for review.</span>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-gray-500 font-display font-600">Uploading…</span>
        <span className="text-[11px] font-display font-700 text-eb-green-900 tabular-nums">{progress}%</span>
      </div>
      <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-eb-green-900 rounded-full transition-all duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

export default function DocumentChecklist({ applicationId }: DocumentChecklistProps) {
  const { user } = useAuth();
  const [realDocs, setRealDocs] = useState<RealDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewDoc, setPreviewDoc] = useState<PreviewDoc | null>(null);
  const [uploadStates, setUploadStates] = useState<Record<string, UploadState>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const isMockId = applicationId.startsWith('app-') || applicationId.startsWith('mock-');

  useEffect(() => {
    if (isMockId || !user) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    supabase
      .from('borrower_documents')
      .select('*')
      .eq('application_id', applicationId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (data) setRealDocs(data as RealDocument[]);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // Real-time updates for doc status changes (admin approves/rejects)
    const channel = supabase
      .channel(`doc-checklist-${applicationId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'borrower_documents',
        filter: `application_id=eq.${applicationId}`,
      }, (payload) => {
        setRealDocs((prev) =>
          prev.map((d) => d.id === (payload.new as RealDocument).id ? (payload.new as RealDocument) : d)
        );
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [applicationId, user, isMockId]);

  const handleUploadClick = useCallback((docId: string) => {
    fileInputRefs.current[docId]?.click();
  }, []);

  const handleFileChange = useCallback(async (doc: RealDocument, file: File) => {
    if (!user) return;

    // Validate file type
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      setUploadStates((prev) => ({
        ...prev,
        [doc.id]: { docId: doc.id, progress: 0, status: 'error', errorMessage: 'File type not allowed. Please upload PDF, JPG, PNG, WEBP, or DOC files.' },
      }));
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      setUploadStates((prev) => ({
        ...prev,
        [doc.id]: { docId: doc.id, progress: 0, status: 'error', errorMessage: 'File exceeds 50 MB limit. Please upload a smaller file.' },
      }));
      return;
    }

    const supabase = createClient();
    const ext = file.name.split('.').pop() ?? 'bin';
    const storagePath = `${user.id}/${doc.id}/${Date.now()}.${ext}`;

    // Start upload state
    setUploadStates((prev) => ({
      ...prev,
      [doc.id]: { docId: doc.id, progress: 5, status: 'uploading' },
    }));

    try {
      // Simulate progress increments while uploading (Supabase JS v2 doesn't expose XHR progress)
      const progressInterval = setInterval(() => {
        setUploadStates((prev) => {
          const current = prev[doc.id];
          if (!current || current.status !== 'uploading') {
            clearInterval(progressInterval);
            return prev;
          }
          const next = Math.min(current.progress + Math.floor(Math.random() * 15 + 5), 85);
          return { ...prev, [doc.id]: { ...current, progress: next } };
        });
      }, 400);

      const { error: uploadError } = await supabase.storage
        .from('borrower-documents')
        .upload(storagePath, file, { cacheControl: '3600', upsert: false });

      clearInterval(progressInterval);

      if (uploadError) {
        setUploadStates((prev) => ({
          ...prev,
          [doc.id]: { docId: doc.id, progress: 0, status: 'error', errorMessage: uploadError.message },
        }));
        return;
      }

      // Set progress to 90 while updating DB
      setUploadStates((prev) => ({
        ...prev,
        [doc.id]: { docId: doc.id, progress: 90, status: 'uploading' },
      }));

      // Get signed URL (bucket is private)
      const { data: signedData, error: signedError } = await supabase.storage
        .from('borrower-documents')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365); // 1 year

      const fileUrl = signedError ? null : signedData?.signedUrl ?? null;

      // Update the borrower_documents record
      const { error: dbError } = await supabase
        .from('borrower_documents')
        .update({
          file_url: fileUrl,
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type,
          doc_status: 'uploaded',
          uploaded_at: new Date().toISOString(),
        })
        .eq('id', doc.id)
        .eq('user_id', user.id);

      if (dbError) {
        setUploadStates((prev) => ({
          ...prev,
          [doc.id]: { docId: doc.id, progress: 0, status: 'error', errorMessage: dbError.message },
        }));
        return;
      }

      // Update local state immediately
      setRealDocs((prev) =>
        prev.map((d) =>
          d.id === doc.id
            ? { ...d, file_url: fileUrl, file_name: file.name, file_size: file.size, mime_type: file.type, doc_status: 'uploaded', uploaded_at: new Date().toISOString() }
            : d
        )
      );

      setUploadStates((prev) => ({
        ...prev,
        [doc.id]: { docId: doc.id, progress: 100, status: 'success' },
      }));

      // Clear success state after 4 seconds
      setTimeout(() => {
        setUploadStates((prev) => {
          const next = { ...prev };
          delete next[doc.id];
          return next;
        });
      }, 4000);

    } catch {
      setUploadStates((prev) => ({
        ...prev,
        [doc.id]: { docId: doc.id, progress: 0, status: 'error', errorMessage: 'An unexpected error occurred. Please try again.' },
      }));
    }
  }, [user]);

  const canUpload = (status: DocStatus) =>
    status === 'pending' || status === 'rejected' || status === 'resubmit_requested';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Icon name="ArrowPathIcon" size={20} className="animate-spin text-eb-green-600" />
        <span className="ml-2 text-sm text-gray-400">Loading documents…</span>
      </div>
    );
  }

  // ── MOCK fallback ──────────────────────────────────────────────────────────
  if (isMockId || realDocs.length === 0) {
    const mockDocs = MOCK_DOCUMENTS.filter((d) => d.applicationId === applicationId);

    if (mockDocs.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Icon name="FolderOpenIcon" size={36} className="text-gray-200 mb-3" />
          <p className="text-sm text-gray-500 font-600">No documents found</p>
          <p className="text-xs text-gray-400 mt-1">Documents submitted with your application will appear here.</p>
        </div>
      );
    }

    const mockApproved = mockDocs.filter((d) => d.status === 'approved').length;
    const mockTotal = mockDocs.filter((d) => d.required).length;
    const mockGrouped = mockDocs.reduce<Record<string, Document[]>>((acc, doc) => {
      if (!acc[doc.category]) acc[doc.category] = [];
      acc[doc.category].push(doc);
      return acc;
    }, {});

    const mockStatusMap: Record<string, { label: string; color: string; icon: string; pillColor: string }> = {
      pending:  { label: 'Pending',   color: 'text-amber-600 bg-amber-50 border-amber-200',     icon: 'ClockIcon',       pillColor: 'text-amber-700 bg-amber-50 border-amber-200' },
      uploaded: { label: 'Submitted', color: 'text-blue-600 bg-blue-50 border-blue-200',         icon: 'ArrowUpTrayIcon', pillColor: 'text-blue-700 bg-blue-50 border-blue-200' },
      approved: { label: 'Approved',  color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: 'CheckCircleIcon', pillColor: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
      rejected: { label: 'Rejected',  color: 'text-red-600 bg-red-50 border-red-200',            icon: 'XCircleIcon',     pillColor: 'text-red-700 bg-red-50 border-red-200' },
    };

    return (
      <>
        {previewDoc && <DocumentPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />}

        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Icon name="FolderOpenIcon" size={15} className="text-gray-400" />
            <h4 className="font-display font-600 text-sm text-gray-900">Document Status</h4>
          </div>
          <span className="text-xs text-gray-400 tabular-nums">{mockDocs.length} document{mockDocs.length !== 1 ? 's' : ''}</span>
        </div>

        {/* Status legend */}
        <DocStatusLegend />

        {/* Progress */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs text-gray-500">{mockApproved} of {mockTotal} required documents approved</p>
          <div className="flex items-center gap-2">
            <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-eb-green-900 rounded-full transition-all" style={{ width: `${mockTotal > 0 ? (mockApproved / mockTotal) * 100 : 0}%` }} />
            </div>
            <span className="text-xs font-display font-700 text-eb-green-900 tabular-nums">{mockTotal > 0 ? Math.round((mockApproved / mockTotal) * 100) : 0}%</span>
          </div>
        </div>

        <div className="space-y-5">
          {Object.entries(mockGrouped).map(([category, categoryDocs]) => (
            <div key={`cat-${category}`}>
              <div className="flex items-center gap-2 mb-2.5">
                <Icon name={(CATEGORY_ICONS[category] || 'FolderIcon') as Parameters<typeof Icon>[0]['name']} size={13} className="text-gray-400" />
                <p className="text-[11px] font-display font-600 uppercase tracking-widest text-gray-400">{category}</p>
              </div>
              <div className="space-y-2">
                {categoryDocs.map((doc) => {
                  const cfg = mockStatusMap[doc.status] ?? mockStatusMap.pending;
                  return (
                    <div
                      key={`doc-${doc.id}`}
                      className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all ${
                        doc.status === 'approved' ? 'bg-emerald-50/50 border-emerald-100' :
                        doc.status === 'rejected' ? 'bg-red-50/50 border-red-100' :
                        doc.status === 'uploaded' ? 'bg-blue-50/50 border-blue-100' : 'bg-gray-50/50 border-gray-100'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${cfg.color}`}>
                        <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium text-gray-800 truncate">{doc.name}</p>
                          {doc.required && <span className="text-[9px] font-display font-700 uppercase tracking-wide text-red-400">Required</span>}
                        </div>
                        {doc.notes && <p className="text-xs text-red-500 mt-0.5">{doc.notes}</p>}
                      </div>
                      <span className={`text-[11px] font-display font-600 px-2.5 py-1 rounded-full border flex-shrink-0 ${cfg.pillColor}`}>
                        {cfg.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  // ── REAL DATA from Supabase ────────────────────────────────────────────────
  const approved = realDocs.filter((d) => d.doc_status === 'approved').length;
  const submitted = realDocs.filter((d) => d.doc_status === 'uploaded').length;
  const rejected = realDocs.filter((d) => d.doc_status === 'rejected').length;
  const actionNeeded = realDocs.filter((d) => d.doc_status === 'resubmit_requested').length;
  const total = realDocs.length;

  const grouped = realDocs.reduce<Record<string, RealDocument[]>>((acc, doc) => {
    const cat = doc.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(doc);
    return acc;
  }, {});

  return (
    <>
      {previewDoc && <DocumentPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon name="FolderOpenIcon" size={15} className="text-gray-400" />
          <h4 className="font-display font-600 text-sm text-gray-900">Document Status</h4>
        </div>
        <span className="text-xs text-gray-400 tabular-nums">{total} document{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Status legend */}
      <DocStatusLegend />

      {/* Summary counts */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div className="flex items-center gap-2 p-2.5 bg-blue-50 border border-blue-100 rounded-xl">
          <Icon name="ArrowUpTrayIcon" size={13} className="text-blue-600 flex-shrink-0" />
          <div>
            <p className="text-[10px] text-blue-500 font-display font-600">Submitted</p>
            <p className="text-sm font-display font-700 text-blue-700 tabular-nums">{submitted}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2.5 bg-emerald-50 border border-emerald-100 rounded-xl">
          <Icon name="CheckCircleIcon" size={13} className="text-emerald-600 flex-shrink-0" />
          <div>
            <p className="text-[10px] text-emerald-500 font-display font-600">Approved</p>
            <p className="text-sm font-display font-700 text-emerald-700 tabular-nums">{approved}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2.5 bg-red-50 border border-red-100 rounded-xl">
          <Icon name="XCircleIcon" size={13} className="text-red-500 flex-shrink-0" />
          <div>
            <p className="text-[10px] text-red-400 font-display font-600">Rejected</p>
            <p className="text-sm font-display font-700 text-red-600 tabular-nums">{rejected}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-2.5 bg-orange-50 border border-orange-100 rounded-xl">
          <Icon name="ArrowPathIcon" size={13} className="text-orange-500 flex-shrink-0" />
          <div>
            <p className="text-[10px] text-orange-400 font-display font-600">Action Needed</p>
            <p className="text-sm font-display font-700 text-orange-600 tabular-nums">{actionNeeded}</p>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-xs text-gray-500">{approved} of {total} document{total !== 1 ? 's' : ''} approved</p>
        <div className="flex items-center gap-2">
          <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-eb-green-900 rounded-full transition-all" style={{ width: `${total > 0 ? (approved / total) * 100 : 0}%` }} />
          </div>
          <span className="text-xs font-display font-700 text-eb-green-900 tabular-nums">{total > 0 ? Math.round((approved / total) * 100) : 0}%</span>
        </div>
      </div>

      <div className="space-y-5">
        {Object.entries(grouped).map(([category, categoryDocs]) => (
          <div key={`cat-${category}`}>
            <div className="flex items-center gap-2 mb-2.5">
              <Icon name={(CATEGORY_ICONS[category] || 'FolderIcon') as Parameters<typeof Icon>[0]['name']} size={13} className="text-gray-400" />
              <p className="text-[11px] font-display font-600 uppercase tracking-widest text-gray-400">{category}</p>
            </div>
            <div className="space-y-2">
              {categoryDocs.map((doc) => {
                const cfg = STATUS_CONFIG[doc.doc_status] ?? STATUS_CONFIG.pending;
                const hasFile = !!doc.file_url;
                const fileType: 'image' | 'pdf' | 'other' = doc.file_url?.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)
                  ? 'image'
                  : doc.file_url?.match(/\.pdf(\?|$)/i)
                  ? 'pdf' : 'other';
                const uploadable = canUpload(doc.doc_status);
                const uploadState = uploadStates[doc.id];
                const isUploading = uploadState?.status === 'uploading';

                return (
                  <div
                    key={`doc-${doc.id}`}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border transition-all ${
                      doc.doc_status === 'approved'            ? 'bg-emerald-50/50 border-emerald-100' :
                      doc.doc_status === 'rejected'            ? 'bg-red-50/50 border-red-100' :
                      doc.doc_status === 'uploaded'            ? 'bg-blue-50/50 border-blue-100' :
                      doc.doc_status === 'resubmit_requested'  ? 'bg-orange-50/50 border-orange-100' : 'bg-gray-50/50 border-gray-100'
                    }`}
                  >
                    {/* Status icon */}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border mt-0.5 ${cfg.color}`}>
                      <Icon name={cfg.icon as Parameters<typeof Icon>[0]['name']} size={14} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{doc.document_name}</p>
                          {doc.uploaded_at && (
                            <p className="text-xs text-gray-400 mt-0.5">
                              Submitted {new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          )}
                          {doc.file_name && (
                            <p className="text-[11px] text-gray-400 mt-0.5 truncate max-w-[180px]" title={doc.file_name}>
                              {doc.file_name}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {/* Status badge */}
                          <span className={`text-[11px] font-display font-600 px-2.5 py-1 rounded-full border ${cfg.pillColor}`}>
                            {cfg.borrowerLabel}
                          </span>
                          {/* View/download if file exists */}
                          {hasFile && (
                            <button
                              onClick={() => setPreviewDoc({ name: doc.document_name, fileUrl: doc.file_url!, fileType })}
                              className="p-1.5 text-gray-400 hover:text-eb-green-700 hover:bg-eb-green-50 rounded-lg transition-all"
                              title="View document"
                            >
                              <Icon name="EyeIcon" size={14} />
                            </button>
                          )}
                          {/* Upload button for actionable statuses */}
                          {uploadable && (
                            <>
                              <input
                                ref={(el) => { fileInputRefs.current[doc.id] = el; }}
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleFileChange(doc, file);
                                  // Reset input so same file can be re-selected
                                  e.target.value = '';
                                }}
                              />
                              <button
                                onClick={() => handleUploadClick(doc.id)}
                                disabled={isUploading}
                                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-display font-600 rounded-lg border transition-all active:scale-95 ${
                                  isUploading
                                    ? 'text-gray-400 bg-gray-50 border-gray-200 cursor-not-allowed'
                                    : doc.doc_status === 'resubmit_requested' ?'text-orange-700 bg-orange-50 border-orange-200 hover:bg-orange-100'
                                    : doc.doc_status === 'rejected' ?'text-red-700 bg-red-50 border-red-200 hover:bg-red-100' :'text-eb-green-800 bg-eb-green-50 border-eb-green-200 hover:bg-eb-green-100'
                                }`}
                                title={doc.doc_status === 'resubmit_requested' ? 'Resubmit document' : 'Upload document'}
                              >
                                {isUploading ? (
                                  <Icon name="ArrowPathIcon" size={12} className="animate-spin" />
                                ) : (
                                  <Icon name="ArrowUpTrayIcon" size={12} />
                                )}
                                {isUploading ? 'Uploading…' : doc.doc_status === 'resubmit_requested' ? 'Resubmit' : 'Upload'}
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Upload progress */}
                      {uploadState && (
                        <UploadProgressBar
                          progress={uploadState.progress}
                          status={uploadState.status}
                          errorMessage={uploadState.errorMessage}
                        />
                      )}

                      {/* Admin notes / resubmit reason visible to borrower */}
                      {!uploadState && doc.doc_status === 'rejected' && doc.admin_notes && (
                        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-2.5 py-2">
                          <Icon name="ExclamationCircleIcon" size={13} className="flex-shrink-0" />
                          <span>{doc.admin_notes}</span>
                        </div>
                      )}
                      {!uploadState && doc.doc_status === 'resubmit_requested' && doc.resubmit_reason && (
                        <div className="mt-2 flex items-start gap-1.5 text-xs text-orange-600 bg-orange-50 border border-orange-100 rounded-lg px-2.5 py-2">
                          <Icon name="ArrowPathIcon" size={13} className="flex-shrink-0" />
                          <span>{doc.resubmit_reason}</span>
                        </div>
                      )}
                      {/* Revision Required banner — shown when review_status = revision_requested */}
                      {!uploadState && doc.review_status === 'revision_requested' && doc.client_revision_message && (
                        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Icon name="ArrowPathIcon" size={12} className="text-amber-600 flex-shrink-0" />
                            <span className="text-[11px] font-display font-700 text-amber-700 uppercase tracking-wide">Revision Required</span>
                          </div>
                          <p className="text-xs text-amber-800 leading-relaxed">{doc.client_revision_message}</p>
                        </div>
                      )}

                      {/* Accepted formats hint for uploadable docs */}
                      {uploadable && !uploadState && (
                        <p className="text-[10px] text-gray-400 mt-1.5">
                          Accepted: PDF, JPG, PNG, WEBP, DOC · Max 50 MB
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}