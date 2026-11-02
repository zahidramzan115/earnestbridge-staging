import { NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/server/adminAuth';
import { createServiceRoleClient, validateServerEnv } from '@/lib/server/adminUsers';
import { sendOutboundEmail } from '@/lib/server/outboundEmail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'borrower-documents';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serviceClient() {
  const env = validateServerEnv();
  return createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
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
    .select('id, property_address, client_notice_email')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();

  if (dealError) {
    return NextResponse.json({ error: 'Could not send the MOU.' }, { status: 500 });
  }
  if (!deal) {
    return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });
  }

  const recipient = typeof deal.client_notice_email === 'string' ? deal.client_notice_email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(recipient)) {
    return NextResponse.json({ error: 'The MOU has no client email address.' }, { status: 400 });
  }

  const { data: current, error: currentError } = await supabase
    .from('deal_documents')
    .select('id, status, storage_path, file_name, version_number')
    .eq('application_id', id)
    .eq('document_type', 'mou')
    .maybeSingle();

  if (currentError) {
    return NextResponse.json({ error: 'Could not send the MOU.' }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: 'Generate the MOU before sending it.' }, { status: 404 });
  }
  if (current.status === 'sent_to_client') {
    return NextResponse.json({ error: 'The MOU was already sent.' }, { status: 409 });
  }
  if (current.status !== 'approved' || !current.storage_path) {
    return NextResponse.json({ error: 'Approve the MOU before sending it.' }, { status: 409 });
  }

  const { data: file, error: downloadError } = await supabase.storage.from(BUCKET).download(current.storage_path);
  if (downloadError || !file) {
    console.error('[mou] download before send failed', downloadError);
    return NextResponse.json({ error: 'Could not send the MOU.' }, { status: 500 });
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
    .select('status, version_number, file_name, storage_path, sent_to_email, sent_at')
    .maybeSingle();

  if (claimError) {
    console.error('[mou] send claim failed', claimError);
    return NextResponse.json({ error: 'Could not send the MOU.' }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: 'Approve the MOU before sending it.' }, { status: 409 });
  }

  const property = typeof deal.property_address === 'string' ? deal.property_address.trim() : '';
  const subject = property ? `Memorandum of Understanding — ${property}` : 'Memorandum of Understanding';
  const lines = ['The approved Memorandum of Understanding is attached.'];
  if (property) lines.push(`Property: ${property}`);
  lines.push(
    '',
    'Please review the attached file and reply to this email with any changes, or confirm that you agree.',
    '',
    'EarnestBridge'
  );
  const body = lines.join('\n');

  try {
    await sendOutboundEmail({
      emailType: 'admin_direct_message',
      to: recipient,
      subject,
      body,
      attachments: [
        {
          filename: current.file_name || 'MOU.docx',
          content,
          mimeType: DOCX_TYPE,
        },
      ],
    });
  } catch (error) {
    console.error('[mou] send failed', error);
    await supabase
      .from('deal_documents')
      .update({ status: 'approved', sent_to_email: null, sent_at: null })
      .eq('id', current.id)
      .eq('status', 'sent_to_client');
    const message = error instanceof Error ? error.message : '';
    if (message.includes('EB_EMAIL_INTERNAL_SECRET')) {
      return NextResponse.json({ error: 'Email is not configured.' }, { status: 500 });
    }
    return NextResponse.json({ error: 'Could not send the MOU.' }, { status: 500 });
  }

  const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(claimed.storage_path, 60 * 60);
  return NextResponse.json({
    document: {
      status: claimed.status,
      version_number: claimed.version_number,
      file_name: claimed.file_name,
      download_url: signed?.signedUrl ?? null,
      sent_to_email: claimed.sent_to_email,
      sent_at: claimed.sent_at,
    },
  });
}
