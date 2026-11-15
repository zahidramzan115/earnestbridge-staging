'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';

// Executed PSA upload (Exhibit A for the Option Agreement and Written Action).
// The browser uploads straight to Storage with a one-time signed URL from our
// server, then the server checks the file and records it on the deal.

interface PsaInfo {
  file_name: string;
  file_size: number;
  uploaded_at: string;
  url: string | null;
}

const BUCKET = 'borrower-documents';
const MAX_BYTES = 50 * 1024 * 1024;

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function PsaExhibitPanel({ dealId }: { dealId: string }) {
  const [psa, setPsa] = useState<PsaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/deals/${dealId}/psa`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.ok) setPsa(body.psa ?? null);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setError(null);
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('The PSA must be a PDF file.');
      return;
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      setError('The PSA must be a PDF up to 50 MB.');
      return;
    }

    setUploading(true);
    try {
      const startResponse = await fetch(`/api/admin/deals/${dealId}/psa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', fileName: file.name, size: file.size }),
      });
      const start = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) throw new Error(start.error || 'Could not start the upload.');

      const { error: uploadError } = await createClient().storage
        .from(BUCKET)
        .uploadToSignedUrl(start.path, start.token, file, { contentType: 'application/pdf' });
      if (uploadError) throw new Error('The upload failed. Please try again.');

      const completeResponse = await fetch(`/api/admin/deals/${dealId}/psa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', path: start.path, fileName: file.name }),
      });
      const complete = await completeResponse.json().catch(() => ({}));
      if (!completeResponse.ok) throw new Error(complete.error || 'Could not save the PSA.');
      setPsa(complete.psa ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload the PSA.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="mt-5 pt-5 border-t border-gray-100">
      <h4 className="font-display font-700 text-xs text-gray-900">Executed PSA (Exhibit A)</h4>
      <p className="text-xs text-gray-500 mt-1">
        Upload the signed PSA as a PDF. It is attached as Exhibit A to the Option Agreement and the Written Action.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {loading ? (
          <span className="text-xs text-gray-500">Loading…</span>
        ) : psa ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-700">
            <Icon name="DocumentTextIcon" size={14} className="text-eb-green-700" />
            {psa.url ? (
              <a href={psa.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-eb-green-800">
                {psa.file_name}
              </a>
            ) : (
              psa.file_name
            )}
            <span className="text-gray-400">
              · {formatSize(psa.file_size)} · {new Date(psa.uploaded_at).toLocaleDateString()}
            </span>
          </span>
        ) : (
          <span className="text-xs text-amber-600">No PSA uploaded yet · required for signature</span>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading || loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-xs font-display font-600 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          {uploading ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="ArrowUpTrayIcon" size={12} />}
          {uploading ? 'Uploading…' : psa ? 'Replace PSA' : 'Upload PSA'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
