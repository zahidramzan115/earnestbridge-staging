import { NextResponse } from 'next/server';

// RETIRED: Legacy Closing Date reminder pipeline.
//
// This route previously sent `deadline_reminder` and `admin_deadline_reminder`
// emails based on borrower_applications.closing_date (Target Closing). Target
// Closing is informational only and must not drive reminders. The option-cycle
// automation (Option Exercise Deadline) is the only reminder path.
//
// This handler performs NO database queries, NO email invocations and NO
// mutations. It returns a deterministic "disabled" response.

function disabledResponse() {
  return NextResponse?.json(
    {
      success: false,
      disabled: true,
      sent: 0,
      message:
        'The legacy Closing Date reminder pipeline has been retired. Target Closing is informational only. Option reminders are driven by the Option Exercise Deadline.',
    },
    { status: 410 }
  );
}

export async function GET() {
  return disabledResponse();
}

export async function POST() {
  return disabledResponse();
}
