import { NextResponse } from 'next/server';

// POST /api/send-verification-email
// Sends a branded email-verification message to a newly registered borrower.
// Body: { email, fullName, verificationLink }

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, fullName, verificationLink } = body;

    if (!email || !verificationLink) {
      return NextResponse.json(
        { error: 'Missing required fields: email, verificationLink' },
        { status: 400 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Supabase configuration missing' }, { status: 500 });
    }

    const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;

    const payload = {
      emailType: 'email_verification',
      borrower: {
        firstName: fullName?.split(' ')[0] || '',
        lastName: fullName?.split(' ').slice(1).join(' ') || '',
        email,
      },
      application: {
        verificationLink,
      },
    };

    const response = await fetch(edgeFnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify(payload),
    });

    const ok = response.ok;
    if (!ok) {
      const errText = await response.text();
      console.error('Verification email failed:', errText);
    }

    return NextResponse.json({ success: ok });
  } catch (err: any) {
    console.error('Verification email error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
