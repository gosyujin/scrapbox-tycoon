// Keyboard shortcuts in the style of ScrapboxShortcutKey (the author's
// TamperMonkey UserScript for scrapbox.io), built into the app so they work
// with or without that script installed.
//
//   browse  -- focus is not in a text field (document keydown)
//   search  -- focus is in the quick-open box
//   edit    -- focus is in the page editor (cm-editor/index.ts routes keydown here)
//
// Contexts, combo strings and the "return false to swallow the key" convention
// are the UserScript's own, on purpose: with the script installed it registers
// ITS key table through window.tycoonShortcut (onBrowse / onSearch / onEditin,
// the same names as its window.scrapboxShortcut) and names the handlers below as
// the implementation, so a key change made in the UserScript takes effect here
// without touching this repo. The defaults in DEFAULT_BINDINGS mirror its
// current table and are what runs when the script is absent.
// See docs/decisions/14-scrapboxshortcutkey-integration.md.
import { Keymap, type KeyHandler } from './keymap.js';

export type ShortcutContext = 'browse' | 'search' | 'edit';

// The selection popup, as the keyboard sees it (cm-editor/popup.ts).
export interface PopupApi {
  isActive(): boolean;
  shift(forward: boolean): void; // move the highlight to the next / previous button
  reset(): void;
  byNumber(n: number): void; // press the n-th button (0 = 10th)
  bySymbol(symbol: string): boolean; // true when a button was pressed
  enter(): boolean; // true when the key was used (highlighted button / extract)
}

// What the keyboard handlers need from the live editor (cm-editor/index.ts).
export interface EditorApi {
  insertText(text: string): void; // as if typed (so `[` still auto-closes)
  tab(): void; // the Tab key with no popup: one space (a tab character inside a table row)
  focus(): void; // back into the editor at the last caret position
  focusBelow(): void; // ... on a new line below that caret
  lineBracketing(): void; // wrap the whole current line in [ ]
  popup: PopupApi;
  leave(go: () => void): void; // save unsaved edits, then go
  isConnected(): boolean; // false once the page was re-rendered and this editor thrown away
}

// The app's own page-level actions, injected by app.ts.
export interface AppActions {
  random(): void;
  home(): void;
  newPage(): void;
  // Page-menu items (pin / duplicate / delete) of the page on screen. Return
  // false when there is no such page (list view, a not-yet-saved new page),
  // so the key is not swallowed.
  pin(): boolean;
  duplicate(): boolean;
  deletePage(): boolean;
}

export interface ShortcutRegistry {
  // The editor of the page on screen (each page render makes a new one).
  setEditor(editor: EditorApi | null): void;
  dispatch(context: ShortcutContext, e: KeyboardEvent): boolean;
  // The implementation of every named handler, for the UserScript to bind
  // its own key table to.
  handlers: Record<HandlerName, KeyHandler>;
  insertText(text: string): void;
  // Saves unsaved edits in the editor (if any), then runs `go`.
  leave(go: () => void): void;
  onBrowse(combo: string, handler: KeyHandler): void;
  onSearch(combo: string, handler: KeyHandler): void;
  onEditin(combo: string, handler: KeyHandler): void;
  // Drops the built-in defaults of one context (or all), for a caller that
  // supplies a complete key table of its own.
  clear(context?: ShortcutContext): void;
}

export const HANDLER_NAMES = [
  'inputFocus',
  'inputFocusBelowCursor',
  'lineBracketing',
  'popupTab',
  'popupShiftTab',
  'popupEnter',
  'popupByNumber',
  'popupBySymbol',
  'resetPopupCursor',
  'random',
  'home',
  'newPage',
  'pin',
  'dup',
  'del',
] as const;
export type HandlerName = (typeof HANDLER_NAMES)[number];

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
// Keys that press a popup button directly when the popup is up.
const POPUP_SYMBOLS = ['>', '"', '+', '.', ';', '~', '#'];
const RESET_POPUP_KEYS = ['esc', 'shift+up', 'shift+down', 'shift+left', 'shift+right', 'shift+home', 'shift+end'];

// combo -> handler name, per context. Mirrors the keybindings table of
// ScrapboxShortcutKey v23 for the operations that exist in this app (no pin /
// duplicate / ChatGPT / permalink / related-pages here).
export const DEFAULT_BINDINGS: Record<ShortcutContext, Record<string, HandlerName>> = {
  browse: {
    o: 'inputFocusBelowCursor',
    i: 'inputFocus',
    'shift+h': 'home',
    'shift+n': 'newPage',
    'alt+q': 'random',
    'ctrl+1': 'random',
  },
  search: {},
  edit: {
    'ctrl+shift+enter': 'lineBracketing',
    'ctrl+1': 'random',
    'alt+q': 'random',
    'alt+p': 'pin',
    ...Object.fromEntries(RESET_POPUP_KEYS.map((k) => [k, 'resetPopupCursor' as const])),
    ...Object.fromEntries(DIGITS.map((k) => [k, 'popupByNumber' as const])),
    ...Object.fromEntries(POPUP_SYMBOLS.map((k) => [k, 'popupBySymbol' as const])),
    enter: 'popupEnter',
    tab: 'popupTab',
    'shift+tab': 'popupShiftTab',
  },
};

