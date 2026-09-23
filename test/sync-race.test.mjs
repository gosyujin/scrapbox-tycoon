// Regression test for a real data-loss bug (fixed in commit 92930cb):
// GitHubSyncStore.push() used to build its GitHub batch from
// this.meta.dirty/deleted, then unconditionally reset both to [] once the
// batch had gone out. pushBatch() makes several real GitHub API round
// trips, so if the user made *another* edit (e.g. merging a second page)
// while a push was still in flight, that edit's dirty/deleted mark got
// silently wiped -- it never reached GitHub, but the sync status still
// reported "synced". Confirmed against the user's real notes repo: pages
// merged away locally were still sitting on GitHub, never deleted.
//
// This test reproduces the exact shape of the race against a real
// GitHubSyncStore (imported from the actual build output, not a
// reimplementation) and an in-memory mock of GitHub's API with artificial
// network latency, and asserts the edit that lands mid-flight survives to
// the next sync instead of being dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { installMockGitHubApi } from './helpers/mock-github-api.mjs';

test('an edit that lands while a push is in flight is not lost', async () => {
  const mock = installMockGitHubApi({ delayMs: 30 });
  const store = new GitHubSyncStore({ owner: 'o', repo: 'r', branch: 'main', token: 't' });
  await store.syncNow(); // let the constructor's initial sync(0) settle

  // Seed a "Source" page as if it were already on the remote from an
  // earlier, unrelated sync.
  await store.savePage({ title: 'Source', lines: ['Source', 'original body'] });
  await store.syncNow();
  assert.deepEqual(
    mock.currentRemoteState().index.map((e) => e.title),
    ['Source']
  );

  // Page X: an unrelated edit whose sync is about to be in flight.
  await store.savePage({ title: 'X', lines: ['X'] });
  const waitForTreesPost = mock.armTreesPostedSignal();
  const firstSync = store.syncNow();

  // While that push is still mid-flight (real network round trips),
  // simulate a rapid page merge: save the target, delete the source. This
  // is the exact shape of app.ts's merge-now handler. Waiting for the
  // mock's POST git/trees guarantees this really lands inside
  // pushBatch(), not just somewhere in pull()'s own earlier round trips.
  await waitForTreesPost;
  await store.savePage({ title: 'Target', lines: ['Target', 'merged body'] });
  await store.deletePage('Source');

  await firstSync;

  // The merge must not have been silently dropped just because it
  // happened to land during the unrelated X sync's network calls.
  assert.ok(
    store.getSyncStatus().dirtyCount > 0,
    'the merge made during the in-flight push should still be queued, not marked synced'
  );

  // A second sync should now actually deliver it.
  await store.syncNow();
  const finalTitles = mock.currentRemoteState().index.map((e) => e.title).sort();
  assert.deepEqual(finalTitles, ['Target', 'X']);
  assert.equal(store.getSyncStatus().dirtyCount, 0);
});
