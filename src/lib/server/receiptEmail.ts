/**
 * src/lib/server/receiptEmail.ts
 *
 * Phase: 7B-11C — Server-Only Receipt Email Dispatcher
 *
 * SERVER-ONLY. Import 'server-only' prevents this module from being bundled
 * into any Client Component. SUPABASE_SERVICE_ROLE_KEY and
 * EB_EMAIL_INTERNAL_SECRET must never reach the browser.
 *
 * PURPOSE
 * -------
 * Provides dispatchReceiptEmail({ paymentId, adminUserId }) — the single
 * reusable entry point for sending a receipt-issued email through the
 * deployed send-borrower-emails Edge Function.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * 1. Validates paymentId and adminUserId as UUID-shaped strings.
 * 2. Validates ALL required server configuration (supabaseUrl,
 *    serviceRoleKey, emailInternalSecret) BEFORE any DB operation or claim.
 *    Missing/invalid configuration throws RECEIPT_EMAIL_CONFIG_ERROR and
 *    no delivery row is created or claimed.
 * 3. Calls claim_receipt_email_delivery() RPC (service_role) — the
 *    authoritative idempotency gate. Handles all RPC outcomes without
 *    calling the provider for already_sent / currently_sending / uncertain.
 * 4. Loads the authoritative payment snapshot from crm_payments and the
 *    associated invoice from crm_invoices (service_role) — selecting only
 *    fields needed for email delivery.
 * 5. Validates the snapshot fields and verifies that billing_email matches
 *    the claim's recipient_email (invariant check).
 * 6. Independently derives the canonical receipt PDF path:
 *    receipts/{application_id}/{invoice_id}/{payment_id}.pdf
 *    and compares it to crm_payments.receipt_pdf_storage_path.
 * 7. Downloads the private immutable PDF from the invoice-pdfs bucket
 *    using the canonical path only (never from caller input).
 *    Validates magic bytes (%PDF-) and non-empty content.
 * 8. Verifies the SHA-256 hash of the downloaded bytes against
 *    crm_payments.receipt_pdf_hash. Hash is REQUIRED — NULL/blank → failure.
 * 9. Base64-encodes the validated PDF bytes server-side.
 * 10. Calls the deployed send-borrower-emails Edge Function with the
 *    receipt_issued payload (exactly one provider call per invocation).
 * 11. Interprets the structured Edge Function response and finalizes
 *    delivery state via success / failure / uncertain RPCs.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * - Does NOT accept recipient email, PDF path, idempotency key, or any
 *   receipt/invoice content from the caller — only paymentId + adminUserId.
 * - Does NOT create a public/signed URL for the PDF.
 * - Does NOT log base64 PDF content, secrets, service keys, storage path,
 *   or PDF hash.
 * - Does NOT write crm_email_log or application_activity rows.
 * - Does NOT modify payment status or PDF state.
 * - Does NOT retry the provider on finalization failure.
 * - Does NOT re-render the receipt PDF — uses the exact immutable stored bytes.
 *
 * RETURN TYPE
 * -----------
 * Returns a structured ReceiptEmailDispatchResult rather than throwing
 * for normal delivery lifecycle outcomes (sent, already_sent,
 * currently_sending, failed, uncertain).
 *
 * Unexpected configuration / programming / database failures throw
 * ReceiptEmailDispatchError with a safe code and message.
 *
 * RECEIPT PDF HASH INVARIANT
 * --------------------------
 * crm_payments.receipt_pdf_hash MUST be a lowercase 64-character hex SHA-256
 * digest of the immutable receipt PDF bytes, set during complete_receipt_generation().
 *
 * receipt_pdf_hash is REQUIRED. There is NO bypass for NULL/blank values.
 * The stored value must match ^[0-9a-f]{64}$ exactly (validated as-is —
 * NOT lowercased before the regex check). The computed SHA-256 of the
 * downloaded bytes must equal the stored hash exactly.
 *
 * NULL / blank receipt_pdf_hash  → receipt_pdf_hash_missing  (definite failure)
 * Malformed receipt_pdf_hash     → receipt_pdf_hash_invalid  (definite failure)
 * Hash mismatch                  → receipt_pdf_hash_mismatch (definite failure)
 *
 * In all three cases the Edge Function is NOT called and delivery is
 * finalized as a definite failure.
 *
 * CONFIG VALIDATION ORDER
 * -----------------------
 * All required configuration (NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, EB_EMAIL_INTERNAL_SECRET) is validated
 * BEFORE claim_receipt_email_delivery() is called. If any value is
 * missing or a placeholder, RECEIPT_EMAIL_CONFIG_ERROR is thrown and
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

export type ReceiptEmailDispatchErrorCode =
  | 'RECEIPT_EMAIL_CONFIG_ERROR' |'RECEIPT_EMAIL_INVALID_INPUT' |'RECEIPT_EMAIL_CLAIM_RPC_ERROR' |'RECEIPT_EMAIL_SNAPSHOT_ERROR' |'RECEIPT_EMAIL_PDF_ERROR' |'RECEIPT_EMAIL_FINALIZE_ERROR';

export class ReceiptEmailDispatchError extends Error {
  public readonly code: ReceiptEmailDispatchErrorCode;

  constructor(code: ReceiptEmailDispatchErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'ReceiptEmailDispatchError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────────────────────────────────────

export type ReceiptEmailOutcome =
  | 'sent' |'already_sent' |'currently_sending' |'failed' |'uncertain';

export interface ReceiptEmailDispatchResult {
  outcome: ReceiptEmailOutcome;
  deliveryId: string | null;
  paymentId: string;
  attemptCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher input
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchReceiptEmailParams {
  paymentId: string;
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
// Internal: payment snapshot shape (only fields needed for email delivery)
// ─────────────────────────────────────────────────────────────────────────────

interface PaymentEmailSnapshot {
  id: string;
  invoice_id: string;
  status: string;
  payment_method: string | null;
  amount_cents: number;
  currency: string;
  received_at: string | null;
  reference_number: string | null;

  receipt_number: string | null;
  receipt_issued_at: string | null;
  receipt_pdf_storage_path: string | null;
  receipt_pdf_generated_at: string | null;
  receipt_pdf_hash: string | null;

  amount_paid_after_cents: number | null;
  balance_remaining_after_cents: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: invoice snapshot shape (only fields needed for email delivery)
// ─────────────────────────────────────────────────────────────────────────────

interface InvoiceEmailSnapshot {
  id: string;
  application_id: string;
  invoice_number: string | null;
  billing_email: string | null;
  billing_contact_name: string | null;
  total_cents: number;
  currency: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: claim RPC row shape
// ─────────────────────────────────────────────────────────────────────────────

interface ClaimRpcRow {
  outcome: string;
  delivery_id: string | null;
  payment_id: string;
  recipient_email: string;
  provider: string;
  provider_idempotency_key: string;
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
// checking. The stored receipt_pdf_hash must itself match ^[0-9a-f]{64}$.
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
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_CONFIG_ERROR',
      `Required environment variable ${name} is not configured.`
    );
  }
  const lower = value.toLowerCase();
  if (KNOWN_PLACEHOLDERS.some((p) => lower.startsWith(p))) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_CONFIG_ERROR',
      `Environment variable ${name} appears to be a placeholder value.`
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build validated server configuration object.
//
// Reads and validates ALL required configuration in one place, BEFORE any
// DB operation or claim. Throws RECEIPT_EMAIL_CONFIG_ERROR if any value is
// missing or a placeholder — no delivery row is created or claimed.
//
// NEVER falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY.
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
// STEP 1: Call claim_receipt_email_delivery RPC
// ─────────────────────────────────────────────────────────────────────────────

async function callClaimRpc(
  serviceClient: SupabaseClient,
  paymentId: string,
  adminUserId: string
): Promise<ClaimRpcRow> {
  const { data, error } = await serviceClient.rpc('claim_receipt_email_delivery', {
    p_payment_id: paymentId,
    p_admin_user_id: adminUserId,
  });

  if (error) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_CLAIM_RPC_ERROR',
      `claim_receipt_email_delivery RPC failed: ${error.message ?? 'unknown error'}`
    );
  }

  // RPC returns a TABLE — Supabase client wraps it as an array
  const rows = Array.isArray(data) ? data : [data];
  if (!rows || rows.length === 0 || rows[0] == null) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_CLAIM_RPC_ERROR',
      'claim_receipt_email_delivery RPC returned no rows.'
    );
  }

  const row = rows[0] as ClaimRpcRow;
  if (typeof row.outcome !== 'string' || row.outcome.trim() === '') {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_CLAIM_RPC_ERROR',
      'claim_receipt_email_delivery RPC returned an unrecognized outcome shape.'
    );
  }

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Load authoritative payment + invoice snapshots
// ─────────────────────────────────────────────────────────────────────────────

async function loadPaymentSnapshot(
  serviceClient: SupabaseClient,
  paymentId: string
): Promise<PaymentEmailSnapshot> {
  const { data, error } = await serviceClient
    .from('crm_payments')
    .select(
      'id, invoice_id, status, payment_method, amount_cents, currency, received_at, reference_number, ' + 'receipt_number, receipt_issued_at, receipt_pdf_storage_path, receipt_pdf_generated_at, receipt_pdf_hash, '+ 'amount_paid_after_cents, balance_remaining_after_cents'
    )
    .eq('id', paymentId)
    .single();

  if (error || !data) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_SNAPSHOT_ERROR',
      `Failed to load payment snapshot: ${error?.message ?? 'row not found'}`
    );
  }

  return data as PaymentEmailSnapshot;
}

async function loadInvoiceSnapshot(
  serviceClient: SupabaseClient,
  invoiceId: string
): Promise<InvoiceEmailSnapshot> {
  const { data, error } = await serviceClient
    .from('crm_invoices')
    .select(
      'id, application_id, invoice_number, billing_email, billing_contact_name, total_cents, currency'
    )
    .eq('id', invoiceId)
    .single();

  if (error || !data) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_SNAPSHOT_ERROR',
      `Failed to load invoice snapshot: ${error?.message ?? 'row not found'}`
    );
  }

  return data as InvoiceEmailSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Validate payment + invoice snapshot fields (invariant checks)
//
// Returns: null (valid) | error code string (definite failure)
// ─────────────────────────────────────────────────────────────────────────────

function validateSnapshots(
  payment: PaymentEmailSnapshot,
  invoice: InvoiceEmailSnapshot,
  requestedPaymentId: string,
  claimRecipientEmail: string
): string | null {
  // A. payment.id must match requested paymentId
  if (payment.id !== requestedPaymentId) {
    return 'receipt_snapshot_payment_id_mismatch';
  }

  // B. payment.invoice_id must match the loaded invoice
  if (payment.invoice_id !== invoice.id) {
    return 'receipt_snapshot_invoice_id_mismatch';
  }

  // C. payment.status must be 'received'
  if (payment.status !== 'received') {
    return 'receipt_snapshot_payment_not_received';
  }

  // D. Receipt must be complete: all receipt fields non-null/non-blank
  if (!payment.receipt_number || payment.receipt_number.trim() === '') {
    return 'receipt_snapshot_missing_receipt_number';
  }
  if (!payment.receipt_issued_at) {
    return 'receipt_snapshot_missing_receipt_issued_at';
  }
  if (!payment.receipt_pdf_storage_path || payment.receipt_pdf_storage_path.trim() === '') {
    return 'receipt_snapshot_missing_pdf_storage_path';
  }
  if (!payment.receipt_pdf_generated_at) {
    return 'receipt_snapshot_missing_pdf_generated_at';
  }
  if (!payment.receipt_pdf_hash || payment.receipt_pdf_hash.trim() === '') {
    return 'receipt_pdf_hash_missing';
  }
  // Validate hash format (as-is, no lowercasing)
  if (!isValidSha256Hex(payment.receipt_pdf_hash)) {
    return 'receipt_pdf_hash_invalid';
  }

  // E. invoice_number must be nonblank
  if (!invoice.invoice_number || invoice.invoice_number.trim() === '') {
    return 'receipt_snapshot_missing_invoice_number';
  }

  // F. invoice.application_id must exist
  if (!invoice.application_id || invoice.application_id.trim() === '') {
    return 'receipt_snapshot_missing_application_id';
  }

  // G. invoice.billing_email must match claim.recipient_email (normalized)
  if (!invoice.billing_email || invoice.billing_email.trim() === '') {
    return 'receipt_snapshot_missing_billing_email';
  }
  if (
    invoice.billing_email.trim().toLowerCase() !==
    claimRecipientEmail.trim().toLowerCase()
  ) {
    return 'receipt_snapshot_billing_email_mismatch';
  }

  // H. currency relationship: payment and invoice must have same currency
  if (
    !payment.currency ||
    !invoice.currency ||
    payment.currency.trim().toUpperCase() !== invoice.currency.trim().toUpperCase()
  ) {
    return 'receipt_snapshot_currency_mismatch';
  }

  return null; // all invariants pass
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Derive and verify canonical receipt PDF path
//
// Canonical path: receipts/{application_id}/{invoice_id}/{payment_id}.pdf
// Compare to crm_payments.receipt_pdf_storage_path.
// Returns: null (paths match) | error code string (definite failure)
// ─────────────────────────────────────────────────────────────────────────────

function deriveAndVerifyCanonicalPath(
  applicationId: string,
  invoiceId: string,
  paymentId: string,
  storedPath: string
): { canonicalPath: string; error: string | null } {
  const canonicalPath = `receipts/${applicationId}/${invoiceId}/${paymentId}.pdf`;

  if (storedPath.trim() !== canonicalPath) {
    return {
      canonicalPath,
      error: 'receipt_pdf_path_mismatch',
    };
  }

  return { canonicalPath, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Download private PDF from storage
// ─────────────────────────────────────────────────────────────────────────────

async function downloadPdfBytes(
  serviceClient: SupabaseClient,
  canonicalPath: string
): Promise<{ bytes: Uint8Array; error: string | null }> {
  const { data: blob, error } = await serviceClient.storage
    .from('invoice-pdfs')
    .download(canonicalPath);

  if (error || !blob) {
    // Do not include raw storage error message (may contain path info)
    return { bytes: new Uint8Array(0), error: 'receipt_pdf_download_failed' };
  }

  let bytes: Uint8Array;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
  } catch {
    return { bytes: new Uint8Array(0), error: 'receipt_pdf_download_failed' };
  }

  // Validate non-empty
  if (bytes.length === 0) {
    return { bytes: new Uint8Array(0), error: 'receipt_pdf_invalid' };
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
    return { bytes: new Uint8Array(0), error: 'receipt_pdf_invalid' };
  }

  return { bytes, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6: Verify PDF SHA-256 hash
//
// receipt_pdf_hash is REQUIRED. There is NO bypass for NULL/blank values.
// All three failure cases are definite failures — Edge Function MUST NOT
// be called in any of them.
//
// NULL / blank receipt_pdf_hash  → 'receipt_pdf_hash_missing'
// Malformed receipt_pdf_hash     → 'receipt_pdf_hash_invalid'
// Hash mismatch                  → 'receipt_pdf_hash_mismatch'
//
// IMPORTANT: the stored receipt_pdf_hash value is validated AS-IS against
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
    return 'receipt_pdf_hash_missing';
  }

  // Validate the stored value exactly as-is (no lowercasing).
  if (!isValidSha256Hex(pdfHash)) {
    return 'receipt_pdf_hash_invalid';
  }

  // Compute SHA-256 over the downloaded bytes and compare exact equality.
  // createHash('sha256').digest('hex') always returns lowercase hex.
  const computed = createHash('sha256').update(bytes).digest('hex');

  if (computed !== pdfHash) {
    return 'receipt_pdf_hash_mismatch';
  }

  return null; // hash verified
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7: Base64 encode PDF bytes (server-side, deterministic)
// ─────────────────────────────────────────────────────────────────────────────

function encodeBase64(bytes: Uint8Array): string {
  // Use Node.js Buffer for deterministic base64 encoding
  return Buffer.from(bytes).toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8: Call the deployed Edge Function
//
// Uses the pre-validated ServerConfig — does NOT re-read required provider
// configuration after a claim has been acquired.
//
// emailType: 'receipt_issued' — the Edge Function does not yet support this
// type (Phase 7B-11D will add that support). The payload is designed now
// so 7B-11D can consume it.
//
// Maximum ONE provider/Edge Function call per dispatcher invocation.
// No internal automatic provider retry loop.
// ─────────────────────────────────────────────────────────────────────────────

interface EdgeFunctionCallResult {
  transportError: boolean; // true = fetch threw / timed out
  httpStatus: number | null;
  body: Record<string, unknown> | null;
}

async function callEdgeFunction(
  config: ServerConfig,
  payment: PaymentEmailSnapshot,
  invoice: InvoiceEmailSnapshot,
  claimRow: ClaimRpcRow,
  base64Pdf: string
): Promise<EdgeFunctionCallResult> {
  const edgeFnUrl = `${config.supabaseUrl}/functions/v1/send-borrower-emails`;

  // Authoritative fields only — no admin identity, storage path, hash, or secrets
  const payload = {
    emailType: 'receipt_issued',

    to: claimRow.recipient_email,

    paymentId: payment.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    receiptNumber: payment.receipt_number,
    receiptIssuedAt: payment.receipt_issued_at,

    paymentAmountCents: payment.amount_cents,
    currency: payment.currency,
    paymentReceivedAt: payment.received_at,
    paymentMethod: payment.payment_method,
    paymentReference: payment.reference_number,

    invoiceTotalCents: invoice.total_cents,
    amountPaidAfterCents: payment.amount_paid_after_cents,
    balanceRemainingAfterCents: payment.balance_remaining_after_cents,

    billingContactName: invoice.billing_contact_name,

    idempotencyKey: claimRow.provider_idempotency_key,

    attachments: [
      {
        filename: `EarnestBridge-Receipt-${payment.receipt_number}.pdf`,
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
// STEP 9: Interpret Edge Function response
//
// Mirrors invoiceEmail.ts provider-response classification exactly.
//
// sent     — provider explicitly accepted with email/message ID
// failed   — explicit provider/Edge rejection proving no send occurred
// uncertain — timeout, network ambiguity, HTTP response where send outcome
//             cannot be established, malformed/unrecognized post-provider response
//
// Prefer uncertain over retryable failed whenever delivery may have occurred.
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
      errorMessage:
        'Network or transport failure reaching Edge Function; delivery outcome unknown.',
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
        errorMessage:
          'Edge Function reported success but returned no usable provider message ID.',
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
// STEP 10: Finalization RPCs
// ─────────────────────────────────────────────────────────────────────────────

async function finalizeSuccess(
  serviceClient: SupabaseClient,
  deliveryId: string,
  attemptCount: number,
  emailId: string
): Promise<{ ok: boolean; alreadySent: boolean }> {
  const { data, error } = await serviceClient.rpc(
    'complete_receipt_email_delivery_success',
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
    'complete_receipt_email_delivery_failure',
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
    'mark_receipt_email_delivery_uncertain',
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
// Throws RECEIPT_EMAIL_FINALIZE_ERROR if finalizeFailure() returns false.
//
// The Edge Function is NEVER called when this helper is used.
// ─────────────────────────────────────────────────────────────────────────────

async function finalizeDefiniteFailureOrThrow(
  serviceClient: SupabaseClient,
  deliveryId: string,
  attemptCount: number,
  errorCode: string,
  errorMessage: string,
  paymentId: string
): Promise<ReceiptEmailDispatchResult> {
  const finalizeOk = await finalizeFailure(
    serviceClient,
    deliveryId,
    attemptCount,
    errorCode,
    errorMessage
  );

  if (!finalizeOk) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_FINALIZE_ERROR',
      `Pre-provider failure could not be finalized (errorCode: ${errorCode}). No provider call was made.`
    );
  }

  return {
    outcome: 'failed',
    deliveryId,
    paymentId,
    attemptCount,
    errorCode,
    errorMessage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORTED FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * dispatchReceiptEmail — Server-only receipt email dispatcher.
 *
 * Accepts ONLY paymentId and adminUserId. All other values (recipient email,
 * PDF path, idempotency key, receipt/invoice content) are derived server-side
 * from the authoritative DB state.
 *
 * Returns a structured ReceiptEmailDispatchResult for normal delivery
 * lifecycle outcomes. Throws ReceiptEmailDispatchError for unexpected
 * configuration / programming / database failures.
 *
 * Maximum one provider call per invocation.
 *
 * This function is NOT wired into any route yet (Phase 7B-11D).
 * Emails sent by calling this function: 0 until wired.
 */
