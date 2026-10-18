import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { assertPortalAccess } from '@/lib/server/portalAccess';
import { sendDocumentEmail } from '@/lib/server/sendDocumentEmail';

// POST /api/send-document-email
// Called by an authenticated browser session (e.g. /apply Step 14 LOI upload).
// Sends confirmation to borrower AND alert to admin (deals@earnestbridge.com).
// Body: { borrowerEmail, borrowerFirstName, borrowerLastName, documentName, documentType?, propertyAddress? }
//
// Security:
//  - A real authenticated session is REQUIRED (401 otherwise). There is no
//    anonymous fallback; server-side callers use the shared helper directly.
//  - Identity is the session user only; no body-supplied userId is trusted.
//  - Admin sessions: allowed (existing behavior preserved).
//  - Client sessions: assertPortalAccess() -> 403 portal_access_disabled.

async function getSessionUser() {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {
            // read-only usage
          },
        },
      }
    );
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (sessionUser.app_metadata?.role !== 'admin') {
      const denied = await assertPortalAccess(sessionUser.id);
      if (denied) return denied;
    }

    const body = await request.json();
    const {
      borrowerEmail,
      borrowerFirstName,
      borrowerLastName,
      documentName,
      documentType,
      propertyAddress,
    } = body;

    const result = await sendDocumentEmail({
      borrowerEmail,
      borrowerFirstName,
      borrowerLastName,
      documentName,
      documentType,
      propertyAddress,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      borrowerNotified: result.borrowerNotified,
      adminNotified: result.adminNotified,
    });
  } catch (err: any) {
    console.error('Document email error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
