// Regression test: a sync triggered by GitHubSyncStore's own internal
// timers (the debounce in scheduleSync(), and the retry-after-failure
// timer in runSync()'s catch block) used to call `void this.syncNow()`
// with nothing awaiting or catching the result. runSync() already records
// a failure (sync status + scheduling the next retry) before re-throwing
// -- that re-throw exists for a direct awaiter like syncNow() or
// listOrphanedRemotePages() to react to, but nothing awaits these two
// internally-triggered calls, so a real failure (e.g. a sustained "branch
// moved during save" after GitHubStore.commit()'s 8 retries) surfaced as
// a raw, alarming "Uncaught (in promise)" error even though it was
// already fully handled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { installMockGitHubApi } from './helpers/mock-github-api.mjs';

test('a sync failure triggered by the internal debounce timer does not become an unhandled rejection', async () => {
  installMockGitHubApi({ delayMs: 5 });
  // Force every ref update to look like the branch moved underneath us --
  // the exact failure mode GitHubStore.commit() retries 8 times before
  // giving up on, which is what the user hit while editing.
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if ((init?.method || 'GET') === 'PATCH' && String(url).includes('git/refs/heads/')) {
      return new Response(JSON.stringify({ message: 'not a fast forward' }), { status: 422 });
    }
    return realFetch(url, init);
  };

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);

  try {
    const store = new GitHubSyncStore({ owner: 'o', repo: 'r', branch: 'main', token: 't' });
    await store.savePage({ title: 'Existing Page', lines: [''] });
    // Exercise the same internal, un-awaited call path scheduleSync() uses,
    // with a short delay instead of the real 4s debounce.
    store.scheduleSync(10);

    // Long enough for GitHubStore.commit()'s 8 attempts (200ms*1..7 backoff
    // between them, ~5.6s worst case) to fully exhaust and reject.
    await new Promise((r) => setTimeout(r, 6500));

    assert.equal(store.getSyncStatus().state, 'error');
    assert.match(store.getSyncStatus().lastError, /branch moved during save/);
    assert.deepEqual(rejections, [], 'the failed sync should not have surfaced as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onRejection);
    global.fetch = realFetch;
  }
});
