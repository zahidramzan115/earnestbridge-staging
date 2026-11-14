import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { decryptToken, encryptToken } from './tokenCrypto';

// ============================================================
// QuickBooks Online client: OAuth 2.0 + connection storage.
//
// Tokens are stored encrypted in public.qbo_connections and are
// only ever read with the service role key, on the server.
// ============================================================

export type QboEnvironment = 'sandbox' | 'production';

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';
export const QBO_MINOR_VERSION = '75';

// Refresh the access token when it has less than this left.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class QboError extends Error {
  constructor(
    public code:
      | 'not_configured'
      | 'not_connected'
      | 'reauthorization_required'
      | 'token_exchange_failed'
      | 'api_error',
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'QboError';
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

interface QboConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: QboEnvironment;
}

export function getQboConfig(): QboConfig {
  const clientId = process.env.QBO_CLIENT_ID?.trim();
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  const redirectUri = process.env.QBO_REDIRECT_URI?.trim();
  const env = (process.env.QBO_ENVIRONMENT?.trim() || 'sandbox').toLowerCase();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new QboError(
      'not_configured',
      'QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI must be set',
    );
  }
  if (env !== 'sandbox' && env !== 'production') {
    throw new QboError('not_configured', 'QBO_ENVIRONMENT must be "sandbox" or "production"');
  }
  return { clientId, clientSecret, redirectUri, environment: env };
}

export function getQboApiBase(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function getServiceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function basicAuthHeader(cfg: QboConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(state: string): string {
  const cfg = getQboConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: ACCOUNTING_SCOPE,
    redirect_uri: cfg.redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const cfg = getQboConfig();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(cfg),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    cache: 'no-store',
  });

  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };

  if (!res.ok) {
    if (json.error === 'invalid_grant') {
      throw new QboError('reauthorization_required', 'QuickBooks authorization is no longer valid', res.status);
    }
    throw new QboError('token_exchange_failed', `QuickBooks token request failed (${json.error ?? res.status})`, res.status);
  }
  if (!json.access_token || !json.refresh_token || !json.expires_in || !json.x_refresh_token_expires_in) {
    throw new QboError('token_exchange_failed', 'QuickBooks token response was incomplete');
  }
  return json as TokenResponse;
}

function expiryFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ── Connection storage ────────────────────────────────────────────────────────

interface ConnectionRow {
  id: string;
  environment: QboEnvironment;
  realm_id: string;
  company_name: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  status: 'active' | 'disconnected' | 'error';
  updated_at: string;
}

export interface QboConnectionStatus {
  connected: boolean;
  environment: QboEnvironment;
  status: 'active' | 'disconnected' | 'error' | 'none';
  realm_id: string | null;
  company_name: string | null;
  connected_at: string | null;
  connected_by: string | null;
  last_refreshed_at: string | null;
  refresh_token_expires_at: string | null;
  last_error: string | null;
}

