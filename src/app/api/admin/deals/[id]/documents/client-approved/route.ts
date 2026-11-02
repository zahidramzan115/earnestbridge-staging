import { markSentDocumentsClientApproved } from '@/lib/server/generatedDealDocument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return markSentDocumentsClientApproved(context);
}
