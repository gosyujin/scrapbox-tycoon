// Turns the document into CodeMirror decorations: the "live preview" that
// makes inactive lines look rendered and the active line show raw notation.
//
//   inactive line: syntax characters ([ ] `code` markers, "* " of [* bold],
//                  the URL half of [label url], ...) are *replaced with
//                  nothing*; the remaining text is styled with marks.
//   active line:   the same marks are kept (links stay blue, headings stay
//                  big), but syntax characters are shown, dimmed.
//
// The text itself is never rewritten -- only decorated -- so copy, undo and
// the saved document are always the raw Scrapbox notation.
import { EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { blockAt, findBlocks, splitIndent } from './blocks';
import { linkConfig } from './config';
import { focusField, focusTracker, isFocusEffect } from './focus';
import { ImageWidget, TableWidget } from './widgets';

// Forces a rebuild without a document change (e.g. a newly created page
// should turn its links from "missing" to "exists").
export const refreshDecorations = StateEffect.define<null>();

// ---- inline scanner --------------------------------------------------------

const URL_ALONE_RE = /^https?:\/\/\S+$/;
const IMG_RE = /\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i;
const GYAZO_RE = /^https?:\/\/(i\.)?gyazo\.com\/[0-9a-fA-F]+/i;
const HASHTAG_RE = /^#([^\s[\]#]+)/;
// Leading non-letter/digit/space/bracket run followed by a space marks
// decoration: [* bold] [/ italic] [- strike] [_ underline] [*/ both] ...
const DECORATION_RE = /^([^\p{L}\p{N}\s[\]]+) (.*)$/u;

const isUrl = (s: string): boolean => URL_ALONE_RE.test(s);
const isImage = (u: string): boolean => IMG_RE.test(u) || GYAZO_RE.test(u);

function matchBracket(text: string, start: number): number {
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

interface Ctx {
  active: boolean;
  out: Range<Decoration>[];
  resolve: (title: string) => { href: string; exists: boolean };
}

const hideDeco = Decoration.replace({});
const syntaxDeco = Decoration.mark({ class: 'sbe-syntax' });

// Syntax characters: invisible on an inactive line, dimmed on the active one.
function syntax(ctx: Ctx, from: number, to: number): void {
  if (to <= from) return;
  ctx.out.push((ctx.active ? syntaxDeco : hideDeco).range(from, to));
}

function mark(ctx: Ctx, from: number, to: number, cls: string, attrs?: Record<string, string>): void {
  if (to <= from) return;
  ctx.out.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to));
}

// Same class names as parser.ts's renderToken, so the global style.css rules
// (.sb-h1, .sb-strike, .deco-\<, ...) style the editor exactly like a
// rendered page.
function decoClass(marks: string): string {
  const cls: string[] = [];
  const stars = [...marks].filter((c) => c === '*').length;
  if (stars >= 3) cls.push('sb-h1');
  else if (stars === 2) cls.push('sb-h2');
  else if (stars === 1) cls.push('sb-h3');
  if (marks.includes('-')) cls.push('sb-strike');
  if (marks.includes('/')) cls.push('sb-em');
  if (marks.includes('_')) cls.push('sb-underline');
  const custom: string[] = [];
  for (const ch of marks) if (!'*-/_'.includes(ch) && !custom.includes(`deco-${ch}`)) custom.push(`deco-${ch}`);
  if (cls.length === 0 && custom.length === 0) cls.push('sb-strong');
  return [...cls, ...custom].join(' ');
}

// Links carry their destination in data-href so one click handler (index.ts)
// serves all of them; `sbe-nav` (inactive lines only) marks the ones a plain
// click follows -- on the active line a click edits instead.
function linkMark(ctx: Ctx, from: number, to: number, extra: string, href: string, external: boolean, exists?: boolean): void {
  const cls = ['sbe-link', extra, external ? 'external' : exists ? 'exists' : 'missing'];
  if (!ctx.active) cls.push('sbe-nav');
  mark(ctx, from, to, cls.filter(Boolean).join(' '), { 'data-href': href, ...(external ? { 'data-ext': '1' } : {}) });
}

function internalLink(ctx: Ctx, from: number, to: number, title: string, extra: string): void {
  const r = ctx.resolve(title);
  linkMark(ctx, from, to, extra, r.href, false, r.exists);
}

