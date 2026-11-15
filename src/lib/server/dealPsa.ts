import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

// Executed PSA uploaded by Admin. Exhibit A for the Option Agreement and the
// Written Action. Stored in the private borrower-documents bucket.

export const PSA_BUCKET = 'borrower-documents';
export const PSA_MAX_BYTES = 50 * 1024 * 1024; // bucket limit

export interface DealPsa {
  storage_path: string;
  file_name: string;
  file_size: number;
  uploaded_at: string;
}

export async function getDealPsa(supabase: SupabaseClient, dealId: string): Promise<DealPsa | null> {
  const { data, error } = await supabase
    .from('deal_psa_files')
    .select('storage_path, file_name, file_size, uploaded_at')
    .eq('application_id', dealId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the PSA: ${error.message}`);
  return (data as DealPsa | null) ?? null;
}

/** Storage path for a new upload. Only paths of this shape are accepted back. */
export function newPsaPath(dealId: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `psa/${dealId}/${suffix}.pdf`;
}

/** Documents that carry the PSA as Exhibit A. */
export const PSA_EXHIBIT_DOCUMENT_TYPES = new Set(['option_agreement', 'written_consent']);

export function isPsaPathForDeal(path: string, dealId: string): boolean {
  return new RegExp(`^psa/${dealId}/\\d+-[a-z0-9]+\\.pdf$`).test(path);
}
