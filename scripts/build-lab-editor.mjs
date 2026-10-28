// Bundles the standalone editor experiment (lab/editor, route #/editor/) into
// js/lab/editor.js. Kept out of tsc's src/ tree and out of app.ts's static
// imports on purpose: it pulls in CodeMirror, which the rest of the app must
// not depend on, and it is loaded on demand only for that route.
import { build } from 'esbuild';

await build({
  entryPoints: ['lab/editor/main.ts'],
  outfile: 'js/lab/editor.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
