/**
 * src/lib/server/invoiceEmail.ts
 *
 * Step: 5E-3A — Server-Only Invoice Email Dispatcher (Safety Corrections)
 *
 * SERVER-ONLY. Import 'server-only' prevents this module from being bundled
 * into any Client Component. SUPABASE_SERVICE_ROLE_KEY and
 * EB_EMAIL_INTERNAL_SECRET must never reach the browser.
 *
 * PURPOSE
 * -------
 * Provides dispatchInvoiceEmail({ invoiceId, adminUserId }) — the single
 * reusable entry point for sending an issued-invoice email through the
 * deployed send-borrower-emails Edge Function.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * 1. Validates invoiceId and adminUserId as UUID-shaped strings.
 * 2. Validates ALL required server configuration (supabaseUrl,
 *    serviceRoleKey, emailInternalSecret) BEFORE any DB operation or claim.
 *    Missing/invalid configuration throws INVOICE_EMAIL_CONFIG_ERROR and
 *    no delivery row is created or claimed.
 * 3. Calls claim_invoice_email_delivery() RPC (service_role) — the
 *    authoritative gate. Handles all RPC outcomes without calling the
 *    provider for already_sent / currently_sending / uncertain.
 * 4. Loads the authoritative invoice snapshot from crm_invoices
 *    (service_role) — selecting only fields needed for email delivery.
 * 5. Validates the snapshot fields and verifies that billing_email
 *    matches the claim's recipient_email (invariant check).
 * 6. Downloads the private immutable PDF from the invoice-pdfs bucket
 *    using the path from the DB row only (never from caller input).
 *    Validates magic bytes (%PDF-) and non-empty content.
 * 7. Verifies the SHA-256 hash of the downloaded bytes against
 *    crm_invoices.pdf_hash. pdf_hash is REQUIRED for every eligible
 *    invoice — NULL/blank → invoice_pdf_hash_missing (definite failure).
 * 8. Base64-encodes the validated PDF bytes server-side.
 * 9. Calls the deployed send-borrower-emails Edge Function with the
 *    invoice_issued payload (exactly one provider call per invocation).
 * 10. Interprets the structured Edge Function response and finalizes
 *    delivery state via success / failure / uncertain RPCs.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * - Does NOT accept recipient email, PDF path, idempotency key, or any
 *   invoice content from the caller — only invoiceId + adminUserId.
 * - Does NOT create a public/signed URL for the PDF.
 * - Does NOT log base64 PDF content, secrets, or service keys.
 * - Does NOT write crm_email_log or application_activity rows.
 * - Does NOT modify invoice status or PDF state.
 * - Does NOT retry the provider on finalization failure.
 * - Does NOT branch on revision_source_invoice_id — Normal and Revision
 *   invoices share the same dispatcher.
 *
 * RETURN TYPE
 * -----------
 * Returns a structured InvoiceEmailDispatchResult rather than throwing
 * for normal delivery lifecycle outcomes (sent, already_sent,
 * currently_sending, failed, uncertain).
 *
 * Unexpected configuration / programming / database failures throw
 * InvoiceEmailDispatchError with a safe code and message.
 *
 * PDF HASH INVARIANT
 * ------------------
 * crm_invoices.pdf_hash MUST be a lowercase 64-character hex SHA-256
 * digest of the immutable issued PDF bytes, set during the
 * complete_invoice_issuance() RPC.
 *
 * pdf_hash is REQUIRED for every eligible invoice. There is NO bypass
 * for NULL/blank values. The stored value must match ^[0-9a-f]{64}$
 * exactly (the stored value is validated as-is — it is NOT lowercased
 * before the regex check). The computed SHA-256 of the downloaded bytes
 * must equal the stored hash exactly.
 *
 * NULL / blank pdf_hash  → invoice_pdf_hash_missing  (definite failure)
 * Malformed pdf_hash     → invoice_pdf_hash_invalid  (definite failure)
 * Hash mismatch          → invoice_pdf_hash_mismatch (definite failure)
 *
 * In all three cases the Edge Function is NOT called and delivery is
 * finalized as a definite failure.
 *
 * CONFIG VALIDATION ORDER
 * -----------------------
 * All required configuration (NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, EB_EMAIL_INTERNAL_SECRET) is validated
 * BEFORE claim_invoice_email_delivery() is called. If any value is
 * missing or a placeholder, INVOICE_EMAIL_CONFIG_ERROR is thrown and
 * no delivery row is created or claimed.
 *
 * MAX PROVIDER CALLS PER INVOCATION: 1
 * EDGE TRANSPORT FAILURE OUTCOME: uncertain
 * PROVIDER DEFINITE FAILURE OUTCOME: failed
 * PROVIDER SUCCESS OUTCOME: sent (after success RPC)
 */