export async function dispatchReceiptEmail(
  params: DispatchReceiptEmailParams
): Promise<ReceiptEmailDispatchResult> {
  const { paymentId, adminUserId } = params;

  // ── 1. VALIDATE INPUT UUIDS ───────────────────────────────────────────────
  if (
    typeof paymentId !== 'string' ||
    !paymentId.trim() ||
    !isValidUuid(paymentId.trim())
  ) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_INVALID_INPUT',
      'paymentId must be a valid UUID string.'
    );
  }

  if (
    typeof adminUserId !== 'string' ||
    !adminUserId.trim() ||
    !isValidUuid(adminUserId.trim())
  ) {
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_INVALID_INPUT',
      'adminUserId must be a valid UUID string.'
    );
  }

  const safePaymentId = paymentId.trim();
  const safeAdminUserId = adminUserId.trim();

  // ── 2. VALIDATE ALL REQUIRED CONFIGURATION BEFORE CLAIM ──────────────────
  //
  // ALL configuration required for a future provider call is validated here,
  // BEFORE claim_receipt_email_delivery() is called. If any value is missing
  // or a placeholder, RECEIPT_EMAIL_CONFIG_ERROR is thrown and no delivery
  // row is created or claimed.
  //
  // The validated config object is reused for the service client and the
  // Edge Function call — required provider configuration is NOT re-read
  // after a claim has been acquired.
  //
  // NEVER falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY.
  const config = buildServerConfig();

  // ── 3. SERVICE CLIENT ─────────────────────────────────────────────────────
  const serviceClient = createServiceClient(config);

  // ── 4. CLAIM DELIVERY ─────────────────────────────────────────────────────
  // claim_receipt_email_delivery is the AUTHORITATIVE idempotency gate.
  // No delivery row is created or claimed if config validation fails above.
  let claimRow: ClaimRpcRow;
  try {
    claimRow = await callClaimRpc(serviceClient, safePaymentId, safeAdminUserId);
  } catch (err) {
    if (err instanceof ReceiptEmailDispatchError) throw err;
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_CLAIM_RPC_ERROR',
      `Unexpected error calling claim RPC: ${err instanceof Error ? err.message : 'unknown'}`
    );
  }

  const claimOutcome = claimRow.outcome;

  // ── Handle non-actionable claim outcomes (do NOT call provider) ───────────
  if (claimOutcome === 'already_sent') {
    return {
      outcome: 'already_sent',
      deliveryId: claimRow.delivery_id,
      paymentId: safePaymentId,
      attemptCount: claimRow.attempt_count,
    };
  }

  if (claimOutcome === 'currently_sending') {
    return {
      outcome: 'currently_sending',
      deliveryId: claimRow.delivery_id,
      paymentId: safePaymentId,
      attemptCount: claimRow.attempt_count,
    };
  }

  if (claimOutcome === 'uncertain') {
    return {
      outcome: 'uncertain',
      deliveryId: claimRow.delivery_id,
      paymentId: safePaymentId,
      attemptCount: claimRow.attempt_count,
    };
  }

  // ── Only 'claimed' or 'retry_claimed' proceed to provider call ────────────
  if (claimOutcome !== 'claimed' && claimOutcome !== 'retry_claimed') {
    // Unknown RPC outcome — fail closed
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_CLAIM_RPC_ERROR',
      `claim_receipt_email_delivery returned unknown outcome: ${claimOutcome}`
    );
  }

  // From here: exactly ONE provider call is permitted.
  // Capture the EXACT authoritative attempt_count from the claim.
  // This MUST be passed to whichever finalizer is later used.
  const deliveryId = claimRow.delivery_id!;
  const attemptCount = claimRow.attempt_count;

  // ── 5. LOAD AUTHORITATIVE PAYMENT SNAPSHOT ────────────────────────────────
  let payment: PaymentEmailSnapshot;
  try {
    payment = await loadPaymentSnapshot(serviceClient, safePaymentId);
  } catch {
    // Snapshot load failed — mark definite failure (provider not called yet)
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      'receipt_payment_snapshot_load_failed',
      'Failed to load payment snapshot before receipt email send.',
      safePaymentId
    );
  }

  // ── 6. LOAD AUTHORITATIVE INVOICE SNAPSHOT ────────────────────────────────
  let invoice: InvoiceEmailSnapshot;
  try {
    invoice = await loadInvoiceSnapshot(serviceClient, payment.invoice_id);
  } catch {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      'receipt_invoice_snapshot_load_failed',
      'Failed to load invoice snapshot before receipt email send.',
      safePaymentId
    );
  }

  // ── 7. VALIDATE SNAPSHOTS (INVARIANT CHECKS) ──────────────────────────────
  const snapshotError = validateSnapshots(
    payment,
    invoice,
    safePaymentId,
    claimRow.recipient_email
  );
  if (snapshotError) {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      snapshotError,
      `Receipt/invoice snapshot invariant check failed: ${snapshotError}`,
      safePaymentId
    );
  }

  // ── 8. CANONICAL PATH DERIVATION AND VERIFICATION ────────────────────────
  // Independently derive the canonical path and compare to stored path.
  // Never trust the stored path blindly.
  const { canonicalPath, error: pathError } = deriveAndVerifyCanonicalPath(
    invoice.application_id,
    invoice.id,
    safePaymentId,
    payment.receipt_pdf_storage_path!
  );

  if (pathError) {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      pathError,
      'Canonical receipt PDF path does not match stored path.',
      safePaymentId
    );
  }

  // ── 9. DOWNLOAD PRIVATE PDF ───────────────────────────────────────────────
  // Path comes ONLY from the canonical derivation — never from caller input.
  // No public URL, no signed URL, no browser access.
  const { bytes: pdfBytes, error: pdfDownloadError } = await downloadPdfBytes(
    serviceClient,
    canonicalPath
  );

  if (pdfDownloadError) {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      pdfDownloadError,
      'Receipt PDF download or validation failed before email send.',
      safePaymentId
    );
  }

  // ── 10. VERIFY PDF HASH ───────────────────────────────────────────────────
  //
  // receipt_pdf_hash is REQUIRED. NULL/blank → receipt_pdf_hash_missing.
  // Malformed → receipt_pdf_hash_invalid.
  // Mismatch → receipt_pdf_hash_mismatch.
  //
  // In ALL three cases the Edge Function is NOT called and delivery is
  // finalized as a definite failure.
  //
  // Do NOT re-render the receipt. The email attachment must be the exact
  // immutable stored receipt.
  const hashError = verifyPdfHash(pdfBytes, payment.receipt_pdf_hash);
  if (hashError) {
    return await finalizeDefiniteFailureOrThrow(
      serviceClient,
      deliveryId,
      attemptCount,
      hashError,
      'Receipt PDF hash verification failed before email send.',
      safePaymentId
    );
  }

  // ── 11. BASE64 ENCODE ─────────────────────────────────────────────────────
  // Server-side only. Do NOT log the base64 string, PDF bytes, storage path,
  // hash, service keys, or internal secret.
  const base64Pdf = encodeBase64(pdfBytes);

  // ── 12. CALL EDGE FUNCTION (exactly ONE provider call) ────────────────────
  const edgeResult = await callEdgeFunction(
    config,
    payment,
    invoice,
    claimRow,
    base64Pdf
  );

  // ── 13. INTERPRET RESPONSE ────────────────────────────────────────────────
  const providerOutcome = interpretEdgeFunctionResponse(edgeResult);

  // ── 14. FINALIZE DELIVERY STATE ───────────────────────────────────────────
  // Use EXACTLY the attempt_count returned from the claim in every finalizer.

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
        paymentId: safePaymentId,
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
      'Provider accepted the receipt email but local success finalization failed.',
      providerOutcome.emailId
    );

    if (uncertainOk) {
      return {
        outcome: 'uncertain',
        deliveryId,
        paymentId: safePaymentId,
        attemptCount,
        errorCode: 'success_finalize_failed',
        errorMessage:
          'Provider accepted the receipt email but local success finalization failed. Marked uncertain.',
      };
    }

    // Even uncertain RPC failed — surface a safe uncertainty error.
    // Leave the row as 'sending'; the stale-sending logic will move it
    // to uncertain after 15 minutes.
    // NEVER call provider again.
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_FINALIZE_ERROR',
      'Provider accepted the receipt email but both success and uncertain finalization RPCs failed. '+ 'The delivery row remains in sending state and will be moved to uncertain by stale-sending logic.'
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
      throw new ReceiptEmailDispatchError(
        'RECEIPT_EMAIL_FINALIZE_ERROR',
        'Provider rejected the receipt email but failure finalization RPC also failed. '+ 'No provider retry will be attempted.'
      );
    }

    return {
      outcome: 'failed',
      deliveryId,
      paymentId: safePaymentId,
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
    throw new ReceiptEmailDispatchError(
      'RECEIPT_EMAIL_FINALIZE_ERROR',
      'Provider outcome was uncertain and uncertain finalization RPC also failed. '+ 'No provider retry will be attempted.'
    );
  }

  return {
    outcome: 'uncertain',
    deliveryId,
    paymentId: safePaymentId,
    attemptCount,
    errorCode: providerOutcome.errorCode,
    errorMessage: providerOutcome.errorMessage,
  };
}
