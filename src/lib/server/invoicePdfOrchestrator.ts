/**
 * src/lib/server/invoicePdfOrchestrator.ts
 *
 * Step: 6A-5C4A — Server-Only PDF Storage + Completion Orchestrator
 * Amended: 6A-5C4A.1 — Orchestrator Completion Contract + Storage Error Hardening
 *
 * SERVER-ONLY. Must never be imported into a Client Component bundle.
 *
 * PURPOSE
 * -------
 * Handles the PDF generation, storage, and completion lifecycle for an invoice
 * that is ALREADY in status = 'issuing'. This helper does NOT call
 * begin_invoice_issuance() — that remains the responsibility of the Issue API.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * 1. Loads the immutable invoice snapshot and line items via service_role.
 * 2. Validates orchestration preconditions (status, invoice_number, etc.).
 * 3. Derives the deterministic storage path.
 * 4. Checks whether the PDF object already exists in storage using a narrow
 *    folder list (not HTTP 400 detection).
 *    - If it exists: downloads, validates (magic bytes + non-zero size),
 *      hashes the exact downloaded bytes, and calls complete_invoice_issuance.
 *    - If it does not exist: renders a new PDF, uploads with upsert:false,
 *      hashes the exact uploaded bytes, and calls complete_invoice_issuance.
 * 5. Handles upload races: if upload fails due to a concurrent upload, attempts
 *    to download the now-existing object and reuse it.
 * 6. Handles concurrent completion: if complete_invoice_issuance returns
 *    invoice_not_issuing, re-fetches the invoice and verifies it is already
 *    open with the same deterministic path and matching hash.
 * 7. Reconciles unknown/uncertain completion results before deciding to mark
 *    failed — never marks an already-open invoice as failed.
 * 8. Returns a safe success payload (no wire data, no storage path, no hash).
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * - Does NOT call begin_invoice_issuance()
 * - Does NOT expose service_role to browser code
 * - Does NOT log wire snapshot, routing/account numbers, billing email,
 *   invoice notes, or PDF bytes
 * - Does NOT return wire_instructions_snapshot, pdf_storage_path, pdf_hash,
 *   routing/account numbers, or PDF bytes to callers
 * - Does NOT modify src/app/api/admin/invoices/[id]/issue/route.ts
 * - Does NOT create any browser-facing routes
 *
 * STORAGE EXISTENCE MECHANISM (6A-5C4A.1 hardened)
 * --------------------------------------------------
 * Instead of treating HTTP 400 as "object not found" (too broad), we use a
 * narrow server-side list of the deterministic folder:
 *
 *   invoices/{application_id}/{invoice_id}/
 *
 * and check for the exact filename: {invoice_number}.pdf
 *
 * Procedure:
 *   1. supabase.storage.from(bucket).list(folder, { search: filename })
 *      - list error            → storage failure (throw)
 *      - exact filename found  → object exists; download and validate
 *      - exact filename absent → object does not exist
 *   2. If the object is found via list, download it for byte validation.
 *      The download step uses structured statusCode for genuine failures.
 *   3. We do NOT rely on HTTP 400 to mean "missing".
 *   4. We do NOT use raw error.message substring matching.
 *
 * COMPLETE RPC SUCCESS CONTRACT (6A-5C4A.1 hardened)
 * ---------------------------------------------------
 * After complete_invoice_issuance succeeds, the returned row is strictly
 * validated. No ?? fallbacks are used. Required:
 *   row is a non-array object
 *   row.invoice_id === invoiceId
 *   row.invoice_number is a non-empty string === originalSnapshot.invoice_number
 *   row.status === 'open'
 *   row.issued_at is a non-empty string that parses as a valid timestamp
 *   row.pdf_generation_status === 'generated'
 *   row.total_cents is a safe integer
 * If any field is missing/malformed: reconcile DB state before deciding.
 *
 * UNKNOWN / UNCERTAIN COMPLETION RESULTS (6A-5C4A.1 hardened)
 * ------------------------------------------------------------
 * Unknown errors from complete_invoice_issuance and malformed success
 * responses are reconciled against the DB before marking failed.
 * The invoice may have committed successfully even if the caller received
 * a network/transport/timeout error. We re-fetch and verify before acting.
 *
 * SAFE INTERNAL ERROR CODES
 * -------------------------
 * INVOICE_PDF_INVOICE_NOT_FOUND   — invoice row does not exist
 * INVOICE_PDF_INVALID_STATE       — precondition not met (wrong status, etc.)
 * INVOICE_PDF_SNAPSHOT_ERROR      — failed to load snapshot or line items
 * INVOICE_PDF_RENDER_FAILED       — renderer threw InvoicePdfError
 * INVOICE_PDF_STORAGE_FAILED      — storage read/write failure
 * INVOICE_PDF_COMPLETION_FAILED   — complete_invoice_issuance failed (non-concurrent)
 *
 * SAFE SUCCESS PAYLOAD
 * --------------------
 * { invoice_id, invoice_number, status, issued_at, pdf_generation_status, total_cents }
 * No wire data, no storage path, no hash, no PDF bytes.
 *
 * SCOPE EXCLUSIONS
 * ----------------
 * - begin_invoice_issuance() is NOT called here
 * - Issue API route is NOT modified
 * - No browser route is created
 * - No real invoice is queried or mutated during testing/build
 * - No migration is created
 * - No Supabase deployment is required for this file
 *
 * REVISION SUPPORT (6A-5R4C1)
 * ----------------------------
 * revision_source_invoice_id is the authoritative field for determining whether
 * an issuing invoice is a Revision. If non-null, the invoice is a Revision and
 * complete_revision_invoice_issuance() is called instead of
 * complete_invoice_issuance(). Normal invoice behavior is fully preserved.
 *
 * revision_source_invoice_id and replaces_invoice_id are loaded into the
 * server-side snapshot for lifecycle routing only. They are NOT returned to
 * callers in OrchestratorSuccessResult.
 */

import 'server-only';

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

import {
  renderInvoicePdf,
  InvoicePdfError,
  InvoicePdfInput,
  InvoiceLineItem,
  WireSnapshot,
} from './invoicePdf';

// ---------------------------------------------------------------------------
// Safe orchestrator error codes
// ---------------------------------------------------------------------------

export type OrchestratorErrorCode =
  | 'INVOICE_PDF_INVOICE_NOT_FOUND' |'INVOICE_PDF_INVALID_STATE' |'INVOICE_PDF_SNAPSHOT_ERROR' |'INVOICE_PDF_RENDER_FAILED' |'INVOICE_PDF_STORAGE_FAILED' |'INVOICE_PDF_COMPLETION_FAILED';

export class InvoicePdfOrchestratorError extends Error {
  public readonly code: OrchestratorErrorCode;

