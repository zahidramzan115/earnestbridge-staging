import 'server-only';

import { qboGet, qboQuoteLiteral, type QboEnvironment } from './client';

// QuickBooks invoice lookup and payer identity matching for the /payment page.

export interface QboInvoice {
  Id: string;
  DocNumber?: string;
  TotalAmt: number;
  Balance: number;
  CurrencyRef?: { value: string };
  CustomerRef: { value: string; name?: string };
  BillEmail?: { Address?: string };
  BillEmailCc?: { Address?: string };
  PrivateNote?: string;
  LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
  Line?: Array<{
    Description?: string;
    DetailType?: string;
    SalesItemLineDetail?: { ItemRef?: { name?: string } };
  }>;
}

interface QboCustomer {
  Id: string;
  DisplayName?: string;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  FullyQualifiedName?: string;
  PrimaryEmailAddr?: { Address?: string };
  Active?: boolean;
}

export async function findInvoicesByNumber(invoiceNumber: string): Promise<{
  invoices: QboInvoice[];
  realmId: string;
  environment: QboEnvironment;
}> {
  const query = `select * from Invoice where DocNumber = ${qboQuoteLiteral(invoiceNumber)} maxresults 10`;
  const { data, realmId, environment } = await qboGet<{ QueryResponse?: { Invoice?: QboInvoice[] } }>(
    `/query?query=${encodeURIComponent(query)}`,
  );
  return { invoices: data.QueryResponse?.Invoice ?? [], realmId, environment };
}

export async function getInvoiceById(invoiceId: string): Promise<{ invoice: QboInvoice | null; realmId: string }> {
  const { data, realmId } = await qboGet<{ Invoice?: QboInvoice }>(`/invoice/${encodeURIComponent(invoiceId)}`);
  return { invoice: data.Invoice ?? null, realmId };
}

export async function getCustomer(customerId: string): Promise<QboCustomer | null> {
  try {
    const { data } = await qboGet<{ Customer?: QboCustomer }>(`/customer/${encodeURIComponent(customerId)}`);
    return data.Customer ?? null;
  } catch {
    return null;
  }
}

// ── Identity matching ────────────────────────────────────────────────────────

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitEmails(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[,;]/).map(normalizeEmail).filter(Boolean);
}

export function isEmailIdentifier(identifier: string): boolean {
  return identifier.includes('@');
}

/** True when the payer's email or name matches the invoice or its customer. */
export function identityMatches(identifier: string, invoice: QboInvoice, customer: QboCustomer | null): boolean {
  if (isEmailIdentifier(identifier)) {
    const entered = normalizeEmail(identifier);
    const known = [
      ...splitEmails(invoice.BillEmail?.Address),
      ...splitEmails(invoice.BillEmailCc?.Address),
      ...splitEmails(customer?.PrimaryEmailAddr?.Address),
    ];
    return known.includes(entered);
  }

  const entered = normalizeName(identifier);
  if (entered.length < 2) return false;
  const known = [
    invoice.CustomerRef.name,
    customer?.DisplayName,
    customer?.CompanyName,
    customer?.FullyQualifiedName,
    [customer?.GivenName, customer?.FamilyName].filter(Boolean).join(' '),
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map(normalizeName);
  return known.includes(entered);
}

// ── Display helpers ──────────────────────────────────────────────────────────

export function invoiceDescription(invoice: QboInvoice): string | null {
  for (const line of invoice.Line ?? []) {
    if (line.DetailType === 'SalesItemLineDetail' || line.DetailType === 'DescriptionOnly') {
      const text = line.Description?.trim() || line.SalesItemLineDetail?.ItemRef?.name?.trim();
      if (text) return text.slice(0, 500);
    }
  }
  return null;
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** QuickBooks keeps voided invoices with a zero total and a "Voided" note. */
export function isVoided(invoice: QboInvoice): boolean {
  return invoice.TotalAmt === 0 && /voided/i.test(invoice.PrivateNote ?? '');
}
