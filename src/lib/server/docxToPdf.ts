import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const WORD_CANDIDATES = [
  'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
  'C:\\Program Files\\Microsoft Office\\root\\Office15\\WINWORD.EXE',
  'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
];

function wordExecutable(): string | null {
  return WORD_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function runWord(docxPath: string, pdfPath: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($env:EB_DOCX)
  $doc.SaveAs2($env:EB_PDF, 17)
} finally {
  if ($doc -ne $null) { $doc.Close([ref]$false) | Out-Null }
  if ($word -ne $null) { $word.Quit() | Out-Null }
}
`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, EB_DOCX: docxPath, EB_PDF: pdfPath },
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PDF conversion timed out.'));
    }, 90000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(pdfPath)) resolve();
      else reject(new Error(stderr.trim() || 'PDF conversion failed.'));
    });
  });
}

export async function docxToPdf(docx: Buffer): Promise<Buffer> {
  if (!wordExecutable()) throw new Error('PDF conversion is not available on this server.');
  const dir = await mkdtemp(path.join(tmpdir(), 'eb-pdf-'));
  const docxPath = path.join(dir, 'document.docx');
  const pdfPath = path.join(dir, 'document.pdf');
  try {
    await writeFile(docxPath, docx);
    await runWord(docxPath, pdfPath);
    const pdf = await readFile(pdfPath);
    if (!pdf.subarray(0, 5).toString().startsWith('%PDF')) throw new Error('PDF conversion failed.');
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