  constructor(code: OrchestratorErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'InvoicePdfOrchestratorError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Safe success result
// ---------------------------------------------------------------------------

export interface OrchestratorSuccessResult {
  invoice_id: string;
  invoice_number: string;
  status: string;            // expected: 'open'
  issued_at: string | null;
  pdf_generation_status: string; // expected: 'generated'
  total_cents: number;
}

// ---------------------------------------------------------------------------
// Allowed PDF failure codes (whitelisted for mark_invoice_pdf_failed RPC)
// ---------------------------------------------------------------------------

type PdfFailureCode =
  | 'pdf_generation_failed' |'pdf_upload_failed' |'pdf_storage_read_failed' |'pdf_completion_failed';

// ---------------------------------------------------------------------------
// Invoice snapshot shape (explicit projection from crm_invoices)
// ---------------------------------------------------------------------------

interface InvoiceSnapshot {
  id: string;
  application_id: string;
  invoice_number: string;
  status: string;
  currency: string;

  issuing_started_at: string;
  issued_at: string | null;

  billing_name: string | null;
  billing_contact_name: string | null;
  billing_email: string;
  billing_address_line1: string | null;
  billing_address_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_postal_code: string | null;
  billing_country: string | null;

  emd_funded_cents: number;
  funding_date: string;
  period_start_date: string;
  period_end_date: string;
  billable_days: number;

  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;

  credit_card_payment_enabled_snapshot: boolean;
  wire_instructions_snapshot: WireSnapshot;
  due_date: string;
  invoice_notes: string | null;

  pdf_generation_status: string;
  pdf_storage_path: string | null;
  pdf_hash: string | null;

  /**
   * Server-side only — used to determine revision vs normal lifecycle.
   * Non-null means this is a Revision invoice.
   * NOT returned to callers in OrchestratorSuccessResult.
   */
  revision_source_invoice_id: string | null;

  /**
   * Server-side only — used to guard against double-completion of a Revision.
   * Must be null for an issuing Revision; if already set, fail closed.
   * NOT returned to callers in OrchestratorSuccessResult.
   */
  replaces_invoice_id: string | null;
}

// ---------------------------------------------------------------------------
// Line item shape (explicit projection from crm_invoice_line_items)
// ---------------------------------------------------------------------------

interface LineItemRow {
  line_type: string;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  line_amount_cents: number;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// Service-role Supabase client (server-side only)
// Never exposed to browser code.
// ---------------------------------------------------------------------------

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_SNAPSHOT_ERROR',
      'Supabase service configuration is missing.',
    );
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Deterministic storage path
// Format: invoices/{application_id}/{invoice_id}/{invoice_number}.pdf
// Bucket: invoice-pdfs
// This must match the path enforced by complete_invoice_issuance().
// ---------------------------------------------------------------------------

const STORAGE_BUCKET = 'invoice-pdfs';

function buildStoragePath(
  applicationId: string,
  invoiceId: string,
  invoiceNumber: string,
): string {
  return `invoices/${applicationId}/${invoiceId}/${invoiceNumber}.pdf`;
}

/**
 * Derives the narrow folder prefix for list-based existence checks.
 * Format: invoices/{application_id}/{invoice_id}
 */
function buildStorageFolder(applicationId: string, invoiceId: string): string {
  return `invoices/${applicationId}/${invoiceId}`;
}

// ---------------------------------------------------------------------------
// SHA-256 helper — lowercase 64-character hex
// Hashes the EXACT bytes (Uint8Array or Buffer).
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// PDF magic bytes validation (%PDF-)
// Requires non-zero size and correct magic prefix.
// ---------------------------------------------------------------------------

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

function validatePdfMagic(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_STORAGE_FAILED',
      'Existing storage object has zero size.',
    );
  }
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) {
      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_STORAGE_FAILED',
        'Existing storage object does not begin with PDF magic bytes.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Storage existence check via narrow folder list (6A-5C4A.1 hardened)
//
// Previous approach treated HTTP 400 as "object not found" — too broad.
// This approach uses a narrow server-side list of the deterministic folder
// and checks for the exact filename. This cleanly distinguishes:
//
//   OBJECT DEFINITELY DOES NOT EXIST  — list succeeds, filename absent
//   OBJECT EXISTS                     — list succeeds, exact filename present
//   STORAGE FAILURE                   — list returns an error
//
// We do NOT rely on HTTP 400 to mean "missing".
// We do NOT use raw error.message substring matching.
//
// After confirming existence via list, we download the object for byte
// validation. The download step uses structured statusCode for genuine
// failures only — it is not used to detect "not found" (list already did that).
//
// Returns:
//   { exists: true,  bytes: Uint8Array }  — object found, downloaded, ready
//   { exists: false, bytes: null }        — object definitely does not exist
//
// Throws InvoicePdfOrchestratorError(INVOICE_PDF_STORAGE_FAILED) on:
//   - list error (storage failure)
//   - download error after confirmed existence (storage failure)
// ---------------------------------------------------------------------------

interface StorageCheckResult {
  exists: true;
  bytes: Uint8Array;
}

interface StorageMissingResult {
  exists: false;
  bytes: null;
}

type StorageExistenceResult = StorageCheckResult | StorageMissingResult;

async function checkAndDownloadExistingObject(
  applicationId: string,
  invoiceId: string,
  invoiceNumber: string,
  storagePath: string,
): Promise<StorageExistenceResult> {
  const supabase = getServiceClient();
  const folder = buildStorageFolder(applicationId, invoiceId);
  const exactFilename = `${invoiceNumber}.pdf`;

  // ── Step A: Narrow folder list to determine existence ───────────────────
  // We list only the deterministic folder and search for the exact filename.
  // A list error is a genuine storage failure — not a "not found" signal.

  const { data: listData, error: listError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(folder, { search: exactFilename });

  if (listError) {
    // List failed — genuine storage failure. Log only safe identifiers.
    console.error('[invoicePdfOrchestrator] storage list failure:', {
      code: (listError as { statusCode?: string }).statusCode ?? 'unknown',
    });
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_STORAGE_FAILED',
      'Storage list failed when checking for existing object.',
    );
  }

  // Check for exact filename match (do not rely on fuzzy search result alone).
  const exactMatch = (listData ?? []).find(
    (item) => item.name === exactFilename,
  );

  if (!exactMatch) {
    // Object definitely does not exist.
    return { exists: false, bytes: null };
  }

  // ── Step B: Object confirmed present — download for byte validation ──────
  // We know the object exists from the list result. Download it for magic
  // byte validation and hashing. A download error here is a genuine failure.

  const { data: downloadData, error: downloadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(storagePath);

  if (downloadError || !downloadData) {
    // Download failed after confirmed existence — genuine storage failure.
    console.error('[invoicePdfOrchestrator] storage download failure after list confirmed existence:', {
      statusCode: (downloadError as { statusCode?: string } | null)?.statusCode ?? 'unknown',
    });
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_STORAGE_FAILED',
      'Storage download failed after list confirmed object existence.',
    );
  }

  // Convert Blob to Uint8Array
  const arrayBuffer = await downloadData.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  return { exists: true, bytes };
}

// ---------------------------------------------------------------------------
// Download-only helper for race recovery
//
// Used after an upload failure to check if a concurrent request succeeded.
// Uses structured statusCode to detect genuine failures.
// Does NOT treat HTTP 400 as "not found" — only 404 is treated as missing.
// ---------------------------------------------------------------------------

async function downloadForRaceRecovery(
  storagePath: string,
): Promise<StorageExistenceResult> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(storagePath);

  if (error) {
    const sc = (error as { statusCode?: string }).statusCode;

    if (sc === '404') {
      // Object does not exist.
      return { exists: false, bytes: null };
    }

    // Genuine failure (auth, network, server error, etc.)
    console.error('[invoicePdfOrchestrator] race recovery download failure:', {
      statusCode: sc ?? 'unknown',
    });

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_STORAGE_FAILED',
      'Race recovery download failed with a non-404 error.',
    );
  }

  if (!data) {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_STORAGE_FAILED',
      'Race recovery download returned no data and no error.',
    );
  }

  const arrayBuffer = await data.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  return { exists: true, bytes };
}

