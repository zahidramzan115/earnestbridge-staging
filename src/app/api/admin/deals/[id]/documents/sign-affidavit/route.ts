import { sendAffidavitForSignature } from '@/lib/server/generatedDealDocument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return sendAffidavitForSignature(context);
}
