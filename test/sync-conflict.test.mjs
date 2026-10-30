// Two devices changing the same page between syncs (decisions/07 first, then
// 13): the page is merged line by line against the version both started from.
// No "(sync conflict)" copy page is created; whatever cannot be merged cleanly
// stays inside the page between markers, and resolving it must not start a
// new conflict -- that cascade (resolve -> conflict -> resolve -> ...) is what
// the copy-page design produced.
//
// Two GitHubSyncStore instances against ONE shared mock remote, with separate
// localStorage swapped via global.localStorage between turns (safe because every
// turn ends with an awaited syncNow(), which clears that turn's timers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { findConflictHunks, resolveConflictHunk, hasConflictMarkers } from '../js/merge.js';
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

// A phone + a PC, both already synced with 'Notes' = [Notes, a, b, c].
async function twoDevices(delayMs = 5) {
  const mock = installMockGitHubApi({ delayMs });
  const storage = { phone: freshLocalStorage(), pc: freshLocalStorage() };
  const stores = {};
  const on = (name) => {
    global.localStorage = storage[name];
    return stores[name];
  };
  global.localStorage = storage.phone;
  stores.phone = new GitHubSyncStore(config);
  await stores.phone.syncNow();
  await stores.phone.savePage({ title: 'Notes', lines: ['Notes', 'a', 'b', 'c'], updated: 1000 });
  await stores.phone.syncNow();
  global.localStorage = storage.pc;
  stores.pc = new GitHubSyncStore(config);
  await stores.pc.syncNow();
  return {
    mock,
    storage,
    phone: () => on('phone'),
    pc: () => on('pc'),
    dispose: () => Object.values(stores).forEach((s) => s.dispose()),
  };
}

async function remoteTitles(mock) {
  return mock
    .currentRemoteState()
    .index.map((e) => e.title)
    .sort();
}

test('edits to different lines on two devices are merged, with no extra page and no markers', async () => {
  const d = await twoDevices();
  await d.pc().savePage({ title: 'Notes', lines: ['Notes', 'a', 'b', 'c', 'line from PC'], updated: 1500 });
  await d.phone().savePage({ title: 'Notes', lines: ['Notes', 'A', 'b', 'c'], updated: 2000 });
  await d.phone().syncNow();
  const pc = d.pc();
  await pc.syncNow();

  const expected = ['Notes', 'A', 'b', 'c', 'line from PC'];
  assert.deepEqual((await pc.getPage('Notes')).lines, expected);
  assert.deepEqual(d.mock.remotePage('Notes').lines, expected);
  assert.deepEqual(await remoteTitles(d.mock), ['Notes']);
  assert.equal(pc.getSyncStatus().phase, 'done');

  const phone = d.phone();
  await phone.syncNow();
  assert.deepEqual((await phone.getPage('Notes')).lines, expected, 'the phone converges on the same merged page');
  assert.deepEqual(await phone.listPages().then((l) => l.map((p) => p.title)), ['Notes']);
  d.dispose();
});

test('the same line edited on both devices is kept, both sides, between markers on every device', async () => {
  const d = await twoDevices();
  await d.pc().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-pc', 'c'], updated: 1500 });
  await d.phone().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-phone', 'c'], updated: 2000 });
  await d.phone().syncNow();
  const pc = d.pc();
  await pc.syncNow();

  const merged = (await pc.getPage('Notes')).lines;
  assert.equal(findConflictHunks(merged).length, 1);
  assert.ok(merged.includes('B-pc') && merged.includes('B-phone'), 'nothing either side wrote is lost');
  assert.deepEqual(d.mock.remotePage('Notes').lines, merged);
  assert.deepEqual(await remoteTitles(d.mock), ['Notes'], 'no conflict copy page');
  assert.equal(pc.getSyncStatus().phase, 'conflict');
  assert.deepEqual(pc.getSyncStatus().conflictTitles, ['Notes']);

  const phone = d.phone();
  await phone.syncNow();
  assert.deepEqual((await phone.getPage('Notes')).lines, merged);
  assert.equal(phone.getSyncStatus().phase, 'conflict');
  d.dispose();
});

