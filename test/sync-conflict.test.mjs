// Regression test for a real data-loss report: editing the same page on two
// devices between syncs used to mean the more-recent push silently threw
// away whatever the other device had added, with no trace of it anywhere
// except GitHub's commit history. Confirmed against the user's real notes
// repo (commits b66065c.. / 8994df4.. on the phone, 0f9e937.. on the PC):
// the PC's sync landed cleanly on top of the phone's already-pushed edit,
// then a few seconds later overwrote that same page back down to the PC's
// own (older) content, discarding everything the phone had just added.
//
// This is a two-device scenario, so it drives two GitHubSyncStore instances
// against ONE shared mock GitHub remote but with separate localStorage
// (swapped via global.localStorage between each device's turn -- safe here
// because every turn ends with an awaited syncNow(), whose runSync() clears
// any timer that turn's savePage() scheduled before the next swap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSyncStore } from '../js/store/github-sync-store.js';
import { installMockGitHubApi } from './helpers/mock-github-api.mjs';

function freshLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('a genuine concurrent edit to the same page is stashed as a mergeCandidate page instead of silently discarded', async () => {
  const mock = installMockGitHubApi({ delayMs: 10 });
  const storagePhone = freshLocalStorage();
  const storagePc = freshLocalStorage();
  const config = { owner: 'o', repo: 'r', branch: 'main', token: 't' };

  // updated is passed explicitly (rather than left to default to
  // Math.floor(Date.now() / 1000)) so the two real edits below land on
  // different values even though this whole test runs in well under a
  // second -- otherwise the second-resolution timestamp could tie with the
  // baseline and mask the exact divergence this test means to trigger.
  global.localStorage = storagePhone;
  const phone = new GitHubSyncStore(config);
  await phone.syncNow(); // let the constructor's initial sync(0) settle
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'v0'], updated: 1000 });
  await phone.syncNow();

  global.localStorage = storagePc;
  const pc = new GitHubSyncStore(config);
  await pc.syncNow(); // baseline: picks up 'Notes' v0 from the remote

  // The PC has an edit sitting locally, not yet synced -- e.g. made while
  // offline, or simply before its own debounced sync got a chance to run.
  await pc.savePage({ title: 'Notes', lines: ['Notes', 'v0', 'edited on PC'] });

  // Meanwhile the phone edits the exact same page and syncs first.
  global.localStorage = storagePhone;
  await phone.savePage({ title: 'Notes', lines: ['Notes', 'v0', 'added on phone'], updated: 2000 });
  await phone.syncNow();

  // Now the PC syncs. Its own edit still wins for the 'Notes' title itself
  // -- that per-title "more recent sync wins" behavior is documented and
  // intentional (see github-sync-store.ts's header comment) -- but the
  // phone's edit must not vanish without a trace.
  global.localStorage = storagePc;
  await pc.syncNow();

  const notes = await pc.getPage('Notes');
  assert.deepEqual(notes.lines, ['Notes', 'v0', 'edited on PC']);

  const stashedTitle = 'Notes (sync conflict)';
  const stashed = await pc.getPage(stashedTitle);
  assert.ok(stashed, 'expected the phone edit to be stashed as a separate page');
  assert.equal(stashed.mergeCandidate, 'Notes');
  // lines[0] must equal the page's own title, else the first edit to the
  // copy would be treated as a rename (see stashConflictIfDiverged).
  assert.deepEqual(stashed.lines, [stashedTitle, 'v0', 'added on phone']);

  // It must have been pushed to the remote too, not just kept on this one
  // device -- otherwise it would vanish the moment this device's
  // localStorage is cleared.
  const remoteTitles = mock
    .currentRemoteState()
    .index.map((e) => e.title)
    .sort();
  assert.deepEqual(remoteTitles, ['Notes', stashedTitle].sort());

  // A second, uneventful sync must not stash a duplicate copy of the same
  // divergence (conflictSeen is what prevents that).
  await pc.syncNow();
  const pagesAfter = await pc.listPages();
  assert.equal(pagesAfter.filter((p) => p.title === stashedTitle).length, 1);

  phone.dispose();
  pc.dispose();
});
