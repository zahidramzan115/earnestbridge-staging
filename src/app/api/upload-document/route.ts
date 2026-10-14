import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Server-side Supabase client with service role — bypasses all RLS
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

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get('file') as File | null;
    const applicationId = formData.get('applicationId') as string | null;
    const userId = formData.get('userId') as string | null;
    const documentName = formData.get('documentName') as string | null;
    const uploadedByRole = (formData.get('uploadedByRole') as string) || 'borrower';
    const uploaderEmail = formData.get('uploaderEmail') as string | null;

    if (!file || !applicationId || !userId) {
      return NextResponse.json(
        { error: 'Missing required fields: file, applicationId, userId' },
        { status: 400 }
      );
    }

    // Validate file type
    const ALLOWED_MIME_TYPES = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: 'File type not allowed. Please upload PDF, JPG, PNG, WEBP, or DOC files.' },
        { status: 400 }
      );
    }

    // Validate file size (50 MB)
    if (file.size > 52428800) {
      return NextResponse.json(
        { error: 'File exceeds 50 MB limit.' },
        { status: 400 }
      );
    }

    const supabase = getServiceClient();

    // Build storage path: userId/applicationId/timestamp.ext
    const ext = file.name.split('.').pop() ?? 'bin';
    const storagePath = `${userId}/${applicationId}/${Date.now()}.${ext}`;

    // Convert File to ArrayBuffer for upload
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to storage using service role (bypasses all RLS)
    const { error: uploadError } = await supabase.storage
      .from('borrower-documents')
      .upload(storagePath, buffer, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      console.error('[upload-document] Storage upload error:', uploadError);
      return NextResponse.json(
        { error: `Storage upload failed: ${uploadError.message}` },
        { status: 500 }
      );
    }

    // Generate a long-lived signed URL (1 year)
    const { data: signedData, error: signedError } = await supabase.storage
      .from('borrower-documents')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365);

    if (signedError) {
      console.error('[upload-document] Signed URL error:', signedError);
    }

    const fileUrl = signedData?.signedUrl ?? null;

    // Insert record into application_documents
    const { data: inserted, error: dbError } = await supabase
      .from('application_documents')
      .insert({
        application_id: applicationId,
        user_id: userId,
        uploaded_by_role: uploadedByRole,
        uploader_email: uploaderEmail,
        document_name: documentName || file.name.replace(/\.[^.]+$/, ''),
        file_name: file.name,
        file_url: fileUrl,
        storage_path: storagePath,
        file_size: file.size,
        mime_type: file.type,
        feedback: (formData.get('feedback') as string | null) || null,
        is_admin_response: uploadedByRole === 'admin',
        // Revision chain fields
        parent_document_id: (formData.get('parentDocumentId') as string | null) || null,
        revision_number: parseInt((formData.get('revisionNumber') as string | null) || '1', 10),
        thread_id: (formData.get('threadId') as string | null) || null,
        // Versioning fields (new in Step 3A)
        // document_group_id is auto-set by trigger if not provided
        document_group_id: (formData.get('documentGroupId') as string | null) || null,
        is_current_version: true,
        review_status: 'uploaded',
      })
      .select()
      .single();

    if (dbError) {
      console.error('[upload-document] DB insert error:', dbError);
      // Clean up the uploaded file since DB insert failed
      await supabase.storage.from('borrower-documents').remove([storagePath]);
      return NextResponse.json(
        { error: `Database insert failed: ${dbError.message}` },
        { status: 500 }
      );
    }

    // ── Send document upload confirmation emails (borrower + admin) ──────────
    // Fire-and-forget — never block the upload response
    if (uploadedByRole !== 'admin' && uploaderEmail) {
      // Fetch borrower name from the application record for the email
      try {
        const { data: appData } = await supabase
          .from('borrower_applications')
          .select('first_name, last_name, property_address')
          .eq('id', applicationId)
          .single();

        const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://earnestbri3677.builtwithrocket.new';
        fetch(`${baseUrl}/api/send-document-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            borrowerEmail: uploaderEmail,
            borrowerFirstName: appData?.first_name ?? '',
            borrowerLastName: appData?.last_name ?? '',
            documentName: documentName || file.name.replace(/\.[^.]+$/, ''),
            documentType: file.type.includes('pdf') ? 'PDF' : file.type.includes('image') ? 'Image' : 'Document',
            propertyAddress: appData?.property_address ?? '',
          }),
        }).catch(() => { /* non-fatal */ });
      } catch {
        // Non-fatal — don't block the upload response
      }
    }

    return NextResponse.json({ success: true, document: inserted, fileUrl, storagePath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[upload-document] Unexpected error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Also handle LOI/PSA uploads for the application form (borrower_documents table)
export async function PUT(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get('file') as File | null;
    const applicationId = formData.get('applicationId') as string | null;
    const userId = formData.get('userId') as string | null;
    const documentName = formData.get('documentName') as string | null;
    const documentType = (formData.get('documentType') as string) || 'other';
    const category = (formData.get('category') as string) || 'legal';

    if (!file || !userId) {
      return NextResponse.json(
        { error: 'Missing required fields: file, userId' },
        { status: 400 }
      );
    }

    const ALLOWED_MIME_TYPES = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: 'File type not allowed.' },
        { status: 400 }
      );
    }

    if (file.size > 52428800) {
      return NextResponse.json({ error: 'File exceeds 50 MB limit.' }, { status: 400 });
    }

    const supabase = getServiceClient();

    const ext = file.name.split('.').pop() ?? 'bin';
    const folder = applicationId ? `${userId}/${applicationId}` : `${userId}/misc`;
    const storagePath = `${folder}/${documentType}_${Date.now()}.${ext}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from('borrower-documents')
      .upload(storagePath, buffer, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: true,
      });

    if (uploadError) {
      console.error('[upload-document PUT] Storage error:', uploadError);
      return NextResponse.json(
        { error: `Storage upload failed: ${uploadError.message}` },
        { status: 500 }
      );
    }

    // Generate signed URL (1 year)
    const { data: signedData } = await supabase.storage
      .from('borrower-documents')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365);

    const fileUrl = signedData?.signedUrl ?? null;

    // Insert into borrower_documents if applicationId provided
    let inserted = null;
    if (applicationId) {
      const { data, error: dbError } = await supabase
        .from('borrower_documents')
        .insert({
          user_id: userId,
          application_id: applicationId,
          document_name: documentName || file.name.replace(/\.[^.]+$/, ''),
          document_type: documentType,
          category,
          file_url: fileUrl,
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type,
          doc_status: 'uploaded',
          uploaded_at: new Date().toISOString(),
          // Versioning fields (new in Step 3A)
          // document_group_id is auto-set by trigger if not provided
          is_current_version: true,
          review_status: 'uploaded',
        })
        .select()
        .single();

      if (dbError) {
        console.error('[upload-document PUT] DB error:', dbError);
        // Non-fatal — file is uploaded, just log
      } else {
        inserted = data;
      }
    }

    return NextResponse.json({ success: true, document: inserted, fileUrl, storagePath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[upload-document PUT] Unexpected error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE: Remove a document by ID (storage + DB)
export async function DELETE(req: NextRequest) {
  try {
    const { documentId, storagePath } = await req.json();

    if (!documentId) {
      return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });
    }

    const supabase = getServiceClient();

    // Remove from storage if path provided
    if (storagePath) {
      const { error: storageError } = await supabase.storage
        .from('borrower-documents')
        .remove([storagePath]);
      if (storageError) {
        console.error('[upload-document DELETE] Storage remove error:', storageError);
        // Non-fatal — continue to DB delete
      }
    }

    // Delete from application_documents
    const { error: dbError } = await supabase
      .from('application_documents')
      .delete()
      .eq('id', documentId);

    if (dbError) {
      console.error('[upload-document DELETE] DB delete error:', dbError);
      return NextResponse.json({ error: dbError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[upload-document DELETE] Unexpected error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
