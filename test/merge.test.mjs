import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  merge3,
  commonLines,
  findConflictHunks,
  resolveConflictHunk,
  hasConflictMarkers,
  CONFLICT_START,
  CONFLICT_SEP,
  CONFLICT_END,
} from '../js/merge.js';

const side = (lines, updated) => ({ lines, updated });

test('edits to different lines merge without markers, whichever side is "mine"', () => {
  const base = ['T', 'a', 'b', 'c', 'd'];
  const x = side(['T', 'A', 'b', 'c', 'd'], 10);
  const y = side(['T', 'a', 'b', 'c', 'D'], 20);
  const expected = ['T', 'A', 'b', 'c', 'D'];
  assert.deepEqual(merge3(base, x, y), { lines: expected, conflicts: 0 });
  assert.deepEqual(merge3(base, y, x), { lines: expected, conflicts: 0 });
});

test('both sides appending to the end keep both, older first', () => {
  const base = ['T', 'a'];
  const phone = side(['T', 'a', 'from phone'], 20);
  const pc = side(['T', 'a', 'from pc'], 10);
  const expected = ['T', 'a', 'from pc', 'from phone'];
  assert.deepEqual(merge3(base, phone, pc), { lines: expected, conflicts: 0 });
  assert.deepEqual(merge3(base, pc, phone), { lines: expected, conflicts: 0 });
});

test('both sides making the same change is not a conflict', () => {
  const base = ['T', 'a', 'b'];
  const same = ['T', 'a', 'B'];
  assert.deepEqual(merge3(base, side(same, 1), side(same, 2)), { lines: same, conflicts: 0 });
});

test('a change on one side only is taken as is (insert, delete)', () => {
  const base = ['T', 'a', 'b', 'c'];
  const edited = side(['T', 'x', 'a', 'c'], 5);
  assert.deepEqual(merge3(base, edited, side(base, 9)).lines, ['T', 'x', 'a', 'c']);
  assert.deepEqual(merge3(base, side(base, 9), edited).lines, ['T', 'x', 'a', 'c']);
});

test('the same line edited differently on both sides keeps both between markers, identically from either perspective', () => {
  const base = ['T', 'a', 'b', 'c'];
  const older = side(['T', 'a', 'B-old', 'c'], 10);
  const newer = side(['T', 'a', 'B-new', 'c'], 20);
  const expected = ['T', 'a', CONFLICT_START, 'B-old', CONFLICT_SEP, 'B-new', CONFLICT_END, 'c'];
  assert.deepEqual(merge3(base, older, newer), { lines: expected, conflicts: 1 });
  assert.deepEqual(merge3(base, newer, older), { lines: expected, conflicts: 1 });
});

test('a delete against an edit of the same line is a conflict that keeps the edit visible', () => {
  const base = ['T', 'a', 'b', 'c'];
  const deleted = side(['T', 'a', 'c'], 10);
  const edited = side(['T', 'a', 'B', 'c'], 20);
  const merged = merge3(base, deleted, edited);
  assert.equal(merged.conflicts, 1);
  assert.deepEqual(merged.lines, ['T', 'a', CONFLICT_START, CONFLICT_SEP, 'B', CONFLICT_END, 'c']);
});

test('changes on adjacent (touching) lines are independent', () => {
  const base = ['T', 'a', 'b'];
  assert.deepEqual(merge3(base, side(['T', 'A', 'b'], 1), side(['T', 'a', 'B'], 2)), { lines: ['T', 'A', 'B'], conflicts: 0 });
});

test('with no usable base, only lines both sides share are trusted', () => {
  const x = ['T', 'a', 'X'];
  const y = ['T', 'a', 'Y'];
  const merged = merge3(commonLines(x, y), side(x, 1), side(y, 2));
  assert.deepEqual(merged.lines, ['T', 'a', 'X', 'Y']); // both appended after the shared lines
  assert.equal(merged.conflicts, 0);
});

test('markers can be found and resolved one at a time', () => {
  const lines = ['T', CONFLICT_START, 'one', CONFLICT_SEP, 'two', CONFLICT_END, 'mid', CONFLICT_START, 'p', CONFLICT_SEP, 'q', CONFLICT_END];
  const hunks = findConflictHunks(lines);
  assert.equal(hunks.length, 2);
  assert.ok(hasConflictMarkers(lines));
  assert.deepEqual(resolveConflictHunk(lines, hunks[1], 'first'), ['T', CONFLICT_START, 'one', CONFLICT_SEP, 'two', CONFLICT_END, 'mid', 'p']);
  assert.deepEqual(resolveConflictHunk(lines, hunks[0], 'second').slice(0, 3), ['T', 'two', 'mid']);
  assert.deepEqual(resolveConflictHunk(lines, hunks[0], 'both').slice(0, 4), ['T', 'one', 'two', 'mid']);
  assert.equal(hasConflictMarkers(['T', 'plain', '=======']), false);
});

test('two devices resolving the same block the same way do not conflict again', () => {
  const base = ['T', 'a', CONFLICT_START, 'one', CONFLICT_SEP, 'two', CONFLICT_END, 'z'];
  const resolved = ['T', 'a', 'one', 'z'];
  assert.deepEqual(merge3(base, side(resolved, 1), side(resolved, 2)), { lines: resolved, conflicts: 0 });
});
