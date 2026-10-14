import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { sendOutboundEmail } from '@/lib/server/outboundEmail';

// ── Constants ─────────────────────────────────────────────────────────────────

const BUCKET = 'email-attachments';
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_ATTACHMENT_COUNT = 5;
const MAX_COMBINED_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB combined raw

// ── Allowed MIME types and their permitted extensions ─────────────────────────
const ALLOWED_MIME_EXTENSION_MAP: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

// ── Supabase service-role client (trusted server writes) ──────────────────────
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// ── Admin authentication ───────────────────────────────────────────────────────
async function requireAdmin() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const isAdmin = user.app_metadata?.role === 'admin';
  return isAdmin ? user : null;
}

// ── Email format validation ────────────────────────────────────────────────────
function isValidEmail(email: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email);
}

// ── Attachment descriptor type ────────────────────────────────────────────────
interface AttachmentDescriptor {
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  return filename.substring(idx).toLowerCase();
}

function validateMimeAndExtension(mimeType: string, filename: string): boolean {
  const allowedExtensions = ALLOWED_MIME_EXTENSION_MAP[mimeType];
  if (!allowedExtensions) return false;
  const ext = getFileExtension(filename);
  if (!ext) return false;
  return allowedExtensions.includes(ext);
}

function sanitizeFilename(raw: string): string {
  let safe = raw
    .replace(/\.\.\//g, '')
    .replace(/\.\.\\/g, '')
    .replace(/[/\\]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  safe = safe.replace(/\s+/g, '_');
  if (safe.length > 200) {
    const ext = safe.lastIndexOf('.');
    if (ext > 0) {
      safe = safe.substring(0, 190) + safe.substring(ext);
    } else {
      safe = safe.substring(0, 200);
    }
  }
  return safe;
}

// ── POST /api/crm/contacts/[id]/send-email ────────────────────────────────────
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1. Authenticate Admin
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Verify app_metadata.role === 'admin' (secondary guard — belt-and-suspenders)
  if (admin.app_metadata?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — Admin role required' }, { status: 403 });
  }

  const { id: contactId } = await params;

  // 3. Parse request body — do NOT accept replyTo from client
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawTo = typeof rawBody.to === 'string' ? rawBody.to.trim() : '';
  const rawSubject = typeof rawBody.subject === 'string' ? rawBody.subject.trim() : '';
  const rawBodyText = typeof rawBody.body === 'string' ? rawBody.body : '';

  // 4. Server-side input validation
  if (!rawTo) {
    return NextResponse.json({ error: 'to is required' }, { status: 400 });
  }
  if (!isValidEmail(rawTo)) {
    return NextResponse.json({ error: 'to must be a single valid email address' }, { status: 400 });
  }
  if (!rawSubject) {
    return NextResponse.json({ error: 'subject is required' }, { status: 400 });
  }
  if (rawSubject.length > 250) {
    return NextResponse.json({ error: 'subject must be 250 characters or fewer' }, { status: 400 });
  }
  if (!rawBodyText || !rawBodyText.trim()) {
    return NextResponse.json({ error: 'body is required and must contain non-whitespace content' }, { status: 400 });
  }
  if (rawBodyText.length > 50000) {
    return NextResponse.json({ error: 'body must be 50,000 characters or fewer' }, { status: 400 });
  }

  // 5. Parse optional attachments — existing requests without attachments still work
  const rawAttachments = rawBody.attachments;
  let attachmentDescriptors: AttachmentDescriptor[] = [];

  if (rawAttachments !== undefined && rawAttachments !== null) {
    if (!Array.isArray(rawAttachments)) {
      return NextResponse.json({ error: 'attachments must be an array' }, { status: 400 });
    }

    if (rawAttachments.length > MAX_ATTACHMENT_COUNT) {
      return NextResponse.json(
        { error: `Too many attachments — maximum ${MAX_ATTACHMENT_COUNT} allowed` },
        { status: 400 }
      );
    }

    // Validate each descriptor shape (do NOT trust values — full server revalidation below)
    for (let i = 0; i < rawAttachments.length; i++) {
      const a = rawAttachments[i];
      if (typeof a !== 'object' || a === null) {
        return NextResponse.json({ error: `attachments[${i}] must be an object` }, { status: 400 });
      }
      const desc = a as Record<string, unknown>;
      if (typeof desc.storagePath !== 'string' || !desc.storagePath.trim()) {
        return NextResponse.json({ error: `attachments[${i}].storagePath is required` }, { status: 400 });
      }
      if (typeof desc.originalFilename !== 'string' || !desc.originalFilename.trim()) {
        return NextResponse.json({ error: `attachments[${i}].originalFilename is required` }, { status: 400 });
      }
      if (typeof desc.mimeType !== 'string' || !desc.mimeType.trim()) {
        return NextResponse.json({ error: `attachments[${i}].mimeType is required` }, { status: 400 });
      }
      if (typeof desc.sizeBytes !== 'number' || desc.sizeBytes <= 0) {
        return NextResponse.json({ error: `attachments[${i}].sizeBytes must be a positive number` }, { status: 400 });
      }
      attachmentDescriptors.push({
        storagePath: (desc.storagePath as string).trim(),
        originalFilename: (desc.originalFilename as string).trim(),
        mimeType: (desc.mimeType as string).trim(),
        sizeBytes: desc.sizeBytes as number,
      });
    }

    // Reject duplicate storagePaths within the request
    const pathSet = new Set<string>();
    for (let i = 0; i < attachmentDescriptors.length; i++) {
      const p = attachmentDescriptors[i].storagePath;
      if (pathSet.has(p)) {
        return NextResponse.json(
          { error: `Duplicate storagePath at attachments[${i}]` },
          { status: 400 }
        );
      }
      pathSet.add(p);
    }
  }

  const supabase = getServiceClient();

  // 6. Load and verify Contact exists
  const { data: contact, error: contactError } = await supabase
    .from('crm_contacts')
    .select('id, first_name, last_name, primary_email')
    .eq('id', contactId)
    .single();

  if (contactError || !contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  // 7. Derive reply-to from authenticated Admin — NOT from client request body
  const adminEmail = typeof admin.email === 'string' ? admin.email.trim() : '';
  const replyTo = adminEmail && isValidEmail(adminEmail) ? adminEmail : undefined;
  const adminDisplayName = adminEmail || 'Admin';

  // ── SERVER REVALIDATION OF ATTACHMENTS ────────────────────────────────────
  // Performed BEFORE creating the email log row.
  // If any attachment fails, we abort without creating a log row.
  interface ValidatedAttachment {
    storagePath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;       // declared
    actualSizeBytes: number; // from downloaded bytes
    base64Content: string;
  }

  const validatedAttachments: ValidatedAttachment[] = [];

  if (attachmentDescriptors.length > 0) {
    // Pre-check combined declared size
    const combinedDeclared = attachmentDescriptors.reduce((sum, a) => sum + a.sizeBytes, 0);
    if (combinedDeclared > MAX_COMBINED_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `Combined attachment size (${combinedDeclared} bytes) exceeds the 5 MB total limit`,
          attachmentState: 'temporary',
        },
        { status: 400 }
      );
    }

    for (let i = 0; i < attachmentDescriptors.length; i++) {
      const desc = attachmentDescriptors[i];

      // a. Verify storage path ownership: must start with uploads/{adminId}/{contactId}/
      const expectedPrefix = `uploads/${admin.id}/${contactId}/`;
      if (!desc.storagePath.startsWith(expectedPrefix)) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: storage path not authorized for this admin and contact`,
            attachmentState: 'temporary',
          },
          { status: 403 }
        );
      }

      // b. Prevent path traversal
      if (desc.storagePath.includes('..') || desc.storagePath.includes('//')) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: invalid storage path`,
            attachmentState: 'temporary',
          },
          { status: 400 }
        );
      }

      // c. Validate filename
      const safeFilename = sanitizeFilename(desc.originalFilename);
      if (!safeFilename) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: originalFilename is invalid`,
            attachmentState: 'temporary',
          },
          { status: 400 }
        );
      }

      // d. Validate MIME + extension combination
      if (!validateMimeAndExtension(desc.mimeType, desc.originalFilename)) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: MIME type and file extension combination is not allowed`,
            attachmentState: 'temporary',
          },
          { status: 400 }
        );
      }

      // e. Validate declared size
      if (desc.sizeBytes > MAX_FILE_SIZE_BYTES) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: declared size exceeds 5 MB per-file limit`,
            attachmentState: 'temporary',
          },
          { status: 400 }
        );
      }

      // f. Check whether storage_path is already referenced by crm_email_attachments (reject reuse)
      const { data: existingAudit, error: auditCheckError } = await supabase
        .from('crm_email_attachments')
        .select('id')
        .eq('storage_path', desc.storagePath)
        .limit(1);

      if (auditCheckError) {
        console.error(`[send-email] Audit check error for attachment ${i}:`, auditCheckError.message);
        return NextResponse.json(
          {
            error: `attachments[${i}]: failed to verify attachment status`,
            attachmentState: 'temporary',
          },
          { status: 500 }
        );
      }

      if (existingAudit && existingAudit.length > 0) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: this attachment has already been used in a previous email. Please upload the file again.`,
            attachmentState: 'audited',
          },
          { status: 409 }
        );
      }

      // g. Download the private object via service_role
      const { data: downloadData, error: downloadError } = await supabase.storage
        .from(BUCKET)
        .download(desc.storagePath);

      if (downloadError || !downloadData) {
        console.error(`[send-email] Failed to download attachment ${i}:`, downloadError?.message);
        return NextResponse.json(
          {
            error: `attachments[${i}]: attachment could not be retrieved from storage`,
            attachmentState: 'temporary',
          },
          { status: 422 }
        );
      }

      // h. Validate downloaded byte length
      const arrayBuffer = await downloadData.arrayBuffer();
      const actualBytes = arrayBuffer.byteLength;

      if (actualBytes <= 0) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: downloaded attachment is empty`,
            attachmentState: 'temporary',
          },
          { status: 422 }
        );
      }

      if (actualBytes > MAX_FILE_SIZE_BYTES) {
        return NextResponse.json(
          {
            error: `attachments[${i}]: downloaded attachment exceeds 5 MB per-file limit`,
            attachmentState: 'temporary',
          },
          { status: 422 }
        );
      }

      // i. Convert to base64
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let b = 0; b < uint8.length; b++) {
        binary += String.fromCharCode(uint8[b]);
      }
      const base64Content = Buffer.from(uint8).toString('base64');

      validatedAttachments.push({
        storagePath: desc.storagePath,
        originalFilename: desc.originalFilename,
        mimeType: desc.mimeType,
        sizeBytes: desc.sizeBytes,
        actualSizeBytes: actualBytes,
        base64Content,
      });
    }

    // j. Check combined ACTUAL downloaded size
    const combinedActual = validatedAttachments.reduce((sum, a) => sum + a.actualSizeBytes, 0);
    if (combinedActual > MAX_COMBINED_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `Combined attachment size (${combinedActual} bytes) exceeds the 5 MB total limit`,
          attachmentState: 'temporary',
        },
        { status: 400 }
      );
    }
  }
  // ── END SERVER REVALIDATION ────────────────────────────────────────────────

  // 8. Create email audit record with delivery_status = 'pending' BEFORE sending
  const { data: logEntry, error: logInsertError } = await supabase
    .from('crm_email_log')
    .insert({
      contact_id: contactId,
      sent_by: adminDisplayName,
      sent_by_user_id: admin.id,
      to_email: rawTo,
      subject: rawSubject,
      body: rawBodyText,
      delivery_status: 'pending',
      resend_id: null,
    })
    .select('id')
    .single();

  if (logInsertError || !logEntry) {
    return NextResponse.json(
      {
        error: 'Failed to create email audit record',
        // attachments have NOT been audited yet — still temporary
        ...(attachmentDescriptors.length > 0 ? { attachmentState: 'temporary' } : {}),
      },
      { status: 500 }
    );
  }

  const emailLogId = logEntry.id;

  // 9. If attachments present: insert crm_email_attachments rows BEFORE provider send
  //    (they are part of the audit regardless of delivery outcome)
  // Track whether audit rows were successfully created
  let attachmentsAudited = false;

  if (validatedAttachments.length > 0) {
    const attachmentRows = validatedAttachments.map((a) => ({
      email_log_id: emailLogId,
      storage_path: a.storagePath,
      original_filename: a.originalFilename,
      mime_type: a.mimeType,
      size_bytes: a.actualSizeBytes, // use ACTUAL downloaded byte size
    }));

    const { error: attachInsertError } = await supabase
      .from('crm_email_attachments')
      .insert(attachmentRows);

    if (attachInsertError) {
      console.error('[send-email] Failed to insert attachment audit rows:', attachInsertError.message);
      // Mark email log as failed — do NOT call Resend
      await supabase
        .from('crm_email_log')
        .update({ delivery_status: 'failed' })
        .eq('id', emailLogId);

      return NextResponse.json(
        {
          success: false,
          error: 'Email could not be sent. Please try again.',
          delivery_status: 'failed',
          email_log_id: emailLogId,
          // Audit insert itself failed — storage objects are still temporary
          attachmentState: 'temporary',
        },
        { status: 500 }
      );
    }

    // Audit rows successfully created — attachments are now part of the permanent audit trail
    attachmentsAudited = true;
  }

  // 10. Build outboundEmail attachments payload (base64 content, never URLs)
  const outboundAttachments = validatedAttachments.length > 0
    ? validatedAttachments.map((a) => ({
        filename: a.originalFilename,
        content: a.base64Content,
        mimeType: a.mimeType,
      }))
    : undefined;

  // 11. Attempt delivery via shared server helper (uses service_role → Edge Function)
  let deliveryStatus: 'sent' | 'failed' = 'failed';
  let resendId: string | null = null;
  let deliveryError: string | null = null;

  try {
    const result = await sendOutboundEmail({
      emailType: 'admin_direct_message',
      to: rawTo,
      subject: rawSubject,
      body: rawBodyText,
      replyTo,
      attachments: outboundAttachments,
    });
    deliveryStatus = 'sent';
    resendId = result.messageId;
  } catch (err: unknown) {
    deliveryStatus = 'failed';
    deliveryError = err instanceof Error ? err.message : 'Unknown delivery error';
  }

  // 12. Update the SAME crm_email_log row with actual delivery result
  await supabase
    .from('crm_email_log')
    .update({
      delivery_status: deliveryStatus,
      resend_id: resendId,
    })
    .eq('id', emailLogId);

  // 13. Create crm_activities ONLY on successful delivery
  if (deliveryStatus === 'sent') {
    await supabase.from('crm_activities').insert({
      contact_id: contactId,
      event_type: 'email_sent',
      title: 'Email sent',
      detail: `Subject: ${rawSubject}`,
      actor: adminDisplayName,
      actor_user_id: admin.id,
      metadata: {
        email_log_id: emailLogId,
        to_email: rawTo,
        resend_id: resendId,
        attachment_count: validatedAttachments.length,
      },
    });
  }

  // 14. Return truthful HTTP status
  if (deliveryStatus === 'failed') {
    return NextResponse.json(
      {
        success: false,
        error: 'Email could not be sent. Please try again.',
        delivery_status: 'failed',
        email_log_id: emailLogId,
        // After audit insert succeeded, attachments are permanently audited even though send failed
        ...(validatedAttachments.length > 0 ? { attachmentState: attachmentsAudited ? 'audited' : 'temporary' } : {}),
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    delivery_status: 'sent',
    email_log_id: emailLogId,
    resend_id: resendId,
    attachment_count: validatedAttachments.length,
    // Optionally signal audited state on success when attachments were present
    ...(validatedAttachments.length > 0 ? { attachmentState: 'audited' } : {}),
  });
}
