import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function requireAdmin() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// GET /api/crm/search?q=...
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const supabase = getServiceClient();
  const pattern = `%${q}%`;

  const [contacts, companies, deals] = await Promise.all([
    // Search contacts
    supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, phone, lead_status, assigned_owner')
      .eq('is_merged', false)
      .is('purged_at', null)
      .or(`first_name.ilike.${pattern},last_name.ilike.${pattern},primary_email.ilike.${pattern},phone.ilike.${pattern}`)
      .limit(8),

    // Search companies
    supabase
      .from('crm_companies')
      .select('id, company_name, city, state')
      .ilike('company_name', pattern)
      .limit(5),

    // Search deals
    supabase
      .from('borrower_applications')
      .select('id, user_id, first_name, last_name, email, property_address, app_status')
      .is('purged_at', null)
      .or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern},property_address.ilike.${pattern}`)
      .limit(5),
  ]);

  // Also search alternate emails
  const { data: altEmails } = await supabase
    .from('crm_contact_emails')
    .select('contact_id, email')
    .ilike('email', pattern)
    .limit(5);

  const altContactIds = (altEmails || []).map(ae => ae.contact_id);
  let altContacts: typeof contacts.data = [];
  if (altContactIds.length > 0) {
    const { data } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, phone, lead_status, assigned_owner')
      .in('id', altContactIds)
      .eq('is_merged', false)
      .is('purged_at', null);
    altContacts = data || [];
  }

  const results = [
    ...(contacts.data || []).map(c => ({
      type: 'contact' as const,
      id: c.id,
      title: `${c.first_name} ${c.last_name}`,
      subtitle: c.primary_email,
      meta: c.lead_status,
      href: `/admin/crm/contacts/${c.id}`,
    })),
    ...altContacts.map(c => ({
      type: 'contact' as const,
      id: c.id,
      title: `${c.first_name} ${c.last_name}`,
      subtitle: c.primary_email + ' (alt email match)',
      meta: c.lead_status,
      href: `/admin/crm/contacts/${c.id}`,
    })),
    ...(companies.data || []).map(c => ({
      type: 'company' as const,
      id: c.id,
      title: c.company_name,
      subtitle: [c.city, c.state].filter(Boolean).join(', ') || 'Company',
      meta: 'Company',
      href: `/admin/crm/companies/${c.id}`,
    })),
    ...(deals.data || []).map(d => ({
      type: 'deal' as const,
      id: d.id,
      title: d.property_address || `${d.first_name} ${d.last_name} Deal`,
      subtitle: d.email,
      meta: d.app_status,
      href: d.user_id ? `/admin/borrower/${d.user_id}/application/${d.id}` : `/admin/deals`,
    })),
  ];

  // Deduplicate by id
  const seen = new Set<string>();
  const unique = results.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  return NextResponse.json({ results: unique.slice(0, 15) });
}
