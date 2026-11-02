'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '@/components/ui/AppIcon';
import { AFFIDAVIT_FIELD_KEYS } from '@/lib/documents/affidavitFields';
import { MOU_FIELD_KEYS } from '@/lib/documents/mouFields';
import { OPERATING_AGREEMENT_FIELD_KEYS } from '@/lib/documents/operatingAgreementFields';
import { OPTION_FIELD_KEYS } from '@/lib/documents/optionFields';
import { WRITTEN_CONSENT_FIELD_KEYS } from '@/lib/documents/writtenConsentFields';

export interface DocumentSourceDeal {
  id: string;
  property_address: string | null;
  deposit_amount: number | null;
  llc_name?: string | null;
  llc_state?: string | null;
  llc_act?: string | null;
  llc_formation_date?: string | null;
  registered_agent?: string | null;
  client_legal_name?: string | null;
  escrow_agent?: string | null;
  admin_fee?: number | null;
  deal_fee?: number | null;
  option_term?: string | null;
  client_notice_address?: string | null;
  client_representative_name?: string | null;
  client_notice_email?: string | null;
  client_signatory_name?: string | null;
  client_signatory_title?: string | null;
  psa_title?: string | null;
  mou_effective_date?: string | null;
  option_effective_date?: string | null;
}

type FieldKey = keyof Omit<DocumentSourceDeal, 'id'>;

const FIELDS: { key: FieldKey; label: string; kind: 'text' | 'money' | 'date' | 'textarea' }[] = [
  { key: 'client_legal_name', label: 'Legal name', kind: 'text' },
  { key: 'property_address', label: 'Property address', kind: 'text' },
  { key: 'llc_name', label: 'LLC name', kind: 'text' },
  { key: 'llc_state', label: 'LLC state', kind: 'text' },
  { key: 'llc_act', label: 'LLC act', kind: 'text' },
  { key: 'llc_formation_date', label: 'LLC formation date', kind: 'date' },
  { key: 'registered_agent', label: 'Registered agent', kind: 'textarea' },
  { key: 'deposit_amount', label: 'Earnest money amount', kind: 'money' },
  { key: 'escrow_agent', label: 'Escrow agent', kind: 'textarea' },
  { key: 'admin_fee', label: 'Admin fee', kind: 'money' },
  { key: 'deal_fee', label: 'Deal fee', kind: 'money' },
  { key: 'option_term', label: 'Option term', kind: 'text' },
  { key: 'client_notice_address', label: 'Notice address', kind: 'textarea' },
  { key: 'client_representative_name', label: 'Representative', kind: 'text' },
  { key: 'client_notice_email', label: 'Notice email', kind: 'text' },
  { key: 'client_signatory_name', label: 'Signatory', kind: 'text' },
  { key: 'client_signatory_title', label: 'Signatory title', kind: 'text' },
  { key: 'psa_title', label: 'PSA title', kind: 'text' },
  { key: 'mou_effective_date', label: 'MOU effective date', kind: 'date' },
  { key: 'option_effective_date', label: 'Option effective date', kind: 'date' },
];

function asText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function dateInput(value: string | null | undefined): string {
  if (!value) return '';
  return value.slice(0, 10);
}

function isEmpty(value: string): boolean {
  return value.trim().length === 0;
}

function matchesSaved(key: FieldKey, formValue: string, deal: DocumentSourceDeal): boolean {
  const form = formValue.trim();
  const saved = deal[key];
  if (key === 'deposit_amount' || key === 'admin_fee' || key === 'deal_fee') {
    if (form === '') return saved === null || saved === undefined;
    if (saved === null || saved === undefined) return false;
    const amount = Number(form);
    return Number.isFinite(amount) && Math.round(amount * 100) === Math.round(Number(saved) * 100);
  }
  if (key === 'mou_effective_date' || key === 'option_effective_date' || key === 'llc_formation_date') {
    return form === dateInput(typeof saved === 'string' ? saved : null);
  }
  if (key === 'client_notice_email') {
    return form.toLowerCase() === asText(saved).trim().toLowerCase();
  }
  return form === asText(saved).trim();
}

interface MouDocument {
  status: string;
  version_number: number;
  file_name: string | null;
  download_url: string | null;
  sent_to_email?: string | null;
  sent_at?: string | null;
  client_approved_at?: string | null;
  signed_download_url?: string | null;
  document_type?: string;
}

