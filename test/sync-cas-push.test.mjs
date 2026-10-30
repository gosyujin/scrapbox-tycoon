// Regression tests for the "sync protocol" weaknesses found when reviewing why
// conflicts kept cascading (see docs/decisions/12-sync-cas-push.md):
//
//  1. pull() checked for a remote change and push() wrote afterwards as two
//     separate steps, so a commit landing in between was silently overwritten.
//     push() now verifies, inside the same commit attempt that moves the ref
//     (force:false = compare-and-swap), that the remote page is still the one
//     we last saw; if not it aborts and runSync() re-pulls.
//  2. A page deleted locally while another device edited it: the delete used
//     to win and destroyed the other device's edit.
//  3. A "(sync conflict)" copy edited on two devices produced a conflict of a
//     conflict ("... (sync conflict) (sync conflict)").
//  4. A second tab's in-memory sync meta went stale, so it could not see (or
//     even clobbered) the first tab's dirty marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { GitHubStore } from '../js/store/github-store.js';
import { installMockGitHubApi } from './helpers/mock-github-api.mjs';

const config = { owner: 'o', repo: 'r', branch: 'main', token: 't' };

function freshLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('a commit landing between pull and push is not silently overwritten (compare-and-swap push)', async () => {
  const mock = installMockGitHubApi({ delayMs: 10 });
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();
  await pc.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await pc.syncNow();

  await pc.savePage({ title: 'Notes', lines: ['Notes', 'v0', 'edited on PC'], updated: 1500 });

  // The phone's complete commit lands right before the PC's ref update, i.e.
  // after the PC's pull() already concluded "nothing changed remotely".
  const phone = new GitHubStore(config);
  mock.setBeforeRefUpdateHook(() =>
    phone.pushBatch([{ title: 'Notes', lines: ['Notes', 'v0', 'added on phone'], updated: 2000 }], 'phone')
  );
  await pc.syncNow();

  // Both appended: the phone's commit must be merged in, not overwritten.
  assert.deepEqual(mock.remotePage('Notes').lines, ['Notes', 'v0', 'edited on PC', 'added on phone']);
  assert.equal(mock.remotePage('Notes (sync conflict)'), null, 'no conflict copy page any more');
  assert.equal(pc.getSyncStatus().dirtyCount, 0);
  pc.dispose();
});

test("a local delete does not destroy another device's later edit of the same page", async () => {
  const mock = installMockGitHubApi({ delayMs: 10 });
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();
  await pc.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await pc.syncNow();

  await pc.deletePage('Notes');
  const phone = new GitHubStore(config);
  await phone.pushBatch([{ title: 'Notes', lines: ['Notes', 'v0', 'added on phone'], updated: 2000 }], 'phone');

  await pc.syncNow();

  assert.deepEqual(mock.remotePage('Notes')?.lines, ['Notes', 'v0', 'added on phone']);
  assert.deepEqual((await pc.getPage('Notes'))?.lines, ['Notes', 'v0', 'added on phone']);
  assert.equal(pc.getSyncStatus().dirtyCount, 0);
  pc.dispose();
});

test('a delete that races a remote edit between pull and push also keeps the edit', async () => {
  const mock = installMockGitHubApi({ delayMs: 10 });
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();
  await pc.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await pc.syncNow();

  await pc.deletePage('Notes');
  const phone = new GitHubStore(config);
  mock.setBeforeRefUpdateHook(() =>
    phone.pushBatch([{ title: 'Notes', lines: ['Notes', 'v0', 'added on phone'], updated: 2000 }], 'phone')
  );
  await pc.syncNow();

  assert.deepEqual(mock.remotePage('Notes')?.lines, ['Notes', 'v0', 'added on phone']);
  pc.dispose();
});

test('editing a "(sync conflict)" copy on two devices does not create a conflict of a conflict', async () => {
  const mock = installMockGitHubApi({ delayMs: 10 });
  const storagePhone = freshLocalStorage();
  const storagePc = freshLocalStorage();
  const copy = 'Notes (sync conflict)';

  global.localStorage = storagePhone;
  const phone = new GitHubSyncStore(config);
  await phone.syncNow();
  await phone.savePage({ title: copy, lines: [copy, 'a'], updated: 1000, mergeCandidate: 'Notes' });
  await phone.syncNow();

  global.localStorage = storagePc;
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();

  global.localStorage = storagePhone;
  await phone.savePage({ title: copy, lines: [copy, 'a', 'phone edit'], updated: 2000 });
  global.localStorage = storagePc;
  await pc.savePage({ title: copy, lines: [copy, 'a', 'pc edit'], updated: 1500 });
  global.localStorage = storagePhone;
  await phone.syncNow();
  global.localStorage = storagePc;
  await pc.syncNow();
  global.localStorage = storagePhone;
  await phone.syncNow();

  const titles = mock.currentRemoteState().index.map((e) => e.title);
  assert.deepEqual(titles, [copy]);
  phone.dispose();
  pc.dispose();
});

test("a second tab sees the first tab's dirty marks instead of working from a stale copy", async () => {
  const mock = installMockGitHubApi({ delayMs: 10 });
  const tabA = new GitHubSyncStore(config);
  const tabB = new GitHubSyncStore(config); // same localStorage = same browser, two tabs
  await tabA.syncNow();
  await tabB.syncNow();

  await tabB.savePage({ title: 'X', lines: ['X', 'written in tab B'], updated: 1000 });
  await tabA.syncNow(); // tab A never saw the edit itself, only the shared meta

  assert.deepEqual(mock.remotePage('X')?.lines, ['X', 'written in tab B']);
  tabA.dispose();
  tabB.dispose();
});
