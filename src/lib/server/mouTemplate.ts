import { readFile } from 'fs/promises';
import path from 'path';
import { MOU_SOURCE_FIELDS, type MouFieldKey } from '@/lib/documents/mouFields';
import { fillDocx } from '@/lib/server/fillDocx';

export interface MouSourceDeal {
  client_legal_name?: string | null;
  property_address?: string | null;
  deposit_amount?: number | string | null;
  escrow_agent?: string | null;
  admin_fee?: number | string | null;
  deal_fee?: number | string | null;
  option_term?: string | null;
  client_notice_address?: string | null;
  client_representative_name?: string | null;
  client_notice_email?: string | null;
  client_signatory_name?: string | null;
  client_signatory_title?: string | null;
  mou_effective_date?: string | null;
}

function textValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function moneyValue(value: string | number | null | undefined): string {
  const raw = textValue(value);
  if (!raw) return '';
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return '';
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dateValue(value: string | null | undefined): string {
  const raw = textValue(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

export function mouFieldValue(deal: MouSourceDeal, key: MouFieldKey): string {
  if (key === 'deposit_amount' || key === 'admin_fee' || key === 'deal_fee') return moneyValue(deal[key]);
  if (key === 'mou_effective_date') return dateValue(deal.mou_effective_date);
  return textValue(deal[key]);
}

export function missingMouLabels(deal: MouSourceDeal): string[] {
  return MOU_SOURCE_FIELDS.filter((field) => mouFieldValue(deal, field.key).length === 0).map((field) => field.label);
}

export async function renderMou(deal: MouSourceDeal): Promise<Buffer> {
  const missing = missingMouLabels(deal);
  if (missing.length > 0) {
    throw new Error(`Missing MOU fields: ${missing.join(', ')}`);
  }
  const template = await readFile(path.join(process.cwd(), 'templates', 'MOU.docx'));
  const replacements: Record<string, string> = {};
  for (const field of MOU_SOURCE_FIELDS) {
    replacements[field.token] = mouFieldValue(deal, field.key);
  }
  return fillDocx(template, replacements);
}
