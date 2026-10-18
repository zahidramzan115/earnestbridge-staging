import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { assertPortalAccess } from '@/lib/server/portalAccess';

// POST /api/send-document-email
// Called when a borrower uploads a document.
// Sends confirmation to borrower AND alert to admin (deals@earnestbridge.com).
// Body: { borrowerEmail, borrowerFirstName, borrowerLastName, documentName, documentType?, propertyAddress? }
//
// Portal access: this route is triggered directly by authenticated Clients
// (/apply LOI upload). If a Client session is present and the account is
// disabled, the request is rejected with 403 portal_access_disabled.
// Cookie-less server-to-server calls (from /api/upload-document, which is
// itself guarded) and Admin sessions are not affected.

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
    if (sessionUser && sessionUser.app_metadata?.role !== 'admin') {
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

    if (!borrowerEmail || !documentName) {
      return NextResponse.json({ error: 'Missing required fields: borrowerEmail, documentName' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Supabase configuration missing' }, { status: 500 });
    }

    const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${supabaseAnonKey}`,
    };

    const borrowerPayload = {
      emailType: 'document_upload',
      borrower: {
        firstName: borrowerFirstName || '',
        lastName: borrowerLastName || '',
        email: borrowerEmail,
      },
      application: {
        documentName,
        documentType: documentType || 'Document',
        propertyAddress: propertyAddress || '',
      },
    };

    const adminPayload = {
      emailType: 'admin_document_upload',
      borrower: {
        firstName: borrowerFirstName || '',
        lastName: borrowerLastName || '',
        email: borrowerEmail,
      },
      application: {
        documentName,
        documentType: documentType || 'Document',
        propertyAddress: propertyAddress || '',
      },
    };

    // Send both emails in parallel
    const [borrowerResponse, adminResponse] = await Promise.allSettled([
      fetch(edgeFnUrl, { method: 'POST', headers, body: JSON.stringify(borrowerPayload) }),
      fetch(edgeFnUrl, { method: 'POST', headers, body: JSON.stringify(adminPayload) }),
    ]);

    const borrowerOk = borrowerResponse.status === 'fulfilled' && borrowerResponse.value.ok;
    const adminOk = adminResponse.status === 'fulfilled' && adminResponse.value.ok;

    if (!borrowerOk) {
      console.error('Borrower document email failed');
    }

    return NextResponse.json({
      success: true,
      borrowerNotified: borrowerOk,
      adminNotified: adminOk,
    });
  } catch (err: any) {
    console.error('Document email error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
