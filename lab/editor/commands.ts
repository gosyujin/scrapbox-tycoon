import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { Command } from '@codemirror/view';
import { blockAt, findBlocks } from './blocks';

// Tab / Shift-Tab: change the outline depth of every selected line (the page
// title, line 1, is never indented). Inside a table: block Tab inserts a
// literal tab instead, which is how cells are separated.
export const indentMore: Command = (view) => {
  const { state } = view;
  const blocks = findBlocks(state.doc);
  const main = state.doc.lineAt(state.selection.main.head);
  if (blockAt(blocks, main.number)?.kind === 'table' && main.number !== blockAt(blocks, main.number)!.head) {
    view.dispatch(state.replaceSelection('\t'), { userEvent: 'input' });
    return true;
  }
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = Math.max(2, a); n <= b; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      changes.push({ from: state.doc.line(n).from, insert: ' ' });
    }
  }
  if (changes.length === 0) return true;
  const cs = state.changes(changes);
  view.dispatch({ changes: cs, selection: state.selection.map(cs, 1), userEvent: 'input.indent' });
  return true;
};

export const indentLess: Command = (view) => {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = Math.max(2, a); n <= b; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (/^[ \t　]/.test(line.text)) changes.push({ from: line.from, to: line.from + 1 });
    }
  }
  if (changes.length === 0) return true;
  const cs = state.changes(changes);
  view.dispatch({ changes: cs, selection: state.selection.map(cs, -1), userEvent: 'delete.dedent' });
  return true;
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
