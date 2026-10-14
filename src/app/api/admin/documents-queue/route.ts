'use server';
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocumentQueueItem {
  id: string;
  source: 'borrower_document' | 'application_document';
  document_name: string;
  document_type: string | null;
  category: string | null;
  version_number: number;
  is_revised: boolean; // version > 1
  review_status: string; // uploaded | under_review | revision_requested | approved_final
  doc_status_legacy: string | null;
  uploaded_at: string | null;
  reviewed_at: string | null;
  client_revision_message: string | null;
  // deal
  application_id: string;
  user_id: string;
  property_address: string | null;
  eb_assigned_owner: string | null;
  // contact
  contact_id: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
  // company
  company_name: string | null;
}

export interface DocumentQueueCounters {
  awaiting_review: number;
  under_review: number;
  waiting_on_client: number;
  approved: number;
}

export interface DocumentQueueResponse {
  items: DocumentQueueItem[];
  counters: DocumentQueueCounters;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveReviewStatus(reviewStatus: string | null, docStatus: string | null): string {
  if (reviewStatus && reviewStatus !== 'superseded') return reviewStatus;
  // Legacy fallback mapping
  if (docStatus === 'approved') return 'approved_final';
  if (docStatus === 'resubmit_requested' || docStatus === 'rejected') return 'revision_requested';
  if (docStatus === 'uploaded') return 'uploaded';
  return 'uploaded';
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );

  // Admin auth check
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ONLY trust app_metadata — user_metadata is user-controlled and must not grant Admin access
  const isAdmin = user.app_metadata?.role === 'admin';
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Use service role for cross-user data access
  const { createClient } = await import('@supabase/supabase-js');
  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // ── 1. Fetch current borrower_documents with deal + contact in one query ──
    const { data: bdRows, error: bdError } = await adminClient
      .from('borrower_documents')
      .select(`
        id,
        document_name,
        document_type,
        category,
        version_number,
        is_current_version,
        review_status,
        doc_status,
        uploaded_at,
        reviewed_at,
        client_revision_message,
        application_id,
        borrower_applications!inner (
          id,
          user_id,
          property_address,
          eb_assigned_owner,
          primary_contact_id,
          email,
          first_name,
          last_name,
          crm_contacts (
            id,
            first_name,
            last_name,
            primary_email,
            company_id,
            crm_companies (
              company_name
            )
          )
        )
      `)
      .eq('is_current_version', true)
      .neq('review_status', 'superseded');

    if (bdError) {
      console.error('[documents-queue] borrower_documents error:', bdError);
    }

    // ── 2. Fetch current application_documents with deal + contact ──
    const { data: adRows, error: adError } = await adminClient
      .from('application_documents')
      .select(`
        id,
        document_name,
        revision_number,
        is_current_version,
        review_status,
        created_at,
        reviewed_at,
        client_revision_message,
        application_id,
        borrower_applications!inner (
          id,
          user_id,
          property_address,
          eb_assigned_owner,
          primary_contact_id,
          email,
          first_name,
          last_name,
          crm_contacts (
            id,
            first_name,
            last_name,
            primary_email,
            company_id,
            crm_companies (
              company_name
            )
          )
        )
      `)
      .eq('is_current_version', true)
      .neq('review_status', 'superseded');

    if (adError) {
      console.error('[documents-queue] application_documents error:', adError);
    }

    // ── 3. Normalize borrower_documents ──
    const bdItems: DocumentQueueItem[] = (bdRows ?? []).map((row: any) => {
      const app = row.borrower_applications;
      const contact = app?.crm_contacts ?? null;
      const company = contact?.crm_companies ?? null;
      const effectiveStatus = resolveReviewStatus(row.review_status, row.doc_status);

      return {
        id: row.id,
        source: 'borrower_document' as const,
        document_name: row.document_name ?? 'Document',
        document_type: row.document_type ?? null,
        category: row.category ?? null,
        version_number: row.version_number ?? 1,
        is_revised: (row.version_number ?? 1) > 1,
        review_status: effectiveStatus,
        doc_status_legacy: row.doc_status ?? null,
        uploaded_at: row.uploaded_at ?? null,
        reviewed_at: row.reviewed_at ?? null,
        client_revision_message: row.client_revision_message ?? null,
        application_id: app?.id ?? row.application_id,
        user_id: app?.user_id ?? '',
        property_address: app?.property_address ?? null,
        eb_assigned_owner: app?.eb_assigned_owner ?? 'Unassigned',
        contact_id: contact?.id ?? null,
        contact_first_name: contact?.first_name ?? app?.first_name ?? null,
        contact_last_name: contact?.last_name ?? app?.last_name ?? null,
        contact_email: contact?.primary_email ?? app?.email ?? null,
        company_name: company?.company_name ?? null,
      };
    });

    // ── 4. Normalize application_documents ──
    const adItems: DocumentQueueItem[] = (adRows ?? []).map((row: any) => {
      const app = row.borrower_applications;
      const contact = app?.crm_contacts ?? null;
      const company = contact?.crm_companies ?? null;
      const effectiveStatus = resolveReviewStatus(row.review_status, null);

      return {
        id: row.id,
        source: 'application_document' as const,
        document_name: row.document_name ?? 'Document',
        document_type: null,
        category: null,
        version_number: row.revision_number ?? 1,
        is_revised: (row.revision_number ?? 1) > 1,
        review_status: effectiveStatus,
        doc_status_legacy: null,
        uploaded_at: row.created_at ?? null,
        reviewed_at: row.reviewed_at ?? null,
        client_revision_message: row.client_revision_message ?? null,
        application_id: app?.id ?? row.application_id,
        user_id: app?.user_id ?? '',
        property_address: app?.property_address ?? null,
        eb_assigned_owner: app?.eb_assigned_owner ?? 'Unassigned',
        contact_id: contact?.id ?? null,
        contact_first_name: contact?.first_name ?? app?.first_name ?? null,
        contact_last_name: contact?.last_name ?? app?.last_name ?? null,
        contact_email: contact?.primary_email ?? app?.email ?? null,
        company_name: company?.company_name ?? null,
      };
    });

    // ── 5. Merge and sort by priority ──
    const STATUS_ORDER: Record<string, number> = {
      uploaded: 0,
      under_review: 1,
      revision_requested: 2,
      approved_final: 3,
    };

    const allItems = [...bdItems, ...adItems].sort((a, b) => {
      const orderA = STATUS_ORDER[a.review_status] ?? 99;
      const orderB = STATUS_ORDER[b.review_status] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      // Within same status: oldest first (longest wait)
      const tA = a.uploaded_at ? new Date(a.uploaded_at).getTime() : 0;
      const tB = b.uploaded_at ? new Date(b.uploaded_at).getTime() : 0;
      return tA - tB;
    });

    // ── 6. Counters (current versions only) ──
    const counters: DocumentQueueCounters = {
      awaiting_review: allItems.filter(i => i.review_status === 'uploaded').length,
      under_review: allItems.filter(i => i.review_status === 'under_review').length,
      waiting_on_client: allItems.filter(i => i.review_status === 'revision_requested').length,
      approved: allItems.filter(i => i.review_status === 'approved_final').length,
    };

    return NextResponse.json({ items: allItems, counters } satisfies DocumentQueueResponse);
  } catch (err) {
    console.error('[documents-queue] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
