import { NextResponse } from 'next/server';

// POST /api/send-document-email
// Called when a borrower uploads a document.
// Sends confirmation to borrower AND alert to admin (deals@earnestbridge.com).
// Body: { borrowerEmail, borrowerFirstName, borrowerLastName, documentName, documentType?, propertyAddress? }

export async function POST(request: Request) {
  try {
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