// ---------------------------------------------------------------------------
// Whitelisted stable tokens for mark_invoice_pdf_failed RPC responses
// ---------------------------------------------------------------------------

const MARK_FAILED_KNOWN_TOKENS = new Set([
  'admin_not_authorized',
  'invoice_not_found',
  'invoice_not_issuing',
  'invoice_pdf_state_invalid',
  'invoice_pdf_failure_code_invalid',
]);

// ---------------------------------------------------------------------------
// Best-effort failure marking helper (6A-5C4A.1 hardened)
//
// Only called while the invoice is still in 'issuing' status.
// Never called on an already-open invoice.
// Never passes arbitrary exception text — only whitelisted failure codes.
// Never logs wire data, billing email, routing/account numbers, or PDF bytes.
//
// Raw error.message is NEVER logged. Only whitelisted stable tokens are
// logged. For unknown errors, only safe fields (invoiceId, failureCode,
// error.code) are logged.
// ---------------------------------------------------------------------------

async function bestEffortMarkFailed(
  invoiceId: string,
  adminUserId: string,
  failureCode: PdfFailureCode,
): Promise<void> {
  try {
    const supabase = getServiceClient();

    const { error } = await supabase.rpc('mark_invoice_pdf_failed', {
      p_invoice_id: invoiceId,
      p_admin_user_id: adminUserId,
      p_failure_code: failureCode,
    });

    if (error) {
      // Inspect error.code (structured) — never log raw error.message.
      const errorCode = (error as { code?: string }).code ?? 'unknown';

      // Only log the message if it exactly matches a known stable token.
      const rawMessage = (error as { message?: string }).message?.trim() ?? '';
      if (MARK_FAILED_KNOWN_TOKENS.has(rawMessage)) {
        console.error('[invoicePdfOrchestrator] mark_invoice_pdf_failed known error:', {
          invoiceId,
          failureCode,
          token: rawMessage,
        });
      } else {
        // Unknown error — log only safe fields, never log error.message.
        console.error('[invoicePdfOrchestrator] mark_invoice_pdf_failed unknown error:', {
          invoiceId,
          failureCode,
          code: errorCode,
        });
      }
    }
  } catch {
    // Failure marking itself failed — do not expose raw details.
    console.error('[invoicePdfOrchestrator] mark_invoice_pdf_failed threw:', {
      invoiceId,
      failureCode,
    });
  }
}

// ---------------------------------------------------------------------------
// RPC error token map for complete_invoice_issuance
// ---------------------------------------------------------------------------

const COMPLETE_RPC_ERROR_TOKENS = new Set([
  'admin_not_authorized',
  'invoice_not_found',
  'invoice_not_issuing',
  'invoice_pdf_state_invalid',
  'invoice_pdf_metadata_invalid',
]);

// ---------------------------------------------------------------------------
// RPC error token map for complete_revision_invoice_issuance
// Separate from normal completion tokens — do NOT mix.
// ---------------------------------------------------------------------------

const COMPLETE_REVISION_RPC_ERROR_TOKENS = new Set([
  'admin_not_authorized',
  'revision_invoice_not_found',
  'revision_invoice_not_issuing',
  'revision_source_ineligible',
  'revision_number_relationship_invalid',
  'revision_pdf_state_invalid',
  'revision_pdf_metadata_invalid',
]);

// ---------------------------------------------------------------------------
// Main orchestrator function
//
// Handles an invoice ALREADY in status = 'issuing'.
// Does NOT call begin_invoice_issuance().
// ---------------------------------------------------------------------------