// A URL standing alone ("[url]" / bare url): image -> inline <img> widget on
// inactive lines, otherwise a link. [from,to) includes the brackets (if any),
// [innerFrom,innerTo) is just the URL.
function urlAlone(ctx: Ctx, url: string, from: number, to: number, innerFrom: number, innerTo: number): void {
  if (isImage(url) && !ctx.active) {
    ctx.out.push(Decoration.replace({ widget: new ImageWidget(url) }).range(from, to));
    return;
  }
  syntax(ctx, from, innerFrom);
  linkMark(ctx, innerFrom, innerTo, '', url, true);
  syntax(ctx, innerTo, to);
}

// text[i] === '[' and text[j] is its matching ']'. `off` = absolute position
// of text[0].
function bracket(ctx: Ctx, text: string, i: number, j: number, off: number): void {
  const inner = text.slice(i + 1, j);
  if (inner === '') return;
  const A = off + i;
  const B = off + j;

  const deco = DECORATION_RE.exec(inner);
  if (deco) {
    const marks = deco[1]!;
    const contentFrom = A + 1 + marks.length + 1;
    syntax(ctx, A, contentFrom);
    mark(ctx, contentFrom, B, decoClass(marks));
    scanInline(ctx, deco[2]!, contentFrom);
    syntax(ctx, B, B + 1);
    return;
  }

  // [[x]] / [[[x]]]: strong link (or strong image when the core is a URL).
  let lo = i + 1;
  let hi = j;
  let layers = 0;
  while (text[lo] === '[' && matchBracket(text, lo) === hi - 1) {
    lo++;
    hi--;
    layers++;
  }
  if (layers > 0) {
    const core = text.slice(lo, hi);
    if (core === '') return;
    if (isUrl(core)) {
      urlAlone(ctx, core, A, B + 1, off + lo, off + hi);
    } else {
      syntax(ctx, A, off + lo);
      internalLink(ctx, off + lo, off + hi, core, 'strong');
      syntax(ctx, off + hi, B + 1);
    }
    return;
  }

  const tokens = inner.split(' ');
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;

  if (isUrl(first)) {
    const rest = inner.slice(first.length);
    const label = rest.trim();
    if (label) {
      const labelFrom = A + 1 + first.length + (rest.length - rest.trimStart().length);
      syntax(ctx, A, labelFrom);
      linkMark(ctx, labelFrom, labelFrom + label.length, '', first, true);
      syntax(ctx, labelFrom + label.length, B + 1);
    } else {
      urlAlone(ctx, first, A, B + 1, A + 1, B);
    }
    return;
  }
  if (isUrl(last)) {
    const restRaw = inner.slice(0, inner.length - last.length);
    const label = restRaw.trim();
    if (label) {
      const labelFrom = A + 1 + (restRaw.length - restRaw.trimStart().length);
      syntax(ctx, A, labelFrom);
      linkMark(ctx, labelFrom, labelFrom + label.length, '', last, true);
      syntax(ctx, labelFrom + label.length, B + 1);
    } else {
      urlAlone(ctx, last, A, B + 1, A + 1, B);
    }
    return;
  }

  if (inner.endsWith('.icon') && inner.length > 5) {
    syntax(ctx, A, A + 1);
    internalLink(ctx, A + 1, B - 5, inner.slice(0, -5).trim() || 'icon', '');
    syntax(ctx, B - 5, B + 1);
    return;
  }

  syntax(ctx, A, A + 1);
  internalLink(ctx, A + 1, B, inner, '');
  syntax(ctx, B, B + 1);
}