/** Current connection status for the configured environment. Never returns tokens. */
export async function getConnectionStatus(): Promise<QboConnectionStatus> {
  const { environment } = getQboConfig();
  const db = getServiceClient();

  const { data, error } = await db
    .from('qbo_connections')
    .select('realm_id, company_name, status, connected_at, connected_by, last_refreshed_at, refresh_token_expires_at, last_error')
    .eq('environment', environment)
    .in('status', ['active', 'error'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read QuickBooks connection: ${error.message}`);

  if (!data) {
    return {
      connected: false,
      environment,
      status: 'none',
      realm_id: null,
      company_name: null,
      connected_at: null,
      connected_by: null,
      last_refreshed_at: null,
      refresh_token_expires_at: null,
      last_error: null,
    };
  }

  return {
    connected: data.status === 'active',
    environment,
    status: data.status,
    realm_id: data.realm_id,
    company_name: data.company_name,
    connected_at: data.connected_at,
    connected_by: data.connected_by,
    last_refreshed_at: data.last_refreshed_at,
    refresh_token_expires_at: data.refresh_token_expires_at,
    last_error: data.last_error,
  };
}

async function fetchCompanyName(environment: QboEnvironment, realmId: string, accessToken: string): Promise<string | null> {
  const url = `${getQboApiBase(environment)}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=${QBO_MINOR_VERSION}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { CompanyInfo?: { CompanyName?: string } };
    return json.CompanyInfo?.CompanyName ?? null;
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization code for tokens and store the connection.
 * Any previously active connection for this environment is marked disconnected.
 */
export async function completeAuthorization(params: {
  code: string;
  realmId: string;
  adminUserId: string;
}): Promise<{ companyName: string | null }> {
  const cfg = getQboConfig();
  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: cfg.redirectUri,
    }),
  );

  const companyName = await fetchCompanyName(cfg.environment, params.realmId, tokens.access_token);
  const db = getServiceClient();
  const now = new Date().toISOString();

  // Retire other connections in this environment (the one-active index requires it).
  const { error: retireError } = await db
    .from('qbo_connections')
    .update({ status: 'disconnected', disconnected_at: now })
    .eq('environment', cfg.environment)
    .neq('realm_id', params.realmId)
    .in('status', ['active', 'error']);
  if (retireError) throw new Error(`Failed to retire old QuickBooks connection: ${retireError.message}`);

  const { error } = await db.from('qbo_connections').upsert(
    {
      environment: cfg.environment,
      realm_id: params.realmId,
      company_name: companyName,
      access_token_encrypted: encryptToken(tokens.access_token),
      refresh_token_encrypted: encryptToken(tokens.refresh_token),
      access_token_expires_at: expiryFromNow(tokens.expires_in),
      refresh_token_expires_at: expiryFromNow(tokens.x_refresh_token_expires_in),
      status: 'active',
      last_refreshed_at: now,
      last_error: null,
      connected_by: params.adminUserId,
      connected_at: now,
      disconnected_at: null,
    },
    { onConflict: 'environment,realm_id' },
  );
  if (error) throw new Error(`Failed to save QuickBooks connection: ${error.message}`);

  return { companyName };
}

async function loadActiveConnection(db: SupabaseClient, environment: QboEnvironment): Promise<ConnectionRow> {
  const { data, error } = await db
    .from('qbo_connections')
    .select('id, environment, realm_id, company_name, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at, status, updated_at')
    .eq('environment', environment)
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw new Error(`Failed to read QuickBooks connection: ${error.message}`);
  if (!data) throw new QboError('not_connected', 'QuickBooks is not connected');
  return data as ConnectionRow;
}

