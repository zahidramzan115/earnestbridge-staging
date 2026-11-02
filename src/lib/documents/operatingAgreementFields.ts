export const OPERATING_AGREEMENT_SOURCE_FIELDS = [
  { key: 'llc_name', label: 'LLC name', token: '[LLC]', kind: 'text' },
  { key: 'llc_formation_date', label: 'LLC formation date', token: '[LLC FORMATION DATE]', kind: 'date' },
  { key: 'llc_act', label: 'LLC act', token: '[LLC ACT]', kind: 'text' },
  { key: 'llc_state', label: 'LLC state', token: '[LLC STATE]', kind: 'text' },
  { key: 'registered_agent', label: 'Registered agent', token: '[REGISTERED AGENT]', kind: 'text' },
] as const;

export const OPERATING_AGREEMENT_FIELD_KEYS = new Set<string>(
  OPERATING_AGREEMENT_SOURCE_FIELDS.map((field) => field.key)
);
