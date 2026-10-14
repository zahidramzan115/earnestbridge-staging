'use client';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import RevisionUploadModal, { RevisionUploadTarget } from '@/components/RevisionUploadModal';

// ── Normalized document model (hides source table from client) ────────────────
type ReviewStatus = 'uploaded' | 'under_review' | 'revision_requested' | 'approved_final' | 'superseded';
type DocCategory = 'identity' | 'financial' | 'property' | 'legal' | 'other';

// Internal source identifier — never shown to client
type DocSource = 'borrower_documents' | 'application_documents';

interface NormalizedDoc {
  // Shared display fields
  id: string;
  documentName: string;
  category: DocCategory;
  fileUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  uploadedAt: string | null;
  createdAt: string;
  applicationId: string | null;

  // Unified status — review_status takes precedence over legacy doc_status
  reviewStatus: ReviewStatus | null;
  legacyDocStatus: string | null;
  clientRevisionMessage: string | null;

  // Version info (normalized across both tables)
  versionNumber: number | null;       // borrower_documents: version_number; application_documents: revision_number
  isCurrentVersion: boolean | null;
  documentGroupId: string | null;     // borrower_documents: document_group_id; application_documents: thread_id

  // Internal routing — NOT shown to client
  _source: DocSource;
  _documentType: string | null;       // for borrower_documents revision routing
}

interface Deal {
  id: string;
  label: string;
}

// ── Client-facing status display logic ────────────────────────────────────────
// Precedence: revision_requested > under_review > uploaded > approved_final > legacy
function getClientStatusDisplay(doc: NormalizedDoc): { label: string; color: string; bg: string; icon: string } {
  const rs = doc.reviewStatus;

  if (rs === 'revision_requested') {
    return { label: 'Revision Required', color: 'text-amber-700', bg: 'bg-amber-50', icon: 'ExclamationTriangleIcon' };
  }
  if (rs === 'under_review') {
    return { label: 'Under Review', color: 'text-blue-600', bg: 'bg-blue-50', icon: 'ArrowPathIcon' };
  }
  if (rs === 'uploaded') {
    return { label: 'Submitted — Awaiting Review', color: 'text-blue-600', bg: 'bg-blue-50', icon: 'ArrowPathIcon' };
  }
  if (rs === 'approved_final') {
    return { label: 'Approved', color: 'text-emerald-600', bg: 'bg-emerald-50', icon: 'CheckCircleIcon' };
  }
  if (rs === 'superseded') {
    return { label: 'Superseded', color: 'text-gray-400', bg: 'bg-gray-50', icon: 'ArchiveBoxIcon' };
  }

  // Legacy fallback — use doc_status from borrower_documents
  const ls = doc.legacyDocStatus;
  if (ls === 'approved') return { label: 'Approved', color: 'text-emerald-600', bg: 'bg-emerald-50', icon: 'CheckCircleIcon' };
  if (ls === 'rejected') return { label: 'Rejected', color: 'text-red-600', bg: 'bg-red-50', icon: 'XCircleIcon' };
  if (ls === 'resubmit_requested') return { label: 'Resubmit Required', color: 'text-amber-600', bg: 'bg-amber-50', icon: 'ArrowUpTrayIcon' };
  if (ls === 'uploaded') return { label: 'Submitted — Awaiting Review', color: 'text-blue-600', bg: 'bg-blue-50', icon: 'ArrowPathIcon' };
  if (ls === 'expired') return { label: 'Expired', color: 'text-orange-600', bg: 'bg-orange-50', icon: 'ExclamationCircleIcon' };
  return { label: 'Pending Upload', color: 'text-gray-500', bg: 'bg-gray-100', icon: 'ClockIcon' };
}

const CATEGORY_LABELS: Record<DocCategory, string> = {
  identity: 'Identity',
  financial: 'Financial',
  property: 'Property',
  legal: 'Legal',
  other: 'Other',
};

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
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

