import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'crypto';

// ============================================================
// Coinflow server helpers: config, session key, checkout JWT,
// webhook authentication and payload parsing.
// The API key and webhook validation key never reach the browser.
// ============================================================

export type CoinflowEnv = 'sandbox' | 'prod';

export interface CoinflowConfig {
  env: CoinflowEnv;
  merchantId: string;
  apiKey: string;
  apiBase: string;
}

export function getCoinflowConfig(): CoinflowConfig {
  const rawEnv = (process.env.COINFLOW_ENV?.trim() || 'sandbox').toLowerCase();
  const env: CoinflowEnv = rawEnv === 'prod' || rawEnv === 'production' ? 'prod' : 'sandbox';
  const merchantId = process.env.COINFLOW_MERCHANT_ID?.trim();
  const apiKey = process.env.COINFLOW_API_KEY?.trim();
  if (!merchantId || !apiKey) {
    throw new Error('COINFLOW_MERCHANT_ID and COINFLOW_API_KEY must be set');
  }
  return {
    env,
    merchantId,
    apiKey,
    apiBase: env === 'prod' ? 'https://api.coinflow.cash' : 'https://api-sandbox.coinflow.cash',
  };
}

async function coinflowFetch<T>(cfg: CoinflowConfig, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.apiBase}${path}`, { ...init, cache: 'no-store' });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Coinflow ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Coinflow ${path} returned invalid JSON`);
  }
}

/** Session key for one end customer. Valid for 24 hours. */
export async function createSessionKey(cfg: CoinflowConfig, customerId: string): Promise<string> {
  const json = await coinflowFetch<{ key?: string }>(cfg, '/api/auth/session-key', {
    method: 'GET',
    headers: {
      Authorization: cfg.apiKey,
      'x-coinflow-auth-user-id': customerId,
      Accept: 'application/json',
    },
  });
  if (!json.key) throw new Error('Coinflow session key response was empty');
  return json.key;
}

/** Cart item sent to Coinflow chargeback protection (required on this merchant). */
export interface ChargebackProtectionItem {
  productName: string;
  productType: 'realEstate';
  quantity: number;
  listPrice: { valueInCurrency: number; currency: 'USD' };
  rawProductData: Record<string, string>;
}

export function buildChargebackProtectionData(args: {
  invoiceNumber: string;
  description: string | null;
  amountCents: number;
}): ChargebackProtectionItem[] {
  return [
    {
      productName: `EarnestBridge Invoice ${args.invoiceNumber}`.slice(0, 200),
      productType: 'realEstate',
      quantity: 1,
      listPrice: { valueInCurrency: args.amountCents / 100, currency: 'USD' },
      rawProductData: {
        invoiceNumber: args.invoiceNumber,
        description: (args.description ?? 'EarnestBridge service invoice').slice(0, 500),
      },
    },
  ];
}

/** Signed checkout parameters, so the amount and references cannot be altered in the browser. */
export async function createCheckoutJwt(
  cfg: CoinflowConfig,
  args: {
    subtotalCents: number;
    currency: 'USD';
    email: string;
    webhookInfo: Record<string, string>;
    chargebackProtectionData: ChargebackProtectionItem[];
  },
): Promise<string> {
  const json = await coinflowFetch<{ checkoutJwtToken?: string }>(cfg, '/api/checkout/jwt-token', {
    method: 'POST',
    headers: {
      Authorization: cfg.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      subtotal: { cents: args.subtotalCents, currency: args.currency },
      email: args.email,
      webhookInfo: args.webhookInfo,
      chargebackProtectionData: args.chargebackProtectionData,
    }),
  });
  if (!json.checkoutJwtToken) throw new Error('Coinflow checkout JWT response was empty');
  return json.checkoutJwtToken;
}

// ── Webhook authentication ───────────────────────────────────────────────────

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function safeEqualText(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Accepts either the Coinflow-Signature header (HMAC-SHA256 of "{t}.{rawBody}")
 * or, when that header is absent, the Authorization header equal to the key.
 */
export function verifyWebhook(headers: Headers, rawBody: string): boolean {
  const key = process.env.COINFLOW_WEBHOOK_VALIDATION_KEY?.trim();
  if (!key) throw new Error('COINFLOW_WEBHOOK_VALIDATION_KEY is not configured');

  const signature = headers.get('coinflow-signature');
  if (signature) {
    const parts = new Map(
      signature.split(',').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as [string, string];
      }),
    );
    const t = parts.get('t');
    const v1 = parts.get('v1');
    if (!t || !v1 || !/^\d+$/.test(t)) return false;
    if (Math.abs(Date.now() / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false;
    const expected = createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex');
    return safeEqualText(expected, v1.toLowerCase());
  }

  const auth = headers.get('authorization');
  return Boolean(auth) && safeEqualText(auth!.trim(), key);
}

// ── Payload parsing ──────────────────────────────────────────────────────────

export interface ParsedWebhook {
  eventId: string;
  eventType: string;
  paymentId: string | null;
  checkoutId: string | null;
  subtotalCents: number | null;
  feesCents: number | null;
  totalCents: number | null;
  currency: string | null;
  last4: string | null;
  cardBrand: string | null;
  created: string | null;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function cents(v: unknown): { cents: number | null; currency: string | null } {
  const o = obj(v);
  if (!o) return { cents: null, currency: null };
  const c = typeof o.cents === 'number' ? o.cents : typeof o.cents === 'string' ? Number(o.cents) : NaN;
  return { cents: Number.isFinite(c) ? Math.round(c) : null, currency: str(o.currency) };
}

/** webhookInfo values may arrive as an object or as JSON strings. */
function readCheckoutId(webhookInfo: unknown): string | null {
  let info: unknown = webhookInfo;
  if (typeof info === 'string') {
    try {
      info = JSON.parse(info);
    } catch {
      return null;
    }
  }
  const o = obj(info);
  if (!o) return null;
  const direct = str(o.checkoutId);
  if (direct) return direct;
  for (const value of Object.values(o)) {
    if (typeof value === 'string' && value.includes('checkoutId')) {
      try {
        const nested = obj(JSON.parse(value));
        const id = nested && str(nested.checkoutId);
        if (id) return id;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export function parseWebhook(rawBody: string): ParsedWebhook {
  const root = obj(JSON.parse(rawBody)) ?? {};
  const data = obj(root.data) ?? root;

  const eventType = str(root.eventType) ?? str(data.eventType) ?? 'Unknown';
  const paymentId = str(data.paymentId) ?? str(data.id) ?? null;
  const created = str(root.created) ?? str(data.created);

  const subtotal = cents(data.subtotal);
  const fees = cents(data.fees);
  const total = cents(data.total);

  const card = obj(data.card) ?? obj(data.paymentMethod) ?? data;
  const last4 = str(card.last4) ?? str(data.last4);
  const cardBrand = str(card.cardType) ?? str(card.brand) ?? str(data.cardType);

  const eventId =
    str(root.id) ??
    str(root.eventId) ??
    createHash('sha256').update(`${eventType}|${paymentId ?? ''}|${created ?? ''}|${rawBody}`).digest('hex');

  return {
    eventId,
    eventType,
    paymentId,
    checkoutId: readCheckoutId(data.webhookInfo ?? root.webhookInfo),
    subtotalCents: subtotal.cents,
    feesCents: fees.cents,
    totalCents: total.cents,
    currency: subtotal.currency ?? total.currency,
    last4: last4 && /^\d{4}$/.test(last4) ? last4 : null,
    cardBrand,
    created,
  };
}
