import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ─── Constants (server-side only — never from browser) ────────────────────────
const BPCON26_CAMPAIGN      = 'BPCON26';
const BPCON26_DISCOUNT_TYPE = 'fixed_amount';
const BPCON26_DISCOUNT_AMT  = 1250;
const BPCON26_ORIGINAL_FEE  = 2500;
const BPCON26_LEAD_SOURCE   = 'BPCON26 Landing Page';

// ─── Allowed CORS origins ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://earnestbridge.com',
  'https://www.earnestbridge.com',
  'https://app.earnestbridge.com',
  'https://earnestbri3677.builtwithrocket.new',
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

// ─── Service client — privileged CRM writes, never falls back to anon ─────────
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('[BPCON26] NEXT_PUBLIC_SUPABASE_URL is not configured');
  }
  if (!key || key === 'your-supabase-service-role-key-here') {
    throw new Error('[BPCON26] SUPABASE_SERVICE_ROLE_KEY is not configured — cannot perform privileged CRM writes');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
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

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ─── Cryptographically secure promo code generation ───────────────────────────
function generateBpcon26PromoCode(): string {
  // 6 uppercase alphanumeric chars from a cryptographically secure source
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const bytes = crypto.randomBytes(6);
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars[bytes[i] % chars.length];
  }
  return `BPCON26-${suffix}`;
}

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────────
export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(origin) });
}

