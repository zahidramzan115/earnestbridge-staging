import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM encryption for QuickBooks OAuth tokens at rest.
// Key: QBO_TOKEN_ENCRYPTION_KEY, base64-encoded 32 bytes.
// Stored format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>

const VERSION = 'v1';

function getKey(): Buffer {
  const raw = process.env.QBO_TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new Error('QBO_TOKEN_ENCRYPTION_KEY is not configured');
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('QBO_TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 bytes');
  }
  return key;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptToken(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored QuickBooks token has an unknown format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