// `text` is the inline part of one line (no indent / block prefix); `off` is
// its absolute document position.
function scanInline(ctx: Ctx, text: string, off: number): void {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '`') {
      const j = text.indexOf('`', i + 1);
      if (j === -1) break;
      syntax(ctx, off + i, off + i + 1);
      mark(ctx, off + i + 1, off + j, 'sbe-inline-code');
      syntax(ctx, off + j, off + j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '[') {
      const j = matchBracket(text, i);
      if (j === -1) {
        i++;
        continue;
      }
      bracket(ctx, text, i, j, off);
      i = j + 1;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      const m = HASHTAG_RE.exec(text.slice(i));
      if (m) {
        internalLink(ctx, off + i, off + i + m[0].length, m[1]!, 'tag');
        i += m[0].length;
        continue;
      }
    }
    if (text.startsWith('http://', i) || text.startsWith('https://', i)) {
      const m = /^https?:\/\/[^\s\]]+/.exec(text.slice(i));
      if (m) {
        urlAlone(ctx, m[0], off + i, off + i + m[0].length, off + i, off + i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
}

// ---- line / block layer ------------------------------------------------------

function lineDeco(classes: string[], depth: number): Decoration {
  return Decoration.line({ class: classes.join(' '), attributes: { style: `--depth:${depth}` } });
}

// One 1.2em-wide cell per leading whitespace character, on every line --
// active or not -- so expanding a line never shifts its indentation.
function indentCells(ctx: Ctx, lineFrom: number, cells: number): void {
  for (let k = 0; k < cells; k++) {
    ctx.out.push(Decoration.mark({ class: 'sbe-ws' }).range(lineFrom + k, lineFrom + k + 1));
  }
}

function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  const focused = state.field(focusField);
  const cfg = state.facet(linkConfig);
  const resolve = (title: string): { href: string; exists: boolean } => {
    const key = title.toLowerCase();
    if (cfg.knownTitles.has(key)) return { href: `${cfg.linkBase}${encodeURIComponent(title)}`, exists: true };
    if (cfg.fallback?.knownTitles.has(key)) return { href: `${cfg.fallback.linkBase}${encodeURIComponent(title)}`, exists: true };
    return { href: `${cfg.linkBase}${encodeURIComponent(title)}`, exists: false };
  };
  const activeLines = new Set<number>();
  if (focused) {
    for (const r of state.selection.ranges) {
      const a = doc.lineAt(r.from).number;
      const b = doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) activeLines.add(n);
    }
  }

  const out: Range<Decoration>[] = [];
  const blocks = findBlocks(doc);

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const ctx: Ctx = { active: activeLines.has(n), out, resolve };
    const block = blockAt(blocks, n);

    // Tables: a single block widget over the whole block while no line of it
    // is active; raw monospace lines (tabs visible) otherwise.
    if (block?.kind === 'table') {
      if (n === block.head) {
        let tableActive = false;
        for (let k = block.head; k <= block.end; k++) if (activeLines.has(k)) tableActive = true;
        if (!tableActive && block.end > block.head) {
          const rows: string[][] = [];
          const bodyIndents: number[] = [];
          for (let k = block.head + 1; k <= block.end; k++) bodyIndents.push(splitIndent(doc.line(k).text).depth);
          const strip = Math.min(...bodyIndents);
          for (let k = block.head + 1; k <= block.end; k++) rows.push(doc.line(k).text.slice(strip).split('\t'));
          out.push(
            Decoration.replace({
              widget: new TableWidget(block.name, rows, doc.line(block.head + 1).from),
              block: true,
            }).range(line.from, doc.line(block.end).to),
          );
          n = block.end; // skip decorating the covered lines
          continue;
        }
      }
      const base = n === block.head ? block.depth : block.depth + 1;
      out.push(lineDeco(['sbe-line', 'sbe-code-line', n === block.head ? 'sbe-code-head' : 'sbe-table-raw'], base).range(line.from));
      indentCells(ctx, line.from, base);
      if (n === block.head) {
        const content = line.text.slice(block.depth);
        const prefix = content.indexOf(':') + 1;
        syntax(ctx, line.from + block.depth, line.from + block.depth + prefix);
        mark(ctx, line.from + block.depth + prefix, line.to, 'sbe-code-name');
      }
      continue;
    }

    if (block?.kind === 'code') {
      const isHead = n === block.head;
      const cells = isHead ? block.depth : block.depth + 1;
      out.push(lineDeco(['sbe-line', 'sbe-code-line', isHead ? 'sbe-code-head' : 'sbe-code-body'], cells).range(line.from));
      indentCells(ctx, line.from, cells);
      if (isHead) {
        const prefix = line.text.slice(block.depth).indexOf(':') + 1;
        syntax(ctx, line.from + block.depth, line.from + block.depth + prefix);
        mark(ctx, line.from + block.depth + prefix, line.to, 'sbe-code-name');
      }
      continue;
    }

    const { depth, content } = splitIndent(line.text);
    const classes = ['sbe-line'];
    if (n === 1) classes.push('sbe-title');
    else if (depth > 0) classes.push('sbe-indented');
    const isQuote = n > 1 && content.startsWith('>');
    if (isQuote) classes.push('sbe-quote');
    out.push(lineDeco(classes, n === 1 ? 0 : depth).range(line.from));
    if (n > 1) indentCells(ctx, line.from, depth);

    let inlineFrom = line.from + depth;
    if (isQuote) {
      const markLen = content.startsWith('> ') ? 2 : 1;
      syntax(ctx, inlineFrom, inlineFrom + markLen);
      inlineFrom += markLen;
    }
    scanInline(ctx, line.text.slice(inlineFrom - line.from), inlineFrom);
  }

  return Decoration.set(out, true);
}

const decorationField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    const forced = tr.effects.some((e) => isFocusEffect(e) || e.is(refreshDecorations));
    if (tr.docChanged || tr.selection || forced) return build(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const liveRender = [focusField, focusTracker, decorationField];
