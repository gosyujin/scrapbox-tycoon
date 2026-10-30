// SyncStatus.phase drives the footer badge (waiting -> starting -> pulling /
// pushing -> done | conflict | error), so its sequence is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { GitHubStore } from '../js/store/github-store.js';
import { installMockGitHubApi } from './helpers/mock-github-api.mjs';

const config = { owner: 'o', repo: 'r', branch: 'main', token: 't' };

function recordPhases(store) {
  const phases = [];
  store.onSyncStatusChange((s) => {
    if (phases.at(-1) !== s.phase) phases.push(s.phase);
  });
  return phases;
}

test('an edit goes waiting -> starting -> pulling -> pushing -> done', async () => {
  installMockGitHubApi({ delayMs: 5 });
  const store = new GitHubSyncStore(config);
  assert.equal(store.getSyncStatus().phase, 'waiting', 'nothing has started yet');
  await store.syncNow();

  const phases = recordPhases(store);
  await store.savePage({ title: 'A', lines: ['A', 'x'], updated: 1000 });
  assert.equal(store.getSyncStatus().phase, 'waiting', 'queued edit waits for the debounce');
  await store.syncNow();

  assert.deepEqual(phases, ['waiting', 'starting', 'pulling', 'pushing', 'done']);
  assert.equal(store.getSyncStatus().conflictCount, 0);
  store.dispose();
});

test('a sync that left conflict markers in a page ends in "conflict" until they are resolved', async () => {
  installMockGitHubApi({ delayMs: 5 });
  const store = new GitHubSyncStore(config);
  await store.syncNow();
  await store.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await store.syncNow();

  await store.savePage({ title: 'Notes', lines: ['Notes', 'mine'], updated: 1500 });
  await new GitHubStore(config).pushBatch([{ title: 'Notes', lines: ['Notes', 'theirs'], updated: 2000 }], 'other device');
  await store.syncNow();

  assert.equal(store.getSyncStatus().phase, 'conflict');
  assert.equal(store.getSyncStatus().conflictCount, 1);
  assert.deepEqual(store.getSyncStatus().conflictTitles, ['Notes']);

  await store.savePage({ title: 'Notes', lines: ['Notes', 'mine'], updated: 3000 }); // the user settled it
  await store.syncNow();
  assert.equal(store.getSyncStatus().phase, 'done');
  assert.equal(store.getSyncStatus().conflictCount, 0);
  store.dispose();
});

test('a failing sync ends in "error"', async () => {
  installMockGitHubApi({ delayMs: 1 });
  const store = new GitHubSyncStore(config);
  await store.syncNow();
  global.fetch = async () => new Response('boom', { status: 500 });
  await assert.rejects(store.syncNow());
  assert.equal(store.getSyncStatus().phase, 'error');
  store.dispose();
});

test('idle polls do not flood the debug log', async () => {
  installMockGitHubApi({ delayMs: 1 });
  const store = new GitHubSyncStore(config);
  await store.syncNow();
  const before = store.getStatusLogText().split('\n').length;
  for (let i = 0; i < 5; i++) await store.syncNow();
  assert.equal(store.getStatusLogText().split('\n').length, before);
  store.dispose();
});
