// Appends ?v=<git short sha> to every relative import/export specifier in
// the compiled js/ output. Busting only the entry script's URL (index.html)
// is not enough: browsers/CDNs cache each ES module file by its own exact
// URL, so a stale editor.js or parser.js can keep running silently across
// deploys unless its import specifier also changes.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function git(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const shortSha = git('git rev-parse --short HEAD');

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.js')) rewrite(full);
  }
}

function rewrite(file) {
  const src = readFileSync(file, 'utf8');
  const out = src.replace(/from '(\.[^']+\.js)'/g, (_, spec) => `from '${spec}?v=${shortSha}'`);
  if (out !== src) writeFileSync(file, out);
}

walk('js');
console.log(`cache-bust-imports: rewrote relative imports with v=${shortSha}`);