// Text-inserting defaults (ctrl+q, ctrl+enter, ctrl+;) take an argument, so
// they are not in the name table above.
const DEFAULT_INSERTS: Record<string, string> = {
  'ctrl+q': 'code:ㅤ\n ', // U+3164 HANGUL FILLER as the code block's file name, as in the UserScript
  'ctrl+enter': '[',
  'ctrl+;': '\t',
};

export function createShortcuts(actions: AppActions): ShortcutRegistry {
  const keymaps: Record<ShortcutContext, Keymap> = { browse: new Keymap(), search: new Keymap(), edit: new Keymap() };
  let current: EditorApi | null = null;
  // The live editor, if the page it belongs to is still on screen.
  const live = (): EditorApi | null => (current?.isConnected() ? current : null);

  // Every handler returns false when the key was used (swallow it) and true
  // when it was not, so the browser / CodeMirror default still runs.
  const needsEditor = (run: (ed: EditorApi) => boolean): KeyHandler => () => {
    const ed = live();
    return ed ? run(ed) : true;
  };
  const handlers: Record<HandlerName, KeyHandler> = {
    inputFocus: needsEditor((ed) => (ed.focus(), false)),
    inputFocusBelowCursor: needsEditor((ed) => (ed.focusBelow(), false)),
    lineBracketing: needsEditor((ed) => (ed.lineBracketing(), false)),
    popupTab: needsEditor((ed) => {
      if (ed.popup.isActive()) ed.popup.shift(true);
      else ed.tab();
      return false;
    }),
    // Without a popup Shift+Tab stays the editor's own outdent.
    popupShiftTab: needsEditor((ed) => {
      if (!ed.popup.isActive()) return true;
      ed.popup.shift(false);
      return false;
    }),
    popupEnter: needsEditor((ed) => !ed.popup.enter()),
    popupByNumber: (e) => {
      const ed = live();
      if (!ed?.popup.isActive()) return true;
      ed.popup.byNumber(Number(e.key));
      return false;
    },
    popupBySymbol: (e) => {
      const ed = live();
      if (!ed?.popup.isActive()) return true;
      return !ed.popup.bySymbol(e.key);
    },
    resetPopupCursor: () => {
      live()?.popup.reset();
    },
    random: () => {
      leave(actions.random);
      return false;
    },
    home: () => (actions.home(), false),
    newPage: () => (actions.newPage(), false),
    // true = no page to act on, so the key falls through.
    pin: () => !actions.pin(),
    dup: () => !actions.duplicate(),
    del: () => !actions.deletePage(),
  };

  const insertText = (text: string): void => live()?.insertText(text);
  const leave = (go: () => void): void => {
    const ed = live();
    if (ed) ed.leave(go);
    else go();
  };

  const reg: ShortcutRegistry = {
    setEditor: (ed) => {
      current = ed;
    },
    dispatch: (context, e) => keymaps[context].dispatch(e),
    handlers,
    insertText,
    leave,
    onBrowse: (combo, handler) => keymaps.browse.set(combo, handler),
    onSearch: (combo, handler) => keymaps.search.set(combo, handler),
    onEditin: (combo, handler) => keymaps.edit.set(combo, handler),
    clear: (context) => {
      for (const c of context ? [context] : (['browse', 'search', 'edit'] as const)) keymaps[c].clear();
    },
  };

  for (const [context, table] of Object.entries(DEFAULT_BINDINGS) as [ShortcutContext, Record<string, HandlerName>][]) {
    for (const [combo, name] of Object.entries(table)) keymaps[context].set(combo, handlers[name]);
  }
  for (const [combo, text] of Object.entries(DEFAULT_INSERTS)) {
    keymaps.edit.set(combo, () => {
      if (!live()) return true;
      insertText(text);
      return false;
    });
  }
  return reg;
}

const isTyping = (el: Element | null): boolean =>
  !!el && ((el as HTMLElement).isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));

// Page-wide keydown: the quick-open box -> search, anywhere that is not a text
// field -> browse. (edit is dispatched by the editor itself, with CodeMirror's
// own key handling order and IME guards.)
export function installGlobalKeys(reg: ShortcutRegistry): void {
  document.addEventListener('keydown', (e) => {
    const target = e.composedPath()[0] as Element | undefined;
    let context: ShortcutContext | null = null;
    if (target?.id === 'quick-open') context = 'search';
    else if (!isTyping(target ?? null)) context = 'browse';
    if (context && reg.dispatch(context, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

// window.tycoonShortcut, the entry point for the UserScript. The event covers
// the case that the script is already waiting when this runs.
export function exposeShortcuts(reg: ShortcutRegistry): void {
  const api = {
    version: 1,
    handlers: reg.handlers,
    insertText: reg.insertText,
    onBrowse: reg.onBrowse,
    onSearch: reg.onSearch,
    onEditin: reg.onEditin,
    clear: reg.clear,
  };
  (window as unknown as { tycoonShortcut: unknown }).tycoonShortcut = api;
  window.dispatchEvent(new CustomEvent('tycoon-shortcut-ready'));
}
