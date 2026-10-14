/**
 * src/app/api/dev/generate-review-receipts/route.ts
 *
 * REMOVED — Phase 7B-9K cleanup. This temporary dev route has been deleted.
 * The V2 receipt design is approved and this generation helper is no longer needed.
 */

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse?.json({ error: 'Not found' }, { status: 404 });
}