export async function continueInvoicePdfIssuance(
  invoiceId: string,
  adminUserId: string,
): Promise<OrchestratorSuccessResult> {
  // ── STEP 1: Load immutable invoice snapshot ─────────────────────────────
  // Explicit column projection — do NOT fetch live crm_companies,
  // crm_contacts, or crm_invoice_settings. The immutable snapshot is
  // authoritative.

  const supabase = getServiceClient();

  const { data: invoiceData, error: invoiceError } = await supabase
    .from('crm_invoices')
    .select(
      [
        'id',
        'application_id',
        'invoice_number',
        'status',
        'currency',
        'issuing_started_at',
        'issued_at',
        'billing_name',
        'billing_contact_name',
        'billing_email',
        'billing_address_line1',
        'billing_address_line2',
        'billing_city',
        'billing_state',
        'billing_postal_code',
        'billing_country',
        'emd_funded_cents',
        'funding_date',
        'period_start_date',
        'period_end_date',
        'billable_days',
        'subtotal_cents',
        'discount_cents',
        'tax_cents',
        'total_cents',
        'credit_card_payment_enabled_snapshot',
        'wire_instructions_snapshot',
        'due_date',
        'invoice_notes',
        'pdf_generation_status',
        'pdf_storage_path',
        'pdf_hash',
        'revision_source_invoice_id',
        'replaces_invoice_id',
      ].join(','),
    )
    .eq('id', invoiceId)
    .single();

  if (invoiceError || !invoiceData) {
    // Log only safe identifiers — never log raw Supabase error details.
    console.error('[invoicePdfOrchestrator] invoice snapshot load error:', {
      invoiceId,
      code: (invoiceError as { code?: string } | null)?.code ?? 'unknown',
    });

    if (
      (invoiceError as { code?: string } | null)?.code === 'PGRST116' ||
      !invoiceData
    ) {
      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_INVOICE_NOT_FOUND',
        'Invoice not found.',
      );
    }

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_SNAPSHOT_ERROR',
      'Failed to load invoice snapshot.',
    );
  }

  const invoice = invoiceData as InvoiceSnapshot;

  // ── STEP 2: Orchestration preconditions ─────────────────────────────────
  // Fail safely unless all preconditions are met.
  // Do NOT operate on draft, open, partially_paid, paid, or void invoices.

  if (invoice.status !== 'issuing') {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_INVALID_STATE',
      `Invoice status is '${invoice.status}'; orchestrator requires 'issuing'.`,
    );
  }

  if (!invoice.invoice_number || invoice.invoice_number.trim() === '') {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_INVALID_STATE',
      'Invoice number is missing or empty.',
    );
  }

  if (!invoice.application_id) {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_INVALID_STATE',
      'Invoice application_id is missing.',
    );
  }

  if (!invoice.issuing_started_at) {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_INVALID_STATE',
      'Invoice issuing_started_at is missing.',
    );
  }

  if (invoice.issued_at !== null) {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_INVALID_STATE',
      'Invoice issued_at is already set; invoice may already be open.',
    );
  }

  if (
    invoice.pdf_generation_status !== 'pending' &&
    invoice.pdf_generation_status !== 'failed'
  ) {
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_INVALID_STATE',
      `Invoice pdf_generation_status is '${invoice.pdf_generation_status}'; expected 'pending' or 'failed'.`,
    );
  }

  // ── STEP 2B: Revision mode detection ────────────────────────────────────
  // revision_source_invoice_id is authoritative.
  // Do NOT infer revision status from invoice_number suffix, invoice_type,
  // or replaces_invoice_id alone.

  const isRevision = invoice.revision_source_invoice_id !== null;

  if (isRevision) {
    // A Revision that is still issuing must NOT already have replaces_invoice_id
    // set. If it does, the invoice is in an unexpected state — fail closed.
    if (invoice.replaces_invoice_id !== null) {
      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_INVALID_STATE',
        'Revision invoice is issuing but replaces_invoice_id is already populated; invalid state.',
      );
    }
  }

  // ── STEP 3: Load line items ──────────────────────────────────────────────
  // Explicit projection — only render-relevant fields.
  // Sort by sort_order ASC with stable secondary ordering.

  const { data: lineItemsData, error: lineItemsError } = await supabase
    .from('crm_invoice_line_items')
    .select('line_type,description,quantity,unit_amount_cents,line_amount_cents,sort_order')
    .eq('invoice_id', invoiceId)
    .order('sort_order', { ascending: true })
    .order('description', { ascending: true }); // stable secondary

  if (lineItemsError) {
    console.error('[invoicePdfOrchestrator] line items load error:', {
      invoiceId,
      code: (lineItemsError as { code?: string }).code ?? 'unknown',
    });

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_SNAPSHOT_ERROR',
      'Failed to load invoice line items.',
    );
  }

  const lineItems: LineItemRow[] = (lineItemsData ?? []) as LineItemRow[];

  // ── STEP 4: Derive deterministic storage path ────────────────────────────
  // Never accept a caller-provided storage path.
  // Must match the path enforced by complete_invoice_issuance().

  const storagePath = buildStoragePath(
    invoice.application_id,
    invoice.id,
    invoice.invoice_number,
  );

  // ── STEP 5: Check for existing storage object ────────────────────────────
  // Use narrow folder list approach (see module header for rationale).
  // If the object already exists: validate, hash, and complete without
  // re-rendering or overwriting.

  let existenceResult: StorageExistenceResult;

  try {
    existenceResult = await checkAndDownloadExistingObject(
      invoice.application_id,
      invoice.id,
      invoice.invoice_number,
      storagePath,
    );
  } catch (err) {
    if (err instanceof InvoicePdfOrchestratorError) {
      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_storage_read_failed');
      throw err;
    }
    await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_storage_read_failed');
    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_STORAGE_FAILED',
      'Unexpected error during storage existence check.',
    );
  }

  // ── STEP 6A: Existing object path ───────────────────────────────────────
  // If the deterministic PDF object already exists while the invoice is still
  // issuing: DO NOT regenerate and overwrite it.
  // Download, validate, hash the exact downloaded bytes, then complete.

  if (existenceResult.exists) {
    const existingBytes = existenceResult.bytes;

    // Validate: non-zero size + PDF magic bytes
    try {
      validatePdfMagic(existingBytes);
    } catch (err) {
      if (err instanceof InvoicePdfOrchestratorError) {
        await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_storage_read_failed');
        throw err;
      }
      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_storage_read_failed');
      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_STORAGE_FAILED',
        'Existing storage object failed validation.',
      );
    }

    // Hash the exact downloaded bytes — these are authoritative.
    const existingHash = sha256Hex(existingBytes);

    // Complete issuance using the existing object.
    return await callCompleteIssuance(
      invoiceId,
      adminUserId,
      storagePath,
      existingHash,
      invoice,
      isRevision,
    );
  }

  // ── STEP 6B: New PDF path ────────────────────────────────────────────────
  // No object exists — render a new PDF.

  // Build InvoicePdfInput exclusively from the immutable snapshot + line items.
  // Do NOT re-read crm_companies, crm_contacts, or crm_invoice_settings.

  const renderInput: InvoicePdfInput = {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    application_id: invoice.application_id,
    currency: invoice.currency,

    issuing_started_at: invoice.issuing_started_at,
    due_date: invoice.due_date,

    billing_name: invoice.billing_name,
    billing_contact_name: invoice.billing_contact_name,
    billing_email: invoice.billing_email,
    billing_address_line1: invoice.billing_address_line1,
    billing_address_line2: invoice.billing_address_line2,
    billing_city: invoice.billing_city,
    billing_state: invoice.billing_state,
    billing_postal_code: invoice.billing_postal_code,
    billing_country: invoice.billing_country,

    emd_funded_cents: invoice.emd_funded_cents,
    funding_date: invoice.funding_date,
    period_start_date: invoice.period_start_date,
    period_end_date: invoice.period_end_date,
    billable_days: invoice.billable_days,

    subtotal_cents: invoice.subtotal_cents,
    discount_cents: invoice.discount_cents,
    tax_cents: invoice.tax_cents,
    total_cents: invoice.total_cents,

    credit_card_payment_enabled_snapshot: invoice.credit_card_payment_enabled_snapshot,
    invoice_notes: invoice.invoice_notes,

    wire_snapshot: invoice.wire_instructions_snapshot,

    line_items: lineItems.map(
      (li): InvoiceLineItem => ({
        line_type: li.line_type,
        description: li.description,
        quantity: li.quantity,
        unit_amount_cents: li.unit_amount_cents,
        line_amount_cents: li.line_amount_cents,
        sort_order: li.sort_order,
      }),
    ),
  };

  // Render PDF — do NOT log render input.
  let pdfBytes: Uint8Array;

  try {
    pdfBytes = await renderInvoicePdf(renderInput);
  } catch (err) {
    // Map renderer failure to pdf_generation_failed.
    // Do NOT store the renderer's message in the database.
    // Do NOT expose or log sensitive render input.
    if (err instanceof InvoicePdfError) {
      console.error('[invoicePdfOrchestrator] renderer failed:', {
        invoiceId,
        rendererCode: err.code,
      });
    } else {
      console.error('[invoicePdfOrchestrator] renderer threw unexpected error:', {
        invoiceId,
      });
    }

    await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_generation_failed');

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_RENDER_FAILED',
      'PDF renderer failed.',
    );
  }

  // Hash the exact bytes that will be uploaded.
  const newHash = sha256Hex(pdfBytes);

  // ── STEP 7: Upload with upsert:false ─────────────────────────────────────
  // NEVER upsert:true. Do not overwrite an existing invoice PDF.

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdfBytes, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    // ── STEP 7A: Upload race recovery ──────────────────────────────────────
    // A concurrent request may have uploaded first.
    // Do NOT immediately mark failed — attempt to download the now-existing
    // object and reuse it.

    console.error('[invoicePdfOrchestrator] upload failed, attempting race recovery:', {
      invoiceId,
      statusCode: (uploadError as { statusCode?: string }).statusCode ?? 'unknown',
    });

    let raceResult: StorageExistenceResult;

    try {
      raceResult = await downloadForRaceRecovery(storagePath);
    } catch {
      // Cannot retrieve the object after upload failure.
      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_upload_failed');
      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_STORAGE_FAILED',
        'Upload failed and race recovery download also failed.',
      );
    }

    if (!raceResult.exists) {
      // Object still does not exist after upload failure — genuine failure.
      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_upload_failed');
      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_STORAGE_FAILED',
        'Upload failed and object does not exist after race recovery attempt.',
      );
    }

    // Object now exists — validate and use it as the authoritative object.
    const raceBytes = raceResult.bytes;

    try {
      validatePdfMagic(raceBytes);
    } catch {
      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_upload_failed');
      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_STORAGE_FAILED',
        'Race-recovered object failed PDF validation.',
      );
    }

    // Hash the exact downloaded bytes — these are authoritative.
    const raceHash = sha256Hex(raceBytes);

    return await callCompleteIssuance(
      invoiceId,
      adminUserId,
      storagePath,
      raceHash,
      invoice,
      isRevision,
    );
  }

  // ── STEP 8: Complete issuance after successful new upload ─────────────────
  return await callCompleteIssuance(
    invoiceId,
    adminUserId,
    storagePath,
    newHash,
    invoice,
    isRevision,
  );
}

