// Regression test for a real "edit rolls back after a successful sync" bug
// reported against the live GitHub repo, reproduced across PC and phone,
// both self-healing only after enough real time (or app restarts) passed.
//
// Root cause, confirmed against the live API: GET git/ref/heads/<branch>
// responds with `Cache-Control: public, max-age=60, s-maxage=60`. The
// fetch() calls in github-store.ts's api() helper did not opt out of the
// browser's HTTP cache, so within 60s of a previous read of that exact URL,
// a device could get back a branch tip from *before* its own just-completed
// commit (the write goes to git/refs/heads/<branch>, plural -- a different
// URL than this GET -- so the browser has no way to invalidate the cached
// read when the write lands). GitHubSyncStore.pull() then sees what looks
// like a remote change relative to what it just synced, and overwrites the
// freshly-written local copy with the stale one.
//
// The in-memory mock here has no real HTTP cache to reproduce that against
// directly, so this instead pins down the actual fix: every request must
// opt out of the cache explicitly, so nothing upstream of the mock (a real
// browser) can hand back a stale response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { installMockGitHubApi } from './helpers/mock-github-api.mjs';

test('every GitHub API request opts out of the HTTP cache', async () => {
  installMockGitHubApi({ delayMs: 5 });
  const seenInits = [];
  const inner = global.fetch;
  global.fetch = (url, init) => {
    seenInits.push(init);
    return inner(url, init);
  };

  const store = new GitHubSyncStore({ owner: 'o', repo: 'r', branch: 'main', token: 't' });
  await store.syncNow();
  await store.savePage({ title: 'A', lines: ['A', 'body'] });
  await store.syncNow();

  assert.ok(seenInits.length > 0, 'expected at least one request to have been made');
  for (const init of seenInits) {
    assert.equal(init?.cache, 'no-store', 'every request must set cache: "no-store"');
  }
});
