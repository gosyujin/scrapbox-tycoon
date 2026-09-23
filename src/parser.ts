// Scrapbox-notation parser, ported from scrapbox-pwa-viewer's build.py
// (https://github.com/gosyujin/scrapbox-pwa-viewer) to keep the two
// projects' rendering in sync. Two layers:
//   - Inline: parseInline() tokenizes one line's text into an AST
//     (parseInline -> InlineToken[]), which both renderLine() (HTML) and
//     extractLinks() (backlink targets) walk. One shared AST rather than
//     two independently-written pattern matchers is deliberate: pwa-viewer
//     originally had exactly that duplication and it caused a real bug
//     (symbols like & ' ( ) $ were misclassified as links to nonexistent
//     pages in one of the two passes but not the other).
//   - Block: renderLinesInto() walks a page's lines, folding code:/table:
//     blocks (which span multiple source lines) into single rendered
//     nodes, and rendering quote/plain lines individually.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FULL_URL_RE = /^https?:\/\/\S+$/;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i;
const GYAZO_RE = /^https?:\/\/(i\.)?gyazo\.com\/[0-9a-fA-F]+/i;
const HASHTAG_RE = /^#([^\s[\]#]+)/;
// A leading run of characters that are neither Unicode letters/digits nor
// whitespace/brackets, followed by a space, marks decoration (Scrapbox
// treats ANY such run this way, not just the four with built-in meaning:
// * - / _). \p{L}/\p{N} (with the `u` flag) matter here specifically
// because \w alone is ASCII-only in JS -- without \p{L}, Japanese text
// right after "[" would itself be misread as decoration marks.
const DECORATION_RE = /^([^\p{L}\p{N}\s[\]]+) (.*)$/u;

function isUrl(s: string): boolean {
  return FULL_URL_RE.test(s);
}

function isImageUrl(u: string): boolean {
  return IMG_EXT_RE.test(u) || GYAZO_RE.test(u);
}

function matchUrlAt(text: string, i: number): string | null {
  const m = /^https?:\/\/[^\s\]]+/.exec(text.slice(i));
  return m ? m[0] : null;
}

// text[start] must be '['. Returns the index of the matching ']', or -1.
function findMatchingBracket(text: string, start: number): number {
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '[') depth++;
    else if (text[j] === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'tag'; title: string }
  | { type: 'link'; title: string; strong: boolean }
  | { type: 'externalLink'; url: string; label: string }
  | { type: 'image'; url: string }
  | { type: 'decoration'; marks: string; children: InlineToken[] };

function urlAloneToken(url: string): InlineToken {
  return isImageUrl(url) ? { type: 'image', url } : { type: 'externalLink', url, label: url };
}

function parseBracket(inner: string): InlineToken[] {
  if (inner === '') return [];

  const deco = DECORATION_RE.exec(inner);
  if (deco) {
    const marks = deco[1]!;
    const content = deco[2]!;
    return [{ type: 'decoration', marks, children: parseInline(content) }];
  }

  // [[...]] -> a strong (bold-styled) link, or a strong image if the inner
  // content is itself a bare URL. Matches real Scrapbox: [[x]] is a link,
  // not just bold plain text.
  if (inner.startsWith('[') && inner.endsWith(']') && inner.length >= 2) {
    const j = findMatchingBracket(inner, 0);
    if (j === inner.length - 1) {
      const sub = inner.slice(1, -1);
      return isUrl(sub) ? [urlAloneToken(sub)] : [{ type: 'link', title: sub, strong: true }];
    }
  }

  const tokens = inner.split(' ');
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;

  if (isUrl(first)) {
    const rest = inner.slice(first.length).trim();
    return [rest ? { type: 'externalLink', url: first, label: rest } : urlAloneToken(first)];
  }
  if (isUrl(last)) {
    const rest = inner.slice(0, inner.length - last.length).trim();
    return [rest ? { type: 'externalLink', url: last, label: rest } : urlAloneToken(last)];
  }

  if (inner.endsWith('.icon')) {
    const name = inner.slice(0, -5).trim() || 'icon';
    return [{ type: 'link', title: name, strong: false }];
  }

  return [{ type: 'link', title: inner, strong: false }];
}

// Tokenizes one line's inline content (no leading indentation, no block
// prefix like "code:" or ">" -- see renderLinesInto for those).
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let textBuf = '';
  const flush = () => {
    if (textBuf) {
      tokens.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '`') {
      const j = text.indexOf('`', i + 1);
      if (j === -1) {
        textBuf += text.slice(i);
        i = n;
        continue;
      }
      flush();
      tokens.push({ type: 'code', text: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (ch === '[') {
      const j = findMatchingBracket(text, i);
      if (j === -1) {
        textBuf += ch;
        i++;
        continue;
      }
      flush();
      tokens.push(...parseBracket(text.slice(i + 1, j)));
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const m = HASHTAG_RE.exec(text.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'tag', title: m[1]! });
        i += m[0].length;
        continue;
      }
    }
    if (text.startsWith('http://', i) || text.startsWith('https://', i)) {
      const url = matchUrlAt(text, i);
      if (url) {
        flush();
        tokens.push(urlAloneToken(url));
        i += url.length;
        continue;
      }
    }
    textBuf += ch;
    i++;
  }
  flush();
  return tokens;
}

