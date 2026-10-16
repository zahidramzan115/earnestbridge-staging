// Step 5D-2.9c: Redeployed to fix stale runtime missing Option Cycle email types.
// All 10 Option Cycle emailTypes now present: client_reminder_7d/5d/3d/1d,
// admin_reminder_7d/5d/3d/1d, option_client_closeout, option_admin_closeout.
// Step 5E-2: Added invoice_issued emailType with internal secret gate, full
// validation, deterministic branded email, PDF attachment, Idempotency-Key
// header to Resend, and structured sent/failed/uncertain outcomes.
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const ADMIN_EMAIL = "admin@earnestbridge.com";
const FROM_EMAIL = "EarnestBridge <admin@earnestbridge.com>";

// ─── Shared timing-safe string comparison ────────────────────────────────────
// Used by both admin_direct_message and invoice_issued internal-secret gates.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

// ─── HTML escape helper (invoice_issued only) ─────────────────────────────────
// Prevents HTML injection when interpolating caller-provided display values
// into the invoice email body. Used ONLY for invoice_issued rendering.
// Does NOT alter canonical values used for idempotency, filenames, or subjects.
function escapeHtmlForInvoice(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Deterministic invoice footer (invoice_issued only) ───────────────────────
// Contains NO runtime date, year, or timestamp so the Resend payload remains
// byte-for-byte identical across retries using the same Idempotency-Key.
// brandedFooter (which contains new Date().getFullYear()) is NOT used here.
const invoiceFooterStyle = `
  margin-top: 36px;
  padding-top: 20px;
  border-top: 1px solid #e5e7eb;
  font-size: 12px;
  color: #9ca3af;
  text-align: center;
  line-height: 1.7;
`;
const invoiceDeterministicFooter = `
  <div style="${invoiceFooterStyle}">
    <p style="margin: 0 0 6px;">
      <strong style="color: #6b7280;">EarnestBridge</strong> — EMD Financing for Real Estate Professionals
    </p>
    <p style="margin: 0 0 6px;">
      Questions? Contact us at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; text-decoration: none;">admin@earnestbridge.com</a>
    </p>
    <p style="margin: 0;">EarnestBridge. All rights reserved. This is an automated message — please do not reply directly.</p>
  </div>
`;

// ─── Shared internal-secret gate ─────────────────────────────────────────────
// Returns true if the request passes the internal secret check.
// Used by admin_direct_message and invoice_issued.
function checkInternalSecret(req: Request): boolean {
  const internalSecret = (globalThis as any).Deno?.env?.get("EB_EMAIL_INTERNAL_SECRET") ?? "";
  const requestSecret = req.headers.get("X-EB-Email-Secret") ?? "";
  const internalSecretMissing = !internalSecret || internalSecret.trim().length === 0;
  const requestSecretMissing = !requestSecret || requestSecret.trim().length === 0;
  if (internalSecretMissing || requestSecretMissing) return false;
  return timingSafeEqual(internalSecret, requestSecret);
}

serve(async (req) => {
  // ✅ CORS preflight
  if (req?.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  try {
    const body = await req?.json();
    const { emailType, borrower, application } = body;

    const RESEND_API_KEY = (globalThis as any).Deno?.env?.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set");
    }

    // Admin email types don't require borrower.email
    const isAdminEmail = emailType?.startsWith("admin_");

    if (!emailType) {
      throw new Error("Missing required field: emailType");
    }
    if (!isAdminEmail && emailType !== "invoice_issued" && emailType !== "receipt_issued" && !borrower?.email) {
      throw new Error("Missing required field: borrower.email");
    }

    let subject = "";
    let htmlBody = "";
    let toEmail: string[] = [];

    const baseStyle = `
      font-family: 'Helvetica Neue', Arial, sans-serif;
      max-width: 600px;
      margin: 0 auto;
      color: #1f2937;
      background: #f3f4f6;
      padding: 24px 16px;
    `;

    const headerStyle = `
      background: linear-gradient(135deg, #1B4332 0%, #2d6a4f 100%);
      padding: 28px 36px;
      border-radius: 10px 10px 0 0;
    `;

    const adminHeaderStyle = `
      background: linear-gradient(135deg, #173F35 0%, #2d6a4f 100%);
      padding: 28px 36px;
      border-radius: 10px 10px 0 0;
    `;

    const bodyStyle = `
      background: #ffffff;
      padding: 36px;
      border: 1px solid #e5e7eb;
      border-top: none;
      border-radius: 0 0 10px 10px;
    `;

    const footerStyle = `
      margin-top: 36px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
      text-align: center;
      line-height: 1.7;
    `;

    const btnStyle = `
      display: inline-block;
      background: #1B4332;
      color: #ffffff !important;
      padding: 13px 28px;
      border-radius: 7px;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      margin-top: 20px;
      letter-spacing: 0.02em;
    `;

    const adminBtnStyle = `
      display: inline-block;
      background: #173F35;
      color: #ffffff !important;
      padding: 13px 28px;
      border-radius: 7px;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      margin-top: 20px;
      letter-spacing: 0.02em;
    `;

    const appUrl = (globalThis as any).Deno?.env?.get("NEXT_PUBLIC_SITE_URL") || "https://app.earnestbridge.com";

    const brandedHeader = `
      <div style="${headerStyle}">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td>
              <div style="font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">EarnestBridge</div>
              <div style="font-size: 12px; color: #86efac; margin-top: 3px; letter-spacing: 0.05em; text-transform: uppercase;">EMD Financing Platform</div>
            </td>
            <td style="text-align: right;">
              <div style="background: rgba(255,255,255,0.15); border-radius: 6px; padding: 6px 12px; display: inline-block;">
                <span style="color: #86efac; font-size: 11px; font-weight: 600; letter-spacing: 0.08em;">EARNEST MONEY DEPOSIT</span>
              </div>
            </td>
          </tr>
        </table>
      </div>
    `;

    const adminBrandedHeader = (subtitle: string) => `
      <div style="${adminHeaderStyle}">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td>
              <div style="font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">EarnestBridge</div>
              <div style="font-size: 12px; color: #C9A227; margin-top: 3px; letter-spacing: 0.05em; text-transform: uppercase;">Admin Portal</div>
            </td>
            <td style="text-align: right;">
              <div style="background: rgba(255,255,255,0.15); border-radius: 6px; padding: 6px 12px; display: inline-block;">
                <span style="color: #C9A227; font-size: 11px; font-weight: 600; letter-spacing: 0.08em;">${subtitle}</span>
              </div>
            </td>
          </tr>
        </table>
      </div>
      <div style="height: 3px; background: linear-gradient(90deg, #C9A227 0%, #e8c84a 50%, #C9A227 100%);"></div>
    `;

    const brandedFooter = `
      <div style="${footerStyle}">
        <p style="margin: 0 0 6px;">
          <strong style="color: #6b7280;">EarnestBridge</strong> — EMD Financing for Real Estate Professionals
        </p>
        <p style="margin: 0 0 6px;">
          Questions? Contact us at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; text-decoration: none;">admin@earnestbridge.com</a>
        </p>
        <p style="margin: 0;">© ${new Date().getFullYear()} EarnestBridge. All rights reserved. This is an automated message — please do not reply directly.</p>
      </div>
    `;

    const adminBrandedFooter = `
      <div style="${footerStyle}">
        <p style="margin: 0 0 6px;">
          <strong style="color: #6b7280;">EarnestBridge Admin</strong> — Internal Notification
        </p>
        <p style="margin: 0;">© ${new Date().getFullYear()} EarnestBridge. Do not forward this message.</p>
      </div>
    `;

    // ─── EMAIL TYPE: Application Submission Confirmation (Borrower) ────────────
    if (emailType === "application_submitted") {
      toEmail = [borrower.email];
      subject = "Application Received — EarnestBridge EMD Financing";
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Application Received ✓</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName},</p>
            <p style="color: #374151; line-height: 1.7;">
              Thank you for submitting your EMD financing application. We have received your request
              and our team will review it within <strong>24 business hours</strong>.
            </p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #1B4332; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Application Summary</h3>
              <table style="width: 100%; border-collapse: collapse;">
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; width: 45%; font-size: 14px;">Property Address</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
                ${application?.depositAmount ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">EMD Amount</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px; color: #16a34a;">$${Number(application.depositAmount).toLocaleString()}</td></tr>` : ""}
                ${application?.purchasePrice ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Purchase Price</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">$${Number(application.purchasePrice).toLocaleString()}</td></tr>` : ""}
                ${application?.closingDate ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Target Closing Date</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.closingDate}</td></tr>` : ""}
              </table>
            </div>

            <p style="color: #374151; line-height: 1.7;">
              You can track the status of your application at any time by logging into your
              EarnestBridge account.
            </p>
            <a href="${appUrl}/application-status" style="${btnStyle}">Track Application Status →</a>

            <p style="margin-top: 28px; color: #374151; line-height: 1.7;">
              If you have any questions, please reach out to us at
              <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a>.
            </p>
            <p style="color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Milestone / Status Update (Borrower) ─────────────────────
    else if (emailType === "status_update") {
      toEmail = [borrower.email];
      const statusLabels: Record<string, string> = {
        application: "Application Received",
        under_review: "Under Review",
        approved: "Approved ✓",
        in_progress: "In Progress",
        funded: "Funded ✓",
        closed: "Closed",
        rejected: "Decision Made",
        // legacy fallbacks
        submitted: "Application Received",
        in_review: "Under Review",
        conditionally_approved: "Approved ✓",
      };

      const statusColors: Record<string, string> = {
        application: "#6b7280",
        under_review: "#d97706",
        approved: "#16a34a",
        in_progress: "#2563eb",
        funded: "#059669",
        closed: "#374151",
        rejected: "#dc2626",
        submitted: "#6b7280",
        in_review: "#d97706",
        conditionally_approved: "#16a34a",
      };

      const statusLabel = statusLabels[application?.newStatus] || application?.newStatus || "Updated";
      const statusColor = statusColors[application?.newStatus] || "#1B4332";

      subject = `Deal Update: ${statusLabel} — EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Deal Status Update</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName},</p>
            <p style="color: #374151; line-height: 1.7;">Your EMD financing deal has been updated. Here is the latest status:</p>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-left: 4px solid ${statusColor}; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Current Stage</p>
              <p style="margin: 6px 0 0; font-size: 22px; font-weight: 800; color: ${statusColor};">${statusLabel}</p>
              ${application?.milestoneLabel ? `<p style="margin: 8px 0 0; font-size: 13px; color: #6b7280;">Phase: ${application.milestoneLabel}</p>` : ""}
              ${application?.propertyAddress ? `<p style="margin: 6px 0 0; font-size: 13px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
            </div>

            ${application?.newStatus === "application" ? `
            <p style="color: #374151; line-height: 1.7;">Your application has been received and is in our queue. Our team will begin reviewing it shortly and will notify you of any updates.</p>` : ""}

            ${application?.newStatus === "under_review" ? `
            <p style="color: #374151; line-height: 1.7;">Our team is actively reviewing your application. We will notify you of any updates or if we need additional information.</p>` : ""}

            ${application?.newStatus === "approved" ? `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <p style="margin: 0; color: #166534; font-weight: 700; font-size: 15px;">🎉 Congratulations — Your Deal is Approved!</p>
              <p style="margin: 10px 0 0; color: #166534; line-height: 1.7;">
                Your EMD financing application has been approved. Our team will be in touch shortly to discuss
                next steps, including document signing and finalizing the EMD financing arrangement.
              </p>
            </div>` : ""}

            ${application?.newStatus === "funded" ? `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <p style="margin: 0; color: #166534; font-weight: 700; font-size: 15px;">🏦 EMD Funded — Funds Transferred to Escrow</p>
              <p style="margin: 10px 0 0; color: #166534; line-height: 1.7;">
                Your earnest money deposit has been funded and transferred to escrow. Your deal is now active.
                Please ensure all remaining conditions are met before your closing date.
              </p>
            </div>` : ""}

            ${application?.message ? `
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-size: 14px; color: #374151; line-height: 1.7;">${application.message}</p>
            </div>` : ""}

            <a href="${appUrl}/application-status" style="${btnStyle}">View Full Deal Status →</a>

            <p style="margin-top: 28px; color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Deadline Reminder (Borrower) ──────────────────────────────
    else if (emailType === "deadline_reminder") {
      toEmail = [borrower.email];
      const daysLeft = application?.daysUntilClosing ?? 0;
      const daysUntilOptionExpires = application?.daysUntilOptionExpires ?? Math.max(0, daysLeft - 2);
      const urgencyColor = daysLeft <= 2 ? "#dc2626" : daysLeft <= 5 ? "#d97706" : "#2563eb";
      const urgencyBg = daysLeft <= 2 ? "#fef2f2" : daysLeft <= 5 ? "#fffbeb" : "#eff6ff";
      const urgencyBorder = daysLeft <= 2 ? "#fecaca" : daysLeft <= 5 ? "#fde68a" : "#bfdbfe";

      subject = `⏰ Action Required: Closing in ${daysLeft} Day${daysLeft !== 1 ? "s" : ""} — EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Closing Date Reminder</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName},</p>
            <p style="color: #374151; line-height: 1.7;">This is your daily reminder that your PSA closing date is approaching and action may be required.</p>

            <div style="background: ${urgencyBg}; border: 1px solid ${urgencyBorder}; border-radius: 8px; padding: 20px; margin: 28px 0; text-align: center;">
              <p style="margin: 0; font-size: 15px; color: ${urgencyColor}; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800;">
                ${daysLeft === 0 ? "⚠️ Closing Date is Today!" : daysLeft === 1 ? "⚠️ Closing Date is Tomorrow!" : `⏰ ${daysLeft} Days Until Closing`}
              </p>
              ${application?.closingDate ? `<p style="margin: 10px 0 0; font-size: 20px; font-weight: 800; color: #111827;">${application.closingDate}</p>` : ""}
              ${application?.propertyAddress ? `<p style="margin: 6px 0 0; font-size: 14px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
            </div>

            <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-size: 13px; color: #92400e; font-weight: 700;">⚠️ Option Period Expires in ${daysUntilOptionExpires} Day${daysUntilOptionExpires !== 1 ? "s" : ""}</p>
              <p style="margin: 8px 0 0; font-size: 13px; color: #78350f; line-height: 1.7;">
                Your option period expires <strong>2 days before closing</strong>. If you need more time, you must sign an extension
                <strong>before the option period expires</strong> — otherwise your EMD will be returned to EarnestBridge and the deal will be automatically closed.
              </p>
            </div>

            <p style="color: #374151; line-height: 1.7;">Please ensure the following are complete before your closing date:</p>
            <ul style="color: #374151; line-height: 2; padding-left: 20px;">
              <li>All PSA documents are uploaded and signed</li>
              <li>LLC formation is complete (if applicable)</li>
              <li>Attorney information is confirmed</li>
              <li>Identity verification is complete</li>
              <li>W-9, MOU, and Option Agreement are signed</li>
            </ul>

            <a href="${appUrl}/application-status" style="${btnStyle}">Review Application Checklist →</a>

            <p style="margin-top: 28px; color: #374151; line-height: 1.7;">
              If you need to request an extension or have questions about your closing timeline,
              please contact us <strong>immediately</strong> at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a>.
            </p>
            <p style="color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Document Upload Confirmation (Borrower) ──────────────────
    else if (emailType === "document_upload") {
      toEmail = [borrower.email];
      subject = "Document Received — EarnestBridge EMD Financing";
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Document Received ✓</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName},</p>
            <p style="color: #374151; line-height: 1.7;">We have successfully received your document upload for your EMD financing deal.</p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #1B4332; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Upload Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                ${application?.documentName ? `<tr><td style="padding: 7px 0; color: #6b7280; width: 45%; font-size: 14px;">Document</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.documentName}</td></tr>` : ""}
                ${application?.documentType ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Type</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.documentType}</td></tr>` : ""}
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Uploaded At</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td></tr>
              </table>
            </div>

            <p style="color: #374151; line-height: 1.7;">Our team will review your document and update your deal status accordingly. You can track your deal progress at any time.</p>

            <a href="${appUrl}/application-status" style="${btnStyle}">View Deal Status →</a>

            <p style="margin-top: 28px; color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── ADMIN EMAIL TYPE: New Application Submitted ───────────────────────────
    else if (emailType === "admin_new_application") {
      toEmail = [ADMIN_EMAIL];
      subject = `🆕 New Deal Submitted — ${borrower?.firstName || ""} ${borrower?.lastName || ""} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("NEW DEAL ALERT")}
          <div style="${bodyStyle}">
            <h2 style="color: #1e3a5f; margin-top: 0; font-size: 20px;">New Deal Submitted</h2>
            <p style="color: #374151; line-height: 1.7;">A new EMD financing deal has been submitted and requires your review.</p>

            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-left: 4px solid #2563eb; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #1e3a5f; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Borrower Information</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">Name</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${borrower?.firstName || ""} ${borrower?.lastName || ""}</td></tr>
                ${borrower?.email ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Email</td><td style="padding: 7px 0; font-size: 14px;"><a href="mailto:${borrower.email}" style="color: #2563eb; font-weight: 600;">${borrower.email}</a></td></tr>` : ""}
                ${borrower?.phone ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Phone</td><td style="padding: 7px 0; font-size: 14px;">${borrower.phone}</td></tr>` : ""}
                ${borrower?.companyName ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Company</td><td style="padding: 7px 0; font-size: 14px;">${borrower.companyName}</td></tr>` : ""}
              </table>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <h3 style="color: #374151; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Deal Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">Property Address</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
                ${application?.propertyType ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property Type</td><td style="padding: 7px 0; font-size: 14px;">${application.propertyType}</td></tr>` : ""}
                ${application?.depositAmount ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">EMD Amount</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px; color: #16a34a;">$${Number(application.depositAmount).toLocaleString()}</td></tr>` : ""}
                ${application?.purchasePrice ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Purchase Price</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">$${Number(application.purchasePrice).toLocaleString()}</td></tr>` : ""}
                ${application?.closingDate ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Closing Date</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.closingDate}</td></tr>` : ""}
                ${application?.newStatus ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Stage</td><td style="padding: 7px 0; font-size: 14px;">${application.statusLabel || application.newStatus}</td></tr>` : ""}
              </table>
            </div>

            <a href="${appUrl}/admin/deals" style="${adminBtnStyle}">Review in Admin Dashboard →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── ADMIN EMAIL TYPE: Stage Transition Alert ──────────────────────────────
    else if (emailType === "admin_stage_transition") {
      toEmail = [ADMIN_EMAIL];
      const stageLabels: Record<string, string> = {
        application: "Application",
        under_review: "Under Review",
        approved: "Approved",
        in_progress: "In Progress",
        funded: "Funded",
        closed: "Closed",
        rejected: "Rejected",
      };
      const stageLabel = stageLabels[application?.newStatus] || application?.newStatus || "Updated";
      const stageColors: Record<string, string> = {
        application: "#6b7280",
        under_review: "#d97706",
        approved: "#16a34a",
        in_progress: "#2563eb",
        funded: "#059669",
        closed: "#374151",
        rejected: "#dc2626",
      };
      const stageColor = stageColors[application?.newStatus] || "#1B4332";

      subject = `🔄 Deal Stage Updated: ${stageLabel} — ${borrower?.firstName || ""} ${borrower?.lastName || ""} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("STAGE TRANSITION")}
          <div style="${bodyStyle}">
            <h2 style="color: #1e3a5f; margin-top: 0; font-size: 20px;">Deal Stage Updated</h2>
            <p style="color: #374151; line-height: 1.7;">A deal has been moved to a new stage.</p>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-left: 4px solid ${stageColor}; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">New Stage</p>
              <p style="margin: 6px 0 0; font-size: 22px; font-weight: 800; color: ${stageColor};">${stageLabel}</p>
            </div>

            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <h3 style="color: #1e3a5f; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Borrower & Deal</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">Borrower</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${borrower?.firstName || ""} ${borrower?.lastName || ""}</td></tr>
                ${borrower?.email ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Email</td><td style="padding: 7px 0; font-size: 14px;"><a href="mailto:${borrower.email}" style="color: #2563eb; font-weight: 600;">${borrower.email}</a></td></tr>` : ""}
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property</td><td style="padding: 7px 0; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
              </table>
            </div>

            <a href="${appUrl}/admin/deals" style="${adminBtnStyle}">View in Admin Dashboard →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── ADMIN EMAIL TYPE: Document Upload Alert ───────────────────────────────
    else if (emailType === "admin_document_upload") {
      toEmail = [ADMIN_EMAIL];
      subject = `📎 Document Uploaded — ${borrower?.firstName || ""} ${borrower?.lastName || ""} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("DOCUMENT UPLOAD ALERT")}
          <div style="${bodyStyle}">
            <h2 style="color: #1e3a5f; margin-top: 0; font-size: 20px;">Document Uploaded by Borrower</h2>
            <p style="color: #374151; line-height: 1.7;">A borrower has uploaded a document to their EMD financing deal.</p>

            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-left: 4px solid #2563eb; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #1e3a5f; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Borrower</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">Name</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${borrower?.firstName || ""} ${borrower?.lastName || ""}</td></tr>
                ${borrower?.email ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Email</td><td style="padding: 7px 0; font-size: 14px;"><a href="mailto:${borrower.email}" style="color: #2563eb; font-weight: 600;">${borrower.email}</a></td></tr>` : ""}
              </table>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <h3 style="color: #374151; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Document Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                ${application?.documentName ? `<tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">File Name</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${application.documentName}</td></tr>` : ""}
                ${application?.documentType ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Document Type</td><td style="padding: 7px 0; font-size: 14px;">${application.documentType}</td></tr>` : ""}
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property</td><td style="padding: 7px 0; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Uploaded At</td><td style="padding: 7px 0; font-size: 14px;">${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td></tr>
              </table>
            </div>

            <a href="${appUrl}/admin/deals" style="${adminBtnStyle}">View in Admin Dashboard →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── ADMIN EMAIL TYPE: Deadline Reminder Alert ─────────────────────────────
    else if (emailType === "admin_deadline_reminder") {
      toEmail = [ADMIN_EMAIL];
      const daysLeft = application?.daysUntilClosing ?? 0;
      const daysUntilOptionExpires = application?.daysUntilOptionExpires ?? Math.max(0, daysLeft - 2);
      const urgencyColor = daysLeft <= 2 ? "#dc2626" : daysLeft <= 5 ? "#d97706" : "#2563eb";
      const urgencyBg = daysLeft <= 2 ? "#fef2f2" : daysLeft <= 5 ? "#fffbeb" : "#eff6ff";
      const urgencyBorder = daysLeft <= 2 ? "#fecaca" : daysLeft <= 5 ? "#fde68a" : "#bfdbfe";

      subject = `⏰ Closing in ${daysLeft} Day${daysLeft !== 1 ? "s" : ""} — ${borrower?.firstName || ""} ${borrower?.lastName || ""} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("CLOSING DEADLINE ALERT")}
          <div style="${bodyStyle}">
            <h2 style="color: #1e3a5f; margin-top: 0; font-size: 20px;">Borrower Closing Deadline Approaching</h2>
            <p style="color: #374151; line-height: 1.7;">A borrower's PSA closing date is approaching and may require your attention.</p>

            <div style="background: ${urgencyBg}; border: 1px solid ${urgencyBorder}; border-radius: 8px; padding: 20px; margin: 28px 0; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: ${urgencyColor}; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;">
                ${daysLeft === 0 ? "⚠️ Closing Date is TODAY" : daysLeft === 1 ? "⚠️ Closing Date is TOMORROW" : `⏰ ${daysLeft} Days Until Closing`}
              </p>
              ${application?.closingDate ? `<p style="margin: 10px 0 0; font-size: 20px; font-weight: 800; color: #111827;">${application.closingDate}</p>` : ""}
              <p style="margin: 8px 0 0; font-size: 13px; color: ${urgencyColor}; font-weight: 600;">Option period expires in ${daysUntilOptionExpires} day${daysUntilOptionExpires !== 1 ? "s" : ""}</p>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <h3 style="color: #374151; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Borrower & Deal</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">Borrower</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${borrower?.firstName || ""} ${borrower?.lastName || ""}</td></tr>
                ${borrower?.email ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Email</td><td style="padding: 7px 0; font-size: 14px;"><a href="mailto:${borrower.email}" style="color: #2563eb; font-weight: 600;">${borrower.email}</a></td></tr>` : ""}
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property</td><td style="padding: 7px 0; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
                ${application?.depositAmount ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">EMD Amount</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px; color: #16a34a;">$${Number(application.depositAmount).toLocaleString()}</td></tr>` : ""}
              </table>
            </div>

            <a href="${appUrl}/admin/deals" style="${adminBtnStyle}">Review in Admin Dashboard →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Email Verification (Borrower) ────────────────────────────
    else if (emailType === "email_verification") {
      toEmail = [borrower.email];
      subject = "Verify Your Email — EarnestBridge";
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Verify Your Email Address</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName || "there"},</p>
            <p style="color: #374151; line-height: 1.7;">
              Thank you for creating your EarnestBridge borrower account. To activate your account
              and access the borrower portal, please verify your email address by clicking the
              button below.
            </p>

            <div style="text-align: center; margin: 36px 0;">
              <a href="${application?.verificationLink}" style="${btnStyle}; font-size: 15px; padding: 16px 36px;">
                Verify My Email Address →
              </a>
            </div>

            <p style="font-size: 13px; color: #6b7280; line-height: 1.7;">
              If the button above doesn't work, copy and paste this link into your browser:
            </p>
            <p style="font-size: 12px; word-break: break-all; color: #2563eb; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; line-height: 1.6;">
              ${application?.verificationLink}
            </p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 24px 0;">
              <p style="margin: 0; font-size: 13px; color: #166534; line-height: 1.7;">
                <strong>Why verify?</strong> Email verification keeps your account secure and ensures
                you receive important updates about your EMD financing deals.
              </p>
            </div>

            <p style="font-size: 13px; color: #6b7280; line-height: 1.7;">
              This link will expire in 24 hours. If you did not create an EarnestBridge account,
              you can safely ignore this email.
            </p>

            <p style="color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Document Approved (Borrower) ─────────────────────────────
    else if (emailType === "document_approved") {
      toEmail = [borrower.email];
      subject = `Document Approved — ${application?.documentName || "Your Document"} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Document Approved ✓</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName},</p>
            <p style="color: #374151; line-height: 1.7;">Great news! Our team has reviewed and <strong>approved</strong> the following document for your EMD financing deal.</p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #16a34a; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Approved Document</p>
              <p style="margin: 8px 0 0; font-size: 17px; font-weight: 800; color: #166534;">${application?.documentName || "Document"}</p>
              ${application?.propertyAddress ? `<p style="margin: 6px 0 0; font-size: 13px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
            </div>

            ${application?.feedbackNote ? `
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Admin Note</p>
              <p style="margin: 10px 0 0; font-size: 14px; color: #374151; line-height: 1.7;">${application.feedbackNote}</p>
            </div>` : ""}

            <p style="color: #374151; line-height: 1.7;">You can log in to your EarnestBridge account to view the full status of your deal and any remaining document requirements.</p>
            <a href="${appUrl}/application-status" style="${btnStyle}">View Deal Status →</a>

            <p style="margin-top: 28px; color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>
            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Document Rejected (Borrower) ─────────────────────────────
    else if (emailType === "document_rejected") {
      toEmail = [borrower.email];
      subject = `Action Required: Document Rejected — ${application?.documentName || "Your Document"} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Document Rejected</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName},</p>
            <p style="color: #374151; line-height: 1.7;">After reviewing your submission, our team was unable to accept the following document for your EMD financing deal.</p>

            <div style="background: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Rejected Document</p>
              <p style="margin: 8px 0 0; font-size: 17px; font-weight: 800; color: #991b1b;">${application?.documentName || "Document"}</p>
              ${application?.propertyAddress ? `<p style="margin: 6px 0 0; font-size: 13px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
            </div>

            ${application?.feedbackNote ? `
            <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-size: 11px; color: #92400e; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Reason for Rejection</p>
              <p style="margin: 10px 0 0; font-size: 14px; color: #374151; line-height: 1.7;">${application.feedbackNote}</p>
            </div>` : ""}

            <p style="color: #374151; line-height: 1.7;">Please contact our team at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a> if you have questions or need clarification on what is required.</p>
            <a href="${appUrl}/documents" style="${btnStyle}">Go to My Documents →</a>

            <p style="margin-top: 28px; color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>
            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Document Resubmission Requested (Borrower) ───────────────
    else if (emailType === "document_resubmit_requested") {
      toEmail = [borrower.email];
      subject = `Action Required: Please Resubmit — ${application?.documentName || "Your Document"} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Document Resubmission Required</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName},</p>
            <p style="color: #374151; line-height: 1.7;">Our team has reviewed your document and is requesting a resubmission with corrections or additional information.</p>

            <div style="background: #fff7ed; border: 1px solid #fed7aa; border-left: 4px solid #ea580c; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Document Requiring Resubmission</p>
              <p style="margin: 8px 0 0; font-size: 17px; font-weight: 800; color: #9a3412;">${application?.documentName || "Document"}</p>
              ${application?.propertyAddress ? `<p style="margin: 6px 0 0; font-size: 13px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
            </div>

            ${application?.feedbackNote ? `
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">What Needs to Be Corrected</p>
              <p style="margin: 10px 0 0; font-size: 14px; color: #374151; line-height: 1.7;">${application.feedbackNote}</p>
            </div>` : ""}

            <p style="color: #374151; line-height: 1.7;">Please log in to your EarnestBridge account and upload the corrected document at your earliest convenience to avoid delays in processing your deal.</p>
            <a href="${appUrl}/documents" style="${btnStyle}">Upload Corrected Document →</a>

            <p style="margin-top: 28px; color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>
            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Document Revision Requested (Borrower) ───────────────────
    else if (emailType === "document_revision_requested") {
      toEmail = [borrower.email];
      subject = `Action Needed: Document Revision Requested — EarnestBridge`;
      const documentsUrl = application?.documentsUrl || `${appUrl}/documents`;
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Document Revision Requested</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName || "there"},</p>
            <p style="color: #374151; line-height: 1.7;">
              We need an updated version of the following document for your EarnestBridge deal.
            </p>

            <div style="background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #d97706; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Document</p>
              <p style="margin: 8px 0 0; font-size: 17px; font-weight: 800; color: #92400e;">${application?.documentName || "Document"}</p>
              ${application?.propertyAddress ? `<p style="margin: 6px 0 0; font-size: 13px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
            </div>

            ${application?.clientRevisionMessage ? `
            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Requested Update</p>
              <p style="margin: 10px 0 0; font-size: 14px; color: #374151; line-height: 1.7;">${application.clientRevisionMessage}</p>
            </div>` : ""}

            <p style="color: #374151; line-height: 1.7;">
              Please log in to your EarnestBridge account to review the request and upload the updated document.
            </p>
            <a href="${documentsUrl}" style="${btnStyle}">VIEW DOCUMENT REQUEST →</a>

            <p style="margin-top: 28px; color: #374151; line-height: 1.7;">
              If you have questions, contact us at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a>.
            </p>
            <p style="color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>
            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: BPCON26 Promo Email (Claimant) ───────────────────────────
    else if (emailType === "bpcon26_promo_email") {
      toEmail = [borrower.email];
      subject = "Your $1,250 EarnestBridge BPCON26 Savings";
      const promoCode = application?.promoCode || "";
      const standardFee = application?.standardFee ?? 2500;
      const promoFee = application?.promoFee ?? 1250;
      const savings = application?.savings ?? 1250;
      const submitDealUrl = `https://earnestbridge.com/contact?promo_code=${encodeURIComponent(promoCode)}&utm_source=bpcon26&utm_medium=promo_email&utm_campaign=bpcon26`;

      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 22px;">Your BPCON26 Promo Code 🎉</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName || "there"},</p>
            <p style="color: #374151; line-height: 1.7;">
              Thank you for connecting with EarnestBridge at BPCON26! Your exclusive promotional
              discount has been reserved. Here are your savings details:
            </p>

            <div style="background: #f0fdf4; border: 2px solid #16a34a; border-radius: 10px; padding: 28px; margin: 28px 0; text-align: center;">
              <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600;">Your Promo Code</p>
              <p style="margin: 0; font-size: 32px; font-weight: 900; color: #1B4332; letter-spacing: 0.08em; font-family: 'Courier New', monospace;">${promoCode}</p>
              <p style="margin: 12px 0 0; font-size: 13px; color: #16a34a; font-weight: 600;">Save $${savings.toLocaleString()} on your Admin Fee</p>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <h3 style="color: #374151; margin: 0 0 16px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Pricing Summary</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Standard Admin Fee</td>
                  <td style="padding: 8px 0; font-size: 14px; text-align: right; text-decoration: line-through; color: #9ca3af;">$${standardFee.toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">BPCON26 Promotional Fee</td>
                  <td style="padding: 8px 0; font-size: 16px; font-weight: 800; text-align: right; color: #1B4332;">$${promoFee.toLocaleString()}</td>
                </tr>
                <tr style="border-top: 1px solid #e5e7eb;">
                  <td style="padding: 10px 0 0; color: #16a34a; font-size: 14px; font-weight: 700;">Your Savings</td>
                  <td style="padding: 10px 0 0; font-size: 16px; font-weight: 800; text-align: right; color: #16a34a;">$${savings.toLocaleString()} (50% off)</td>
                </tr>
              </table>
            </div>

            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 20px 0;">
              <h3 style="color: #92400e; margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Important Terms</h3>
              <ul style="margin: 0; padding-left: 18px; color: #374151; font-size: 13px; line-height: 1.8;">
                <li>No expiration date — use when you are ready</li>
                <li>One redemption per promo code</li>
                <li>Available to new and existing EarnestBridge clients</li>
                <li>EMD financing subject to approval</li>
              </ul>
            </div>

            <p style="color: #374151; line-height: 1.7;">
              Ready to submit a deal? Click below and your promo code will be pre-filled.
            </p>
            <a href="${submitDealUrl}" style="${btnStyle}">Submit a Deal & Apply Promo →</a>

            <p style="margin-top: 28px; color: #374151; line-height: 1.7;">
              Questions? Reach us at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a>.
            </p>
            <p style="color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── ADMIN EMAIL TYPE: BPCON26 Promo Claimed Notification ─────────────────
    else if (emailType === "admin_bpcon26_promo_claimed") {
      toEmail = [ADMIN_EMAIL];
      const contactName = `${borrower.firstName || ""} ${borrower.lastName || ""}`.trim() || borrower.email;
      const actionLabel = application?.isExistingPromo ? "RESENT" : "NEW CLAIM";
      subject = `BPCON26 Promo ${actionLabel} — ${contactName}`;

      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("BPCON26 PROMO")}
          <div style="${bodyStyle}">
            <h2 style="color: #1e3a5f; margin-top: 0; font-size: 20px;">
              BPCON26 Promo ${application?.isExistingPromo ? "Resent" : "Claimed"} — ${contactName}
            </h2>
            <p style="color: #374151; line-height: 1.7;">
              A BPCON26 promotional code has been ${application?.isExistingPromo ? "resent to an existing claimant" : "claimed by a new visitor"}.
            </p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #16a34a; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0 0 4px; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Promo Code</p>
              <p style="margin: 0; font-size: 22px; font-weight: 900; color: #1B4332; font-family: 'Courier New', monospace;">${application?.promoCode || ""}</p>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <h3 style="color: #374151; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Contact Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">Name</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${contactName}</td></tr>
                ${application?.companyName ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Company</td><td style="padding: 7px 0; font-size: 14px;">${application.companyName}</td></tr>` : ""}
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Email</td><td style="padding: 7px 0; font-size: 14px;"><a href="mailto:${borrower.email}" style="color: #2563eb; font-weight: 600;">${borrower.email}</a></td></tr>
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Active Deal</td><td style="padding: 7px 0; font-size: 14px; font-weight: 700;">${application?.activeDeal === true ? "Yes" : application?.activeDeal === false ? "No" : "Not specified"}</td></tr>
                ${application?.estimatedEmdAmount ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">EMD Amount</td><td style="padding: 7px 0; font-size: 14px; font-weight: 700; color: #16a34a;">$${Number(application.estimatedEmdAmount).toLocaleString()}</td></tr>` : ""}
                ${application?.targetClosingDate ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Target Close</td><td style="padding: 7px 0; font-size: 14px;">${application.targetClosingDate}</td></tr>` : ""}
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Contact Type</td><td style="padding: 7px 0; font-size: 14px; font-weight: 700;">${application?.isNewContact ? "🆕 New Contact" : "🔄 Existing Contact"}</td></tr>
              </table>
            </div>

            <a href="${application?.contactUrl || appUrl + "/admin/crm/contacts"}" style="${adminBtnStyle}">View CRM Contact →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── ADMIN EMAIL TYPE: Revised Document Uploaded ───────────────────────────
    else if (emailType === "document_revision_uploaded_admin") {
      toEmail = [ADMIN_EMAIL];
      const borrowerName = application?.borrowerName ||
        `${borrower?.firstName || ""} ${borrower?.lastName || ""}`.trim() ||
        borrower?.email ||
        "A borrower";
      const docName = application?.documentName || "Document";
      const versionNumber = application?.versionNumber ?? "";
      const propertyAddress = application?.propertyAddress || "";
      const adminDealUrl = application?.adminDealUrl || `${appUrl}/admin`;
      const uploadedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

      subject = `Revised Document Uploaded — ${docName}`;
      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("REVISED DOCUMENT ALERT")}
          <div style="${bodyStyle}">
            <h2 style="color: #1e3a5f; margin-top: 0; font-size: 20px;">Revised Document Uploaded</h2>
            <p style="color: #374151; line-height: 1.7;">
              <strong>${borrowerName}</strong> uploaded a revised version of <strong>${docName}</strong>.
            </p>

            <div style="background: #fffbeb; border: 1px solid #fde68a; border-left: 4px solid #d97706; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #92400e; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Document Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 40%; font-size: 14px;">Document</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${docName}</td></tr>
                ${versionNumber ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">New Version</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">v${versionNumber}</td></tr>` : ""}
                ${propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property</td><td style="padding: 7px 0; font-size: 14px;">${propertyAddress}</td></tr>` : ""}
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Uploaded By</td><td style="padding: 7px 0; font-size: 14px; font-weight: 700;">${borrowerName}</td></tr>
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Uploaded At</td><td style="padding: 7px 0; font-size: 14px;">${uploadedAt}</td></tr>
              </table>
            </div>

            <p style="color: #374151; line-height: 1.7;">
              Please review the new version and update the document status accordingly.
            </p>
            <a href="${adminDealUrl}" style="${adminBtnStyle}">REVIEW DOCUMENT →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── OPTION CYCLE: Client Reminder (7d / 5d / 3d / 1d) ───────────────────
    // SECURITY: NEVER expose Deposit Goes Hard Date, two-day buffer,
    // internal fee leniency, or manual override policy to the client.
    else if (
      emailType === "client_reminder_7d" ||
      emailType === "client_reminder_5d" ||
      emailType === "client_reminder_3d" ||
      emailType === "client_reminder_1d"
    ) {
      toEmail = [borrower.email];
      const daysMap: Record<string, number> = {
        client_reminder_7d: 7,
        client_reminder_5d: 5,
        client_reminder_3d: 3,
        client_reminder_1d: 1,
      };
      const daysUntil = daysMap[emailType] ?? 0;
      const deadlineDisplay = application?.optionDeadlineDisplay || application?.optionExerciseDeadline || "the Option Exercise Deadline";
      const dealName = application?.dealDisplayName || application?.propertyAddress || "your deal";

      const urgencyColor = daysUntil <= 1 ? "#dc2626" : daysUntil <= 3 ? "#d97706" : "#2563eb";
      const urgencyBg = daysUntil <= 1 ? "#fef2f2" : daysUntil <= 3 ? "#fffbeb" : "#eff6ff";
      const urgencyBorder = daysUntil <= 1 ? "#fecaca" : daysUntil <= 3 ? "#fde68a" : "#bfdbfe";

      const urgencyLabel =
        daysUntil === 7 ? "Option Exercise Deadline — Advance Notice" :
        daysUntil === 5 ? "Option Exercise Deadline — Action Required Soon" :
        daysUntil === 3 ? "⚠️ Urgent: Option Exercise Deadline Approaching": "🚨 Final Notice: Option Exercise Deadline Tomorrow";

      const urgencyIntro =
        daysUntil === 7 ? `This is an advance reminder that your Option Exercise Deadline is approaching for <strong>${dealName}</strong>.` :
        daysUntil === 5 ? `Your Option Exercise Deadline is coming up soon for <strong>${dealName}</strong>. Action is required.` :
        daysUntil === 3 ? `Your Option Exercise Deadline is in <strong>3 days</strong> for <strong>${dealName}</strong>. Please act promptly.` :
        `Your Option Exercise Deadline is <strong>tomorrow</strong> for <strong>${dealName}</strong>. Action is required by 5:00 PM Eastern Time.`;

      subject = `${urgencyLabel} — EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">${urgencyLabel}</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName || "there"},</p>
            <p style="color: #374151; line-height: 1.7;">${urgencyIntro}</p>

            <div style="background: ${urgencyBg}; border: 1px solid ${urgencyBorder}; border-radius: 8px; padding: 20px; margin: 28px 0; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Option Exercise Deadline</p>
              <p style="margin: 8px 0 0; font-size: 22px; font-weight: 800; color: ${urgencyColor};">${deadlineDisplay}</p>
              <p style="margin: 6px 0 0; font-size: 13px; color: ${urgencyColor}; font-weight: 700;">Cutoff: 5:00 PM Eastern Time</p>
              ${application?.propertyAddress ? `<p style="margin: 8px 0 0; font-size: 13px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
            </div>

            <p style="color: #374151; line-height: 1.7; font-weight: 700;">To exercise your option, EarnestBridge must receive your option exercise by the deadline above.</p>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <p style="margin: 0 0 12px; font-size: 14px; font-weight: 700; color: #374151;">If you need additional due-diligence time, BOTH of the following are required:</p>
              <ol style="margin: 0; padding-left: 20px; color: #374151; font-size: 14px; line-height: 2;">
                <li><strong>Signed amendment to the Purchase &amp; Sale Agreement</strong> extending the due-diligence period</li>
                <li><strong>Extension Deal Fee payment</strong></li>
              </ol>
              <p style="margin: 14px 0 0; font-size: 13px; color: #dc2626; font-weight: 700;">
                The signed PSA amendment must be received by EarnestBridge no later than 5:00 PM Eastern on the Option Exercise Deadline.
              </p>
            </div>

            <a href="${appUrl}/deadlines" style="${btnStyle}">View My Deadlines →</a>

            <p style="margin-top: 28px; color: #374151; line-height: 1.7;">
              Questions? Contact us immediately at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a>.
            </p>
            <p style="color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── OPTION CYCLE: Admin Reminder (7d / 5d / 3d / 1d) ────────────────────
    // Admin wording may contain internal operational information.
    // Deposit Goes Hard Date is included for Admin only.
    else if (
      emailType === "admin_reminder_7d" ||
      emailType === "admin_reminder_5d" ||
      emailType === "admin_reminder_3d" ||
      emailType === "admin_reminder_1d"
    ) {
      toEmail = [borrower.email]; // borrower.email = admin email in this context
      const daysMap: Record<string, number> = {
        admin_reminder_7d: 7,
        admin_reminder_5d: 5,
        admin_reminder_3d: 3,
        admin_reminder_1d: 1,
      };
      const daysUntil = daysMap[emailType] ?? 0;
      const deadlineDisplay = application?.optionDeadlineDisplay || application?.optionExerciseDeadline || "the Option Exercise Deadline";
      const dealName = application?.dealDisplayName || application?.propertyAddress || "Deal";
      const hardDate = application?.depositGoesHardDate || "—";
      const assignedOwner = application?.assignedOwner || "Unassigned";

      const urgencyLabel =
        daysUntil === 7 ? "Option Deadline — 7 Days" :
        daysUntil === 5 ? "Option Deadline — 5 Days" :
        daysUntil === 3 ? "⚠️ Option Deadline — 3 Days": "🚨 Option Deadline — Tomorrow";

      subject = `[Admin] ${urgencyLabel} — ${dealName} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("OPTION DEADLINE ALERT")}
          <div style="${bodyStyle}">
            <h2 style="color: #173F35; margin-top: 0; font-size: 20px;">${urgencyLabel}</h2>
            <p style="color: #374151; line-height: 1.7;">An active option cycle is approaching its deadline with no timely exercise or amendment recorded.</p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #173F35; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #173F35; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Deal Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 45%; font-size: 14px;">Deal</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${dealName}</td></tr>
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property</td><td style="padding: 7px 0; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Assigned Owner</td><td style="padding: 7px 0; font-size: 14px; font-weight: 700;">${assignedOwner}</td></tr>
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Option Exercise Deadline</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px; color: #dc2626;">${deadlineDisplay}</td></tr>
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Deposit Goes Hard Date</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${hardDate}</td></tr>
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Days Until Deadline</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px; color: #dc2626;">${daysUntil} day${daysUntil !== 1 ? "s" : ""}</td></tr>
              </table>
            </div>

            <p style="color: #374151; line-height: 1.7;">No timely option exercise or signed PSA amendment has been recorded. Please follow up with the borrower and ensure the CRM is updated.</p>

            <a href="${appUrl}/admin/deals" style="${adminBtnStyle}">Review in Admin Dashboard →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── OPTION CYCLE: Client Closeout Notice ─────────────────────────────────
    // SECURITY: NEVER expose Deposit Goes Hard Date, two-day buffer,
    // internal override window, or legal DD expiration to the client.
    else if (emailType === "option_client_closeout") {
      toEmail = [borrower.email];
      const dealName = application?.dealDisplayName || application?.propertyAddress || "your deal";
      const deadlineDisplay = application?.optionDeadlineDisplay || application?.optionExerciseDeadline || "the Option Exercise Deadline";

      subject = "Important Notice: EarnestBridge Deal Closed — EarnestBridge";
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Deal Closed — Option Exercise Deadline Not Met</h2>
            <p style="color: #374151; line-height: 1.7;">Hi ${borrower.firstName || "there"},</p>

            <div style="background: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <p style="margin: 0; font-size: 15px; font-weight: 700; color: #991b1b;">Your EarnestBridge deal has been closed because the Option Exercise Deadline was not met.</p>
              ${application?.propertyAddress ? `<p style="margin: 10px 0 0; font-size: 13px; color: #6b7280;">${application.propertyAddress}</p>` : ""}
              <p style="margin: 10px 0 0; font-size: 13px; color: #6b7280;">Option Exercise Deadline: <strong>${deadlineDisplay}</strong></p>
            </div>

            <p style="color: #374151; line-height: 1.7;">
              <strong>Please contact EarnestBridge immediately if you believe required extension documentation was submitted.</strong>
            </p>

            <p style="color: #374151; line-height: 1.7;">
              You can reach us at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a>.
            </p>

            <a href="${appUrl}/deadlines" style="${btnStyle}">Contact EarnestBridge →</a>

            <p style="margin-top: 28px; color: #374151;">Best regards,<br/><strong>The EarnestBridge Team</strong></p>

            ${brandedFooter}
          </div>
        </div>
      `;
    }

    // ─── OPTION CYCLE: Admin Closeout Notice ──────────────────────────────────
    // Admin notification may include internal operational details.
    // CRM must not claim escrow was already returned.
    else if (emailType === "option_admin_closeout") {
      toEmail = [borrower.email]; // borrower.email = admin email in this context
      const dealName = application?.dealDisplayName || application?.propertyAddress || "Deal";
      const deadlineDisplay = application?.optionDeadlineDisplay || application?.optionExerciseDeadline || "—";
      const hardDate = application?.depositGoesHardDate || "—";
      const assignedOwner = application?.assignedOwner || "Unassigned";

      subject = `[Admin] Deal Auto-Closed — Option Deadline Missed — ${dealName} | EarnestBridge`;
      htmlBody = `
        <div style="${baseStyle}">
          ${adminBrandedHeader("DEAL AUTO-CLOSED")}
          <div style="${bodyStyle}">
            <h2 style="color: #173F35; margin-top: 0; font-size: 20px;">CRM Deal Auto-Closed — Option Deadline Missed</h2>
            <p style="color: #374151; line-height: 1.7;">The following deal has been automatically closed by the CRM because the Option Exercise Deadline passed with no timely exercise or signed amendment recorded.</p>

            <div style="background: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #991b1b; margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em;">Closed Deal</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 7px 0; color: #6b7280; width: 45%; font-size: 14px;">Deal</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${dealName}</td></tr>
                ${application?.propertyAddress ? `<tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Property</td><td style="padding: 7px 0; font-size: 14px;">${application.propertyAddress}</td></tr>` : ""}
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Assigned Owner</td><td style="padding: 7px 0; font-size: 14px; font-weight: 700;">${assignedOwner}</td></tr>
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Option Exercise Deadline</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px; color: #dc2626;">${deadlineDisplay}</td></tr>
                <tr><td style="padding: 7px 0; color: #6b7280; font-size: 14px;">Deposit Goes Hard Date</td><td style="padding: 7px 0; font-weight: 700; font-size: 14px;">${hardDate}</td></tr>
              </table>
            </div>

            <div style="background: #fffbeb; border: 1px solid #fde68a; border-left: 3px solid #C9A227; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-size: 13px; color: #92400e; font-weight: 700;">Action Required</p>
              <ul style="margin: 10px 0 0; padding-left: 18px; color: #374151; font-size: 13px; line-height: 1.8;">
                <li>No timely option exercise recorded in CRM</li>
                <li>No timely signed PSA amendment recorded in CRM</li>
                <li>CRM Deal status: <strong>Closed</strong></li>
                <li>Review escrow/return-of-funds process separately</li>
                <li>If borrower submitted documentation, use Admin Override to review</li>
              </ul>
            </div>

            <a href="${appUrl}/admin/deals" style="${adminBtnStyle}">Review in Admin Dashboard →</a>

            ${adminBrandedFooter}
          </div>
        </div>
      `;
    }

    // ─── EMAIL TYPE: Admin Direct Message (Manual CRM Email) ─────────────────
    else if (emailType === "admin_direct_message") {
      // ── INTERNAL-SECRET GATE ──────────────────────────────────────────────
      // admin_direct_message is an internal server email transport.
      // The Authorization Bearer (service_role) is still sent and used by Supabase
      // to invoke the Edge Function. The dedicated internal secret provides the
      // second trust boundary, replacing the brittle service-role value comparison
      // across Netlify → Deno runtimes.
      if (!checkInternalSecret(req)) {
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
      // ── END INTERNAL-SECRET GATE ──────────────────────────────────────────

      // Input validation
      const dmTo = body?.to;
      const dmSubject = body?.subject;
      const dmBody = body?.body;
      const dmReplyTo = body?.replyTo; // optional — derived server-side from admin user

      if (!dmTo || typeof dmTo !== "string") {
        throw new Error("admin_direct_message requires a valid 'to' field");
      }
      if (!dmSubject || typeof dmSubject !== "string") {
        throw new Error("admin_direct_message requires a valid 'subject' field");
      }
      if (!dmBody || typeof dmBody !== "string") {
        throw new Error("admin_direct_message requires a valid 'body' field");
      }

      // ── Safe HTML escaping — treat admin body as PLAIN TEXT ──────────────
      // Escape &, <, >, ", ' then convert line breaks to <br>
      function escapeHtml(text: string): string {
        return text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#x27;");
      }

      const escapedBody = escapeHtml(dmBody)
        .replace(/\r\n|\r|\n/g, "<br>");

      const escapedSubject = escapeHtml(dmSubject);

      toEmail = [dmTo.trim()];
      subject = dmSubject.trim();

      htmlBody = `
        <div style="${baseStyle}">
          <div style="${headerStyle}">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td>
                  <div style="font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">EarnestBridge</div>
                  <div style="font-size: 12px; color: #86efac; margin-top: 3px; letter-spacing: 0.05em; text-transform: uppercase;">EMD Financing Platform</div>
                </td>
              </tr>
            </table>
          </div>
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">${escapedSubject}</h2>
            <div style="color: #374151; line-height: 1.8; font-size: 15px; white-space: pre-wrap;">${escapedBody}</div>
            <div style="${footerStyle}">
              <p style="margin: 0 0 6px;">
                <strong style="color: #6b7280;">EarnestBridge</strong> — EMD Financing for Real Estate Professionals
              </p>
              <p style="margin: 0 0 6px;">
                Questions? Contact us at <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; text-decoration: none;">admin@earnestbridge.com</a>
              </p>
              <p style="margin: 0;">© ${new Date().getFullYear()} EarnestBridge. All rights reserved.</p>
            </div>
          </div>
        </div>
      `;

      // Store replyTo for use in the Resend payload below (if provided and valid)
      if (dmReplyTo && typeof dmReplyTo === "string" && dmReplyTo.includes("@")) {
        (body as any)._resolvedReplyTo = dmReplyTo.trim();
      }

      // ── Attachment payload validation ─────────────────────────────────────
      // Must happen AFTER the internal-secret gate and BEFORE Resend is called.
      // undefined / null → zero attachments (allowed)
      // array            → continue to existing per-item validation downstream
      // anything else    → reject immediately, do NOT call Resend
      const rawAttachments = body?.attachments;
      if (rawAttachments !== undefined && rawAttachments !== null && !Array.isArray(rawAttachments)) {
        return new Response(
          JSON.stringify({ success: false, error: "Invalid attachments payload" }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    // ─── EMAIL TYPE: Invoice Issued ───────────────────────────────────────────
    // TRUST BOUNDARY: Requires BOTH service-role Bearer authorization (enforced
    // by Supabase Edge Function invocation) AND the X-EB-Email-Secret internal
    // secret — identical to admin_direct_message.
    //
    // This handler is ONLY responsible for:
    //   - validating the invoice-email request
    //   - rendering deterministic branded email content
    //   - attaching the immutable PDF
    //   - sending through Resend with the provider idempotency key
    //   - returning a structured provider outcome
    //
    // It must NOT make invoice/database state decisions.
    // It must NOT insert or update any database rows.
    else if (emailType === "invoice_issued") {
      // ── INTERNAL-SECRET GATE (same as admin_direct_message) ───────────────
      if (!checkInternalSecret(req)) {
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
      // ── END INTERNAL-SECRET GATE ──────────────────────────────────────────

      // ── Field extraction ──────────────────────────────────────────────────
      const invTo: unknown = body?.to;
      const invInvoiceId: unknown = body?.invoiceId;
      const invInvoiceNumber: unknown = body?.invoiceNumber;
      const invBillingContactName: unknown = body?.billingContactName;
      const invTotalCents: unknown = body?.totalCents;
      const invCurrency: unknown = body?.currency;
      const invDueDate: unknown = body?.dueDate;
      const invIdempotencyKey: unknown = body?.idempotencyKey;
      const invAttachments: unknown = body?.attachments;

      // ── Validation helpers ────────────────────────────────────────────────
      function isNonblankString(v: unknown): v is string {
        return typeof v === "string" && v.trim().length > 0;
      }

      function validationError(msg: string): Response {
        return new Response(
          JSON.stringify({ success: false, error: msg }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      // to — nonblank, reasonable email format
      if (!isNonblankString(invTo)) {
        return validationError("invoice_issued: 'to' must be a nonblank string");
      }
      const trimmedTo = invTo.trim();
      // Reasonable email format: contains @ with nonblank parts on each side
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedTo)) {
        return validationError("invoice_issued: 'to' must be a valid email address");
      }

      // invoiceId — nonblank UUID-shaped string
      if (!isNonblankString(invInvoiceId)) {
        return validationError("invoice_issued: 'invoiceId' must be a nonblank string");
      }
      const trimmedInvoiceId = invInvoiceId.trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedInvoiceId)) {
        return validationError("invoice_issued: 'invoiceId' must be a valid UUID");
      }

      // invoiceNumber — nonblank, reasonable length (max 100 chars)
      if (!isNonblankString(invInvoiceNumber)) {
        return validationError("invoice_issued: 'invoiceNumber' must be a nonblank string");
      }
      const trimmedInvoiceNumber = invInvoiceNumber.trim();
      if (trimmedInvoiceNumber.length > 100) {
        return validationError("invoice_issued: 'invoiceNumber' exceeds maximum length");
      }

      // billingContactName — nullable; if present, trim and cap at 200 chars
      let trimmedBillingContactName: string | null = null;
      if (invBillingContactName !== null && invBillingContactName !== undefined) {
        if (typeof invBillingContactName !== "string") {
          return validationError("invoice_issued: 'billingContactName' must be a string or null");
        }
        const t = invBillingContactName.trim();
        trimmedBillingContactName = t.length > 0 ? t.substring(0, 200) : null;
      }

      // totalCents — integer >= 0
      if (typeof invTotalCents !== "number" || !Number.isInteger(invTotalCents) || invTotalCents < 0) {
        return validationError("invoice_issued: 'totalCents' must be a non-negative integer");
      }

      // currency — exactly 3 alphabetic characters
      if (!isNonblankString(invCurrency)) {
        return validationError("invoice_issued: 'currency' must be a nonblank string");
      }
      const trimmedCurrency = invCurrency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(trimmedCurrency)) {
        return validationError("invoice_issued: 'currency' must be exactly 3 alphabetic characters");
      }

      // dueDate — valid YYYY-MM-DD date-only string
      if (!isNonblankString(invDueDate)) {
        return validationError("invoice_issued: 'dueDate' must be a nonblank string");
      }
      const trimmedDueDate = invDueDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedDueDate)) {
        return validationError("invoice_issued: 'dueDate' must be in YYYY-MM-DD format");
      }
      // Verify it is a real calendar date
      const dueDateParts = trimmedDueDate.split("-");
      const dueDateObj = new Date(`${dueDateParts[0]}-${dueDateParts[1]}-${dueDateParts[2]}T00:00:00Z`);
      if (
        isNaN(dueDateObj.getTime()) ||
        dueDateObj.getUTCFullYear() !== parseInt(dueDateParts[0], 10) ||
        dueDateObj.getUTCMonth() + 1 !== parseInt(dueDateParts[1], 10) ||
        dueDateObj.getUTCDate() !== parseInt(dueDateParts[2], 10)
      ) {
        return validationError("invoice_issued: 'dueDate' is not a valid calendar date");
      }

      // idempotencyKey — nonblank, <= 256 chars, MUST equal invoice-issued/{invoiceId}
      if (!isNonblankString(invIdempotencyKey)) {
        return validationError("invoice_issued: 'idempotencyKey' must be a nonblank string");
      }
      const trimmedIdempotencyKey = invIdempotencyKey.trim();
      if (trimmedIdempotencyKey.length > 256) {
        return validationError("invoice_issued: 'idempotencyKey' exceeds 256 characters");
      }
      const expectedIdempotencyKey = `invoice-issued/${trimmedInvoiceId}`;
      if (trimmedIdempotencyKey !== expectedIdempotencyKey) {
        return validationError(
          `invoice_issued: 'idempotencyKey' must equal 'invoice-issued/{invoiceId}'`
        );
      }

      // attachments — exactly 1
      if (!Array.isArray(invAttachments) || invAttachments.length !== 1) {
        return validationError("invoice_issued: 'attachments' must be an array with exactly 1 item");
      }
      const att = invAttachments[0];

      // attachment.filename must exactly equal {invoiceNumber}.pdf
      const expectedFilename = `${trimmedInvoiceNumber}.pdf`;
      if (!att || typeof att.filename !== "string" || att.filename !== expectedFilename) {
        return validationError(
          `invoice_issued: attachment filename must exactly equal '${expectedFilename}'`
        );
      }

      // attachment.content — nonblank base64; decode defensively; validate PDF magic
      if (!isNonblankString(att.content)) {
        return validationError("invoice_issued: attachment content must be a nonblank base64 string");
      }
      // Do NOT log att.content
      let pdfBytes: Uint8Array;
      try {
        // Deno: atob decodes base64 to a binary string; convert to Uint8Array
        const binaryString = atob(att.content);
        pdfBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          pdfBytes[i] = binaryString.charCodeAt(i);
        }
      } catch {
        return validationError("invoice_issued: attachment content is not valid base64");
      }
      if (pdfBytes.length === 0) {
        return validationError("invoice_issued: attachment decoded bytes are empty");
      }
      // Validate PDF magic header: %PDF- (bytes: 0x25 0x50 0x44 0x46 0x2D)
      if (
        pdfBytes.length < 5 ||
        pdfBytes[0] !== 0x25 || // %
        pdfBytes[1] !== 0x50 || // P
        pdfBytes[2] !== 0x44 || // D
        pdfBytes[3] !== 0x46 || // F
        pdfBytes[4] !== 0x2D    // -
      ) {
        return validationError("invoice_issued: attachment does not appear to be a valid PDF (missing %PDF- header)");
      }
      // ── END VALIDATION ────────────────────────────────────────────────────

      // ── Format invoice total deterministically ────────────────────────────
      // Uses Intl.NumberFormat for proper currency symbol and grouping separators.
      // totalCents is a non-negative integer; divide by 100 for display.
      // Example: USD + 1675000 cents → $16,750.00
      const totalFormatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: trimmedCurrency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(invTotalCents / 100);

      // ── Format due date deterministically (YYYY-MM-DD → Month D, YYYY) ───
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];
      const dueDateFormatted = `${monthNames[dueDateObj.getUTCMonth()]} ${dueDateObj.getUTCDate()}, ${dueDateObj.getUTCFullYear()}`;

      // ── HTML-escape display values before inserting into email HTML ──────
      // Prevents HTML injection from caller-provided strings.
      // Canonical values (trimmedInvoiceNumber, trimmedBillingContactName) are
      // NOT altered — escaping applies only to the HTML rendering path.
      // Idempotency validation, attachment filename, and subject construction
      // continue to use the unescaped trimmed values.
      const safeInvoiceNumber = escapeHtmlForInvoice(trimmedInvoiceNumber);
      const safeBillingContactName = trimmedBillingContactName !== null
        ? escapeHtmlForInvoice(trimmedBillingContactName)
        : null;

      // ── Greeting — use HTML-escaped billing contact name if available ──────
      const greeting = safeBillingContactName
        ? `Hi ${safeBillingContactName},`
        : "Hello,";

      // ── Deterministic subject — caller cannot supply subject ──────────────
      // Subject uses the unescaped trimmedInvoiceNumber (plain text context).
      subject = `EarnestBridge Invoice ${trimmedInvoiceNumber}`;

      // ── Deterministic branded email body ─────────────────────────────────
      // MUST NOT include: bank/wire info, routing info, CRM data, storage paths,
      // admin notes, portal authorization state, or any mutable/dynamic content.
      // Uses ONLY values derived from the immutable invoice snapshot in the request.
      // Uses invoiceDeterministicFooter (no runtime year) instead of brandedFooter
      // so the Resend payload is byte-for-byte identical across retries.
      toEmail = [trimmedTo];
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Invoice ${safeInvoiceNumber}</h2>
            <p style="color: #374151; line-height: 1.7;">${greeting}</p>
            <p style="color: #374151; line-height: 1.7;">
              Your EarnestBridge invoice <strong>${safeInvoiceNumber}</strong> is attached.
            </p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; width: 45%; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;">Invoice Total</td>
                  <td style="padding: 10px 0; font-weight: 800; font-size: 18px; color: #1B4332;">${totalFormatted}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; color: #6b7280; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; border-top: 1px solid #d1fae5;">Due Date</td>
                  <td style="padding: 10px 0; font-weight: 700; font-size: 15px; color: #374151; border-top: 1px solid #d1fae5;">${dueDateFormatted}</td>
                </tr>
              </table>
            </div>

            <p style="color: #374151; line-height: 1.7;">
              Please retain the attached invoice for your records.
            </p>
            <p style="color: #374151; line-height: 1.7;">
              If you have any questions, please contact EarnestBridge at
              <a href="mailto:admin@earnestbridge.com" style="color: #1B4332; font-weight: 600;">admin@earnestbridge.com</a>.
            </p>

            <p style="margin-top: 28px; color: #374151;">
              Thank you,<br/><strong>EarnestBridge</strong>
            </p>

            ${invoiceDeterministicFooter}
          </div>
        </div>
      `;

      // ── Store invoice-specific fields for use in Resend section below ─────
      // These are stored on body as internal markers (not logged).
      (body as any)._invoiceIdempotencyKey = trimmedIdempotencyKey;
      (body as any)._invoiceAttachment = { filename: expectedFilename, content: att.content };
    }

    // ─── EMAIL TYPE: Receipt Issued ───────────────────────────────────────────
    // TRUST BOUNDARY: Requires BOTH service-role Bearer authorization (enforced
    // by Supabase Edge Function invocation) AND the X-EB-Email-Secret internal
    // secret — identical to invoice_issued / admin_direct_message.
    //
    // This handler ONLY validates the payload, renders deterministic content,
    // forwards the already-verified immutable receipt PDF, and sends through
    // Resend using the caller-supplied idempotency key. It does NOT decode or
    // re-render the PDF, derive a second idempotency key, or touch any database.
    else if (emailType === "receipt_issued") {
      // ── INTERNAL-SECRET GATE ──────────────────────────────────────────────
      if (!checkInternalSecret(req)) {
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
      // ── END INTERNAL-SECRET GATE ──────────────────────────────────────────

      const rcIsNonblank = (v: unknown): v is string =>
        typeof v === "string" && v.trim().length > 0;

      const rcValidationError = (msg: string): Response =>
        new Response(
          JSON.stringify({ success: false, error: msg }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );

      const rcIsNonNegInt = (v: unknown): v is number =>
        typeof v === "number" && Number.isInteger(v) && v >= 0;

      const rcUuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      // ── Field extraction (names exactly as emitted by receiptEmail.ts) ────
      const rcTo: unknown = body?.to;
      const rcPaymentId: unknown = body?.paymentId;
      const rcInvoiceId: unknown = body?.invoiceId;
      const rcDealId: unknown = body?.dealId;
      const rcInvoiceNumber: unknown = body?.invoiceNumber;
      const rcReceiptNumber: unknown = body?.receiptNumber;
      const rcReceiptIssuedAt: unknown = body?.receiptIssuedAt;
      const rcPaymentAmountCents: unknown = body?.paymentAmountCents;
      const rcCurrency: unknown = body?.currency;
      const rcPaymentReceivedAt: unknown = body?.paymentReceivedAt;
      const rcPaymentMethod: unknown = body?.paymentMethod;
      const rcPaymentReference: unknown = body?.paymentReference;
      const rcInvoiceTotalCents: unknown = body?.invoiceTotalCents;
      const rcAmountPaidAfterCents: unknown = body?.amountPaidAfterCents;
      const rcBalanceRemainingAfterCents: unknown = body?.balanceRemainingAfterCents;
      const rcBillingContactName: unknown = body?.billingContactName;
      const rcIdempotencyKey: unknown = body?.idempotencyKey;
      const rcAttachments: unknown = body?.attachments;

      // to
      if (!rcIsNonblank(rcTo)) {
        return rcValidationError("receipt_issued: 'to' must be a nonblank string");
      }
      const rcToTrimmed = rcTo.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rcToTrimmed)) {
        return rcValidationError("receipt_issued: 'to' must be a valid email address");
      }

      // paymentId
      if (!rcIsNonblank(rcPaymentId) || !rcUuidRe.test(rcPaymentId.trim())) {
        return rcValidationError("receipt_issued: 'paymentId' must be a valid UUID");
      }
      const rcPaymentIdTrimmed = rcPaymentId.trim();

      // invoiceId
      if (!rcIsNonblank(rcInvoiceId) || !rcUuidRe.test(rcInvoiceId.trim())) {
        return rcValidationError("receipt_issued: 'invoiceId' must be a valid UUID");
      }

      // dealId — OPTIONAL (backward compatible with older dispatcher payloads).
      // Absent (undefined/null) → no portal CTA. Present → must be a strict UUID.
      let rcDealIdTrimmed: string | null = null;
      if (rcDealId !== undefined && rcDealId !== null) {
        if (!rcIsNonblank(rcDealId) || !rcUuidRe.test(rcDealId.trim())) {
          return rcValidationError("receipt_issued: 'dealId' must be a valid UUID");
        }
        rcDealIdTrimmed = rcDealId.trim();
      }
      const rcPortalUrl: string | null = rcDealIdTrimmed !== null
        ? `${appUrl.replace(/\/+$/, "")}/deals/${rcDealIdTrimmed}`
        : null;

      // invoiceNumber
      if (!rcIsNonblank(rcInvoiceNumber)) {
        return rcValidationError("receipt_issued: 'invoiceNumber' must be a nonblank string");
      }
      const rcInvoiceNumberTrimmed = rcInvoiceNumber.trim();
      if (rcInvoiceNumberTrimmed.length > 100) {
        return rcValidationError("receipt_issued: 'invoiceNumber' exceeds maximum length");
      }

      // receiptNumber
      if (!rcIsNonblank(rcReceiptNumber)) {
        return rcValidationError("receipt_issued: 'receiptNumber' must be a nonblank string");
      }
      const rcReceiptNumberTrimmed = rcReceiptNumber.trim();
      if (rcReceiptNumberTrimmed.length > 100) {
        return rcValidationError("receipt_issued: 'receiptNumber' exceeds maximum length");
      }
      if (!/^[A-Za-z0-9._-]+$/.test(rcReceiptNumberTrimmed)) {
        return rcValidationError("receipt_issued: 'receiptNumber' contains unsupported characters");
      }

      // receiptIssuedAt / paymentReceivedAt — nonblank, parseable timestamps
      if (!rcIsNonblank(rcReceiptIssuedAt) || isNaN(new Date(rcReceiptIssuedAt.trim()).getTime())) {
        return rcValidationError("receipt_issued: 'receiptIssuedAt' must be a valid timestamp");
      }
      const rcReceiptIssuedAtDate = new Date(rcReceiptIssuedAt.trim());
      if (!rcIsNonblank(rcPaymentReceivedAt) || isNaN(new Date(rcPaymentReceivedAt.trim()).getTime())) {
        return rcValidationError("receipt_issued: 'paymentReceivedAt' must be a valid timestamp");
      }
      const rcPaymentReceivedAtDate = new Date(rcPaymentReceivedAt.trim());

      // money integers
      if (!rcIsNonNegInt(rcPaymentAmountCents)) {
        return rcValidationError("receipt_issued: 'paymentAmountCents' must be a non-negative integer");
      }
      if (!rcIsNonNegInt(rcInvoiceTotalCents)) {
        return rcValidationError("receipt_issued: 'invoiceTotalCents' must be a non-negative integer");
      }
      if (!rcIsNonNegInt(rcAmountPaidAfterCents)) {
        return rcValidationError("receipt_issued: 'amountPaidAfterCents' must be a non-negative integer");
      }
      if (!rcIsNonNegInt(rcBalanceRemainingAfterCents)) {
        return rcValidationError("receipt_issued: 'balanceRemainingAfterCents' must be a non-negative integer");
      }

      // currency — same rule as invoice_issued (3 alphabetic characters)
      if (!rcIsNonblank(rcCurrency)) {
        return rcValidationError("receipt_issued: 'currency' must be a nonblank string");
      }
      const rcCurrencyTrimmed = rcCurrency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(rcCurrencyTrimmed)) {
        return rcValidationError("receipt_issued: 'currency' must be exactly 3 alphabetic characters");
      }

      // paymentMethod
      if (!rcIsNonblank(rcPaymentMethod)) {
        return rcValidationError("receipt_issued: 'paymentMethod' must be a nonblank string");
      }
      const rcPaymentMethodTrimmed = rcPaymentMethod.trim();
      if (rcPaymentMethodTrimmed.length > 100) {
        return rcValidationError("receipt_issued: 'paymentMethod' exceeds maximum length");
      }

      // paymentReference — optional
      let rcPaymentReferenceTrimmed: string | null = null;
      if (rcPaymentReference !== null && rcPaymentReference !== undefined) {
        if (typeof rcPaymentReference !== "string") {
          return rcValidationError("receipt_issued: 'paymentReference' must be a string or null");
        }
        const t = rcPaymentReference.trim();
        rcPaymentReferenceTrimmed = t.length > 0 ? t.substring(0, 200) : null;
      }

      // billingContactName — optional
      let rcBillingContactNameTrimmed: string | null = null;
      if (rcBillingContactName !== null && rcBillingContactName !== undefined) {
        if (typeof rcBillingContactName !== "string") {
          return rcValidationError("receipt_issued: 'billingContactName' must be a string or null");
        }
        const t = rcBillingContactName.trim();
        rcBillingContactNameTrimmed = t.length > 0 ? t.substring(0, 200) : null;
      }

      // idempotencyKey — nonblank, <= 256 chars. Passed through unchanged; the
      // database dispatcher owns the canonical key (receipt-email/{payment_id}).
      if (!rcIsNonblank(rcIdempotencyKey)) {
        return rcValidationError("receipt_issued: 'idempotencyKey' must be a nonblank string");
      }
      const rcIdempotencyKeyTrimmed = rcIdempotencyKey.trim();
      if (rcIdempotencyKeyTrimmed.length > 256) {
        return rcValidationError("receipt_issued: 'idempotencyKey' exceeds 256 characters");
      }
      if (rcIdempotencyKeyTrimmed !== `receipt-email/${rcPaymentIdTrimmed}`) {
        return rcValidationError("receipt_issued: 'idempotencyKey' must equal 'receipt-email/{paymentId}'");
      }

      // attachments — exactly one receipt PDF
      if (!Array.isArray(rcAttachments) || rcAttachments.length !== 1) {
        return rcValidationError("receipt_issued: 'attachments' must be an array with exactly 1 item");
      }
      const rcAtt = rcAttachments[0];
      const rcExpectedFilename = `EarnestBridge-Receipt-${rcReceiptNumberTrimmed}.pdf`;
      if (!rcAtt || typeof rcAtt.filename !== "string" || rcAtt.filename !== rcExpectedFilename) {
        return rcValidationError(
          `receipt_issued: attachment filename must exactly equal '${rcExpectedFilename}'`
        );
      }
      if (!rcIsNonblank(rcAtt.content)) {
        return rcValidationError("receipt_issued: attachment content must be a nonblank base64 string");
      }
      // Structural base64 check only — the PDF is forwarded unmodified. Do NOT log content.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(rcAtt.content.trim())) {
        return rcValidationError("receipt_issued: attachment content is not valid base64");
      }
      // ── END VALIDATION ────────────────────────────────────────────────────

      // ── Deterministic formatting (supplied values only; no runtime date) ──
      const rcMoney = (cents: number): string =>
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: rcCurrencyTrimmed,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(cents / 100);

      const rcMonthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];
      // Fixed US Eastern-independent presentation: calendar date in UTC
      // so output is deterministic regardless of runtime timezone.
      const rcDate = (d: Date): string =>
        `${rcMonthNames[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

      const rcMethodLabels: Record<string, string> = {
        bank_wire: "Bank Wire",
        wire: "Bank Wire",
        ach: "ACH",
        check: "Check",
        cheque: "Check",
        card: "Card",
        credit_card: "Credit Card",
        cash: "Cash",
        other: "Other",
      };
      const rcFormatMethod = (raw: string): string => {
        const key = raw.trim().toLowerCase();
        if (rcMethodLabels[key]) return rcMethodLabels[key];
        const words = key
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .split(" ")
          .filter((w) => w.length > 0);
        if (words.length === 0) return "Other";
        return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      };

      const rcPaymentAmountFmt = rcMoney(rcPaymentAmountCents);
      const rcInvoiceTotalFmt = rcMoney(rcInvoiceTotalCents);
      const rcAmountPaidFmt = rcMoney(rcAmountPaidAfterCents);
      const rcBalanceFmt = rcMoney(rcBalanceRemainingAfterCents);
      const rcPaymentDateFmt = rcDate(rcPaymentReceivedAtDate);
      const rcReceiptDateFmt = rcDate(rcReceiptIssuedAtDate);
      const rcMethodFmt = rcFormatMethod(rcPaymentMethodTrimmed);
      const rcPaidInFull = rcBalanceRemainingAfterCents === 0;

      // ── HTML-escaped display values (canonical values remain unescaped) ───
      const rcSafeInvoiceNumber = escapeHtmlForInvoice(rcInvoiceNumberTrimmed);
      const rcSafeReceiptNumber = escapeHtmlForInvoice(rcReceiptNumberTrimmed);
      const rcSafeMethod = escapeHtmlForInvoice(rcMethodFmt);
      const rcSafeReference = rcPaymentReferenceTrimmed !== null
        ? escapeHtmlForInvoice(rcPaymentReferenceTrimmed)
        : null;
      const rcGreeting = rcBillingContactNameTrimmed
        ? `Hi ${escapeHtmlForInvoice(rcBillingContactNameTrimmed)},`
        : "Hello,";

      // ── Deterministic subject ─────────────────────────────────────────────
      subject = `Payment Receipt — ${rcInvoiceNumberTrimmed} — ${rcReceiptNumberTrimmed}`;

      const rcRowLabel = "padding: 9px 0; color: #6b7280; width: 45%; font-size: 14px;";
      const rcRowValue = "padding: 9px 0; font-weight: 700; font-size: 14px; color: #111827;";
      const rcRowBorder = "border-top: 1px solid #d1fae5;";

      const rcStatusLine = rcPaidInFull
        ? "This invoice is paid in full."
        : `Remaining balance: ${rcBalanceFmt}.`;

      const rcBalanceBlock = rcPaidInFull
        ? `<tr>
             <td style="${rcRowLabel} ${rcRowBorder}">Balance Remaining</td>
             <td style="${rcRowValue} ${rcRowBorder}">
               <span style="display: inline-block; background: #1B4332; color: #ffffff; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; padding: 4px 10px; border-radius: 4px;">PAID IN FULL</span>
             </td>
           </tr>`
        : `<tr>
             <td style="${rcRowLabel} ${rcRowBorder}">Balance Remaining</td>
             <td style="${rcRowValue} ${rcRowBorder} color: #92400e;">${rcBalanceFmt}</td>
           </tr>`;

      toEmail = [rcToTrimmed];
      htmlBody = `
        <div style="${baseStyle}">
          ${brandedHeader}
          <div style="${bodyStyle}">
            <h2 style="color: #1B4332; margin-top: 0; font-size: 20px;">Payment Received</h2>
            <p style="color: #374151; line-height: 1.7;">${rcGreeting}</p>
            <p style="color: #374151; line-height: 1.7;">
              We received your payment of <strong>${rcPaymentAmountFmt}</strong> for invoice
              <strong>${rcSafeInvoiceNumber}</strong>.
            </p>

            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 28px 0;">
              <h3 style="color: #1B4332; margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">Payment Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="${rcRowLabel}">Payment Amount</td>
                  <td style="${rcRowValue} font-size: 16px; color: #1B4332;">${rcPaymentAmountFmt}</td>
                </tr>
                <tr>
                  <td style="${rcRowLabel} ${rcRowBorder}">Payment Date</td>
                  <td style="${rcRowValue} ${rcRowBorder}">${rcPaymentDateFmt}</td>
                </tr>
                <tr>
                  <td style="${rcRowLabel} ${rcRowBorder}">Payment Method</td>
                  <td style="${rcRowValue} ${rcRowBorder}">${rcSafeMethod}</td>
                </tr>
                ${rcSafeReference !== null ? `<tr>
                  <td style="${rcRowLabel} ${rcRowBorder}">Reference</td>
                  <td style="${rcRowValue} ${rcRowBorder}">${rcSafeReference}</td>
                </tr>` : ""}
                <tr>
                  <td style="${rcRowLabel} ${rcRowBorder}">Invoice</td>
                  <td style="${rcRowValue} ${rcRowBorder}">${rcSafeInvoiceNumber}</td>
                </tr>
                <tr>
                  <td style="${rcRowLabel} ${rcRowBorder}">Receipt</td>
                  <td style="${rcRowValue} ${rcRowBorder}">${rcSafeReceiptNumber}</td>
                </tr>
                <tr>
                  <td style="${rcRowLabel} ${rcRowBorder}">Receipt Date</td>
                  <td style="${rcRowValue} ${rcRowBorder}">${rcReceiptDateFmt}</td>
                </tr>
              </table>
            </div>

            <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <h3 style="color: #374151; margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">Account Summary</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="${rcRowLabel}">Invoice Total</td>
                  <td style="${rcRowValue}">${rcInvoiceTotalFmt}</td>
                </tr>
                <tr>
                  <td style="${rcRowLabel} border-top: 1px solid #e5e7eb;">This Payment</td>
                  <td style="${rcRowValue} border-top: 1px solid #e5e7eb;">${rcPaymentAmountFmt}</td>
                </tr>
                <tr>
                  <td style="${rcRowLabel} border-top: 1px solid #e5e7eb;">Total Paid</td>
                  <td style="${rcRowValue} border-top: 1px solid #e5e7eb;">${rcAmountPaidFmt}</td>
                </tr>
                ${rcBalanceBlock}
              </table>
            </div>

            <p style="color: #374151; line-height: 1.7;">
              Payment received and applied to invoice ${rcSafeInvoiceNumber}.
              ${rcStatusLine}
            </p>
            <p style="color: #374151; line-height: 1.7;">
              Your payment receipt is attached for your records.
            </p>
            ${rcPortalUrl !== null ? `<a href="${rcPortalUrl}" style="${btnStyle}">View Receipt in Client Portal</a>
            <p style="color: #6b7280; font-size: 13px; line-height: 1.6;">
              Sign in to your EarnestBridge client portal to view or download this receipt. Portal access requires an approved account.
            </p>` : ""}

            <p style="margin-top: 28px; color: #374151;">
              Thank you,<br/><strong>EarnestBridge</strong>
            </p>

            <div style="${invoiceFooterStyle}">
              <p style="margin: 0 0 6px;"><strong style="color: #6b7280;">EarnestBridge</strong></p>
              <p style="margin: 0;">Payment Receipt · ${rcSafeReceiptNumber}</p>
            </div>
          </div>
        </div>
      `;

      // ── Plain-text fallback (same essential information) ──────────────────
      const rcTextLines: string[] = [
        "Payment Received",
        "",
        rcBillingContactNameTrimmed ? `Hi ${rcBillingContactNameTrimmed},` : "Hello,",
        "",
        `We received your payment of ${rcPaymentAmountFmt} for invoice ${rcInvoiceNumberTrimmed}.`,
        "",
        "Payment Details",
        `Payment Amount: ${rcPaymentAmountFmt}`,
        `Payment Date: ${rcPaymentDateFmt}`,
        `Payment Method: ${rcMethodFmt}`,
      ];
      if (rcPaymentReferenceTrimmed !== null) {
        rcTextLines.push(`Reference: ${rcPaymentReferenceTrimmed}`);
      }
      rcTextLines.push(
        `Invoice: ${rcInvoiceNumberTrimmed}`,
        `Receipt: ${rcReceiptNumberTrimmed}`,
        `Receipt Date: ${rcReceiptDateFmt}`,
        "",
        "Account Summary",
        `Invoice Total: ${rcInvoiceTotalFmt}`,
        `This Payment: ${rcPaymentAmountFmt}`,
        `Total Paid: ${rcAmountPaidFmt}`,
        rcPaidInFull ? "Balance Remaining: PAID IN FULL" : `Balance Remaining: ${rcBalanceFmt}`,
        "",
        `Payment received and applied to invoice ${rcInvoiceNumberTrimmed}. ${rcStatusLine}`,
        "",
        "Your payment receipt is attached for your records.",
        "",
        ...(rcPortalUrl !== null
          ? [
              "View Receipt in Client Portal:",
              rcPortalUrl,
              "",
              "Sign in to your EarnestBridge client portal to view or download this receipt. Portal access requires an approved account.",
              "",
            ]
          : []),
        "Thank you,",
        "EarnestBridge",
        `Payment Receipt · ${rcReceiptNumberTrimmed}`
      );
      (body as any)._receiptText = rcTextLines.join("\n");

      // ── Internal markers for the shared Resend section (never logged) ─────
      (body as any)._receiptIdempotencyKey = rcIdempotencyKeyTrimmed;
      (body as any)._receiptAttachment = { filename: rcExpectedFilename, content: rcAtt.content };
    }

    else {
      throw new Error(`Unknown emailType: ${emailType}`);
    }

    // ─── Build Resend payload ─────────────────────────────────────────────────
    // For admin_direct_message, include reply_to if derived server-side.
    // The exact Resend payload for invoice_issued must remain stable across
    // retries using the same idempotency key — no timestamps, random IDs, or
    // mutable data are included.
    const resendPayload: Record<string, unknown> = {
      from: FROM_EMAIL,
      to: toEmail,
      subject,
      html: htmlBody,
    };

    if (emailType === "receipt_issued") {
      resendPayload.text = (body as any)._receiptText as string;
    }

    if (emailType === "admin_direct_message" && (body as any)?._resolvedReplyTo) {
      resendPayload.reply_to = (body as any)._resolvedReplyTo;
    }

    // ── Attach validated files for admin_direct_message ───────────────────
    // rawAttachments is already validated above (undefined/null/array only).
    // Per-item validation: filename and content must be present strings.
    if (emailType === "admin_direct_message") {
      const rawAttachments = body?.attachments;
      if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
        if (rawAttachments.length > 5) {
          return new Response(
            JSON.stringify({ success: false, error: "Too many attachments (max 5)" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            }
          );
        }
        const mappedAttachments: Array<{ filename: string; content: string }> = [];
        for (const att of rawAttachments) {
          if (!att?.filename || typeof att.filename !== "string" || !att?.content || typeof att.content !== "string") {
            return new Response(
              JSON.stringify({ success: false, error: "Invalid attachment item" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
              }
            );
          }
          mappedAttachments.push({ filename: att.filename, content: att.content });
        }
        resendPayload.attachments = mappedAttachments;
      }
      // zero attachments → omit attachments field from payload (already omitted)
    }

    // ── Attach exactly one PDF for invoice_issued ─────────────────────────
    // The attachment was fully validated above (magic header, base64, filename).
    // Pass it directly to Resend in the same shape as admin_direct_message.
    if (emailType === "invoice_issued") {
      const invoiceAttachment = (body as any)._invoiceAttachment;
      resendPayload.attachments = [
        { filename: invoiceAttachment.filename, content: invoiceAttachment.content },
      ];
    }

    // ── Attach exactly one immutable receipt PDF for receipt_issued ───────
    // Forwarded unmodified — never decoded, re-rendered, or altered here.
    if (emailType === "receipt_issued") {
      const receiptAttachment = (body as any)._receiptAttachment;
      resendPayload.attachments = [
        { filename: receiptAttachment.filename, content: receiptAttachment.content },
      ];
    }

    // ─── Build Resend request headers ─────────────────────────────────────────
    // For invoice_issued ONLY: add the Idempotency-Key header to the Resend POST.
    // This header is NOT added to any other email type.
    // The key is deterministic: invoice-issued/{invoiceId} — already validated above.
    const resendHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    };
    if (emailType === "invoice_issued") {
      resendHeaders["Idempotency-Key"] = (body as any)._invoiceIdempotencyKey as string;
    }
    // receipt_issued: same mechanism, using the caller-supplied canonical key
    // (receipt-email/{paymentId}) validated above. No second key is derived.
    if (emailType === "receipt_issued") {
      resendHeaders["Idempotency-Key"] = (body as any)._receiptIdempotencyKey as string;
    }

    // ─── Send via Resend ───────────────────────────────────────────────────────
    let resendResponse: Response;
    try {
      resendResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: resendHeaders,
        body: JSON.stringify(resendPayload),
      });
    } catch (fetchError: unknown) {
      // ── Network/fetch exception — uncertain outcome for invoice_issued ────
      // We cannot prove whether Resend accepted the message.
      if (emailType === "invoice_issued" || emailType === "receipt_issued") {
        const errMsg = fetchError instanceof Error ? fetchError.message : "Network error calling Resend";
        return new Response(
          JSON.stringify({
            success: false,
            emailType,
            deliveryOutcome: "uncertain",
            stage: "fetch",
            providerErrorMessage: errMsg,
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
      // For all other email types: re-throw so the outer catch returns 500
      throw fetchError;
    }

    if (!resendResponse?.ok) {
      // ── Capture safe provider error fields — no keys exposed ─────────────
      const providerStatus = resendResponse.status;
      let providerErrorCode: string | null = null;
      let providerErrorMessage: string | null = null;
      let providerErrorName: string | null = null;

      try {
        const errorBody = await resendResponse.json();
        // Resend error shape: { statusCode, name, message } or { error: { ... } }
        providerErrorCode = errorBody?.statusCode?.toString() ?? errorBody?.error?.statusCode?.toString() ?? null;
        providerErrorName = errorBody?.name ?? errorBody?.error?.name ?? null;
        providerErrorMessage = errorBody?.message ?? errorBody?.error?.message ?? null;
      } catch {
        // Non-JSON error body — leave fields null
      }

      // ── invoice_issued: conservative definite-failure vs uncertain outcome ──
      if (emailType === "invoice_issued" || emailType === "receipt_issued") {
        // Classify conservatively: if the status does not clearly prove the
        // provider rejected the request, treat as uncertain.
        //
        // UNCERTAIN — cannot safely prove the provider did NOT send:
        //   - HTTP 408 (request timeout — provider may have processed it)
        //   - HTTP 409 (idempotency conflict — a prior/concurrent delivery may exist)
        //   - HTTP 5xx (server-side error — provider state unknown)
        //   - error names: concurrent_idempotent_requests, invalid_idempotent_request
        //
        // FAILED — definite client/provider rejection, safe to treat as not accepted:
        //   - HTTP 4xx EXCEPT 408 and 409
        //   - HTTP 429 is classified as failed/retryable: the provider explicitly
        //     rejected the request due to rate limiting (not accepted, safe to retry)
        //
        // DEFAULT: if status does not clearly prove rejection → uncertain.

        const isUncertain =
          providerStatus === 408 ||
          providerStatus === 409 ||
          (providerStatus >= 500 && providerStatus <= 599) ||
          providerErrorName === "concurrent_idempotent_requests" ||
          providerErrorName === "invalid_idempotent_request";

        // Definite 4xx rejection (includes 429 — rate limited, not accepted, retryable)
        // Excludes 408 and 409 which are already caught as uncertain above.
        const isDefiniteFailure =
          !isUncertain &&
          providerStatus >= 400 &&
          providerStatus <= 499;

        if (isUncertain) {
          return new Response(
            JSON.stringify({
              success: false,
              emailType,
              deliveryOutcome: "uncertain",
              stage: "resend",
              providerStatus,
              providerErrorCode,
              providerErrorName,
              providerErrorMessage,
            }),
            {
              status: 502,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }

        if (isDefiniteFailure) {
          return new Response(
            JSON.stringify({
              success: false,
              emailType,
              deliveryOutcome: "failed",
              stage: "resend",
              providerStatus,
              providerErrorCode,
              providerErrorName,
              providerErrorMessage,
            }),
            {
              status: 502,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }

        // Default: status does not clearly prove rejection → classify as uncertain.
        return new Response(
          JSON.stringify({
            success: false,
            emailType,
            deliveryOutcome: "uncertain",
            stage: "resend",
            providerStatus,
            providerErrorCode,
            providerErrorName,
            providerErrorMessage,
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      // For admin_direct_message: return structured provider error to trusted caller
      if (emailType === "admin_direct_message") {
        return new Response(
          JSON.stringify({
            success: false,
            stage: "resend",
            providerStatus,
            providerErrorCode,
            providerErrorName,
            providerErrorMessage,
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      // For all other email types: preserve existing throw behavior
      throw new Error(`Resend API error (HTTP ${providerStatus}): ${providerErrorMessage ?? providerErrorName ?? "unknown error"}`);
    }

    let resendData: Record<string, unknown>;
    try {
      resendData = await resendResponse?.json();
    } catch {
      // ── Malformed provider success response — uncertain for invoice_issued ─
      if (emailType === "invoice_issued" || emailType === "receipt_issued") {
        return new Response(
          JSON.stringify({
            success: false,
            emailType,
            deliveryOutcome: "uncertain",
            stage: "resend_parse",
            providerStatus: resendResponse.status,
            providerErrorMessage: "Provider returned a success HTTP status but the response body could not be parsed.",
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
      resendData = {};
    }

    // ── Strict provider message ID validation ─────────────────────────────
    // Resend returned 2xx but we must verify the message ID is a non-empty string.
    // A missing, null, empty, or non-string ID is treated as a malformed provider
    // response — we must NOT report success or fabricate an ID.
    const providedId = resendData?.id;
    const validMessageId = typeof providedId === "string" && providedId.trim().length > 0;

    if (!validMessageId) {
      // ── invoice_issued: missing/unusable email ID → uncertain outcome ─────
      if (emailType === "invoice_issued" || emailType === "receipt_issued") {
        return new Response(
          JSON.stringify({
            success: false,
            emailType,
            deliveryOutcome: "uncertain",
            stage: "resend_id",
            providerStatus: resendResponse.status,
            providerErrorMessage: "Provider returned a success HTTP status but did not return a usable message ID.",
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      if (emailType === "admin_direct_message") {
        return new Response(
          JSON.stringify({
            success: false,
            stage: "resend",
            providerStatus: resendResponse.status,
            providerErrorCode: "missing_message_id",
            providerErrorMessage: "Email provider returned an invalid success response.",
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
      // For all other email types: throw so the existing error handler returns 500
      // without fabricating an ID.
      throw new Error("Email provider returned a success response without a valid message ID.");
    }

    // ── invoice_issued: structured success response ───────────────────────
    // emailId is returned so the future server helper can pass it to
    // complete_invoice_email_delivery_success().
    if (emailType === "invoice_issued" || emailType === "receipt_issued") {
      return new Response(
        JSON.stringify({
          success: true,
          emailType,
          emailId: providedId,
          deliveryOutcome: "sent",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({ success: true, emailId: providedId, emailType }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
});
