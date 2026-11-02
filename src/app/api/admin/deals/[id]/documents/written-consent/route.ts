import { WRITTEN_CONSENT_SOURCE_FIELDS } from '@/lib/documents/writtenConsentFields';
import {
  approveGeneratedDocument,
  generateGeneratedDocument,
  getGeneratedDocument,
  type GeneratedDocumentSpec,
} from '@/lib/server/generatedDealDocument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const spec: GeneratedDocumentSpec = {
  documentType: 'written_consent',
  label: 'Written Consent',
  storageSlug: 'written-consent',
  fileBase: 'Written-Consent',
  templateFile: 'Action-by-Written-Consent-of-Mgr-FORM-NO-SIG.docx',
  columns: 'id, llc_name, client_representative_name, psa_title',
  fields: WRITTEN_CONSENT_SOURCE_FIELDS,
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