// ---------------------------------------------------------------------------
// validateCompleteRpcRow — strictly validates the complete_invoice_issuance
// success response (6A-5C4A.1 hardened).
//
// Requires:
//   row is a non-array object
//   row.invoice_id === invoiceId
//   row.invoice_number is a non-empty string === originalSnapshot.invoice_number
//   row.status === 'open'
//   row.issued_at is a non-empty string that parses as a valid timestamp
//   row.pdf_generation_status === 'generated'
//   row.total_cents is a safe integer
//
// Returns the validated safe result, or throws if validation fails.
// Does NOT use ?? fallbacks. Does NOT expose the raw row.
// ---------------------------------------------------------------------------

function validateCompleteRpcRow(
  row: unknown,
  invoiceId: string,
  originalSnapshot: InvoiceSnapshot,
): OrchestratorSuccessResult {
  // Must be a non-null, non-array object.
  if (
    row === null ||
    row === undefined ||
    typeof row !== 'object' ||
    Array.isArray(row)
  ) {
    throw new Error('RPC row is not a non-array object');
  }

  const r = row as Record<string, unknown>;

  // invoice_id must match.
  if (r.invoice_id !== invoiceId) {
    throw new Error('RPC row invoice_id mismatch');
  }

  // invoice_number must be a non-empty string matching the snapshot.
  if (
    typeof r.invoice_number !== 'string' ||
    r.invoice_number.trim() === '' ||
    r.invoice_number !== originalSnapshot.invoice_number
  ) {
    throw new Error('RPC row invoice_number invalid or mismatched');
  }

  // status must be exactly 'open'.
  if (r.status !== 'open') {
    throw new Error('RPC row status is not open');
  }

  // issued_at must be a non-empty string that parses as a valid timestamp.
  if (
    typeof r.issued_at !== 'string' ||
    r.issued_at.trim() === '' ||
    isNaN(new Date(r.issued_at).getTime())
  ) {
    throw new Error('RPC row issued_at is missing or invalid');
  }

  // pdf_generation_status must be exactly 'generated'.
  if (r.pdf_generation_status !== 'generated') {
    throw new Error('RPC row pdf_generation_status is not generated');
  }

  // total_cents must be a safe integer.
  if (!Number.isSafeInteger(r.total_cents)) {
    throw new Error('RPC row total_cents is not a safe integer');
  }

  return {
    invoice_id: invoiceId,
    invoice_number: r.invoice_number,
    status: r.status,
    issued_at: r.issued_at,
    pdf_generation_status: r.pdf_generation_status,
    total_cents: r.total_cents as number,
  };
}

// ---------------------------------------------------------------------------
// validateRevisionCompleteRpcRow — strictly validates the
// complete_revision_invoice_issuance success response (6A-5R4C1).
//
// Requires:
//   row is a non-array object
//   row.invoice_id === invoiceId
//   row.invoice_number === originalSnapshot.invoice_number (non-empty)
//   row.status === 'open'
//   row.revision_source_invoice_id === originalSnapshot.revision_source_invoice_id
//   row.replaces_invoice_id === originalSnapshot.revision_source_invoice_id
//   row.source_invoice_id === originalSnapshot.revision_source_invoice_id
//   row.source_status === 'void'
//   row.issued_at is a non-empty valid timestamp string
//   row.pdf_generated_at is a non-empty valid timestamp string
//   row.pdf_generation_status === 'generated'
//   row.total_cents is a safe integer
//   row.source_invoice_number is a non-empty string
//
// Returns the validated safe result, or throws if validation fails.
// Does NOT use ?? fallbacks. Does NOT fabricate missing values.
// ---------------------------------------------------------------------------

function validateRevisionCompleteRpcRow(
  row: unknown,
  invoiceId: string,
  originalSnapshot: InvoiceSnapshot,
): OrchestratorSuccessResult {
  // Must be a non-null, non-array object.
  if (
    row === null ||
    row === undefined ||
    typeof row !== 'object' ||
    Array.isArray(row)
  ) {
    throw new Error('Revision RPC row is not a non-array object');
  }

  const r = row as Record<string, unknown>;

  // invoice_id must match the requested invoiceId.
  if (r.invoice_id !== invoiceId) {
    throw new Error('Revision RPC row invoice_id mismatch');
  }

  // invoice_number must be a non-empty string matching the original immutable snapshot.
  if (
    typeof r.invoice_number !== 'string' ||
    r.invoice_number.trim() === '' ||
    r.invoice_number !== originalSnapshot.invoice_number
  ) {
    throw new Error('Revision RPC row invoice_number invalid or mismatched');
  }

  // status must be exactly 'open'.
  if (r.status !== 'open') {
    throw new Error('Revision RPC row status is not open');
  }

  // revision_source_invoice_id must match the original snapshot value.
  if (r.revision_source_invoice_id !== originalSnapshot.revision_source_invoice_id) {
    throw new Error('Revision RPC row revision_source_invoice_id mismatch');
  }

  // replaces_invoice_id must equal the original snapshot revision_source_invoice_id.
  if (r.replaces_invoice_id !== originalSnapshot.revision_source_invoice_id) {
    throw new Error('Revision RPC row replaces_invoice_id does not equal revision_source_invoice_id');
  }

  // source_invoice_id must equal the original snapshot revision_source_invoice_id.
  if (r.source_invoice_id !== originalSnapshot.revision_source_invoice_id) {
    throw new Error('Revision RPC row source_invoice_id mismatch');
  }

  // source_status must be exactly 'void'.
  if (r.source_status !== 'void') {
    throw new Error('Revision RPC row source_status is not void');
  }

  // issued_at must be a non-empty string that parses as a valid timestamp.
  if (
    typeof r.issued_at !== 'string' ||
    r.issued_at.trim() === '' ||
    isNaN(new Date(r.issued_at).getTime())
  ) {
    throw new Error('Revision RPC row issued_at is missing or invalid');
  }

  // pdf_generated_at must be a non-empty string that parses as a valid timestamp.
  if (
    typeof r.pdf_generated_at !== 'string' ||
    r.pdf_generated_at.trim() === '' ||
    isNaN(new Date(r.pdf_generated_at).getTime())
  ) {
    throw new Error('Revision RPC row pdf_generated_at is missing or invalid');
  }

  // pdf_generation_status must be exactly 'generated'.
  if (r.pdf_generation_status !== 'generated') {
    throw new Error('Revision RPC row pdf_generation_status is not generated');
  }

  // total_cents must be a safe integer.
  if (!Number.isSafeInteger(r.total_cents)) {
    throw new Error('Revision RPC row total_cents is not a safe integer');
  }

  // total_cents must be non-negative.
  if ((r.total_cents as number) < 0) {
    throw new Error('Revision RPC row total_cents is negative');
  }

  // source_invoice_number must be a non-empty string.
  if (
    typeof r.source_invoice_number !== 'string' ||
    r.source_invoice_number.trim() === ''
  ) {
    throw new Error('Revision RPC row source_invoice_number is missing or empty');
  }

  return {
    invoice_id: invoiceId,
    invoice_number: r.invoice_number,
    status: r.status,
    issued_at: r.issued_at,
    pdf_generation_status: r.pdf_generation_status,
    total_cents: r.total_cents as number,
  };
}

