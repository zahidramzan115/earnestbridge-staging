import { AFFIDAVIT_SOURCE_FIELDS } from '@/lib/documents/affidavitFields';
import {
  approveGeneratedDocument,
  generateGeneratedDocument,
  getGeneratedDocument,
  type GeneratedDocumentSpec,
} from '@/lib/server/generatedDealDocument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const spec: GeneratedDocumentSpec = {
  documentType: 'affidavit',
  label: 'Affidavit',
  storageSlug: 'affidavit',
  fileBase: 'Affidavit',
  templateFile: 'EarnestBridge_Affidavit_Ownership_and_Authority.docx',
  columns:
    'id, client_legal_name, llc_name, client_notice_address, client_signatory_name, client_signatory_title',
  fields: AFFIDAVIT_SOURCE_FIELDS,
};

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return getGeneratedDocument(context, spec);
}

export function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return generateGeneratedDocument(context, spec);
}

export function PATCH(_request: Request, context: { params: Promise<{ id: string }> }) {
  return approveGeneratedDocument(context, spec);
}
