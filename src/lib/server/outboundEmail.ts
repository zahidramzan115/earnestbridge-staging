/**
 * outboundEmail.ts — Server-Only Outbound Email Helper
 *
 * IMPORTANT: This file must NEVER be imported into client components.
 * It uses SUPABASE_SERVICE_ROLE_KEY which must remain server-side only.
 *
 * Usage:
 *   import { sendOutboundEmail } from '@/lib/server/outboundEmail';
 *   const result = await sendOutboundEmail({ emailType: 'admin_direct_message', to, subject, body, replyTo });
 *
 * Architecture:
 *   - Constructs the Supabase Edge Function URL
 *   - Authorizes using SUPABASE_SERVICE_ROLE_KEY (never anon key)
 *   - Adds X-EB-Email-Secret header for admin email types (dedicated internal secret)
 *   - Parses the Edge Function response
 *   - Throws on provider delivery failure (with safe provider error fields)
 *   - Returns provider message ID on success
 *
 * Attachments: optional base64-encoded file content supplied by the trusted
 * send-email route after server-side download from private storage.
 * The Edge Function receives base64 content — never URLs, never browser uploads.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutboundEmailAttachment {
  filename: string;
  content: string; // base64-encoded file bytes
  mimeType?: string;
}

export interface SendOutboundEmailParams {
  emailType: 'admin_direct_message';
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  attachments?: OutboundEmailAttachment[];
}

export interface SendOutboundEmailResult {
  success: true;
  messageId: string | null;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function getEdgeFunctionUrl(): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured');
  }
  return `${supabaseUrl}/functions/v1/send-borrower-emails`;
}

function getServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key === 'your-supabase-service-role-key-here') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return key;
}

// ── Internal email secret — server-side only, never exposed to browser ────────
const KNOWN_INTERNAL_SECRET_PLACEHOLDERS = [
  'your-eb-email-internal-secret-here',
  'placeholder',
  'changeme',
  'todo',
  'xxxx',
  'replace_me',
  'secret',
];

function getEmailInternalSecret(): string {
  const secret = process.env.EB_EMAIL_INTERNAL_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error('EB_EMAIL_INTERNAL_SECRET is not configured — server configuration error');
  }
  const lower = secret.toLowerCase();
  if (KNOWN_INTERNAL_SECRET_PLACEHOLDERS.some((p) => lower.includes(p))) {
    throw new Error('EB_EMAIL_INTERNAL_SECRET appears to be a placeholder — server configuration error');
  }
  return secret;
}

/**
 * Sends an outbound email via the Supabase Edge Function.
 *
 * - Uses SUPABASE_SERVICE_ROLE_KEY for authorization (never anon key)
 * - RESEND_API_KEY remains exclusively in the Edge Function environment
 * - Throws a descriptive error on delivery failure (with safe provider fields logged server-side)
 * - Returns the provider message ID on success
 * - Optional attachments: base64-encoded content supplied by trusted server code only
 */
export async function sendOutboundEmail(
  params: SendOutboundEmailParams
): Promise<SendOutboundEmailResult> {
  const { emailType, to, subject, body, replyTo, attachments } = params;

  const edgeFnUrl = getEdgeFunctionUrl();
  const serviceRoleKey = getServiceRoleKey();
  const emailInternalSecret = getEmailInternalSecret();

  const payload: Record<string, unknown> = {
    emailType,
    to,
    subject,
    body,
  };

  if (replyTo) {
    payload.replyTo = replyTo;
  }

  // Pass attachments only if provided and non-empty
  // Each attachment carries base64 content — never URLs
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
    }));
  }

  let response: Response;
  try {
    response = await fetch(edgeFnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
        'X-EB-Email-Secret': emailInternalSecret,
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError: unknown) {
    const msg = networkError instanceof Error ? networkError.message : 'Network error';
    throw new Error(`Email delivery failed — could not reach Edge Function: ${msg}`);
  }

  // Parse response body regardless of status
  let responseBody: Record<string, unknown> = {};
  try {
    responseBody = await response.json();
  } catch {
    // Non-JSON body — treat as failure
    if (!response.ok) {
      throw new Error(`Email delivery failed — Edge Function returned HTTP ${response.status} with non-JSON body`);
    }
  }

  if (!response.ok) {
    // ── Capture safe provider error fields for server-side logging ────────
    const stage = typeof responseBody.stage === 'string' ? responseBody.stage : 'edge-function';
    const providerStatus = typeof responseBody.providerStatus === 'number' ? responseBody.providerStatus : response.status;
    const providerErrorCode = typeof responseBody.providerErrorCode === 'string' ? responseBody.providerErrorCode : null;
    const providerErrorName = typeof responseBody.providerErrorName === 'string' ? responseBody.providerErrorName : null;
    const providerErrorMessage = typeof responseBody.providerErrorMessage === 'string' ? responseBody.providerErrorMessage : null;

    console.error('[outboundEmail] Delivery failure:', {
      stage,
      providerStatus,
      providerErrorCode,
      providerErrorName,
      providerErrorMessage: providerErrorMessage ? providerErrorMessage.substring(0, 200) : null,
    });

    const errorMsg = typeof responseBody.error === 'string'
      ? responseBody.error
      : `HTTP ${response.status}`;
    throw new Error(`Email delivery failed — provider error: ${errorMsg}`);
  }

  if (responseBody.success !== true) {
    throw new Error(
      `Email delivery failed — provider response malformed: ${JSON.stringify(responseBody).substring(0, 200)}`
    );
  }

  const messageId = typeof responseBody.emailId === 'string' ? responseBody.emailId : null;

  return { success: true, messageId };
}
