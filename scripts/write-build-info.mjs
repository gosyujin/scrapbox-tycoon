// Writes build-info.json (git sha + build time) so the running app can show
// which build is actually live, and so the deploy workflow can cache-bust
// asset URLs per build (see .github/workflows/deploy-pages.yml).
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function git(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const sha = git('git rev-parse HEAD');
const shortSha = git('git rev-parse --short HEAD');
const builtAt = new Date().toISOString();

writeFileSync('build-info.json', JSON.stringify({ sha, shortSha, builtAt }, null, 2) + '\n');
console.log(`build-info.json written: ${shortSha} @ ${builtAt}`);
