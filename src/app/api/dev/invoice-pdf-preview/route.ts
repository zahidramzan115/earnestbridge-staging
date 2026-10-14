// THIS FILE HAS BEEN INTENTIONALLY REMOVED.
// The temporary invoice PDF preview route has been deleted as part of pre-production cleanup.
// See Step 6A-5C5D.

import { NextResponse } from 'next/server';

export function GET(): NextResponse {
  return new NextResponse('This preview route has been removed.', { status: 410 });
}
