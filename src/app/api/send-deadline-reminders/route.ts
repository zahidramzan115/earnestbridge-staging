import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// POST /api/send-deadline-reminders
// Fetches all active deals with closing dates within the next 9 days (inclusive of today)
// and sends daily deadline reminder emails to borrowers AND admin@earnestbridge.com.
//
// BUSINESS LOGIC:
//   - Reminders start 9 days before closing date
//   - Option period expires 2 days before closing (so 9 days = 7 days until option expires)
//   - Borrower must sign an extension before EMD is returned and deal auto-closes
//   - Runs daily via Vercel Cron (see vercel.json)
//
// Trigger: GET /api/send-deadline-reminders (Vercel Cron) or POST (manual/admin)

export async function GET(request: Request) {
  return handleReminders(request);
}

export async function POST(request: Request) {
  return handleReminders(request);
}

async function handleReminders(request: Request) {
  try {
    // Validate secret to prevent unauthorized calls
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Supabase configuration missing' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Call the DB function — returns deals with closing dates 0–9 days away
    const { data: applications, error } = await supabase.rpc('get_applications_needing_deadline_reminders');

    if (error) {
      console.error('Error fetching deadline applications:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!applications || applications.length === 0) {
      return NextResponse.json({ success: true, sent: 0, message: 'No deadline reminders needed today' });
    }

    const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;
    const edgeHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${supabaseServiceKey}`,
    };

    const results: { email: string; status: string; daysLeft: number; adminNotified: boolean }[] = [];

    // Send reminder email for each application
    for (const app of applications) {
      let borrowerSent = false;
      let adminSent = false;

      const daysLeft = app.days_until_closing ?? 0;

      // Compute option period context for the email
      const daysUntilOptionExpires = Math.max(0, daysLeft - 2);

      const borrowerPayload = {
        emailType: 'deadline_reminder',
        borrower: {
          firstName: app.borrower_first_name,
          lastName: app.borrower_last_name,
          email: app.borrower_email,
        },
        application: {
          propertyAddress: app.property_address,
          closingDate: app.closing_date,
          daysUntilClosing: daysLeft,
          daysUntilOptionExpires,
        },
      };

      // Send borrower reminder
      try {
        const response = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: edgeHeaders,
          body: JSON.stringify(borrowerPayload),
        });
        borrowerSent = response.ok;
      } catch {
        borrowerSent = false;
      }

      // Send admin deadline alert to admin@earnestbridge.com
      try {
        const adminResponse = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: edgeHeaders,
          body: JSON.stringify({
            emailType: 'admin_deadline_reminder',
            borrower: {
              firstName: app.borrower_first_name,
              lastName: app.borrower_last_name,
              email: app.borrower_email,
            },
            application: {
              propertyAddress: app.property_address,
              closingDate: app.closing_date,
              daysUntilClosing: daysLeft,
              daysUntilOptionExpires,
              depositAmount: app.deposit_amount,
            },
          }),
        });
        adminSent = adminResponse.ok;
      } catch {
        adminSent = false;
      }

      results.push({
        email: app.borrower_email,
        status: borrowerSent ? 'sent' : 'failed',
        daysLeft,
        adminNotified: adminSent,
      });
    }

    const sentCount = results.filter(r => r.status === 'sent').length;
    const adminNotifiedCount = results.filter(r => r.adminNotified).length;

    return NextResponse.json({
      success: true,
      sent: sentCount,
      adminNotified: adminNotifiedCount,
      total: results.length,
      results,
    });
  } catch (err: any) {
    console.error('Deadline reminder job error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
