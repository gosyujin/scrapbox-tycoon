// The page editor app.ts talks to. The real implementation is a CodeMirror 6
// editor (cm-editor/), bundled by esbuild into js/cm-editor.js and loaded
// here on demand: tsc emits un-bundled modules, which cannot resolve CodeMirror's
// bare package imports, and the read-only reference view never needs it.
//
// Until the bundle arrives the page is shown rendered and read-only (same
// look as the reference view), so opening a page never flashes empty.
//
// `onChange` fires when the editor loses focus (blur/commit), not per
// keystroke -- see docs/decisions/04-empty-page-title-desync.md.
import { renderLinesInto } from './parser.js';
import type { EditorOptions } from './editor-types.js';

export type { EditorOptions };

export class Editor {
  constructor(opts: EditorOptions) {
    const { container, lines, knownTitles, fallback } = opts;
    renderLinesInto(container, lines, { linkBase: '#/page/', knownTitles, fallback });
    // import.meta.url carries the deploy's ?v=<sha> (see cache-bust-imports.mjs),
    // forwarded so the bundle is cache-busted per deploy like every other module.
    import(`./cm-editor.js${new URL(import.meta.url).search}`)
      .then((mod: { createEditor: (o: EditorOptions) => void }) => {
        // The page may have been re-rendered while the bundle loaded.
        if (container.isConnected) mod.createEditor(opts);
      })
      .catch((e: unknown) => {
        if (!container.isConnected) return;
        const note = document.createElement('p');
        note.className = 'muted';
        note.textContent = `エディタを読み込めませんでした (表示のみ): ${String(e)}`;
        container.prepend(note);
      });
  }
}
