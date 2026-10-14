/**
 * src/app/api/dev/generate-review-receipts/route.ts
 *
 * Phase 7B-9J — Dev-only route to generate synthetic review PDFs into public/review/
 *
 * GET /api/dev/generate-review-receipts
 *
 * Generates both v1 (polished) and v2 (design overhaul) review PDFs.
 * Uses IDENTICAL fixture data and renderer as scripts/testReceiptPdfDeterminism.js.
 * Writes output to:
 *   public/review/receipt-partial-polished.pdf   (v1, preserved)
 *   public/review/receipt-paid-in-full-polished.pdf (v1, preserved)
 *   public/review/receipt-partial-v2.pdf         (v2, new)
 *   public/review/receipt-paid-in-full-v2.pdf    (v2, new)
 *
 * CONSTRAINTS:
 *   - Synthetic fixture data only
 *   - No Supabase calls
 *   - No receipt RPCs
 *   - No production data
 *   - Does NOT modify receiptPdf.ts or receiptPdfOrchestrator.ts
 *   - Does NOT modify production receipt EBR-2026-000001
 */

import { NextResponse } from 'next/server';
import { renderReceiptPdf } from '@/lib/server/receiptPdf';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// ── SYNTHETIC FIXTURE DATA ───────────────────────────────────────────────────
// No real customer data. Synthetic values only.

const FIXTURE_PARTIAL = {
  receipt_number: 'EBR-2026-TEST-001',
  receipt_issued_at: '2026-10-14T14:30:00.000Z',
  payment_id: '00000000-0000-0000-0000-000000000001',
  payment_amount_cents: 100,
  payment_received_at: '2026-10-01T10:00:00.000Z',
  payment_method: 'bank_wire',
  payment_reference_number: 'REF-TEST-001',
  payment_currency: 'USD',
  amount_paid_after_cents: 100,
  balance_remaining_after_cents: 749900,
  invoice_id: '00000000-0000-0000-0000-000000000002',
  invoice_number: 'EB-2026-TEST-001-B',
  invoice_total_cents: 750000,
  invoice_issued_at: '2026-09-15T00:00:00.000Z',
  invoice_currency: 'USD',
  billing_name: 'Acme Holdings LLC',
  billing_contact_name: 'Jane Doe',
  billing_address_line1: '123 Main Street',
  billing_address_line2: 'Suite 400',
  billing_city: 'New York',
  billing_state: 'NY',
  billing_postal_code: '10001',
  billing_country: 'United States',
};

const FIXTURE_PAID_IN_FULL = {
  receipt_number: 'EBR-2026-TEST-002',
  receipt_issued_at: '2026-10-14T15:00:00.000Z',
  payment_id: '00000000-0000-0000-0000-000000000003',
  payment_amount_cents: 750000,
  payment_received_at: '2026-10-14T09:00:00.000Z',
  payment_method: 'bank_wire',
  payment_reference_number: null,
  payment_currency: 'USD',
  amount_paid_after_cents: 750000,
  balance_remaining_after_cents: 0,
  invoice_id: '00000000-0000-0000-0000-000000000004',
  invoice_number: 'EB-2026-TEST-002-A',
  invoice_total_cents: 750000,
  invoice_issued_at: '2026-09-20T00:00:00.000Z',
  invoice_currency: 'USD',
  billing_name: 'Beta Corp',
  billing_contact_name: 'Beta Corp',
  billing_address_line1: '456 Commerce Ave',
  billing_address_line2: null,
  billing_city: 'Chicago',
  billing_state: 'IL',
  billing_postal_code: '60601',
  billing_country: 'United States',
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function GET() {
  try {
    // Render both fixtures using the current approved renderer
    const bytesPartial = await renderReceiptPdf(FIXTURE_PARTIAL);
    const bytesPaidInFull = await renderReceiptPdf(FIXTURE_PAID_IN_FULL);

    // Double-render for determinism verification
    const bytesPartial2 = await renderReceiptPdf(FIXTURE_PARTIAL);
    const bytesPaidInFull2 = await renderReceiptPdf(FIXTURE_PAID_IN_FULL);

    const hashPartial1 = sha256Hex(bytesPartial);
    const hashPartial2 = sha256Hex(bytesPartial2);
    const hashPaidInFull1 = sha256Hex(bytesPaidInFull);
    const hashPaidInFull2 = sha256Hex(bytesPaidInFull2);

    const deterministicPartial = hashPartial1 === hashPartial2;
    const deterministicPaidInFull = hashPaidInFull1 === hashPaidInFull2;

    // Write to public/review/
    const reviewDir = path.join(process.cwd(), 'public', 'review');
    if (!fs.existsSync(reviewDir)) {
      fs.mkdirSync(reviewDir, { recursive: true });
    }

    const partialPath = path.join(reviewDir, 'receipt-partial-v2.pdf');
    const paidInFullPath = path.join(reviewDir, 'receipt-paid-in-full-v2.pdf');

    fs.writeFileSync(partialPath, Buffer.from(bytesPartial));
    fs.writeFileSync(paidInFullPath, Buffer.from(bytesPaidInFull));

    return NextResponse.json({
      success: true,
      phase: '7B-9J',
      files: {
        partial: {
          path: 'public/review/receipt-partial-v2.pdf',
          previewUrl: '/review/receipt-partial-v2.pdf',
          hash1: hashPartial1,
          hash2: hashPartial2,
          bytes1: bytesPartial.length,
          bytes2: bytesPartial2.length,
          deterministic: deterministicPartial,
        },
        paidInFull: {
          path: 'public/review/receipt-paid-in-full-v2.pdf',
          previewUrl: '/review/receipt-paid-in-full-v2.pdf',
          hash1: hashPaidInFull1,
          hash2: hashPaidInFull2,
          bytes1: bytesPaidInFull.length,
          bytes2: bytesPaidInFull2.length,
          deterministic: deterministicPaidInFull,
        },
      },
      productionRpcsInvoked: 0,
      productionDatabaseRowsModified: 0,
      productionPdfsUploaded: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
