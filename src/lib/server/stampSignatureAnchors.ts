import PizZip from 'pizzip';

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paragraphText(paragraph: string): string {
  return [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function withAnchorRun(paragraph: string, anchors: string): string {
  const run = `<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escapeXml(anchors)}</w:t></w:r>`;
  if (paragraph.includes('</w:pPr>')) return paragraph.replace('</w:pPr>', `</w:pPr>${run}`);
  return paragraph.replace(/<w:p\b[^>]*>/, (open) => `${open}${run}`);
}

export type SignerParty = 'client' | 'earnestbridge';

export interface SignatureAnchor {
  party: SignerParty;
  signAnchor: string;
  dateAnchor: string;
}

// Signature block headings and who signs under them.
//   CLIENT: / "Signature of Affiant"         -> client, on the next "By:" line
//   EARNESTBRIDGE: / MEMBER: / COMPANY:       -> EarnestBridge, on the next "By:" line
//   MANAGER:                                   -> EarnestBridge, on this line (no "By:")
function blockParty(text: string): SignerParty | null {
  if (text === 'CLIENT:' || text.includes('Signature of Affiant')) return 'client';
  if (text === 'EARNESTBRIDGE:' || text === 'MEMBER:' || text === 'COMPANY:') return 'earnestbridge';
  return null;
}

/**
 * Adds invisible DocuSign anchor text at every signature line in the document
 * and reports which signer each anchor belongs to. Anchor ids include the
 * document id so they are unique across the envelope.
 */
export function stampSignatures(docx: Buffer, documentId: string): { docx: Buffer; anchors: SignatureAnchor[] } {
  const zip = new PizZip(docx);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('The signature line was not found.');
  const paragraphs = entry.asText().match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  const anchors: SignatureAnchor[] = [];

  const stamp = (paragraph: string, party: SignerParty) => {
    const n = anchors.length + 1;
    const anchor = {
      party,
      signAnchor: `/eb-sign-${documentId}-${n}/`,
      dateAnchor: `/eb-date-${documentId}-${n}/`,
    };
    anchors.push(anchor);
    return withAnchorRun(paragraph, `${anchor.signAnchor} ${anchor.dateAnchor}`);
  };

  let armed: SignerParty | null = null;
  const next = paragraphs.map((paragraph) => {
    const text = paragraphText(paragraph);
    if (text === 'MANAGER:') {
      armed = null;
      return stamp(paragraph, 'earnestbridge');
    }
    const party = blockParty(text);
    const signatureLine = text.includes('By:');
    if (party && signatureLine) {
      armed = null;
      return stamp(paragraph, party);
    }
    if (party) {
      armed = party;
      return paragraph;
    }
    if (armed && signatureLine) {
      const signer: SignerParty = armed;
      armed = null;
      return stamp(paragraph, signer);
    }
    return paragraph;
  });

  if (anchors.length === 0) throw new Error('The signature line was not found.');
  zip.file('word/document.xml', entry.asText().replace(/<w:p\b[\s\S]*?<\/w:p>/g, () => next.shift() ?? ''));
  return { docx: zip.generate({ type: 'nodebuffer' }) as Buffer, anchors };
}
