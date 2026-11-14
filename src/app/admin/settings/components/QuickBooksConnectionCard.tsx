'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Icon from '@/components/ui/AppIcon';

interface QboStatus {
  connected: boolean;
  environment: 'sandbox' | 'production';
  status: 'active' | 'disconnected' | 'error' | 'none';
  realm_id: string | null;
  company_name: string | null;
  connected_at: string | null;
  connected_by_email: string | null;
  last_refreshed_at: string | null;
  refresh_token_expires_at: string | null;
  last_error: string | null;
}

const CALLBACK_MESSAGES: Record<string, string> = {
  not_authorized: 'Only SuperAdmin can connect QuickBooks.',
  access_denied: 'The QuickBooks connection was cancelled.',
  invalid_state: 'The connection request expired or was invalid. Please try again.',
  missing_code: 'QuickBooks did not return the expected details. Please try again.',
  not_configured: 'QuickBooks keys are not configured on the server.',
  token_exchange_failed: 'QuickBooks rejected the connection. Check the app keys and redirect URI.',
  reauthorization_required: 'QuickBooks authorization was rejected. Please try again.',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function QuickBooksConnectionCard({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'test' | 'disconnect' | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/quickbooks', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load QuickBooks status');
      setStatus(json as QboStatus);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load QuickBooks status' });
    } finally {
      setLoading(false);
    }
  }, []);

  // Show the result of the OAuth redirect, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('qbo');
    if (outcome) {
      if (outcome === 'connected') {
        setMessage({ kind: 'success', text: 'QuickBooks connected.' });
      } else {
        const reason = params.get('reason') ?? '';
        setMessage({ kind: 'error', text: CALLBACK_MESSAGES[reason] ?? 'QuickBooks connection failed. Please try again.' });
      }
      params.delete('qbo');
      params.delete('reason');
      const query = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
    }
    loadStatus();
  }, [loadStatus]);

  const runAction = async (action: 'test' | 'disconnect') => {
    if (action === 'disconnect' && !window.confirm('Disconnect QuickBooks? Customers will not be able to pay until it is reconnected.')) {
      return;
    }
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/quickbooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed');
      setMessage({
        kind: 'success',
        text: action === 'test' ? `Connection OK${json.company_name ? `: ${json.company_name}` : ''}.` : 'QuickBooks disconnected.',
      });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setBusy(null);
      loadStatus();
    }
  };

  const isConnected = status?.status === 'active';
  const needsReconnect = status?.status === 'error';

  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-eb-green-50 border border-eb-green-100 flex items-center justify-center">
            <Icon name="LinkIcon" size={16} className="text-eb-green-700" />
          </div>
          <div>
            <h2 className="text-sm font-700 text-gray-900">QuickBooks Online</h2>
            <p className="text-xs text-gray-500">Used by the payment page to verify invoices and record payments.</p>
          </div>
        </div>
        {status && (
          <span className={`text-[11px] font-600 uppercase tracking-wide px-2 py-0.5 rounded-full border ${
            status.environment === 'production'
              ? 'bg-blue-50 border-blue-200 text-blue-700'
              : 'bg-amber-50 border-amber-200 text-amber-700'
          }`}>
            {status.environment}
          </span>
        )}
      </div>

      <div className="px-6 py-5 space-y-4">
        {message && (
          <div className={`rounded-lg border px-3 py-2 text-sm ${
            message.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}>
            {message.text}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Loading QuickBooks status…</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${
                isConnected ? 'bg-emerald-500' : needsReconnect ? 'bg-red-500' : 'bg-gray-300'
              }`} />
              <span className="text-sm font-600 text-gray-900">
                {isConnected ? 'Connected' : needsReconnect ? 'Reconnect required' : 'Not connected'}
              </span>
            </div>

            {needsReconnect && status?.last_error && (
              <p className="text-sm text-red-700">{status.last_error}</p>
            )}

            {(isConnected || needsReconnect) && status && (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-gray-500">Company</dt>
                  <dd className="text-gray-900">{status.company_name ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Company ID (Realm)</dt>
                  <dd className="text-gray-900 font-mono text-xs mt-0.5">{status.realm_id ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Connected</dt>
                  <dd className="text-gray-900">
                    {formatDate(status.connected_at)}
                    {status.connected_by_email ? ` by ${status.connected_by_email}` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Last renewed</dt>
                  <dd className="text-gray-900">{formatDate(status.last_refreshed_at)}</dd>
                </div>
              </dl>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {canManage && (
                <a
                  href="/api/quickbooks/connect"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-eb-green-700 text-white text-sm font-600 hover:bg-eb-green-800"
                >
                  <Icon name="LinkIcon" size={16} />
                  {isConnected || needsReconnect ? 'Reconnect QuickBooks' : 'Connect QuickBooks'}
                </a>
              )}
              {isConnected && (
                <button
                  type="button"
                  onClick={() => runAction('test')}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-sm font-600 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Icon name="ArrowPathIcon" size={16} />
                  {busy === 'test' ? 'Testing…' : 'Test connection'}
                </button>
              )}
              {canManage && (isConnected || needsReconnect) && (
                <button
                  type="button"
                  onClick={() => runAction('disconnect')}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 text-sm font-600 text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
            </div>

            {!canManage && (
              <p className="text-xs text-gray-500">Only SuperAdmin can connect or disconnect QuickBooks.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