async function refreshConnection(db: SupabaseClient, row: ConnectionRow): Promise<{ accessToken: string; realmId: string }> {
  let tokens: TokenResponse;
  try {
    tokens = await requestTokens(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: decryptToken(row.refresh_token_encrypted),
      }),
    );
  } catch (err) {
    if (err instanceof QboError && err.code === 'reauthorization_required') {
      await db
        .from('qbo_connections')
        .update({ status: 'error', last_error: 'QuickBooks authorization expired or was revoked. Reconnect required.' })
        .eq('id', row.id);
    } else {
      await db
        .from('qbo_connections')
        .update({ last_error: err instanceof Error ? err.message : 'Token refresh failed' })
        .eq('id', row.id);
    }
    throw err;
  }

  // Conditional update: if another request refreshed first, use its token instead.
  const { data: updated, error } = await db
    .from('qbo_connections')
    .update({
      access_token_encrypted: encryptToken(tokens.access_token),
      refresh_token_encrypted: encryptToken(tokens.refresh_token),
      access_token_expires_at: expiryFromNow(tokens.expires_in),
      refresh_token_expires_at: expiryFromNow(tokens.x_refresh_token_expires_in),
      last_refreshed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .select('id');

  if (error) throw new Error(`Failed to store refreshed QuickBooks token: ${error.message}`);

  if (!updated || updated.length === 0) {
    const latest = await loadActiveConnection(db, row.environment);
    return { accessToken: decryptToken(latest.access_token_encrypted), realmId: latest.realm_id };
  }
  return { accessToken: tokens.access_token, realmId: row.realm_id };
}

/** Returns a usable access token, refreshing it first when close to expiry. */
export async function getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<{
  accessToken: string;
  realmId: string;
  environment: QboEnvironment;
}> {
  const { environment } = getQboConfig();
  const db = getServiceClient();
  const row = await loadActiveConnection(db, environment);

  const expiresAt = new Date(row.access_token_expires_at).getTime();
  if (!options.forceRefresh && expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    return { accessToken: decryptToken(row.access_token_encrypted), realmId: row.realm_id, environment };
  }

  const refreshed = await refreshConnection(db, row);
  return { ...refreshed, environment };
}

/**
 * Authenticated GET against the QuickBooks Accounting API.
 * `path` starts after /v3/company/{realmId}, e.g. "/query?query=..." or "/customer/1".
 * Retries once with a refreshed token on 401.
 */
export async function qboGet<T>(path: string): Promise<{ data: T; realmId: string; environment: QboEnvironment }> {
  const attempt = async (forceRefresh: boolean) => {
    const { accessToken, realmId, environment } = await getAccessToken({ forceRefresh });
    const sep = path.includes('?') ? '&' : '?';
    const url = `${getQboApiBase(environment)}/v3/company/${encodeURIComponent(realmId)}${path}${sep}minorversion=${QBO_MINOR_VERSION}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    return { res, realmId, environment };
  };

  let { res, realmId, environment } = await attempt(false);
  if (res.status === 401) {
    ({ res, realmId, environment } = await attempt(true));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new QboError('api_error', `QuickBooks API ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return { data: (await res.json()) as T, realmId, environment };
}

/**
 * Authenticated POST against the QuickBooks Accounting API.
 * `requestId` makes the call idempotent: QuickBooks returns the original
 * result instead of creating a duplicate when the same id is reused.
 */
export async function qboPost<T>(path: string, body: unknown, requestId: string): Promise<{ data: T; realmId: string }> {
  const attempt = async (forceRefresh: boolean) => {
    const { accessToken, realmId, environment } = await getAccessToken({ forceRefresh });
    const url = `${getQboApiBase(environment)}/v3/company/${encodeURIComponent(realmId)}${path}?minorversion=${QBO_MINOR_VERSION}&requestid=${encodeURIComponent(requestId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    return { res, realmId };
  };

  let { res, realmId } = await attempt(false);
  if (res.status === 401) {
    ({ res, realmId } = await attempt(true));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new QboError('api_error', `QuickBooks API ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return { data: (await res.json()) as T, realmId };
}

/** Escape a value for a single-quoted QuickBooks query string literal. */
export function qboQuoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Refresh tokens and confirm the API answers. Used by "Test connection"
 * and by the daily keep-alive, so the refresh token never lapses.
 */
export async function testConnection(): Promise<{ companyName: string | null }> {
  const { accessToken, realmId, environment } = await getAccessToken({ forceRefresh: true });
  const companyName = await fetchCompanyName(environment, realmId, accessToken);
  if (companyName === null) {
    throw new QboError('api_error', 'QuickBooks did not return company information');
  }

  const db = getServiceClient();
  await db
    .from('qbo_connections')
    .update({ company_name: companyName })
    .eq('environment', environment)
    .eq('realm_id', realmId);

  return { companyName };
}

/** Revoke the token at Intuit (best effort) and mark the connection disconnected. */
export async function disconnect(): Promise<void> {
  const cfg = getQboConfig();
  const db = getServiceClient();

  const { data: rows, error } = await db
    .from('qbo_connections')
    .select('id, refresh_token_encrypted')
    .eq('environment', cfg.environment)
    .in('status', ['active', 'error']);
  if (error) throw new Error(`Failed to read QuickBooks connection: ${error.message}`);

  for (const row of rows ?? []) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(cfg),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token: decryptToken(row.refresh_token_encrypted) }),
        cache: 'no-store',
      });
    } catch {
      // Revocation is best effort; the local record is still retired below.
    }

    const { error: updateError } = await db
      .from('qbo_connections')
      .update({ status: 'disconnected', disconnected_at: new Date().toISOString() })
      .eq('id', row.id);
    if (updateError) throw new Error(`Failed to mark QuickBooks disconnected: ${updateError.message}`);
  }
}
