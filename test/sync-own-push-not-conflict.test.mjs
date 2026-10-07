// Regression test for a false "(sync conflict)" page seen on a phone-only
// setup. Real data: the notes repo had `心療内科 (sync conflict).json` whose
// lines/created/updated were byte-for-byte identical to `心療内科.json` --
// i.e. the "other device's edit" was this device's own push.
//
// Mechanism: a push's commit lands on GitHub but the acknowledgement never
// reaches the client (iOS freezing the PWA right after the PATCH, a dropped
// mobile connection), so lastSyncedUpdated is not advanced and the page stays
// dirty. The next sync's pull() then sees the remote `updated` differ from
// lastSyncedUpdated and used to conclude "another device changed this".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { installMockGitHubApi } from './helpers/mock-github-api.mjs';

const config = { owner: 'o', repo: 'r', branch: 'main', token: 't' };
const META_KEY = 'scrapbox_tycoon_sync_meta_v1';

async function pushWithLostAck(mock, store, page) {
  await store.savePage(page);
  mock.setLostAckOnRefUpdate(true);
  await assert.rejects(store.syncNow(), /Could not save/);
  mock.setLostAckOnRefUpdate(false);
}

function titles(list) {
  return list.map((p) => p.title).sort();
}

test('a push whose acknowledgement was lost is recognised as our own write on the next sync (pendingPush)', async () => {
  const mock = installMockGitHubApi({ delayMs: 1 });
  const store = new GitHubSyncStore(config);
  await store.syncNow();
  await store.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await store.syncNow();

  await pushWithLostAck(mock, store, { title: 'Notes', lines: ['Notes', 'v0', 'edited on phone'], updated: 2000 });
  await store.syncNow();

  assert.deepEqual(titles(await store.listPages()), ['Notes']);
  assert.deepEqual((await store.getPage('Notes')).lines, ['Notes', 'v0', 'edited on phone']);
  assert.deepEqual(mock.currentRemoteState().index.map((e) => e.title), ['Notes']);
  assert.equal(store.getSyncStatus().dirtyCount, 0);
  store.dispose();
});

test('identical content is never a conflict even without pendingPush (older meta, same-content fallback)', async () => {
  const mock = installMockGitHubApi({ delayMs: 1 });
  const store = new GitHubSyncStore(config);
  await store.syncNow();
  await store.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await store.syncNow();

  await pushWithLostAck(mock, store, { title: 'Notes', lines: ['Notes', 'v0', 'edited on phone'], updated: 2000 });

  // Forget the pendingPush record, so only the content comparison can save us.
  const meta = JSON.parse(localStorage.getItem(META_KEY));
  delete meta.pendingPush;
  localStorage.setItem(META_KEY, JSON.stringify(meta));
  store.dispose();
  const reopened = new GitHubSyncStore(config);
  await reopened.syncNow();

  assert.deepEqual(titles(await reopened.listPages()), ['Notes']);
  assert.deepEqual(mock.currentRemoteState().index.map((e) => e.title), ['Notes']);
  reopened.dispose();
});
