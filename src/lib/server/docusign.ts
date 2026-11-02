import { readFileSync } from 'fs';
import { createHmac, createSign, timingSafeEqual } from 'crypto';
import path from 'path';

type DocuSignConfig = {
  integrationKey: string;
  userId: string;
  accountId: string;
  basePath: string;
  oauthBaseUrl: string;
  privateKey: string;
};

export type SignatureFile = {
  name: string;
  documentId: string;
  content: Buffer;
  signAnchor: string;
  dateAnchor: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function privateKeyFromEnvFile(): string | null {
  try {
    const text = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith('DOCUSIGN_RSA_PRIVATE_KEY='));
    if (start < 0) return null;
    const first = lines[start].slice('DOCUSIGN_RSA_PRIVATE_KEY='.length).replace(/^["']/, '');
    const parts = [first];
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index].trim().replace(/["']$/, '');
      if (!line) break;
      parts.push(line);
      if (line.includes('END ') && line.includes('PRIVATE KEY')) break;
    }
    const key = parts.join('\n').trim();
    return key.includes('END ') && key.includes('PRIVATE KEY') ? key : null;
  } catch {
    return null;
  }
}

function looksLikePem(value: string): boolean {
  return value.includes('BEGIN') && value.includes('END') && value.includes('PRIVATE KEY');
}

function decodeEnvPrivateKey(raw: string): string {
  let value = raw.trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  value = value
    .replace(/\\\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n');
  if (looksLikePem(value)) return value;
  const compact = value.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/]+=*$/.test(compact) && compact.length > 80) {
    const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/\r\n/g, '\n').trim();
    if (looksLikePem(decoded)) return decoded;
  }
  return value;
}

function readPrivateKey(): string {
  const fromB64 = decodeEnvPrivateKey(process.env.DOCUSIGN_RSA_PRIVATE_KEY_B64 ?? '');
  if (looksLikePem(fromB64)) return fromB64;
  const fromEnv = decodeEnvPrivateKey(process.env.DOCUSIGN_RSA_PRIVATE_KEY ?? '');
  if (looksLikePem(fromEnv)) return fromEnv;
  const fromFile = privateKeyFromEnvFile();
  if (fromFile) return fromFile;
  if (fromEnv.includes('BEGIN') && !fromEnv.includes('END')) {
    throw new Error(
      'DOCUSIGN_RSA_PRIVATE_KEY is incomplete. On Netlify add DOCUSIGN_RSA_PRIVATE_KEY_B64 with the Base64 of the full key (one line).'
    );
  }
  throw new Error('DOCUSIGN_RSA_PRIVATE_KEY is not configured');
}

function config(): DocuSignConfig {
  const oauthBaseUrl = requiredEnv('DOCUSIGN_OAUTH_BASE_URL').replace(/\/$/, '');
  const basePath = requiredEnv('DOCUSIGN_BASE_PATH').replace(/\/$/, '');
  return {
    integrationKey: requiredEnv('DOCUSIGN_INTEGRATION_KEY'),
    userId: requiredEnv('DOCUSIGN_USER_ID'),
    accountId: requiredEnv('DOCUSIGN_ACCOUNT_ID'),
    basePath,
    oauthBaseUrl,
    privateKey: readPrivateKey(),
  };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function assertion(settings: DocuSignConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const audience = new URL(settings.oauthBaseUrl).host;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: settings.integrationKey,
    sub: settings.userId,
    aud: audience,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  }));
  const signingInput = `${header}.${payload}`;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(settings.privateKey).toString('base64url')}`;
  } catch {
    throw new Error(
      'DocuSign private key is invalid. On Netlify paste the full key as one line, with \\n between each line of the key.'
    );
  }
}

export async function getDocuSignAccessToken(): Promise<string> {
  const settings = config();
  const response = await fetch(`${settings.oauthBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion(settings),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== 'string') {
    const code = typeof body.error === 'string' ? body.error : '';
    const description = typeof body.error_description === 'string' ? body.error_description : '';
    console.error('[docusign] login failed', code, description.slice(0, 180));
    if (code === 'consent_required' || description.toLowerCase().includes('consent')) {
      throw new Error('DocuSign consent is still required.');
    }
    if (description.includes('no_valid_keys_or_signatures')) {
      throw new Error('DocuSign rejected the private key. Generate a new RSA key in the sandbox app and save that same key in .env.');
    }
    throw new Error(code ? `DocuSign login failed (${code}).` : 'DocuSign login failed.');
  }
  return body.access_token;
}

