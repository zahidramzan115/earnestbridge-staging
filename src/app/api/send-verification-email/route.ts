import { NextResponse } from 'next/server';

// RETIRED: Supabase's native confirmation email is the only signup verification email.
// This endpoint no longer sends anything.

const retired = () =>
  NextResponse?.json({ error: 'verification_email_route_retired' }, { status: 410 });

export async function POST() {
  return retired();
}

export async function GET() {
  return retired();
}
