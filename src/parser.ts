// Minimal Scrapbox-notation parser.
// Supports: [[bold]], [link] / [url] / [url label], #tag, plain text.
// Not supported (yet): headings ([* text]), code blocks, images, strikethrough.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const URL_RE = /^https?:\/\/\S+$/;

// Returns the page titles this line links to (internal links + tags).
export function extractLinks(text: string): string[] {
  const links: string[] = [];
  const withoutBold = text.replace(/\[\[([^\[\]]+)\]\]/g, (_, inner: string) => inner);

  const bracketRe = /\[([^\[\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = bracketRe.exec(withoutBold))) {
    const content = m[1]!.trim();
    if (URL_RE.test(content)) continue; // pure external link, no label
    const parts = content.split(/\s+/);
    if (URL_RE.test(parts[0]!)) continue; // "url label" form -> external
    links.push(content);
  }

  const tagRe = /(^|\s)#(\S+)/g;
  while ((m = tagRe.exec(withoutBold))) {
    links.push(m[2]!);
  }
  return links;
}

// Renders a single line of Scrapbox notation to safe HTML.
export function renderLine(text: string): string {
  if (text.length === 0) return '<br>';

  // Tokenize left-to-right so we don't double-process nested brackets.
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('[[', i)) {
      const end = text.indexOf(']]', i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        out += `<strong>${escapeHtml(inner)}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '[') {
      const end = text.indexOf(']', i + 1);
      if (end !== -1) {
        const content = text.slice(i + 1, end).trim();
        out += renderBracket(content);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === '#') {
      const m = /^#(\S+)/.exec(text.slice(i));
      if (m) {
        const tag = m[1]!;
        out += `<a class="link tag" href="#/page/${encodeURIComponent(tag)}">#${escapeHtml(tag)}</a>`;
        i += m[0].length;
        continue;
      }
    }
    out += escapeHtml(text[i]!);
    i++;
  }
  return out;
}

export interface IndentedLine {
  depth: number;
  content: string;
}

// Scrapbox-style outline indent: each leading half-width space, full-width
// space, or tab counts as one level of depth (not pairs), stripped from the
// content that actually gets rendered/linkified.
export function splitIndent(text: string): IndentedLine {
  let depth = 0;
  while (depth < text.length) {
    const ch = text[depth];
    if (ch === ' ' || ch === '\t' || ch === '　') depth++;
    else break;
  }
  return { depth, content: text.slice(depth) };
}

function renderBracket(content: string): string {
  if (URL_RE.test(content)) {
    return `<a class="link external" href="${escapeHtml(content)}" target="_blank" rel="noopener noreferrer">${escapeHtml(content)}</a>`;
  }
  const parts = content.split(/\s+/);
  if (URL_RE.test(parts[0]!)) {
    const url = parts[0]!;
    const label = content.slice(url.length).trim() || url;
    return `<a class="link external" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }
  return `<a class="link internal" href="#/page/${encodeURIComponent(content)}">${escapeHtml(content)}</a>`;
}