export async function createSignatureEnvelope(input: {
  accessToken: string;
  email: string;
  signerName: string;
  subject: string;
  files: SignatureFile[];
}): Promise<string> {
  const settings = config();
  const subject = input.subject.slice(0, 100);
  const response = await fetch(`${settings.basePath}/v2.1/accounts/${settings.accountId}/envelopes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      emailSubject: subject,
      emailBlurb: 'Please review and sign the attached EarnestBridge documents.',
      status: 'sent',
      documents: input.files.map((file) => ({
        documentBase64: file.content.toString('base64'),
        name: `${file.name}.docx`,
        fileExtension: 'docx',
        documentId: file.documentId,
      })),
      recipients: {
        signers: [
          {
            email: input.email,
            name: input.signerName,
            recipientId: '1',
            routingOrder: '1',
            tabs: {
              signHereTabs: input.files.map((file) => ({
                documentId: file.documentId,
                anchorString: file.signAnchor,
                anchorUnits: 'pixels',
                anchorXOffset: '0',
                anchorYOffset: '-5',
              })),
              dateSignedTabs: input.files.map((file) => ({
                documentId: file.documentId,
                anchorString: file.dateAnchor,
                anchorUnits: 'pixels',
                anchorXOffset: '140',
                anchorYOffset: '-5',
              })),
            },
          },
        ],
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.envelopeId !== 'string') {
    const message = typeof body.message === 'string' ? body.message : '';
    const code = typeof body.errorCode === 'string' ? body.errorCode : '';
    console.error('[docusign] envelope failed', response.status, code, message.slice(0, 200));
    throw new Error(code ? `DocuSign could not send the documents (${code}).` : 'DocuSign could not send the documents.');
  }
  return body.envelopeId;
}

function hmacMatches(secret: string, rawBody: string, signature: string): boolean {
  const keys = [secret];
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
    keys.push(Buffer.from(secret, 'hex').toString('utf8'));
  }
  return keys.some((key) => {
    const digestHex = createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
    const digestB64 = createHmac('sha256', key).update(rawBody, 'utf8').digest('base64');
    return safeEqual(signature, digestHex) || safeEqual(signature, digestB64);
  });
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function connectHmacValid(rawBody: string, request: Request): boolean {
  const secret = process.env.DOCUSIGN_CONNECT_HMAC_SECRET?.trim() ?? '';
  if (!secret) return true;
  const signatures = [
    request.headers.get('x-docusign-signature-1'),
    request.headers.get('x-docusign-signature-2'),
  ].filter((value): value is string => Boolean(value));
  return signatures.some((signature) => hmacMatches(secret, rawBody, signature));
}

export async function getEnvelopeStatus(envelopeId: string): Promise<string> {
  const settings = config();
  const accessToken = await getDocuSignAccessToken();
  const response = await fetch(
    `${settings.basePath}/v2.1/accounts/${settings.accountId}/envelopes/${encodeURIComponent(envelopeId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const body = await response.json().catch(() => ({}));
  return typeof body.status === 'string' ? body.status.toLowerCase() : '';
}

export async function listEnvelopeDocuments(
  accessToken: string,
  envelopeId: string
): Promise<Array<{ documentId: string; name: string; type?: string }>> {
  const settings = config();
  const response = await fetch(
    `${settings.basePath}/v2.1/accounts/${settings.accountId}/envelopes/${envelopeId}/documents`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(body.envelopeDocuments)) {
    throw new Error('Could not load the signed documents.');
  }
  return body.envelopeDocuments
    .map((item: { documentId?: string; name?: string; type?: string }) => ({
      documentId: String(item.documentId ?? ''),
      name: String(item.name ?? ''),
      type: item.type,
    }))
    .filter((item: { documentId: string }) => item.documentId);
}

export async function downloadEnvelopeFile(
  accessToken: string,
  envelopeId: string,
  documentId: string
): Promise<Buffer> {
  const settings = config();
  const response = await fetch(
    `${settings.basePath}/v2.1/accounts/${settings.accountId}/envelopes/${envelopeId}/documents/${documentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) throw new Error('Could not download the signed document.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 5) throw new Error('Could not download the signed document.');
  return bytes;
}

export function expectedConnectAccountId(): string {
  return requiredEnv('DOCUSIGN_ACCOUNT_ID');
}
