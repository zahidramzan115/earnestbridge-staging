import { readFileSync } from 'fs';
import { createSign } from 'crypto';
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
  pdf: Buffer;
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

function readPrivateKey(): string {
  const fromEnv = (process.env.DOCUSIGN_RSA_PRIVATE_KEY ?? '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  if (fromEnv.includes('BEGIN') && fromEnv.includes('END ') && fromEnv.includes('PRIVATE KEY')) return fromEnv;
  const fromFile = privateKeyFromEnvFile();
  if (fromFile) return fromFile;
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
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(settings.privateKey).toString('base64url')}`;
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
        documentBase64: file.pdf.toString('base64'),
        name: file.name,
        fileExtension: 'pdf',
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
    console.error('[docusign] envelope failed', response.status, message.slice(0, 200));
    throw new Error('DocuSign could not send the documents.');
  }
  return body.envelopeId;
}
