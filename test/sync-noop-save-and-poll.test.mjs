// Regression tests for "sync feels laggy and reloading produces conflict
// pages" (see docs/decisions/09-noop-save-conflict-and-polling.md).
//
// 1. Opening a page on the PC and blurring it (Editor.commit() -> onChange ->
//    savePage with unchanged lines) used to bump `updated` and mark the page
//    dirty. When the phone then edited that page, the PC's next pull() saw
//    "dirty + remote updated differs" and stashed a "(sync conflict)" copy
//    even though the PC never changed anything.
// 2. A sync with nothing dirty and an unmoved branch must cost only the ref
//    read, so a foreground tab can poll cheaply; once the branch moves, the
//    poll must pull and bump dataVersion so the UI knows to re-render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
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

test('re-saving an unchanged page does not mark it dirty, so a later edit elsewhere is not a conflict', async () => {
  installMockGitHubApi({ delayMs: 1 });
  const storagePhone = freshLocalStorage();
  const storagePc = freshLocalStorage();

  global.localStorage = storagePhone;
  const phone = new GitHubSyncStore(config);
  await phone.syncNow();
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await phone.syncNow();

  global.localStorage = storagePc;
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();
  // PC opens the page and blurs without editing: onChange -> savePage, same lines.
  await pc.savePage({ title: 'Notes', lines: ['Notes', 'v0'] });
  assert.equal(pc.getSyncStatus().dirtyCount, 0);
  assert.equal((await pc.getPage('Notes')).updated, 1000);

  global.localStorage = storagePhone;
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'v0', 'added on phone'], updated: 2000 });
  await phone.syncNow();

  global.localStorage = storagePc;
  await pc.syncNow();

  assert.deepEqual((await pc.listPages()).map((p) => p.title), ['Notes']);
  assert.deepEqual((await pc.getPage('Notes')).lines, ['Notes', 'v0', 'added on phone']);
  phone.dispose();
  pc.dispose();
});

test('a real edit and a mergeCandidate change are still saved', async () => {
  installMockGitHubApi({ delayMs: 1 });
  global.localStorage = freshLocalStorage();
  const store = new GitHubSyncStore(config);
  await store.syncNow();
  await store.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await store.syncNow();

  await store.savePage({ title: 'Notes', lines: ['Notes', 'v1'] });
  assert.equal(store.getSyncStatus().dirtyCount, 1);
  await store.syncNow();

  await store.savePage({ title: 'Notes', lines: ['Notes', 'v1'], mergeCandidate: 'Other' });
  assert.equal(store.getSyncStatus().dirtyCount, 1);
  await store.syncNow();
  await store.savePage({ title: 'Notes', lines: ['Notes', 'v1'], mergeCandidate: null });
  assert.equal(store.getSyncStatus().dirtyCount, 1);
  store.dispose();
});

test('an idle poll is a single ref read; a moved branch is pulled and bumps dataVersion', async () => {
  installMockGitHubApi({ delayMs: 1 });
  const storagePhone = freshLocalStorage();
  const storagePc = freshLocalStorage();

  global.localStorage = storagePc;
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();

  const realFetch = global.fetch;
  let calls = [];
  global.fetch = (url, init) => {
    calls.push(String(url));
    return realFetch(url, init);
  };

  await pc.syncNow();
  assert.equal(calls.length, 2, `expected ref read + display HEAD read, got ${calls.join(', ')}`);
  assert.ok(calls.every((u) => u.includes('git/ref/heads/main')));
  const versionBefore = pc.getSyncStatus().dataVersion;

  global.fetch = realFetch;
  global.localStorage = storagePhone;
  const phone = new GitHubSyncStore(config);
  await phone.syncNow();
  await phone.savePage({ title: 'From phone', lines: ['From phone', 'hi'] });
  await phone.syncNow();

  global.localStorage = storagePc;
  await pc.syncNow();
  assert.equal((await pc.getPage('From phone')).lines[1], 'hi');
  assert.equal(pc.getSyncStatus().dataVersion, versionBefore + 1);

  await pc.syncNow(); // nothing new: must not bump again
  assert.equal(pc.getSyncStatus().dataVersion, versionBefore + 1);
  phone.dispose();
  pc.dispose();
});
