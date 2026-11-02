import { OPERATING_AGREEMENT_SOURCE_FIELDS } from '@/lib/documents/operatingAgreementFields';
import {
  approveGeneratedDocument,
  generateGeneratedDocument,
  getGeneratedDocument,
  type GeneratedDocumentSpec,
} from '@/lib/server/generatedDealDocument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const spec: GeneratedDocumentSpec = {
  documentType: 'operating_agreement',
  label: 'Operating Agreement',
  storageSlug: 'operating-agreement',
  fileBase: 'Operating-Agreement',
  templateFile: 'Operating-Agreement-DRE.docx',
  columns: 'id, llc_name, llc_formation_date, llc_act, llc_state, registered_agent',
  fields: OPERATING_AGREEMENT_SOURCE_FIELDS,
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
