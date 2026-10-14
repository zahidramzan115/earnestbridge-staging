#!/usr/bin/env node
/**
 * scripts/cleanupReceiptReviewArtifacts.js
 *
 * PHASE 7B-9K1 — TRUE FILESYSTEM CLEANUP
 * One-time maintenance script. Deletes itself after successful cleanup.
 *
 * Run: node scripts/cleanupReceiptReviewArtifacts.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

// ── Helpers ──────────────────────────────────────────────────────────────────

function deleteFile(relPath) {
  const abs = path?.join(ROOT, relPath);
  if (fs?.existsSync(abs)) {
    fs?.unlinkSync(abs);
    console.log(`DELETED: ${relPath}`);
    return true;
  } else {
    console.log(`ABSENT (skipped): ${relPath}`);
    return false;
  }
}

function removeDirIfEmpty(relPath) {
  const abs = path?.join(ROOT, relPath);
  if (!fs?.existsSync(abs)) {
    console.log(`ABSENT (skipped dir): ${relPath}`);
    return;
  }
  const entries = fs?.readdirSync(abs);
  if (entries?.length === 0) {
    fs?.rmdirSync(abs);
    console.log(`REMOVED EMPTY DIR: ${relPath}`);
  } else {
    console.log(`NOT EMPTY (skipped dir): ${relPath} — contains: ${entries?.join(', ')}`);
  }
}

// ── Step 1: Delete the four review PDFs ─────────────────────────────────────

console.log('\n── Deleting review PDFs ──');
deleteFile('public/review/receipt-partial-polished.pdf');
deleteFile('public/review/receipt-paid-in-full-polished.pdf');
deleteFile('public/review/receipt-partial-v2.pdf');
deleteFile('public/review/receipt-paid-in-full-v2.pdf');

// Remove public/review/ if now empty
console.log('\n── Removing public/review/ if empty ──');
removeDirIfEmpty('public/review');

// ── Step 2: Delete dev route file and empty parent folders ──────────────────

console.log('\n── Deleting dev route file ──');
deleteFile('src/app/api/dev/generate-review-receipts/route.ts');

// Walk up and remove empty directories, but stop before src/app/api/dev/
// (do NOT remove unrelated dev routes)
const devRouteDirs = [
  'src/app/api/dev/generate-review-receipts',
];
console.log('\n── Removing empty dev route parent dirs ──');
for (const dir of devRouteDirs) {
  removeDirIfEmpty(dir);
}

// ── Step 3: Delete generateReviewReceipts.js ────────────────────────────────

console.log('\n── Deleting generateReviewReceipts.js ──');
deleteFile('scripts/generateReviewReceipts.js');

// ── Step 4: Self-delete ──────────────────────────────────────────────────────

console.log('\n── Self-deleting cleanup script ──');
const selfPath = path?.join(ROOT, 'scripts/cleanupReceiptReviewArtifacts.js');
// Schedule deletion after this process tick so the script finishes executing
process.on('exit', () => {
  try {
    if (fs?.existsSync(selfPath)) {
      fs?.unlinkSync(selfPath);
      // Note: console.log after process.on('exit') may not flush on all platforms,
      // but the deletion will occur.
    }
  } catch (e) {
    // Silently ignore — script may already be gone
  }
});

console.log('\n✅ Cleanup complete. Script will self-delete on process exit.');