// ── Map borrower_documents row → NormalizedDoc ────────────────────────────────
function mapBorrowerDoc(row: any): NormalizedDoc {
  return {
    id: row.id,
    documentName: row.document_name,
    category: row.category ?? 'other',
    fileUrl: row.file_url ?? null,
    fileName: row.file_name ?? null,
    fileSize: row.file_size ?? null,
    mimeType: row.mime_type ?? null,
    uploadedAt: row.uploaded_at ?? null,
    createdAt: row.created_at,
    applicationId: row.application_id ?? null,
    reviewStatus: row.review_status ?? null,
    legacyDocStatus: row.doc_status ?? null,
    clientRevisionMessage: row.client_revision_message ?? null,
    versionNumber: row.version_number ?? null,
    isCurrentVersion: row.is_current_version ?? null,
    documentGroupId: row.document_group_id ?? null,
    _source: 'borrower_documents',
    _documentType: row.document_type ?? null,
  };
}

// ── Map application_documents row → NormalizedDoc ────────────────────────────
function mapAppDoc(row: any): NormalizedDoc {
  return {
    id: row.id,
    documentName: row.document_name,
    category: 'other', // application_documents doesn't have a category column
    fileUrl: row.file_url ?? row.storage_path ?? null,
    fileName: row.file_name ?? null,
    fileSize: row.file_size ?? null,
    mimeType: row.mime_type ?? null,
    uploadedAt: row.created_at ?? null,
    createdAt: row.created_at,
    applicationId: row.application_id ?? null,
    reviewStatus: row.review_status ?? null,
    legacyDocStatus: null,
    clientRevisionMessage: row.client_revision_message ?? null,
    versionNumber: row.revision_number ?? null,
    isCurrentVersion: row.is_current_version ?? null,
    documentGroupId: row.thread_id ?? null,
    _source: 'application_documents',
    _documentType: null,
  };
}

// ── Deduplication: only deduplicate where there is a known shared identity ────
// We do NOT fuzzy-deduplicate by filename. Two distinct records = two entries.
// The only known shared identity is if a borrower_documents record has the same
// document_group_id as an application_documents thread_id (not currently the case).
// So we simply return all docs as-is.
function deduplicateDocs(docs: NormalizedDoc[]): NormalizedDoc[] {
  return docs;
}

