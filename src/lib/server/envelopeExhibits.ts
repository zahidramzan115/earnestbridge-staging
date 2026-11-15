// Exhibit files placed in a DocuSign envelope right after the document they
// belong to. Nobody signs them; when the envelope completes they are joined
// onto the end of that document's signed PDF.

export const PSA_EXHIBIT_NAME = 'Exhibit A - Executed PSA';
export const LLC_AGREEMENT_EXHIBIT_NAME = 'Exhibit A - Executed LLC Agreement';
export const WRITTEN_ACTION_EXHIBIT_NAME = 'Exhibit B - Executed Written Action';

const EXHIBIT_KEYS = [PSA_EXHIBIT_NAME, LLC_AGREEMENT_EXHIBIT_NAME, WRITTEN_ACTION_EXHIBIT_NAME].map(compact);

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

/** DocuSign may return the name with or without the file extension. */
export function isExhibitEnvelopeFile(name: string): boolean {
  const key = compact(name);
  return EXHIBIT_KEYS.some((exhibit) => key.startsWith(exhibit));
}
