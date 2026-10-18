import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

const BUCKET = 'email-attachments';

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

// ── DELETE /api/crm/contacts/[id]/email-attachments ───────────────────────────
// Deletes an uploaded-but-unsent attachment from private storage.
// Used by future UI for "Remove attachment" and "Cancel compose" cleanup.
export async function DELETE(
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

  const storagePath = typeof rawBody.storagePath === 'string' ? rawBody.storagePath.trim() : '';

  if (!storagePath) {
    return NextResponse.json({ error: 'storagePath is required' }, { status: 400 });
  }

  // 4. Verify storage path belongs to current Admin + Contact prefix
  // Expected prefix: uploads/{adminUserId}/{contactId}/
  const expectedPrefix = `uploads/${admin.id}/${contactId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    // Do not reveal ownership details in error
    return NextResponse.json({ error: 'Forbidden — storage path not authorized' }, { status: 403 });
  }

  // 5. Prevent path traversal in the path itself
  if (storagePath.includes('..') || storagePath.includes('//')) {
    return NextResponse.json({ error: 'Invalid storage path' }, { status: 400 });
  }

  const supabase = getServiceClient();

  // 6. Verify Contact exists
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

  // 7. Block deletion if storage_path is already referenced by crm_email_attachments
  const { data: existingAudit, error: auditCheckError } = await supabase
    .from('crm_email_attachments')
    .select('id')
    .eq('storage_path', storagePath)
    .limit(1);

  if (auditCheckError) {
    console.error('[email-attachments DELETE] Audit check error:', auditCheckError.message);
    return NextResponse.json({ error: 'Failed to verify attachment status' }, { status: 500 });
  }

  if (existingAudit && existingAudit.length > 0) {
    return NextResponse.json(
      { error: 'Attachment has already been used in a sent email and cannot be deleted' },
      { status: 409 }
    );
  }

  // 8. Delete the private storage object via service_role
  const { error: deleteError } = await supabase.storage
    .from(BUCKET)
    .remove([storagePath]);

  if (deleteError) {
    console.error('[email-attachments DELETE] Storage delete error:', deleteError.message);
    return NextResponse.json(
      { error: 'Failed to delete attachment. Please try again.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
