import { createServiceRoleClient, validateServerEnv } from '@/lib/server/adminUsers';
import {
  downloadEnvelopeFile,
  expectedConnectAccountId,
  getDocuSignAccessToken,
  getEnvelopeStatus,
  listEnvelopeDocuments,
} from '@/lib/server/docusign';

const BUCKET = 'borrower-documents';
const PDF_TYPE = 'application/pdf';

const DOCUMENT_NAMES: Array<{ documentType: string; label: string; slug: string }> = [
  { documentType: 'mou', label: 'MOU', slug: 'mou' },
  { documentType: 'option_agreement', label: 'Option Agreement', slug: 'option-agreement' },
  { documentType: 'affidavit', label: 'Affidavit', slug: 'affidavit' },
  { documentType: 'operating_agreement', label: 'Operating Agreement', slug: 'operating-agreement' },
  { documentType: 'written_consent', label: 'Written Consent', slug: 'written-consent' },
];

type DealDocumentRow = {
  id: string;
  application_id: string;
  document_type: string;
  status: string;
  version_number: number;
  signed_file_path: string | null;
};

const inflight = new Map<string, Promise<{ ok: true } | { status: number; error: string }>>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function envelopeIdFrom(payload: Record<string, unknown>, rawBody: string): string {
  const data = asRecord(payload.data);
  const summary = asRecord(data.envelopeSummary);
  const status = asRecord(payload.EnvelopeStatus);
  const fromJson = firstString(
    data.envelopeId,
    summary.envelopeId,
    payload.envelopeId,
    status.EnvelopeID,
    status.envelopeId
  );
  if (fromJson) return fromJson;
  const xml = rawBody.match(/<EnvelopeID>\s*([^<]+)\s*<\/EnvelopeID>/i);
  return xml?.[1]?.trim() ?? '';
}

function accountIdFrom(payload: Record<string, unknown>, rawBody: string): string {
  const data = asRecord(payload.data);
  const fromJson = firstString(data.accountId, payload.accountId);
  if (fromJson) return fromJson;
  const xml = rawBody.match(/<AccountId>\s*([^<]+)\s*<\/AccountId>/i);
  return xml?.[1]?.trim() ?? '';
}

function eventFrom(payload: Record<string, unknown>, rawBody: string): string {
  const event = firstString(payload.event, payload.Event);
  if (event) return event.toLowerCase();
  const xml = rawBody.match(/<Status>\s*([^<]+)\s*<\/Status>/i);
  return (xml?.[1]?.trim() ?? '').toLowerCase();
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function matchType(name: string): (typeof DOCUMENT_NAMES)[number] | undefined {
  const haystack = compact(name);
  return DOCUMENT_NAMES.find(
    (item) => haystack.includes(compact(item.label)) || haystack.includes(compact(item.slug))
  );
}

export async function handleDocuSignConnect(
  payload: Record<string, unknown>,
  rawBody = ''
): Promise<{ ok: true } | { status: number; error: string }> {
  const event = eventFrom(payload, rawBody);
  if (event && event !== 'envelope-completed' && event !== 'completed') {
    return { ok: true };
  }

  const envelopeId = envelopeIdFrom(payload, rawBody);
  if (!envelopeId) {
    console.error('[docusign-connect] missing envelope id');
    return { ok: true };
  }

  const accountId = accountIdFrom(payload, rawBody);
  if (accountId && accountId.toLowerCase() !== expectedConnectAccountId().toLowerCase()) {
    return { status: 401, error: 'Unknown account.' };
  }

  return applyCompletedEnvelope(envelopeId);
}

export async function syncEnvelopeFromDocuSign(
  envelopeId: string | null | undefined
): Promise<{ ok: true } | { status: number; error: string }> {
  const id = envelopeId?.trim() ?? '';
  if (!id) return { ok: true };
  const existing = inflight.get(id);
  if (existing) return existing;
  const work = (async () => {
    try {
      const status = await getEnvelopeStatus(id);
      if (status !== 'completed') return { ok: true } as const;
      return await applyCompletedEnvelope(id);
    } catch (error) {
      console.error('[docusign-connect] sync failed', error);
      return { ok: true } as const;
    }
  })().finally(() => inflight.delete(id));
  inflight.set(id, work);
  return work;
}

async function applyCompletedEnvelope(
  envelopeId: string
): Promise<{ ok: true } | { status: number; error: string }> {
  const env = validateServerEnv();
  const supabase = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  const { data: rows, error } = await supabase
    .from('deal_documents')
    .select('id, application_id, document_type, status, version_number, signed_file_path')
    .ilike('docusign_envelope_id', envelopeId);

  if (error) {
    console.error('[docusign-connect] lookup failed', error);
    return { status: 500, error: 'Could not update the documents.' };
  }
  if (!rows || rows.length === 0) {
    console.error('[docusign-connect] no documents for envelope');
    return { ok: true };
  }
  if (rows.every((row) => row.status === 'signed' && row.signed_file_path)) return { ok: true };

  const accessToken = await getDocuSignAccessToken();
  const files = await listEnvelopeDocuments(accessToken, envelopeId);
  const dealId = rows[0].application_id as string;
  const typedRows = rows as DealDocumentRow[];
  const orderedRows = DOCUMENT_NAMES.flatMap((spec) =>
    typedRows.filter((row) => row.document_type === spec.documentType)
  );
  const assigned = new Set<string>();

  for (const file of files) {
    if (file.documentId === 'combined' || file.type === 'summary') continue;
    const isCertificate = file.documentId === 'certificate' || /certificate of completion/i.test(file.name);
    const spec = isCertificate ? null : matchType(file.name);
    let targets = spec ? typedRows.filter((row) => row.document_type === spec.documentType) : [];
    if (!isCertificate && targets.length === 0) {
      const index = Number.parseInt(file.documentId, 10) - 1;
      const fallback = Number.isInteger(index) ? orderedRows[index] : undefined;
      if (fallback && !assigned.has(fallback.id)) targets = [fallback];
    }
    if (!isCertificate && targets.length === 0) continue;

    const pdf = await downloadEnvelopeFile(accessToken, envelopeId, file.documentId);
    if (isCertificate) {
      const storagePath = `generated/${dealId}/signed/${envelopeId}-certificate.pdf`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, pdf, {
        contentType: PDF_TYPE,
        upsert: true,
      });
      if (uploadError) {
        console.error('[docusign-connect] certificate upload failed', uploadError);
        return { status: 500, error: 'Could not save the signed documents.' };
      }
      continue;
    }

    for (const row of targets) {
      assigned.add(row.id);
      const slug = spec?.slug ?? DOCUMENT_NAMES.find((item) => item.documentType === row.document_type)?.slug ?? row.document_type;
      const storagePath = `generated/${dealId}/signed/${slug}-v${row.version_number}.pdf`;
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, pdf, {
        contentType: PDF_TYPE,
        upsert: true,
      });
      if (uploadError) {
        console.error('[docusign-connect] signed upload failed', uploadError);
        return { status: 500, error: 'Could not save the signed documents.' };
      }
      const { error: updateError } = await supabase
        .from('deal_documents')
        .update({ status: 'signed', signed_file_path: storagePath })
        .eq('id', row.id)
        .eq('docusign_envelope_id', envelopeId);
      if (updateError) {
        console.error('[docusign-connect] status update failed', updateError);
        return { status: 500, error: 'Could not update the documents.' };
      }
    }
  }

  return { ok: true };
}
