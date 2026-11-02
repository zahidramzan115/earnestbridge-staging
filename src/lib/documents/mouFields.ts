export const MOU_SOURCE_FIELDS = [
  { key: 'client_legal_name', label: 'Legal name', token: '[CLIENT]', kind: 'text' },
  { key: 'property_address', label: 'Property address', token: '[PROPERTY ADDRESS]', kind: 'text' },
  { key: 'deposit_amount', label: 'Earnest money amount', token: '[EMD AMOUNT]', kind: 'money' },
  { key: 'escrow_agent', label: 'Escrow agent', token: '[ESCROW AGENT]', kind: 'text' },
  { key: 'admin_fee', label: 'Admin fee', token: '[ADMIN FEE]', kind: 'money' },
  { key: 'deal_fee', label: 'Deal fee', token: '[DEAL FEE]', kind: 'money' },
  { key: 'option_term', label: 'Option term', token: '[OPTION TERM]', kind: 'text' },
  { key: 'client_notice_address', label: 'Notice address', token: '[CLIENT NOTICE ADDRESS]', kind: 'text' },
  { key: 'client_representative_name', label: 'Representative', token: '[REPRESENTATIVE]', kind: 'text' },
  { key: 'client_notice_email', label: 'Notice email', token: '[CLIENT EMAIL]', kind: 'text' },
  { key: 'client_signatory_name', label: 'Signatory', token: '[CLIENT SIGNATORY]', kind: 'text' },
  { key: 'client_signatory_title', label: 'Signatory title', token: '[CLIENT SIGNATORY TITLE]', kind: 'text' },
  { key: 'mou_effective_date', label: 'MOU effective date', token: '[EFFECTIVE DATE]', kind: 'date' },
] as const;

export type MouFieldKey = (typeof MOU_SOURCE_FIELDS)[number]['key'];

export const MOU_FIELD_KEYS = new Set<string>(MOU_SOURCE_FIELDS.map((field) => field.key));
