'use client';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

// What the normal GET returns — no full secrets
interface InvoiceSettingsResponse {
  exists: boolean;
  issuer_legal_name: string;
  issuer_address_line1: string;
  issuer_address_line2: string;
  issuer_city: string;
  issuer_state: string;
  issuer_postal_code: string;
  issuer_country: string;
  wire_bank_name: string;
  wire_account_name: string;
  // Safe metadata only — full secrets are NOT in this response
  has_wire_routing_number: boolean;
  wire_routing_last4: string | null;
  has_wire_account_number: boolean;
  wire_account_last4: string | null;
  wire_bank_address: string;
  wire_memo_instructions: string;
  invoice_tagline: string;
  invoice_footer_text: string;
  updated_at: string | null;
  updated_by: string | null;
}

// Non-secret form fields only
type NonSecretFormState = {
  issuer_legal_name: string;
  issuer_address_line1: string;
  issuer_address_line2: string;
  issuer_city: string;
  issuer_state: string;
  issuer_postal_code: string;
  issuer_country: string;
  wire_bank_name: string;
  wire_account_name: string;
  wire_bank_address: string;
  wire_memo_instructions: string;
  invoice_tagline: string;
  invoice_footer_text: string;
};

const EMPTY_FORM: NonSecretFormState = {
  issuer_legal_name: '',
  issuer_address_line1: '',
  issuer_address_line2: '',
  issuer_city: '',
  issuer_state: '',
  issuer_postal_code: '',
  issuer_country: 'US',
  wire_bank_name: '',
  wire_account_name: '',
  wire_bank_address: '',
  wire_memo_instructions: '',
  invoice_tagline: '',
  invoice_footer_text: '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function maskWithLast4(last4: string | null): string {
  if (!last4) return '••••';
  return '•••••' + last4;
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${h12}:${m} ${ampm}`;
}

// ─── Sensitive field component ────────────────────────────────────────────────
// Uses only last-4 metadata for masked display.
// Full secret is fetched on demand via the /secret endpoint — SuperAdmin only.

interface SensitiveFieldProps {
  label: string;
  id: string;
  fieldAlias: 'routing' | 'account';
  hasExistingValue: boolean;
  last4: string | null;
  // Replace mode state
  isReplacing: boolean;
  replacementValue: string;
  onStartReplace: () => void;
  onCancelReplace: () => void;
  onReplacementChange: (val: string) => void;
  placeholder?: string;
  helpText?: string;
  validationError?: string;
  // Permission gate — client-side UX only; server is authoritative
  canManageFinancialSettings: boolean;
}

function SensitiveField({
  label,
  id,
  fieldAlias,
  hasExistingValue,
  last4,
  isReplacing,
  replacementValue,
  onStartReplace,
  onCancelReplace,
  onReplacementChange,
  placeholder,
  helpText,
  validationError,
  canManageFinancialSettings,
}: SensitiveFieldProps) {
  // Revealed full value lives only in local state — never in parent
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const handleToggleReveal = async () => {
    if (revealedValue !== null) {
      // Hide — remove from local state immediately
      setRevealedValue(null);
      setRevealError(null);
      return;
    }
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await fetch(`/api/admin/invoice-settings/secret?field=${fieldAlias}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Unable to retrieve value.');
      }
      const data = await res.json();
      setRevealedValue(data.value ?? null);
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : 'Unable to retrieve value.');
    } finally {
      setRevealing(false);
    }
  };

  // When entering replace mode, hide any revealed value
  const handleStartReplace = () => {
    setRevealedValue(null);
    setRevealError(null);
    onStartReplace();
  };

  // When cancelling replace, also clear revealed value
  const handleCancelReplace = () => {
    setRevealedValue(null);
    setRevealError(null);
    onCancelReplace();
  };

  // ── Normal Admin: read-only display — no Show, no Replace ─────────────────
  if (!canManageFinancialSettings) {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm font-mono text-gray-500 tracking-wider min-h-[38px] flex items-center">
            {hasExistingValue
              ? maskWithLast4(last4)
              : <span className="text-gray-400 italic text-xs">Not configured</span>
            }
          </div>
        </div>
      </div>
    );
  }

  // ── SuperAdmin: full interactive controls ──────────────────────────────────

  if (isReplacing) {
    return (
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <input
              id={id}
              type="text"
              value={replacementValue}
              onChange={(e) => onReplacementChange(e.target.value)}
              placeholder={placeholder}
              className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-eb-green-600 focus:border-transparent font-mono ${
                validationError ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white'
              }`}
              autoComplete="off"
              spellCheck={false}
            />
            {validationError && (
              <p className="mt-1 text-xs text-red-600">{validationError}</p>
            )}
            {helpText && !validationError && (
              <p className="mt-1 text-xs text-gray-500">{helpText}</p>
            )}
          </div>
          <button
            type="button"
            onClick={handleCancelReplace}
            className="mt-0.5 px-3 py-2 text-xs font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex-shrink-0"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!hasExistingValue) {
    // No value set yet — show plain input for initial entry
    return (
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
        <input
          id={id}
          type="text"
          value={replacementValue}
          onChange={(e) => onReplacementChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-eb-green-600 focus:border-transparent font-mono ${
            validationError ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white'
          }`}
          autoComplete="off"
          spellCheck={false}
        />
        {validationError && (
          <p className="mt-1 text-xs text-red-600">{validationError}</p>
        )}
        {helpText && !validationError && (
          <p className="mt-1 text-xs text-gray-500">{helpText}</p>
        )}
      </div>
    );
  }

  // Existing value — show masked last-4 display with Show/Hide and Replace
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <div className="flex-1 px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm font-mono text-gray-700 tracking-wider min-h-[38px] flex items-center">
          {revealedValue !== null
            ? revealedValue
            : maskWithLast4(last4)
          }
        </div>
        <button
          type="button"
          onClick={handleToggleReveal}
          disabled={revealing}
          className="px-3 py-2 text-xs font-medium text-eb-green-700 border border-eb-green-300 rounded-lg hover:bg-eb-green-50 transition-colors flex-shrink-0 disabled:opacity-50"
        >
          {revealing ? '…' : revealedValue !== null ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={handleStartReplace}
          className="px-3 py-2 text-xs font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex-shrink-0"
        >
          Replace
        </button>
      </div>
      {revealError && (
        <p className="mt-1 text-xs text-red-600">{revealError}</p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InvoiceSettingsContent() {
  // ── Authorization ──────────────────────────────────────────────────────────
  // Client-side check is UX only. Server APIs are the authoritative security boundary.
  const { isSuperAdmin } = useAuth();
  const canManageFinancialSettings = isSuperAdmin();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Saved state from server (safe metadata only — no full secrets)
  const [savedSettings, setSavedSettings] = useState<InvoiceSettingsResponse | null>(null);

  // Non-secret form state
  const [form, setForm] = useState<NonSecretFormState>({ ...EMPTY_FORM });

  // Track original loaded values to detect changes
  const originalFormRef = useRef<NonSecretFormState>({ ...EMPTY_FORM });

  // Replace mode state — only populated when SuperAdmin explicitly clicks Replace
  const [routingReplacing, setRoutingReplacing] = useState(false);
  const [accountReplacing, setAccountReplacing] = useState(false);
  const [newRoutingNumber, setNewRoutingNumber] = useState('');
  const [newAccountNumber, setNewAccountNumber] = useState('');

  // Validation errors
  const [routingError, setRoutingError] = useState('');
  const [accountError, setAccountError] = useState('');

  // ── Load settings ──────────────────────────────────────────────────────────

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/invoice-settings');
      if (!res.ok) throw new Error('Failed to load settings.');
      const data: InvoiceSettingsResponse = await res.json();
      setSavedSettings(data);

      const formData: NonSecretFormState = {
        issuer_legal_name: data.issuer_legal_name,
        issuer_address_line1: data.issuer_address_line1,
        issuer_address_line2: data.issuer_address_line2,
        issuer_city: data.issuer_city,
        issuer_state: data.issuer_state,
        issuer_postal_code: data.issuer_postal_code,
        issuer_country: data.issuer_country,
        wire_bank_name: data.wire_bank_name,
        wire_account_name: data.wire_account_name,
        wire_bank_address: data.wire_bank_address,
        wire_memo_instructions: data.wire_memo_instructions,
        invoice_tagline: data.invoice_tagline,
        invoice_footer_text: data.invoice_footer_text,
      };
      setForm(formData);
      originalFormRef.current = { ...formData };
    } catch {
      setError('Unable to load invoice settings. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // ── Change detection ───────────────────────────────────────────────────────

  const hasChanges = useCallback((): boolean => {
    const orig = originalFormRef.current;
    const nonSecretChanged = (
      form.issuer_legal_name !== orig.issuer_legal_name ||
      form.issuer_address_line1 !== orig.issuer_address_line1 ||
      form.issuer_address_line2 !== orig.issuer_address_line2 ||
      form.issuer_city !== orig.issuer_city ||
      form.issuer_state !== orig.issuer_state ||
      form.issuer_postal_code !== orig.issuer_postal_code ||
      form.issuer_country !== orig.issuer_country ||
      form.wire_bank_name !== orig.wire_bank_name ||
      form.wire_account_name !== orig.wire_account_name ||
      form.wire_bank_address !== orig.wire_bank_address ||
      form.wire_memo_instructions !== orig.wire_memo_instructions ||
      form.invoice_tagline !== orig.invoice_tagline ||
      form.invoice_footer_text !== orig.invoice_footer_text
    );
    // A secret replacement is pending only if SuperAdmin is in replace mode AND typed something
    const secretChanged = (routingReplacing && newRoutingNumber.trim() !== '') ||
      (accountReplacing && newAccountNumber.trim() !== '') ||
      // Also count initial entry (no existing value, something typed)
      (!savedSettings?.has_wire_routing_number && newRoutingNumber.trim() !== '') ||
      (!savedSettings?.has_wire_account_number && newAccountNumber.trim() !== '');
    return nonSecretChanged || secretChanged;
  }, [form, routingReplacing, accountReplacing, newRoutingNumber, newAccountNumber, savedSettings]);

  // ── Invoice setup completeness ─────────────────────────────────────────────
  // Required for "Invoice Setup Ready":
  //   issuer_legal_name, wire_bank_name, wire_account_name,
  //   wire_routing_number (has_wire_routing_number), wire_account_number (has_wire_account_number)
  // NOT required: any address fields, wire_bank_address, wire_memo_instructions,
  //               invoice_tagline, invoice_footer_text

  const isSetupReady = useCallback((): boolean => {
    const s = savedSettings;
    if (!s) return false;
    return !!(
      s.issuer_legal_name?.trim() &&
      s.wire_bank_name?.trim() &&
      s.wire_account_name?.trim() &&
      s.has_wire_routing_number &&
      s.has_wire_account_number
    );
  }, [savedSettings]);

  // ── Validation ─────────────────────────────────────────────────────────────

  function validateSensitiveFields(): boolean {
    let valid = true;

    // Validate routing if in replace mode with a value, or initial entry
    const routingActive = routingReplacing || !savedSettings?.has_wire_routing_number;
    if (routingActive && newRoutingNumber.trim() !== '') {
      const rn = newRoutingNumber.trim();
      if (!/^\d+$/.test(rn)) {
        setRoutingError('Routing number must contain digits only.');
        valid = false;
      } else if (rn.length !== 9) {
        setRoutingError('U.S. routing numbers must be exactly 9 digits.');
        valid = false;
      } else {
        setRoutingError('');
      }
    } else {
      setRoutingError('');
    }

    // Validate account if in replace mode with a value, or initial entry
    const accountActive = accountReplacing || !savedSettings?.has_wire_account_number;
    if (accountActive && newAccountNumber.trim() !== '') {
      const an = newAccountNumber.trim();
      if (!/^[0-9a-zA-Z\-]+$/.test(an)) {
        setAccountError('Account number contains invalid characters.');
        valid = false;
      } else if (an.length > 34) {
        setAccountError('Account number is too long.');
        valid = false;
      } else {
        setAccountError('');
      }
    } else {
      setAccountError('');
    }

    return valid;
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!validateSensitiveFields()) return;

    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      // Build payload — non-secret fields always included
      const payload: Record<string, string | null> = {
        issuer_legal_name: form.issuer_legal_name || null,
        issuer_address_line1: form.issuer_address_line1 || null,
        issuer_address_line2: form.issuer_address_line2 || null,
        issuer_city: form.issuer_city || null,
        issuer_state: form.issuer_state || null,
        issuer_postal_code: form.issuer_postal_code || null,
        issuer_country: form.issuer_country || null,
        wire_bank_name: form.wire_bank_name || null,
        wire_account_name: form.wire_account_name || null,
        wire_bank_address: form.wire_bank_address || null,
        wire_memo_instructions: form.wire_memo_instructions || null,
        invoice_tagline: form.invoice_tagline || null,
        invoice_footer_text: form.invoice_footer_text || null,
      };

      // Only include secret replacement fields if SuperAdmin explicitly entered a new value.
      // Use the _replacement field names so the server knows this is intentional.
      // Omission = preserve existing DB value.
      const routingActive = routingReplacing || !savedSettings?.has_wire_routing_number;
      if (routingActive && newRoutingNumber.trim() !== '') {
        payload['wire_routing_number_replacement'] = newRoutingNumber.trim();
      }

      const accountActive = accountReplacing || !savedSettings?.has_wire_account_number;
      if (accountActive && newAccountNumber.trim() !== '') {
        payload['wire_account_number_replacement'] = newAccountNumber.trim();
      }

      const res = await fetch('/api/admin/invoice-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Unable to save invoice settings.');
      }

      setSuccessMsg('Invoice settings saved.');
      // Reload to get fresh server state (safe metadata)
      await loadSettings();
      // Reset sensitive editing state
      setRoutingReplacing(false);
      setAccountReplacing(false);
      setNewRoutingNumber('');
      setNewAccountNumber('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save invoice settings.');
    } finally {
      setSaving(false);
    }
  };

  // ── Field helpers ──────────────────────────────────────────────────────────

  const setField = (key: keyof NonSecretFormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // ── Shared input class helpers ─────────────────────────────────────────────

  const inputClass = (extra?: string) =>
    `w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors ${
      canManageFinancialSettings
        ? 'border-gray-300 bg-white focus:ring-2 focus:ring-eb-green-600 focus:border-transparent' :'border-gray-200 bg-gray-50 text-gray-600 cursor-default'
    } ${extra ?? ''}`;

  const textareaClass = () =>
    `w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors resize-none ${
      canManageFinancialSettings
        ? 'border-gray-300 bg-white focus:ring-2 focus:ring-eb-green-600 focus:border-transparent' :'border-gray-200 bg-gray-50 text-gray-600 cursor-default'
    }`;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading invoice settings…</p>
        </div>
      </div>
    );
  }

  const setupReady = isSetupReady();
  const changed = hasChanges();

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-8">

      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-700 text-gray-900">Invoice &amp; Payment Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            EarnestBridge-wide invoice identity, bank wire instructions, and invoice presentation settings.
          </p>
        </div>
        {/* Setup readiness badge */}
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-600 border flex-shrink-0 ${
          setupReady
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :'bg-amber-50 border-amber-200 text-amber-700'
        }`}>
          <Icon
            name={setupReady ? 'CheckCircleIcon' : 'ExclamationTriangleIcon'}
            size={14}
            className={setupReady ? 'text-emerald-600' : 'text-amber-600'}
          />
          {setupReady ? 'Invoice Setup Ready' : 'Invoice Setup Incomplete'}
        </div>
      </div>

      {/* ── Normal Admin read-only notice ── */}
      {!canManageFinancialSettings && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex gap-3">
          <Icon name="InformationCircleIcon" size={18} className="text-blue-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-blue-800">
            Global financial settings are managed by SuperAdmin. You can view the current configuration, but only SuperAdmin can make changes or reveal bank account details.
          </p>
        </div>
      )}

      {/* Setup incomplete notice */}
      {!setupReady && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex gap-3">
          <Icon name="InformationCircleIcon" size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">Required fields for invoice issuance are incomplete.</p>
            <p className="mt-0.5 text-amber-700">
              Before invoices can be issued, the following must be set: Legal Business Name, Bank Name, Account Name, Routing Number, and Account Number.
            </p>
          </div>
        </div>
      )}

      {/* Error / success toasts */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3">
          <Icon name="XCircleIcon" size={18} className="text-red-500 flex-shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <Icon name="XMarkIcon" size={16} />
          </button>
        </div>
      )}
      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-3">
          <Icon name="CheckCircleIcon" size={18} className="text-emerald-500 flex-shrink-0" />
          <p className="text-sm text-emerald-700">{successMsg}</p>
          <button onClick={() => setSuccessMsg(null)} className="ml-auto text-emerald-400 hover:text-emerald-600">
            <Icon name="XMarkIcon" size={16} />
          </button>
        </div>
      )}

      {/* ── Section 1: Invoice Issuer ── */}
      <section className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-eb-green-50 border border-eb-green-100 flex items-center justify-center">
            <Icon name="BuildingOfficeIcon" size={16} className="text-eb-green-700" />
          </div>
          <div>
            <h2 className="text-sm font-700 text-gray-900">Invoice Issuer</h2>
            <p className="text-xs text-gray-500">Legal business identity that will appear on issued invoices.</p>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label htmlFor="issuer_legal_name" className="block text-sm font-medium text-gray-700 mb-1">
              Legal Business Name
            </label>
            <input
              id="issuer_legal_name"
              type="text"
              value={form.issuer_legal_name}
              onChange={(e) => canManageFinancialSettings && setField('issuer_legal_name', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="e.g. Earnest Bridge LLC"
              className={inputClass()}
            />
          </div>
          <div>
            <label htmlFor="issuer_address_line1" className="block text-sm font-medium text-gray-700 mb-1">
              Address Line 1
            </label>
            <input
              id="issuer_address_line1"
              type="text"
              value={form.issuer_address_line1}
              onChange={(e) => canManageFinancialSettings && setField('issuer_address_line1', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="Street address"
              className={inputClass()}
            />
          </div>
          <div>
            <label htmlFor="issuer_address_line2" className="block text-sm font-medium text-gray-700 mb-1">
              Address Line 2
            </label>
            <input
              id="issuer_address_line2"
              type="text"
              value={form.issuer_address_line2}
              onChange={(e) => canManageFinancialSettings && setField('issuer_address_line2', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="Suite, unit, floor (optional)"
              className={inputClass()}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="issuer_city" className="block text-sm font-medium text-gray-700 mb-1">
                City
              </label>
              <input
                id="issuer_city"
                type="text"
                value={form.issuer_city}
                onChange={(e) => canManageFinancialSettings && setField('issuer_city', e.target.value)}
                readOnly={!canManageFinancialSettings}
                placeholder="City"
                className={inputClass()}
              />
            </div>
            <div>
              <label htmlFor="issuer_state" className="block text-sm font-medium text-gray-700 mb-1">
                State
              </label>
              <input
                id="issuer_state"
                type="text"
                value={form.issuer_state}
                onChange={(e) => canManageFinancialSettings && setField('issuer_state', e.target.value)}
                readOnly={!canManageFinancialSettings}
                placeholder="e.g. TX"
                maxLength={2}
                className={inputClass('uppercase')}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="issuer_postal_code" className="block text-sm font-medium text-gray-700 mb-1">
                Postal Code
              </label>
              <input
                id="issuer_postal_code"
                type="text"
                value={form.issuer_postal_code}
                onChange={(e) => canManageFinancialSettings && setField('issuer_postal_code', e.target.value)}
                readOnly={!canManageFinancialSettings}
                placeholder="ZIP code"
                className={inputClass()}
              />
            </div>
            <div>
              <label htmlFor="issuer_country" className="block text-sm font-medium text-gray-700 mb-1">
                Country
              </label>
              <input
                id="issuer_country"
                type="text"
                value={form.issuer_country}
                onChange={(e) => canManageFinancialSettings && setField('issuer_country', e.target.value)}
                readOnly={!canManageFinancialSettings}
                placeholder="US"
                className={inputClass()}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Section 2: Bank Wire Instructions ── */}
      <section className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-eb-green-50 border border-eb-green-100 flex items-center justify-center">
            <Icon name="BanknotesIcon" size={16} className="text-eb-green-700" />
          </div>
          <div>
            <h2 className="text-sm font-700 text-gray-900">Bank Wire Instructions</h2>
            <p className="text-xs text-gray-500">
              Default wire instructions. Future invoices will snapshot these values at issuance.
            </p>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label htmlFor="wire_bank_name" className="block text-sm font-medium text-gray-700 mb-1">
              Bank Name
            </label>
            <input
              id="wire_bank_name"
              type="text"
              value={form.wire_bank_name}
              onChange={(e) => canManageFinancialSettings && setField('wire_bank_name', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="e.g. First National Bank"
              className={inputClass()}
            />
          </div>
          <div>
            <label htmlFor="wire_account_name" className="block text-sm font-medium text-gray-700 mb-1">
              Account Name
            </label>
            <input
              id="wire_account_name"
              type="text"
              value={form.wire_account_name}
              onChange={(e) => canManageFinancialSettings && setField('wire_account_name', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="Name on the account"
              className={inputClass()}
            />
          </div>

          {/* Routing Number — sensitive, uses last-4 metadata only */}
          <SensitiveField
            label="Routing Number"
            id="wire_routing_number"
            fieldAlias="routing"
            hasExistingValue={savedSettings?.has_wire_routing_number ?? false}
            last4={savedSettings?.wire_routing_last4 ?? null}
            isReplacing={routingReplacing}
            replacementValue={newRoutingNumber}
            onStartReplace={() => {
              setRoutingReplacing(true);
              setNewRoutingNumber('');
            }}
            onCancelReplace={() => {
              setRoutingReplacing(false);
              setNewRoutingNumber('');
              setRoutingError('');
            }}
            onReplacementChange={(val) => {
              // Only allow digits
              const cleaned = val.replace(/\D/g, '');
              setNewRoutingNumber(cleaned);
              if (routingError) setRoutingError('');
            }}
            placeholder="9-digit routing number"
            helpText="Digits only. U.S. routing numbers are exactly 9 digits. Leading zeroes are preserved."
            validationError={routingError}
            canManageFinancialSettings={canManageFinancialSettings}
          />

          {/* Account Number — sensitive, uses last-4 metadata only */}
          <SensitiveField
            label="Account Number"
            id="wire_account_number"
            fieldAlias="account"
            hasExistingValue={savedSettings?.has_wire_account_number ?? false}
            last4={savedSettings?.wire_account_last4 ?? null}
            isReplacing={accountReplacing}
            replacementValue={newAccountNumber}
            onStartReplace={() => {
              setAccountReplacing(true);
              setNewAccountNumber('');
            }}
            onCancelReplace={() => {
              setAccountReplacing(false);
              setNewAccountNumber('');
              setAccountError('');
            }}
            onReplacementChange={(val) => {
              setNewAccountNumber(val);
              if (accountError) setAccountError('');
            }}
            placeholder="Account number"
            helpText="Digits and letters only. Leading zeroes are preserved."
            validationError={accountError}
            canManageFinancialSettings={canManageFinancialSettings}
          />

          <div>
            <label htmlFor="wire_bank_address" className="block text-sm font-medium text-gray-700 mb-1">
              Bank Address
            </label>
            <input
              id="wire_bank_address"
              type="text"
              value={form.wire_bank_address}
              onChange={(e) => canManageFinancialSettings && setField('wire_bank_address', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="Bank branch address"
              className={inputClass()}
            />
          </div>
          <div>
            <label htmlFor="wire_memo_instructions" className="block text-sm font-medium text-gray-700 mb-1">
              Wire / Memo Instructions
            </label>
            <textarea
              id="wire_memo_instructions"
              value={form.wire_memo_instructions}
              onChange={(e) => canManageFinancialSettings && setField('wire_memo_instructions', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="e.g. Include Deal ID and borrower name in memo"
              rows={3}
              className={textareaClass()}
            />
          </div>
        </div>
      </section>

      {/* ── Section 3: Invoice Appearance ── */}
      <section className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-eb-green-50 border border-eb-green-100 flex items-center justify-center">
            <Icon name="DocumentTextIcon" size={16} className="text-eb-green-700" />
          </div>
          <div>
            <h2 className="text-sm font-700 text-gray-900">Invoice Appearance</h2>
            <p className="text-xs text-gray-500">Text used in future invoice PDF generation.</p>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label htmlFor="invoice_tagline" className="block text-sm font-medium text-gray-700 mb-1">
              Invoice Tagline
            </label>
            <input
              id="invoice_tagline"
              type="text"
              value={form.invoice_tagline}
              onChange={(e) => canManageFinancialSettings && setField('invoice_tagline', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="Short phrase displayed near the invoice header"
              className={inputClass()}
            />
            <p className="mt-1 text-xs text-gray-500">Short phrase displayed near the invoice header.</p>
          </div>
          <div>
            <label htmlFor="invoice_footer_text" className="block text-sm font-medium text-gray-700 mb-1">
              Invoice Footer Text
            </label>
            <textarea
              id="invoice_footer_text"
              value={form.invoice_footer_text}
              onChange={(e) => canManageFinancialSettings && setField('invoice_footer_text', e.target.value)}
              readOnly={!canManageFinancialSettings}
              placeholder="Text displayed at the bottom of issued invoice PDFs"
              rows={3}
              className={textareaClass()}
            />
            <p className="mt-1 text-xs text-gray-500">Text displayed at the bottom of issued invoice PDFs.</p>
          </div>
        </div>
      </section>

      {/* ── Section 4: Payment Instructions Preview ── */}
      <section className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gray-50 border border-gray-200 flex items-center justify-center">
            <Icon name="EyeIcon" size={16} className="text-gray-500" />
          </div>
          <div>
            <h2 className="text-sm font-700 text-gray-900">Payment Instructions Preview</h2>
            <p className="text-xs text-gray-500">Read-only preview of how wire instructions will appear. Sensitive numbers are masked using last-4 digits.</p>
          </div>
        </div>
        <div className="px-6 py-5">
          <PaymentInstructionsPreview settings={savedSettings} />
        </div>
      </section>

      {/* ── Save button — SuperAdmin only ── */}
      {canManageFinancialSettings && (
        <div className="flex items-center justify-between gap-4 pb-4">
          <div className="text-xs text-gray-400">
            {savedSettings?.updated_at ? (
              <>Last saved {formatDateTime(savedSettings.updated_at)}{savedSettings.updated_by ? ` by ${savedSettings.updated_by}` : ''}</>
            ) : (
              'Not yet saved'
            )}
          </div>
          <div className="flex items-center gap-3">
            {changed && (
              <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                <Icon name="ExclamationCircleIcon" size={14} />
                Unsaved changes
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !changed}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-600 transition-all ${
                saving || !changed
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed' :'bg-eb-green-700 text-white hover:bg-eb-green-800 shadow-sm hover:shadow-md'
              }`}
            >
              {saving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Icon name="CheckIcon" size={16} />
                  Save Invoice Settings
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Last saved info for normal Admin (no Save button) ── */}
      {!canManageFinancialSettings && savedSettings?.updated_at && (
        <div className="pb-4">
          <p className="text-xs text-gray-400">
            Last saved {formatDateTime(savedSettings.updated_at)}{savedSettings.updated_by ? ` by ${savedSettings.updated_by}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Payment Instructions Preview ────────────────────────────────────────────
// Uses only last-4 metadata for masked display — never the full secret.

function PaymentInstructionsPreview({ settings }: { settings: InvoiceSettingsResponse | null }) {
  if (!settings) return null;

  const hasAny = settings.wire_account_name || settings.wire_bank_name ||
    settings.has_wire_routing_number || settings.has_wire_account_number;

  if (!hasAny) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-center">
        <Icon name="BanknotesIcon" size={24} className="text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-400">Bank wire instructions will appear here once configured.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-5 py-5 space-y-3">
      <p className="text-[10px] font-700 uppercase tracking-widest text-gray-400">Payment Instructions</p>
      {settings.wire_account_name && (
        <div>
          <p className="text-xs text-gray-500">Remit payment to:</p>
          <p className="text-sm font-600 text-gray-900">{settings.wire_account_name}</p>
        </div>
      )}
      {settings.wire_bank_name && (
        <div>
          <p className="text-xs text-gray-500">Bank:</p>
          <p className="text-sm text-gray-800">{settings.wire_bank_name}</p>
        </div>
      )}
      {settings.has_wire_routing_number && (
        <div>
          <p className="text-xs text-gray-500">Routing Number:</p>
          <p className="text-sm font-mono text-gray-800 tracking-wider">
            {maskWithLast4(settings.wire_routing_last4)}
          </p>
        </div>
      )}
      {settings.has_wire_account_number && (
        <div>
          <p className="text-xs text-gray-500">Account Number:</p>
          <p className="text-sm font-mono text-gray-800 tracking-wider">
            {maskWithLast4(settings.wire_account_last4)}
          </p>
        </div>
      )}
      {settings.wire_bank_address && (
        <div>
          <p className="text-xs text-gray-500">Bank Address:</p>
          <p className="text-sm text-gray-800">{settings.wire_bank_address}</p>
        </div>
      )}
      {settings.wire_memo_instructions && (
        <div className="pt-2 border-t border-gray-200">
          <p className="text-xs text-gray-500 mb-1">Wire / Memo Instructions:</p>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{settings.wire_memo_instructions}</p>
        </div>
      )}
    </div>
  );
}