// ── Filter to current versions only (for the main list) ──────────────────────
// Show only is_current_version=true rows. If a logical group has no current row,
// fall back to the highest version in that group.
function filterCurrentVersions(docs: NormalizedDoc[]): NormalizedDoc[] {
  // Group by (source, documentGroupId). Docs without a groupId are standalone.
  const grouped = new Map<string, NormalizedDoc[]>();
  const standalone: NormalizedDoc[] = [];

  for (const doc of docs) {
    if (!doc.documentGroupId) {
      standalone.push(doc);
      continue;
    }
    const key = `${doc._source}::${doc.documentGroupId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(doc);
  }

  const result: NormalizedDoc[] = [...standalone];

  for (const [, versions] of grouped) {
    // Sort newest first
    const sorted = [...versions].sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
    const current = sorted.find((d) => d.isCurrentVersion === true) ?? sorted[0];
    if (current) result.push(current);
  }

  return result;
}

export default function DocumentsContent() {
  const { user, loading: authLoading } = useAuth();
  const [borrowerDocs, setBorrowerDocs] = useState<NormalizedDoc[]>([]);
  const [appDocs, setAppDocs] = useState<NormalizedDoc[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterDeal, setFilterDeal] = useState<string>('all');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [revisionModalTarget, setRevisionModalTarget] = useState<RevisionUploadTarget | null>(null);

  // Upload form state — new generic uploads go to application_documents
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [uploadFormFile, setUploadFormFile] = useState<File | null>(null);
  const [uploadFormDragOver, setUploadFormDragOver] = useState(false);
  const [uploadFormName, setUploadFormName] = useState('');
  const [uploadFormDeal, setUploadFormDeal] = useState<string>('');
  const [uploadFormSubmitting, setUploadFormSubmitting] = useState(false);
  const [uploadFormProgress, setUploadFormProgress] = useState(0);
  const uploadFormFileRef = useRef<HTMLInputElement | null>(null);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchDocuments = useCallback(async () => {
    if (!user) return;
    const supabase = createClient();
    try {
      const [bdRes, adRes] = await Promise.all([
        supabase
          .from('borrower_documents')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('application_documents')
          .select('id, application_id, user_id, uploaded_by_role, document_name, file_name, file_url, storage_path, file_size, mime_type, created_at, revision_number, thread_id, is_current_version, review_status, client_revision_message, is_admin_response')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
      ]);

      if (bdRes.error) throw bdRes.error;
      setBorrowerDocs((bdRes.data || []).map(mapBorrowerDoc));
      setAppDocs((adRes.data || []).map(mapAppDoc));
    } catch (err: any) {
      setError(err.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [user]);

  const fetchDeals = useCallback(async () => {
    if (!user) return;
    const supabase = createClient();
    try {
      const { data } = await supabase
        .from('borrower_applications')
        .select('id, property_address, company_name, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (data) {
        setDeals(data.map((d: any) => ({
          id: d.id,
          label: d.property_address
            ? d.property_address
            : d.company_name
            ? `${d.company_name} Deal`
            : `Deal ${new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        })));
      }
    } catch {
      // silently fail
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setLoading(false); return; }
    fetchDocuments();
    fetchDeals();
  }, [authLoading, fetchDocuments, fetchDeals]);

  // Real-time subscriptions for both tables
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();

    const bdChannel = supabase
      .channel('documents-bd-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'borrower_documents', filter: `user_id=eq.${user.id}` }, (payload) => {
        if (payload.eventType === 'INSERT') setBorrowerDocs((prev) => [mapBorrowerDoc(payload.new), ...prev]);
        else if (payload.eventType === 'UPDATE') setBorrowerDocs((prev) => prev.map((d) => d.id === payload.new.id ? mapBorrowerDoc(payload.new) : d));
        else if (payload.eventType === 'DELETE') setBorrowerDocs((prev) => prev.filter((d) => d.id !== payload.old.id));
      })
      .subscribe();

    const adChannel = supabase
      .channel('documents-ad-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'application_documents', filter: `user_id=eq.${user.id}` }, (payload) => {
        if (payload.eventType === 'INSERT') setAppDocs((prev) => [mapAppDoc(payload.new), ...prev]);
        else if (payload.eventType === 'UPDATE') setAppDocs((prev) => prev.map((d) => d.id === payload.new.id ? mapAppDoc(payload.new) : d));
        else if (payload.eventType === 'DELETE') setAppDocs((prev) => prev.filter((d) => d.id !== payload.old.id));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(bdChannel);
      supabase.removeChannel(adChannel);
    };
  }, [user]);

  // ── Normalized unified document list ─────────────────────────────────────
  const allCurrentDocs = useMemo(() => {
    const combined = deduplicateDocs([...borrowerDocs, ...appDocs]);
    const current = filterCurrentVersions(combined);
    // Sort: revision_requested first, then uploaded, then under_review, then approved, then rest
    const priority: Record<string, number> = {
      revision_requested: 0,
      uploaded: 1,
      under_review: 2,
      approved_final: 3,
      superseded: 4,
    };
    return current.sort((a, b) => {
      const pa = priority[a.reviewStatus ?? ''] ?? 5;
      const pb = priority[b.reviewStatus ?? ''] ?? 5;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [borrowerDocs, appDocs]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = allCurrentDocs.length;
    const approved = allCurrentDocs.filter((d) => d.reviewStatus === 'approved_final' || d.legacyDocStatus === 'approved').length;
    const action = allCurrentDocs.filter((d) => {
      if (d.reviewStatus === 'revision_requested') return true;
      if (!d.reviewStatus && (d.legacyDocStatus === 'resubmit_requested' || d.legacyDocStatus === 'rejected')) return true;
      return false;
    }).length;
    return { total, approved, action };
  }, [allCurrentDocs]);

  // ── Filtered docs ─────────────────────────────────────────────────────────
  const filteredDocs = useMemo(() => {
    if (filterDeal === 'all') return allCurrentDocs;
    if (filterDeal === 'unassigned') return allCurrentDocs.filter((d) => !d.applicationId);
    return allCurrentDocs.filter((d) => d.applicationId === filterDeal);
  }, [allCurrentDocs, filterDeal]);

  // ── New generic upload → application_documents ────────────────────────────
  const handleUploadFormFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setUploadFormDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) { setUploadFormFile(file); if (!uploadFormName) setUploadFormName(file.name.replace(/\.[^.]+$/, '')); }
  };

  const handleUploadFormFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) { setUploadFormFile(file); if (!uploadFormName) setUploadFormName(file.name.replace(/\.[^.]+$/, '')); }
    e.target.value = '';
  };

  const resetUploadForm = () => {
    setUploadFormFile(null);
    setUploadFormName('');
    setUploadFormDeal('');
    setUploadFormProgress(0);
    setShowUploadForm(false);
  };

  // New generic uploads go to application_documents via /api/upload-document
  const handleUploadFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !uploadFormFile) return;
    if (!ACCEPTED_TYPES.includes(uploadFormFile.type)) { showToast('File type not supported. Use PDF, JPG, PNG, or DOCX.', 'error'); return; }
    if (uploadFormFile.size > MAX_FILE_SIZE) { showToast('File exceeds 50MB limit.', 'error'); return; }
    if (!uploadFormName.trim()) { showToast('Please enter a document name.', 'error'); return; }
    if (!uploadFormDeal) { showToast('Please assign this document to a deal.', 'error'); return; }

    setUploadFormSubmitting(true);
    setUploadFormProgress(0);

    try {
      const progressInterval = setInterval(() => {
        setUploadFormProgress((prev) => { if (prev >= 80) { clearInterval(progressInterval); return prev; } return prev + 15; });
      }, 200);

      const fd = new FormData();
      fd.append('file', uploadFormFile);
      fd.append('applicationId', uploadFormDeal);
      fd.append('userId', user.id);
      fd.append('documentName', uploadFormName.trim());
      fd.append('uploadedByRole', 'borrower');
      fd.append('tableTarget', 'application_documents');

      const res = await fetch('/api/upload-document', { method: 'POST', body: fd });
      clearInterval(progressInterval);

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Upload failed');
      }

      setUploadFormProgress(100);
      showToast(`${uploadFormFile.name} uploaded successfully.`, 'success');
      resetUploadForm();
    } catch (err: any) {
      showToast(err.message || 'Upload failed. Please try again.', 'error');
    } finally {
      setUploadFormSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading your documents…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Icon name="ExclamationCircleIcon" size={40} className="text-red-400 mx-auto mb-3" />
          <p className="font-display font-600 text-gray-900 mb-1">Failed to load documents</p>
          <p className="text-sm text-gray-500 mb-4">{error}</p>
          <button onClick={fetchDocuments} className="px-4 py-2 bg-eb-green-900 text-white rounded-lg text-sm font-medium hover:bg-eb-green-800 transition-colors">
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Revision Upload Modal */}
      {revisionModalTarget && (
        <RevisionUploadModal
          target={revisionModalTarget}
          onClose={() => setRevisionModalTarget(null)}
          onSuccess={() => {
            fetchDocuments();
            showToast('Revision uploaded successfully. EarnestBridge will review the new version.', 'success');
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-fade-in ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <Icon name={toast.type === 'success' ? 'CheckCircleIcon' : 'XCircleIcon'} size={18} />
          {toast.message}
        </div>
      )}

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <div className="flex-1">
          <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Documents</h1>
          <p className="text-sm text-gray-400 mt-0.5">Upload, track, and manage all documents for your deals.</p>
        </div>
        {deals.length > 0 && (
          <button
            onClick={() => setShowUploadForm(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-eb-green-900 text-white rounded-xl text-sm font-display font-600 hover:bg-eb-green-800 transition-colors flex-shrink-0"
          >
            <Icon name="ArrowUpTrayIcon" size={16} />
            Upload Document
          </button>
        )}
      </div>

      {/* ── Upload Document Form ─────────────────────────────────────────── */}
      {showUploadForm && (
        <div className="bg-white rounded-2xl border border-eb-green-900/20 shadow-card mb-6 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-eb-green-50">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-eb-green-900 rounded-lg flex items-center justify-center">
                <Icon name="ArrowUpTrayIcon" size={16} className="text-white" />
              </div>
              <div>
                <p className="font-display font-700 text-gray-900 text-sm">Upload New Document</p>
                <p className="text-xs text-gray-500">Attach a file and assign it to a deal</p>
              </div>
            </div>
            <button onClick={resetUploadForm} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
              <Icon name="XMarkIcon" size={18} />
            </button>
          </div>

          <form onSubmit={handleUploadFormSubmit} className="p-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              {/* Drop zone */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-display font-600 text-gray-700 mb-1.5">File <span className="text-red-500">*</span></label>
                <div
                  className={`relative border-2 border-dashed rounded-xl transition-all cursor-pointer ${uploadFormDragOver ? 'border-eb-green-900 bg-eb-green-50' : uploadFormFile ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-gray-300 bg-gray-50'}`}
                  onDragOver={(e) => { e.preventDefault(); setUploadFormDragOver(true); }}
                  onDragLeave={() => setUploadFormDragOver(false)}
                  onDrop={handleUploadFormFileDrop}
                  onClick={() => uploadFormFileRef.current?.click()}
                >
                  <input ref={uploadFormFileRef} type="file" accept={ACCEPTED_TYPES.join(',')} className="hidden" onChange={handleUploadFormFileChange} />
                  {uploadFormFile ? (
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="w-9 h-9 bg-emerald-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Icon name="DocumentCheckIcon" size={18} className="text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-display font-600 text-gray-900 truncate">{uploadFormFile.name}</p>
                        <p className="text-xs text-gray-500">{formatBytes(uploadFormFile.size)}</p>
                      </div>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setUploadFormFile(null); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-emerald-100 text-emerald-600 transition-colors">
                        <Icon name="XMarkIcon" size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-6 gap-2">
                      <Icon name="ArrowUpTrayIcon" size={24} className={uploadFormDragOver ? 'text-eb-green-900' : 'text-gray-400'} />
                      <p className="text-sm text-gray-600 font-display font-500"><span className="text-eb-green-900 font-600 underline">Browse</span> or drag & drop</p>
                      <p className="text-xs text-gray-400">PDF, JPG, PNG, DOCX · Max 50MB</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Document name */}
              <div>
                <label className="block text-xs font-display font-600 text-gray-700 mb-1.5">Document Name <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={uploadFormName}
                  onChange={(e) => setUploadFormName(e.target.value)}
                  placeholder="e.g. Bank Statement – March 2025"
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-900/10 transition-all placeholder-gray-400 font-display"
                  required
                />
              </div>

              {/* Assign to Deal — required for application_documents */}
              <div>
                <label className="block text-xs font-display font-600 text-gray-700 mb-1.5">
                  Assign to Deal <span className="text-red-500">*</span>
                </label>
                {deals.length === 0 ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-400">
                    <Icon name="InformationCircleIcon" size={15} className="text-gray-400 flex-shrink-0" />
                    No deals found. Submit an application first.
                  </div>
                ) : (
                  <div className="relative">
                    <select
                      value={uploadFormDeal}
                      onChange={(e) => setUploadFormDeal(e.target.value)}
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl outline-none focus:border-eb-green-900 focus:ring-2 focus:ring-eb-green-900/10 transition-all bg-white appearance-none font-display cursor-pointer"
                      required
                    >
                      <option value="">— Select a deal —</option>
                      {deals.map((d) => (
                        <option key={d.id} value={d.id}>{d.label}</option>
                      ))}
                    </select>
                    <Icon name="ChevronDownIcon" size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  </div>
                )}
              </div>
            </div>

            {uploadFormSubmitting && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                  <span className="font-display font-600">Uploading…</span>
                  <span>{uploadFormProgress}%</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-eb-green-900 rounded-full transition-all duration-300" style={{ width: `${uploadFormProgress}%` }} />
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={resetUploadForm} disabled={uploadFormSubmitting} className="px-4 py-2 text-sm font-display font-600 text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors disabled:opacity-50">Cancel</button>
              <button type="submit" disabled={uploadFormSubmitting || !uploadFormFile || !uploadFormDeal} className="flex items-center gap-2 px-5 py-2 text-sm font-display font-600 text-white bg-eb-green-900 rounded-xl hover:bg-eb-green-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {uploadFormSubmitting ? (
                  <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Uploading…</>
                ) : (
                  <><Icon name="ArrowUpTrayIcon" size={15} />Upload Document</>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Total Documents', value: stats.total, icon: 'FolderOpenIcon', color: 'text-gray-700', bg: 'bg-gray-50' },
          { label: 'Approved', value: stats.approved, icon: 'CheckCircleIcon', color: 'text-emerald-600', bg: 'bg-emerald-50' },
          { label: 'Action Required', value: stats.action, icon: 'ExclamationTriangleIcon', color: stats.action > 0 ? 'text-red-600' : 'text-gray-400', bg: stats.action > 0 ? 'bg-red-50' : 'bg-gray-50' },
        ].map((stat) => (
          <div key={stat.label} className={`${stat.bg} rounded-2xl p-4 border border-white shadow-sm`}>
            <div className="flex items-center gap-2 mb-1">
              <Icon name={stat.icon as Parameters<typeof Icon>[0]['name']} size={16} className={stat.color} />
              <span className="text-xs text-gray-500 font-display font-600">{stat.label}</span>
            </div>
            <p className={`font-display font-800 text-2xl ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Deal filter */}
      {deals.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          <div className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-xl px-3 py-2 shadow-sm">
            <Icon name="BuildingOfficeIcon" size={14} className="text-gray-400" />
            <select
              value={filterDeal}
              onChange={(e) => setFilterDeal(e.target.value)}
              className="text-sm text-gray-700 bg-transparent outline-none cursor-pointer font-display font-500 max-w-[200px]"
            >
              <option value="all">All Deals</option>
              <option value="unassigned">Unassigned</option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </div>
          {filterDeal !== 'all' && (
            <button
              onClick={() => setFilterDeal('all')}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 px-3 py-2 bg-white border border-gray-200 rounded-xl shadow-sm transition-colors"
            >
              <Icon name="XMarkIcon" size={14} />
              Clear
            </button>
          )}
        </div>
      )}

      {/* Document list */}
      {filteredDocs.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-12 text-center">
          <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Icon name="FolderOpenIcon" size={32} className="text-gray-300" />
          </div>
          <p className="font-display font-600 text-gray-900 mb-1">No documents found</p>
          <p className="text-sm text-gray-400">
            {filterDeal !== 'all' ?'No documents for this deal.' :'Your documents will appear here once you submit an application or upload a file.'}
          </p>
          {filterDeal === 'all' && deals.length > 0 && (
            <button
              onClick={() => setShowUploadForm(true)}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-eb-green-900 text-white rounded-xl text-sm font-display font-600 hover:bg-eb-green-800 transition-colors"
            >
              <Icon name="ArrowUpTrayIcon" size={15} />
              Upload Your First Document
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredDocs.map((doc) => (
            <NormalizedDocCard
              key={`${doc._source}::${doc.id}`}
              doc={doc}
              deals={deals}
              onUploadRevision={setRevisionModalTarget}
              onRefresh={fetchDocuments}
              showToast={showToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── NormalizedDocCard ─────────────────────────────────────────────────────────
interface NormalizedDocCardProps {
  doc: NormalizedDoc;
  deals: Deal[];
  onUploadRevision: (target: RevisionUploadTarget) => void;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}

function NormalizedDocCard({ doc, deals, onUploadRevision }: NormalizedDocCardProps) {
  const statusDisplay = getClientStatusDisplay(doc);
  const isRevisionRequested = doc.reviewStatus === 'revision_requested' && doc.isCurrentVersion !== false;
  const dealLabel = doc.applicationId ? deals.find((d) => d.id === doc.applicationId)?.label : null;
  const [viewLoading, setViewLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);

  const supabase = useMemo(() => createClient(), []);

  const getSignedUrl = async (expiresIn = 3600): Promise<string | null> => {
    if (!doc.fileUrl) return null;
    const bucket = doc._source === 'borrower_documents' ? 'borrower-documents' : 'application-documents';
    let storagePath = doc.fileUrl;
    // Strip full URL prefix if present
    const publicMarker = `/object/public/${bucket}/`;
    const signedMarker = `/object/sign/${bucket}/`;
    if (storagePath.includes(publicMarker)) storagePath = storagePath.split(publicMarker)[1].split('?')[0];
    else if (storagePath.includes(signedMarker)) storagePath = storagePath.split(signedMarker)[1].split('?')[0];
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  };

  const handleView = async () => {
    setViewLoading(true);
    try {
      const url = await getSignedUrl(3600);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } finally { setViewLoading(false); }
  };

  const handleDownload = async () => {
    if (!doc.fileUrl) return;
    setDownloadLoading(true);
    try {
      const url = await getSignedUrl(300);
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.fileName || doc.documentName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally { setDownloadLoading(false); }
  };

  return (
    <div className={`bg-white rounded-2xl border shadow-card transition-all duration-200 overflow-hidden ${
      isRevisionRequested ? 'border-l-4 border-l-amber-400 border-gray-100' : 'border-gray-100'
    }`}>
      <div className="p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          {/* Icon */}
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${statusDisplay.bg}`}>
            <Icon name={statusDisplay.icon as Parameters<typeof Icon>[0]['name']} size={20} className={statusDisplay.color} />
          </div>

          {/* Main info */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h3 className="font-display font-600 text-gray-900 text-sm">{doc.documentName}</h3>
              <span className={`inline-flex items-center gap-1 text-[11px] font-display font-600 px-2 py-0.5 rounded-full ${statusDisplay.bg} ${statusDisplay.color}`}>
                <Icon name={statusDisplay.icon as Parameters<typeof Icon>[0]['name']} size={11} />
                {statusDisplay.label}
              </span>
              {doc.versionNumber && doc.versionNumber > 1 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 px-2 py-0.5 rounded-full">
                  v{doc.versionNumber}
                </span>
              )}
              {dealLabel && (
                <span className="inline-flex items-center gap-1 text-[11px] text-eb-green-900 bg-eb-green-50 px-2 py-0.5 rounded-full font-display font-600 border border-eb-green-900/10">
                  <Icon name="BuildingOfficeIcon" size={10} />
                  {dealLabel}
                </span>
              )}
            </div>

            {/* File info */}
            {doc.fileName && (
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                <Icon name="DocumentIcon" size={12} className="text-gray-400" />
                <span className="truncate max-w-[200px]">{doc.fileName}</span>
                {doc.fileSize && <span className="text-gray-400">({formatBytes(doc.fileSize)})</span>}
                {doc.uploadedAt && <span className="text-gray-400">· Uploaded {formatDate(doc.uploadedAt)}</span>}
              </div>
            )}

            {/* Revision Required banner */}
            {isRevisionRequested && doc.clientRevisionMessage && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 mb-2">
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon name="ExclamationTriangleIcon" size={12} className="text-amber-600 flex-shrink-0" />
                  <span className="text-[11px] font-display font-700 text-amber-700 uppercase tracking-wide">Revision Required</span>
                </div>
                <p className="text-xs text-amber-800 leading-relaxed">{doc.clientRevisionMessage}</p>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            {doc.fileUrl && (
              <>
                <button onClick={handleView} disabled={viewLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50">
                  {viewLoading ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : <Icon name="EyeIcon" size={13} />}
                  View
                </button>
                <button onClick={handleDownload} disabled={downloadLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 rounded-lg hover:bg-eb-green-100 transition-colors disabled:opacity-50">
                  {downloadLoading ? <Icon name="ArrowPathIcon" size={13} className="animate-spin" /> : <Icon name="ArrowDownTrayIcon" size={13} />}
                  Download
                </button>
              </>
            )}
            {/* Revision upload CTA for borrower_documents threads */}
            {isRevisionRequested && doc._source === 'borrower_documents' && doc.documentGroupId && doc.applicationId && doc.clientRevisionMessage && (
              <button
                onClick={() => onUploadRevision({
                  tableTarget: 'borrower_documents',
                  documentGroupId: doc.documentGroupId!,
                  applicationId: doc.applicationId!,
                  documentName: doc.documentName,
                  currentVersion: doc.versionNumber ?? 1,
                  clientRevisionMessage: doc.clientRevisionMessage!,
                  documentType: doc._documentType ?? 'user_upload',
                  category: doc.category,
                })}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors active:scale-95"
              >
                <Icon name="ArrowUpTrayIcon" size={13} />
                Upload Revised Document
              </button>
            )}
            {/* Revision upload CTA for application_documents threads */}
            {isRevisionRequested && doc._source === 'application_documents' && doc.documentGroupId && doc.applicationId && doc.clientRevisionMessage && (
              <button
                onClick={() => onUploadRevision({
                  tableTarget: 'application_documents',
                  documentGroupId: doc.documentGroupId!,
                  applicationId: doc.applicationId!,
                  documentName: doc.documentName,
                  currentVersion: doc.versionNumber ?? 1,
                  clientRevisionMessage: doc.clientRevisionMessage!,
                  documentType: 'user_upload',
                  category: 'other',
                })}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors active:scale-95"
              >
                <Icon name="ArrowUpTrayIcon" size={13} />
                Upload Revised Document
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
