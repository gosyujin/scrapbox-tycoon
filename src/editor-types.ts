// Public shape of the page editor, shared by src/editor.ts (the thin loader
// app.ts talks to) and cm-editor/ (the CodeMirror implementation, bundled
// separately -- see scripts/build-cm-editor.mjs).
export interface EditorOptions {
  container: HTMLElement;
  lines: string[];
  // Fires once when the editor loses focus (blur/commit) -- NOT per
  // keystroke. See docs/decisions/04-empty-page-title-desync.md.
  onChange: (lines: string[]) => void | Promise<void>;
  // Lower-cased titles of pages that currently exist, for the link
  // exists/missing color-coding (see parser.ts's RenderOpts). A snapshot
  // taken once when the page is opened.
  knownTitles: Set<string>;
  // A link not found in knownTitles falls through to this before being
  // treated as missing -- see parser.ts's RenderOpts.fallback.
  fallback?: { linkBase: string; knownTitles: Set<string> };
  // Called when the user uses the selection popup's "ページ切り出し" button.
  // `lines` is the new page's content (lines[0] is its title). The caller
  // creates the page; the editor only replaces the selection with a link.
  onExtractPage?: (title: string, lines: string[]) => void | Promise<void>;
}
