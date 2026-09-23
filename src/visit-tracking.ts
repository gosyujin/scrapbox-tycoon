// Device-local page-visit stats (last-visited time, view count) for sort
// options that real Scrapbox either derives server-side (view count) or
// from browsing history an export can't carry at all (last-visited) --
// ported from scrapbox-pwa-viewer's equivalent tracking. Two independent
// trackers are used (editable notes vs. the read-only reference project)
// since a title could collide between them and their stats shouldn't mix.
export interface VisitStats {
  lastVisited: number;
  views: number;
}

export interface VisitTracker {
  recordVisit(title: string): void;
  getStats(title: string): VisitStats;
}

const EMPTY: VisitStats = { lastVisited: 0, views: 0 };

export function makeVisitTracker(storageKey: string): VisitTracker {
  function readAll(): Record<string, VisitStats> {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}');
    } catch {
      return {};
    }
  }

  const cache = readAll();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persist(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(cache));
      } catch {
        /* storage full or unavailable -- visit stats are a nice-to-have, not worth surfacing an error for */
      }
    }, 300);
  }

  return {
    recordVisit(title: string): void {
      const key = title.toLowerCase();
      const existing = cache[key] ?? EMPTY;
      cache[key] = { lastVisited: Date.now(), views: existing.views + 1 };
      persist();
    },
    getStats(title: string): VisitStats {
      return cache[title.toLowerCase()] ?? EMPTY;
    },
  };
}
