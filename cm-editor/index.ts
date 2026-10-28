// CodeMirror 6 implementation of the page editor (loaded on demand by
// src/editor.ts). One always-editable document: lines other than the ones the
// selection touches are shown rendered (see decorations.ts).
//
// `onChange` keeps its long-standing contract: it fires when the editor loses
// focus (blur/commit), never per keystroke -- see CLAUDE.md and
// docs/decisions/04-empty-page-title-desync.md.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewlineKeepIndent } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import type { EditorOptions } from '../src/editor-types';
import { Prec } from '@codemirror/state';
import { linkConfig } from './config';
import { liveRender, refreshDecorations } from './decorations';
import {
  backspaceOneIndent,
  indentLinesLess,
  indentLinesMore,
  indentSubtreeLess,
  indentSubtreeMore,
  moveLinesDown,
  moveLinesUp,
  moveSubtreeDown,
  moveSubtreeUp,
  tabIndent,
} from './commands';
import { keyboardAware } from './mobile';
import { selectionPopup } from './popup';
import { EDITOR_CSS } from './style';
import { wrapSelection } from './format';

const STYLE_ID = 'sbe-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = EDITOR_CSS;
  document.head.appendChild(style);
}

const isEditable = (el: Element | null): boolean =>
  !!el && ((el as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function createEditor(opts: EditorOptions): void {
  const { container, onChange, onExtractPage, knownTitles, fallback } = opts;
  ensureStyle();

  container.textContent = '';
  const host = document.createElement('div');
  host.className = 'sbe';
  container.appendChild(host);

  let dirty = false; // edited since the last onChange

  const commit = (): void | Promise<void> => {
    dirty = false;
    return onChange(view.state.doc.toString().split('\n'));
  };

  // Navigating away must not lose edits: the page DOM (and this editor with
  // it) is thrown away by the route change without a blur.
  const commitThen = (go: () => void): void => {
    if (!dirty) return go();
    void Promise.resolve(commit()).then(go, go);
  };

  const extract = async (v: EditorView): Promise<void> => {
    const { state } = v;
    const sel = state.selection.main;
    const selectedLines = state.sliceDoc(sel.from, sel.to).split('\n');
    const title = (selectedLines[0] ?? '').trim();
    if (!title) return;
    // Everything after the selection's own first line -- selecting a whole
    // paragraph carries its later lines into the new page's body. A single
    // term leaves this empty: the new page is just a title + backlink stub.
    const body = selectedLines.slice(1);
    const sourceTitle = state.doc.line(1).text;
    wrapSelection(v, '[', ']'); // the selection becomes a link to the new page
    // Matches Scrapbox's "split into a new page": title, backlink, cut text.
    const newPageLines = [title, '', `from [${sourceTitle}]`, ...(body.length ? ['', ...body] : [])];
    try {
      await onExtractPage?.(title, newPageLines);
      // So the new link renders as "exists" right away.
      knownTitles.add(title.toLowerCase());
      v.dispatch({ effects: refreshDecorations.of(null) });
    } catch {
      // The link is in the text either way; only the page creation failed --
      // same recoverable state as any other failed save in this app.
    }
  };

  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: opts.lines.join('\n'),
      extensions: [
        linkConfig.of({ linkBase: '#/page/', knownTitles, fallback }),
        history(),
        closeBrackets(),
        // Before defaultKeymap, which binds Alt-Arrow to its own line
        // move/copy and would otherwise win for the same keys.
        Prec.high(
          keymap.of([
            { key: 'Ctrl-ArrowUp', run: moveLinesUp },
            { key: 'Ctrl-ArrowDown', run: moveLinesDown },
            { key: 'Ctrl-ArrowLeft', run: indentLinesLess },
            { key: 'Ctrl-ArrowRight', run: indentLinesMore },
            { key: 'Alt-ArrowUp', run: moveSubtreeUp },
            { key: 'Alt-ArrowDown', run: moveSubtreeDown },
            { key: 'Alt-ArrowLeft', run: indentSubtreeLess },
            { key: 'Alt-ArrowRight', run: indentSubtreeMore },
            { key: 'Tab', run: tabIndent, shift: indentLinesLess },
            { key: 'Backspace', run: backspaceOneIndent },
            { key: 'Enter', run: insertNewlineKeepIndent },
            {
              key: 'Escape',
              run: (v) => {
                v.contentDOM.blur();
                return true;
              },
            },
          ])
        ),
        keymap.of([...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        liveRender,
        selectionPopup((v) => void extract(v)),
        keyboardAware,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) dirty = true;
        }),
        EditorView.domEventHandlers({
          // Following a link: a plain click on a rendered (inactive) line, or
          // ctrl/cmd+click anywhere. On the active line a plain click edits
          // the text instead. Handled on mousedown, not click: that mousedown
          // would otherwise move the caret, re-render the line, and the click
          // would then land on a replaced element.
          mousedown(e) {
            if (e.button !== 0) return false;
            const a = (e.target as HTMLElement).closest<HTMLElement>('[data-href]');
            if (!a) return false;
            const modifier = e.metaKey || e.ctrlKey;
            if (!modifier && !a.classList.contains('sbe-nav')) return false;
            const href = a.dataset.href!;
            e.preventDefault();
            if (a.dataset.ext) window.open(href, '_blank', 'noopener,noreferrer');
            else commitThen(() => (location.hash = href));
            return true;
          },
          blur() {
            // Same as the old textarea: every blur is a commit; the app
            // treats an unchanged page as a no-op save.
            void commit();
            return false;
          },
        }),
      ],
    }),
  });

  // The card's own padding and anything else outside the text area: a click
  // there still starts editing, caret at the end (as the old editor did).
  container.addEventListener('mousedown', (e) => {
    const t = e.target as Element;
    if (e.button !== 0 || t.closest('.cm-content') || t.closest('.cm-tooltip')) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
  });

  // Backgrounding a tab/PWA with unsaved edits (the phone's keyboard still up)
  // is not guaranteed to blur first.
  const onHidden = (): void => {
    if (!view.dom.isConnected) {
      document.removeEventListener('visibilitychange', onHidden);
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (document.visibilityState === 'hidden' && dirty) void commit();
  };
  // vim-flavored "press i / o to start editing" when nothing else has focus.
  const onKey = (e: KeyboardEvent): void => {
    if (!view.dom.isConnected) {
      document.removeEventListener('visibilitychange', onHidden);
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (view.hasFocus || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'i' && e.key !== 'o') return;
    if (isEditable(e.target as Element | null)) return;
    e.preventDefault();
    if (e.key === 'i') {
      view.dispatch({ selection: { anchor: 0 } });
    } else {
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 } });
    }
    view.focus();
  };
  document.addEventListener('visibilitychange', onHidden);
  document.addEventListener('keydown', onKey);
}
