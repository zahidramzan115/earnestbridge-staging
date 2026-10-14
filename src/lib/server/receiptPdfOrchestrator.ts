/**
 * src/lib/server/receiptPdfOrchestrator.ts
 *
 * Phase: 7B-9F — Receipt PDF Orchestrator
 *
 * SERVER-ONLY. Must never be imported into a Client Component bundle.
 *
 * PURPOSE
 * -------
 * Handles the full receipt PDF generation, storage, and completion lifecycle
 * for a payment that has already been recorded as status = 'received'.
 *
 * LIFECYCLE
 * ---------
 * STEP A — PREPARE
 *   Call prepare_receipt_generation(p_payment_id, p_admin_user_id).
 *   If already_complete = true → return existing state, no further work.
 *
 * STEP B — RENDER
 *   Build ReceiptPdfInput strictly from PREPARE response.
 *   Render deterministic PDF bytes using receiptPdf.ts.
 *
 * STEP C — HASH
 *   Compute SHA-256 of the exact PDF bytes (lowercase 64-char hex).
 *
 * STEP D — CANONICAL PATH
 *   receipts/{application_id}/{invoice_id}/{payment_id}.pdf
 *   All components from PREPARE response / trusted DB-derived values.
 *   Never accept storage path from browser/caller.
 *
 * STEP E — STORAGE CHECK
 *   Check whether canonical object already exists in invoice-pdfs bucket.
 *   If NOT exists → upload with upsert:false.
 *   If EXISTS → download, hash, compare:
 *     Same hash  → reuse, proceed to COMPLETE.
 *     Diff hash  → STOP with receipt_storage_conflict. Never overwrite.
 *
 * STEP F — COMPLETE
 *   Call complete_receipt_generation(p_payment_id, p_admin_user_id, p_pdf_hash).
 *   RPC derives canonical path and timestamp internally.
 *
 * RETRY RECOVERY
 * --------------
 * A. PREPARE succeeds, render fails → retry gets same receipt_number + receipt_issued_at
 * B. Render succeeds, upload fails → DB remains prepared; retry renders same bytes
 * C. Upload succeeds, COMPLETE fails → retry finds existing object, hashes it,
 *    same hash → COMPLETE again, never overwrites
 * D. COMPLETE succeeds, caller loses response → next PREPARE returns already_complete
 * E. Existing object differs from deterministic render → fail closed, no overwrite
 *
 * STORAGE SECURITY
 * ----------------
 * Bucket: invoice-pdfs (private, existing)
 * Path prefix: receipts/
 * Uses service-role client only.
 * Never creates public bucket, signed URLs, or exposes service-role credentials.
 *
 * SAFE RESULT
 * -----------
 * Returns only: success, already_complete, receipt_number, receipt_issued_at,
 * generated_at, payment_id, invoice_id.
 * Does NOT return: Admin identity, notes, idempotency keys, provider data,
 * service-role info, or storage_path.
 *
 * ERROR CATEGORIES
 * ----------------
 * receipt_prepare_failed
 * receipt_render_failed
 * receipt_storage_conflict
 * receipt_upload_failed
 * receipt_complete_failed
 */

import 'server-only';

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

import { renderReceiptPdf, ReceiptPdfError, ReceiptPdfInput } from './receiptPdf';

// ---------------------------------------------------------------------------
// Safe orchestrator error codes
// ---------------------------------------------------------------------------

export type ReceiptOrchestratorErrorCode =
  | 'receipt_prepare_failed' |'receipt_render_failed' |'receipt_storage_conflict' |'receipt_upload_failed' |'receipt_complete_failed';

export class ReceiptOrchestratorError extends Error {
  public readonly code: ReceiptOrchestratorErrorCode;

