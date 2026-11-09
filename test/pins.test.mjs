// Device-local page pins (src/pins.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePinStore } from '../js/pins.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), raw: m };
};

test('toggle pins and unpins, case-insensitively', () => {
  const pins = makePinStore('k', memory());
  assert.equal(pins.isPinned('Foo'), false);
  assert.equal(pins.toggle('Foo'), true);
  assert.equal(pins.isPinned('foo'), true);
  assert.equal(pins.toggle('FOO'), false);
  assert.equal(pins.isPinned('Foo'), false);
});

test('pins survive a new instance on the same storage', () => {
  const storage = memory();
  makePinStore('k', storage).toggle('Foo');
  assert.equal(makePinStore('k', storage).isPinned('Foo'), true);
  assert.equal(makePinStore('other', storage).isPinned('Foo'), false);
});

test('floatPinned puts pinned pages first (latest pin first) and keeps the rest in order', async () => {
  const pins = makePinStore('k', memory());
  pins.toggle('c');
  await new Promise((r) => setTimeout(r, 5));
  pins.toggle('a');
  const rows = ['a', 'b', 'c', 'd', 'e'].map((title) => ({ title }));
  assert.deepEqual(pins.floatPinned(rows).map((r) => r.title), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(rows.map((r) => r.title), ['a', 'b', 'c', 'd', 'e'], 'input is not mutated');
});

test('rename moves the pin, unpin drops it', () => {
  const pins = makePinStore('k', memory());
  pins.toggle('Old');
  pins.rename('Old', 'New');
  assert.equal(pins.isPinned('Old'), false);
  assert.equal(pins.isPinned('New'), true);
  pins.rename('Nothing', 'Else'); // not pinned: no-op
  assert.equal(pins.isPinned('Else'), false);
  pins.unpin('new');
  assert.equal(pins.isPinned('New'), false);
});

test('broken or unavailable storage never throws', () => {
  const bad = { getItem: () => '{not json', setItem: () => { throw new Error('full'); } };
  const pins = makePinStore('k', bad);
  assert.equal(pins.isPinned('x'), false);
  assert.doesNotThrow(() => pins.toggle('x'));
  const none = makePinStore('k', null);
  assert.equal(none.isPinned('x'), false);
});