// Collects the page titles a line links to (internal links + strong links
// + .icon links + tags), recursing into decoration content -- used for
// backlinks. Shares parseInline with renderLine so "does this count as a
// link" can never drift between the two (see the file header).
export function extractLinks(text: string): string[] {
  return collectLinks(parseInline(text));
}

function collectLinks(tokens: InlineToken[]): string[] {
  const links: string[] = [];
  for (const t of tokens) {
    if (t.type === 'tag' || t.type === 'link') links.push(t.title);
    else if (t.type === 'decoration') links.push(...collectLinks(t.children));
  }
  return links;
}

export interface RenderOpts {
  // Where internal links/tags point: the editable-notes route by default,
  // or the read-only reference-project route when rendering an imported
  // page (see reference-store.ts) -- following a link there stays inside
  // that same separate page set.
  linkBase: string;
  // Lower-cased titles known to exist, for the exists/missing link
  // color-coding (a scrapbox-tycoon-only convention, not in real
  // Scrapbox). Compute once per page render (store.listPages() /
  // reference-store's getAllTitlesLowercased()), not per link.
  knownTitles: Set<string>;
}

function renderInternalLink(title: string, opts: RenderOpts, extraClasses: string[]): string {
  const exists = opts.knownTitles.has(title.toLowerCase());
  const classes = ['link', ...extraClasses, exists ? 'exists' : 'missing'];
  return `<a class="${classes.join(' ')}" href="${opts.linkBase}${encodeURIComponent(title)}">${escapeHtml(title)}</a>`;
}

function renderToken(t: InlineToken, opts: RenderOpts): string {
  switch (t.type) {
    case 'text':
      return escapeHtml(t.text);
    case 'code':
      return `<code class="inline-code">${escapeHtml(t.text)}</code>`;
    case 'tag':
      return renderInternalLink(t.title, opts, ['tag']);
    case 'link':
      return renderInternalLink(t.title, opts, t.strong ? ['strong'] : []);
    case 'externalLink':
      return `<a class="link external" href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.label)}</a>`;
    case 'image':
      return (
        `<a class="img-embed" href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer">` +
        `<img src="${escapeHtml(t.url)}" loading="lazy" alt="">` +
        `<span class="img-caption">${escapeHtml(t.url)}</span></a>`
      );
    case 'decoration': {
      const rendered = t.children.map((c) => renderToken(c, opts)).join('');
      const classes: string[] = [];
      const starCount = [...t.marks].filter((c) => c === '*').length;
      if (starCount >= 3) classes.push('sb-h1');
      else if (starCount === 2) classes.push('sb-h2');
      else if (starCount === 1) classes.push('sb-h3');
      if (t.marks.includes('-')) classes.push('sb-strike');
      if (t.marks.includes('/')) classes.push('sb-em');
      if (t.marks.includes('_')) classes.push('sb-underline');
      const customClasses: string[] = [];
      for (const ch of t.marks) {
        if (!'*-/_'.includes(ch) && !customClasses.includes(`deco-${ch}`)) customClasses.push(`deco-${ch}`);
      }
      if (classes.length === 0 && customClasses.length === 0) classes.push('sb-strong');
      return `<span class="${escapeHtml([...classes, ...customClasses].join(' '))}">${rendered}</span>`;
    }
  }
}

