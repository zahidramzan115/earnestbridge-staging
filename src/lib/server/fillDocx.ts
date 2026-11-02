import PizZip from 'pizzip';

const PART_RE = /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/;

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
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textNodeXml(attrs: string, text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  return lines
    .map((line, index) => {
      const nodeAttrs = index === 0 ? attrs : ' xml:space="preserve"';
      const br = index === 0 ? '' : '<w:br/>';
      return `${br}<w:t${nodeAttrs}>${escapeXml(line)}</w:t>`;
    })
    .join('');
}

function replaceFirst(texts: string[], token: string, value: string): string[] {
  const combined = texts.join('');
  const at = combined.indexOf(token);
  if (at < 0) return texts;
  const end = at + token.length;
  let cursor = 0;
  let startNode = -1;
  let startOffset = 0;
  let endNode = -1;
  let endOffset = 0;
  for (let i = 0; i < texts.length; i++) {
    const next = cursor + texts[i].length;
    if (startNode < 0 && at < next) {
      startNode = i;
      startOffset = at - cursor;
    }
    if (end <= next) {
      endNode = i;
      endOffset = end - cursor;
      break;
    }
    cursor = next;
  }
  if (startNode < 0 || endNode < 0) return texts;
  const nextTexts = texts.slice();
  if (startNode === endNode) {
    nextTexts[startNode] = texts[startNode].slice(0, startOffset) + value + texts[startNode].slice(endOffset);
    return nextTexts;
  }
  nextTexts[startNode] = texts[startNode].slice(0, startOffset) + value;
  for (let i = startNode + 1; i < endNode; i++) nextTexts[i] = '';
  nextTexts[endNode] = texts[endNode].slice(endOffset);
  return nextTexts;
}

function fillXml(xml: string, tokens: Array<[string, string]>): string {
  const re = /<w:p\b[^>]*>|<\/w:p>|<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
  const nodes: { start: number; end: number; attrs: string; text: string; para: number }[] = [];
  const stack: number[] = [];
  let nextPara = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    if (match[0].startsWith('</w:p>')) {
      stack.pop();
      continue;
    }
    if (match[0].startsWith('<w:p')) {
      stack.push(nextPara++);
      continue;
    }
    nodes.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: match[1] || '',
      text: decodeXml(match[2] ?? ''),
      para: stack.length ? stack[stack.length - 1] : -1,
    });
  }

  const byPara = new Map<number, number[]>();
  nodes.forEach((node, index) => {
    const list = byPara.get(node.para) ?? [];
    list.push(index);
    byPara.set(node.para, list);
  });

  const updated = nodes.map((node) => node.text);
  for (const indexes of byPara.values()) {
    let texts = indexes.map((index) => updated[index]);
    for (const [token, value] of tokens) {
      let guard = 0;
      while (texts.join('').includes(token) && guard < 100) {
        const before = texts.join('');
        texts = replaceFirst(texts, token, value);
        guard += 1;
        if (texts.join('') === before) break;
      }
    }
    indexes.forEach((index, offset) => {
      updated[index] = texts[offset];
    });
  }

  let result = xml;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (updated[i] === nodes[i].text) continue;
    result = result.slice(0, nodes[i].start) + textNodeXml(nodes[i].attrs, updated[i]) + result.slice(nodes[i].end);
  }
  return result;
}

export function plainDocxText(xml: string): string {
  return decodeXml(xml.replace(/<[^>]+>/g, ''));
}

export function fillDocx(template: Buffer, replacements: Record<string, string>): Buffer {
  const tokens = Object.entries(replacements).sort((a, b) => b[0].length - a[0].length);
  const zip = new PizZip(template);
  for (const name of Object.keys(zip.files)) {
    if (!PART_RE.test(name)) continue;
    const file = zip.file(name);
    if (!file) continue;
    const filled = fillXml(file.asText(), tokens);
    const text = plainDocxText(filled);
    const left = tokens.filter(([token]) => text.includes(token)).map(([token]) => token);
    if (left.length > 0) {
      throw new Error(`Unfilled placeholders in ${name}: ${left.join(', ')}`);
    }
    zip.file(name, filled);
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
