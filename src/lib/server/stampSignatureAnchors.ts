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

export function stampClientSignature(docx: Buffer, anchorId: string): { docx: Buffer; signAnchor: string; dateAnchor: string } {
  const signAnchor = `/eb-sign-${anchorId}/`;
  const dateAnchor = `/eb-date-${anchorId}/`;
  const zip = new PizZip(docx);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('The signature line was not found.');
  const paragraphs = entry.asText().match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  let armed = false;
  let stamped = false;
  const next = paragraphs.map((paragraph) => {
    if (stamped) return paragraph;
    const text = paragraphText(paragraph);
    const clientBlock = text === 'CLIENT:' || text.includes('Signature of Affiant');
    const signatureLine = text.includes('By:');
    if (clientBlock && signatureLine) {
      armed = false;
      stamped = true;
      return withAnchorRun(paragraph, `${signAnchor} ${dateAnchor}`);
    }
    if (clientBlock) {
      armed = true;
      return paragraph;
    }
    if (armed && signatureLine) {
      armed = false;
      stamped = true;
      return withAnchorRun(paragraph, `${signAnchor} ${dateAnchor}`);
    }
    return paragraph;
  });
  if (!stamped) throw new Error('The signature line was not found.');
  zip.file('word/document.xml', entry.asText().replace(/<w:p\b[\s\S]*?<\/w:p>/g, () => next.shift() ?? ''));
  return {
    docx: zip.generate({ type: 'nodebuffer' }) as Buffer,
    signAnchor,
    dateAnchor,
  };
}