// Renders a single line's inline content (post block-prefix-stripping --
// see renderLinesInto) to safe HTML.
export function renderLine(text: string, opts: RenderOpts): string {
  if (text.length === 0) return '<br>';
  return parseInline(text)
    .map((t) => renderToken(t, opts))
    .join('');
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

function leadingWhitespaceCount(s: string): number {
  let n = 0;
  while (n < s.length && (s[n] === ' ' || s[n] === '\t' || s[n] === '　')) n++;
  return n;
}

// Strips whatever leading whitespace is common to every non-blank line of
// a code:/table: block, so relative indentation *within* the block survives
// but the block marker's own indent level doesn't leak into its text.
function stripCommonIndent(blockLines: string[]): string {
  if (blockLines.length === 0) return '';
  const indents = blockLines.filter((l) => l.trim() !== '').map(leadingWhitespaceCount);
  const base = indents.length ? Math.min(...indents) : 0;
  return blockLines.map((l) => (l.length >= base ? l.slice(base) : '')).join('\n');
}

function applyIndent(el: HTMLElement, depth: number): void {
  if (depth > 0) el.style.paddingLeft = `${0.6 + depth * 1.2}em`;
}

// .indent-bullet's own width (1em) + margin-right (0.2em) in css/style.css.
const BULLET_WIDTH_EM = 1.2;

// Like applyIndent, but for a line that also gets a bullet marker: without
// this, a wrapped (long) line's continuation lines land flush with the
// bullet's own left edge instead of under the text that follows it, since
// the bullet is just inline content pushing the first line over -- padding
// alone has no way to know a bullet came before it. Pushing padding-left
// out by the bullet's width and pulling the first line back by the same
// amount with a negative text-indent (which -- per CSS -- only affects a
// block's first line) makes the bullet sit in that reclaimed space while
// every line, wrapped or not, lines up at the same text column.
function applyBulletIndent(el: HTMLElement, depth: number): void {
  el.style.paddingLeft = `${0.6 + depth * 1.2 + BULLET_WIDTH_EM}em`;
  el.style.textIndent = `-${BULLET_WIDTH_EM}em`;
}

// Shared by the editable-page view (editor.ts) and the read-only
// reference-page view (app.ts): renders a title + outline-indented body
// into `container`, replacing its current contents. Each top-level
// rendered node carries data-line-start/data-line-end (0-based, inclusive)
// so callers that need to map a click back to a source line -- the editor's
// click-to-caret -- have something to key off other than DOM child index,
// which code:/table: blocks (one rendered node covering several source
// lines) would otherwise break.
export function renderLinesInto(container: HTMLElement, lines: string[], opts: RenderOpts): void {
  container.innerHTML = '';

  if (lines.length > 0) {
    const div = document.createElement('div');
    div.className = 'line-view line-title';
    div.dataset.lineStart = '0';
    div.dataset.lineEnd = '0';
    div.innerHTML = renderLine(lines[0] ?? '', opts);
    container.appendChild(div);
  }

  const body = lines.slice(1);
  const n = body.length;
  let i = 0;
  while (i < n) {
    const raw = body[i] ?? '';
    const { depth, content } = splitIndent(raw);
    const lineIndex = i + 1; // index within the full `lines` array

    const codeMatch = /^code:(.*)$/.exec(content);
    const tableMatch = /^table:(.*)$/.exec(content);

    if (codeMatch) {
      const lang = codeMatch[1]!.trim();
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < n && splitIndent(body[j] ?? '').depth > depth) {
        blockLines.push(body[j]!);
        j++;
      }
      const langHtml = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '';
      const div = document.createElement('div');
      div.className = 'line-view';
      div.dataset.lineStart = String(lineIndex);
      div.dataset.lineEnd = String(j);
      applyIndent(div, depth);
      div.innerHTML = `<pre class="sb-code">${langHtml}<code>${escapeHtml(stripCommonIndent(blockLines))}</code></pre>`;
      container.appendChild(div);
      i = j;
      continue;
    }

    if (tableMatch) {
      const name = tableMatch[1]!.trim();
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < n && splitIndent(body[j] ?? '').depth > depth) {
        blockLines.push(body[j]!);
        j++;
      }
      const stripped = blockLines.length ? stripCommonIndent(blockLines).split('\n') : [];
      const rowsHtml = stripped
        .map((r) => `<tr>${r
          .split('\t')
          .map((c) => `<td>${escapeHtml(c)}</td>`)
          .join('')}</tr>`)
        .join('');
      const cap = name ? `<caption>${escapeHtml(name)}</caption>` : '';
      const div = document.createElement('div');
      div.className = 'line-view';
      div.dataset.lineStart = String(lineIndex);
      div.dataset.lineEnd = String(j);
      applyIndent(div, depth);
      div.innerHTML = `<table class="sb-table">${cap}${rowsHtml}</table>`;
      container.appendChild(div);
      i = j;
      continue;
    }

    if (content.startsWith('>')) {
      let qtext = content.slice(1);
      if (qtext.startsWith(' ')) qtext = qtext.slice(1);
      const bq = document.createElement('blockquote');
      bq.className = 'line-view sb-quote';
      bq.dataset.lineStart = String(lineIndex);
      bq.dataset.lineEnd = String(lineIndex);
      applyIndent(bq, depth);
      bq.innerHTML = renderLine(qtext, opts);
      container.appendChild(bq);
      i++;
      continue;
    }

    const div = document.createElement('div');
    div.className = 'line-view';
    div.dataset.lineStart = String(lineIndex);
    div.dataset.lineEnd = String(lineIndex);
    if (depth > 0) {
      applyBulletIndent(div, depth);
      div.innerHTML = `<span class="indent-bullet">•</span>${renderLine(content, opts)}`;
    } else {
      div.innerHTML = renderLine(content, opts);
    }
    container.appendChild(div);
    i++;
  }
}
