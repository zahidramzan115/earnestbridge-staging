export const AFFIDAVIT_SOURCE_FIELDS = [
  { key: 'client_signatory_name', label: 'Signatory', token: '[CLIENT SIGNATORY]', kind: 'text' },
  { key: 'client_signatory_name', label: 'Signatory', token: '[Client Signatory]', kind: 'text' },
  { key: 'client_signatory_title', label: 'Signatory title', token: '[CLIENT SIGNATORY TITLE]', kind: 'text' },
  { key: 'client_legal_name', label: 'Legal name', token: '[CLIENT]', kind: 'text' },
  { key: 'llc_name', label: 'LLC name', token: '[LLC]', kind: 'text' },
  { key: 'client_notice_address', label: 'Notice address', token: '[Client Notice Address]', kind: 'text' },
] as const;

export type AffidavitFieldKey = (typeof AFFIDAVIT_SOURCE_FIELDS)[number]['key'];

export const AFFIDAVIT_FIELD_KEYS = new Set<string>(AFFIDAVIT_SOURCE_FIELDS.map((field) => field.key));
