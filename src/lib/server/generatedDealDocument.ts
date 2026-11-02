import { NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/server/adminAuth';
import { createServiceRoleClient, validateServerEnv } from '@/lib/server/adminUsers';
import { docxToPdf } from '@/lib/server/docxToPdf';
import { createSignatureEnvelope, getDocuSignAccessToken, type SignatureFile } from '@/lib/server/docusign';
import { sendOutboundEmail } from '@/lib/server/outboundEmail';
import { stampClientSignature } from '@/lib/server/stampSignatureAnchors';
import {
  missingSourceLabels,
  renderSourceDocument,
  type SourceDeal,
  type SourceField,
} from '@/lib/server/renderSourceDocument';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'borrower-documents';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCUMENT_COLUMNS = 'status, version_number, file_name, storage_path, sent_to_email, sent_at, client_approved_at';

export interface GeneratedDocumentSpec {
  documentType: 'option_agreement' | 'affidavit' | 'operating_agreement' | 'written_consent';
  label: string;
  storageSlug: string;
  fileBase: string;
  templateFile: string;
  columns: string;
  fields: readonly SourceField[];
}

function serviceClient() {
  const env = validateServerEnv();
  return createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
}

async function signedUrl(supabase: ReturnType<typeof serviceClient>, storagePath: string | null) {
  if (!storagePath) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
  if (error) return null;
  return data?.signedUrl ?? null;
}

function presentDocument(
  row: {
    status: string;
    version_number: number;
    file_name: string | null;
    storage_path: string | null;
    sent_to_email?: string | null;
    sent_at?: string | null;
    client_approved_at?: string | null;
  },
  downloadUrl: string | null
) {
  return {
    status: row.status,
    version_number: row.version_number,
    file_name: row.file_name,
    download_url: downloadUrl,
    sent_to_email: row.sent_to_email ?? null,
    sent_at: row.sent_at ?? null,
    client_approved_at: row.client_approved_at ?? null,
  };
}

async function authorizedDealId(context: { params: Promise<{ id: string }> }) {
  const auth = await checkAdmin();
  if (!auth.ok) {
    return {
      response: NextResponse.json(
        { error: auth.status === 401 ? 'Unauthorized.' : 'Forbidden.' },
        { status: auth.status }
      ),
    };
  }
  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return { response: NextResponse.json({ error: 'Deal not found.' }, { status: 404 }) };
  }
  try {
    return { id, userId: auth.user.id, supabase: serviceClient() };
  } catch {
    return { response: NextResponse.json({ error: 'Server is not configured.' }, { status: 500 }) };
  }
}

export async function getGeneratedDocument(
  context: { params: Promise<{ id: string }> },
  spec: GeneratedDocumentSpec
) {
  const access = await authorizedDealId(context);
  if ('response' in access) return access.response;

  const { data, error } = await access.supabase
    .from('deal_documents')
    .select(DOCUMENT_COLUMNS)
    .eq('application_id', access.id)
    .eq('document_type', spec.documentType)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: `Could not load the ${spec.label}.` }, { status: 500 });
  }
  if (!data) return NextResponse.json({ document: null });
  return NextResponse.json({
    document: presentDocument(data, await signedUrl(access.supabase, data.storage_path)),
  });
}

