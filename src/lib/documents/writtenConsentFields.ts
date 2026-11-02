export const WRITTEN_CONSENT_SOURCE_FIELDS = [
  { key: 'llc_name', label: 'LLC name', token: '[LLC]', kind: 'text' },
  { key: 'client_representative_name', label: 'Representative', token: '[CLIENT REPRESENTATIVE]', kind: 'text' },
  { key: 'psa_title', label: 'PSA title', token: '[PSA TITLE]', kind: 'text' },
] as const;

export const WRITTEN_CONSENT_FIELD_KEYS = new Set<string>(
  WRITTEN_CONSENT_SOURCE_FIELDS.map((field) => field.key)
);
