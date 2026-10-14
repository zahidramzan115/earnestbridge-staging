'use client';
import React, { useRef, useState, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AttachmentDescriptor {
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

interface AttachmentItem {
  /** Unique local key for React rendering */
  localId: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  errorMessage?: string;
  descriptor?: AttachmentDescriptor;
}

interface EmailAttachmentPickerProps {
  /** The CRM contact ID used for upload/delete API routes */
  contactId: string;
  /** Called whenever the list of successfully uploaded descriptors changes */
  onChange: (descriptors: AttachmentDescriptor[]) => void;
  /** Whether any upload is currently in progress (parent can use to disable Send) */
  onUploadingChange: (uploading: boolean) => void;
  /** Disable all controls (e.g. while sending) */
  disabled?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ATTACHMENTS = 5;
const MAX_PER_FILE_BYTES = 5 * 1024 * 1024;   // 5 MB
const MAX_COMBINED_BYTES = 5 * 1024 * 1024;   // 5 MB

const ALLOWED_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png';

const ALLOWED_MIME_EXTENSION_MAP: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.substring(idx).toLowerCase() : '';
}

function isAllowedFile(file: File): boolean {
  const allowed = ALLOWED_MIME_EXTENSION_MAP[file.type];
  if (!allowed) return false;
  const ext = getExtension(file.name);
  return allowed.includes(ext);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let localIdCounter = 0;
function nextLocalId(): string {
  return `att-${++localIdCounter}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EmailAttachmentPicker({
  contactId,
  onChange,
  onUploadingChange,
  disabled = false,
}: EmailAttachmentPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Derive uploading state from items
  const isUploading = items.some(i => i.status === 'uploading');

  // Notify parent of uploading state changes
  const notifyUploading = useCallback(
    (newItems: AttachmentItem[]) => {
      onUploadingChange(newItems.some(i => i.status === 'uploading'));
    },
    [onUploadingChange]
  );

  // Notify parent of descriptor changes
  const notifyDescriptors = useCallback(
    (newItems: AttachmentItem[]) => {
      const descriptors = newItems
        .filter(i => i.status === 'done' && i.descriptor)
        .map(i => i.descriptor!);
      onChange(descriptors);
    },
    [onChange]
  );

  // ── File picker handler ────────────────────────────────────────────────────

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      setValidationError(null);
      const selected = Array.from(e.target.files ?? []);
      // Reset input so same file can be re-selected after removal
      if (fileInputRef.current) fileInputRef.current.value = '';

      if (selected.length === 0) return;

      // Current done/uploading count
      const currentActive = items.filter(i => i.status !== 'error').length;
      const slots = MAX_ATTACHMENTS - currentActive;

      if (slots <= 0) {
        setValidationError(`You can attach a maximum of ${MAX_ATTACHMENTS} files.`);
        return;
      }

      // Validate each file
      const accepted: File[] = [];
      const errors: string[] = [];

      for (const file of selected) {
        if (!isAllowedFile(file)) {
          errors.push(`"${file.name}": PDF, Word, Excel, CSV, text, JPG, and PNG files are supported.`);
          continue;
        }
        if (file.size > MAX_PER_FILE_BYTES) {
          errors.push(`"${file.name}": Each attachment must be 5 MB or less.`);
          continue;
        }
        accepted.push(file);
      }

      // Trim to available slots
      const toUpload = accepted.slice(0, slots);
      if (accepted.length > slots) {
        errors.push(`Only ${slots} more attachment${slots === 1 ? '' : 's'} can be added (maximum ${MAX_ATTACHMENTS}).`);
      }

      // Check combined size (existing done + new)
      const existingBytes = items
        .filter(i => i.status === 'done' && i.descriptor)
        .reduce((sum, i) => sum + (i.descriptor?.sizeBytes ?? 0), 0);
      const newBytes = toUpload.reduce((sum, f) => sum + f.size, 0);
      if (existingBytes + newBytes > MAX_COMBINED_BYTES) {
        errors.push('Attachments may not exceed 5 MB total.');
        if (errors.length > 0) {
          setValidationError(errors.join(' '));
        }
        return;
      }

      if (errors.length > 0) {
        setValidationError(errors.join(' '));
      }

      if (toUpload.length === 0) return;

      // Create placeholder items in 'uploading' state
      const newItems: AttachmentItem[] = toUpload.map(file => ({
        localId: nextLocalId(),
        file,
        status: 'uploading' as const,
      }));

      const updatedItems = [...items, ...newItems];
      setItems(updatedItems);
      notifyUploading(updatedItems);

      // Upload each file
      for (const item of newItems) {
        await uploadFile(item, updatedItems);
      }
    },
    [items, contactId, notifyUploading, notifyDescriptors]
  );

  // ── Upload a single file ───────────────────────────────────────────────────

  const uploadFile = useCallback(
    async (item: AttachmentItem, currentItems: AttachmentItem[]) => {
      const { file, localId } = item;

      const updateItem = (patch: Partial<AttachmentItem>) => {
        setItems(prev => {
          const next = prev.map(i => i.localId === localId ? { ...i, ...patch } : i);
          notifyUploading(next);
          notifyDescriptors(next);
          return next;
        });
      };

      try {
        // Step A: Request signed upload URL from D1 API
        const urlRes = await fetch(`/api/crm/contacts/${contactId}/email-attachments/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
          }),
        });

        if (!urlRes.ok) {
          let errMsg = 'Upload failed. Please try again.';
          try {
            const errData = await urlRes.json();
            if (typeof errData?.error === 'string') errMsg = errData.error;
          } catch { /* ignore */ }
          updateItem({ status: 'error', errorMessage: errMsg });
          return;
        }

        const urlData = await urlRes.json();
        // D1 response fields: signedUrl, token, storagePath, originalFilename, mimeType, sizeBytes
        const { signedUrl, storagePath, originalFilename, mimeType, sizeBytes } = urlData as {
          signedUrl: string;
          token: string;
          storagePath: string;
          originalFilename: string;
          mimeType: string;
          sizeBytes: number;
        };

        if (!signedUrl || !storagePath) {
          updateItem({ status: 'error', errorMessage: 'Upload failed. Please try again.' });
          return;
        }

        // Step B: Upload the file directly to the signed Supabase storage URL
        const uploadRes = await fetch(signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        });

        if (!uploadRes.ok) {
          updateItem({ status: 'error', errorMessage: 'Upload failed. Please try again.' });
          return;
        }

        // Step C: Mark as done with the descriptor required by send-email
        const descriptor: AttachmentDescriptor = {
          storagePath,
          originalFilename,
          mimeType,
          sizeBytes,
        };

        updateItem({ status: 'done', descriptor });
      } catch {
        updateItem({ status: 'error', errorMessage: 'Upload failed. Please try again.' });
      }
    },
    [contactId, notifyUploading, notifyDescriptors]
  );

  // ── Remove attachment ──────────────────────────────────────────────────────

  const handleRemove = useCallback(
    async (localId: string) => {
      const item = items.find(i => i.localId === localId);
      if (!item) return;

      // If still uploading, just remove from local state (no storage object yet)
      if (item.status === 'uploading') {
        const next = items.filter(i => i.localId !== localId);
        setItems(next);
        notifyUploading(next);
        notifyDescriptors(next);
        return;
      }

      // If error, just remove from local state
      if (item.status === 'error') {
        const next = items.filter(i => i.localId !== localId);
        setItems(next);
        notifyDescriptors(next);
        return;
      }

      // If done: call DELETE API to clean up storage
      if (item.status === 'done' && item.descriptor) {
        const { storagePath } = item.descriptor;
        try {
          const res = await fetch(`/api/crm/contacts/${contactId}/email-attachments`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storagePath }),
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            // 409 = already audited — do not remove from UI
            if (res.status === 409) {
              setValidationError(
                typeof errData?.error === 'string'
                  ? errData.error
                  : 'This attachment has already been used in a sent email and cannot be removed.'
              );
              return;
            }
            setValidationError('Could not remove attachment. Please try again.');
            return;
          }
        } catch {
          setValidationError('Could not remove attachment. Please try again.');
          return;
        }

        const next = items.filter(i => i.localId !== localId);
        setItems(next);
        notifyDescriptors(next);
      }
    },
    [items, contactId, notifyUploading, notifyDescriptors]
  );

  // ── Cleanup: delete all temporary (done, not audited) attachments ──────────
  // Called by parent on cancel/close before send

  // Exposed via ref pattern — parent calls cleanupAll()
  // We export this as a named export for parent use
  // (parent will call the returned cleanup function)

  // ── Derived display values ─────────────────────────────────────────────────

  const doneItems = items.filter(i => i.status === 'done' && i.descriptor);
  const combinedBytes = doneItems.reduce((sum, i) => sum + (i.descriptor?.sizeBytes ?? 0), 0);
  const activeCount = items.filter(i => i.status !== 'error').length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-2">
      {/* Validation / error message */}
      {validationError && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg"
        >
          <Icon name="ExclamationTriangleIcon" size={14} className="text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">{validationError}</p>
          <button
            type="button"
            onClick={() => setValidationError(null)}
            className="ml-auto shrink-0 text-amber-500 hover:text-amber-700"
            aria-label="Dismiss error"
          >
            <Icon name="XMarkIcon" size={13} />
          </button>
        </div>
      )}

      {/* Attachment rows */}
      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map(item => (
            <AttachmentRow
              key={item.localId}
              item={item}
              onRemove={() => handleRemove(item.localId)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      {/* Summary line */}
      {doneItems.length > 0 && (
        <p className="text-xs text-gray-400">
          {doneItems.length} attachment{doneItems.length !== 1 ? 's' : ''} · {formatBytes(combinedBytes)} of 5 MB
        </p>
      )}

      {/* Attach files button */}
      {activeCount < MAX_ATTACHMENTS && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_ACCEPT}
            className="sr-only"
            aria-label="Select files to attach"
            onChange={handleFileChange}
            disabled={disabled || isUploading}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || isUploading}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-eb-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Attach files"
          >
            <Icon name="PaperClipIcon" size={15} className="text-gray-400" />
            <span>Attach files</span>
          </button>
          <p className="text-xs text-gray-400 mt-0.5 ml-5">
            PDF, Word, Excel, CSV, text, JPG, PNG · max 5 MB per file · up to {MAX_ATTACHMENTS} files
          </p>
        </div>
      )}
    </div>
  );
}