import 'server-only';

import { createHash } from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// Safe error class for unexpected configuration / programming / DB failures
// ─────────────────────────────────────────────────────────────────────────────

export type InvoiceEmailDispatchErrorCode =
  | 'INVOICE_EMAIL_CONFIG_ERROR' |'INVOICE_EMAIL_INVALID_INPUT' |'INVOICE_EMAIL_CLAIM_RPC_ERROR' |'INVOICE_EMAIL_SNAPSHOT_ERROR' |'INVOICE_EMAIL_PDF_ERROR' |'INVOICE_EMAIL_FINALIZE_ERROR';

export class InvoiceEmailDispatchError extends Error {
  public readonly code: InvoiceEmailDispatchErrorCode;

  constructor(code: InvoiceEmailDispatchErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'InvoiceEmailDispatchError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────────────────────────────────────

export type InvoiceEmailOutcome =
  | 'sent' |'already_sent' |'currently_sending' |'failed' |'uncertain';

export interface InvoiceEmailDispatchResult {
  outcome: InvoiceEmailOutcome;
  deliveryId: string | null;
  invoiceId: string;
  recipientEmail?: string;
  providerMessageId?: string | null;
  attemptCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher input
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchInvoiceEmailParams {
  invoiceId: string;
  adminUserId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: validated server configuration object
// Created once after UUID validation, before any DB operation or claim.
// ─────────────────────────────────────────────────────────────────────────────

interface ServerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  emailInternalSecret: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: invoice snapshot shape (only fields needed for email delivery)
// ─────────────────────────────────────────────────────────────────────────────

interface InvoiceEmailSnapshot {
  id: string;
  invoice_number: string;
  status: string;
  billing_contact_name: string | null;
  billing_email: string;
  currency: string;
  total_cents: number;
  due_date: string;
  pdf_generation_status: string;
  pdf_storage_path: string;
  pdf_hash: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: claim RPC row shape
// ─────────────────────────────────────────────────────────────────────────────

interface ClaimRpcRow {
  outcome: string;
  delivery_id: string | null;
  delivery_status: string;
  recipient_email: string;
  provider: string;
  provider_idempotency_key: string;
  provider_message_id: string | null;
  attempt_count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// UUID validation
// ─────────────────────────────────────────────────────────────────────────────

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 hex validation
//
// IMPORTANT: validates the stored value AS-IS — do NOT lowercase before
// checking. The stored pdf_hash must itself match ^[0-9a-f]{64}$.
// ─────────────────────────────────────────────────────────────────────────────

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

function isValidSha256Hex(value: string): boolean {
  // Validate the value exactly as provided — no case normalization.
  return SHA256_HEX_REGEX.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment helpers — fail closed on missing/placeholder values
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_PLACEHOLDERS = [
  'your-',
  'placeholder',
  'changeme',
  'todo',
  'xxxx',
  'replace_me',
  'secret',
  'example',
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_CONFIG_ERROR',
      `Required environment variable ${name} is not configured.`
    );
  }
  const lower = value.toLowerCase();
  if (KNOWN_PLACEHOLDERS.some((p) => lower.startsWith(p))) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_CONFIG_ERROR',
      `Environment variable ${name} appears to be a placeholder value.`
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build validated server configuration object.
//
// Reads and validates ALL required configuration in one place, BEFORE any
// DB operation or claim. Throws INVOICE_EMAIL_CONFIG_ERROR if any value is
// missing or a placeholder — no delivery row is created or claimed.
// ─────────────────────────────────────────────────────────────────────────────

function buildServerConfig(): ServerConfig {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const emailInternalSecret = requireEnv('EB_EMAIL_INTERNAL_SECRET');
  return { supabaseUrl, serviceRoleKey, emailInternalSecret };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service-role Supabase client — server-side only, never exposed to browser
// ─────────────────────────────────────────────────────────────────────────────

function createServiceClient(config: ServerConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Call claim_invoice_email_delivery RPC
// ─────────────────────────────────────────────────────────────────────────────

async function callClaimRpc(
  serviceClient: SupabaseClient,
  invoiceId: string,
  adminUserId: string
): Promise<ClaimRpcRow> {
  const { data, error } = await serviceClient.rpc('claim_invoice_email_delivery', {
    p_invoice_id: invoiceId,
    p_admin_user_id: adminUserId,
  });

  if (error) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_CLAIM_RPC_ERROR',
      `claim_invoice_email_delivery RPC failed: ${error.message ?? 'unknown error'}`
    );
  }

  // RPC returns a TABLE — Supabase client wraps it as an array
  const rows = Array.isArray(data) ? data : [data];
  if (!rows || rows.length === 0 || rows[0] == null) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_CLAIM_RPC_ERROR',
      'claim_invoice_email_delivery RPC returned no rows.'
    );
  }

  const row = rows[0] as ClaimRpcRow;
  if (typeof row.outcome !== 'string' || row.outcome.trim() === '') {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_CLAIM_RPC_ERROR',
      'claim_invoice_email_delivery RPC returned an unrecognized outcome shape.'
    );
  }

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Load authoritative invoice snapshot
// ─────────────────────────────────────────────────────────────────────────────

async function loadInvoiceSnapshot(
  serviceClient: SupabaseClient,
  invoiceId: string
): Promise<InvoiceEmailSnapshot> {
  const { data, error } = await serviceClient
    .from('crm_invoices')
    .select(
      'id, invoice_number, status, billing_contact_name, billing_email, currency, total_cents, due_date, pdf_generation_status, pdf_storage_path, pdf_hash'
    )
    .eq('id', invoiceId)
    .single();

  if (error || !data) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_SNAPSHOT_ERROR',
      `Failed to load invoice snapshot: ${error?.message ?? 'row not found'}`
    );
  }

  return data as InvoiceEmailSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Validate invoice snapshot fields
// ─────────────────────────────────────────────────────────────────────────────

function validateInvoiceSnapshot(
  invoice: InvoiceEmailSnapshot,
  claimRecipientEmail: string
): string | null {
  // status must be open, partially_paid, or paid
  if (!['open', 'partially_paid', 'paid'].includes(invoice.status)) {
    return `invoice_snapshot_invalid_status`;
  }

  // invoice_number must be nonblank
  if (!invoice.invoice_number || invoice.invoice_number.trim() === '') {
    return `invoice_snapshot_missing_invoice_number`;
  }

  // billing_email must be nonblank
  if (!invoice.billing_email || invoice.billing_email.trim() === '') {
    return `invoice_snapshot_missing_billing_email`;
  }

  // currency must be nonblank
  if (!invoice.currency || invoice.currency.trim() === '') {
    return `invoice_snapshot_missing_currency`;
  }

  // total_cents must be a safe non-negative integer
  if (
    !Number.isSafeInteger(invoice.total_cents) ||
    invoice.total_cents < 0
  ) {
    return `invoice_snapshot_invalid_total_cents`;
  }

  // due_date must be nonblank
  if (!invoice.due_date || invoice.due_date.trim() === '') {
    return `invoice_snapshot_missing_due_date`;
  }

  // pdf_generation_status must be 'generated'
  if (invoice.pdf_generation_status !== 'generated') {
    return `invoice_snapshot_pdf_not_generated`;
  }

  // pdf_storage_path must be nonblank
  if (!invoice.pdf_storage_path || invoice.pdf_storage_path.trim() === '') {
    return `invoice_snapshot_missing_pdf_path`;
  }

  // CRITICAL INVARIANT: billing_email must match claim's recipient_email
  // This guards against any drift between the claim and the current snapshot.
  if (
    invoice.billing_email.trim().toLowerCase() !==
    claimRecipientEmail.trim().toLowerCase()
  ) {
    return `invoice_snapshot_mismatch`;
  }

  return null; // valid
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Download private PDF from storage
// ─────────────────────────────────────────────────────────────────────────────

async function downloadPdfBytes(
  serviceClient: SupabaseClient,
  pdfStoragePath: string
): Promise<{ bytes: Uint8Array; error: string | null }> {
  const { data: blob, error } = await serviceClient.storage
    .from('invoice-pdfs')
    .download(pdfStoragePath);

  if (error || !blob) {
    // Do not include raw storage error message (may contain path/secret info)
    return { bytes: new Uint8Array(0), error: 'invoice_pdf_download_failed' };
  }

  let bytes: Uint8Array;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
  } catch {
    return { bytes: new Uint8Array(0), error: 'invoice_pdf_download_failed' };
  }

  // Validate non-empty
  if (bytes.length === 0) {
    return { bytes: new Uint8Array(0), error: 'invoice_pdf_invalid' };
  }

  // Validate PDF magic header: first 5 bytes must be %PDF-
  // %=0x25, P=0x50, D=0x44, F=0x46, -=0x2D
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d
  ) {
    return { bytes: new Uint8Array(0), error: 'invoice_pdf_invalid' };
  }

  return { bytes, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Verify PDF SHA-256 hash
//
// pdf_hash is REQUIRED for every eligible invoice. There is NO bypass for
// NULL/blank values — all three failure cases are definite failures and
// the Edge Function MUST NOT be called in any of them.
//
// NULL / blank pdf_hash  → 'invoice_pdf_hash_missing'
// Malformed pdf_hash     → 'invoice_pdf_hash_invalid'
// Hash mismatch          → 'invoice_pdf_hash_mismatch'
//
// IMPORTANT: the stored pdf_hash value is validated AS-IS against
// ^[0-9a-f]{64}$. It is NOT lowercased before the regex check.
// The computed SHA-256 digest (always lowercase hex) is then compared
// to the stored value using exact equality.
//
// Returns: null (hash verified) | error code string (definite failure)
// ─────────────────────────────────────────────────────────────────────────────

function verifyPdfHash(
  bytes: Uint8Array,
  pdfHash: string | null
): string | null {
  // NULL or blank — hash is required; fail closed.
  if (!pdfHash || pdfHash.trim() === '') {
    return 'invoice_pdf_hash_missing';
  }

  // Validate the stored value exactly as-is (no lowercasing).
  // The stored hash must itself be lowercase hex — if it contains uppercase
  // or other characters it is malformed.
  if (!isValidSha256Hex(pdfHash)) {
    return 'invoice_pdf_hash_invalid';
  }

  // Compute SHA-256 over the downloaded bytes and compare exact equality.
  // createHash('sha256').digest('hex') always returns lowercase hex.
  const computed = createHash('sha256').update(bytes).digest('hex');

  if (computed !== pdfHash) {
    return 'invoice_pdf_hash_mismatch';
  }

  return null; // hash verified
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6: Base64 encode PDF bytes (server-side, deterministic)
// ─────────────────────────────────────────────────────────────────────────────

function encodeBase64(bytes: Uint8Array): string {
  // Use Node.js Buffer for deterministic base64 encoding
  return Buffer.from(bytes).toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7: Call the deployed Edge Function
//
// Uses the pre-validated ServerConfig — does NOT re-read required provider
// configuration after a claim has been acquired.
// ─────────────────────────────────────────────────────────────────────────────

interface EdgeFunctionCallResult {
  transportError: boolean; // true = fetch threw / timed out
  httpStatus: number | null;
  body: Record<string, unknown> | null;
}

async function callEdgeFunction(
  config: ServerConfig,
  invoice: InvoiceEmailSnapshot,
  claimRow: ClaimRpcRow,
  base64Pdf: string
): Promise<EdgeFunctionCallResult> {
  const edgeFnUrl = `${config.supabaseUrl}/functions/v1/send-borrower-emails`;

  const payload = {
    emailType: 'invoice_issued',
    to: claimRow.recipient_email,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    billingContactName: invoice.billing_contact_name,
    totalCents: invoice.total_cents,
    currency: invoice.currency,
    dueDate: invoice.due_date,
    idempotencyKey: claimRow.provider_idempotency_key,
    attachments: [
      {
        filename: `${invoice.invoice_number}.pdf`,
        content: base64Pdf,
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(edgeFnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'X-EB-Email-Secret': config.emailInternalSecret,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Network/transport failure — cannot prove whether Edge Function was reached
    return { transportError: true, httpStatus: null, body: null };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON response
    body = null;
  }

  return { transportError: false, httpStatus: response.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8: Interpret Edge Function response
// ─────────────────────────────────────────────────────────────────────────────

type ProviderOutcome =
  | { kind: 'sent'; emailId: string }
  | { kind: 'failed'; errorCode: string; errorMessage: string }
  | { kind: 'uncertain'; errorCode: string; errorMessage: string; emailId?: string };

function interpretEdgeFunctionResponse(
  result: EdgeFunctionCallResult
): ProviderOutcome {
  // Transport failure — cannot prove whether provider was called
  if (result.transportError) {
    return {
      kind: 'uncertain',
      errorCode: 'edge_transport_uncertain',
      errorMessage: 'Network or transport failure reaching Edge Function; delivery outcome unknown.',
    };
  }

  const { httpStatus, body } = result;

  // No body or non-parseable body
  if (!body || typeof body !== 'object') {
    // If 4xx (not 408/409) without body — treat as failed (pre-provider rejection)
    if (
      httpStatus !== null &&
      httpStatus >= 400 &&
      httpStatus < 500 &&
      httpStatus !== 408 &&
      httpStatus !== 409
    ) {
      return {
        kind: 'failed',
        errorCode: 'edge_validation_rejected',
        errorMessage: `Edge Function returned HTTP ${httpStatus} with no parseable body.`,
      };
    }
    return {
      kind: 'uncertain',
      errorCode: 'edge_response_unparseable',
      errorMessage: `Edge Function returned HTTP ${httpStatus ?? 'unknown'} with no parseable body.`,
    };
  }

  const deliveryOutcome = body.deliveryOutcome;
  const success = body.success;

  // ── SUCCESS ──────────────────────────────────────────────────────────────
  if (success === true && deliveryOutcome === 'sent') {
    const emailId = typeof body.emailId === 'string' ? body.emailId.trim() : '';
    if (!emailId) {
      // Success-looking response but no usable emailId — uncertain
      return {
        kind: 'uncertain',
        errorCode: 'edge_success_missing_email_id',
        errorMessage: 'Edge Function reported success but returned no usable provider message ID.',
      };
    }
    return { kind: 'sent', emailId };
  }

  // ── DEFINITE FAILURE ─────────────────────────────────────────────────────
  if (deliveryOutcome === 'failed') {
    const errorCode =
      typeof body.providerErrorCode === 'string'
        ? body.providerErrorCode.substring(0, 100)
        : 'provider_rejected';
    const errorMessage =
      typeof body.providerErrorMessage === 'string'
        ? body.providerErrorMessage.substring(0, 500)
        : `Provider rejected the request (HTTP ${httpStatus ?? 'unknown'}).`;

    return { kind: 'failed', errorCode, errorMessage };
  }

  // ── UNCERTAIN ────────────────────────────────────────────────────────────
  if (deliveryOutcome === 'uncertain') {
    const errorCode =
      typeof body.providerErrorCode === 'string'
        ? body.providerErrorCode.substring(0, 100)
        : 'provider_uncertain';
    const errorMessage =
      typeof body.providerErrorMessage === 'string'
        ? body.providerErrorMessage.substring(0, 500)
        : `Provider outcome uncertain (HTTP ${httpStatus ?? 'unknown'}).`;
    const emailId =
      typeof body.emailId === 'string' && body.emailId.trim()
        ? body.emailId.trim()
        : undefined;

    return { kind: 'uncertain', errorCode, errorMessage, emailId };
  }

  // ── UNRECOGNIZED RESPONSE ────────────────────────────────────────────────
  // HTTP 5xx without a valid structured deliveryOutcome → uncertain
  if (httpStatus !== null && httpStatus >= 500 && httpStatus <= 599) {
    return {
      kind: 'uncertain',
      errorCode: 'edge_5xx_no_outcome',
      errorMessage: `Edge Function returned HTTP ${httpStatus} without a valid deliveryOutcome.`,
    };
  }

  // Clear pre-provider rejection (4xx, not 408/409) without a recognized outcome
  if (
    httpStatus !== null &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    httpStatus !== 408 &&
    httpStatus !== 409
  ) {
    const errorCode =
      typeof body.error === 'string'
        ? body.error.substring(0, 100)
        : 'edge_validation_rejected';
    const errorMessage =
      typeof body.message === 'string'
        ? body.message.substring(0, 500)
        : `Edge Function rejected the request before provider call (HTTP ${httpStatus}).`;
    return { kind: 'failed', errorCode, errorMessage };
  }

  // Default: cannot safely prove outcome → uncertain
  return {
    kind: 'uncertain',
    errorCode: 'edge_response_unrecognized',
    errorMessage: `Edge Function returned an unrecognized response shape (HTTP ${httpStatus ?? 'unknown'}).`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 9: Finalization RPCs
// ─────────────────────────────────────────────────────────────────────────────

async function finalizeSuccess(
  serviceClient: SupabaseClient,
  deliveryId: string,
  attemptCount: number,
  emailId: string
): Promise<{ ok: boolean; alreadySent: boolean }> {
  const { data, error } = await serviceClient.rpc(
    'complete_invoice_email_delivery_success',
    {
      p_delivery_id: deliveryId,
      p_attempt_count: attemptCount,
      p_provider_message_id: emailId,
    }
  );

  if (error) {
    return { ok: false, alreadySent: false };
  }

  const rows = Array.isArray(data) ? data : [data];
  const outcome = rows?.[0]?.outcome ?? rows?.[0];
  if (outcome === 'already_sent') {
    return { ok: true, alreadySent: true };
  }
  return { ok: outcome === 'sent', alreadySent: false };
}

async function finalizeFailure(
  serviceClient: SupabaseClient,
  deliveryId: string,
  attemptCount: number,
  errorCode: string,
  errorMessage: string
): Promise<boolean> {
  const { error } = await serviceClient.rpc(
    'complete_invoice_email_delivery_failure',
    {
      p_delivery_id: deliveryId,
      p_attempt_count: attemptCount,
      p_error_code: errorCode,
      p_error_message: errorMessage.substring(0, 1000),
    }
  );
  return !error;
}

async function finalizeUncertain(
  serviceClient: SupabaseClient,
  deliveryId: string,
  attemptCount: number,
  errorCode: string,
  errorMessage: string,
  emailId?: string | null
): Promise<boolean> {
  const { error } = await serviceClient.rpc(
    'mark_invoice_email_delivery_uncertain',
    {
      p_delivery_id: deliveryId,
      p_attempt_count: attemptCount,
      p_error_code: errorCode,
      p_error_message: errorMessage.substring(0, 1000),
      p_provider_message_id: emailId ?? null,
    }
  );
  return !error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: finalize a definite pre-provider failure or throw.
//
// All pre-provider definite-failure paths MUST use this helper.
// Returns outcome: 'failed' only after finalizeFailure() succeeds.
// Throws INVOICE_EMAIL_FINALIZE_ERROR if finalizeFailure() returns false.
//
// The Edge Function is NEVER called when this helper is used.
// ─────────────────────────────────────────────────────────────────────────────

async function finalizeDefiniteFailureOrThrow(
  serviceClient: SupabaseClient,
  deliveryId: string,
  attemptCount: number,
  errorCode: string,
  errorMessage: string,
  invoiceId: string,
  recipientEmail: string
): Promise<InvoiceEmailDispatchResult> {
  const finalizeOk = await finalizeFailure(
    serviceClient,
    deliveryId,
    attemptCount,
    errorCode,
    errorMessage
  );

  if (!finalizeOk) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_FINALIZE_ERROR',
      `Pre-provider failure could not be finalized (errorCode: ${errorCode}). No provider call was made.`
    );
  }

  return {
    outcome: 'failed',
    deliveryId,
    invoiceId,
    recipientEmail,
    attemptCount,
    errorCode,
    errorMessage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORTED FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * dispatchInvoiceEmail — Server-only invoice email dispatcher.
 *
 * Accepts ONLY invoiceId and adminUserId. All other values (recipient email,
 * PDF path, idempotency key, invoice content) are derived server-side from
 * the authoritative DB state.
 *
 * Returns a structured InvoiceEmailDispatchResult for normal delivery
 * lifecycle outcomes. Throws InvoiceEmailDispatchError for unexpected
 * configuration / programming / database failures.
 *
 * Maximum one provider call per invocation.
 */
export async function dispatchInvoiceEmail(
  params: DispatchInvoiceEmailParams
): Promise<InvoiceEmailDispatchResult> {
  const { invoiceId, adminUserId } = params;

  // ── 1. VALIDATE INPUT UUIDS ───────────────────────────────────────────────
  if (
    typeof invoiceId !== 'string' ||
    !invoiceId.trim() ||
    !isValidUuid(invoiceId.trim())
  ) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_INVALID_INPUT',
      'invoiceId must be a valid UUID string.'
    );
  }

  if (
    typeof adminUserId !== 'string' ||
    !adminUserId.trim() ||
    !isValidUuid(adminUserId.trim())
  ) {
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_INVALID_INPUT',
      'adminUserId must be a valid UUID string.'
    );
  }

  const safeInvoiceId = invoiceId.trim();
  const safeAdminUserId = adminUserId.trim();

  // ── 2. VALIDATE ALL REQUIRED CONFIGURATION BEFORE CLAIM ──────────────────
  //
  // ALL configuration required for a future provider call is validated here,
  // BEFORE claim_invoice_email_delivery() is called. If any value is missing
  // or a placeholder, INVOICE_EMAIL_CONFIG_ERROR is thrown and no delivery
  // row is created or claimed.
  //
  // The validated config object is reused for the service client and the
  // Edge Function call — required provider configuration is NOT re-read
  // after a claim has been acquired.
  const config = buildServerConfig();

  // ── 3. SERVICE CLIENT ─────────────────────────────────────────────────────
  const serviceClient = createServiceClient(config);

  // ── 4. CLAIM DELIVERY ─────────────────────────────────────────────────────
  let claimRow: ClaimRpcRow;
  try {
    claimRow = await callClaimRpc(serviceClient, safeInvoiceId, safeAdminUserId);
  } catch (err) {
    if (err instanceof InvoiceEmailDispatchError) throw err;
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_CLAIM_RPC_ERROR',
      `Unexpected error calling claim RPC: ${err instanceof Error ? err.message : 'unknown'}`
    );
  }

  const claimOutcome = claimRow.outcome;

  // ── Handle non-actionable claim outcomes (do NOT call provider) ───────────
  if (claimOutcome === 'already_sent') {
    return {
      outcome: 'already_sent',
      deliveryId: claimRow.delivery_id,
      invoiceId: safeInvoiceId,
      recipientEmail: claimRow.recipient_email,
      providerMessageId: claimRow.provider_message_id,
      attemptCount: claimRow.attempt_count,
    };
  }

  if (claimOutcome === 'currently_sending') {
    return {
      outcome: 'currently_sending',
      deliveryId: claimRow.delivery_id,
      invoiceId: safeInvoiceId,
      recipientEmail: claimRow.recipient_email,
      attemptCount: claimRow.attempt_count,
    };
  }

  if (claimOutcome === 'uncertain') {
    return {
      outcome: 'uncertain',
      deliveryId: claimRow.delivery_id,
      invoiceId: safeInvoiceId,
      recipientEmail: claimRow.recipient_email,
      attemptCount: claimRow.attempt_count,
    };
  }

  // ── Only 'claimed' or 'retry_claimed' proceed to provider call ────────────
  if (claimOutcome !== 'claimed' && claimOutcome !== 'retry_claimed') {
    // Unknown RPC outcome — fail closed
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_CLAIM_RPC_ERROR',
      `claim_invoice_email_delivery returned unknown outcome: ${claimOutcome}`
    );
  }

  // From here: exactly ONE provider call is permitted.
  const deliveryId = claimRow.delivery_id!;
  const attemptCount = claimRow.attempt_count;
  const recipientEmail = claimRow.recipient_email;

  // ── 5. LOAD AUTHORITATIVE INVOICE SNAPSHOT ────────────────────────────────
  let invoice: InvoiceEmailSnapshot;
  try {
    invoice = await loadInvoiceSnapshot(serviceClient, safeInvoiceId);
  } catch {
    // Snapshot load failed — mark definite failure (provider not called yet)
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      'invoice_snapshot_load_failed',
      'Failed to load invoice snapshot before email send.',
      safeInvoiceId,
      recipientEmail
    );
  }

  // ── 6. VALIDATE SNAPSHOT ──────────────────────────────────────────────────
  const snapshotError = validateInvoiceSnapshot(invoice, claimRow.recipient_email);
  if (snapshotError) {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      snapshotError,
      `Invoice snapshot validation failed: ${snapshotError}`,
      safeInvoiceId,
      recipientEmail
    );
  }

  // ── 7. DOWNLOAD PRIVATE PDF ───────────────────────────────────────────────
  // Path comes ONLY from the DB row — never from caller input.
  const { bytes: pdfBytes, error: pdfDownloadError } = await downloadPdfBytes(
    serviceClient,
    invoice.pdf_storage_path
  );

  if (pdfDownloadError) {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      pdfDownloadError,
      'PDF download or validation failed before email send.',
      safeInvoiceId,
      recipientEmail
    );
  }

  // ── 8. VERIFY PDF HASH ────────────────────────────────────────────────────
  //
  // pdf_hash is REQUIRED. NULL/blank → invoice_pdf_hash_missing.
  // Malformed → invoice_pdf_hash_invalid.
  // Mismatch → invoice_pdf_hash_mismatch.
  //
  // In ALL three cases the Edge Function is NOT called and delivery is
  // finalized as a definite failure.
  const hashError = verifyPdfHash(pdfBytes, invoice.pdf_hash);
  if (hashError) {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      hashError,
      'PDF hash verification failed before email send.',
      safeInvoiceId,
      recipientEmail
    );
  }

  // ── 9. BASE64 ENCODE ──────────────────────────────────────────────────────
  // Server-side only. Do NOT log the base64 string.
  const base64Pdf = encodeBase64(pdfBytes);

  // ── 10. CALL EDGE FUNCTION (exactly ONE provider call) ────────────────────
  const edgeResult = await callEdgeFunction(config, invoice, claimRow, base64Pdf);

  // ── 11. INTERPRET RESPONSE ────────────────────────────────────────────────
  const providerOutcome = interpretEdgeFunctionResponse(edgeResult);

  // ── 12. FINALIZE DELIVERY STATE ───────────────────────────────────────────

  if (providerOutcome.kind === 'sent') {
    // SUCCESS PATH
    const { ok, alreadySent } = await finalizeSuccess(
      serviceClient,
      deliveryId,
      attemptCount,
      providerOutcome.emailId
    );

    if (ok) {
      return {
        outcome: alreadySent ? 'already_sent' : 'sent',
        deliveryId,
        invoiceId: safeInvoiceId,
        recipientEmail,
        providerMessageId: providerOutcome.emailId,
        attemptCount,
      };
    }

    // SUCCESS FINALIZATION FAILURE (critical edge case)
    // Provider confirmed success but local DB finalization failed.
    // Best-effort: mark uncertain with the known emailId.
    // NEVER call provider again.
    const uncertainOk = await finalizeUncertain(
      serviceClient,
      deliveryId,
      attemptCount,
      'success_finalize_failed',
      'Provider accepted the email but local success finalization failed.',
      providerOutcome.emailId
    );

    if (uncertainOk) {
      return {
        outcome: 'uncertain',
        deliveryId,
        invoiceId: safeInvoiceId,
        recipientEmail,
        providerMessageId: providerOutcome.emailId,
        attemptCount,
        errorCode: 'success_finalize_failed',
        errorMessage:
          'Provider accepted the email but local success finalization failed. Marked uncertain.',
      };
    }

    // Even uncertain RPC failed — surface a safe uncertainty error.
    // Leave the row as 'sending'; the stale-sending logic will move it
    // to uncertain after 15 minutes.
    // NEVER call provider again.
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_FINALIZE_ERROR',
      'Provider accepted the email but both success and uncertain finalization RPCs failed. '+ 'The delivery row remains in sending state and will be moved to uncertain by stale-sending logic.'
    );
  }

  if (providerOutcome.kind === 'failed') {
    // DEFINITE FAILURE PATH (post-provider)
    const finalizeOk = await finalizeFailure(
      serviceClient,
      deliveryId,
      attemptCount,
      providerOutcome.errorCode,
      providerOutcome.errorMessage
    );

    if (!finalizeOk) {
      // Failure finalization RPC itself failed — surface safe error, no retry
      throw new InvoiceEmailDispatchError(
        'INVOICE_EMAIL_FINALIZE_ERROR',
        'Provider rejected the email but failure finalization RPC also failed. '+ 'No provider retry will be attempted.'
      );
    }

    return {
      outcome: 'failed',
      deliveryId,
      invoiceId: safeInvoiceId,
      recipientEmail,
      attemptCount,
      errorCode: providerOutcome.errorCode,
      errorMessage: providerOutcome.errorMessage,
    };
  }

  // UNCERTAIN PATH (providerOutcome.kind === 'uncertain')
  const uncertainOk = await finalizeUncertain(
    serviceClient,
    deliveryId,
    attemptCount,
    providerOutcome.errorCode,
    providerOutcome.errorMessage,
    providerOutcome.emailId ?? null
  );

  if (!uncertainOk) {
    // Uncertain finalization RPC itself failed — surface safe error, no retry
    throw new InvoiceEmailDispatchError(
      'INVOICE_EMAIL_FINALIZE_ERROR',
      'Provider outcome was uncertain and uncertain finalization RPC also failed. '+ 'No provider retry will be attempted.'
    );
  }

  return {
    outcome: 'uncertain',
    deliveryId,
    invoiceId: safeInvoiceId,
    recipientEmail,
    providerMessageId: providerOutcome.emailId ?? null,
    attemptCount,
    errorCode: providerOutcome.errorCode,
    errorMessage: providerOutcome.errorMessage,
  };
}
