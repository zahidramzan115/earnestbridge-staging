import { OPTION_SOURCE_FIELDS } from '@/lib/documents/optionFields';
import {
  approveGeneratedDocument,
  generateGeneratedDocument,
  getGeneratedDocument,
  type GeneratedDocumentSpec,
} from '@/lib/server/generatedDealDocument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const spec: GeneratedDocumentSpec = {
  documentType: 'option_agreement',
  label: 'Option Agreement',
  storageSlug: 'option-agreement',
  fileBase: 'Option-Agreement',
  templateFile: 'Option-Agreement-EMD-Program.docx',
  columns:
    'id, client_legal_name, property_address, llc_name, deposit_amount, option_term, client_notice_address, client_representative_name, client_notice_email, client_signatory_name, client_signatory_title, psa_title, option_effective_date',
  fields: OPTION_SOURCE_FIELDS,
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
