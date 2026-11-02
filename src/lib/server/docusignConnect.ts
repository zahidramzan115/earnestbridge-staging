import { createServiceRoleClient, validateServerEnv } from '@/lib/server/adminUsers';
import {
  downloadEnvelopeFile,
  expectedConnectAccountId,
  getDocuSignAccessToken,
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

function envelopeIdFrom(payload: Record<string, unknown>): string {
  const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  const direct = typeof data.envelopeId === 'string' ? data.envelopeId : '';
  if (direct) return direct.trim();
  const summary = data.envelopeSummary && typeof data.envelopeSummary === 'object'
    ? (data.envelopeSummary as Record<string, unknown>)
    : {};
  return typeof summary.envelopeId === 'string' ? summary.envelopeId.trim() : '';
}

function accountIdFrom(payload: Record<string, unknown>): string {
  const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  return typeof data.accountId === 'string' ? data.accountId.trim() : '';
}

function matchType(name: string): (typeof DOCUMENT_NAMES)[number] | undefined {
  const lower = name.toLowerCase();
  return DOCUMENT_NAMES.find((item) => lower.includes(item.label.toLowerCase()) || lower.includes(item.slug));
}

export async function handleDocuSignConnect(payload: Record<string, unknown>): Promise<{ ok: true } | { status: number; error: string }> {
  const event = typeof payload.event === 'string' ? payload.event : '';
  if (event && event !== 'envelope-completed') {
    return { ok: true };
  }

  const envelopeId = envelopeIdFrom(payload);
  if (!envelopeId) return { ok: true };

  const accountId = accountIdFrom(payload);
  if (accountId && accountId.toLowerCase() !== expectedConnectAccountId().toLowerCase()) {
    return { status: 401, error: 'Unknown account.' };
  }

  const env = validateServerEnv();
  const supabase = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  const { data: rows, error } = await supabase
    .from('deal_documents')
    .select('id, application_id, document_type, status, version_number, signed_file_path')
    .eq('docusign_envelope_id', envelopeId);

  if (error) {
    console.error('[docusign-connect] lookup failed', error);
    return { status: 500, error: 'Could not update the documents.' };
  }
  if (!rows || rows.length === 0) return { ok: true };
  if (rows.every((row) => row.status === 'signed' && row.signed_file_path)) return { ok: true };

  const accessToken = await getDocuSignAccessToken();
  const files = await listEnvelopeDocuments(accessToken, envelopeId);
  const dealId = rows[0].application_id as string;

  for (const file of files) {
    if (file.documentId === 'combined' || file.type === 'summary') continue;
    const isCertificate = file.documentId === 'certificate' || /certificate of completion/i.test(file.name);
    const spec = isCertificate ? null : matchType(file.name);
    const targets = spec ? rows.filter((row) => row.document_type === spec.documentType) : [];
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
      const slug = spec?.slug ?? row.document_type;
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
