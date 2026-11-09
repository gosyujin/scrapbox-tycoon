// The editor side of the keyboard shortcuts (src/shortcuts.ts): what each
// named handler actually does to the CodeMirror view and to the selection
// popup. Written against the view's own state rather than faking key events
// the way the UserScript has to on scrapbox.io.
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { insertNewlineKeepIndent } from '@codemirror/commands';
import type { EditorApi, PopupApi } from '../src/shortcuts';
import { blockAt, findBlocks } from './blocks';

// Types text as if the user had: goes through the view's input handlers, so
// closeBrackets still auto-closes '[' (and wraps a selection in it).
export function typeText(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: 'input.type' });
  for (const handler of view.state.facet(EditorView.inputHandler)) {
    if (handler(view, from, to, text, insert)) return;
  }
  view.dispatch(insert());
}

// Popup keys that press a button directly: key -> a piece of the button's label.
// Scrapbox's popup has quote / bullet / numbering buttons for these; this
// app's does not (yet), so nothing is bound and those keys type normally.
export const POPUP_SYMBOL_LABELS: Record<string, string> = {};

const ACTIVE = 'sbe-popup-active';

function popupApi(view: EditorView): PopupApi {
  const dom = (): HTMLElement | null => view.dom.querySelector<HTMLElement>('.sbe-popup');
  const buttons = (): HTMLButtonElement[] => Array.from(dom()?.querySelectorAll<HTMLButtonElement>('.selection-toolbar-btn') ?? []);
  const current = (): number => buttons().findIndex((b) => b.classList.contains(ACTIVE));
  const reset = (): void => {
    for (const b of buttons()) b.classList.remove(ACTIVE);
  };
  // The highlight belongs to one selection: a different selection starts over
  // (the popup element is reused while only the selection's end moves).
  const selKey = (): string => {
    const { from, to } = view.state.selection.main;
    return `${from}-${to}`;
  };
  const shift = (forward: boolean): void => {
    const d = dom();
    const btns = buttons();
    if (!d || !btns.length) return;
    if (d.dataset.selKey !== selKey()) {
      reset();
      d.dataset.selKey = selKey();
    }
    const cur = current();
    const next = forward ? (cur + 1) % btns.length : cur <= 0 ? btns.length - 1 : cur - 1;
    reset();
    btns[next]!.classList.add(ACTIVE);
  };
  const press = (b: HTMLButtonElement | undefined): boolean => {
    if (!b) return false;
    reset();
    b.click();
    return true;
  };
  return {
    isActive: () => buttons().length > 0,
    shift,
    reset,
    byNumber: (n) => {
      for (let i = 0; i < (n === 0 ? 10 : n); i++) shift(true);
    },
    bySymbol: (symbol) => {
      const label = POPUP_SYMBOL_LABELS[symbol];
      return !!label && press(buttons().find((b) => (b.textContent ?? '').includes(label)));
    },
    enter: () => {
      const cur = current();
      if (cur !== -1) return press(buttons()[cur]);
      // Nothing highlighted: Enter on a multi-line selection extracts it into a
      // new page (Scrapbox's "New page" is the first button there).
      const { from, to } = view.state.selection.main;
      if (view.state.doc.lineAt(from).number !== view.state.doc.lineAt(to).number) {
        return press(buttons().find((b) => b.dataset.action === 'extract'));
      }
      return false;
    },
  };
}

export function editorApi(view: EditorView, leave: (go: () => void) => void): EditorApi {
  return {
    insertText: (text) => typeText(view, text),
    tab: () => {
      const { state } = view;
      const line = state.doc.lineAt(state.selection.main.head);
      const block = blockAt(findBlocks(state.doc), line.number);
      // A table row's cells are separated by tab characters.
      typeText(view, block?.kind === 'table' && line.number !== block.head ? '\t' : ' ');
    },
    focus: () => {
      view.focus();
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) });
    },
    focusBelow: () => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      view.dispatch({ selection: EditorSelection.cursor(line.to) });
      view.focus();
      insertNewlineKeepIndent(view);
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) });
    },
    lineBracketing: () => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const indent = line.text.length - line.text.replace(/^[ \t　]+/, '').length;
      const from = line.from + indent;
      const to = line.to - (line.text.length - line.text.trimEnd().length);
      if (to <= from) return;
      view.dispatch({ selection: EditorSelection.range(from, to) });
      view.focus();
      typeText(view, '[');
    },
    popup: popupApi(view),
    leave,
    isConnected: () => view.dom.isConnected,
  };
}
