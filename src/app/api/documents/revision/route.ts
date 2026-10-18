import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { assertPortalAccess } from '@/lib/server/portalAccess';

// ============================================================
// Document Revision API
// POST   /api/documents/revision  — Upload a new revision
// PATCH  /api/documents/revision  — Update review status (Admin only)
// GET    /api/documents/revision  — Fetch version history
//
// SECURITY MODEL:
//   All three methods perform authentication BEFORE any
//   service-role database or storage operations.
//   The service-role key bypasses RLS and is therefore NOT
//   itself considered authorization.
//
// Admin email → reviewer name mapping (canonical):
//   admin@earnestbridge.com  → Eric
//   deals@earnestbridge.com  → Dan
//   legal@earnestbridge.com  → Tucker
// ============================================================

// ─── Admin email → display name mapping ──────────────────────────────────────
const ADMIN_REVIEWER_MAP: Record<string, string> = {
  'admin@earnestbridge.com': 'Eric',
  'deals@earnestbridge.com': 'Dan',
  'legal@earnestbridge.com': 'Tucker',
};

const ADMIN_EMAILS = new Set(Object.keys(ADMIN_REVIEWER_MAP));

// ─── Valid review statuses ────────────────────────────────────────────────────
const VALID_REVIEW_STATUSES = [
  'uploaded',
  'under_review',
  'revision_requested',
  'approved_final',
  'superseded',
] as const;
type ReviewStatus = (typeof VALID_REVIEW_STATUSES)[number];

// ─── Statuses that only Admins may set ───────────────────────────────────────
// A client/borrower must NEVER be able to approve their own document.
const ADMIN_ONLY_STATUSES: ReviewStatus[] = [
  'under_review',
  'revision_requested',
  'approved_final',
  'superseded',
];

// ─── Allowed MIME types ───────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// ─── Service-role client (bypasses RLS — use ONLY after auth check) ──────────
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase service role not configured');
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

interface AuthedUser {
  id: string;
  email: string;
  isAdmin: boolean;
  reviewerName: string | null; // null for non-admin users
}

/**
 * Verify the caller's session using the anon key (respects RLS).
 * Returns null if unauthenticated.
 * MUST be called before any service-role operation.
 */
async function getAuthedUser(): Promise<AuthedUser | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const isAdmin = user.app_metadata?.role === 'admin';

  const reviewerName = isAdmin ? (ADMIN_REVIEWER_MAP[user.email ?? ''] ?? null) : null;

  return {
    id: user.id,
    email: user.email ?? '',
    isAdmin,
    reviewerName,
  };
}

/**
 * Verify that a given applicationId belongs to the authenticated user
 * (for client/borrower ownership checks).
 * Uses the service client but only after auth has been verified.
 */
async function verifyApplicationOwnership(
  serviceClient: ReturnType<typeof getServiceClient>,
  applicationId: string,
  userId: string
): Promise<boolean> {
  const { data } = await serviceClient
    .from('borrower_applications')
    .select('id')
    .eq('id', applicationId)
    .eq('user_id', userId)
    .is('purged_at', null)
    .single();
  return !!data;
}

/**
 * Verify that a document group (thread_id for application_documents,
 * document_group_id for borrower_documents) belongs to the given application.
 */
async function verifyGroupBelongsToApplication(
  serviceClient: ReturnType<typeof getServiceClient>,
  tableTarget: string,
  groupId: string,
  applicationId: string
): Promise<boolean> {
  if (tableTarget === 'borrower_documents') {
    const { data } = await serviceClient
      .from('borrower_documents')
      .select('id')
      .eq('document_group_id', groupId)
      .eq('application_id', applicationId)
      .limit(1)
      .single();
    return !!data;
  } else {
    // application_documents — group is thread_id
    const { data } = await serviceClient
      .from('application_documents')
      .select('id')
      .eq('thread_id', groupId)
      .eq('application_id', applicationId)
      .limit(1)
      .single();
    return !!data;
  }
}

