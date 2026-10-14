import { createBrowserClient } from '@supabase/ssr';
import { SupabaseClient } from '@supabase/supabase-js';

const GLOBAL_KEY = '__supabase_browser_client__';

export function createClient(): SupabaseClient {
  if (typeof window !== 'undefined') {
    const g = globalThis as any;
    if (g[GLOBAL_KEY]) return g[GLOBAL_KEY];
    g[GLOBAL_KEY] = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    return g[GLOBAL_KEY];
  }
  // SSR fallback (should not be reached in browser context)
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
