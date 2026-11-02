export const OPTION_SOURCE_FIELDS = [
  { key: 'option_effective_date', label: 'Option effective date', token: '[EFFECTIVE DATE]', kind: 'date' },
  { key: 'client_legal_name', label: 'Legal name', token: '[CLIENT]', kind: 'text' },
  { key: 'llc_name', label: 'LLC name', token: '[LLC]', kind: 'text' },
  { key: 'psa_title', label: 'PSA title', token: '[PSA TITLE]', kind: 'text' },
  { key: 'property_address', label: 'Property address', token: '[PROPERTY ADDRESS]', kind: 'text' },
  { key: 'option_term', label: 'Option term', token: '[OPTION TERM]', kind: 'text' },
  { key: 'client_notice_address', label: 'Notice address', token: '[CLIENT NOTICE ADDRESS]', kind: 'text' },
  { key: 'client_representative_name', label: 'Representative', token: '[REPRESENTATIVE]', kind: 'text' },
  { key: 'client_notice_email', label: 'Notice email', token: '[CLIENT EMAIL]', kind: 'text' },
  { key: 'client_signatory_name', label: 'Signatory', token: '[CLIENT SIGNATORY]', kind: 'text' },
  { key: 'client_signatory_title', label: 'Signatory title', token: '[CLIENT SIGNATORY TITLE]', kind: 'text' },
  { key: 'deposit_amount', label: 'Earnest money amount', token: '[$EMD AMOUNT]', kind: 'money_with_dollar' },
] as const;

export type OptionFieldKey = (typeof OPTION_SOURCE_FIELDS)[number]['key'];

export const OPTION_FIELD_KEYS = new Set<string>(OPTION_SOURCE_FIELDS.map((field) => field.key));
