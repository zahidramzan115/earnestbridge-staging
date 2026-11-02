import { NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/server/adminAuth';
import { createServiceRoleClient, validateServerEnv } from '@/lib/server/adminUsers';
import { missingMouLabels, renderMou, type MouSourceDeal } from '@/lib/server/mouTemplate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'borrower-documents';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const DEAL_COLUMNS =
  'id, client_legal_name, property_address, deposit_amount, escrow_agent, admin_fee, deal_fee, option_term, client_notice_address, client_representative_name, client_notice_email, client_signatory_name, client_signatory_title, mou_effective_date';

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

const DOCUMENT_COLUMNS = 'status, version_number, file_name, storage_path, sent_to_email, sent_at, client_approved_at, signed_file_path';

function presentDocument(
  row: {
    status: string;
    version_number: number;
    file_name: string | null;
    storage_path: string | null;
    sent_to_email?: string | null;
    sent_at?: string | null;
    client_approved_at?: string | null;
    signed_file_path?: string | null;
  },
  downloadUrl: string | null,
  signedDownloadUrl: string | null = null
) {
  return {
    status: row.status,
    version_number: row.version_number,
    file_name: row.file_name,
    download_url: downloadUrl,
    signed_download_url: signedDownloadUrl,
    sent_to_email: row.sent_to_email ?? null,
    sent_at: row.sent_at ?? null,
    client_approved_at: row.client_approved_at ?? null,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await checkAdmin();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'Unauthorized.' : 'Forbidden.' },
      { status: auth.status }
    );
  }

  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  let supabase: ReturnType<typeof serviceClient>;
  try {
    supabase = serviceClient();
  } catch {
    return NextResponse.json({ error: 'Server is not configured.' }, { status: 500 });
  }

  const { data, error } = await supabase
    .from('deal_documents')
    .select(DOCUMENT_COLUMNS)
    .eq('application_id', id)
    .eq('document_type', 'mou')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'Could not load the MOU.' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ document: null });
  }

  return NextResponse.json({
    document: presentDocument(
      data,
      await signedUrl(supabase, data.storage_path),
      await signedUrl(supabase, data.signed_file_path)
    ),
  });
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await checkAdmin();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'Unauthorized.' : 'Forbidden.' },
      { status: auth.status }
    );
  }

  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  let supabase: ReturnType<typeof serviceClient>;
  try {
    supabase = serviceClient();
  } catch {
    return NextResponse.json({ error: 'Server is not configured.' }, { status: 500 });
  }

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select(DEAL_COLUMNS)
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: 'Could not generate the MOU.' }, { status: 500 });
  }
  if (!deal) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  const source = deal as MouSourceDeal;
  const missing = missingMouLabels(source);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Save the MOU fields before generating.', missing },
      { status: 400 }
    );
  }

  let docx: Buffer;
  try {
    docx = await renderMou(source);
  } catch (error) {
    console.error('[mou] fill failed', error);
    return NextResponse.json({ error: 'Could not generate the MOU.' }, { status: 500 });
  }

  const { data: existing, error: existingError } = await supabase
    .from('deal_documents')
    .select('id, version_number, storage_path')
    .eq('application_id', id)
    .eq('document_type', 'mou')
    .maybeSingle();

  if (existingError) {
    return NextResponse.json({ error: 'Could not generate the MOU.' }, { status: 500 });
  }

  const version = existing ? existing.version_number + 1 : 1;
  const storagePath = `generated/${id}/mou-v${version}.docx`;
  const fileName = `MOU-v${version}.docx`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, docx, {
    contentType: DOCX_TYPE,
    upsert: false,
  });
  if (uploadError) {
    console.error('[mou] upload failed', uploadError);
    return NextResponse.json({ error: 'Could not generate the MOU.' }, { status: 500 });
  }

  const row = {
    application_id: id,
    document_type: 'mou',
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
    console.error('[mou] save failed', write.error);
    await supabase.storage.from(BUCKET).remove([storagePath]);
    return NextResponse.json({ error: 'Could not generate the MOU.' }, { status: 500 });
  }

  if (existing?.storage_path && existing.storage_path !== storagePath) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove([existing.storage_path]);
    if (removeError) console.error('[mou] could not delete previous file', removeError);
  }

  return NextResponse.json({
    document: presentDocument(write.data, await signedUrl(supabase, write.data.storage_path)),
  });
}

export async function PATCH(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await checkAdmin();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 401 ? 'Unauthorized.' : 'Forbidden.' },
      { status: auth.status }
    );
  }

  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  let supabase: ReturnType<typeof serviceClient>;
  try {
    supabase = serviceClient();
  } catch {
    return NextResponse.json({ error: 'Server is not configured.' }, { status: 500 });
  }

  const { data: deal, error: dealError } = await supabase
    .from('borrower_applications')
    .select('id')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: 'Could not approve the MOU.' }, { status: 500 });
  }
  if (!deal) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  const { data: updated, error: updateError } = await supabase
    .from('deal_documents')
    .update({
      status: 'approved',
      approved_by: auth.user.id,
      approved_at: new Date().toISOString(),
    })
    .eq('application_id', id)
    .eq('document_type', 'mou')
    .eq('status', 'pending_review')
    .select(DOCUMENT_COLUMNS)
    .maybeSingle();

  if (updateError) {
    console.error('[mou] approve failed', updateError);
    return NextResponse.json({ error: 'Could not approve the MOU.' }, { status: 500 });
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
    .eq('document_type', 'mou')
    .maybeSingle();

  if (currentError) {
    return NextResponse.json({ error: 'Could not approve the MOU.' }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: 'Generate the MOU before approving.' }, { status: 404 });
  }
  return NextResponse.json({ error: 'The MOU is not waiting for approval.' }, { status: 409 });
}
