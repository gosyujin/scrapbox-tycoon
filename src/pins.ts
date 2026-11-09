// Pinned pages ("ピン留め", Scrapbox's page-menu item): shown first on the
// notes list. Kept on this device only (localStorage), NOT in the Page record:
// a pin is not page content, and putting it in the record would need the sync
// layer (no-op-save check, pull's "same content" test, 3-way merge, push CAS)
// to learn about it. See docs/decisions/15-page-menu-pin-duplicate.md.
//
// Keys are lower-cased titles, like visit-tracking.ts and the link matching
// everywhere else. The value is when the page was pinned (ms): the most
// recently pinned page comes first.
export interface PinStore {
  isPinned(title: string): boolean;
  // Returns the new state (true = now pinned).
  toggle(title: string): boolean;
  unpin(title: string): void;
  // A renamed page keeps its pin.
  rename(oldTitle: string, newTitle: string): void;
  // Orders pinned pages before the rest; a sort of rows by `title`, stable for
  // equal rows (the caller's own order inside each group is kept).
  floatPinned<T extends { title: string }>(rows: T[]): T[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function makePinStore(storageKey: string, storage: StorageLike | undefined = globalThis.localStorage): PinStore {
  const read = (): Record<string, number> => {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(storageKey) || '{}');
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  };
  const write = (pins: Record<string, number>): void => {
    try {
      storage?.setItem(storageKey, JSON.stringify(pins));
    } catch {
      /* storage full or unavailable -- a pin is a convenience, not worth an error */
    }
  };

  return {
    isPinned: (title) => read()[title.toLowerCase()] !== undefined,
    toggle(title) {
      const pins = read();
      const key = title.toLowerCase();
      const now = pins[key] === undefined;
      if (now) pins[key] = Date.now();
      else delete pins[key];
      write(pins);
      return now;
    },
    unpin(title) {
      const pins = read();
      if (delete pins[title.toLowerCase()]) write(pins);
    },
    rename(oldTitle, newTitle) {
      const pins = read();
      const from = oldTitle.toLowerCase();
      const at = pins[from];
      if (at === undefined || from === newTitle.toLowerCase()) return;
      delete pins[from];
      pins[newTitle.toLowerCase()] = at;
      write(pins);
    },
    floatPinned(rows) {
      const pins = read();
      const at = (r: { title: string }): number => pins[r.title.toLowerCase()] ?? 0;
      // Array.prototype.sort is stable: equal (both unpinned) keep their order.
      return rows.slice().sort((a, b) => at(b) - at(a));
    },
  };
}
