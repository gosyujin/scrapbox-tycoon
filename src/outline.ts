// Outline (indent-based list) editing on a plain `string[]` of lines, with no
// DOM / editor dependency so it can be unit-tested in node. The editor
// (cm-editor/) feeds it the caret's line range and turns the result back
// into a text change + caret position.
//
//   ctrl+up/down      moveLines      the selected line(s) swap with the one
//                                    line next to them
//   ctrl+left/right   indentLines    one leading space added / removed per
//                                    selected line
//   alt+up/down       moveSubtree    the selected line(s) *with their nested
//                                    children* swap with the neighbouring
//                                    sibling and its children
//   alt+left/right    indentSubtree  indent / outdent the line(s) and all
//                                    their nested children together
//
// Line 0 is the page title: it never moves, never gets indented, and nothing
// can be moved above it (that would silently rename the page).
import { splitIndent } from './parser.js';

export interface LineRange {
  from: number; // 0-based, inclusive
  to: number; // 0-based, inclusive
}

export interface LineCol {
  line: number;
  col: number;
}

export interface OutlineEdit {
  lines: string[];
  // How a position inside the edited block moves: moved lines shift by
  // `lineShift`; indented lines shift their column by `colDelta.get(oldLine)`.
  lineShift: number;
  colDelta: Map<number, number>;
}

// Where a caret/selection end lands after the edit.
export function mapPosition(edit: OutlineEdit, pos: LineCol): LineCol {
  const col = Math.max(0, pos.col + (edit.colDelta.get(pos.line) ?? 0));
  return { line: pos.line + edit.lineShift, col };
}

// The lines a selection covers. A selection ending exactly at column 0 of a
// later line has nothing highlighted on that line (e.g. two full lines picked
// with shift+Down twice), so that line is excluded.
export function selectedLineRange(start: LineCol, end: LineCol): LineRange {
  let to = end.line;
  if (to > start.line && end.col === 0) to -= 1;
  return { from: start.line, to };
}

const isIndentChar = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '　';

export function moveLines(lines: string[], { from, to }: LineRange, direction: -1 | 1): OutlineEdit | null {
  if (from < 1) return null; // title is fixed
  if (direction === -1 && from < 2) return null; // nothing may go above the title
  if (direction === 1 && to >= lines.length - 1) return null;
  const out = [...lines];
  if (direction === -1) {
    const [above] = out.splice(from - 1, 1);
    out.splice(to, 0, above ?? '');
  } else {
    const [below] = out.splice(to + 1, 1);
    out.splice(from, 0, below ?? '');
  }
  return { lines: out, lineShift: direction, colDelta: new Map() };
}

function indentRange(lines: string[], { from, to }: LineRange, direction: 1 | -1): OutlineEdit | null {
  const out = [...lines];
  const colDelta = new Map<number, number>();
  for (let i = Math.max(1, from); i <= to; i++) {
    const line = out[i] ?? '';
    if (direction === 1) {
      out[i] = ' ' + line;
      colDelta.set(i, 1);
    } else if (isIndentChar(line[0])) {
      out[i] = line.slice(1);
      colDelta.set(i, -1);
    }
  }
  return colDelta.size === 0 ? null : { lines: out, lineShift: 0, colDelta };
}

export function indentLines(lines: string[], range: LineRange, direction: 1 | -1): OutlineEdit | null {
  return indentRange(lines, range, direction);
}

// Index of the last line of the subtree rooted at `start`: every line right
// after it that is indented deeper than `rootDepth`.
function subtreeEnd(lines: string[], start: number, rootDepth: number): number {
  let end = start;
  while (end + 1 < lines.length && splitIndent(lines[end + 1] ?? '').depth > rootDepth) end++;
  return end;
}

// Start of the sibling subtree just above `from` at `rootDepth`, skipping
// back over that sibling's own children. null when the line above is
// shallower (the parent, not a sibling), when there is none, or when it
// would be the title.
function prevSiblingStart(lines: string[], from: number, rootDepth: number): number | null {
  let i = from - 1;
  while (i >= 1 && splitIndent(lines[i] ?? '').depth > rootDepth) i--;
  return i >= 1 && splitIndent(lines[i] ?? '').depth === rootDepth ? i : null;
}

function nextSiblingRange(lines: string[], to: number, rootDepth: number): [number, number] | null {
  const start = to + 1;
  if (start >= lines.length || splitIndent(lines[start] ?? '').depth !== rootDepth) return null;
  return [start, subtreeEnd(lines, start, rootDepth)];
}

// The subtree being operated on is rooted at `from`'s own depth: every
// selected line, each dragged along with its own children, so a subtree is
// never orphaned or split.
function subtreeRange(lines: string[], { from, to }: LineRange): LineRange | null {
  if (from < 1) return null;
  const rootDepth = splitIndent(lines[from] ?? '').depth;
  return { from, to: subtreeEnd(lines, to, rootDepth) };
}

export function moveSubtree(lines: string[], range: LineRange, direction: -1 | 1): OutlineEdit | null {
  const sub = subtreeRange(lines, range);
  if (!sub) return null;
  const { from, to } = sub;
  const rootDepth = splitIndent(lines[from] ?? '').depth;
  if (direction === -1) {
    const prevStart = prevSiblingStart(lines, from, rootDepth);
    if (prevStart === null) return null;
    const prevBlock = lines.slice(prevStart, from);
    const block = lines.slice(from, to + 1);
    return {
      lines: [...lines.slice(0, prevStart), ...block, ...prevBlock, ...lines.slice(to + 1)],
      lineShift: -prevBlock.length,
      colDelta: new Map(),
    };
  }
  const next = nextSiblingRange(lines, to, rootDepth);
  if (!next) return null;
  const [nextStart, nextEnd] = next;
  const block = lines.slice(from, to + 1);
  const nextBlock = lines.slice(nextStart, nextEnd + 1);
  return {
    lines: [...lines.slice(0, from), ...nextBlock, ...block, ...lines.slice(nextEnd + 1)],
    lineShift: nextBlock.length,
    colDelta: new Map(),
  };
}

export function indentSubtree(lines: string[], range: LineRange, direction: 1 | -1): OutlineEdit | null {
  const sub = subtreeRange(lines, range);
  if (!sub) return null;
  // Outdenting a root that is already at depth 0 would pull its children
  // out of line with it only partly -- nothing to do instead.
  if (direction === -1 && splitIndent(lines[sub.from] ?? '').depth === 0) return null;
  return indentRange(lines, sub, direction);
}
