import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';


import crypto from 'crypto';

// ─── Allowed CORS origins ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://earnestbridge.com',
  'https://www.earnestbridge.com',
  'https://app.earnestbridge.com',
  'https://earnestbri3677.builtwithrocket.new',
  // Dev environments
  'http://localhost:3000',
  'http://localhost:3001',
];

function getCorsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ─── Service client (bypasses RLS for CRM writes) ─────────────────────────────
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key);
}

// ─── In-memory rate limiter (per IP, 5 requests per 60s) ─────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true; // allowed
  }
  if (entry.count >= RATE_LIMIT_MAX) return false; // blocked
  entry.count++;
  return true;
}

// ─── Input sanitization ───────────────────────────────────────────────────────
function sanitizeText(v: unknown, maxLen = 500): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen).replace(/[<>]/g, '');
}

function sanitizeEmail(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.toLowerCase().trim().slice(0, 254);
}

function sanitizePhone(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/[^0-9+\-().x ]/g, '').slice(0, 30);
}

function sanitizeUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim().slice(0, 2048);
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return trimmed;
  } catch {
    return '';
  }
}

function sanitizeUtm(v: unknown): string {
  return sanitizeText(v, 200);
}

function sanitizePromoCode(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 50);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ─── Idempotency key ──────────────────────────────────────────────────────────
function buildIdempotencyKey(email: string, message: string): string {
  const windowMs = 30_000;
  const window = Math.floor(Date.now() / windowMs);
  const raw = `${email}|${message.slice(0, 100)}|${window}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 64);
}

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────────
export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(origin) });
}

// ─── POST /api/crm/contact-form ───────────────────────────────────────────────
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment before submitting again.' },
      { status: 429, headers: corsHeaders }
    );
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
  }

  // ── Sanitize inputs ────────────────────────────────────────────────────────
  const first_name    = sanitizeText(rawBody.first_name, 100);
  const last_name     = sanitizeText(rawBody.last_name, 100);
  const email         = sanitizeEmail(rawBody.email);
  const phone         = sanitizePhone(rawBody.phone);
  const company_name  = sanitizeText(rawBody.company_name, 200);
  const message       = sanitizeText(rawBody.message, 2000);
  const inquiry_type  = sanitizeText(rawBody.inquiry_type, 100);
  const property_address = sanitizeText(rawBody.property_address, 300);
  const property_type    = sanitizeText(rawBody.property_type, 100);
  const purchase_price   = typeof rawBody.purchase_price === 'number' ? rawBody.purchase_price : null;
  const deposit_amount   = typeof rawBody.deposit_amount === 'number' ? rawBody.deposit_amount : null;
  const estimated_emd_amount  = typeof rawBody.estimated_emd_amount === 'number' ? rawBody.estimated_emd_amount : null;
  const target_closing_date   = sanitizeText(rawBody.target_closing_date, 20);
  const closing_date          = sanitizeText(rawBody.closing_date, 20);

  // due_diligence_days: optional during transition; when supplied must be an integer 1–999
  let due_diligence_days: number | null = null;
  const rawDd = rawBody.due_diligence_days;
  if (rawDd !== undefined && rawDd !== null && rawDd !== '') {
    const ddStr = typeof rawDd === 'number' ? String(rawDd) : typeof rawDd === 'string' ? rawDd.trim() : '';
    const ddNum = /^\d{1,4}$/.test(ddStr) ? parseInt(ddStr, 10) : NaN;
    if (!Number.isInteger(ddNum) || ddNum < 1 || ddNum > 999) {
      return NextResponse.json(
        { error: 'due_diligence_days must be a whole number between 1 and 999' },
        { status: 400, headers: corsHeaders }
      );
    }
    due_diligence_days = ddNum;
  }
  const lead_source   = sanitizeText(rawBody.lead_source || 'Website Contact Form', 100);
  const landing_page  = sanitizeUrl(rawBody.landing_page);
  const referrer      = sanitizeUrl(rawBody.referrer);
  const utm_source    = sanitizeUtm(rawBody.utm_source);
  const utm_medium    = sanitizeUtm(rawBody.utm_medium);
  const utm_campaign  = sanitizeUtm(rawBody.utm_campaign);
  const utm_content   = sanitizeUtm(rawBody.utm_content);
  const utm_term      = sanitizeUtm(rawBody.utm_term);
  const promo_code    = sanitizePromoCode(rawBody.promo_code);

  // ── Server-side validation ─────────────────────────────────────────────────
  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400, headers: corsHeaders });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400, headers: corsHeaders });
  }
  if (!first_name && !last_name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400, headers: corsHeaders });
  }

  // ── Idempotency check ──────────────────────────────────────────────────────
  const idempotencyKey = buildIdempotencyKey(email, message);
  const supabase = getServiceClient();

  const { data: existingKey } = await supabase
    .from('crm_submission_idempotency')
    .select('contact_id')
    .eq('idempotency_key', idempotencyKey)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (existingKey) {
    // Duplicate submission within 30s window — return success silently
    console.log(`[CRM] Idempotent duplicate submission blocked for ${email}`);
    return NextResponse.json(
      { success: true, contactId: existingKey.contact_id, isDuplicate: true, message: 'Submission already received' },
      { status: 200, headers: corsHeaders }
    );
  }

  try {
    // ── Check for existing contact by primary email ────────────────────────
    let existingContact = null;
    const { data: primaryMatch } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, lead_status, assigned_owner')
      .eq('is_merged', false)
      .eq('primary_email', email)
      .maybeSingle();

    if (primaryMatch) {
      existingContact = primaryMatch;
    } else {
      // Check alternate emails
      const { data: altMatch } = await supabase
        .from('crm_contact_emails')
        .select('contact_id, crm_contacts!inner(id, first_name, last_name, primary_email, lead_status, assigned_owner, is_merged)')
        .eq('email', email)
        .eq('crm_contacts.is_merged', false)
        .maybeSingle();

      if (altMatch && altMatch.crm_contacts) {
        existingContact = altMatch.crm_contacts as typeof primaryMatch;
      }
    }

    let contactId: string;
    let isNewContact = false;

    // ── Company matching/creation ──────────────────────────────────────────
    let companyId: string | null = null;
    if (company_name) {
      const { data: exactCompany } = await supabase
        .from('crm_companies')
        .select('id')
        .ilike('company_name', company_name)
        .maybeSingle();

      if (exactCompany) {
        companyId = exactCompany.id;
      }
      // Note: fuzzy company matching is intentionally NOT done here.
      // Admin should manually link companies. We only auto-link on exact match.
    }

    if (!existingContact) {
      // ── Create new contact ───────────────────────────────────────────────
      isNewContact = true;
      const { data: newContact, error: contactError } = await supabase
        .from('crm_contacts')
        .insert({
          first_name: first_name || '',
          last_name: last_name || '',
          primary_email: email,
          phone: phone || null,
          company_id: companyId,
          lead_status: 'New Lead',
          assigned_owner: 'Unassigned',
          lead_source,
          original_lead_source: lead_source,
          original_campaign: utm_campaign || null,
          latest_lead_source: lead_source,
          latest_campaign: utm_campaign || null,
          portal_link_status: 'none',
        })
        .select('id')
        .single();

      if (contactError || !newContact) {
        console.error('[CRM] Failed to create contact:', contactError);
        return NextResponse.json({ error: 'Failed to create contact' }, { status: 500, headers: corsHeaders });
      }
      contactId = newContact.id;

      await supabase.from('crm_activities').insert({
        contact_id: contactId,
        event_type: 'contact_created',
        title: 'New lead created from website contact form',
        detail: `${first_name || ''} ${last_name || ''} submitted the contact form.`,
        actor: 'Website Form',
        metadata: { utm_source, utm_medium, utm_campaign, promo_code: promo_code || null },
      });

    } else {
      // ── Existing contact ─────────────────────────────────────────────────
      contactId = existingContact.id;

      await supabase
        .from('crm_contacts')
        .update({
          latest_lead_source: lead_source,
          latest_campaign: utm_campaign || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contactId);

      await supabase.from('crm_activities').insert({
        contact_id: contactId,
        event_type: 'repeat_inquiry',
        title: 'Existing contact submitted new website inquiry',
        detail: `${email} submitted the contact form again.`,
        actor: 'Website Form',
        metadata: { utm_source, utm_medium, utm_campaign, promo_code: promo_code || null },
      });
    }

    // ── Create submission record (always) ──────────────────────────────────
    await supabase.from('crm_contact_submissions').insert({
      contact_id: contactId,
      first_name,
      last_name,
      email,
      phone: phone || null,
      company_name: company_name || null,
      message: message || null,
      inquiry_type: inquiry_type || null,
      property_address: property_address || null,
      property_type: property_type || null,
      purchase_price: purchase_price,
      deposit_amount: deposit_amount,
      estimated_emd_amount: estimated_emd_amount,
      target_closing_date: target_closing_date || null,
      closing_date: closing_date || null,
      due_diligence_days: due_diligence_days,
      lead_source,
      landing_page: landing_page || null,
      referrer: referrer || null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
      utm_term: utm_term || null,
      promo_code: promo_code || null,
      promo_code_used: promo_code || null,
      is_new_contact: isNewContact,
    });

    // ── Store idempotency key ──────────────────────────────────────────────
    await supabase.from('crm_submission_idempotency').insert({
      idempotency_key: idempotencyKey,
      contact_id: contactId,
    }).onConflict('idempotency_key').ignore();

    // ── Admin in-app notification ──────────────────────────────────────────
    try {
      const { data: adminUsers } = await supabase
        .from('auth.users')
        .select('id')
        .or('raw_app_meta_data->>role.eq.admin,raw_user_meta_data->>role.eq.admin')
        .limit(5);

      if (adminUsers && adminUsers.length > 0) {
        const notifTitle = isNewContact
          ? `New Lead: ${first_name} ${last_name}`.trim()
          : `Existing Contact New Inquiry: ${first_name} ${last_name}`.trim();
        const notifMsg = isNewContact
          ? `${email}${company_name ? ' · ' + company_name : ''} submitted via website contact form.`
          : `${email} submitted another inquiry. Existing CRM contact.`;

        await supabase.from('notifications').insert(
          adminUsers.map((u: { id: string }) => ({
            user_id: u.id,
            type: isNewContact ? 'crm_new_lead' : 'crm_repeat_inquiry',
            title: notifTitle,
            message: notifMsg,
            crm_contact_id: contactId,
          }))
        );
      }
    } catch (notifErr) {
      console.error('[CRM] Admin notification failed (non-fatal):', notifErr);
    }

    // ── Admin email notification ───────────────────────────────────────────
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (supabaseUrl && supabaseAnonKey) {
        await fetch(`${supabaseUrl}/functions/v1/send-borrower-emails`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
          body: JSON.stringify({
            emailType: 'admin_new_application',
            borrower: {
              firstName: first_name || '',
              lastName: last_name || '',
              email,
            },
            application: {
              propertyAddress: company_name || message || '',
              newStatus: isNewContact ? 'New Lead' : 'Repeat Inquiry',
              statusLabel: isNewContact
                ? `New Lead from ${lead_source}`
                : 'Existing Contact — New Inquiry',
            },
          }),
        });
      }
    } catch (emailErr) {
      console.error('[CRM] Admin email notification failed (non-fatal):', emailErr);
    }

    return NextResponse.json(
      {
        success: true,
        contactId,
        isNewContact,
        message: isNewContact ? 'New CRM contact created' : 'Submission attached to existing contact',
      },
      { status: 200, headers: corsHeaders }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    console.error('[CRM] Contact form error:', err);
    return NextResponse.json({ error: 'An error occurred processing your submission' }, { status: 500, headers: corsHeaders });
  }
}
