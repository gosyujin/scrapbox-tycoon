// All selectors are scoped under .lab-editor so nothing here can leak into
// (or be overridden by) the rest of the app's stylesheet. The colors fall
// back to literal values and only *read* the app's CSS variables.
export const LAB_CSS = `
.lab-editor-page { max-width: 760px; margin: 0 auto; padding: 0.6rem 0.8rem 5rem; }
.lab-editor-bar { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; margin-bottom: 0.6rem; font-size: 0.85rem; }
.lab-editor-bar .lab-note { opacity: 0.65; flex: 1; }
.lab-editor-bar button { font: inherit; padding: 0.2rem 0.6rem; border: 1px solid var(--border, #e3e3e3); background: var(--bg, #fff); color: inherit; border-radius: 4px; cursor: pointer; }
.lab-raw summary { cursor: pointer; font-size: 0.85rem; opacity: 0.7; margin-top: 1rem; }
.lab-raw pre { font-size: 0.8rem; white-space: pre-wrap; border: 1px solid var(--border, #e3e3e3); padding: 0.5rem; border-radius: 4px; tab-size: 4; }

.lab-editor {
  --lab-fg: var(--text, #222);
  --lab-border: var(--border, #e3e3e3);
  --lab-link: var(--link, #0b6fbf);
  --lab-ext: var(--link-external, #1a7f37);
  --lab-dim: #aaa;
  --lab-code-bg: rgba(128, 128, 128, 0.12);
  --pad: 0.4em;
  --cell: 1.2em;
  border: 1px solid var(--lab-border);
  border-radius: 6px;
  min-height: 60vh;
  color: var(--lab-fg);
}
@media (prefers-color-scheme: dark) {
  .lab-editor { --lab-fg: var(--text, #e6e6e6); --lab-dim: #666; }
}
.lab-editor .cm-editor { min-height: 60vh; background: transparent; color: inherit; }
.lab-editor .cm-editor.cm-focused { outline: none; }
.lab-editor .cm-scroller { font-family: inherit; line-height: 1.7; }
.lab-editor .cm-content { padding: 0.6rem 0; caret-color: currentColor; }

.lab-editor .cm-line.sb-line { position: relative; padding: 0 0.6em 0 var(--pad); }
.lab-editor .cm-line.sb-title { font-size: 1.5em; font-weight: bold; line-height: 1.4; padding-bottom: 0.3em; }
.lab-editor .sb-syntax { color: var(--lab-dim); font-weight: normal; }

/* outline indent: one cell per leading whitespace char, bullet in the last
   cell, wrapped lines hang under the text */
.lab-editor .sb-ws { display: inline-block; width: var(--cell); overflow: hidden; white-space: pre; text-indent: 0; vertical-align: bottom; }
.lab-editor .cm-line.sb-indented,
.lab-editor .cm-line.sb-code-line {
  padding-left: calc(var(--pad) + var(--depth) * var(--cell));
  text-indent: calc(var(--depth) * var(--cell) * -1);
}
.lab-editor .cm-line > * { text-indent: 0; } /* inline-block widgets must not inherit the hanging indent */
.lab-editor .cm-line.sb-indented::before {
  content: '•';
  position: absolute;
  left: calc(var(--pad) + (var(--depth) - 1) * var(--cell) + 0.3em);
  text-indent: 0;
  opacity: 0.55;
}
.lab-editor .cm-line.sb-indented.sb-quote::before { content: none; }

/* inline notation */
.lab-editor .sb-link { color: var(--lab-link); cursor: pointer; }
.lab-editor .sb-link.sb-external { color: var(--lab-ext); }
.lab-editor .sb-strong-link { font-weight: bold; }
.lab-editor .sb-tag { opacity: 0.9; }
.lab-editor .sb-icon::after { content: ' ◔'; font-size: 0.8em; }
.lab-editor .sb-strong, .lab-editor .sb-h1, .lab-editor .sb-h2, .lab-editor .sb-h3 { font-weight: bold; }
.lab-editor .sb-h1 { font-size: 1.6em; line-height: 1.3; }
.lab-editor .sb-h2 { font-size: 1.3em; }
.lab-editor .sb-h3 { font-size: 1.1em; }
.lab-editor .sb-strike { text-decoration: line-through; }
.lab-editor .sb-em { font-style: italic; }
.lab-editor .sb-underline { text-decoration: underline; }
.lab-editor .sb-inline-code { font-family: ui-monospace, Menlo, Consolas, monospace; background: var(--lab-code-bg); border-radius: 3px; padding: 0 0.25em; font-size: 0.92em; }
.lab-editor .cm-line.sb-quote { border-left: 3px solid var(--lab-border); margin-left: 0.4em; opacity: 0.9; }

/* code: / table: blocks */
.lab-editor .cm-line.sb-code-line { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; background: var(--lab-code-bg); }
.lab-editor .cm-line.sb-code-head { font-weight: bold; font-size: 0.85em; }
.lab-editor .sb-code-name { color: var(--lab-ext); }
.lab-editor .cm-line.sb-table-raw { tab-size: 4; }
.lab-editor .sb-img { display: inline-block; text-indent: 0; vertical-align: bottom; }
.lab-editor .sb-img img { max-width: 100%; max-height: 18em; display: block; border-radius: 3px; }
.lab-editor .sb-img-error { color: var(--link-missing, #b23b3b); font-size: 0.85em; }
.lab-editor .sb-table-wrap { padding: 0.3em 0.6em; overflow-x: auto; cursor: text; }
.lab-editor .sb-table { border-collapse: collapse; font-size: 0.92em; }
.lab-editor .sb-table caption { text-align: left; font-weight: bold; font-size: 0.85em; padding-bottom: 0.2em; }
.lab-editor .sb-table td { border: 1px solid var(--lab-border); padding: 0.15em 0.6em; }
`;