// ─── POST /api/crm/bpcon26-claim ─────────────────────────────────────────────
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
  }

  // ── Sanitize inputs ────────────────────────────────────────────────────────
  const first_name            = sanitizeText(rawBody.first_name, 100);
  const last_name             = sanitizeText(rawBody.last_name, 100);
  const email                 = sanitizeEmail(rawBody.email);
  const phone                 = sanitizePhone(rawBody.phone);
  const company_name          = sanitizeText(rawBody.company_name, 200);
  const active_deal           = typeof rawBody.active_deal === 'boolean' ? rawBody.active_deal : null;
  const estimated_emd_amount  = typeof rawBody.estimated_emd_amount === 'number' ? rawBody.estimated_emd_amount : null;
  const target_closing_date   = sanitizeText(rawBody.target_closing_date, 20);
  const landing_page          = sanitizeUrl(rawBody.landing_page);
  const referrer              = sanitizeUrl(rawBody.referrer);
  const utm_source            = sanitizeUtm(rawBody.utm_source);
  const utm_medium            = sanitizeUtm(rawBody.utm_medium);
  const utm_campaign          = sanitizeUtm(rawBody.utm_campaign);
  const utm_content           = sanitizeUtm(rawBody.utm_content);
  const utm_term              = sanitizeUtm(rawBody.utm_term);

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: 'Valid email is required' }, { status: 400, headers: corsHeaders });
  }
  if (!first_name && !last_name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400, headers: corsHeaders });
  }

  // ── Initialize service client ──────────────────────────────────────────────
  let supabase: ReturnType<typeof createClient>;
  try {
    supabase = getServiceClient();
  } catch (configErr: unknown) {
    const msg = configErr instanceof Error ? configErr.message : 'Server configuration error';
    console.error(msg);
    return NextResponse.json({ error: 'Server configuration error. Please contact support.' }, { status: 500, headers: corsHeaders });
  }

  try {
    // ── Step 1: Find or create CRM Contact ────────────────────────────────────
    let existingContact: { id: string; first_name: string; last_name: string; primary_email: string } | null = null;

    const { data: primaryMatch } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email')
      .eq('is_merged', false)
      .eq('primary_email', email)
      .maybeSingle();

    if (primaryMatch) {
      existingContact = primaryMatch;
    } else {
      const { data: altMatch } = await supabase
        .from('crm_contact_emails')
        .select('contact_id, crm_contacts!inner(id, first_name, last_name, primary_email, is_merged)')
        .eq('email', email)
        .eq('crm_contacts.is_merged', false)
        .maybeSingle();

      if (altMatch && altMatch.crm_contacts) {
        existingContact = altMatch.crm_contacts as typeof primaryMatch;
      }
    }

    let contactId: string;
    let isNewContact = false;

    // ── Company matching ───────────────────────────────────────────────────
    let companyId: string | null = null;
    if (company_name) {
      const { data: exactCompany } = await supabase
        .from('crm_companies')
        .select('id')
        .ilike('company_name', company_name)
        .maybeSingle();
      if (exactCompany) companyId = exactCompany.id;
    }

    if (!existingContact) {
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
          lead_source: BPCON26_LEAD_SOURCE,
          original_lead_source: BPCON26_LEAD_SOURCE,
          original_campaign: BPCON26_CAMPAIGN,
          latest_lead_source: BPCON26_LEAD_SOURCE,
          latest_campaign: BPCON26_CAMPAIGN,
          portal_link_status: 'none',
        })
        .select('id')
        .single();

      if (contactError || !newContact) {
        console.error('[BPCON26] Failed to create contact:', contactError);
        return NextResponse.json({ error: 'Failed to create CRM contact' }, { status: 500, headers: corsHeaders });
      }
      contactId = newContact.id;
    } else {
      contactId = existingContact.id;
      // Update latest lead source for existing contact
      await supabase
        .from('crm_contacts')
        .update({
          latest_lead_source: BPCON26_LEAD_SOURCE,
          latest_campaign: BPCON26_CAMPAIGN,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contactId);
    }

    // ── Step 2: Check for existing non-voided BPCON26 promo ───────────────────
    const { data: existingPromo } = await supabase
      .from('crm_promo_codes')
      .select('id, promo_code, claimed_at')
      .eq('campaign', BPCON26_CAMPAIGN)
      .is('voided_at', null)
      .ilike('email', email)
      .maybeSingle();

    let promoCode: string;
    let isExistingPromo = false;

    if (existingPromo) {
      // ── Repeat claim: return existing promo ─────────────────────────────
      isExistingPromo = true;
      promoCode = existingPromo.promo_code;

      // Update last_resent_at
      await supabase
        .from('crm_promo_codes')
        .update({ last_resent_at: new Date().toISOString() })
        .eq('id', existingPromo.id);

      // CRM Activity: promo email resent
      await supabase.from('crm_activities').insert({
        contact_id: contactId,
        event_type: 'bpcon26_promo_resent',
        title: 'BPCON26 promo email resent',
        detail: `Promo code ${promoCode} resent to ${email}.`,
        actor: 'BPCON26 Landing Page',
        metadata: { promo_code: promoCode, utm_source, utm_medium, utm_campaign },
      });

    } else {
      // ── First claim: create submission + promo ───────────────────────────

      // Step 2a: Create CRM Contact Submission
      await supabase.from('crm_contact_submissions').insert({
        contact_id: contactId,
        first_name,
        last_name,
        email,
        phone: phone || null,
        company_name: company_name || null,
        message: active_deal != null
          ? `Active Deal: ${active_deal ? 'Yes' : 'No'}${estimated_emd_amount ? ` | EMD: $${estimated_emd_amount}` : ''}${target_closing_date ? ` | Target Close: ${target_closing_date}` : ''}`
          : null,
        inquiry_type: 'BPCON26 Promo Claim',
        estimated_emd_amount: estimated_emd_amount,
        target_closing_date: target_closing_date || null,
        lead_source: BPCON26_LEAD_SOURCE,
        landing_page: landing_page || null,
        referrer: referrer || null,
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
        utm_content: utm_content || null,
        utm_term: utm_term || null,
        is_new_contact: isNewContact,
      });

      // Step 2b: Generate unique promo code (retry up to 5 times on collision)
      let generatedCode = '';
      let promoInserted = false;
      let promoId = '';

      for (let attempt = 0; attempt < 5; attempt++) {
        generatedCode = generateBpcon26PromoCode();
        const { data: inserted, error: promoError } = await supabase
          .from('crm_promo_codes')
          .insert({
            campaign: BPCON26_CAMPAIGN,
            promo_code: generatedCode,
            crm_contact_id: contactId,
            email,
            status: 'claimed',
            discount_type: BPCON26_DISCOUNT_TYPE,
            discount_amount: BPCON26_DISCOUNT_AMT,
            original_fee: BPCON26_ORIGINAL_FEE,
            landing_page: landing_page || null,
            referrer: referrer || null,
            utm_source: utm_source || null,
            utm_medium: utm_medium || null,
            utm_campaign: utm_campaign || null,
            utm_content: utm_content || null,
            utm_term: utm_term || null,
          })
          .select('id')
          .single();

        if (!promoError && inserted) {
          promoInserted = true;
          promoId = inserted.id;
          break;
        }

        // If unique_violation on one_per_email_campaign index, another request won the race
        if (promoError?.code === '23505' && promoError.message?.includes('one_per_email_campaign')) {
          // Race condition: fetch the winner
          const { data: raceWinner } = await supabase
            .from('crm_promo_codes')
            .select('id, promo_code')
            .eq('campaign', BPCON26_CAMPAIGN)
            .is('voided_at', null)
            .ilike('email', email)
            .maybeSingle();
          if (raceWinner) {
            generatedCode = raceWinner.promo_code;
            promoId = raceWinner.id;
            isExistingPromo = true;
            promoInserted = true;
            break;
          }
        }

        // If unique_violation on promo_code uniqueness, retry with new code
        if (promoError?.code !== '23505') {
          console.error('[BPCON26] Promo insert error:', promoError);
          return NextResponse.json({ error: 'Failed to generate promo code' }, { status: 500, headers: corsHeaders });
        }
      }

      if (!promoInserted) {
        console.error('[BPCON26] Failed to insert unique promo code after 5 attempts');
        return NextResponse.json({ error: 'Failed to generate unique promo code' }, { status: 500, headers: corsHeaders });
      }

      promoCode = generatedCode;

      // Step 2c: CRM Activity — promo claimed
      await supabase.from('crm_activities').insert({
        contact_id: contactId,
        event_type: 'bpcon26_promo_claimed',
        title: 'BPCON26 promo claimed',
        detail: `Promo code ${promoCode} issued to ${email}. New contact: ${isNewContact ? 'Yes' : 'No'}.`,
        actor: 'BPCON26 Landing Page',
        metadata: {
          promo_code: promoCode,
          promo_id: promoId,
          is_new_contact: isNewContact,
          utm_source,
          utm_medium,
          utm_campaign,
          active_deal,
          estimated_emd_amount,
        },
      });
    }

    // ── Step 3: Admin in-app notification ─────────────────────────────────────
    try {
      const { data: adminUsers } = await supabase
        .from('auth.users')
        .select('id')
        .or('raw_app_meta_data->>role.eq.admin,raw_user_meta_data->>role.eq.admin')
        .limit(5);

      if (adminUsers && adminUsers.length > 0) {
        const contactName = `${first_name} ${last_name}`.trim() || email;
        const notifTitle = `BPCON26 Promo Claimed — ${contactName}`;
        const notifMsg = [
          `Contact: ${contactName}`,
          company_name ? `Company: ${company_name}` : null,
          `Email: ${email}`,
          active_deal != null ? `Active Deal: ${active_deal ? 'Yes' : 'No'}` : null,
          estimated_emd_amount ? `EMD Amount: $${estimated_emd_amount.toLocaleString()}` : null,
          target_closing_date ? `Target Close: ${target_closing_date}` : null,
          `Promo Code: ${promoCode}`,
          `${isNewContact ? 'New Contact' : 'Existing Contact'}`,
        ].filter(Boolean).join(' · ');

        await supabase.from('notifications').insert(
          adminUsers.map((u: { id: string }) => ({
            user_id: u.id,
            type: 'bpcon26_promo_claimed',
            title: notifTitle,
            message: notifMsg,
            crm_contact_id: contactId,
          }))
        );
      }
    } catch (notifErr) {
      console.error('[BPCON26] Admin in-app notification failed (non-fatal):', notifErr);
    }

    // ── Step 4: Admin email notification ──────────────────────────────────────
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (supabaseUrl && supabaseAnonKey) {
        const contactUrl = `https://app.earnestbridge.com/admin/crm/contacts/${contactId}`;
        await fetch(`${supabaseUrl}/functions/v1/send-borrower-emails`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
          body: JSON.stringify({
            emailType: 'admin_bpcon26_promo_claimed',
            borrower: {
              firstName: first_name || '',
              lastName: last_name || '',
              email,
            },
            application: {
              companyName: company_name || '',
              activeDeal: active_deal,
              estimatedEmdAmount: estimated_emd_amount,
              targetClosingDate: target_closing_date || '',
              promoCode: promoCode,
              isNewContact,
              contactUrl,
              isExistingPromo,
            },
          }),
        });
      }
    } catch (adminEmailErr) {
      console.error('[BPCON26] Admin email notification failed (non-fatal):', adminEmailErr);
    }

    // ── Step 5: Claimant promo email ───────────────────────────────────────────
    let emailSent = false;
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (supabaseUrl && supabaseAnonKey) {
        const emailRes = await fetch(`${supabaseUrl}/functions/v1/send-borrower-emails`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
          body: JSON.stringify({
            emailType: 'bpcon26_promo_email',
            borrower: {
              firstName: first_name || '',
              lastName: last_name || '',
              email,
            },
            application: {
              promoCode,
              standardFee: BPCON26_ORIGINAL_FEE,
              promoFee: BPCON26_ORIGINAL_FEE - BPCON26_DISCOUNT_AMT,
              savings: BPCON26_DISCOUNT_AMT,
            },
          }),
        });
        emailSent = emailRes.ok;
        if (!emailRes.ok) {
          const errText = await emailRes.text();
          console.error('[BPCON26] Promo email failed (promo kept):', errText);
        }
      }
    } catch (emailErr) {
      // Email failure is non-fatal — promo is already persisted
      console.error('[BPCON26] Promo email exception (promo kept):', emailErr);
    }

    // ── Return response ────────────────────────────────────────────────────────
    return NextResponse.json(
      {
        success: true,
        isNewContact,
        isExistingPromo,
        promoCode,
        emailSent,
      },
      { status: 200, headers: corsHeaders }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    console.error('[BPCON26] Unhandled error:', err);
    return NextResponse.json({ error: 'An error occurred processing your claim' }, { status: 500, headers: corsHeaders });
  }
}
