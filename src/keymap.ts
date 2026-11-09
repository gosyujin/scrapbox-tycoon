// Key-combo strings ('ctrl+shift+f', 'tab', 'shift+up', '+') and the per-context
// lookup tables behind them. DOM-free so it can be tested in node.
//
// This is a port of ScrapboxShortcutKey's own key handling (the UserScript
// at https://github.com/gosyujin/scrapbox-shortcutkey) on purpose: the
// combos that script registers through window.tycoonShortcut.bind() have to
// normalise to exactly the same strings as the ones in shortcuts.ts, or an
// override would add a second binding instead of replacing the default one.
// Keep the two in step -- see docs/decisions/14-scrapboxshortcutkey-integration.md.

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};
const CODE_TO_KEY: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

// The part of a KeyboardEvent the lookup needs (so tests can pass plain objects).
export interface KeyEventLike {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

// 'Shift+Ctrl+F' -> 'ctrl+shift+f' (modifiers in a fixed order).
export function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split('+');
  let key = parts.pop() ?? '';
  if (key === '') {
    key = '+'; // the '+' key itself ('+', 'ctrl++')
    parts.pop();
  }
  return [...MODIFIERS.filter((m) => parts.includes(m)), KEY_ALIASES[key] ?? key].join('+');
}

// With a modifier held, e.key depends on the platform (Mac's option+a is 'å',
// shift+, is '<'), so punctuation is read from the physical key (e.code).
function physicalKey(e: KeyEventLike): string | undefined {
  const code = e.code ?? '';
  return CODE_TO_KEY[code] ?? /^(?:Key|Digit)(.)$/.exec(code)?.[1]?.toLowerCase();
}

export function comboFromEvent(e: KeyEventLike): string {
  const hasMod = !!(e.ctrlKey || e.altKey || e.metaKey);
  let key = (e.key ?? '').toLowerCase();
  if (hasMod && key.length === 1 && !/[a-z0-9]/.test(key)) key = physicalKey(e) ?? key;
  // Where shift is part of the character itself ('?' or '>'), ignore it;
  // shift+h, shift+tab, ctrl+shift+, ... stay distinct.
  const shiftIsPartOfChar = !hasMod && key.length === 1 && !/[a-z0-9]/.test(key);
  const active = { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey && !shiftIsPartOfChar, meta: !!e.metaKey };
  return [...MODIFIERS.filter((m) => active[m]), key].join('+');
}

// A synthetic event without a key, or one produced mid-IME-composition
// (keyCode 229), must never trigger a binding.
export const isIgnorableKeyEvent = (e: KeyEventLike): boolean => !e.key || !!e.isComposing || e.keyCode === 229;

// Return false to swallow the key (preventDefault + stopPropagation by the
// caller); anything else lets it through. Same convention as the UserScript.
export type KeyHandler = (e: KeyboardEvent) => boolean | void;

export class Keymap {
  private map = new Map<string, KeyHandler>();

  set(combo: string, handler: KeyHandler): void {
    this.map.set(normalizeCombo(combo), handler);
  }

  delete(combo: string): void {
    this.map.delete(normalizeCombo(combo));
  }

  clear(): void {
    this.map.clear();
  }

  // The handler bound to this event's combo, unless the event must be ignored.
  find(e: KeyEventLike): KeyHandler | undefined {
    if (isIgnorableKeyEvent(e)) return undefined;
    return this.map.get(comboFromEvent(e));
  }

  // Runs the matching handler. Returns true when the key was swallowed
  // (the caller then stops the event).
  dispatch(e: KeyboardEvent): boolean {
    const handler = this.find(e);
    return !!handler && handler(e) === false;
  }
}
