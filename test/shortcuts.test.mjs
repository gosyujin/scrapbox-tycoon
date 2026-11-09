// ScrapboxShortcutKey-style shortcuts: combo normalisation (must agree with the
// UserScript's, or its overrides would not replace the defaults) and the
// default handlers' branches, against a stub editor -- see src/shortcuts.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCombo, comboFromEvent, Keymap } from '../js/keymap.js';
import { createShortcuts, DEFAULT_BINDINGS, HANDLER_NAMES } from '../js/shortcuts.js';

test('normalizeCombo orders modifiers and resolves aliases', () => {
  assert.equal(normalizeCombo('Shift+Ctrl+F'), 'ctrl+shift+f');
  assert.equal(normalizeCombo('esc'), 'escape');
  assert.equal(normalizeCombo('shift+up'), 'shift+arrowup');
  assert.equal(normalizeCombo('+'), '+');
  assert.equal(normalizeCombo('ctrl++'), 'ctrl++');
  assert.equal(normalizeCombo('ctrl+shift+,'), 'ctrl+shift+,');
});

test('comboFromEvent: shift is dropped only where it is part of the character', () => {
  assert.equal(comboFromEvent({ key: 'H', shiftKey: true, code: 'KeyH' }), 'shift+h');
  assert.equal(comboFromEvent({ key: '>', shiftKey: true, code: 'Period' }), '>');
  assert.equal(comboFromEvent({ key: 'Tab', shiftKey: true }), 'shift+tab');
  // with ctrl held, punctuation comes from the physical key (e.key differs by platform/layout)
  assert.equal(comboFromEvent({ key: '≤', altKey: true, code: 'Comma' }), 'alt+,');
  assert.equal(comboFromEvent({ key: ';', ctrlKey: true, code: 'Semicolon' }), 'ctrl+;');
  assert.equal(comboFromEvent({ key: 'Enter', ctrlKey: true, shiftKey: true }), 'ctrl+shift+enter');
});

test('Keymap ignores key-less (synthetic) and IME-composition events', () => {
  const km = new Keymap();
  let n = 0;
  km.set('tab', () => {
    n++;
    return false;
  });
  assert.equal(km.dispatch({ key: 'Tab' }), true);
  assert.equal(km.dispatch({ key: 'Tab', isComposing: true }), false);
  assert.equal(km.dispatch({ key: 'Tab', keyCode: 229 }), false);
  assert.equal(km.dispatch({}), false);
  assert.equal(n, 1);
  // returning anything but false lets the key through
  km.set('enter', () => true);
  assert.equal(km.dispatch({ key: 'Enter' }), false);
});

function stubEditor({ popupActive = false, multiLine = false } = {}) {
  const calls = [];
  const popup = {
    isActive: () => popupActive,
    shift: (f) => calls.push(['shift', f]),
    reset: () => calls.push(['reset']),
    byNumber: (n) => calls.push(['byNumber', n]),
    bySymbol: (s) => (calls.push(['bySymbol', s]), s === '>'),
    enter: () => (calls.push(['enter']), multiLine),
  };
  return {
    calls,
    ed: {
      insertText: (t) => calls.push(['insertText', t]),
      tab: () => calls.push(['tab']),
      focus: () => calls.push(['focus']),
      focusBelow: () => calls.push(['focusBelow']),
      lineBracketing: () => calls.push(['lineBracketing']),
      popup,
      leave: (go) => (calls.push(['leave']), go()),
      isConnected: () => true,
    },
  };
}

function setup(opts, pageOpen = true) {
  const actions = [];
  const reg = createShortcuts({
    random: () => actions.push('random'),
    home: () => actions.push('home'),
    newPage: () => actions.push('newPage'),
    pin: () => (actions.push('pin'), pageOpen),
    duplicate: () => (actions.push('dup'), pageOpen),
    deletePage: () => (actions.push('del'), pageOpen),
  });
  const s = stubEditor(opts);
  reg.setEditor(s.ed);
  return { reg, actions, ...s };
}

test('every default binding names an existing handler', () => {
  for (const table of Object.values(DEFAULT_BINDINGS)) {
    for (const name of Object.values(table)) assert.ok(HANDLER_NAMES.includes(name), name);
  }
});

test('Tab: highlights the next popup button, else inserts one space', () => {
  let t = setup({ popupActive: true });
  assert.equal(t.reg.dispatch('edit', { key: 'Tab' }), true);
  assert.deepEqual(t.calls, [['shift', true]]);
  t = setup({ popupActive: false });
  assert.equal(t.reg.dispatch('edit', { key: 'Tab' }), true);
  assert.deepEqual(t.calls, [['tab']]);
});

test('Shift+Tab goes back in the popup, and is left to the editor otherwise', () => {
  let t = setup({ popupActive: true });
  assert.equal(t.reg.dispatch('edit', { key: 'Tab', shiftKey: true }), true);
  assert.deepEqual(t.calls, [['shift', false]]);
  t = setup({ popupActive: false });
  assert.equal(t.reg.dispatch('edit', { key: 'Tab', shiftKey: true }), false);
  assert.deepEqual(t.calls, []);
});