test('both devices merging the same divergence at once end up identical (the second push has nothing to fight over)', async () => {
  const d = await twoDevices();
  await d.pc().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-pc', 'c'], updated: 1500 });
  await d.phone().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-phone', 'c'], updated: 2000 });
  // Both pull and push in the same window: PC loses the ref race and must
  // re-merge against what the phone wrote.
  const pc = d.pc();
  const mock = d.mock;
  const { GitHubStore } = await import('../js/store/github-store.js');
  const phoneRemote = new GitHubStore(config);
  mock.setBeforeRefUpdateHook(() =>
    phoneRemote.pushBatch([{ title: 'Notes', lines: ['Notes', 'a', 'B-phone', 'c'], updated: 2000 }], 'phone')
  );
  await pc.syncNow();

  const lines = mock.remotePage('Notes').lines;
  assert.ok(lines.includes('B-pc') && lines.includes('B-phone'));
  assert.equal(findConflictHunks(lines).length, 1, 'one block, not nested markers from a second round');
  assert.deepEqual(await remoteTitles(mock), ['Notes']);
  d.dispose();
});

test('resolving a conflict the same way on both devices does not create a new conflict', async () => {
  const d = await twoDevices();
  await d.pc().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-pc', 'c'], updated: 1500 });
  await d.phone().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-phone', 'c'], updated: 2000 });
  await d.phone().syncNow();
  await d.pc().syncNow();
  await d.phone().syncNow();

  // Each device resolves on its own, before seeing the other's resolution.
  for (const name of ['phone', 'pc']) {
    const store = d[name]();
    const page = await store.getPage('Notes');
    const lines = resolveConflictHunk(page.lines, findConflictHunks(page.lines)[0], 'first');
    await store.savePage({ title: 'Notes', lines, updated: name === 'phone' ? 3000 : 3100 });
  }
  await d.phone().syncNow();
  const pc = d.pc();
  await pc.syncNow();
  const phone = d.phone();
  await phone.syncNow();

  const remote = d.mock.remotePage('Notes').lines;
  assert.equal(hasConflictMarkers(remote), false);
  assert.deepEqual(remote, ['Notes', 'a', 'B-pc', 'c']);
  assert.deepEqual((await phone.getPage('Notes')).lines, remote);
  assert.deepEqual((await pc.getPage('Notes')).lines, remote);
  assert.deepEqual(await remoteTitles(d.mock), ['Notes']);
  assert.equal(phone.getSyncStatus().phase, 'done');
  d.dispose();
});

test('resolving differently on two devices never spawns extra pages: one block, and both devices converge', async () => {
  const d = await twoDevices();
  await d.pc().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-pc', 'c'], updated: 1500 });
  await d.phone().savePage({ title: 'Notes', lines: ['Notes', 'a', 'B-phone', 'c'], updated: 2000 });
  await d.phone().syncNow();
  await d.pc().syncNow();
  await d.phone().syncNow();

  for (const [name, choice, updated] of [['phone', 'first', 3000], ['pc', 'second', 3100]]) {
    const store = d[name]();
    const page = await store.getPage('Notes');
    await store.savePage({ title: 'Notes', lines: resolveConflictHunk(page.lines, findConflictHunks(page.lines)[0], choice), updated });
  }
  await d.phone().syncNow();
  const pc = d.pc();
  await pc.syncNow();
  const phone = d.phone();
  await phone.syncNow();

  const remote = d.mock.remotePage('Notes').lines;
  assert.equal(findConflictHunks(remote).length, 1);
  assert.ok(remote.includes('B-pc') && remote.includes('B-phone'));
  assert.deepEqual((await phone.getPage('Notes')).lines, remote);
  assert.deepEqual((await pc.getPage('Notes')).lines, remote);
  assert.deepEqual(await remoteTitles(d.mock), ['Notes']);
  d.dispose();
});

test('without a recorded base (older meta) nothing is lost either', async () => {
  const d = await twoDevices();
  await d.pc().savePage({ title: 'Notes', lines: ['Notes', 'a', 'b', 'c', 'pc line'], updated: 1500 });
  // Simulate meta written by a build that did not track baseCommit.
  const metaKey = 'scrapbox_tycoon_sync_meta_v1';
  const meta = JSON.parse(d.storage.pc.getItem(metaKey));
  delete meta.baseCommit;
  d.storage.pc.setItem(metaKey, JSON.stringify(meta));
  await d.phone().savePage({ title: 'Notes', lines: ['Notes', 'a', 'b', 'c', 'phone line'], updated: 2000 });
  await d.phone().syncNow();
  await d.pc().syncNow();

  const lines = d.mock.remotePage('Notes').lines;
  assert.ok(lines.includes('pc line') && lines.includes('phone line'));
  assert.deepEqual(await remoteTitles(d.mock), ['Notes']);
  d.dispose();
});
