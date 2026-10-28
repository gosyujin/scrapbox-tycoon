// Standalone Scrapbox-style editor experiment, mounted at #/editor/.
// Shares nothing with the rest of the app (no store, no parser, no sync, no
// stylesheet): app.ts only dynamic-imports this bundle for that one route.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewlineKeepIndent } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { liveRender } from './decorations';
import { backspaceOneIndent, indentLess, indentMore } from './commands';
import { SAMPLE } from './sample';
import { LAB_CSS } from './style';

export function mount(root: HTMLElement): void {
  const style = document.createElement('style');
  style.id = 'lab-editor-style';
  style.textContent = LAB_CSS;
  document.head.appendChild(style);

  root.innerHTML = `
    <div class="lab-editor-page">
      <div class="lab-editor-bar">
        <a href="#/">← scrapbox-tycoon</a>
        <span class="lab-note">editor lab (検証用: 保存・同期なし。リロードで消えます)</span>
        <button type="button" id="lab-reset">サンプルに戻す</button>
      </div>
      <div class="lab-editor" id="lab-editor-host"></div>
      <details class="lab-raw"><summary>raw text</summary><pre id="lab-raw"></pre></details>
    </div>`;
  const host = root.querySelector<HTMLElement>('#lab-editor-host')!;
  const rawEl = root.querySelector<HTMLElement>('#lab-raw')!;

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: SAMPLE,
      extensions: [
        history(),
        closeBrackets(),
        keymap.of([
          { key: 'Enter', run: insertNewlineKeepIndent },
          { key: 'Tab', run: indentMore, shift: indentLess },
          { key: 'Backspace', run: backspaceOneIndent },
          ...closeBracketsKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        liveRender,
        // Plain click expands the line (default caret placement); Ctrl/Cmd+click
        // on an external link opens it instead.
        EditorView.domEventHandlers({
          mousedown(e) {
            if (!(e.metaKey || e.ctrlKey)) return false;
            const a = (e.target as HTMLElement).closest<HTMLElement>('[data-href]');
            if (!a) return false;
            window.open(a.dataset.href!, '_blank', 'noopener,noreferrer');
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) rawEl.textContent = u.state.doc.toString();
        }),
      ],
    }),
  });
  rawEl.textContent = view.state.doc.toString();
  (window as unknown as { labEditor?: EditorView }).labEditor = view; // for debugging from the console

  root.querySelector('#lab-reset')!.addEventListener('click', () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: SAMPLE } });
  });

  // app.ts replaces #app's contents when another route renders; clean up our
  // view and stylesheet once we've been navigated away from.
  const onHashChange = (): void => {
    if (location.hash === '#/editor' || location.hash === '#/editor/') return;
    window.removeEventListener('hashchange', onHashChange);
    delete (window as unknown as { labEditor?: EditorView }).labEditor;
    view.destroy();
    style.remove();
  };
  window.addEventListener('hashchange', onHashChange);
}
