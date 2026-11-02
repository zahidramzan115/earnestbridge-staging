import { NextRequest, NextResponse } from 'next/server';
import { connectHmacValid } from '@/lib/server/docusign';
import { handleDocuSignConnect } from '@/lib/server/docusignConnect';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (!connectHmacValid(rawBody, request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const result = await handleDocuSignConnect(payload);
    if ('ok' in result) return NextResponse.json({ ok: true });
    return NextResponse.json({ error: result.error }, { status: result.status });
  } catch (error) {
    console.error('[docusign-connect] failed', error);
    return NextResponse.json({ error: 'Could not process the DocuSign event.' }, { status: 500 });
  }
}
