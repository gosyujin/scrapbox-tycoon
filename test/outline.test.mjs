// Outline editing (ctrl/alt + arrow) on plain line arrays -- see src/outline.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveLines,
  indentLines,
  moveSubtree,
  indentSubtree,
  selectedLineRange,
  mapPosition,
} from '../js/outline.js';

const doc = ['title', 'a', ' a1', ' a2', '  a2x', 'b', ' b1', 'c'];

test('moveLines swaps a single line with its neighbour, ignoring nesting', () => {
  const e = moveLines(doc, { from: 5, to: 5 }, -1);
  assert.deepEqual(e.lines, ['title', 'a', ' a1', ' a2', 'b', '  a2x', ' b1', 'c']);
  assert.equal(e.lineShift, -1);
});

test('moveLines moves a multi-line selection as one block', () => {
  const e = moveLines(doc, { from: 2, to: 3 }, 1);
  assert.deepEqual(e.lines, ['title', 'a', '  a2x', ' a1', ' a2', 'b', ' b1', 'c']);
  assert.equal(e.lineShift, 1);
});

test('moveLines never touches or crosses the title, nor runs off the end', () => {
  assert.equal(moveLines(doc, { from: 0, to: 0 }, 1), null);
  assert.equal(moveLines(doc, { from: 1, to: 1 }, -1), null);
  assert.equal(moveLines(doc, { from: 7, to: 7 }, 1), null);
});

test('indentLines adds/removes one leading space per selected line', () => {
  const e = indentLines(doc, { from: 1, to: 2 }, 1);
  assert.deepEqual(e.lines.slice(1, 4), [' a', '  a1', ' a2']);
  assert.deepEqual(indentLines(doc, { from: 2, to: 2 }, -1).lines[2], 'a1');
  assert.equal(indentLines(doc, { from: 1, to: 1 }, -1), null); // nothing to remove
  assert.equal(indentLines(doc, { from: 0, to: 0 }, 1), null); // title is never indented
});

test('indentLines also strips a tab / full-width space', () => {
  assert.equal(indentLines(['t', '\tx'], { from: 1, to: 1 }, -1).lines[1], 'x');
  assert.equal(indentLines(['t', '　x'], { from: 1, to: 1 }, -1).lines[1], 'x');
});

test('moveSubtree swaps a node (with its children) past the sibling subtree', () => {
  const down = moveSubtree(doc, { from: 1, to: 1 }, 1);
  assert.deepEqual(down.lines, ['title', 'b', ' b1', 'a', ' a1', ' a2', '  a2x', 'c']);
  assert.equal(down.lineShift, 2);
  const up = moveSubtree(doc, { from: 5, to: 5 }, -1);
  assert.deepEqual(up.lines, ['title', 'b', ' b1', 'a', ' a1', ' a2', '  a2x', 'c']);
  assert.equal(up.lineShift, -4);
});

test('moveSubtree among nested siblings stays inside the parent', () => {
  const e = moveSubtree(doc, { from: 3, to: 3 }, -1); // a2 (+a2x) above a1
  assert.deepEqual(e.lines, ['title', 'a', ' a2', '  a2x', ' a1', 'b', ' b1', 'c']);
  assert.equal(moveSubtree(doc, { from: 2, to: 2 }, -1), null); // a1 has no previous sibling (parent above)
  assert.equal(moveSubtree(doc, { from: 4, to: 4 }, 1), null); // a2x is the parent's last child
});

test('moveSubtree cannot swap with the title block', () => {
  assert.equal(moveSubtree(doc, { from: 1, to: 1 }, -1), null);
  assert.equal(moveSubtree(doc, { from: 0, to: 0 }, 1), null);
});

test('indentSubtree indents / outdents a node together with its children', () => {
  const e = indentSubtree(doc, { from: 3, to: 3 }, 1); // a2 + a2x
  assert.deepEqual(e.lines, ['title', 'a', ' a1', '  a2', '   a2x', 'b', ' b1', 'c']);
  const o = indentSubtree(doc, { from: 3, to: 3 }, -1);
  assert.deepEqual(o.lines, ['title', 'a', ' a1', 'a2', ' a2x', 'b', ' b1', 'c']);
  assert.equal(indentSubtree(doc, { from: 1, to: 1 }, -1), null); // already at depth 0
  assert.equal(indentSubtree(doc, { from: 0, to: 0 }, 1), null);
});

test('indentSubtree from a line inside the tree reaches only that subtree', () => {
  const e = indentSubtree(doc, { from: 1, to: 1 }, 1); // a + a1 a2 a2x, not b
  assert.deepEqual(e.lines, ['title', ' a', '  a1', '  a2', '   a2x', 'b', ' b1', 'c']);
});

test('selectedLineRange drops a trailing line selected only at column 0', () => {
  assert.deepEqual(selectedLineRange({ line: 2, col: 1 }, { line: 4, col: 0 }), { from: 2, to: 3 });
  assert.deepEqual(selectedLineRange({ line: 2, col: 0 }, { line: 2, col: 0 }), { from: 2, to: 2 });
});

test('mapPosition follows moved and indented lines', () => {
  const moved = moveLines(doc, { from: 5, to: 5 }, -1);
  assert.deepEqual(mapPosition(moved, { line: 5, col: 1 }), { line: 4, col: 1 });
  const indented = indentLines(doc, { from: 1, to: 2 }, 1);
  assert.deepEqual(mapPosition(indented, { line: 2, col: 3 }), { line: 2, col: 4 });
  assert.deepEqual(mapPosition(indented, { line: 5, col: 0 }), { line: 5, col: 0 });
});
