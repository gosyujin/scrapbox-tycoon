import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import {
  indentLines,
  indentSubtree,
  mapPosition,
  moveLines,
  moveSubtree,
  selectedLineRange,
  type LineCol,
  type LineRange,
  type OutlineEdit,
} from '../src/outline';
import { blockAt, findBlocks } from './blocks';

function toLineCol(view: EditorView, pos: number): LineCol {
  const line = view.state.doc.lineAt(pos);
  return { line: line.number - 1, col: pos - line.from };
}

function toOffset(lines: string[], { line, col }: LineCol): number {
  let offset = 0;
  const target = Math.min(line, lines.length - 1);
  for (let i = 0; i < target; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset + Math.min(col, lines[target]?.length ?? 0);
}

// One minimal text change (common prefix/suffix trimmed) instead of replacing
// the whole document, so undo stays one step and untouched lines keep their DOM.
function minimalChange(oldText: string, newText: string): ChangeSpec {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}

// Runs an outline edit (src/outline.ts) against the selection and applies the
// result, keeping the caret/selection on the same text. `compute` gets the
// current lines and the selected line range.
function outlineCommand(compute: (lines: string[], range: LineRange) => OutlineEdit | null): Command {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    const text = state.doc.toString();
    const lines = text.split('\n');
    const start = toLineCol(view, sel.from);
    const end = toLineCol(view, sel.to);
    const edit = compute(lines, selectedLineRange(start, end));
    if (!edit) return true; // nothing to do, but the key is still ours (no word-jump etc.)
    const newText = edit.lines.join('\n');
    const anchor = toOffset(edit.lines, mapPosition(edit, toLineCol(view, sel.anchor)));
    const head = toOffset(edit.lines, mapPosition(edit, toLineCol(view, sel.head)));
    view.dispatch({
      changes: minimalChange(text, newText),
      selection: EditorSelection.range(anchor, head),
      scrollIntoView: true,
      userEvent: 'input.outline',
    });
    return true;
  };
}

// ctrl+arrow: the selected line(s)
export const moveLinesUp = outlineCommand((l, r) => moveLines(l, r, -1));
export const moveLinesDown = outlineCommand((l, r) => moveLines(l, r, 1));
export const indentLinesMore = outlineCommand((l, r) => indentLines(l, r, 1));
export const indentLinesLess = outlineCommand((l, r) => indentLines(l, r, -1));
// alt+arrow: the selected line(s) together with their nested children
export const moveSubtreeUp = outlineCommand((l, r) => moveSubtree(l, r, -1));
export const moveSubtreeDown = outlineCommand((l, r) => moveSubtree(l, r, 1));
export const indentSubtreeMore = outlineCommand((l, r) => indentSubtree(l, r, 1));
export const indentSubtreeLess = outlineCommand((l, r) => indentSubtree(l, r, -1));

// Tab / Shift-Tab: same as ctrl+left/right. Inside a table: block's rows Tab
// inserts a literal tab instead, which is how cells are separated.
export const tabIndent: Command = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const block = blockAt(findBlocks(state.doc), line.number);
  if (block?.kind === 'table' && line.number !== block.head) {
    view.dispatch(state.replaceSelection('\t'), { userEvent: 'input' });
    return true;
  }
  return indentLinesMore(view);
};

// Backspace with the caret inside a line's leading whitespace removes one
// level at a time (CodeMirror's default would jump by its indent unit).
export const backspaceOneIndent: Command = (view) => {
  const { state } = view;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (before === '' || !/^[ \t　]+$/.test(before)) return false;
  view.dispatch({
    changes: { from: pos - 1, to: pos },
    selection: EditorSelection.cursor(pos - 1),
    userEvent: 'delete.backward',
  });
  return true;
};
