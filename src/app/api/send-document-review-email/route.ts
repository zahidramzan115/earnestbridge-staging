import { NextResponse } from 'next/server';

// POST /api/send-document-review-email
// Called when an admin approves, rejects, or requests resubmission of a borrower document.
// Body: { action, borrowerEmail, borrowerFirstName, borrowerLastName, documentName, feedbackNote?, propertyAddress? }
// action: 'approved' | 'rejected' | 'resubmit_requested'

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      action,
      borrowerEmail,
      borrowerFirstName,
      borrowerLastName,
      documentName,
      feedbackNote,
      propertyAddress,
    } = body;

    if (!borrowerEmail || !action || !documentName) {
      return NextResponse.json(
        { error: 'Missing required fields: borrowerEmail, action, documentName' },
        { status: 400 }
      );
    }

    const validActions = ['approved', 'rejected', 'resubmit_requested'];
    if (!validActions.includes(action)) {
      return NextResponse.json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Supabase configuration missing' }, { status: 500 });
    }

    const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseAnonKey}`,
    };

    // Map action to emailType
    const emailTypeMap: Record<string, string> = {
      approved: 'document_approved',
      rejected: 'document_rejected',
      resubmit_requested: 'document_resubmit_requested',
    };

    const payload = {
      emailType: emailTypeMap[action],
      borrower: {
        firstName: borrowerFirstName || '',
        lastName: borrowerLastName || '',
        email: borrowerEmail,
      },
      application: {
        documentName,
        feedbackNote: feedbackNote || '',
        propertyAddress: propertyAddress || '',
      },
    };

    const response = await fetch(edgeFnUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
      return NextResponse.json({ error: errData.error || 'Email send failed' }, { status: 500 });
    }

    const data = await response.json();
    return NextResponse.json({ success: true, emailId: data.emailId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Document review email error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