  constructor(code: ReceiptOrchestratorErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'ReceiptOrchestratorError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Safe orchestrator result
// ---------------------------------------------------------------------------

export interface ReceiptOrchestratorResult {
  success: true;
  already_complete: boolean;
  receipt_number: string;
  receipt_issued_at: string;
  generated_at: string | null;
  payment_id: string;
  invoice_id: string;
}

// ---------------------------------------------------------------------------
// PREPARE RPC response shape
// ---------------------------------------------------------------------------

interface PrepareReceiptResponse {
  already_complete: boolean;
  receipt_number: string;
  receipt_issued_at: string;

  payment_id: string;
  payment_amount_cents: number;
  payment_received_at: string;
  payment_method: string;
  payment_reference_number: string | null;
  payment_currency: string;

  amount_paid_after_cents: number;
  balance_remaining_after_cents: number;

  invoice_id: string;
  application_id: string;
  invoice_number: string;
  invoice_total_cents: number;
  invoice_issued_at: string;
  invoice_currency: string;

  billing_name: string | null;
  billing_contact_name: string | null;
  billing_address_line1: string | null;
  billing_address_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_postal_code: string | null;
  billing_country: string | null;
}

// ---------------------------------------------------------------------------
// COMPLETE RPC response shape
// ---------------------------------------------------------------------------

interface CompleteReceiptResponse {
  already_complete?: boolean;
  receipt_number: string;
  receipt_issued_at: string;
  generated_at: string | null;
  payment_id: string;
  invoice_id: string;
}

// ---------------------------------------------------------------------------
// Service-role Supabase client (server-side only)
// ---------------------------------------------------------------------------

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new ReceiptOrchestratorError(
      'receipt_prepare_failed',
      'Supabase service configuration is missing.',
    );
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Storage constants
// ---------------------------------------------------------------------------

const STORAGE_BUCKET = 'invoice-pdfs';

/**
 * Canonical storage path for a receipt PDF.
 * receipts/{application_id}/{invoice_id}/{payment_id}.pdf
 * All components must come from PREPARE response / trusted DB-derived values.
 */
function buildCanonicalPath(
  applicationId: string,
  invoiceId: string,
  paymentId: string,
): string {
  return `receipts/${applicationId}/${invoiceId}/${paymentId}.pdf`;
}

/**
 * Folder prefix for narrow list-based existence check.
 * receipts/{application_id}/{invoice_id}
 */
function buildStorageFolder(applicationId: string, invoiceId: string): string {
  return `receipts/${applicationId}/${invoiceId}`;
}

// ---------------------------------------------------------------------------
// SHA-256 helper — lowercase 64-character hex
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// PDF magic bytes validation (%PDF-)
// ---------------------------------------------------------------------------

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

function validatePdfMagic(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new ReceiptOrchestratorError(
      'receipt_upload_failed',
      'Storage object has zero size.',
    );
  }
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) {
      throw new ReceiptOrchestratorError(
        'receipt_upload_failed',
        'Storage object does not begin with PDF magic bytes.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Storage existence check via narrow folder list
//
// Returns:
//   { exists: true,  bytes: Uint8Array }  — object found and downloaded
//   { exists: false, bytes: null }        — object definitely does not exist
//
// Throws ReceiptOrchestratorError on storage failure.
// ---------------------------------------------------------------------------

interface StorageFoundResult {
  exists: true;
  bytes: Uint8Array;
}

interface StorageMissingResult {
  exists: false;
  bytes: null;
}

type StorageCheckResult = StorageFoundResult | StorageMissingResult;

async function checkAndDownloadExistingObject(
  applicationId: string,
  invoiceId: string,
  paymentId: string,
  canonicalPath: string,
): Promise<StorageCheckResult> {
  const supabase = getServiceClient();
  const folder = buildStorageFolder(applicationId, invoiceId);
  const exactFilename = `${paymentId}.pdf`;

  // Narrow folder list to determine existence
  const { data: listData, error: listError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(folder, { search: exactFilename });

  if (listError) {
    console.error('[receiptPdfOrchestrator] storage list failure:', {
      code: (listError as { statusCode?: string }).statusCode ?? 'unknown',
    });
    throw new ReceiptOrchestratorError(
      'receipt_upload_failed',
      'Storage list failed when checking for existing receipt object.',
    );
  }

  const exactMatch = (listData ?? []).find((item) => item.name === exactFilename);

  if (!exactMatch) {
    return { exists: false, bytes: null };
  }

  // Object confirmed present — download for byte validation
  const { data: downloadData, error: downloadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(canonicalPath);

  if (downloadError || !downloadData) {
    console.error('[receiptPdfOrchestrator] storage download failure after list confirmed existence:', {
      statusCode: (downloadError as { statusCode?: string } | null)?.statusCode ?? 'unknown',
    });
    throw new ReceiptOrchestratorError(
      'receipt_upload_failed',
      'Storage download failed after list confirmed object existence.',
    );
  }

  const arrayBuffer = await downloadData.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  return { exists: true, bytes };
}

// ---------------------------------------------------------------------------
// Main orchestrator function
//
// Caller provides: paymentId, adminUserId
// Does NOT accept storage path, receipt number, or any other server-derived value.
// ---------------------------------------------------------------------------

export async function generateReceiptPdf(
  paymentId: string,
  adminUserId: string,
): Promise<ReceiptOrchestratorResult> {
  const supabase = getServiceClient();

  // ── STEP A: PREPARE ──────────────────────────────────────────────────────
  // Call prepare_receipt_generation RPC.
  // This is the authoritative source for all receipt rendering data.

  let prepareData: PrepareReceiptResponse;

  try {
    const { data, error } = await supabase.rpc('prepare_receipt_generation', {
      p_payment_id: paymentId,
      p_admin_user_id: adminUserId,
    });

    if (error) {
      console.error('[receiptPdfOrchestrator] prepare_receipt_generation failed:', {
        paymentId,
        code: (error as { code?: string }).code ?? 'unknown',
      });
      throw new ReceiptOrchestratorError(
        'receipt_prepare_failed',
        'prepare_receipt_generation RPC failed.',
      );
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ReceiptOrchestratorError(
        'receipt_prepare_failed',
        'prepare_receipt_generation returned unexpected response shape.',
      );
    }

    prepareData = data as PrepareReceiptResponse;
  } catch (err) {
    if (err instanceof ReceiptOrchestratorError) throw err;
    console.error('[receiptPdfOrchestrator] prepare_receipt_generation threw:', { paymentId });
    throw new ReceiptOrchestratorError(
      'receipt_prepare_failed',
      'prepare_receipt_generation threw an unexpected error.',
    );
  }

  // ── STEP A1: already_complete short-circuit ──────────────────────────────
  // If the receipt PDF is already complete, return existing state immediately.
  // Do NOT allocate another number, render another PDF, or upload another object.

  if (prepareData.already_complete === true) {
    console.info('[receiptPdfOrchestrator] receipt already complete, returning existing state:', {
      paymentId,
    });
    return {
      success: true,
      already_complete: true,
      receipt_number: prepareData.receipt_number,
      receipt_issued_at: prepareData.receipt_issued_at,
      generated_at: null, // not returned by PREPARE for already_complete
      payment_id: prepareData.payment_id,
      invoice_id: prepareData.invoice_id,
    };
  }

  // ── STEP B: RENDER ───────────────────────────────────────────────────────
  // Build ReceiptPdfInput STRICTLY from PREPARE response.
  // Do NOT re-query Supabase. Do NOT call now(). Do NOT use any caller-supplied values.

  const renderInput: ReceiptPdfInput = {
    receipt_number: prepareData.receipt_number,
    receipt_issued_at: prepareData.receipt_issued_at,

    payment_id: prepareData.payment_id,
    payment_amount_cents: prepareData.payment_amount_cents,
    payment_received_at: prepareData.payment_received_at,
    payment_method: prepareData.payment_method,
    payment_reference_number: prepareData.payment_reference_number,
    payment_currency: prepareData.payment_currency,

    amount_paid_after_cents: prepareData.amount_paid_after_cents,
    balance_remaining_after_cents: prepareData.balance_remaining_after_cents,

    invoice_id: prepareData.invoice_id,
    invoice_number: prepareData.invoice_number,
    invoice_total_cents: prepareData.invoice_total_cents,
    invoice_issued_at: prepareData.invoice_issued_at,
    invoice_currency: prepareData.invoice_currency,

    billing_name: prepareData.billing_name,
    billing_contact_name: prepareData.billing_contact_name,
    billing_address_line1: prepareData.billing_address_line1,
    billing_address_line2: prepareData.billing_address_line2,
    billing_city: prepareData.billing_city,
    billing_state: prepareData.billing_state,
    billing_postal_code: prepareData.billing_postal_code,
    billing_country: prepareData.billing_country,
  };

  let pdfBytes: Uint8Array;

  try {
    pdfBytes = await renderReceiptPdf(renderInput);
  } catch (err) {
    if (err instanceof ReceiptPdfError) {
      console.error('[receiptPdfOrchestrator] renderer failed:', {
        paymentId,
        rendererCode: err.code,
      });
    } else {
      console.error('[receiptPdfOrchestrator] renderer threw unexpected error:', { paymentId });
    }
    throw new ReceiptOrchestratorError(
      'receipt_render_failed',
      'Receipt PDF renderer failed.',
    );
  }

  // ── STEP C: HASH ─────────────────────────────────────────────────────────
  // Compute SHA-256 of the exact PDF bytes.
  // Lowercase 64-character hex.

  const pdfHash = sha256Hex(pdfBytes);

  // ── STEP D: CANONICAL PATH ───────────────────────────────────────────────
  // Derived exclusively from PREPARE response / trusted DB-derived values.
  // Never accept storage path from browser/caller.

  const canonicalPath = buildCanonicalPath(
    prepareData.application_id,
    prepareData.invoice_id,
    prepareData.payment_id,
  );

  // ── STEP E: STORAGE CHECK ────────────────────────────────────────────────
  // Check whether the canonical object already exists in the private bucket.

  let storageCheck: StorageCheckResult;

  try {
    storageCheck = await checkAndDownloadExistingObject(
      prepareData.application_id,
      prepareData.invoice_id,
      prepareData.payment_id,
      canonicalPath,
    );
  } catch (err) {
    if (err instanceof ReceiptOrchestratorError) throw err;
    console.error('[receiptPdfOrchestrator] storage check threw unexpected error:', { paymentId });
    throw new ReceiptOrchestratorError(
      'receipt_upload_failed',
      'Unexpected error during storage existence check.',
    );
  }

  if (storageCheck.exists) {
    // Object already exists — validate and compare hashes
    const existingBytes = storageCheck.bytes;

    try {
      validatePdfMagic(existingBytes);
    } catch (err) {
      if (err instanceof ReceiptOrchestratorError) throw err;
      throw new ReceiptOrchestratorError(
        'receipt_upload_failed',
        'Existing storage object failed PDF validation.',
      );
    }

    const existingHash = sha256Hex(existingBytes);

    if (existingHash === pdfHash) {
      // Same hash — reuse existing object, proceed to COMPLETE.
      // Do NOT overwrite.
      console.info('[receiptPdfOrchestrator] existing object hash matches, reusing:', { paymentId });
    } else {
      // Different hash — STOP. Never overwrite an existing receipt object.
      console.error('[receiptPdfOrchestrator] existing object hash DIFFERS from deterministic render:', {
        paymentId,
      });
      throw new ReceiptOrchestratorError(
        'receipt_storage_conflict',
        'Existing receipt storage object hash differs from deterministic render. '+ 'Cannot overwrite. Manual investigation required.',
      );
    }
  } else {
    // Object does not exist — upload with upsert:false
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(canonicalPath, pdfBytes, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadError) {
      console.error('[receiptPdfOrchestrator] upload failed:', {
        paymentId,
        statusCode: (uploadError as { statusCode?: string }).statusCode ?? 'unknown',
      });
      throw new ReceiptOrchestratorError(
        'receipt_upload_failed',
        'Receipt PDF upload failed.',
      );
    }
  }

  // ── STEP F: COMPLETE ─────────────────────────────────────────────────────
  // Call complete_receipt_generation with only: payment_id, admin_user_id, pdf_hash.
  // The RPC derives canonical path and generated_at internally.
  // Do NOT supply receipt_number, storage_path, or generated_at.

  let completeData: CompleteReceiptResponse;

  try {
    const { data, error } = await supabase.rpc('complete_receipt_generation', {
      p_payment_id: paymentId,
      p_admin_user_id: adminUserId,
      p_pdf_hash: pdfHash,
    });

    if (error) {
      console.error('[receiptPdfOrchestrator] complete_receipt_generation failed:', {
        paymentId,
        code: (error as { code?: string }).code ?? 'unknown',
      });
      throw new ReceiptOrchestratorError(
        'receipt_complete_failed',
        'complete_receipt_generation RPC failed.',
      );
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ReceiptOrchestratorError(
        'receipt_complete_failed',
        'complete_receipt_generation returned unexpected response shape.',
      );
    }

    completeData = data as CompleteReceiptResponse;
  } catch (err) {
    if (err instanceof ReceiptOrchestratorError) throw err;
    console.error('[receiptPdfOrchestrator] complete_receipt_generation threw:', { paymentId });
    throw new ReceiptOrchestratorError(
      'receipt_complete_failed',
      'complete_receipt_generation threw an unexpected error.',
    );
  }

  // Return safe completion data only
  // payment_id and invoice_id come from prepareData (authoritative source).
  // generated_at comes from the COMPLETE RPC response.
  // Do not trust caller-supplied IDs.
  return {
    success: true,
    already_complete: completeData.already_complete === true,
    receipt_number: completeData.receipt_number,
    receipt_issued_at: completeData.receipt_issued_at,
    generated_at: completeData.generated_at ?? null,
    payment_id: prepareData.payment_id,
    invoice_id: prepareData.invoice_id,
  };
}
