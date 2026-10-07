import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, isIdentical } from '../js/diff.js';

test('identical line lists report as identical (the 心療内科 case)', () => {
  const lines = ['a', '', 'b'];
  assert.ok(isIdentical(diffLines(lines, [...lines])));
  assert.ok(isIdentical(diffLines([], [])));
});

test('added, removed and unchanged lines are classified in order', () => {
  const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
  assert.deepEqual(ops, [
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'added', text: 'x' },
    { kind: 'same', text: 'c' },
    { kind: 'added', text: 'd' },
  ]);
  assert.ok(!isIdentical(ops));
});
