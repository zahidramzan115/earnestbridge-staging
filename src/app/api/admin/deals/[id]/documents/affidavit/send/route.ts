import { sendGeneratedDocument } from '@/lib/server/generatedDealDocument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return sendGeneratedDocument(context, {
    documentType: 'affidavit',
    label: 'Affidavit',
    fileBase: 'Affidavit',
  });
}
