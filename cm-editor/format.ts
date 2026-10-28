// Wrapping the selection in Scrapbox notation: the actions behind the
// selection popup.
import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

// Wraps each line's part of the selection separately -- Scrapbox notation
// cannot span lines -- trimming surrounding spaces ("[ x]" is not a link).
// Afterwards the wrapped text itself stays selected, so wrappers can be
// stacked ([* [/ x]]) and the popup stays up.
export function wrapSelection(view: EditorView, open: string, close: string): void {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) return;
  const changes: ChangeSpec[] = [];
  let first = -1;
  let last = -1;
  for (let n = state.doc.lineAt(sel.from).number; n <= state.doc.lineAt(sel.to).number; n++) {
    const line = state.doc.line(n);
    let from = Math.max(sel.from, line.from);
    let to = Math.min(sel.to, line.to);
    const text = state.doc.sliceString(from, to);
    from += text.length - text.trimStart().length;
    to -= text.length - text.trimEnd().length;
    if (to <= from) continue;
    changes.push({ from, insert: open }, { from: to, insert: close });
    if (first < 0) first = from;
    last = to;
  }
  if (first < 0) return;
  const cs = state.changes(changes);
  view.dispatch({
    changes: cs,
    // assoc 1: past the opening insert at `first`; -1: before the closing one at `last`.
    selection: EditorSelection.range(cs.mapPos(first, 1), cs.mapPos(last, -1)),
    userEvent: 'input.format',
  });
  view.focus();
}

export interface FormatAction {
  label: string;
  title: string;
  open: string;
  close: string;
}

export const FORMAT_ACTIONS: FormatAction[] = [
  { label: '[ ]', title: '選択範囲を [ ] で囲んでリンクにする', open: '[', close: ']' },
  { label: '太字', title: '太字 [* ]', open: '[* ', close: ']' },
  { label: '見出し', title: '大きい太字 [** ]', open: '[** ', close: ']' },
  { label: '斜体', title: '斜体 [/ ]', open: '[/ ', close: ']' },
  { label: '取消', title: '取り消し線 [- ]', open: '[- ', close: ']' },
  { label: '下線', title: '下線 [_ ]', open: '[_ ', close: ']' },
  { label: '`コード`', title: 'インラインコード', open: '`', close: '`' },
];
