'use client';
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import RevisionUploadModal, { RevisionUploadTarget } from '@/components/RevisionUploadModal';

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const MAX_FILE_SIZE = 52428800; // 50 MB

interface AppDocument {
  id: string;
  application_id: string;
  user_id: string;
  uploaded_by_role: string;
  uploader_email: string | null;
  document_name: string;
  file_name: string;
  file_url: string | null;
  storage_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  description: string | null;
  feedback: string | null;
  is_admin_response: boolean | null;
  created_at: string;
  parent_document_id: string | null;
  revision_number: number;
  thread_id: string | null;
  // Review fields (client-safe subset only — review_notes/reviewed_by/reviewed_at are never fetched here)
  review_status: string | null;
  client_revision_message: string | null;
}

interface DocumentThread {
  threadId: string;
  rootDoc: AppDocument;
  revisions: AppDocument[]; // all docs in this thread, sorted oldest→newest
}

interface UploadItem {
  id: string;
  file: File;
  name: string;
  feedback: string;
  progress: number;
  status: 'pending' | 'uploading' | 'success' | 'error';
  errorMessage?: string;
  // For revision uploads — which thread/doc this is responding to
  replyToThreadId?: string;
  replyToDocId?: string;
  replyToRevisionNumber?: number;
}

interface PreviewDoc {
  name: string;
  fileUrl: string;
  fileType: 'image' | 'pdf' | 'other';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function getFileType(mimeType: string | null, fileName: string): 'image' | 'pdf' | 'other' {
  if (!mimeType && !fileName) return 'other';
  if (mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(fileName)) return 'image';
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(fileName)) return 'pdf';
  return 'other';
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

interface ApplicationDocumentUploadProps {
  applicationId: string;
  isAdmin?: boolean;
  borrowerUserId?: string;
}

export default function ApplicationDocumentUpload({
  applicationId,
  isAdmin = false,
  borrowerUserId,
}: ApplicationDocumentUploadProps) {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<AppDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const [showUploadArea, setShowUploadArea] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<PreviewDoc | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [revisionModalTarget, setRevisionModalTarget] = useState<RevisionUploadTarget | null>(null);
  // Track which thread is expanded to show full history
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  // Track which thread is showing a reply upload form
  const [replyingToThread, setReplyingToThread] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replyFileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);

  const isMockApp = applicationId.startsWith('app-') || applicationId.startsWith('mock-') || applicationId.startsWith('demo-');

