'use client';
import React, { useState, useRef, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const MAX_FILE_SIZE = 52428800; // 50 MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface RevisionUploadTarget {
  /** 'borrower_documents' or 'application_documents' */
  tableTarget: 'borrower_documents' | 'application_documents';
  /** document_group_id (borrower_documents) or thread_id (application_documents) */
  documentGroupId: string;
  applicationId: string;
  documentName: string;
  /** Current version number shown to user */
  currentVersion: number;
  /** The client_revision_message from the admin */
  clientRevisionMessage: string;
  /** Optional: document_type for borrower_documents */
  documentType?: string;
  /** Optional: category for borrower_documents */
  category?: string;
}

interface RevisionUploadModalProps {
  target: RevisionUploadTarget;
  onClose: () => void;
  onSuccess: () => void;
}

export default function RevisionUploadModal({ target, onClose, onSuccess }: RevisionUploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const validateFile = (f: File): string | null => {
    if (!ALLOWED_MIME_TYPES.includes(f.type)) {
      return 'File type not allowed. Please upload PDF, JPG, PNG, WEBP, or DOC files.';
    }
    if (f.size > MAX_FILE_SIZE) {
      return 'File exceeds 50 MB limit. Please upload a smaller file.';
    }
    return null;
  };

  const handleFileSelect = (f: File) => {
    const err = validateFile(f);
    if (err) { setError(err); return; }
    setError(null);
    setFile(f);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) handleFileSelect(dropped);
  }, []);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setProgress(10);

    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 85) { clearInterval(progressInterval); return prev; }
        return prev + Math.floor(Math.random() * 12 + 5);
      });
    }, 350);

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('documentGroupId', target.documentGroupId);
      fd.append('tableTarget', target.tableTarget);
      fd.append('applicationId', target.applicationId);
      fd.append('documentName', target.documentName);
      if (target.documentType) fd.append('documentType', target.documentType);
      if (target.category) fd.append('category', target.category);

      const res = await fetch('/api/documents/revision', {
        method: 'POST',
        body: fd,
      });

      clearInterval(progressInterval);
      const json = await res.json();

      if (!res.ok || json.error) {
        setError(json.error || 'Upload failed. Please try again.');
        setUploading(false);
        setProgress(0);
        return;
      }

      setProgress(100);
      setSuccess(true);

      // Give user a moment to see the success message, then close
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 2000);
    } catch (err) {
      clearInterval(progressInterval);
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setUploading(false);
      setProgress(0);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !uploading) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-amber-50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
              <Icon name="ArrowUpTrayIcon" size={18} className="text-amber-600" />
            </div>
            <div>
              <p className="font-display font-700 text-gray-900 text-sm">Upload Revised Document</p>
              <p className="text-xs text-amber-700 mt-0.5">Replacing current version</p>
            </div>
          </div>
          {!uploading && (
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-all"
              aria-label="Close"
            >
              <Icon name="XMarkIcon" size={18} />
            </button>
          )}
        </div>

        <div className="p-5 space-y-4">
          {/* Document info */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-xl px-3 py-2.5">
              <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Document</p>
              <p className="text-sm font-display font-600 text-gray-900 leading-tight">{target.documentName}</p>
            </div>
            <div className="bg-gray-50 rounded-xl px-3 py-2.5">
              <p className="text-[10px] font-display font-600 text-gray-400 uppercase tracking-wide mb-0.5">Replacing</p>
              <p className="text-sm font-display font-600 text-gray-900">Version {target.currentVersion}</p>
            </div>
          </div>

          {/* Requested change */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Icon name="ExclamationTriangleIcon" size={13} className="text-amber-600 flex-shrink-0" />
              <p className="text-[11px] font-display font-700 text-amber-700 uppercase tracking-wide">Requested Change</p>
            </div>
            <p className="text-xs text-amber-800 leading-relaxed">{target.clientRevisionMessage}</p>
          </div>

          {/* File upload area */}
          {!success && (
            <>
              <div>
                <label className="block text-xs font-display font-600 text-gray-700 mb-1.5">
                  Revised File <span className="text-red-500">*</span>
                </label>
                <div
                  className={`relative border-2 border-dashed rounded-xl transition-all cursor-pointer ${
                    isDragOver
                      ? 'border-eb-green-900 bg-eb-green-50'
                      : file
                      ? 'border-emerald-400 bg-emerald-50' :'border-gray-200 hover:border-gray-300 bg-gray-50'
                  }`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => !uploading && fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFileSelect(f);
                      e.target.value = '';
                    }}
                  />
                  {file ? (
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="w-9 h-9 bg-emerald-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Icon name="DocumentCheckIcon" size={18} className="text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-display font-600 text-gray-900 truncate">{file.name}</p>
                        <p className="text-xs text-gray-500">{formatBytes(file.size)}</p>
                      </div>
                      {!uploading && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setFile(null); setError(null); }}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-emerald-100 text-emerald-600 transition-colors"
                        >
                          <Icon name="XMarkIcon" size={14} />
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-6 gap-2">
                      <Icon name="ArrowUpTrayIcon" size={24} className={isDragOver ? 'text-eb-green-900' : 'text-gray-400'} />
                      <p className="text-sm text-gray-600 font-display font-500">
                        <span className="text-eb-green-900 font-600 underline">Browse</span> or drag & drop
                      </p>
                      <p className="text-xs text-gray-400">PDF, JPG, PNG, DOCX · Max 50MB</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                  <Icon name="ExclamationCircleIcon" size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{error}</p>
                </div>
              )}

              {/* Progress */}
              {uploading && (
                <div>
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
                    <span className="font-display font-600">Uploading…</span>
                    <span className="tabular-nums">{progress}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-eb-green-900 rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Success state */}
          {success && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 flex items-center justify-center">
                <Icon name="CheckCircleIcon" size={32} className="text-emerald-500" />
              </div>
              <div>
                <p className="font-display font-700 text-gray-900 text-sm">Revision uploaded successfully.</p>
                <p className="text-xs text-gray-500 mt-1">EarnestBridge will review the new version.</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {!success && (
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 bg-gray-50">
            <button
              onClick={onClose}
              disabled={uploading}
              className="px-4 py-2 text-sm font-display font-600 text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="flex items-center gap-2 px-5 py-2 text-sm font-display font-600 text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
            >
              {uploading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <Icon name="ArrowUpTrayIcon" size={15} />
                  Upload Revised Document
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