// ─── POST /api/documents/revision ─────────────────────────────────────────────
// Upload a new revision to an existing document group.
//
// Authorization:
//   Admin: may always upload a revision.
//   Authenticated client: may upload a revision ONLY when ALL of the following are true:
//     1. The client owns/is authorized for the application (verifyApplicationOwnership).
//     2. The document group belongs to that application (verifyGroupBelongsToApplication).
//     3. The referenced document is the CURRENT version (is_current_version = true).
//     4. The current document's review_status = 'revision_requested'.
//     5. The logical document group/thread belongs to that client's authorized Deal.
//
// Required form fields:
//   file              — the new file
//   documentGroupId   — UUID of the existing document group
//                       (document_group_id for borrower_documents,
//                        thread_id for application_documents)
//   tableTarget       — 'borrower_documents' | 'application_documents'
//   applicationId     — associated application UUID
//   documentName      — logical document name (stable across revisions)
//
// For borrower_documents only:
//   documentType      — document_type value
//   category          — document_category enum value
//   complianceType    — optional
//   checklistStep     — optional integer
//
// For application_documents only:
//   uploadedByRole    — 'borrower' | 'admin'
//   uploaderEmail     — optional
//   feedback          — optional
//   isAdminResponse   — 'true' | 'false'
export async function POST(req: NextRequest) {
  // ── 1. AUTHENTICATE before any privileged operation ──────────────────────
  const authedUser = await getAuthedUser();
  if (!authedUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Account-wide portal access guard for Client callers
  if (!authedUser.isAdmin) {
    const portalBlock = await assertPortalAccess(authedUser.id);
    if (portalBlock) return portalBlock;
  }

  try {
    const formData = await req.formData();

    const file = formData.get('file') as File | null;
    // documentGroupId = document_group_id for borrower_documents,
    //                   thread_id for application_documents
    const documentGroupId = formData.get('documentGroupId') as string | null;
    const tableTarget = (formData.get('tableTarget') as string) || 'application_documents';
    let applicationId = formData.get('applicationId') as string | null;
    const documentName = formData.get('documentName') as string | null;

    // ── 2. Validate required fields ──────────────────────────────────────────
    if (!file || !documentGroupId || !applicationId) {
      return NextResponse.json(
        { error: 'Missing required fields: file, documentGroupId, applicationId' },
        { status: 400 }
      );
    }

    if (!['borrower_documents', 'application_documents'].includes(tableTarget)) {
      return NextResponse.json(
        { error: 'Invalid tableTarget. Must be borrower_documents or application_documents.' },
        { status: 400 }
      );
    }

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: 'File type not allowed. Please upload PDF, JPG, PNG, WEBP, or DOC files.' },
        { status: 400 }
      );
    }

    if (file.size > 52428800) {
      return NextResponse.json({ error: 'File exceeds 50 MB limit.' }, { status: 400 });
    }

    // ── 3. Service-role client (only after auth + authz verified below) ──────
    const supabase = getServiceClient();

    // ── 4. AUTHORIZE ──────────────────────────────────────────────────────────
    if (!authedUser.isAdmin) {
      // Client path: verify application ownership
      const ownsApplication = await verifyApplicationOwnership(
        supabase,
        applicationId,
        authedUser.id
      );
      if (!ownsApplication) {
        return NextResponse.json(
          { error: 'Forbidden: you do not have access to this application.' },
          { status: 403 }
        );
      }

      // Verify the document group belongs to that application
      const groupBelongs = await verifyGroupBelongsToApplication(
        supabase,
        tableTarget,
        documentGroupId,
        applicationId
      );
      if (!groupBelongs) {
        return NextResponse.json(
          { error: 'Forbidden: document group does not belong to your application.' },
          { status: 403 }
        );
      }

      // Verify the current document has review_status = 'revision_requested'
      // and is the current version — client may ONLY upload when revision was requested
      if (tableTarget === 'borrower_documents') {
        const { data: currentDoc } = await supabase
          .from('borrower_documents')
          .select('id, review_status, is_current_version')
          .eq('document_group_id', documentGroupId)
          .eq('is_current_version', true)
          .single();

        if (!currentDoc) {
          return NextResponse.json(
            { error: 'No current version found for this document group.' },
            { status: 404 }
          );
        }
        if (currentDoc.review_status !== 'revision_requested') {
          return NextResponse.json(
            { error: 'Forbidden: a revision can only be uploaded when the document status is revision_requested.' },
            { status: 403 }
          );
        }
      } else {
        // application_documents
        const { data: currentDoc } = await supabase
          .from('application_documents')
          .select('id, review_status, is_current_version')
          .eq('thread_id', documentGroupId)
          .eq('is_current_version', true)
          .single();

        if (!currentDoc) {
          return NextResponse.json(
            { error: 'No current version found for this document thread.' },
            { status: 404 }
          );
        }
        if (currentDoc.review_status !== 'revision_requested') {
          return NextResponse.json(
            { error: 'Forbidden: a revision can only be uploaded when the document status is revision_requested.' },
            { status: 403 }
          );
        }
      }
    } else {
      // Admin path: still verify group belongs to application
      const groupBelongs = await verifyGroupBelongsToApplication(
        supabase,
        tableTarget,
        documentGroupId,
        applicationId
      );
      if (!groupBelongs) {
        return NextResponse.json(
          { error: 'Document group does not belong to the specified application.' },
          { status: 403 }
        );
      }
    }

    // ── 5. Determine next version number for storage path naming ─────────────
    let currentMaxVersion = 1;
    if (tableTarget === 'borrower_documents') {
      const { data: versionData } = await supabase
        .from('borrower_documents')
        .select('version_number')
        .eq('document_group_id', documentGroupId)
        .order('version_number', { ascending: false })
        .limit(1)
        .single();
      currentMaxVersion = (versionData?.version_number ?? 0) + 1;
    } else {
      // application_documents — use canonical revision_number
      const { data: versionData } = await supabase
        .from('application_documents')
        .select('revision_number')
        .eq('thread_id', documentGroupId)
        .order('revision_number', { ascending: false })
        .limit(1)
        .single();
      currentMaxVersion = (versionData?.revision_number ?? 0) + 1;
    }

    // ── 6. Build versioned storage path ──────────────────────────────────────
    // applicationId/documentGroupId/v{N}/timestamp.ext
    // Every revision gets a unique path — historical files are never overwritten.
    const ext = file.name.split('.').pop() ?? 'bin';
    const storagePath = `${applicationId}/${documentGroupId}/v${currentMaxVersion}/${Date.now()}.${ext}`;

    // ── 7. Upload file to storage ─────────────────────────────────────────────
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from('borrower-documents')
      .upload(storagePath, buffer, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      console.error('[document-revision POST] Storage upload error:', uploadError);
      return NextResponse.json(
        { error: `Storage upload failed: ${uploadError.message}` },
        { status: 500 }
      );
    }

    // ── 8. Generate signed URL (1 year) ──────────────────────────────────────
    const { data: signedData, error: signedError } = await supabase.storage
      .from('borrower-documents')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365);

    if (signedError) {
      console.error('[document-revision POST] Signed URL error:', signedError);
    }

    const fileUrl = signedData?.signedUrl ?? null;

    // ── 9. Create DB revision record ─────────────────────────────────────────
    // If the DB operation fails, attempt to clean up the orphaned storage object.
    let newDocumentId: string | null = null;
    const resolvedDocumentName = documentName || file.name.replace(/\.[^.]+$/, '');

    if (tableTarget === 'borrower_documents') {
      const documentType = (formData.get('documentType') as string) || 'other';
      const category = (formData.get('category') as string) || 'other';
      const complianceType = formData.get('complianceType') as string | null;
      const checklistStepRaw = formData.get('checklistStep') as string | null;
      const checklistStep = checklistStepRaw ? parseInt(checklistStepRaw, 10) : null;

      const { data: fnResult, error: fnError } = await supabase.rpc(
        'create_borrower_document_revision',
        {
          p_document_group_id: documentGroupId,
          p_user_id: authedUser.id, // use authenticated user, not request-supplied userId
          p_application_id: applicationId,
          p_document_name: resolvedDocumentName,
          p_document_type: documentType,
          p_category: category,
          p_file_url: fileUrl,
          p_file_name: file.name,
          p_file_size: file.size,
          p_mime_type: file.type,
          p_compliance_type: complianceType,
          p_checklist_step: checklistStep,
        }
      );

      if (fnError) {
        console.error('[document-revision POST] DB function error:', fnError);
        // Storage failure cleanup: remove the orphaned storage object
        const { error: cleanupError } = await supabase.storage
          .from('borrower-documents')
          .remove([storagePath]);
        if (cleanupError) {
          console.error(
            '[document-revision POST] ORPHAN STORAGE OBJECT — cleanup failed. Manual removal required:',
            storagePath,
            cleanupError
          );
        } else {
          console.info('[document-revision POST] Orphaned storage object removed:', storagePath);
        }
        return NextResponse.json(
          { error: `Revision creation failed: ${fnError.message}` },
          { status: 500 }
        );
      }

      newDocumentId = fnResult as string;
    } else {
      // application_documents — use canonical thread_id parameter name
      const uploadedByRole = authedUser.isAdmin ? 'admin' : 'borrower';
      const uploaderEmail = authedUser.email; // derive from session, not request
      const feedback = formData.get('feedback') as string | null;
      const isAdminResponse = authedUser.isAdmin; // derive from session

      const { data: fnResult, error: fnError } = await supabase.rpc(
        'create_application_document_revision',
        {
          p_thread_id: documentGroupId, // canonical parameter name
          p_application_id: applicationId,
          p_user_id: authedUser.id, // use authenticated user
          p_uploaded_by_role: uploadedByRole,
          p_uploader_email: uploaderEmail,
          p_document_name: resolvedDocumentName,
          p_file_name: file.name,
          p_file_url: fileUrl,
          p_storage_path: storagePath,
          p_file_size: file.size,
          p_mime_type: file.type,
          p_feedback: feedback,
          p_is_admin_response: isAdminResponse,
        }
      );

      if (fnError) {
        console.error('[document-revision POST] DB function error:', fnError);
        // Storage failure cleanup: remove the orphaned storage object
        const { error: cleanupError } = await supabase.storage
          .from('borrower-documents')
          .remove([storagePath]);
        if (cleanupError) {
          console.error(
            '[document-revision POST] ORPHAN STORAGE OBJECT — cleanup failed. Manual removal required:',
            storagePath,
            cleanupError
          );
        } else {
          console.info('[document-revision POST] Orphaned storage object removed:', storagePath);
        }
        return NextResponse.json(
          { error: `Revision creation failed: ${fnError.message}` },
          { status: 500 }
        );
      }

      newDocumentId = fnResult as string;
    }

    // ── 10. Activity logging for client revision uploads ──────────────────────
    // Log ONE document_revision_uploaded event per client upload.
    // Admin uploads are not logged here (they use the PATCH flow for review status).
    if (!authedUser.isAdmin) {
      try {
        const versionSuffix = `v${currentMaxVersion}`;
        const title = `Revised document uploaded — ${resolvedDocumentName} ${versionSuffix}`;
        const detail: Record<string, unknown> = {
          document_id: newDocumentId,
          table_target: tableTarget,
          document_name: resolvedDocumentName,
          version: currentMaxVersion,
          uploaded_at: new Date().toISOString(),
          uploader_user_id: authedUser.id,
        };

        const { error: activityErr } = await supabase
          .from('application_activity')
          .insert({
            application_id: applicationId,
            event_type: 'document_revision_uploaded',
            title,
            detail,
          });

        if (activityErr) {
          console.error(
            '[document-revision POST] Activity insert failed (revision was NOT reverted):',
            { applicationId, documentGroupId, error: activityErr }
          );
        }
      } catch (activityException) {
        console.error(
          '[document-revision POST] Unexpected error during activity logging (revision was NOT reverted):',
          activityException
        );
      }

      // ── 11. Admin notification email for client revision uploads ──────────
      // Reuse existing borrower-email edge function if available.
      // Failure does NOT revert the revision.
      try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        const portalUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.earnestbridge.com';

        if (supabaseUrl && supabaseAnonKey) {
          // Fetch borrower name for notification
          const { data: appRow } = await supabase
            .from('borrower_applications')
            .select('first_name, last_name, email, property_address')
            .eq('id', applicationId)
            .single();

          if (appRow) {
            const borrowerName = [appRow.first_name, appRow.last_name].filter(Boolean).join(' ') || appRow.email || 'A borrower';
            const adminDealUrl = `${portalUrl}/admin/borrower/${authedUser.id}/application/${applicationId}`;

            const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;
            const emailPayload = {
              emailType: 'document_revision_uploaded_admin',
              borrower: {
                firstName: appRow.first_name || '',
                lastName: appRow.last_name || '',
                email: appRow.email || '',
              },
              application: {
                documentName: resolvedDocumentName,
                versionNumber: currentMaxVersion,
                propertyAddress: appRow.property_address || '',
                adminDealUrl,
                borrowerName,
              },
            };

            const emailRes = await fetch(edgeFnUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${supabaseAnonKey}`,
              },
              body: JSON.stringify(emailPayload),
            });

            if (!emailRes.ok) {
              const errData = await emailRes.json().catch(() => ({}));
              console.error(
                '[document-revision POST] Admin notification email failed (revision was NOT reverted):',
                errData
              );
            }
          }
        }
      } catch (emailException) {
        console.error(
          '[document-revision POST] Unexpected error sending admin notification email (revision was NOT reverted):',
          emailException
        );
      }
    }

    return NextResponse.json({
      success: true,
      documentId: newDocumentId,
      versionNumber: currentMaxVersion,
      storagePath,
      fileUrl,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[document-revision POST] Unexpected error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── PATCH /api/documents/revision ────────────────────────────────────────────
// Update the review status of a document revision.
//
// Authorization: ADMIN ONLY.
//   Only authorized EarnestBridge Admins may set review statuses.
//   The reviewer identity is derived from the authenticated Admin session —
//   NOT from the request body. The request body's reviewedBy field is ignored.
//
// Body: { documentId, tableTarget, newStatus, reviewNotes?, clientRevisionMessage? }
export async function PATCH(req: NextRequest) {
  // ── 1. AUTHENTICATE before any privileged operation ──────────────────────
  const authedUser = await getAuthedUser();
  if (!authedUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── 2. AUTHORIZE: Admin only ──────────────────────────────────────────────
  if (!authedUser.isAdmin) {
    return NextResponse.json(
      { error: 'Forbidden: only EarnestBridge Admins may update document review status.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    // NOTE: reviewedBy from the request body is intentionally ignored.
    // The reviewer is derived from the authenticated Admin session below.
    const { documentId, tableTarget, newStatus, reviewNotes, clientRevisionMessage } = body;

    if (!documentId || !tableTarget || !newStatus) {
      return NextResponse.json(
        { error: 'Missing required fields: documentId, tableTarget, newStatus' },
        { status: 400 }
      );
    }

    // ── 3. Server-side status validation ─────────────────────────────────────
    if (!(VALID_REVIEW_STATUSES as readonly string[]).includes(newStatus)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${VALID_REVIEW_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    // Admin-only statuses: double-check (belt and suspenders)
    if ((ADMIN_ONLY_STATUSES as string[]).includes(newStatus) && !authedUser.isAdmin) {
      return NextResponse.json(
        { error: 'Forbidden: this status transition requires Admin authorization.' },
        { status: 403 }
      );
    }

    if (!['borrower_documents', 'application_documents'].includes(tableTarget)) {
      return NextResponse.json(
        { error: 'Invalid tableTarget. Must be borrower_documents or application_documents.' },
        { status: 400 }
      );
    }

    // ── 4. Validate clientRevisionMessage when status = revision_requested ────
    if (newStatus === 'revision_requested') {
      const trimmedMsg = typeof clientRevisionMessage === 'string' ? clientRevisionMessage.trim() : '';
      if (!trimmedMsg) {
        return NextResponse.json(
          { error: 'clientRevisionMessage is required when requesting a revision.' },
          { status: 400 }
        );
      }
      if (trimmedMsg.length > 2000) {
        return NextResponse.json(
          { error: 'clientRevisionMessage must be 2000 characters or fewer.' },
          { status: 400 }
        );
      }
    }

    // ── 5. Derive reviewer from authenticated session ─────────────────────────
    // The reviewer name is derived from the Admin's email address.
    // If the email is not in the canonical mapping, fall back to the email itself.
    // The request body's reviewedBy is NEVER used.
    const derivedReviewerName =
      authedUser.reviewerName ?? authedUser.email;

    // ── 6. Service-role client (only after auth + authz verified above) ──────
    const supabase = getServiceClient();

    const { data, error } = await supabase.rpc('update_document_review_status', {
      p_document_id: documentId,
      p_table_name: tableTarget,
      p_new_status: newStatus,
      p_reviewed_by: derivedReviewerName, // derived from session, not request body
      p_review_notes: reviewNotes ?? null,
      p_client_revision_message: newStatus === 'revision_requested'
        ? (typeof clientRevisionMessage === 'string' ? clientRevisionMessage.trim() : null)
        : null,
    });

    if (error) {
      console.error('[document-revision PATCH] Error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ── 7. Activity logging (revision_requested / document_approved only) ────
    // The review-status update is the primary operation.
    // If activity insert fails, we DO NOT revert the status update.
    // We log the failure server-side and still return success.
    // under_review is intentionally NOT logged (no matching event_type in schema).
    if (newStatus === 'revision_requested' || newStatus === 'approved_final') {
      try {
        // Fetch the document record to derive application_id, label, and version
        // server-side — never trust application_id from the request body.
        let applicationId: string | null = null;
        let documentLabel: string | null = null;
        let versionNumber: number | null = null;
        let borrowerEmail: string | null = null;
        let borrowerFirstName: string | null = null;
        let borrowerLastName: string | null = null;
        let propertyAddress: string | null = null;

        if (tableTarget === 'borrower_documents') {
          const { data: docRow, error: docErr } = await supabase
            .from('borrower_documents')
            .select('application_id, document_name, document_type, version_number')
            .eq('id', documentId)
            .single();

          if (docErr || !docRow) {
            console.error(
              '[document-revision PATCH] Activity: failed to fetch borrower_document row for activity logging:',
              docErr
            );
          } else {
            applicationId = docRow.application_id ?? null;
            documentLabel =
              docRow.document_name ||
              docRow.document_type ||
              null;
            versionNumber = docRow.version_number ?? null;
          }
        } else {
          // application_documents — use thread_id / revision_number
          const { data: docRow, error: docErr } = await supabase
            .from('application_documents')
            .select('application_id, document_name, revision_number')
            .eq('id', documentId)
            .single();

          if (docErr || !docRow) {
            console.error(
              '[document-revision PATCH] Activity: failed to fetch application_document row for activity logging:',
              docErr
            );
          } else {
            applicationId = docRow.application_id ?? null;
            documentLabel = docRow.document_name || null;
            versionNumber = docRow.revision_number ?? null;
          }
        }

        // Fetch borrower info for email notification
        if (applicationId && newStatus === 'revision_requested') {
          const { data: appRow } = await supabase
            .from('borrower_applications')
            .select('first_name, last_name, email, property_address')
            .eq('id', applicationId)
            .single();
          if (appRow) {
            borrowerEmail = appRow.email ?? null;
            borrowerFirstName = appRow.first_name ?? null;
            borrowerLastName = appRow.last_name ?? null;
            propertyAddress = appRow.property_address ?? null;
          }
        }

        if (!applicationId) {
          console.error(
            '[document-revision PATCH] Activity: could not derive application_id for document',
            documentId,
            '— activity insert skipped.'
          );
        } else {
          const eventType =
            newStatus === 'revision_requested' ? 'revision_requested' : 'document_approved';

          // Build a safe title — MUST NOT include review_notes or revision reason
          const versionSuffix =
            versionNumber != null ? ` — v${versionNumber}` : '';
          const labelPart = documentLabel ? `${documentLabel}` : 'Document';
          const title =
            newStatus === 'revision_requested'
              ? `Revision requested — ${labelPart}${versionSuffix}`
              : `Document approved — ${labelPart}${versionSuffix}`;

          // Safe detail: document name, version, reviewer, timestamp only.
          // review_notes / revision reason are intentionally excluded.
          const detail: Record<string, unknown> = {
            document_id: documentId,
            table_target: tableTarget,
            reviewer: derivedReviewerName,
            reviewed_at: new Date().toISOString(),
          };
          if (documentLabel) detail.document_name = documentLabel;
          if (versionNumber != null) detail.version = versionNumber;

          const { error: activityErr } = await supabase
            .from('application_activity')
            .insert({
              application_id: applicationId,
              event_type: eventType,
              title,
              detail,
            });

          if (activityErr) {
            // Activity failure: log server-side, do NOT revert status update.
            console.error(
              '[document-revision PATCH] Activity insert failed (status update was NOT reverted):',
              { eventType, applicationId, documentId, error: activityErr }
            );
          }
        }

        // ── 9. Send client email notification for revision_requested ──────────
        // Only after successful status update. Email failure does NOT revert status.
        if (newStatus === 'revision_requested' && borrowerEmail && documentLabel) {
          try {
            const trimmedMsg = typeof clientRevisionMessage === 'string' ? clientRevisionMessage.trim() : '';
            const portalUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.earnestbridge.com';
            const documentsUrl = `${portalUrl}/documents`;

            const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
            const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

            if (supabaseUrl && supabaseAnonKey) {
              const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;
              const emailPayload = {
                emailType: 'document_revision_requested',
                borrower: {
                  firstName: borrowerFirstName || '',
                  lastName: borrowerLastName || '',
                  email: borrowerEmail,
                },
                application: {
                  documentName: documentLabel,
                  clientRevisionMessage: trimmedMsg,
                  propertyAddress: propertyAddress || '',
                  documentsUrl,
                },
              };

              const emailRes = await fetch(edgeFnUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${supabaseAnonKey}`,
                },
                body: JSON.stringify(emailPayload),
              });

              if (!emailRes.ok) {
                const errData = await emailRes.json().catch(() => ({}));
                console.error(
                  '[document-revision PATCH] Revision notification email failed (status update was NOT reverted):',
                  errData
                );
              }
            }
          } catch (emailException) {
            console.error(
              '[document-revision PATCH] Unexpected error sending revision notification email (status update was NOT reverted):',
              emailException
            );
          }
        }
      } catch (activityException) {
        // Unexpected error in activity block — log and continue.
        console.error(
          '[document-revision PATCH] Unexpected error during activity logging (status update was NOT reverted):',
          activityException
        );
      }
    }

    return NextResponse.json({
      success: true,
      result: data,
      reviewedBy: derivedReviewerName,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[document-revision PATCH] Unexpected error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── GET /api/documents/revision ──────────────────────────────────────────────
// Returns all revisions in a document group, ordered by version ascending.
//
// Authorization:
//   Admin: may access any document group.
//   Authenticated client: may only access groups belonging to their own application.
//
// Query params:
//   documentGroupId — UUID of the group
//                     (document_group_id for borrower_documents,
//                      thread_id for application_documents)
//   tableTarget     — 'borrower_documents' | 'application_documents'
//   applicationId   — required for client callers (used for ownership check)
export async function GET(req: NextRequest) {
  // ── 1. AUTHENTICATE before any privileged operation ──────────────────────
  const authedUser = await getAuthedUser();
  if (!authedUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Account-wide portal access guard for Client callers
  if (!authedUser.isAdmin) {
    const portalBlock = await assertPortalAccess(authedUser.id);
    if (portalBlock) return portalBlock;
  }

  try {
    const { searchParams } = new URL(req.url);
    const documentGroupId = searchParams.get('documentGroupId');
    const tableTarget = searchParams.get('tableTarget') || 'application_documents';
    let applicationId = searchParams.get('applicationId');

    if (!documentGroupId) {
      return NextResponse.json(
        { error: 'Missing required query param: documentGroupId' },
        { status: 400 }
      );
    }

    if (!['borrower_documents', 'application_documents'].includes(tableTarget)) {
      return NextResponse.json(
        { error: 'Invalid tableTarget. Must be borrower_documents or application_documents.' },
        { status: 400 }
      );
    }

    // ── 2. Service-role client (only after auth verified above) ──────────────
    const supabase = getServiceClient();

    // ── 3. AUTHORIZE: Admin sees all; client must own the application ─────────
    if (!authedUser.isAdmin) {
      // Non-admin callers must supply applicationId for ownership verification
      if (!applicationId) {
        return NextResponse.json(
          { error: 'applicationId is required for non-admin callers.' },
          { status: 400 }
        );
      }

      // Verify the caller owns the application
      const ownsApplication = await verifyApplicationOwnership(
        supabase,
        applicationId,
        authedUser.id
      );
      if (!ownsApplication) {
        return NextResponse.json(
          { error: 'Forbidden: you do not have access to this application.' },
          { status: 403 }
        );
      }

      // Verify the document group belongs to that application
      const groupBelongs = await verifyGroupBelongsToApplication(
        supabase,
        tableTarget,
        documentGroupId,
        applicationId
      );
      if (!groupBelongs) {
        return NextResponse.json(
          { error: 'Forbidden: document group does not belong to your application.' },
          { status: 403 }
        );
      }
    }

    // ── 4. Fetch revisions ────────────────────────────────────────────────────
    if (tableTarget === 'borrower_documents') {
      const { data, error } = await supabase
        .from('borrower_documents')
        .select(
          'id, document_name, document_type, category, file_url, file_name, file_size, mime_type, doc_status, uploaded_at, created_at, document_group_id, version_number, is_current_version, review_status, review_notes, reviewed_by, reviewed_at, supersedes_document_id, compliance_type, checklist_step'
        )
        .eq('document_group_id', documentGroupId)
        .order('version_number', { ascending: true });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // Strip Admin-internal fields for non-Admin callers.
      // review_notes, reviewed_by, reviewed_at are internal only.
      const sanitized = authedUser.isAdmin
        ? data
        : (data ?? []).map(({ review_notes, reviewed_by, reviewed_at, ...rest }: any) => rest);

      return NextResponse.json({ revisions: sanitized, count: sanitized?.length ?? 0 });
    } else {
      // application_documents — query by canonical thread_id
      const { data, error } = await supabase
        .from('application_documents')
        .select(
          'id, document_name, file_name, file_url, storage_path, file_size, mime_type, uploaded_by_role, uploader_email, feedback, is_admin_response, created_at, thread_id, revision_number, parent_document_id, is_current_version, review_status, review_notes, reviewed_by, reviewed_at'
        )
        .eq('thread_id', documentGroupId)
        .order('revision_number', { ascending: true });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // Strip Admin-internal fields for non-Admin callers.
      const sanitized = authedUser.isAdmin
        ? data
        : (data ?? []).map(({ review_notes, reviewed_by, reviewed_at, ...rest }: any) => rest);

      return NextResponse.json({ revisions: sanitized, count: sanitized?.length ?? 0 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[document-revision GET] Unexpected error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
