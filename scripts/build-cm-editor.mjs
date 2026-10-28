// Bundles the CodeMirror page editor (cm-editor/) into js/cm-editor.js.
// Kept out of tsc's src/ tree on purpose: tsc emits un-bundled modules, which
// cannot resolve the bare @codemirror/* imports in a browser. src/editor.ts
// loads this bundle on demand.
import { build } from 'esbuild';

await build({
  entryPoints: ['cm-editor/index.ts'],
  outfile: 'js/cm-editor.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