  // Fetch documents
  const fetchDocuments = useCallback(async () => {
    if (isMockApp || !user) { setLoading(false); return; }
    const supabase = createClient();
    const { data } = await supabase
      .from('application_documents')
      .select('id, application_id, user_id, uploaded_by_role, uploader_email, document_name, file_name, file_url, storage_path, file_size, mime_type, description, feedback, is_admin_response, created_at, parent_document_id, revision_number, thread_id, review_status, client_revision_message')
      .eq('application_id', applicationId)
      .order('created_at', { ascending: true });
    if (data) setDocuments(data as AppDocument[]);
    setLoading(false);
  }, [applicationId, user, isMockApp]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // Real-time subscription
  useEffect(() => {
    if (isMockApp || !user) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`app-docs-${applicationId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'application_documents',
        filter: `application_id=eq.${applicationId}`,
      }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setDocuments((prev) => {
            const exists = prev.some((d) => d.id === (payload.new as AppDocument).id);
            return exists ? prev : [...prev, payload.new as AppDocument].sort(
              (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );
          });
        } else if (payload.eventType === 'DELETE') {
          setDocuments((prev) => prev.filter((d) => d.id !== (payload.old as AppDocument).id));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [applicationId, user, isMockApp]);

  // Log audit event
  const logAuditEvent = useCallback(async (
    eventType: 'document_upload' | 'document_download' | 'document_access',
    description: string,
    resourceId?: string,
  ) => {
    if (!user || isMockApp) return;
    try {
      const supabase = createClient();
      await supabase.from('audit_logs').insert({
        admin_id: user.id,
        admin_email: user.email ?? '',
        event_type: eventType,
        resource_type: 'application_document',
        resource_id: resourceId ?? applicationId,
        borrower_id: borrowerUserId ?? (isAdmin ? null : user.id),
        borrower_email: isAdmin ? null : user.email,
        description,
      });
    } catch {
      // Non-fatal
    }
  }, [user, applicationId, isAdmin, borrowerUserId, isMockApp]);

  // Validate file
  const validateFile = (file: File): string | null => {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return 'File type not allowed. Please upload PDF, JPG, PNG, WEBP, or DOC files.';
    }
    if (file.size > MAX_FILE_SIZE) {
      return 'File exceeds 50 MB limit. Please upload a smaller file.';
    }
    return null;
  };

  // Add files to queue (for new top-level uploads)
  const addFilesToQueue = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const newItems: UploadItem[] = fileArray.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      name: file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
      feedback: '',
      progress: 0,
      status: 'pending',
    }));
    setUploadQueue((prev) => [...prev, ...newItems]);
    setShowUploadArea(true);
  }, []);

  // Add a reply file to queue (linked to a thread)
  const addReplyToQueue = useCallback((
    files: FileList | File[],
    threadId: string,
    latestDocId: string,
    latestRevisionNumber: number,
  ) => {
    const fileArray = Array.from(files);
    const newItems: UploadItem[] = fileArray.map((file) => ({
      id: `reply-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      name: file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
      feedback: '',
      progress: 0,
      status: 'pending',
      replyToThreadId: threadId,
      replyToDocId: latestDocId,
      replyToRevisionNumber: latestRevisionNumber,
    }));
    setUploadQueue((prev) => [...prev, ...newItems]);
  }, []);

  // Upload a single file
  const uploadFile = useCallback(async (item: UploadItem) => {
    if (!user) return;

    const validationError = validateFile(item.file);
    if (validationError) {
      setUploadQueue((prev) => prev.map((q) =>
        q.id === item.id ? { ...q, status: 'error', errorMessage: validationError } : q
      ));
      return;
    }

    setUploadQueue((prev) => prev.map((q) =>
      q.id === item.id ? { ...q, status: 'uploading', progress: 10 } : q
    ));

    const progressInterval = setInterval(() => {
      setUploadQueue((prev) => prev.map((q) => {
        if (q.id !== item.id || q.status !== 'uploading') return q;
        const next = Math.min(q.progress + Math.floor(Math.random() * 15 + 5), 85);
        return { ...q, progress: next };
      }));
    }, 400);

    try {
      const fd = new FormData();
      fd.append('file', item.file);
      fd.append('applicationId', applicationId);
      fd.append('userId', user.id);
      fd.append('documentName', item.name || item.file.name.replace(/\.[^.]+$/, ''));
      fd.append('uploadedByRole', isAdmin ? 'admin' : 'borrower');
      if (user.email) fd.append('uploaderEmail', user.email);
      if (item.feedback.trim()) fd.append('feedback', item.feedback.trim());

      // Revision chain fields
      if (item.replyToThreadId) fd.append('threadId', item.replyToThreadId);
      if (item.replyToDocId) fd.append('parentDocumentId', item.replyToDocId);
      if (item.replyToRevisionNumber != null) {
        fd.append('revisionNumber', String(item.replyToRevisionNumber + 1));
      }

      const res = await fetch('/api/upload-document', {
        method: 'POST',
        body: fd,
      });

      clearInterval(progressInterval);
      const json = await res.json();

      if (!res.ok || json.error) {
        setUploadQueue((prev) => prev.map((q) =>
          q.id === item.id ? { ...q, status: 'error', errorMessage: json.error || 'Upload failed. Please try again.' } : q
        ));
        return;
      }

      setUploadQueue((prev) => prev.map((q) =>
        q.id === item.id ? { ...q, status: 'success', progress: 100 } : q
      ));

      await logAuditEvent(
        'document_upload',
        `${isAdmin ? 'Admin' : 'Borrower'} uploaded ${item.replyToThreadId ? 'revision' : 'document'} "${item.name || item.file.name}" for application ${applicationId.slice(0, 8).toUpperCase()}`,
        json.document?.id,
      );

      // Close reply form for this thread after success
      if (item.replyToThreadId) {
        setTimeout(() => {
          setReplyingToThread(null);
          setUploadQueue((prev) => prev.filter((q) => q.id !== item.id));
        }, 2000);
      } else {
        setTimeout(() => {
          setUploadQueue((prev) => prev.filter((q) => q.id !== item.id));
        }, 3000);
      }

    } catch (err) {
      clearInterval(progressInterval);
      const message = err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.';
      setUploadQueue((prev) => prev.map((q) =>
        q.id === item.id ? { ...q, status: 'error', errorMessage: message } : q
      ));
    }
  }, [user, applicationId, isAdmin, logAuditEvent]);

  const uploadAll = useCallback(() => {
    const pending = uploadQueue.filter((q) => q.status === 'pending' && !q.replyToThreadId);
    pending.forEach((item) => uploadFile(item));
  }, [uploadQueue, uploadFile]);

  const uploadReply = useCallback((threadId: string) => {
    const pending = uploadQueue.filter((q) => q.status === 'pending' && q.replyToThreadId === threadId);
    pending.forEach((item) => uploadFile(item));
  }, [uploadQueue, uploadFile]);

  // Get a fresh signed URL
  const getFreshSignedUrl = useCallback(async (storagePath: string): Promise<string | null> => {
    const supabase = createClient();
    const { data } = await supabase.storage
      .from('borrower-documents')
      .createSignedUrl(storagePath, 60 * 60 * 2);
    return data?.signedUrl ?? null;
  }, []);

  const handleDownload = useCallback(async (doc: AppDocument) => {
    let url = doc.file_url;
    if (doc.storage_path) {
      const fresh = await getFreshSignedUrl(doc.storage_path);
      if (fresh) url = fresh;
    }
    if (!url) return;
    const link = window.document.createElement('a');
    link.href = url;
    link.download = doc.file_name;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
    await logAuditEvent('document_download', `${isAdmin ? 'Admin' : 'Borrower'} downloaded "${doc.document_name}"`, doc.id);
  }, [logAuditEvent, isAdmin, getFreshSignedUrl]);

  const handleView = useCallback(async (doc: AppDocument) => {
    let url = doc.file_url;
    if (doc.storage_path) {
      const fresh = await getFreshSignedUrl(doc.storage_path);
      if (fresh) url = fresh;
    }
    if (!url) return;
    setPreviewDoc({
      name: doc.document_name,
      fileUrl: url,
      fileType: getFileType(doc.mime_type, doc.file_name),
    });
    await logAuditEvent('document_access', `${isAdmin ? 'Admin' : 'Borrower'} viewed "${doc.document_name}"`, doc.id);
  }, [logAuditEvent, isAdmin, getFreshSignedUrl]);

  const handleDelete = useCallback(async (docId: string) => {
    if (!user) return;
    setDeletingId(docId);
    const doc = documents.find((d) => d.id === docId);
    try {
      await fetch('/api/upload-document', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: docId, storagePath: doc?.storage_path ?? null }),
      });
    } catch { /* Non-fatal */ }
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
    setDeletingId(null);
    setConfirmDelete(null);
  }, [user, documents]);

  // Drag handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current++; setIsDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current = 0; setIsDragging(false);
    if (e.dataTransfer.files.length > 0) addFilesToQueue(e.dataTransfer.files);
  }, [addFilesToQueue]);

  // ── Build document threads ────────────────────────────────────────────────
  const threads: DocumentThread[] = React.useMemo(() => {
    // Group by thread_id; fall back to id for legacy docs without thread_id
    const threadMap = new Map<string, AppDocument[]>();
    for (const doc of documents) {
      const key = doc.thread_id ?? doc.id;
      if (!threadMap.has(key)) threadMap.set(key, []);
      threadMap.get(key)!.push(doc);
    }

    const result: DocumentThread[] = [];
    for (const [threadId, docs] of threadMap.entries()) {
      const sorted = [...docs].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const rootDoc = sorted[0];
      result.push({ threadId, rootDoc, revisions: sorted });
    }

    // Sort threads by root doc date, newest first
    return result.sort(
      (a, b) => new Date(b.rootDoc.created_at).getTime() - new Date(a.rootDoc.created_at).getTime()
    );
  }, [documents]);

  const pendingCount = uploadQueue.filter((q) => q.status === 'pending' && !q.replyToThreadId).length;
  const uploadingCount = uploadQueue.filter((q) => q.status === 'uploading' && !q.replyToThreadId).length;
  const hasQueue = uploadQueue.filter((q) => !q.replyToThreadId).length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Icon name="ArrowPathIcon" size={18} className="animate-spin text-eb-green-600" />
        <span className="ml-2 text-sm text-gray-400">Loading documents…</span>
      </div>
    );
  }

  return (
    <>
      {previewDoc && (
        <DocumentPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}

      {/* Revision Upload Modal */}
      {revisionModalTarget && (
        <RevisionUploadModal
          target={revisionModalTarget}
          onClose={() => setRevisionModalTarget(null)}
          onSuccess={() => {
            fetchDocuments();
          }}
        />
      )}

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                <Icon name="TrashIcon" size={18} className="text-red-500" />
              </div>
              <div>
                <p className="font-display font-700 text-gray-900 text-sm">Delete Document?</p>
                <p className="text-xs text-gray-400 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 text-sm font-display font-600 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                disabled={!!deletingId}
                className="flex-1 px-4 py-2 text-sm font-display font-600 text-white bg-red-500 hover:bg-red-600 rounded-xl transition-colors disabled:opacity-50"
              >
                {deletingId ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="PaperClipIcon" size={15} className="text-gray-400" />
            <h4 className="font-display font-600 text-sm text-gray-900">
              {isAdmin ? 'Application Documents' : 'Documents'}
            </h4>
            {documents.length > 0 && (
              <span className="text-[11px] font-display font-600 text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {documents.length}
              </span>
            )}
          </div>
          <button
            onClick={() => setShowUploadArea((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 rounded-lg transition-all active:scale-95"
          >
            <Icon name="ArrowUpTrayIcon" size={12} />
            {isAdmin ? 'Upload to Borrower' : 'Upload'}
          </button>
        </div>

        {/* Top-level upload area */}
        {showUploadArea && (
          <div className="space-y-3">
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-dashed cursor-pointer transition-all ${
                isDragging
                  ? 'border-eb-green-500 bg-eb-green-50 scale-[1.01]'
                  : 'border-gray-200 bg-gray-50 hover:border-eb-green-400 hover:bg-eb-green-50/50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) addFilesToQueue(e.target.files);
                  e.target.value = '';
                }}
              />
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                isDragging ? 'bg-eb-green-100' : 'bg-white border border-gray-200'
              }`}>
                <Icon
                  name={isDragging ? 'ArrowDownTrayIcon' : 'CloudArrowUpIcon'}
                  size={22}
                  className={isDragging ? 'text-eb-green-600' : 'text-gray-400'}
                />
              </div>
              <div className="text-center">
                <p className="text-sm font-display font-600 text-gray-700">
                  {isDragging ? 'Drop files here' : isAdmin ? 'Upload documents for borrower' : 'Drag & drop files here'}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">or click to browse</p>
              </div>
              <p className="text-[11px] text-gray-400">PDF, JPG, PNG, WEBP, DOC · Max 50 MB per file</p>
            </div>

            {hasQueue && (
              <div className="space-y-2">
                {uploadQueue.filter((q) => !q.replyToThreadId).map((item) => (
                  <UploadQueueItem
                    key={item.id}
                    item={item}
                    isAdmin={isAdmin}
                    onNameChange={(name) => setUploadQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, name } : q))}
                    onFeedbackChange={(feedback) => setUploadQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, feedback } : q))}
                    onRemove={() => setUploadQueue((prev) => prev.filter((q) => q.id !== item.id))}
                  />
                ))}
                {pendingCount > 0 && (
                  <button
                    onClick={uploadAll}
                    disabled={uploadingCount > 0}
                    className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-display font-600 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-xl transition-all active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <Icon name="ArrowUpTrayIcon" size={14} />
                    {isAdmin
                      ? `Send ${pendingCount} document${pendingCount !== 1 ? 's' : ''} to Borrower`
                      : `Upload ${pendingCount} file${pendingCount !== 1 ? 's' : ''}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Document Threads ─────────────────────────────────────────────── */}
        {threads.length > 0 && (
          <div className="space-y-3">
            {threads.map((thread) => {
              const latestDoc = thread.revisions[thread.revisions.length - 1];
              const hasMultipleRevisions = thread.revisions.length > 1;
              const isExpanded = expandedThreads.has(thread.threadId);
              const isReplying = replyingToThread === thread.threadId;
              const replyQueueItems = uploadQueue.filter((q) => q.replyToThreadId === thread.threadId);
              const pendingReplies = replyQueueItems.filter((q) => q.status === 'pending').length;
              const uploadingReplies = replyQueueItems.filter((q) => q.status === 'uploading').length;

              return (
                <div
                  key={thread.threadId}
                  className="rounded-xl border border-gray-200 bg-white overflow-hidden"
                >
                  {/* Thread header — shows the latest document */}
                  <div className="flex items-start gap-3 p-3.5">
                    {/* File icon */}
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
                      latestDoc.uploaded_by_role === 'admin' ? 'bg-eb-green-100' : 'bg-blue-50'
                    }`}>
                      <Icon
                        name={getFileType(latestDoc.mime_type, latestDoc.file_name) === 'image' ? 'PhotoIcon' : 'DocumentTextIcon'}
                        size={16}
                        className={latestDoc.uploaded_by_role === 'admin' ? 'text-eb-green-700' : 'text-blue-600'}
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-display font-600 text-gray-900 truncate max-w-[200px]">
                          {latestDoc.document_name}
                        </p>
                        {/* Revision badge */}
                        {hasMultipleRevisions && (
                          <span className="text-[10px] font-display font-700 uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded-full flex-shrink-0">
                            Rev {thread.revisions.length}
                          </span>
                        )}
                        {/* Role badge */}
                        <span className={`text-[10px] font-display font-700 uppercase tracking-wide px-1.5 py-0.5 rounded-full flex-shrink-0 border ${
                          latestDoc.uploaded_by_role === 'admin' ?'text-eb-green-700 bg-eb-green-50 border-eb-green-200' :'text-blue-700 bg-blue-50 border-blue-200'
                        }`}>
                          {latestDoc.uploaded_by_role === 'admin' ? (isAdmin ?'Admin' : 'From EarnestBridge')
                            : (isAdmin ? 'Borrower' : 'You')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <p className="text-[11px] text-gray-400 truncate max-w-[160px]">{latestDoc.file_name}</p>
                        {latestDoc.file_size && (
                          <>
                            <span className="text-[11px] text-gray-300">·</span>
                            <p className="text-[11px] text-gray-400">{formatBytes(latestDoc.file_size)}</p>
                          </>
                        )}
                        <span className="text-[11px] text-gray-300">·</span>
                        <p className="text-[11px] text-gray-400">{formatDate(latestDoc.created_at)}</p>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* Expand history button */}
                      {hasMultipleRevisions && (
                        <button
                          onClick={() => setExpandedThreads((prev) => {
                            const next = new Set(prev);
                            if (next.has(thread.threadId)) next.delete(thread.threadId);
                            else next.add(thread.threadId);
                            return next;
                          })}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] font-display font-600 text-violet-600 hover:text-violet-800 hover:bg-violet-50 rounded-lg transition-all"
                          title={isExpanded ? 'Hide history' : 'Show revision history'}
                        >
                          <Icon name="ClockIcon" size={12} />
                          {thread.revisions.length - 1} revision{thread.revisions.length - 1 !== 1 ? 's' : ''}
                          <Icon name={isExpanded ? 'ChevronUpIcon' : 'ChevronDownIcon'} size={11} />
                        </button>
                      )}
                      {latestDoc.file_url && (
                        <>
                          <button
                            onClick={() => handleView(latestDoc)}
                            className="p-1.5 text-gray-400 hover:text-eb-green-700 hover:bg-eb-green-50 rounded-lg transition-all"
                            title="View"
                          >
                            <Icon name="EyeIcon" size={14} />
                          </button>
                          <button
                            onClick={() => handleDownload(latestDoc)}
                            className="p-1.5 text-gray-400 hover:text-eb-green-700 hover:bg-eb-green-50 rounded-lg transition-all"
                            title="Download"
                          >
                            <Icon name="ArrowDownTrayIcon" size={14} />
                          </button>
                        </>
                      )}
                      {(isAdmin || latestDoc.user_id === user?.id) && (
                        <button
                          onClick={() => setConfirmDelete(latestDoc.id)}
                          disabled={deletingId === latestDoc.id}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all disabled:opacity-50"
                          title="Delete"
                        >
                          <Icon name="TrashIcon" size={14} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Latest doc feedback */}
                  {latestDoc.feedback && (
                    <div className={`mx-3.5 mb-2 flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
                      latestDoc.uploaded_by_role === 'admin' ?'bg-eb-green-50 border-eb-green-200 text-eb-green-800' :'bg-gray-50 border-gray-200 text-gray-600'
                    }`}>
                      <Icon name="ChatBubbleLeftEllipsisIcon" size={12} className="flex-shrink-0 mt-0.5 opacity-70" />
                      <span className="leading-relaxed">{latestDoc.feedback}</span>
                    </div>
                  )}

                  {/* ── Revision Required banner (client-facing) ─────────── */}
                  {!isAdmin && latestDoc.review_status === 'revision_requested' && latestDoc.client_revision_message && (
                    <div className="mx-3.5 mb-3 flex items-start gap-3 px-3.5 py-3 rounded-xl border border-amber-200 bg-amber-50">
                      <div className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Icon name="ExclamationTriangleIcon" size={14} className="text-amber-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-display font-700 text-amber-800 uppercase tracking-wide mb-1">
                          Revision Required
                          {latestDoc.revision_number != null && (
                            <span className="ml-1.5 font-500 normal-case tracking-normal text-amber-600">
                              · Current revision: {latestDoc.revision_number}
                            </span>
                          )}
                        </p>
                        <p className="text-xs font-display font-600 text-amber-900 mb-1">{latestDoc.document_name}</p>
                        <p className="text-xs text-amber-800 leading-relaxed mb-2">{latestDoc.client_revision_message}</p>
                        {/* Upload Revised Document CTA */}
                        {latestDoc.thread_id && (
                          <button
                            onClick={() => setRevisionModalTarget({
                              tableTarget: 'application_documents',
                              documentGroupId: latestDoc.thread_id!,
                              applicationId: latestDoc.application_id,
                              documentName: latestDoc.document_name,
                              currentVersion: latestDoc.revision_number ?? 1,
                              clientRevisionMessage: latestDoc.client_revision_message!,
                            })}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-all active:scale-95"
                          >
                            <Icon name="ArrowUpTrayIcon" size={12} />
                            Upload Revised Document
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Revision history (expanded) ─────────────────────── */}
                  {isExpanded && hasMultipleRevisions && (
                    <div className="mx-3.5 mb-3 border border-gray-100 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
                        <Icon name="ClockIcon" size={12} className="text-gray-400" />
                        <p className="text-[11px] font-display font-700 uppercase tracking-widest text-gray-500">
                          Revision History · {thread.revisions.length} versions
                        </p>
                      </div>
                      <div className="divide-y divide-gray-50">
                        {thread.revisions.map((rev, idx) => {
                          const isLatest = idx === thread.revisions.length - 1;
                          const isAdminRev = rev.uploaded_by_role === 'admin';
                          return (
                            <div key={rev.id} className={`flex items-start gap-3 px-3 py-2.5 ${isLatest ? 'bg-white' : 'bg-gray-50/50'}`}>
                              {/* Timeline dot */}
                              <div className="flex flex-col items-center flex-shrink-0 mt-1">
                                <div className={`w-5 h-5 rounded-full flex items-center justify-center border-2 ${
                                  isLatest
                                    ? 'border-eb-green-500 bg-eb-green-50' :'border-gray-200 bg-white'
                                }`}>
                                  <span className={`text-[9px] font-display font-700 ${isLatest ? 'text-eb-green-700' : 'text-gray-400'}`}>
                                    {idx + 1}
                                  </span>
                                </div>
                                {idx < thread.revisions.length - 1 && (
                                  <div className="w-px h-4 bg-gray-200 mt-1" />
                                )}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-xs font-display font-600 text-gray-800 truncate max-w-[180px]">
                                    {rev.document_name}
                                  </p>
                                  <span className={`text-[10px] font-display font-600 px-1.5 py-0.5 rounded-full border ${
                                    isAdminRev
                                      ? 'text-eb-green-700 bg-eb-green-50 border-eb-green-200' :'text-blue-700 bg-blue-50 border-blue-200'
                                  }`}>
                                    {isAdminRev ? (isAdmin ? 'Admin' : 'EarnestBridge') : (isAdmin ? 'Borrower' : 'You')}
                                  </span>
                                  {isLatest && (
                                    <span className="text-[10px] font-display font-700 text-eb-green-700 bg-eb-green-50 border border-eb-green-200 px-1.5 py-0.5 rounded-full">
                                      Latest
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                  <p className="text-[11px] text-gray-400">{formatDate(rev.created_at)} at {formatTime(rev.created_at)}</p>
                                  {rev.file_size && (
                                    <>
                                      <span className="text-[11px] text-gray-300">·</span>
                                      <p className="text-[11px] text-gray-400">{formatBytes(rev.file_size)}</p>
                                    </>
                                  )}
                                </div>
                                {rev.feedback && (
                                  <p className="text-[11px] text-gray-500 mt-1 italic leading-relaxed">
                                    &ldquo;{rev.feedback}&rdquo;
                                  </p>
                                )}
                              </div>

                              {/* Per-revision actions */}
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {rev.file_url && (
                                  <>
                                    <button
                                      onClick={() => handleView(rev)}
                                      className="p-1 text-gray-300 hover:text-eb-green-600 hover:bg-eb-green-50 rounded-lg transition-all"
                                      title="View"
                                    >
                                      <Icon name="EyeIcon" size={13} />
                                    </button>
                                    <button
                                      onClick={() => handleDownload(rev)}
                                      className="p-1 text-gray-300 hover:text-eb-green-600 hover:bg-eb-green-50 rounded-lg transition-all"
                                      title="Download"
                                    >
                                      <Icon name="ArrowDownTrayIcon" size={13} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── Reply / Upload Revision button ──────────────────── */}
                  <div className="px-3.5 pb-3">
                    {!isReplying ? (
                      <button
                        onClick={() => {
                          setReplyingToThread(thread.threadId);
                          // Remove any stale queue items for this thread
                          setUploadQueue((prev) => prev.filter((q) => q.replyToThreadId !== thread.threadId));
                        }}
                        className={`flex items-center gap-1.5 text-[11px] font-display font-600 transition-colors px-2 py-1 rounded-lg hover:bg-gray-50 ${
                          latestDoc.uploaded_by_role === 'admin' && !isAdmin ?'text-blue-600 hover:text-blue-800'
                            : isAdmin && latestDoc.uploaded_by_role !== 'admin' ?'text-eb-green-700 hover:text-eb-green-900' :'text-gray-500 hover:text-gray-700'
                        }`}
                      >
                        <Icon name="ArrowUturnLeftIcon" size={12} />
                        {isAdmin
                          ? latestDoc.uploaded_by_role !== 'admin' ?'Respond with document' :'Upload new revision'
                          : latestDoc.uploaded_by_role === 'admin' ?'Reply with updated document' :'Upload revision'}
                      </button>
                    ) : (
                      /* Inline reply upload form */
                      <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden bg-gray-50/50">
                        <div className="flex items-center justify-between px-3 py-2 bg-white border-b border-gray-100">
                          <div className="flex items-center gap-2">
                            <Icon name="ArrowUturnLeftIcon" size={12} className="text-gray-400" />
                            <span className="text-[11px] font-display font-700 text-gray-700">
                              {isAdmin ? 'Upload response document' : 'Upload revised document'}
                            </span>
                            <span className="text-[10px] text-gray-400">
                              → Rev {thread.revisions.length + 1}
                            </span>
                          </div>
                          <button
                            onClick={() => {
                              setReplyingToThread(null);
                              setUploadQueue((prev) => prev.filter((q) => q.replyToThreadId !== thread.threadId));
                            }}
                            className="p-1 text-gray-300 hover:text-gray-500 rounded transition-colors"
                          >
                            <Icon name="XMarkIcon" size={13} />
                          </button>
                        </div>

                        <div className="p-3 space-y-2">
                          {/* Drop zone for reply */}
                          <div
                            onClick={() => replyFileInputRef.current?.click()}
                            className="flex items-center justify-center gap-2 p-3 rounded-lg border-2 border-dashed border-gray-200 hover:border-eb-green-400 hover:bg-eb-green-50/30 cursor-pointer transition-all"
                          >
                            <input
                              ref={replyFileInputRef}
                              type="file"
                              multiple
                              accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
                              className="hidden"
                              onChange={(e) => {
                                if (e.target.files && e.target.files.length > 0) {
                                  addReplyToQueue(
                                    e.target.files,
                                    thread.threadId,
                                    latestDoc.id,
                                    latestDoc.revision_number ?? thread.revisions.length,
                                  );
                                }
                                e.target.value = '';
                              }}
                            />
                            <Icon name="CloudArrowUpIcon" size={16} className="text-gray-400" />
                            <span className="text-xs text-gray-500">Click to select file</span>
                          </div>

                          {/* Reply queue items */}
                          {replyQueueItems.map((item) => (
                            <UploadQueueItem
                              key={item.id}
                              item={item}
                              isAdmin={isAdmin}
                              onNameChange={(name) => setUploadQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, name } : q))}
                              onFeedbackChange={(feedback) => setUploadQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, feedback } : q))}
                              onRemove={() => setUploadQueue((prev) => prev.filter((q) => q.id !== item.id))}
                            />
                          ))}

                          {pendingReplies > 0 && (
                            <button
                              onClick={() => uploadReply(thread.threadId)}
                              disabled={uploadingReplies > 0}
                              className="w-full flex items-center justify-center gap-2 py-2 text-xs font-display font-600 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-lg transition-all disabled:opacity-60"
                            >
                              <Icon name="ArrowUpTrayIcon" size={13} />
                              {isAdmin ? 'Send Response' : 'Upload Revision'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {documents.length === 0 && !showUploadArea && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-12 h-12 rounded-2xl bg-gray-50 flex items-center justify-center mb-3">
              <Icon name="PaperClipIcon" size={22} className="text-gray-300" />
            </div>
            <p className="text-sm font-display font-600 text-gray-500">No documents yet</p>
            <p className="text-xs text-gray-400 mt-1">
              {isAdmin
                ? 'Upload documents for this application or wait for the borrower to submit.'
                : 'Upload any supporting documents for your application.'}
            </p>
            <button
              onClick={() => setShowUploadArea(true)}
              className="mt-3 flex items-center gap-1.5 px-4 py-2 text-sm font-display font-600 text-eb-green-800 bg-eb-green-50 border border-eb-green-200 hover:bg-eb-green-100 rounded-xl transition-all"
            >
              <Icon name="ArrowUpTrayIcon" size={13} />
              {isAdmin ? 'Upload Document' : 'Upload a Document'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── Shared upload queue item ──────────────────────────────────────────────
interface UploadQueueItemProps {
  item: UploadItem;
  isAdmin: boolean;
  onNameChange: (name: string) => void;
  onFeedbackChange: (feedback: string) => void;
  onRemove: () => void;
}

function UploadQueueItem({ item, isAdmin, onNameChange, onFeedbackChange, onRemove }: UploadQueueItemProps) {
  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-xl border transition-all ${
        item.status === 'success' ? 'bg-emerald-50 border-emerald-100' :
        item.status === 'error' ? 'bg-red-50 border-red-100' :
        item.status === 'uploading' ? 'bg-blue-50 border-blue-100' : 'bg-white border-gray-100'
      }`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
        item.status === 'success' ? 'bg-emerald-100' :
        item.status === 'error' ? 'bg-red-100' :
        item.status === 'uploading' ? 'bg-blue-100' : 'bg-gray-100'
      }`}>
        {item.status === 'uploading' ? (
          <Icon name="ArrowPathIcon" size={14} className="text-blue-600 animate-spin" />
        ) : item.status === 'success' ? (
          <Icon name="CheckCircleIcon" size={14} className="text-emerald-600" />
        ) : item.status === 'error' ? (
          <Icon name="ExclamationCircleIcon" size={14} className="text-red-500" />
        ) : (
          <Icon name="DocumentIcon" size={14} className="text-gray-400" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        {item.status === 'pending' ? (
          <input
            type="text"
            value={item.name}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full text-sm font-medium text-gray-800 bg-transparent border-b border-gray-200 focus:border-eb-green-500 outline-none pb-0.5 transition-colors"
            placeholder="Document name…"
          />
        ) : (
          <p className="text-sm font-medium text-gray-800 truncate">{item.name || item.file.name}</p>
        )}
        <p className="text-[11px] text-gray-400 mt-0.5">{item.file.name} · {formatBytes(item.file.size)}</p>

        {isAdmin && item.status === 'pending' && (
          <textarea
            value={item.feedback}
            onChange={(e) => onFeedbackChange(e.target.value)}
            placeholder="Add feedback or instructions for the borrower (optional)…"
            rows={2}
            className="mt-2 w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500 resize-none transition-all bg-white"
          />
        )}

        {item.status === 'uploading' && (
          <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-blue-500 font-display font-600">Uploading…</span>
              <span className="text-[11px] font-display font-700 text-blue-700 tabular-nums">{item.progress}%</span>
            </div>
            <div className="w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all duration-200" style={{ width: `${item.progress}%` }} />
            </div>
          </div>
        )}

        {item.status === 'success' && (
          <p className="text-[11px] text-emerald-600 mt-1 font-display font-600">✓ Uploaded successfully</p>
        )}
        {item.status === 'error' && (
          <p className="text-[11px] text-red-500 mt-1">{item.errorMessage}</p>
        )}
      </div>

      {(item.status === 'pending' || item.status === 'error') && (
        <button
          onClick={onRemove}
          className="p-1 text-gray-300 hover:text-gray-500 transition-colors flex-shrink-0"
          title="Remove"
        >
          <Icon name="XMarkIcon" size={14} />
        </button>
      )}
    </div>
  );
}
