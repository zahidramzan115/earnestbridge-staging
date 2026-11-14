import 'server-only';

import { createHmac } from 'crypto';

// Request helpers for the public /payment API: client IP hashing and hCaptcha.

export function getClientIp(request: Request): string {
  const h = request.headers;
  return (
    h.get('x-nf-client-connection-ip') ||
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip') ||
    'unknown'
  );
}

/** Keyed hash of the client IP, so raw IPs are never stored. */
export function hashIp(ip: string): string {
  const key = process.env.QBO_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('QBO_TOKEN_ENCRYPTION_KEY is not configured');
  return createHmac('sha256', key).update(`payment-ip:${ip}`).digest('hex');
}

export async function verifyHcaptcha(token: string, ip: string): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET_KEY?.trim();
  if (!secret) throw new Error('HCAPTCHA_SECRET_KEY is not configured');
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY?.trim();
  if (siteKey) body.set('sitekey', siteKey);
  if (ip && ip !== 'unknown') body.set('remoteip', ip);

  try {
    const res = await fetch('https://api.hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