// ---------------------------------------------------------------------------
// callCompleteIssuance — routes to the correct completion RPC based on
// whether the invoice is a Revision, then handles concurrent success
// reconciliation and unknown/malformed result reconciliation.
//
// For NORMAL invoices:  calls complete_invoice_issuance()
// For REVISION invoices: calls complete_revision_invoice_issuance()
//
// Does NOT call both. Does NOT let a Revision fall through to the normal RPC.
// Does NOT let a normal invoice call the Revision RPC.
// ---------------------------------------------------------------------------

async function callCompleteIssuance(
  invoiceId: string,
  adminUserId: string,
  storagePath: string,
  pdfHash: string,
  originalSnapshot: InvoiceSnapshot,
  isRevision: boolean,
): Promise<OrchestratorSuccessResult> {
  if (isRevision) {
    return await callCompleteRevisionIssuance(
      invoiceId,
      adminUserId,
      storagePath,
      pdfHash,
      originalSnapshot,
    );
  }

  return await callCompleteNormalIssuance(
    invoiceId,
    adminUserId,
    storagePath,
    pdfHash,
    originalSnapshot,
  );
}

// ---------------------------------------------------------------------------
// callCompleteNormalIssuance — calls complete_invoice_issuance RPC and handles
// concurrent success reconciliation and unknown/malformed result reconciliation.
// This is the original normal invoice completion path — behavior unchanged.
// ---------------------------------------------------------------------------

async function callCompleteNormalIssuance(
  invoiceId: string,
  adminUserId: string,
  storagePath: string,
  pdfHash: string,
  originalSnapshot: InvoiceSnapshot,
): Promise<OrchestratorSuccessResult> {
  const supabase = getServiceClient();

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'complete_invoice_issuance',
    {
      p_invoice_id: invoiceId,
      p_admin_user_id: adminUserId,
      p_pdf_storage_path: storagePath,
      p_pdf_hash: pdfHash,
    },
  );

  if (rpcError) {
    // Extract the raw message for token inspection — but NEVER log it unless
    // it is a known stable token.
    const rawMessage = (rpcError as { message?: string }).message?.trim() ?? '';
    const errorCode = (rpcError as { code?: string }).code ?? 'unknown';

    // ── invoice_not_issuing: concurrent success reconciliation ─────────────
    // May mean a concurrent request already completed the issuance.
    // Do NOT automatically mark pdf_completion_failed.
    if (rawMessage === 'invoice_not_issuing') {
      return await reconcileDbState(
        invoiceId,
        adminUserId,
        storagePath,
        pdfHash,
        originalSnapshot,
        'invoice_not_issuing',
      );
    }

    // ── Known stable failure tokens ────────────────────────────────────────
    // These unambiguously indicate the RPC transaction failed.
    // The invoice remains in 'issuing' — safe to best-effort mark failed.
    if (COMPLETE_RPC_ERROR_TOKENS.has(rawMessage)) {
      console.error('[invoicePdfOrchestrator] complete_invoice_issuance stable error:', {
        invoiceId,
        token: rawMessage,
      });

      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_completion_failed');

      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_COMPLETION_FAILED',
        'complete_invoice_issuance failed with a known stable error.',
      );
    }

    // ── Unknown error ──────────────────────────────────────────────────────
    // The RPC may have committed successfully but the caller received a
    // network/transport/timeout error. Do NOT immediately mark failed.
    // Reconcile DB state first.
    console.error('[invoicePdfOrchestrator] complete_invoice_issuance unknown error:', {
      invoiceId,
      code: errorCode,
    });

    return await reconcileDbState(
      invoiceId,
      adminUserId,
      storagePath,
      pdfHash,
      originalSnapshot,
      'unknown_error',
    );
  }

  // ── RPC returned success — strictly validate the row ─────────────────────
  // Do NOT use ?? fallbacks. Do NOT fabricate successful values.
  // If the row is malformed: reconcile DB state before deciding.

  try {
    return validateCompleteRpcRow(rpcData, invoiceId, originalSnapshot);
  } catch {
    // Malformed success response — the RPC may have committed but returned
    // unexpected data. Reconcile DB state before marking failed.
    console.error('[invoicePdfOrchestrator] complete_invoice_issuance malformed success row:', {
      invoiceId,
    });

    return await reconcileDbState(
      invoiceId,
      adminUserId,
      storagePath,
      pdfHash,
      originalSnapshot,
      'malformed_success',
    );
  }
}

// ---------------------------------------------------------------------------
// callCompleteRevisionIssuance — calls complete_revision_invoice_issuance RPC
// and handles concurrent success reconciliation and unknown/malformed result
// reconciliation specific to Revision invoices.
//
// Uses COMPLETE_REVISION_RPC_ERROR_TOKENS — separate from normal tokens.
// Does NOT call complete_invoice_issuance().
// ---------------------------------------------------------------------------

