// Line/block structure of a Scrapbox page, independent of CodeMirror's
// decoration machinery so the Tab command and the decoration builder agree
// on what counts as "inside a code:/table: block".
import type { Text } from '@codemirror/state';

export interface Indent {
  depth: number;
  content: string;
}

// Same rule as Scrapbox / the main app: every leading half-width space,
// tab or full-width space is one indent level.
export function splitIndent(text: string): Indent {
  let depth = 0;
  while (depth < text.length) {
    const ch = text[depth];
    if (ch === ' ' || ch === '\t' || ch === '　') depth++;
    else break;
  }
  return { depth, content: text.slice(depth) };
}

export interface Block {
  kind: 'code' | 'table';
  name: string;
  depth: number; // indent depth of the `code:` / `table:` header line
  head: number; // 1-based line number of the header
  end: number; // 1-based line number of the last body line (== head if empty)
}

// Scans the whole doc. Line 1 is the page title and never starts a block.
// A block's body is the run of lines indented deeper than its header.
export function findBlocks(doc: Text): Block[] {
  const blocks: Block[] = [];
  let n = 2;
  while (n <= doc.lines) {
    const { depth, content } = splitIndent(doc.line(n).text);
    const m = /^(code|table):(.*)$/.exec(content);
    if (!m) {
      n++;
      continue;
    }
    let end = n;
    while (end + 1 <= doc.lines && splitIndent(doc.line(end + 1).text).depth > depth) end++;
    blocks.push({ kind: m[1] as 'code' | 'table', name: m[2]!.trim(), depth, head: n, end });
    n = end + 1;
  }
  return blocks;
}

export function blockAt(blocks: Block[], lineNumber: number): Block | undefined {
  return blocks.find((b) => lineNumber >= b.head && lineNumber <= b.end);
}
