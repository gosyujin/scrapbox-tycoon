// Per-line edit times ("telomere"): carried across edits by diffing text, kept
// through the local store, and synced to / merged between devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLineTimes, normalizeLineTimes, reconcileLineTimes, telomereLevel } from '../js/line-times.js';
import { LocalStore } from '../js/store/local-store.js';
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

test('reconcileLineTimes keeps unchanged lines and stamps edited/new ones', () => {
  const old = ['T', 'a', 'b', 'c'];
  const times = [10, 20, 30, 40];
  assert.deepEqual(reconcileLineTimes(old, times, ['T', 'a', 'B', 'c'], 99), [10, 20, 99, 40]);
  assert.deepEqual(reconcileLineTimes(old, times, ['T', 'a', 'b', 'c', 'd'], 99), [10, 20, 30, 40, 99]);
  assert.deepEqual(reconcileLineTimes(old, times, ['T', 'x', 'a', 'b', 'c'], 99), [10, 99, 20, 30, 40]);
  assert.deepEqual(reconcileLineTimes(old, times, ['T', 'a', 'c'], 99), [10, 20, 40]);
  assert.deepEqual(reconcileLineTimes(old, times, old, 99), times);
  assert.deepEqual(reconcileLineTimes([], [], ['x', 'y'], 99), [99, 99]);
});

test('normalizeLineTimes falls back for missing or mismatched arrays', () => {
  assert.deepEqual(normalizeLineTimes(['a', 'b'], undefined, 5), [5, 5]);
  assert.deepEqual(normalizeLineTimes(['a', 'b'], [1], 5), [5, 5]);
  assert.deepEqual(normalizeLineTimes(['a', 'b'], [1, 2], 5), [1, 2]);
});

test('mergeLineTimes takes the newest time of each line across sources', () => {
  const a = { lines: ['T', 'x', 'y'], times: [1, 100, 5] };
  const b = { lines: ['T', 'x', 'z'], times: [1, 50, 70] };
  const merged = ['T', 'x', 'y', 'z'];
  assert.deepEqual(mergeLineTimes(merged, [a, b], 999), [1, 100, 5, 70]);
  assert.deepEqual(mergeLineTimes(merged, [b, a], 999), [1, 100, 5, 70]);
  assert.deepEqual(mergeLineTimes(['T', 'new'], [a, b], 999), [1, 999]);
});

test('telomereLevel buckets by age', () => {
  const now = 1_000_000_000;
  assert.equal(telomereLevel(now, now), 0);
  assert.equal(telomereLevel(now - 2 * 3600, now), 1);
  assert.equal(telomereLevel(now - 3 * 86400, now), 2);
  assert.equal(telomereLevel(now - 20 * 86400, now), 3);
  assert.equal(telomereLevel(now - 100 * 86400, now), 4);
  assert.equal(telomereLevel(now - 400 * 86400, now), 5);
  assert.equal(telomereLevel(now + 100, now), 0);
});

test('LocalStore: legacy records read back filled with `updated`; edits stamp only changed lines', async () => {
  global.localStorage = freshLocalStorage();
  localStorage.setItem('scrapbox_tycoon_pages_v1', JSON.stringify({ Old: { title: 'Old', lines: ['Old', 'a', 'b'], created: 100, updated: 500 } }));
  const store = new LocalStore();
  assert.deepEqual((await store.getPage('Old')).lineTimes, [500, 500, 500]);

  await store.savePage({ title: 'Old', lines: ['Old', 'a', 'B'], updated: 900 });
  assert.deepEqual((await store.getPage('Old')).lineTimes, [500, 500, 900]);

  await store.savePage({ title: 'New', lines: ['New', 'x'], updated: 700 });
  assert.deepEqual((await store.getPage('New')).lineTimes, [700, 700]);

  // Explicit times (sync) are stored as given.
  await store.savePage({ title: 'New', lines: ['New', 'x'], updated: 800, lineTimes: [1, 2] });
  assert.deepEqual((await store.getPage('New')).lineTimes, [1, 2]);
});

test('lineTimes survive a push/pull to another device, including older remote records without them', async () => {
  installMockGitHubApi({ delayMs: 1 });
  const storagePhone = freshLocalStorage();
  const storagePc = freshLocalStorage();

  global.localStorage = storagePhone;
  const phone = new GitHubSyncStore(config);
  await phone.syncNow();
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'one', 'two'], updated: 1000 });
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'one', 'two!'], updated: 2000 });
  assert.deepEqual((await phone.getPage('Notes')).lineTimes, [1000, 1000, 2000]);
  await phone.syncNow();

  global.localStorage = storagePc;
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();
  assert.deepEqual((await pc.getPage('Notes')).lineTimes, [1000, 1000, 2000]);
  phone.dispose();
  pc.dispose();
});

test('a diverged merge combines lineTimes from both sides', async () => {
  installMockGitHubApi({ delayMs: 1 });
  const storagePhone = freshLocalStorage();
  const storagePc = freshLocalStorage();

  global.localStorage = storagePhone;
  const phone = new GitHubSyncStore(config);
  await phone.syncNow();
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'a', 'b', 'c'], updated: 1000 });
  await phone.syncNow();

  global.localStorage = storagePc;
  const pc = new GitHubSyncStore(config);
  await pc.syncNow();

  global.localStorage = storagePhone;
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'a', 'b', 'c', 'phone'], updated: 2000 });
  await phone.syncNow();

  global.localStorage = storagePc;
  await pc.savePage({ title: 'Notes', lines: ['Notes', 'pc', 'a', 'b', 'c'], updated: 3000 });
  await pc.syncNow();

  const page = await pc.getPage('Notes');
  assert.deepEqual(page.lines, ['Notes', 'pc', 'a', 'b', 'c', 'phone']);
  assert.equal(page.lineTimes.length, page.lines.length);
  assert.deepEqual(page.lineTimes.slice(0, 5), [1000, 3000, 1000, 1000, 1000]);
  assert.equal(page.lineTimes[5], 2000);
  phone.dispose();
  pc.dispose();
});