// ── Attachment Row Sub-Component ───────────────────────────────────────────────

function AttachmentRow({
  item,
  onRemove,
  disabled,
}: {
  item: AttachmentItem;
  onRemove: () => void;
  disabled: boolean;
}) {
  const filename = item.descriptor?.originalFilename ?? item.file.name;
  const sizeLabel = item.descriptor
    ? formatBytes(item.descriptor.sizeBytes)
    : formatBytes(item.file.size);

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
        item.status === 'error' ?'bg-red-50 border-red-200'
          : item.status === 'uploading' ?'bg-gray-50 border-gray-200' :'bg-gray-50 border-gray-200'
      }`}
    >
      {/* Icon */}
      {item.status === 'uploading' ? (
        <Icon name="ArrowPathIcon" size={14} className="text-gray-400 animate-spin shrink-0" />
      ) : item.status === 'error' ? (
        <Icon name="ExclamationCircleIcon" size={14} className="text-red-500 shrink-0" />
      ) : (
        <Icon name="PaperClipIcon" size={14} className="text-gray-400 shrink-0" />
      )}

      {/* Filename + size */}
      <div className="flex-1 min-w-0">
        <span className="truncate text-gray-800 font-500 text-xs">{filename}</span>
        {item.status === 'uploading' && (
          <span className="ml-2 text-xs text-gray-400">Uploading…</span>
        )}
        {item.status === 'done' && (
          <span className="ml-2 text-xs text-gray-400">{sizeLabel}</span>
        )}
        {item.status === 'error' && item.errorMessage && (
          <span className="ml-2 text-xs text-red-600">{item.errorMessage}</span>
        )}
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${filename}`}
        className="shrink-0 p-1 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Icon name="XMarkIcon" size={13} className="text-gray-500" />
      </button>
    </div>
  );
}

// ── Cleanup helper (exported for parent use) ───────────────────────────────────

/**
 * Best-effort cleanup of all uploaded-but-unsent attachments.
 * Call this when the compose modal is cancelled/closed before sending.
 * Failures are swallowed — cleanup is best-effort.
 */
export async function cleanupAttachments(
  contactId: string,
  descriptors: AttachmentDescriptor[]
): Promise<void> {
  await Promise.allSettled(
    descriptors.map(d =>
      fetch(`/api/crm/contacts/${contactId}/email-attachments`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath: d.storagePath }),
      }).catch(() => { /* best-effort */ })
    )
  );
}
