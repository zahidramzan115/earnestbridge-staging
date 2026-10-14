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

async function getAuthClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}

async function requireAdmin() {
  const supabase = await getAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// GET /api/crm/deals — list deals with CRM context
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || '';
  const owner = searchParams.get('owner') || '';
  const contactId = searchParams.get('contact_id') || '';
  const companyId = searchParams.get('company_id') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = (page - 1) * limit;

  const supabase = getServiceClient();

  let query = supabase
    .from('borrower_applications')
    .select(`
      id, first_name, last_name, email, phone, company_name,
      property_address, property_type, purchase_price, deposit_amount,
      closing_date, app_status, submitted_at, created_at,
      eb_assigned_owner, primary_contact_id, crm_company_id,
      deal_workflow_stage,
      crm_contacts:primary_contact_id(id, first_name, last_name, lead_status, portal_link_status),
      crm_companies:crm_company_id(id, company_name),
      crm_deal_contacts(contact_id, role, crm_contacts(id, first_name, last_name))
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,property_address.ilike.%${search}%,company_name.ilike.%${search}%`
    );
  }
  if (status && status !== 'all') query = query.eq('app_status', status);
  if (owner && owner !== 'All') query = query.eq('eb_assigned_owner', owner);
  if (companyId) query = query.eq('crm_company_id', companyId);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If filtering by contact_id, filter in JS (join table)
  let deals = data || [];
  if (contactId) {
    deals = deals.filter((d: any) =>
      d.primary_contact_id === contactId ||
      (d.crm_deal_contacts || []).some((dc: any) => dc.contact_id === contactId)
    );
  }

  return NextResponse.json({ deals, total: count, page, limit });
}
