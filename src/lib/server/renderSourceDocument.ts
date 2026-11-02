import { readFile } from 'fs/promises';
import path from 'path';
import { fillDocx } from '@/lib/server/fillDocx';

export interface SourceField {
  key: string;
  label: string;
  token: string;
  kind: 'text' | 'money' | 'money_with_dollar' | 'date';
}

export interface SourceDeal {
  [key: string]: string | number | null | undefined;
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

function dateValue(value: string | number | null | undefined): string {
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

export function sourceFieldValue(deal: SourceDeal, field: SourceField): string {
  const raw = deal[field.key];
  if (field.kind === 'money') return moneyValue(raw);
  if (field.kind === 'money_with_dollar') {
    const amount = moneyValue(raw);
    return amount ? `$${amount}` : '';
  }
  if (field.kind === 'date') return dateValue(raw);
  return textValue(raw);
}

export function missingSourceLabels(deal: SourceDeal, fields: readonly SourceField[]): string[] {
  const labels = new Set<string>();
  for (const field of fields) {
    if (sourceFieldValue(deal, field).length === 0) labels.add(field.label);
  }
  return [...labels];
}

export async function renderSourceDocument(
  templateFile: string,
  deal: SourceDeal,
  fields: readonly SourceField[]
): Promise<Buffer> {
  const missing = missingSourceLabels(deal, fields);
  if (missing.length > 0) {
    throw new Error(`Missing document fields: ${missing.join(', ')}`);
  }
  const template = await readFile(path.join(process.cwd(), 'templates', templateFile));
  const replacements: Record<string, string> = {};
  for (const field of fields) {
    replacements[field.token] = sourceFieldValue(deal, field);
  }
  return fillDocx(template, replacements);
}