async function callCompleteRevisionIssuance(
  invoiceId: string,
  adminUserId: string,
  storagePath: string,
  pdfHash: string,
  originalSnapshot: InvoiceSnapshot,
): Promise<OrchestratorSuccessResult> {
  const supabase = getServiceClient();

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'complete_revision_invoice_issuance',
    {
      p_invoice_id: invoiceId,
      p_admin_user_id: adminUserId,
      p_pdf_storage_path: storagePath,
      p_pdf_hash: pdfHash,
    },
  );

  if (rpcError) {
    const rawMessage = (rpcError as { message?: string }).message?.trim() ?? '';
    const errorCode = (rpcError as { code?: string }).code ?? 'unknown';

    // ── revision_invoice_not_issuing: concurrent success reconciliation ─────
    // May mean a concurrent request already completed the Revision issuance.
    // Do NOT automatically mark pdf_completion_failed.
    if (rawMessage === 'revision_invoice_not_issuing') {
      return await reconcileRevisionDbState(
        invoiceId,
        adminUserId,
        storagePath,
        pdfHash,
        originalSnapshot,
        'revision_invoice_not_issuing',
      );
    }

    // ── Known stable Revision failure tokens ──────────────────────────────
    // These unambiguously indicate the RPC transaction failed.
    // The invoice remains in 'issuing' — safe to best-effort mark failed.
    if (COMPLETE_REVISION_RPC_ERROR_TOKENS.has(rawMessage)) {
      console.error('[invoicePdfOrchestrator] complete_revision_invoice_issuance stable error:', {
        invoiceId,
        token: rawMessage,
      });

      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_completion_failed');

      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_COMPLETION_FAILED',
        'complete_revision_invoice_issuance failed with a known stable error.',
      );
    }

    // ── Unknown error ──────────────────────────────────────────────────────
    // The RPC may have committed successfully but the caller received a
    // network/transport/timeout error. Do NOT immediately mark failed.
    // Reconcile Revision DB state first.
    console.error('[invoicePdfOrchestrator] complete_revision_invoice_issuance unknown error:', {
      invoiceId,
      code: errorCode,
    });

    return await reconcileRevisionDbState(
      invoiceId,
      adminUserId,
      storagePath,
      pdfHash,
      originalSnapshot,
      'unknown_error',
    );
  }

  // ── RPC returned success — strictly validate the Revision row ─────────────
  // Do NOT use ?? fallbacks. Do NOT fabricate missing values.
  // If the row is malformed: reconcile Revision DB state before deciding.

  try {
    return validateRevisionCompleteRpcRow(rpcData, invoiceId, originalSnapshot);
  } catch {
    // Malformed success response — the RPC may have committed but returned
    // unexpected data. Reconcile Revision DB state before marking failed.
    console.error('[invoicePdfOrchestrator] complete_revision_invoice_issuance malformed success row:', {
      invoiceId,
    });

    return await reconcileRevisionDbState(
      invoiceId,
      adminUserId,
      storagePath,
      pdfHash,
      originalSnapshot,
      'malformed_success',
    );
  }
}

// ---------------------------------------------------------------------------
// reconcileRevisionDbState — re-fetches the Revision invoice AND its source
// invoice to determine actual DB state before deciding whether to mark failed
// or treat as success.
//
// Called for:
//   A. revision_invoice_not_issuing from complete_revision_invoice_issuance
//   B. Unknown errors from complete_revision_invoice_issuance
//   C. Malformed/invalid successful RPC response
//
// Revision success requires ALL of:
//   revision.id === invoiceId
//   revision.status === 'open'
//   revision.invoice_number === originalSnapshot.invoice_number
//   revision.issued_at non-null
//   revision.pdf_generation_status === 'generated'
//   revision.pdf_storage_path === deterministic storagePath
//   revision.pdf_hash === current computed/downloaded hash
//   revision.revision_source_invoice_id === originalSnapshot.revision_source_invoice_id
//   revision.replaces_invoice_id === originalSnapshot.revision_source_invoice_id
//
// Then re-fetches the SOURCE invoice (by revision_source_invoice_id) and requires:
//   source.id === originalSnapshot.revision_source_invoice_id
//   source.status === 'void'
//   source.invoice_number is non-empty
//
// Only then treats the concurrent Revision completion as successful.
// Does NOT rewrite either invoice. Does NOT create activities. Does NOT upload.
// ---------------------------------------------------------------------------

async function reconcileRevisionDbState(
  invoiceId: string,
  adminUserId: string,
  storagePath: string,
  pdfHash: string,
  originalSnapshot: InvoiceSnapshot,
  reason: 'revision_invoice_not_issuing' | 'unknown_error' | 'malformed_success',
): Promise<OrchestratorSuccessResult> {
  const supabase = getServiceClient();

  // ── Re-fetch the Revision invoice ────────────────────────────────────────
  const { data: refetchData, error: refetchError } = await supabase
    .from('crm_invoices')
    .select(
      'id,status,invoice_number,issued_at,pdf_generation_status,pdf_storage_path,pdf_generated_at,pdf_hash,total_cents,revision_source_invoice_id,replaces_invoice_id',
    )
    .eq('id', invoiceId)
    .single();

  if (refetchError || !refetchData) {
    // Cannot determine DB state — do NOT mark failed (final state unknown).
    console.error('[invoicePdfOrchestrator] reconcileRevisionDbState revision re-fetch failed:', {
      invoiceId,
      reason,
    });

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_COMPLETION_FAILED',
      'Revision completion result uncertain and re-fetch failed; DB state unknown.',
    );
  }

  const refetched = refetchData as {
    id: string;
    status: string;
    invoice_number: string;
    issued_at: string | null;
    pdf_generation_status: string;
    pdf_storage_path: string | null;
    pdf_generated_at: string | null;
    pdf_hash: string | null;
    total_cents: number;
    revision_source_invoice_id: string | null;
    replaces_invoice_id: string | null;
  };

  // ── Check: Revision invoice is open with all metadata matching ───────────
  const issuedAtValid =
    typeof refetched.issued_at === 'string' &&
    refetched.issued_at.trim() !== '' &&
    !isNaN(new Date(refetched.issued_at).getTime());

  const pdfGeneratedAtValid =
    typeof refetched.pdf_generated_at === 'string' &&
    refetched.pdf_generated_at.trim() !== '' &&
    !isNaN(new Date(refetched.pdf_generated_at).getTime());

  const totalMatch =
    Number.isSafeInteger(refetched.total_cents) &&
    refetched.total_cents === originalSnapshot.total_cents;

  const hashMatch =
    typeof refetched.pdf_hash === 'string' &&
    refetched.pdf_hash.toLowerCase() === pdfHash.toLowerCase();

  const revisionSuccess =
    refetched.id === invoiceId &&
    refetched.status === 'open' &&
    refetched.invoice_number === originalSnapshot.invoice_number &&
    issuedAtValid &&
    pdfGeneratedAtValid &&
    refetched.pdf_generation_status === 'generated' &&
    refetched.pdf_storage_path === storagePath &&
    hashMatch &&
    refetched.revision_source_invoice_id === originalSnapshot.revision_source_invoice_id &&
    refetched.replaces_invoice_id === originalSnapshot.revision_source_invoice_id &&
    totalMatch;

  if (!revisionSuccess) {
    // Revision is still issuing — safe to mark failed.
    if (refetched.status === 'issuing') {
      console.error('[invoicePdfOrchestrator] reconcileRevisionDbState: revision still issuing after reconciliation:', {
        invoiceId,
        reason,
      });

      await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_completion_failed');

      throw new InvoicePdfOrchestratorError(
        'INVOICE_PDF_COMPLETION_FAILED',
        'Revision completion failed and invoice remains in issuing state.',
      );
    }

    // Revision is open but metadata does not match — do NOT mark failed.
    console.error('[invoicePdfOrchestrator] reconcileRevisionDbState: revision open but metadata mismatch:', {
      invoiceId,
      reason,
      refetchedStatus: refetched.status,
      refetchedPdfStatus: refetched.pdf_generation_status,
      pathMatch: refetched.pdf_storage_path === storagePath,
      hashMatch,
      numberMatch: refetched.invoice_number === originalSnapshot.invoice_number,
      issuedAtValid,
      pdfGeneratedAtValid,
      replacesMatch: refetched.replaces_invoice_id === originalSnapshot.revision_source_invoice_id,
      sourceIdMatch: refetched.revision_source_invoice_id === originalSnapshot.revision_source_invoice_id,
      totalMatch,
    });

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_COMPLETION_FAILED',
      'Revision invoice is open but completion metadata does not match this request.',
    );
  }

  // ── Re-fetch the SOURCE invoice ───────────────────────────────────────────
  // Must verify source is void before treating Revision completion as success.
  const sourceInvoiceId = originalSnapshot.revision_source_invoice_id as string;

  const { data: sourceData, error: sourceError } = await supabase
    .from('crm_invoices')
    .select('id,status,invoice_number')
    .eq('id', sourceInvoiceId)
    .single();

  if (sourceError || !sourceData) {
    // Cannot verify source state — do NOT mark Revision failed (state unknown).
    console.error('[invoicePdfOrchestrator] reconcileRevisionDbState source re-fetch failed:', {
      invoiceId,
      reason,
    });

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_COMPLETION_FAILED',
      'Revision completion uncertain: could not re-fetch source invoice to verify void status.',
    );
  }

  const source = sourceData as {
    id: string;
    status: string;
    invoice_number: string;
  };

  // Require source to be void with a non-empty invoice_number.
  const sourceSuccess =
    source.id === sourceInvoiceId &&
    source.status === 'void' &&
    typeof source.invoice_number === 'string' &&
    source.invoice_number.trim() !== '';

  if (!sourceSuccess) {
    // Source is not void — do NOT mark Revision failed (state is uncertain).
    console.error('[invoicePdfOrchestrator] reconcileRevisionDbState: source invoice not void:', {
      invoiceId,
      reason,
      sourceStatus: source.status,
      sourceIdMatch: source.id === sourceInvoiceId,
    });

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_COMPLETION_FAILED',
      'Revision completion uncertain: source invoice is not void.',
    );
  }

  // ── Both Revision and Source verified — treat as successful completion ────
  // Do NOT rewrite either invoice. Do NOT create activities. Do NOT upload.
  return {
    invoice_id: invoiceId,
    invoice_number: refetched.invoice_number,
    status: refetched.status,
    issued_at: refetched.issued_at,
    pdf_generation_status: refetched.pdf_generation_status,
    total_cents: refetched.total_cents,
  };
}