export async function generateGeneratedDocument(
  context: { params: Promise<{ id: string }> },
  spec: GeneratedDocumentSpec
) {
  const access = await authorizedDealId(context);
  if ('response' in access) return access.response;
  const { id, supabase } = access;

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select(spec.columns)
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: `Could not generate the ${spec.label}.` }, { status: 500 });
  }
  if (!deal) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

  const source = deal as SourceDeal;
  const missing = missingSourceLabels(source, spec.fields);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Save the ${spec.label} fields before generating.`, missing },
      { status: 400 }
    );
  }

  let docx: Buffer;
  try {
    docx = await renderSourceDocument(spec.templateFile, source, spec.fields);
  } catch (error) {
    console.error(`[${spec.documentType}] fill failed`, error);
    return NextResponse.json({ error: `Could not generate the ${spec.label}.` }, { status: 500 });
  }

  const { data: existing, error: existingError } = await supabase
    .from('deal_documents')
    .select('id, version_number, storage_path')
    .eq('application_id', id)
    .eq('document_type', spec.documentType)
    .maybeSingle();

  if (existingError) {
    return NextResponse.json({ error: `Could not generate the ${spec.label}.` }, { status: 500 });
  }

  const version = existing ? existing.version_number + 1 : 1;
  const storagePath = `generated/${id}/${spec.storageSlug}-v${version}.docx`;
  const fileName = `${spec.fileBase}-v${version}.docx`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, docx, {
    contentType: DOCX_TYPE,
    upsert: false,
  });
  if (uploadError) {
    console.error(`[${spec.documentType}] upload failed`, uploadError);
    return NextResponse.json({ error: `Could not generate the ${spec.label}.` }, { status: 500 });
  }

  const row = {
    application_id: id,
    document_type: spec.documentType,
    status: 'pending_review',
    version_number: version,
    storage_path: storagePath,
    file_name: fileName,
    approved_by: null,
    approved_at: null,
    sent_to_email: null,
    sent_at: null,
    client_approved_by: null,
    client_approved_at: null,
    docusign_envelope_id: null,
    signed_file_path: null,
  };

  const write = existing
    ? await supabase.from('deal_documents').update(row).eq('id', existing.id).select(DOCUMENT_COLUMNS).single()
    : await supabase.from('deal_documents').insert(row).select(DOCUMENT_COLUMNS).single();

  if (write.error || !write.data) {
    console.error(`[${spec.documentType}] save failed`, write.error);
    await supabase.storage.from(BUCKET).remove([storagePath]);
    return NextResponse.json({ error: `Could not generate the ${spec.label}.` }, { status: 500 });
  }

  if (existing?.storage_path && existing.storage_path !== storagePath) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove([existing.storage_path]);
    if (removeError) console.error(`[${spec.documentType}] could not delete previous file`, removeError);
  }

  return NextResponse.json({
    document: presentDocument(write.data, await signedUrl(supabase, write.data.storage_path)),
  });
}

export async function approveGeneratedDocument(
  context: { params: Promise<{ id: string }> },
  spec: GeneratedDocumentSpec
) {
  const access = await authorizedDealId(context);
  if ('response' in access) return access.response;
  const { id, supabase, userId } = access;

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: `Could not approve the ${spec.label}.` }, { status: 500 });
  }
  if (!deal) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

  const { data: updated, error: updateError } = await supabase
    .from('deal_documents')
    .update({
      status: 'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('application_id', id)
    .eq('document_type', spec.documentType)
    .eq('status', 'pending_review')
    .select(DOCUMENT_COLUMNS)
    .maybeSingle();

  if (updateError) {
    console.error(`[${spec.documentType}] approve failed`, updateError);
    return NextResponse.json({ error: `Could not approve the ${spec.label}.` }, { status: 500 });
  }
  if (updated) {
    return NextResponse.json({
      document: presentDocument(updated, await signedUrl(supabase, updated.storage_path)),
    });
  }

  const { data: current, error: currentError } = await supabase
    .from('deal_documents')
    .select('status')
    .eq('application_id', id)
    .eq('document_type', spec.documentType)
    .maybeSingle();

  if (currentError) {
    return NextResponse.json({ error: `Could not approve the ${spec.label}.` }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: `Generate the ${spec.label} before approving.` }, { status: 404 });
  }
  return NextResponse.json({ error: `The ${spec.label} is not waiting for approval.` }, { status: 409 });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendGeneratedDocument(
  context: { params: Promise<{ id: string }> },
  spec: Pick<GeneratedDocumentSpec, 'documentType' | 'label' | 'fileBase'>
) {
  const access = await authorizedDealId(context);
  if ('response' in access) return access.response;
  const { id, supabase } = access;

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id, property_address, client_notice_email')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: `Could not send the ${spec.label}.` }, { status: 500 });
  }
  if (!deal) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

  const recipient = typeof deal.client_notice_email === 'string' ? deal.client_notice_email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(recipient)) {
    return NextResponse.json({ error: `The ${spec.label} has no client email address.` }, { status: 400 });
  }

  const { data: current, error: currentError } = await supabase
    .from('deal_documents')
    .select('id, status, storage_path, file_name, version_number')
    .eq('application_id', id)
    .eq('document_type', spec.documentType)
    .maybeSingle();

  if (currentError) {
    return NextResponse.json({ error: `Could not send the ${spec.label}.` }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: `Generate the ${spec.label} before sending it.` }, { status: 404 });
  }
  if (current.status === 'sent_to_client') {
    return NextResponse.json({ error: `The ${spec.label} was already sent.` }, { status: 409 });
  }
  if (current.status !== 'approved' || !current.storage_path) {
    return NextResponse.json({ error: `Approve the ${spec.label} before sending it.` }, { status: 409 });
  }

  const { data: file, error: downloadError } = await supabase.storage.from(BUCKET).download(current.storage_path);
  if (downloadError || !file) {
    console.error(`[${spec.documentType}] download before send failed`, downloadError);
    return NextResponse.json({ error: `Could not send the ${spec.label}.` }, { status: 500 });
  }

  const content = Buffer.from(await file.arrayBuffer()).toString('base64');
  const sentAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('deal_documents')
    .update({
      status: 'sent_to_client',
      sent_to_email: recipient,
      sent_at: sentAt,
    })
    .eq('id', current.id)
    .eq('status', 'approved')
    .select(DOCUMENT_COLUMNS)
    .maybeSingle();

  if (claimError) {
    console.error(`[${spec.documentType}] send claim failed`, claimError);
    return NextResponse.json({ error: `Could not send the ${spec.label}.` }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: `Approve the ${spec.label} before sending it.` }, { status: 409 });
  }

  const property = typeof deal.property_address === 'string' ? deal.property_address.trim() : '';
  const subject = property ? `${spec.label} for your review — ${property}` : `${spec.label} for your review`;
  const lines = [`The ${spec.label} for your deal is attached.`];
  if (property) lines.push('', `Property: ${property}`);
  lines.push('', 'Please review the attached file and reply to this email with any changes, or confirm that you agree.');

  try {
    await sendOutboundEmail({
      emailType: 'admin_direct_message',
      to: recipient,
      subject,
      body: lines.join('\n'),
      attachments: [
        {
          filename: current.file_name || `${spec.fileBase}.docx`,
          content,
          mimeType: DOCX_TYPE,
        },
      ],
    });
  } catch (error) {
    console.error(`[${spec.documentType}] send failed`, error);
    await supabase
      .from('deal_documents')
      .update({ status: 'approved', sent_to_email: null, sent_at: null })
      .eq('id', current.id)
      .eq('status', 'sent_to_client');
    const message = error instanceof Error ? error.message : '';
    if (message.includes('EB_EMAIL_INTERNAL_SECRET')) {
      return NextResponse.json({ error: 'Email is not configured.' }, { status: 500 });
    }
    return NextResponse.json({ error: `Could not send the ${spec.label}.` }, { status: 500 });
  }

  return NextResponse.json({
    document: presentDocument(claimed, await signedUrl(supabase, claimed.storage_path)),
  });
}

const SENDABLE_DOCUMENTS: Array<{
  documentType: 'mou' | 'option_agreement' | 'affidavit' | 'operating_agreement' | 'written_consent';
  label: string;
  fileBase: string;
}> = [
  { documentType: 'mou', label: 'MOU', fileBase: 'MOU' },
  { documentType: 'option_agreement', label: 'Option Agreement', fileBase: 'Option-Agreement' },
  { documentType: 'affidavit', label: 'Affidavit', fileBase: 'Affidavit' },
  { documentType: 'operating_agreement', label: 'Operating Agreement', fileBase: 'Operating-Agreement' },
  { documentType: 'written_consent', label: 'Written Consent', fileBase: 'Written-Consent' },
];

export async function sendApprovedDocuments(context: { params: Promise<{ id: string }> }) {
  const access = await authorizedDealId(context);
  if ('response' in access) return access.response;
  const { id, supabase } = access;

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id, property_address, client_notice_email')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: 'Could not send the documents.' }, { status: 500 });
  }
  if (!deal) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

  const recipient = typeof deal.client_notice_email === 'string' ? deal.client_notice_email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(recipient)) {
    return NextResponse.json({ error: 'The deal has no client email address.' }, { status: 400 });
  }

  const { data: rows, error: rowsError } = await supabase
    .from('deal_documents')
    .select('id, document_type, status, storage_path, file_name, version_number')
    .eq('application_id', id)
    .eq('status', 'approved');

  if (rowsError) {
    return NextResponse.json({ error: 'Could not send the documents.' }, { status: 500 });
  }

  const approved = SENDABLE_DOCUMENTS.flatMap((spec) => {
    const row = (rows ?? []).find((item) => item.document_type === spec.documentType && item.storage_path);
    return row ? [{ spec, row }] : [];
  });
  if (approved.length === 0) {
    return NextResponse.json({ error: 'Approve a document before sending.' }, { status: 409 });
  }

  const files: Array<{ id: string; spec: (typeof approved)[number]['spec']; filename: string; content: string; storagePath: string }> = [];
  for (const item of approved) {
    const { data: file, error: downloadError } = await supabase.storage.from(BUCKET).download(item.row.storage_path as string);
    if (downloadError || !file) {
      console.error(`[${item.spec.documentType}] download before send failed`, downloadError);
      return NextResponse.json({ error: 'Could not send the documents.' }, { status: 500 });
    }
    files.push({
      id: item.row.id,
      spec: item.spec,
      filename: item.row.file_name || `${item.spec.fileBase}.docx`,
      content: Buffer.from(await file.arrayBuffer()).toString('base64'),
      storagePath: item.row.storage_path as string,
    });
  }

  const sentAt = new Date().toISOString();
  const claimedIds: string[] = [];
  for (const file of files) {
    const { data: claimed, error: claimError } = await supabase
      .from('deal_documents')
      .update({ status: 'sent_to_client', sent_to_email: recipient, sent_at: sentAt })
      .eq('id', file.id)
      .eq('status', 'approved')
      .select('id')
      .maybeSingle();
    if (claimError || !claimed) {
      console.error('[documents] send claim failed', claimError);
      if (claimedIds.length > 0) {
        await supabase.from('deal_documents').update({ status: 'approved', sent_to_email: null, sent_at: null }).in('id', claimedIds);
      }
      return NextResponse.json({ error: 'Approve a document before sending.' }, { status: 409 });
    }
    claimedIds.push(file.id);
  }

  const property = typeof deal.property_address === 'string' ? deal.property_address.trim() : '';
  const names = files.map((file) => file.spec.label);
  const subject = property ? `EarnestBridge documents for your review — ${property}` : 'EarnestBridge documents for your review';
  const lines = ['The documents for your deal are attached:', ...names.map((name) => `- ${name}`)];
  if (property) lines.push('', `Property: ${property}`);
  lines.push('', 'Please review each file and reply to this email with any changes, or confirm that you agree.');

  try {
    await sendOutboundEmail({
      emailType: 'admin_direct_message',
      to: recipient,
      subject,
      body: lines.join('\n'),
      attachments: files.map((file) => ({
        filename: file.filename,
        content: file.content,
        mimeType: DOCX_TYPE,
      })),
    });
  } catch (error) {
    console.error('[documents] send failed', error);
    await supabase.from('deal_documents').update({ status: 'approved', sent_to_email: null, sent_at: null }).in('id', claimedIds);
    const message = error instanceof Error ? error.message : '';
    if (message.includes('EB_EMAIL_INTERNAL_SECRET')) {
      return NextResponse.json({ error: 'Email is not configured.' }, { status: 500 });
    }
    return NextResponse.json({ error: 'Could not send the documents.' }, { status: 500 });
  }

  const documents = [];
  for (const file of files) {
    const { data: row } = await supabase
      .from('deal_documents')
      .select(`document_type, ${DOCUMENT_COLUMNS}`)
      .eq('id', file.id)
      .maybeSingle();
    if (!row) continue;
    documents.push({
      document_type: row.document_type,
      ...presentDocument(row, await signedUrl(supabase, row.storage_path)),
    });
  }

  return NextResponse.json({ documents });
}

export async function markSentDocumentsClientApproved(context: { params: Promise<{ id: string }> }) {
  const access = await authorizedDealId(context);
  if ('response' in access) return access.response;
  const { id, userId, supabase } = access;

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: 'Could not update the documents.' }, { status: 500 });
  }
  if (!deal) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

  const approvedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from('deal_documents')
    .update({
      status: 'client_approved',
      client_approved_by: userId,
      client_approved_at: approvedAt,
    })
    .eq('application_id', id)
    .eq('status', 'sent_to_client')
    .in('document_type', SENDABLE_DOCUMENTS.map((spec) => spec.documentType))
    .select(`document_type, ${DOCUMENT_COLUMNS}`);

  if (updateError) {
    console.error('[documents] client approval failed', updateError);
    return NextResponse.json({ error: 'Could not update the documents.' }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: 'Send a document to the client before marking it Client approved.' }, { status: 409 });
  }

  const documents = [];
  for (const row of updated) {
    documents.push({
      document_type: row.document_type,
      ...presentDocument(row, await signedUrl(supabase, row.storage_path)),
    });
  }

  return NextResponse.json({ documents });
}

async function revertClientApproval(supabase: ReturnType<typeof serviceClient>, ids: string[]) {
  if (ids.length === 0) return;
  await supabase.from('deal_documents').update({ status: 'client_approved', docusign_envelope_id: null }).in('id', ids).eq('status', 'sent_for_signature');
}

export async function sendForSignature(context: { params: Promise<{ id: string }> }) {
  const access = await authorizedDealId(context);
  if ('response' in access) return access.response;
  const { id, supabase } = access;

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id, property_address, client_notice_email, client_signatory_name, client_legal_name')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) return NextResponse.json({ error: 'Could not send the documents for signature.' }, { status: 500 });
  if (!deal) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

  const recipient = typeof deal.client_notice_email === 'string' ? deal.client_notice_email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(recipient)) {
    return NextResponse.json({ error: 'The deal has no client email address.' }, { status: 400 });
  }
  const signerName = (typeof deal.client_signatory_name === 'string' ? deal.client_signatory_name.trim() : '')
    || (typeof deal.client_legal_name === 'string' ? deal.client_legal_name.trim() : '');
  if (!signerName) {
    return NextResponse.json({ error: 'The deal has no client signatory.' }, { status: 400 });
  }

  const { data: rows, error: rowsError } = await supabase
    .from('deal_documents')
    .select('id, document_type, status, storage_path, file_name')
    .eq('application_id', id)
    .eq('status', 'client_approved');

  if (rowsError) return NextResponse.json({ error: 'Could not send the documents for signature.' }, { status: 500 });

  const ready = SENDABLE_DOCUMENTS.flatMap((spec) => {
    const row = (rows ?? []).find((item) => item.document_type === spec.documentType && item.storage_path);
    return row ? [{ spec, row }] : [];
  });
  if (ready.length === 0) {
    return NextResponse.json({ error: 'Mark a document Client approved before sending it for signature.' }, { status: 409 });
  }

  const ids = ready.map((item) => item.row.id as string);
  const { data: claimed, error: claimError } = await supabase
    .from('deal_documents')
    .update({ status: 'sent_for_signature' })
    .in('id', ids)
    .eq('status', 'client_approved')
    .select('id');

  if (claimError || !claimed || claimed.length !== ids.length) {
    await revertClientApproval(supabase, (claimed ?? []).map((row) => row.id));
    return NextResponse.json({ error: 'Mark a document Client approved before sending it for signature.' }, { status: 409 });
  }

  try {
    const files: SignatureFile[] = [];
    for (let index = 0; index < ready.length; index++) {
      const item = ready[index];
      const { data: file, error: downloadError } = await supabase.storage.from(BUCKET).download(item.row.storage_path as string);
      if (downloadError || !file) throw new Error('Could not read the document.');
      const stamped = stampClientSignature(Buffer.from(await file.arrayBuffer()), String(index + 1));
      const pdf = await docxToPdf(stamped.docx);
      files.push({
        name: item.spec.label,
        documentId: String(index + 1),
        pdf,
        signAnchor: stamped.signAnchor,
        dateAnchor: stamped.dateAnchor,
      });
    }

    const property = typeof deal.property_address === 'string' ? deal.property_address.trim() : '';
    const subject = property ? `Please sign your EarnestBridge documents — ${property}` : 'Please sign your EarnestBridge documents';
    const accessToken = await getDocuSignAccessToken();
    const envelopeId = await createSignatureEnvelope({
      accessToken,
      email: recipient,
      signerName,
      subject,
      files,
    });

    const { error: envelopeError } = await supabase
      .from('deal_documents')
      .update({ docusign_envelope_id: envelopeId })
      .in('id', ids)
      .eq('status', 'sent_for_signature');
    if (envelopeError) {
      console.error('[documents] envelope id save failed', envelopeError);
    }
  } catch (error) {
    console.error('[documents] signature send failed', error);
    await revertClientApproval(supabase, ids);
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('DocuSign') || message.includes('PDF') || message.includes('signature line') || message.includes('DOCUSIGN_')) {
      return NextResponse.json({ error: message }, { status: 500 });
    }
    return NextResponse.json({ error: 'Could not send the documents for signature.' }, { status: 500 });
  }

  const documents = [];
  for (const item of ready) {
    const { data: row } = await supabase
      .from('deal_documents')
      .select(`document_type, ${DOCUMENT_COLUMNS}`)
      .eq('id', item.row.id)
      .maybeSingle();
    if (!row) continue;
    documents.push({
      document_type: row.document_type,
      ...presentDocument(row, await signedUrl(supabase, row.storage_path)),
    });
  }

  return NextResponse.json({ documents });
}
