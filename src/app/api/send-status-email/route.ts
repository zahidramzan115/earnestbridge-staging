import { NextResponse } from 'next/server';

// POST /api/send-status-email
// Called when an application status is updated to notify the borrower AND admin.
// Body: { borrowerEmail, borrowerFirstName, borrowerLastName, newStatus, propertyAddress, milestoneLabel?, message? }

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      borrowerEmail,
      borrowerFirstName,
      borrowerLastName,
      newStatus,
      propertyAddress,
      milestoneLabel,
      message,
    } = body;

    if (!borrowerEmail || !newStatus) {
      return NextResponse.json({ error: 'Missing required fields: borrowerEmail, newStatus' }, { status: 400 });
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
      emailType: 'status_update',
      borrower: {
        firstName: borrowerFirstName || '',
        lastName: borrowerLastName || '',
        email: borrowerEmail,
      },
      application: {
        newStatus,
        propertyAddress: propertyAddress || '',
        milestoneLabel: milestoneLabel || '',
        message: message || '',
      },
    };

    // Send borrower notification
    const borrowerResponse = await fetch(edgeFnUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(borrowerPayload),
    });

    if (!borrowerResponse.ok) {
      const errData = await borrowerResponse.json();
      return NextResponse.json({ error: errData.error || 'Borrower email send failed' }, { status: 500 });
    }

    const borrowerData = await borrowerResponse.json();

    // Send admin notification (fire-and-forget — don't fail if admin email fails)
    try {
      const statusLabels: Record<string, string> = {
        application: 'Application',
        under_review: 'Under Review',
        approved: 'Approved',
        in_progress: 'In Progress',
        funded: 'Funded',
        closed: 'Closed',
        rejected: 'Rejected',
        // legacy fallbacks
        submitted: 'Application',
        in_review: 'Under Review',
        conditionally_approved: 'Approved',
      };
      await fetch(edgeFnUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          emailType: 'admin_new_application',
          borrower: {
            firstName: borrowerFirstName || '',
            lastName: borrowerLastName || '',
            email: borrowerEmail,
          },
          application: {
            propertyAddress: propertyAddress || '',
            newStatus,
            statusLabel: statusLabels[newStatus] || newStatus,
          },
        }),
      });
    } catch {
      // Admin email failure should not block borrower notification success
    }

    return NextResponse.json({ success: true, emailId: borrowerData.emailId });
  } catch (err: any) {
    console.error('Status email error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