function statusLabel(status: string): string {
  if (status === 'pending_review') return 'Pending review';
  if (status === 'approved') return 'Approved';
  if (status === 'sent_to_client') return 'Sent to client';
  if (status === 'client_approved') return 'Client approved';
  if (status === 'sent_for_signature') return 'Sent for signature';
  if (status === 'signed') return 'Signed';
  return status.replace(/_/g, ' ');
}

function sentWhen(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function deliveryNote(document: MouDocument | null): string | undefined {
  if (!document) return undefined;
  const sent = document.sent_to_email
    ? `Sent to ${document.sent_to_email}${sentWhen(document.sent_at) ? ` on ${sentWhen(document.sent_at)}` : ''}.`
    : '';
  if (document.status === 'sent_to_client') return sent || undefined;
  if (document.status === 'client_approved' || document.status === 'sent_for_signature') {
    const when = sentWhen(document.client_approved_at);
    const approved = `Client approved${when ? ` on ${when}` : ''}.`;
    const signature = document.status === 'sent_for_signature' ? 'Sent for signature.' : '';
    return [sent, approved, signature].filter(Boolean).join(' ');
  }
  if (document.status === 'signed') return [sent, 'Signed.'].filter(Boolean).join(' ');
  return undefined;
}

export default function DocumentSourceFieldsSection({
  deal,
  onSaved,
}: {
  deal: DocumentSourceDeal;
  onSaved: (deal: DocumentSourceDeal) => void;
}) {
  const [values, setValues] = useState<Record<FieldKey, string>>(() => emptyValues(deal));
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [sending, setSending] = useState(false);
  const [markingClientApproved, setMarkingClientApproved] = useState(false);
  const [confirmClientApproval, setConfirmClientApproval] = useState(false);
  const [signing, setSigning] = useState(false);
  const [confirmSignature, setConfirmSignature] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [mou, setMou] = useState<MouDocument | null>(null);
  const [optionDoc, setOptionDoc] = useState<MouDocument | null>(null);
  const [affidavitDoc, setAffidavitDoc] = useState<MouDocument | null>(null);
  const [operatingDoc, setOperatingDoc] = useState<MouDocument | null>(null);
  const [consentDoc, setConsentDoc] = useState<MouDocument | null>(null);
  const [extraBusy, setExtraBusy] = useState<string | null>(null);

  useEffect(() => {
    setValues(emptyValues(deal));
  }, [deal]);

  const loadDocuments = useCallback(async () => {
    const loadOne = async (path: string, setDoc: (document: MouDocument | null) => void) => {
      try {
        const response = await fetch(`/api/admin/deals/${deal.id}/documents/${path}`);
        const body = await response.json().catch(() => ({}));
        if (response.ok) setDoc(body.document ?? null);
      } catch {
        setDoc(null);
      }
    };
    await Promise.all([
      loadOne('mou', setMou),
      loadOne('option-agreement', setOptionDoc),
      loadOne('affidavit', setAffidavitDoc),
      loadOne('operating-agreement', setOperatingDoc),
      loadOne('written-consent', setConsentDoc),
    ]);
  }, [deal.id]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const missing = useMemo(
    () => FIELDS.filter((field) => MOU_FIELD_KEYS.has(field.key) && isEmpty(values[field.key])).map((field) => field.label),
    [values]
  );
  const dirty = useMemo(
    () => FIELDS.some((field) => MOU_FIELD_KEYS.has(field.key) && !matchesSaved(field.key, values[field.key], deal)),
    [deal, values]
  );
  const canGenerate = missing.length === 0 && !dirty && !saving && !generating && !approving && !sending && !signing && !markingClientApproved && !extraBusy;
  const optionReady = useMemo(() => {
    const missingLabels = FIELDS.filter((field) => OPTION_FIELD_KEYS.has(field.key) && isEmpty(values[field.key])).map((field) => field.label);
    const unsaved = FIELDS.some((field) => OPTION_FIELD_KEYS.has(field.key) && !matchesSaved(field.key, values[field.key], deal));
    return { missingLabels, unsaved, ready: missingLabels.length === 0 && !unsaved };
  }, [deal, values]);
  const affidavitReady = useMemo(() => {
    const missingLabels = FIELDS.filter((field) => AFFIDAVIT_FIELD_KEYS.has(field.key) && isEmpty(values[field.key])).map((field) => field.label);
    const unsaved = FIELDS.some((field) => AFFIDAVIT_FIELD_KEYS.has(field.key) && !matchesSaved(field.key, values[field.key], deal));
    return { missingLabels, unsaved, ready: missingLabels.length === 0 && !unsaved };
  }, [deal, values]);
  const operatingReady = useMemo(() => {
    const missingLabels = FIELDS.filter((field) => OPERATING_AGREEMENT_FIELD_KEYS.has(field.key) && isEmpty(values[field.key])).map((field) => field.label);
    const unsaved = FIELDS.some((field) => OPERATING_AGREEMENT_FIELD_KEYS.has(field.key) && !matchesSaved(field.key, values[field.key], deal));
    return { missingLabels, unsaved, ready: missingLabels.length === 0 && !unsaved };
  }, [deal, values]);
  const consentReady = useMemo(() => {
    const missingLabels = FIELDS.filter((field) => WRITTEN_CONSENT_FIELD_KEYS.has(field.key) && isEmpty(values[field.key])).map((field) => field.label);
    const unsaved = FIELDS.some((field) => WRITTEN_CONSENT_FIELD_KEYS.has(field.key) && !matchesSaved(field.key, values[field.key], deal));
    return { missingLabels, unsaved, ready: missingLabels.length === 0 && !unsaved };
  }, [deal, values]);
  const allDocuments = [mou, optionDoc, affidavitDoc, operatingDoc, consentDoc];
  const waitingForSignature = allDocuments.some((document) => document?.status === 'sent_for_signature');
  useEffect(() => {
    if (!waitingForSignature) return undefined;
    const timer = window.setInterval(() => {
      void loadDocuments();
    }, 12000);
    return () => window.clearInterval(timer);
  }, [waitingForSignature, loadDocuments]);
  const controlsLocked = saving || generating || approving || sending || markingClientApproved || signing || Boolean(extraBusy);
  const hasApprovedDocument = allDocuments.some((document) => document?.status === 'approved');
  const hasSentDocument = allDocuments.some((document) => document?.status === 'sent_to_client');
  const hasClientApprovedDocument = allDocuments.some((document) => document?.status === 'client_approved');

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload: Record<string, string | number | null> = {};
      for (const field of FIELDS) {
        const raw = values[field.key].trim();
        if (field.kind === 'money') {
          payload[field.key] = raw === '' ? null : Number(raw);
        } else {
          payload[field.key] = raw === '' ? null : raw;
        }
      }
      const response = await fetch(`/api/admin/deals/${deal.id}/document-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not save document fields.');
        return;
      }
      onSaved({ ...deal, ...body.deal });
      setSaved(true);
    } catch {
      setError('Could not save document fields.');
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/documents/mou`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not generate the MOU.');
        return;
      }
      setMou(body.document ?? null);
      setSaved(false);
    } catch {
      setError('Could not generate the MOU.');
    } finally {
      setGenerating(false);
    }
  };

  const approve = async () => {
    setApproving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/documents/mou`, { method: 'PATCH' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not approve the MOU.');
        return;
      }
      setMou(body.document ?? null);
    } catch {
      setError('Could not approve the MOU.');
    } finally {
      setApproving(false);
    }
  };

  const sendToClient = async () => {
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/documents/send`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSendError(typeof body.error === 'string' ? body.error : 'Could not send the documents.');
        return;
      }
      applyReturnedDocuments(Array.isArray(body.documents) ? body.documents : []);
    } catch {
      setSendError('Could not send the documents.');
    } finally {
      setSending(false);
    }
  };

  const markClientApproved = async () => {
    setMarkingClientApproved(true);
    setSendError(null);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/documents/client-approved`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSendError(typeof body.error === 'string' ? body.error : 'Could not update the documents.');
        return;
      }
      applyReturnedDocuments(Array.isArray(body.documents) ? body.documents : []);
      setConfirmClientApproval(false);
    } catch {
      setSendError('Could not update the documents.');
    } finally {
      setMarkingClientApproved(false);
    }
  };

  const sendForSignature = async () => {
    setSigning(true);
    setSendError(null);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/documents/sign`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSendError(typeof body.error === 'string' ? body.error : 'Could not send the documents for signature.');
        return;
      }
      applyReturnedDocuments(Array.isArray(body.documents) ? body.documents : []);
      setConfirmSignature(false);
    } catch {
      setSendError('Could not send the documents for signature.');
    } finally {
      setSigning(false);
    }
  };

  function applyReturnedDocuments(documents: MouDocument[]) {
    for (const document of documents) {
      if (document.document_type === 'mou') setMou(document);
      if (document.document_type === 'option_agreement') setOptionDoc(document);
      if (document.document_type === 'affidavit') setAffidavitDoc(document);
      if (document.document_type === 'operating_agreement') setOperatingDoc(document);
      if (document.document_type === 'written_consent') setConsentDoc(document);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="font-display font-700 text-sm text-gray-900">Document fields</h3>
          <p className="text-xs text-gray-500 mt-1">
            Save these values on the deal. Generate fills the five source documents. Nothing is emailed.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {FIELDS.map((field) => (
          <label key={field.key} className={field.kind === 'textarea' ? 'sm:col-span-2' : ''}>
            <span className="block text-[11px] font-display font-600 text-gray-600 mb-1">
              {field.label}
              {(MOU_FIELD_KEYS.has(field.key) || OPTION_FIELD_KEYS.has(field.key) || AFFIDAVIT_FIELD_KEYS.has(field.key) || OPERATING_AGREEMENT_FIELD_KEYS.has(field.key) || WRITTEN_CONSENT_FIELD_KEYS.has(field.key)) && isEmpty(values[field.key]) && <span className="text-amber-600"> · required</span>}
            </span>
            {field.kind === 'textarea' ? (
              <textarea
                value={values[field.key]}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                rows={2}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20 resize-none"
              />
            ) : (
              <input
                type={field.kind === 'date' ? 'date' : field.kind === 'money' ? 'number' : field.key === 'client_notice_email' ? 'email' : 'text'}
                min={field.kind === 'money' ? '0' : undefined}
                step={field.kind === 'money' ? '0.01' : undefined}
                value={values[field.key]}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-eb-green-900 focus:ring-1 focus:ring-eb-green-500/20"
              />
            )}
          </label>
        ))}
      </div>

      {error && <p className="mt-3 text-xs text-red-700">{error}</p>}
      {saved && <p className="mt-3 text-xs text-emerald-700">Document fields saved.</p>}

      <div className="mt-4">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-eb-green-900 text-white text-xs font-display font-700 rounded-lg hover:bg-eb-green-800 disabled:opacity-50"
        >
          {saving ? <Icon name="ArrowPathIcon" size={12} className="animate-spin" /> : <Icon name="CheckIcon" size={12} />}
          {saving ? 'Saving…' : 'Save document fields'}
        </button>
      </div>

      <GeneratedFileCard
        title="MOU"
        document={mou}
        ready={canGenerate}
        busy={generating || approving || sending || markingClientApproved || signing}
        generating={generating}
        approving={approving}
        hint={missing.length > 0 ? `Still empty: ${missing.join(', ')}.` : dirty ? 'Save document fields before Generate.' : 'Generate creates the MOU and leaves it pending review.'}
        statusNote={deliveryNote(mou)}
        onGenerate={generate}
        onApprove={approve}
      />

      <GeneratedFileCard
        title="Option Agreement"
        document={optionDoc}
        ready={optionReady.ready && !controlsLocked}
        busy={extraBusy === 'option-generate' || extraBusy === 'option-approve'}
        generating={extraBusy === 'option-generate'}
        approving={extraBusy === 'option-approve'}
        hint={optionReady.missingLabels.length > 0 ? `Still empty: ${optionReady.missingLabels.join(', ')}.` : optionReady.unsaved ? 'Save document fields before Generate.' : 'Generate creates the Option Agreement and leaves it pending review.'}
        statusNote={deliveryNote(optionDoc)}
        onGenerate={() => runDocumentAction('option-agreement', 'POST', 'option-generate', setOptionDoc, 'Could not generate the Option Agreement.')}
        onApprove={() => runDocumentAction('option-agreement', 'PATCH', 'option-approve', setOptionDoc, 'Could not approve the Option Agreement.')}
      />
      <GeneratedFileCard
        title="Affidavit"
        document={affidavitDoc}
        ready={affidavitReady.ready && !controlsLocked}
        busy={extraBusy === 'affidavit-generate' || extraBusy === 'affidavit-approve'}
        generating={extraBusy === 'affidavit-generate'}
        approving={extraBusy === 'affidavit-approve'}
        hint={affidavitReady.missingLabels.length > 0 ? `Still empty: ${affidavitReady.missingLabels.join(', ')}.` : affidavitReady.unsaved ? 'Save document fields before Generate.' : 'Generate creates the Affidavit and leaves it pending review.'}
        statusNote={deliveryNote(affidavitDoc)}
        onGenerate={() => runDocumentAction('affidavit', 'POST', 'affidavit-generate', setAffidavitDoc, 'Could not generate the Affidavit.')}
        onApprove={() => runDocumentAction('affidavit', 'PATCH', 'affidavit-approve', setAffidavitDoc, 'Could not approve the Affidavit.')}
      />
      <GeneratedFileCard
        title="Operating Agreement"
        document={operatingDoc}
        ready={operatingReady.ready && !controlsLocked}
        busy={extraBusy === 'operating-generate' || extraBusy === 'operating-approve'}
        generating={extraBusy === 'operating-generate'}
        approving={extraBusy === 'operating-approve'}
        hint={operatingReady.missingLabels.length > 0 ? `Still empty: ${operatingReady.missingLabels.join(', ')}.` : operatingReady.unsaved ? 'Save document fields before Generate.' : 'Generate creates the Operating Agreement and leaves it pending review.'}
        statusNote={deliveryNote(operatingDoc)}
        onGenerate={() => runDocumentAction('operating-agreement', 'POST', 'operating-generate', setOperatingDoc, 'Could not generate the Operating Agreement.')}
        onApprove={() => runDocumentAction('operating-agreement', 'PATCH', 'operating-approve', setOperatingDoc, 'Could not approve the Operating Agreement.')}
      />
      <GeneratedFileCard
        title="Written Consent"
        document={consentDoc}
        ready={consentReady.ready && !controlsLocked}
        busy={extraBusy === 'consent-generate' || extraBusy === 'consent-approve'}
        generating={extraBusy === 'consent-generate'}
        approving={extraBusy === 'consent-approve'}
        hint={consentReady.missingLabels.length > 0 ? `Still empty: ${consentReady.missingLabels.join(', ')}.` : consentReady.unsaved ? 'Save document fields before Generate.' : 'Generate creates the Written Consent and leaves it pending review.'}
        statusNote={deliveryNote(consentDoc)}
        onGenerate={() => runDocumentAction('written-consent', 'POST', 'consent-generate', setConsentDoc, 'Could not generate the Written Consent.')}
        onApprove={() => runDocumentAction('written-consent', 'PATCH', 'consent-approve', setConsentDoc, 'Could not approve the Written Consent.')}
      />

      {(hasApprovedDocument || hasSentDocument || hasClientApprovedDocument) && (
        <div className="mt-4 rounded-lg border border-gray-200 px-3 py-3">
          {confirmClientApproval ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-gray-700">Mark every sent document as Client approved? This does not send another email.</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmClientApproval(false)}
                  disabled={markingClientApproved}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-display font-700 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={markClientApproved}
                  disabled={markingClientApproved}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-display font-700 rounded-lg bg-eb-green-900 text-white hover:bg-eb-green-800 disabled:opacity-50"
                >
                  {markingClientApproved ? 'Updating…' : 'Confirm'}
                </button>
              </div>
            </div>
          ) : confirmSignature ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-gray-700">Send every Client approved document for signature? DocuSign will email the client a signing link.</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmSignature(false)}
                  disabled={signing}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-display font-700 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={sendForSignature}
                  disabled={signing}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-display font-700 rounded-lg bg-eb-green-900 text-white hover:bg-eb-green-800 disabled:opacity-50"
                >
                  {signing ? 'Sending…' : 'Confirm'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-gray-500">
                {hasApprovedDocument
                  ? 'Sends every approved document to the notice email. Each file is sent once.'
                  : hasSentDocument
                    ? 'Marks every document already sent to the client as Client approved.'
                    : 'Turns every Client approved document into a PDF and sends it through DocuSign.'}
              </p>
              {hasApprovedDocument ? (
                <button
                  type="button"
                  onClick={sendToClient}
                  disabled={controlsLocked}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 rounded-lg bg-eb-green-900 text-white hover:bg-eb-green-800 disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send to Client'}
                </button>
              ) : hasSentDocument ? (
                <button
                  type="button"
                  onClick={() => {
                    setSendError(null);
                    setConfirmClientApproval(true);
                  }}
                  disabled={controlsLocked}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 rounded-lg bg-eb-green-900 text-white hover:bg-eb-green-800 disabled:opacity-50"
                >
                  Client Approved
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSendError(null);
                    setConfirmSignature(true);
                  }}
                  disabled={controlsLocked}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 rounded-lg bg-eb-green-900 text-white hover:bg-eb-green-800 disabled:opacity-50"
                >
                  Send for Signature
                </button>
              )}
            </div>
          )}
          {sendError && <p className="mt-2 text-xs text-red-700">{sendError}</p>}
        </div>
      )}
    </div>
  );

  async function runDocumentAction(
    path: string,
    method: 'POST' | 'PATCH',
    busyKey: string,
    setDoc: (document: MouDocument | null) => void,
    fallback: string
  ) {
    setExtraBusy(busyKey);
    setError(null);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/documents/${path}`, { method });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : fallback);
        return;
      }
      setDoc(body.document ?? null);
    } catch {
      setError(fallback);
    } finally {
      setExtraBusy(null);
    }
  }
}

function emptyValues(deal: DocumentSourceDeal): Record<FieldKey, string> {
  return {
    property_address: asText(deal.property_address),
    deposit_amount: asText(deal.deposit_amount),
    llc_name: asText(deal.llc_name),
    llc_state: asText(deal.llc_state),
    llc_act: asText(deal.llc_act),
    llc_formation_date: dateInput(deal.llc_formation_date),
    registered_agent: asText(deal.registered_agent),
    client_legal_name: asText(deal.client_legal_name),
    escrow_agent: asText(deal.escrow_agent),
    admin_fee: asText(deal.admin_fee),
    deal_fee: asText(deal.deal_fee),
    option_term: asText(deal.option_term),
    client_notice_address: asText(deal.client_notice_address),
    client_representative_name: asText(deal.client_representative_name),
    client_notice_email: asText(deal.client_notice_email),
    client_signatory_name: asText(deal.client_signatory_name),
    client_signatory_title: asText(deal.client_signatory_title),
    psa_title: asText(deal.psa_title),
    mou_effective_date: dateInput(deal.mou_effective_date),
    option_effective_date: dateInput(deal.option_effective_date),
  };
}

function GeneratedFileCard({
  title,
  document,
  ready,
  busy,
  generating,
  approving,
  hint,
  statusNote,
  onGenerate,
  onApprove,
  extra,
}: {
  title: string;
  document: MouDocument | null;
  ready: boolean;
  busy: boolean;
  generating: boolean;
  approving: boolean;
  hint: string;
  statusNote?: string;
  onGenerate: () => void;
  onApprove: () => void;
  extra?: React.ReactNode;
}) {
  const signed = document?.status === 'signed';
  const generateHint = signed ? 'This signed file cannot be regenerated.' : hint;
  return (
    <div className="mt-4 rounded-lg border border-gray-200 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-display font-700 text-gray-900">{document?.file_name || title}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {document
              ? `${statusLabel(document.status)} · Version ${document.version_number}${document.status === 'pending_review' ? '. Regenerate replaces this file.' : ''}${statusNote ? ` ${statusNote}` : ''}`
              : 'Not generated yet.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onGenerate}
            disabled={signed || !ready || busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 rounded-lg border border-eb-green-900 text-eb-green-900 bg-white hover:bg-eb-green-50 disabled:border-gray-200 disabled:text-gray-400 disabled:bg-gray-50 disabled:cursor-not-allowed"
          >
            {generating ? 'Generating…' : document ? 'Regenerate' : 'Generate'}
          </button>
          {extra}
          {document?.status === 'pending_review' && (
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-display font-700 rounded-lg bg-eb-green-900 text-white hover:bg-eb-green-800 disabled:opacity-50"
            >
              {approving ? 'Approving…' : 'Approve'}
            </button>
          )}
          {document?.download_url && (
            <a href={document.download_url} className="text-xs font-display font-700 text-eb-green-900 hover:underline">
              Download
            </a>
          )}
          {document?.signed_download_url && (
            <a href={document.signed_download_url} className="text-xs font-display font-700 text-eb-green-900 hover:underline">
              Download signed
            </a>
          )}
        </div>
      </div>
      <p className={`mt-2 text-[11px] ${signed || ready ? 'text-emerald-700' : 'text-amber-800'}`}>{generateHint}</p>
    </div>
  );
}