// ---------------------------------------------------------------------------
// reconcileDbState — re-fetches the invoice to determine actual DB state
// before deciding whether to mark failed or treat as success.
// Normal invoice path only — unchanged from original implementation.
//
// Called for:
//   A. invoice_not_issuing from complete_invoice_issuance
//   B. Unknown errors from complete_invoice_issuance
//   C. Malformed/invalid successful RPC response
//
// Logic:
//   status === 'open' AND all metadata matches → SUCCESS (concurrent or committed)
//   status === 'issuing'                        → safe to mark pdf_completion_failed
//   status === 'open' but metadata mismatches   → do NOT mark failed; throw safe error
//   re-fetch fails                              → do NOT mark failed (unknown state)
// ---------------------------------------------------------------------------

async function reconcileDbState(
  invoiceId: string,
  adminUserId: string,
  storagePath: string,
  pdfHash: string,
  originalSnapshot: InvoiceSnapshot,
  reason: 'invoice_not_issuing' | 'unknown_error' | 'malformed_success',
): Promise<OrchestratorSuccessResult> {
  const supabase = getServiceClient();

  const { data: refetchData, error: refetchError } = await supabase
    .from('crm_invoices')
    .select(
      'id,status,invoice_number,issued_at,pdf_generation_status,pdf_storage_path,pdf_hash,total_cents',
    )
    .eq('id', invoiceId)
    .single();

  if (refetchError || !refetchData) {
    // Cannot determine DB state — do NOT mark failed (final state unknown).
    console.error('[invoicePdfOrchestrator] reconcileDbState re-fetch failed:', {
      invoiceId,
      reason,
    });

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_COMPLETION_FAILED',
      'Completion result uncertain and re-fetch failed; DB state unknown.',
    );
  }

  const refetched = refetchData as {
    id: string;
    status: string;
    invoice_number: string;
    issued_at: string | null;
    pdf_generation_status: string;
    pdf_storage_path: string | null;
    pdf_hash: string | null;
    total_cents: number;
  };

  // ── Check: invoice is open with all metadata matching ───────────────────
  // Verify:
  //   status === 'open'
  //   pdf_generation_status === 'generated'
  //   pdf_storage_path === deterministic storagePath
  //   pdf_hash === exact pdfHash used by this request
  //   invoice_number === originalSnapshot.invoice_number
  //   issued_at is non-null

  const isSuccess =
    refetched.status === 'open' &&
    refetched.pdf_generation_status === 'generated' &&
    refetched.pdf_storage_path === storagePath &&
    refetched.pdf_hash === pdfHash &&
    refetched.invoice_number === originalSnapshot.invoice_number &&
    refetched.issued_at !== null;

  if (isSuccess) {
    // Treat as successful completion (concurrent or committed).
    // Do NOT rewrite the invoice, upload again, or create another activity.
    return {
      invoice_id: invoiceId,
      invoice_number: refetched.invoice_number,
      status: refetched.status,
      issued_at: refetched.issued_at,
      pdf_generation_status: refetched.pdf_generation_status,
      total_cents: refetched.total_cents,
    };
  }

  // ── Check: invoice is still issuing ─────────────────────────────────────
  // RPC transaction unambiguously did not commit — safe to mark failed.

  if (refetched.status === 'issuing') {
    console.error('[invoicePdfOrchestrator] reconcileDbState: invoice still issuing after reconciliation:', {
      invoiceId,
      reason,
    });

    await bestEffortMarkFailed(invoiceId, adminUserId, 'pdf_completion_failed');

    throw new InvoicePdfOrchestratorError(
      'INVOICE_PDF_COMPLETION_FAILED',
      'Completion failed and invoice remains in issuing state.',
    );
  }

  // ── Check: invoice is open but metadata/hash/path do NOT match ──────────
  // Do NOT mark it failed — the invoice is already open.
  // Throw safe error without exposing the raw row.

  console.error('[invoicePdfOrchestrator] reconcileDbState: invoice open but metadata mismatch:', {
    invoiceId,
    reason,
    refetchedStatus: refetched.status,
    refetchedPdfStatus: refetched.pdf_generation_status,
    pathMatch: refetched.pdf_storage_path === storagePath,
    hashMatch: refetched.pdf_hash === pdfHash,
    numberMatch: refetched.invoice_number === originalSnapshot.invoice_number,
    issuedAtPresent: refetched.issued_at !== null,
  });

  throw new InvoicePdfOrchestratorError(
    'INVOICE_PDF_COMPLETION_FAILED',
    'Invoice is open but completion metadata does not match this request.',
  );
}
