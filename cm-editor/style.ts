// Editor-specific styles, injected once as a <style> (index.ts) so the editor
// bundle is self-contained. Every selector is under .sbe and every class has
// an sbe- prefix, so nothing collides with css/style.css. Colors come from the
// app's CSS variables (light/dark handled there); inline decoration classes
// that parser.ts also emits (.sb-h1, .sb-strike, .deco-\<, table.sb-table ...)
// are deliberately NOT redefined here -- style.css already styles them, which
// keeps the editor looking like a rendered page.
export const EDITOR_CSS = `
.sbe { --cell: 1.2em; --pad: 0.3em; }
.sbe .cm-editor { background: transparent; color: var(--fg); }
.sbe .cm-editor.cm-focused { outline: none; }
.sbe .cm-scroller { font-family: inherit; line-height: 1.6; }
/* >= 16px: iOS Safari zooms the page when focusing a smaller editable (see
   .edit-layer history in docs/technical-notes.md). min-height gives the empty
   area under a short page something to click/tap. */
.sbe .cm-content { font-size: 16px; padding: 0; min-height: 6em; caret-color: var(--fg); }
.sbe .cm-line.sbe-line { position: relative; padding: 0 6px 0 var(--pad); word-break: break-word; }
.sbe .cm-line.sbe-title { font-size: 1.35em; font-weight: 700; line-height: 1.4; padding-bottom: 0.35em; }
.sbe .sbe-syntax { color: var(--muted); font-weight: normal; }

/* Outline indent: one cell per leading whitespace character (on the active
   line too, so expanding a line never shifts its text), a bullet in the last
   cell, and wrapped lines hang under the text. */
.sbe .sbe-ws { display: inline-block; width: var(--cell); overflow: hidden; white-space: pre; vertical-align: bottom; }
.sbe .cm-line > * { text-indent: 0; } /* inline-block widgets must not inherit the hanging indent */
.sbe .cm-line.sbe-indented,
.sbe .cm-line.sbe-code-line {
  padding-left: calc(var(--pad) + var(--depth) * var(--cell));
  text-indent: calc(var(--depth) * var(--cell) * -1);
}
.sbe .cm-line.sbe-indented::before {
  content: '•';
  position: absolute;
  left: calc(var(--pad) + (var(--depth) - 1) * var(--cell) + 0.3em);
  text-indent: 0;
  color: var(--muted);
}
.sbe .cm-line.sbe-indented.sbe-quote::before { content: none; }

/* Inline notation. .sb-h1/2/3 are inline-block in style.css (fine in a
   rendered page); here they must stay inline so a long heading can wrap and
   the caret can move through it. */
.sbe .sb-h1, .sbe .sb-h2, .sbe .sb-h3 { display: inline; }
.sbe .sbe-link { color: var(--link); text-decoration: none; }
.sbe .sbe-link.strong { font-weight: 700; }
.sbe .sbe-link.missing { color: var(--link-missing); border-bottom: 1px dashed var(--link-missing); }
.sbe .sbe-link.external { color: var(--link-external); }
.sbe .sbe-link.external::after { content: " \\2197"; font-size: 0.75em; opacity: 0.6; }
.sbe .sbe-link.sbe-nav { cursor: pointer; }
.sbe .sbe-inline-code { background: var(--code-bg); border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.sbe .cm-line.sbe-quote { background: var(--quote-bg); border-left: 1px solid var(--quote-border); color: var(--muted); }

/* code: / table: blocks */
.sbe .cm-line.sbe-code-line { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; background: var(--code-bg); }
.sbe .cm-line.sbe-code-head { color: var(--muted); font-size: 12px; }
.sbe .sbe-code-name { color: var(--muted); }
.sbe .cm-line.sbe-table-raw { tab-size: 4; }
.sbe .sbe-table-wrap { padding: 0.2em 0.3em; overflow-x: auto; cursor: text; }
.sbe .sbe-img { display: inline-block; vertical-align: bottom; }
.sbe .sbe-img img { display: block; max-width: 100%; max-height: 18em; border-radius: 3px; }
.sbe .sbe-img-error { color: var(--link-missing); font-size: 0.85em; }

/* selection popup (tooltip); the pill look itself is .selection-toolbar in style.css */
/* The popup element is itself the .cm-tooltip, so it must restate the pill
   look to beat CodeMirror's default tooltip border/background. */
.sbe .cm-tooltip.sbe-popup { border: none; background: var(--fg); flex-wrap: wrap; max-width: calc(100vw - 16px); }
`;
