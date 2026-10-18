import 'server-only';

export interface SendDocumentEmailInput {
  borrowerEmail: string;
  borrowerFirstName?: string;
  borrowerLastName?: string;
  documentName: string;
  documentType?: string;
  propertyAddress?: string;
}

export type SendDocumentEmailResult =
  | { ok: true; borrowerNotified: boolean; adminNotified: boolean }
  | { ok: false; error: string; status: number };

/**
 * Internal, server-only document-upload email behavior.
 *
 * Sends a confirmation to the borrower AND an alert to admin via the
 * send-borrower-emails Edge Function.
 *
 * This helper performs NO authentication or authorization. Callers (routes /
 * server code) MUST authorize before invoking it.
 */
export async function sendDocumentEmail(
  input: SendDocumentEmailInput
): Promise<SendDocumentEmailResult> {
  const {
    borrowerEmail,
    borrowerFirstName,
    borrowerLastName,
    documentName,
    documentType,
    propertyAddress,
  } = input;

  if (!borrowerEmail || !documentName) {
    return {
      ok: false,
      error: 'Missing required fields: borrowerEmail, documentName',
      status: 400,
    };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, error: 'Supabase configuration missing', status: 500 };
  }

  const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${supabaseAnonKey}`,
  };

  const borrower = {
    firstName: borrowerFirstName || '',
    lastName: borrowerLastName || '',
    email: borrowerEmail,
  };
  const application = {
    documentName,
    documentType: documentType || 'Document',
    propertyAddress: propertyAddress || '',
  };

  const borrowerPayload = { emailType: 'document_upload', borrower, application };
  const adminPayload = { emailType: 'admin_document_upload', borrower, application };

  // Send both emails in parallel
  const [borrowerResponse, adminResponse] = await Promise.allSettled([
    fetch(edgeFnUrl, { method: 'POST', headers, body: JSON.stringify(borrowerPayload) }),
    fetch(edgeFnUrl, { method: 'POST', headers, body: JSON.stringify(adminPayload) }),
  ]);

  const borrowerOk = borrowerResponse.status === 'fulfilled' && borrowerResponse.value.ok;
  const adminOk = adminResponse.status === 'fulfilled' && adminResponse.value.ok;

  if (!borrowerOk) {
    console.error('Borrower document email failed');
  }

  return { ok: true, borrowerNotified: borrowerOk, adminNotified: adminOk };
}
