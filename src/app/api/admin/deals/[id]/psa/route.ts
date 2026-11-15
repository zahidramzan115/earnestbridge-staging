import { NextRequest, NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/server/adminAuth';
import { createServiceRoleClient, validateServerEnv } from '@/lib/server/adminUsers';
import {
  PSA_BUCKET,
  PSA_MAX_BYTES,
  getDealPsa,
  isPsaPathForDeal,
  newPsaPath,
} from '@/lib/server/dealPsa';

// Executed PSA (Exhibit A) for a deal. Admin only.
//
// GET                         current PSA + short-lived download link
// POST {action:'start', fileName, size}
//                             returns a one-time signed upload URL; the browser
//                             uploads the PDF straight to Storage (avoids the
//                             hosting request-size limit)
// POST {action:'complete', path, fileName}
//                             checks the uploaded file is a PDF, then makes it
//                             the deal's current PSA and removes the old file

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorize(context: { params: Promise<{ id: string }> }) {
  const auth = await checkAdmin();
  if (!auth.ok) {
    return { response: NextResponse.json({ error: auth.status === 401 ? 'Unauthorized.' : 'Forbidden.' }, { status: auth.status }) };
  }
  const { id } = await context.params;
  if (!id || !UUID_RE.test(id)) {
    return { response: NextResponse.json({ error: 'Deal not found.' }, { status: 404 }) };
  }
  let env;
  try {
    env = validateServerEnv();
  } catch {
    return { response: NextResponse.json({ error: 'Server is not configured.' }, { status: 500 }) };
  }
  const supabase = createServiceRoleClient(env.supabaseUrl, env.serviceRoleKey);
  const { data: deal } = await supabase
    .from('borrower_applications')
    .select('id')
    .eq('id', id)
    .is('purged_at', null)
    .maybeSingle();
  if (!deal) {
    return { response: NextResponse.json({ error: 'Deal not found.' }, { status: 404 }) };
  }
  return { id, userId: auth.user.id, supabase };
}

function cleanFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
  return name.toLowerCase().endsWith('.pdf') && name.length > 4 ? name : null;
}

async function present(supabase: ReturnType<typeof createServiceRoleClient>, dealId: string) {
  const psa = await getDealPsa(supabase, dealId);
  if (!psa) return null;
  const { data } = await supabase.storage.from(PSA_BUCKET).createSignedUrl(psa.storage_path, 60 * 60);
  return { file_name: psa.file_name, file_size: psa.file_size, uploaded_at: psa.uploaded_at, url: data?.signedUrl ?? null };
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await authorize(context);
  if ('response' in access) return access.response;
  try {
    return NextResponse.json({ psa: await present(access.supabase, access.id) });
  } catch {
    return NextResponse.json({ error: 'Could not load the PSA.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await authorize(context);
  if ('response' in access) return access.response;
  const { id, userId, supabase } = access;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });

  if (body.action === 'start') {
    const fileName = cleanFileName(body.fileName);
    const size = typeof body.size === 'number' ? body.size : 0;
    if (!fileName) return NextResponse.json({ error: 'The PSA must be a PDF file.' }, { status: 400 });
    if (size <= 0 || size > PSA_MAX_BYTES) {
      return NextResponse.json({ error: 'The PSA must be a PDF up to 50 MB.' }, { status: 400 });
    }
    const path = newPsaPath(id);
    const { data, error } = await supabase.storage.from(PSA_BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      return NextResponse.json({ error: 'Could not start the upload.' }, { status: 500 });
    }
    return NextResponse.json({ path: data.path, token: data.token });
  }

  if (body.action === 'complete') {
    const path = typeof body.path === 'string' ? body.path : '';
    const fileName = cleanFileName(body.fileName);
    if (!isPsaPathForDeal(path, id) || !fileName) {
      return NextResponse.json({ error: 'Invalid upload.' }, { status: 400 });
    }

    const { data: blob, error: downloadError } = await supabase.storage.from(PSA_BUCKET).download(path);
    if (downloadError || !blob) {
      return NextResponse.json({ error: 'The uploaded file was not found.' }, { status: 400 });
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.length === 0 || bytes.length > PSA_MAX_BYTES || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      await supabase.storage.from(PSA_BUCKET).remove([path]);
      return NextResponse.json({ error: 'The PSA must be a valid PDF file.' }, { status: 400 });
    }

    let previous;
    try {
      previous = await getDealPsa(supabase, id);
    } catch {
      return NextResponse.json({ error: 'Could not save the PSA.' }, { status: 500 });
    }

    const { error: saveError } = await supabase.from('deal_psa_files').upsert(
      {
        application_id: id,
        storage_path: path,
        file_name: fileName,
        file_size: bytes.length,
        uploaded_by: userId,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: 'application_id' },
    );
    if (saveError) {
      return NextResponse.json({ error: 'Could not save the PSA.' }, { status: 500 });
    }

    if (previous && previous.storage_path !== path) {
      await supabase.storage.from(PSA_BUCKET).remove([previous.storage_path]);
    }

    return NextResponse.json({ psa: await present(supabase, id) });
  }

  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
