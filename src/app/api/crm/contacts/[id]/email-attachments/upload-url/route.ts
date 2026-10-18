import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { randomUUID } from 'crypto';

// ── Constants ─────────────────────────────────────────────────────────────────

const BUCKET = 'email-attachments';
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const SIGNED_URL_EXPIRES_IN = 300; // 5 minutes — one-time short-lived upload token

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

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

/**
 * Sanitize filename to a safe basename.
 * - Strips directory components (slashes, backslashes, ../)
 * - Removes control characters
 * - Collapses whitespace
 * - Truncates to 200 chars
 */
function sanitizeFilename(raw: string): string {
  // Remove any directory traversal or path separators
  let safe = raw
    .replace(/\.\.\//g, '')
    .replace(/\.\.\\/g, '')
    .replace(/[/\\]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '') // control characters
    .trim();

  // Collapse multiple dots/spaces
  safe = safe.replace(/\s+/g, '_');

  // Truncate
  if (safe.length > 200) {
    const ext = safe.lastIndexOf('.');
    if (ext > 0) {
      const base = safe.substring(0, 190);
      const extension = safe.substring(ext);
      safe = base + extension;
    } else {
      safe = safe.substring(0, 200);
    }
  }

  return safe;
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

// ── POST /api/crm/contacts/[id]/email-attachments/upload-url ─────────────────
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1. Authenticate Admin
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Require app_metadata.role === 'admin'
  if (admin.app_metadata?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — Admin role required' }, { status: 403 });
  }

  const { id: contactId } = await params;

  // 3. Parse request body
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const filename = typeof rawBody.filename === 'string' ? rawBody.filename.trim() : '';
  const mimeType = typeof rawBody.mimeType === 'string' ? rawBody.mimeType.trim() : '';
  const sizeBytes = typeof rawBody.sizeBytes === 'number' ? rawBody.sizeBytes : -1;

  // 4. Validate filename
  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }

  const safeFilename = sanitizeFilename(filename);
  if (!safeFilename) {
    return NextResponse.json({ error: 'filename is invalid after sanitization' }, { status: 400 });
  }

  // 5. Validate MIME type
  if (!mimeType) {
    return NextResponse.json({ error: 'mimeType is required' }, { status: 400 });
  }

  if (!validateMimeAndExtension(mimeType, filename)) {
    return NextResponse.json(
      { error: `File type not allowed. Allowed types: PDF, Word (.doc/.docx), Excel (.xls/.xlsx), CSV, TXT, JPEG, PNG` },
      { status: 400 }
    );
  }

  // 6. Validate size
  if (sizeBytes <= 0) {
    return NextResponse.json({ error: 'sizeBytes must be a positive number' }, { status: 400 });
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: `File size exceeds the 5 MB per-file limit (received ${sizeBytes} bytes)` },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();

  // 7. Verify Contact exists
  const { data: contact, error: contactError } = await supabase
    .from('crm_contacts')
    .select('id')
    .eq('id', contactId)
    .eq('is_merged', false)
    .is('purged_at', null)
    .single();

  if (contactError || !contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  // 8. Generate server-controlled storage path
  // Pattern: uploads/{adminUserId}/{contactId}/{uuid}-{safeFilename}
  const objectUuid = randomUUID();
  const storagePath = `uploads/${admin.id}/${contactId}/${objectUuid}-${safeFilename}`;

  // 9. Create a short-lived signed upload URL via service_role
  const { data: signedData, error: signedError } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);

  if (signedError || !signedData) {
    console.error('[upload-url] Failed to create signed upload URL:', signedError?.message);
    return NextResponse.json(
      { error: 'Failed to generate upload URL. Please try again.' },
      { status: 500 }
    );
  }

  // 10. Return only what the browser UI needs — never expose service_role
  return NextResponse.json({
    signedUrl: signedData.signedUrl,
    token: signedData.token,
    storagePath,
    originalFilename: filename,
    mimeType,
    sizeBytes,
  });
}
