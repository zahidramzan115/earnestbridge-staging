'use client';
import React, { useRef, useState } from 'react';
import Icon from '@/components/ui/AppIcon';

interface PortalAccessDialogProps {
  mode: 'revoke' | 'reinstate';
  userId: string;
  displayName: string;
  onClose: () => void;
  onSuccess: (disabled: boolean) => void;
}

/**
 * Shared SuperAdmin dialog for account-wide Client Portal access changes.
 * All mutations go through POST /api/admin/portal-access/[userId]; the server
 * is the authoritative boundary (SuperAdmin-only).
 */
export default function PortalAccessDialog({
  mode,
  userId,
  displayName,
  onClose,
  onSuccess,
}: PortalAccessDialogProps) {
  const isRevoke = mode === 'revoke';
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lockRef = useRef(false);

  const canSubmit =
    !submitting && (isRevoke ? reason.trim().length > 0 && confirmText === 'REVOKE' : true);

  const handleClose = () => {
    if (lockRef.current) return;
    onClose();
  };

  const handleSubmit = async () => {
    if (lockRef.current || !canSubmit) return;
    lockRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const trimmed = reason.trim();
      const res = await fetch(`/api/admin/portal-access/${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isRevoke
            ? { disabled: true, reason: trimmed }
            : { disabled: false, ...(trimmed ? { reason: trimmed } : {}) }
        ),
      });
      if (res.ok) {
        onSuccess(isRevoke);
      } else if (res.status === 401) {
        setError('Your session has expired. Please sign in again.');
      } else if (res.status === 403) {
        setError('Only a SuperAdmin can change Client Portal access.');
      } else if (res.status === 400) {
        const j = await res.json().catch(() => null);
        setError(j?.error || 'Invalid request.');
      } else {
        setError('The change could not be confirmed. Please refresh the page to check the current status before retrying.');
      }
    } catch {
      setError('A network error occurred. The change may or may not have completed. Please refresh the page before retrying.');
    } finally {
      lockRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-start gap-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${isRevoke ? 'bg-red-100' : 'bg-emerald-100'}`}>
            <Icon
              name={isRevoke ? 'ExclamationTriangleIcon' : 'LockOpenIcon'}
              size={20}
              className={isRevoke ? 'text-red-600' : 'text-emerald-600'}
            />
          </div>
          <div className="flex-1">
            <h3 className="font-display font-700 text-gray-900 text-base">
              {isRevoke ? 'Revoke Portal Access' : 'Reinstate Portal Access'}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {`Client: ${displayName}. `}
              {isRevoke
                ? "This disables this client's entire Client Portal account. Their CRM Contact, Deals, invoices and history remain stored." :'This restores account-wide Client Portal access. It does not restore purged Deals or Contacts.'}
            </p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="portal-access-reason" className="block text-xs font-600 text-gray-700 mb-1">
              {isRevoke ? 'Reason (required)' : 'Note (optional)'}
            </label>
            <textarea
              id="portal-access-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              rows={3}
              disabled={submitting}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-500/20"
            />
          </div>
          {isRevoke && (
            <div>
              <label htmlFor="portal-access-confirm" className="block text-xs font-600 text-gray-700 mb-1">
                Type <span className="font-mono font-700">REVOKE</span> to confirm
              </label>
              <input
                id="portal-access-confirm"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={submitting}
                autoComplete="off"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-red-500/20"
              />
            </div>
          )}
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={handleClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              isRevoke ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {submitting
              ? isRevoke ? 'Revoking…' : 'Reinstating…' : isRevoke ?'Revoke Portal Access' : 'Reinstate Portal Access'}
          </button>
        </div>
      </div>
    </div>
  );
}