test('Enter: used only when the popup has something to run', () => {
  assert.equal(setup({ popupActive: true, multiLine: true }).reg.dispatch('edit', { key: 'Enter' }), true);
  assert.equal(setup({ popupActive: true, multiLine: false }).reg.dispatch('edit', { key: 'Enter' }), false);
});

test('digits and symbols only act while the popup is up (and a symbol with no button types normally)', () => {
  let t = setup({ popupActive: true });
  assert.equal(t.reg.dispatch('edit', { key: '3' }), true);
  assert.deepEqual(t.calls, [['byNumber', 3]]);
  assert.equal(t.reg.dispatch('edit', { key: '>', shiftKey: true, code: 'Period' }), true);
  assert.equal(t.reg.dispatch('edit', { key: '+', shiftKey: true, code: 'Semicolon' }), false);
  t = setup({ popupActive: false });
  assert.equal(t.reg.dispatch('edit', { key: '3' }), false);
  assert.equal(t.reg.dispatch('edit', { key: '>' }), false);
  assert.deepEqual(t.calls, []);
});

test('text-inserting defaults', () => {
  const t = setup();
  t.reg.dispatch('edit', { key: 'q', ctrlKey: true, code: 'KeyQ' });
  t.reg.dispatch('edit', { key: 'Enter', ctrlKey: true });
  t.reg.dispatch('edit', { key: ';', ctrlKey: true, code: 'Semicolon' });
  t.reg.dispatch('edit', { key: 'Enter', ctrlKey: true, shiftKey: true });
  assert.deepEqual(t.calls, [
    ['insertText', 'code:ㅤ\n '],
    ['insertText', '['],
    ['insertText', '\t'],
    ['lineBracketing'],
  ]);
});

test('browse keys: o / i act on the editor, home / new / random on the app', () => {
  const t = setup();
  assert.equal(t.reg.dispatch('browse', { key: 'o' }), true);
  assert.equal(t.reg.dispatch('browse', { key: 'i' }), true);
  assert.equal(t.reg.dispatch('browse', { key: 'H', shiftKey: true, code: 'KeyH' }), true);
  assert.equal(t.reg.dispatch('browse', { key: 'N', shiftKey: true, code: 'KeyN' }), true);
  assert.equal(t.reg.dispatch('browse', { key: 'q', altKey: true, code: 'KeyQ' }), true);
  assert.deepEqual(t.calls, [['focusBelow'], ['focus'], ['leave']]);
  assert.deepEqual(t.actions, ['home', 'newPage', 'random']);
  // ctrl/meta + o stays the browser's
  assert.equal(t.reg.dispatch('browse', { key: 'o', ctrlKey: true, code: 'KeyO' }), false);
});

test('o / i with no live editor (e.g. the list page) are not swallowed', () => {
  const reg = createShortcuts({ random() {}, home() {}, newPage() {}, pin: () => false, duplicate: () => false, deletePage: () => false });
  assert.equal(reg.dispatch('browse', { key: 'o' }), false);
  const t = setup();
  t.ed.isConnected = () => false; // page re-rendered, editor gone
  assert.equal(t.reg.dispatch('browse', { key: 'i' }), false);
});

test('a binding added through onEditin replaces the default for the same combo', () => {
  const t = setup({ popupActive: false });
  let hit = 0;
  t.reg.onEditin('Tab', () => (hit++, false)); // different spelling, same combo
  assert.equal(t.reg.dispatch('edit', { key: 'Tab' }), true);
  assert.equal(hit, 1);
  assert.deepEqual(t.calls, []);
  t.reg.clear('edit');
  assert.equal(t.reg.dispatch('edit', { key: 'Tab' }), false);
});

test('alt+p pins the page; with no saved page the key is not swallowed', () => {
  let t = setup({}, true);
  assert.equal(t.reg.dispatch('edit', { key: 'π', altKey: true, code: 'KeyP' }), true);
  assert.deepEqual(t.actions, ['pin']);
  t = setup({}, false);
  assert.equal(t.reg.dispatch('edit', { key: 'π', altKey: true, code: 'KeyP' }), false);
});

test('dup / del handlers (bound by the UserScript, not by default) follow the same rule', () => {
  let t = setup({}, true);
  assert.equal(t.reg.handlers.dup({}), false);
  assert.equal(t.reg.handlers.del({}), false);
  assert.deepEqual(t.actions, ['dup', 'del']);
  t = setup({}, false);
  assert.equal(t.reg.handlers.dup({}), true);
});

test('leave saves the editor first, and just runs when there is no live editor', () => {
  const t = setup();
  let ran = 0;
  t.reg.leave(() => ran++);
  assert.deepEqual(t.calls, [['leave']]);
  assert.equal(ran, 1);
  const bare = createShortcuts({ random() {}, home() {}, newPage() {}, pin: () => false, duplicate: () => false, deletePage: () => false });
  bare.leave(() => ran++);
  assert.equal(ran, 2);
});
