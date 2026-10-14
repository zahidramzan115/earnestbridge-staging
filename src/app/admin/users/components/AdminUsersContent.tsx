'use client';
import React, { useEffect, useState, useCallback } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';
import ConfirmModal from '@/components/ui/ConfirmModal';
import AccessDeniedScreen from '@/components/AccessDeniedScreen';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  role: 'admin';
  is_superadmin: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ─── Invite Modal ─────────────────────────────────────────────────────────────

interface InviteModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (email: string) => void;
}

function InviteModal({ open, onClose, onSuccess }: InviteModalProps) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialFailure, setPartialFailure] = useState(false);

  const reset = () => {
    setEmail('');
    setError(null);
    setPartialFailure(false);
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setPartialFailure(false);
    setSubmitting(true);

    try {
      const res = await fetch('/api/admin/admin-users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        const sentEmail = email.trim();
        reset();
        onSuccess(sentEmail);
        return;
      }

      if (data.partialFailure) {
        setPartialFailure(true);
        setError(data.error ?? 'Invitation sent but Admin access could not be assigned. Use Grant Admin Access to complete setup.');
        setSubmitting(false);
        return;
      }

      if (res.status === 409) {
        setError(
          (data.error ?? 'User already exists.') +
          ' Use "Grant Admin Access" to grant access to an existing account.'
        );
        setSubmitting(false);
        return;
      }

      setError(data.error ?? 'An error occurred. Please try again.');
    } catch {
      setError('A network error occurred. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-eb-green-900/10 flex items-center justify-center">
              <Icon name="EnvelopeIcon" size={18} className="text-eb-green-900" />
            </div>
            <h2 className="font-display font-700 text-gray-900 text-base">Invite Admin</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-all"
          >
            <Icon name="XMarkIcon" size={18} />
          </button>
        </div>

        {/* Email warning banner */}
        <div className="mb-4 flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200">
          <Icon name="ExclamationTriangleIcon" size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 leading-relaxed">
            <span className="font-600">Sending this invitation will immediately email the recipient.</span>{' '}
            Only click "Send Invitation" when you are ready to invite this person.
          </p>
        </div>

        <p className="text-sm text-gray-500 mb-4 leading-relaxed">
          Enter the email address of the person you want to invite as an Admin. They will receive an invitation email with a link to set up their account.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-600 text-gray-700 mb-1.5 uppercase tracking-wide">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
              disabled={submitting}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all disabled:opacity-60 disabled:bg-gray-50"
            />
          </div>

          {error && (
            <div className={`flex items-start gap-2 px-3 py-2.5 rounded-xl text-xs leading-relaxed ${partialFailure ? 'bg-amber-50 border border-amber-200 text-amber-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
              <Icon name={partialFailure ? 'ExclamationTriangleIcon' : 'XCircleIcon'} size={14} className={`flex-shrink-0 mt-0.5 ${partialFailure ? 'text-amber-600' : 'text-red-500'}`} />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-lg transition-all disabled:opacity-60 flex items-center gap-2"
            >
              {submitting && (
                <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              Send Invitation
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Grant Modal ──────────────────────────────────────────────────────────────

interface GrantModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (email: string) => void;
}

function GrantModal({ open, onClose, onSuccess }: GrantModalProps) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmail('');
    setError(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/admin/admin-users/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        const grantedEmail = email.trim();
        reset();
        onSuccess(grantedEmail);
        return;
      }

      if (res.status === 404) {
        setError('No existing EarnestBridge account was found for this email. Use Invite Admin instead.');
        setSubmitting(false);
        return;
      }

      if (res.status === 409) {
        setError(data.error ?? 'User is already an Admin.');
        setSubmitting(false);
        return;
      }

      setError(data.error ?? 'An error occurred. Please try again.');
    } catch {
      setError('A network error occurred. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center">
              <Icon name="KeyIcon" size={18} className="text-blue-600" />
            </div>
            <h2 className="font-display font-700 text-gray-900 text-base">Grant Admin Access</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-all"
          >
            <Icon name="XMarkIcon" size={18} />
          </button>
        </div>

        <div className="mb-4 flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-blue-50 border border-blue-200">
          <Icon name="InformationCircleIcon" size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-800 leading-relaxed">
            Use this only for someone who already has an EarnestBridge account. This grants Admin access <span className="font-600">without sending an invitation email.</span>
          </p>
        </div>

        <p className="text-sm text-gray-500 mb-4 leading-relaxed">
          Enter the email address of an existing EarnestBridge user to grant them Admin CRM access.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-600 text-gray-700 mb-1.5 uppercase tracking-wide">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="existing@example.com"
              required
              disabled={submitting}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all disabled:opacity-60 disabled:bg-gray-50"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 leading-relaxed">
              <Icon name="XCircleIcon" size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-all disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-all disabled:opacity-60 flex items-center gap-2"
            >
              {submitting && (
                <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              Grant Access
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AdminUsersContent() {
  const { user, loading, isSuperAdmin } = useAuth();

  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modal state
  const [inviteOpen, setInviteOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminUser | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const fetchAdminUsers = useCallback(async () => {
    setFetchLoading(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/admin/admin-users');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to load Admin users.');
      }
      const data = await res.json();
      setAdminUsers(data.users ?? []);
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load Admin users.');
    } finally {
      setFetchLoading(false);
    }
  }, []);

  // Only fetch after auth has resolved and user is SuperAdmin
  useEffect(() => {
    if (loading) return;
    if (!isSuperAdmin()) return;
    fetchAdminUsers();
  }, [loading, isSuperAdmin, fetchAdminUsers]);

  const showSuccess = (msg: string) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(null), 6000);
  };

  const handleInviteSuccess = (email: string) => {
    setInviteOpen(false);
    showSuccess(`Admin invitation sent to ${email}.`);
    fetchAdminUsers();
  };

  const handleGrantSuccess = (email: string) => {
    setGrantOpen(false);
    showSuccess(`Admin access granted to ${email}.`);
    fetchAdminUsers();
  };

  const handleRevokeConfirm = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await fetch('/api/admin/admin-users/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: revokeTarget.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRevokeError(data.error ?? 'An error occurred. Please try again.');
        setRevoking(false);
        return;
      }
      const revokedEmail = revokeTarget.email;
      setRevokeTarget(null);
      setRevoking(false);
      showSuccess(`Admin access revoked for ${revokedEmail}.`);
      fetchAdminUsers();
    } catch {
      setRevokeError('A network error occurred. Please try again.');
      setRevoking(false);
    }
  };

  // ── Auth loading state ──
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Verifying access…</p>
        </div>
      </div>
    );
  }

  // ── Access gate: non-SuperAdmin ──
  if (!isSuperAdmin()) {
    return <AccessDeniedScreen />;
  }

  // ── SuperAdmin view ──
  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="font-display font-700 text-2xl text-gray-900">Admin Users</h1>
            <p className="text-sm text-gray-500 mt-1">Manage access to the EarnestBridge Admin CRM.</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setGrantOpen(true)}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-all"
            >
              <Icon name="KeyIcon" size={15} />
              Grant Admin Access
            </button>
            <button
              onClick={() => setInviteOpen(true)}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-white bg-eb-green-900 hover:bg-eb-green-800 rounded-xl transition-all"
            >
              <Icon name="UserPlusIcon" size={15} />
              Invite Admin
            </button>
          </div>
        </div>
      </div>

      {/* Success message */}
      {successMessage && (
        <div className="mb-4 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-sm text-green-800">
          <Icon name="CheckCircleIcon" size={16} className="text-green-600 flex-shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Revoke error (shown outside modal if modal was closed) */}
      {revokeError && !revokeTarget && (
        <div className="mb-4 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
          <Icon name="XCircleIcon" size={16} className="text-red-500 flex-shrink-0" />
          <span>{revokeError}</span>
        </div>
      )}

      {/* Table card */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Fetch error */}
        {fetchError && (
          <div className="px-6 py-4 flex items-center gap-2.5 bg-red-50 border-b border-red-100 text-sm text-red-700">
            <Icon name="ExclamationCircleIcon" size={16} className="text-red-500 flex-shrink-0" />
            <span>{fetchError}</span>
            <button
              onClick={fetchAdminUsers}
              className="ml-auto text-xs font-medium text-red-600 hover:text-red-800 underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {fetchLoading && (
          <div className="px-6 py-12 flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-400">Loading Admin users…</p>
          </div>
        )}

        {/* Table */}
        {!fetchLoading && !fetchError && (
          <>
            {adminUsers.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
                  <Icon name="UsersIcon" size={22} className="text-gray-400" />
                </div>
                <p className="text-sm font-medium text-gray-500">No Admin users found.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/60">
                      <th className="text-left px-5 py-3 text-xs font-600 uppercase tracking-wide text-gray-500">Email</th>
                      <th className="text-left px-5 py-3 text-xs font-600 uppercase tracking-wide text-gray-500">Access Level</th>
                      <th className="text-left px-5 py-3 text-xs font-600 uppercase tracking-wide text-gray-500 hidden md:table-cell">Created</th>
                      <th className="text-left px-5 py-3 text-xs font-600 uppercase tracking-wide text-gray-500 hidden lg:table-cell">Last Sign In</th>
                      <th className="text-right px-5 py-3 text-xs font-600 uppercase tracking-wide text-gray-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {adminUsers.map((u) => {
                      const isCurrentUser = u.id === user?.id;
                      return (
                        <tr key={u.id} className="hover:bg-gray-50/50 transition-colors">
                          {/* Email */}
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-full bg-eb-green-900/10 flex items-center justify-center flex-shrink-0">
                                <Icon name="UserCircleIcon" size={16} className="text-eb-green-900" />
                              </div>
                              <div className="min-w-0">
                                <span className="text-gray-900 font-medium truncate block">{u.email}</span>
                                {isCurrentUser && (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-600 text-eb-gold-600 uppercase tracking-wide">
                                    <Icon name="StarIcon" size={10} className="text-eb-gold-500" />
                                    You
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Access Level badge */}
                          <td className="px-5 py-3.5">
                            {u.is_superadmin ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-600 bg-eb-gold-500/15 text-eb-gold-700 border border-eb-gold-300/40">
                                <Icon name="ShieldCheckIcon" size={11} />
                                SuperAdmin
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-600 bg-eb-green-900/10 text-eb-green-900 border border-eb-green-900/20">
                                <Icon name="ShieldExclamationIcon" size={11} />
                                Admin
                              </span>
                            )}
                          </td>

                          {/* Created */}
                          <td className="px-5 py-3.5 text-gray-500 hidden md:table-cell">
                            {formatDate(u.created_at)}
                          </td>

                          {/* Last Sign In */}
                          <td className="px-5 py-3.5 text-gray-500 hidden lg:table-cell">
                            {formatDate(u.last_sign_in_at)}
                          </td>

                          {/* Actions */}
                          <td className="px-5 py-3.5 text-right">
                            {isCurrentUser ? (
                              <span className="text-xs text-gray-400 italic">Current account</span>
                            ) : (
                              <button
                                onClick={() => {
                                  setRevokeError(null);
                                  setRevokeTarget(u);
                                }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-all"
                              >
                                <Icon name="NoSymbolIcon" size={13} />
                                Revoke Access
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Invite Modal */}
      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSuccess={handleInviteSuccess}
      />

      {/* Grant Modal */}
      <GrantModal
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        onSuccess={handleGrantSuccess}
      />

      {/* Revoke Confirm Modal */}
      <ConfirmModal
        open={!!revokeTarget}
        title="Revoke Admin Access"
        message={
          revokeTarget
            ? `Revoke Admin access for ${revokeTarget.email}? They will no longer be able to access the Admin CRM. Their account and historical records will not be deleted.`
            : ''
        }
        confirmLabel={revoking ? 'Revoking…' : 'Revoke Access'}
        cancelLabel="Cancel"
        destructive
        onConfirm={handleRevokeConfirm}
        onCancel={() => {
          setRevokeTarget(null);
          setRevokeError(null);
        }}
      />

      {/* Revoke error shown inside confirm flow */}
      {revokeError && revokeTarget && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-600 text-white text-sm shadow-lg">
          <Icon name="XCircleIcon" size={16} className="flex-shrink-0" />
          <span>{revokeError}</span>
        </div>
      )}
    </div>
  );
}
