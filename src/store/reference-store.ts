// IndexedDB-backed store for a "reference project": a read-only snapshot
// imported from a real Scrapbox project's own export JSON (Settings ->
// Export -> JSON on scrapbox.io). Kept completely separate from the
// editable notes (local-store.ts / github-sync-store.ts) -- this data is
// never edited or pushed anywhere, only viewed. IndexedDB instead of
// localStorage because a long-running real Scrapbox project's export can
// run tens of MB, well past localStorage's practical ~5-10MB limit.
import { matchQuery } from '../search.js';

const DB_NAME = 'scrapbox_tycoon_reference_v1';
const PAGES_STORE = 'pages';
const META_STORE = 'meta';

export interface ReferencePage {
  title: string;
  lines: string[];
  created: number;
  updated: number;
  views: number;
  // How many other pages in this same snapshot link to this one.
  // Precomputed at import time from the export's linksLc field (mirrors
  // scrapbox-pwa-viewer's build-time backlink pass) rather than scanning
  // all ~10k pages' content on every "Most linked" sort.
  linkedCount: number;
}

export interface ReferenceMeta {
  projectName: string;
  importedAt: number;
  pageCount: number;
}

interface RawLine {
  text?: string;
}
interface RawPage {
  title?: string;
  lines?: (string | RawLine)[];
  created?: number;
  updated?: number;
  views?: number;
  linksLc?: string[];
}
interface RawExport {
  name?: string;
  displayName?: string;
  pages?: RawPage[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PAGES_STORE)) db.createObjectStore(PAGES_STORE, { keyPath: 'title' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqResult<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function normalizeLines(lines: (string | RawLine)[] | undefined, title: string): string[] {
  const ls = (lines || []).map((l) => (typeof l === 'string' ? l : l.text || ''));
  return ls.length ? ls : [title];
}

// Replaces any previously-imported snapshot wholesale -- this is a
// snapshot, not something merged incrementally.
export async function importExport(json: string): Promise<ReferenceMeta> {
  const data = JSON.parse(json) as RawExport;
  const rawPages = data.pages || [];
  const now = Math.floor(Date.now() / 1000);

  const titles = rawPages.map((p, i) => p.title || (p.lines && normalizeLines(p.lines, '')[0]) || `Untitled${i}`);
  const knownLc = new Set(titles.map((t) => t.toLowerCase()));
  // Only counts a link toward "Most linked" when its target is an actual
  // page in this same snapshot -- matches build.py's backlink pass, which
  // looks the target up in title_to_page rather than counting every raw
  // linksLc entry.
  const linkedCount = new Map<string, number>();
  for (const p of rawPages) {
    const seen = new Set<string>();
    for (const lc of p.linksLc || []) {
      if (!knownLc.has(lc) || seen.has(lc)) continue;
      seen.add(lc);
      linkedCount.set(lc, (linkedCount.get(lc) ?? 0) + 1);
    }
  }

  const db = await openDb();
  const tx = db.transaction([PAGES_STORE, META_STORE], 'readwrite');
  const pagesStore = tx.objectStore(PAGES_STORE);
  pagesStore.clear();
  let count = 0;
  for (let i = 0; i < rawPages.length; i++) {
    const p = rawPages[i]!;
    const title = titles[i]!;
    const page: ReferencePage = {
      title,
      lines: normalizeLines(p.lines, title),
      created: p.created ?? now,
      updated: p.updated ?? now,
      views: p.views ?? 0,
      linkedCount: linkedCount.get(title.toLowerCase()) ?? 0,
    };
    pagesStore.put(page);
    count++;
  }
  const meta: ReferenceMeta = {
    projectName: data.displayName || data.name || 'reference',
    importedAt: now,
    pageCount: count,
  };
  tx.objectStore(META_STORE).put(meta, 'meta');
  await txDone(tx);
  db.close();
  return meta;
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([PAGES_STORE, META_STORE], 'readwrite');
  tx.objectStore(PAGES_STORE).clear();
  tx.objectStore(META_STORE).clear();
  await txDone(tx);
  db.close();
}

export async function getMeta(): Promise<ReferenceMeta | null> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readonly');
  const meta = await reqResult<ReferenceMeta | undefined>(tx.objectStore(META_STORE).get('meta'));
  db.close();
  return meta ?? null;
}

export async function getPage(title: string): Promise<ReferencePage | null> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readonly');
  const page = await reqResult<ReferencePage | undefined>(tx.objectStore(PAGES_STORE).get(title));
  db.close();
  return page ?? null;
}

export interface ReferenceSummary {
  title: string;
  description: string;
  updated: number;
  created: number;
  views: number;
  linkedCount: number;
}

// The card preview text: everything but the title line, blank lines
// dropped but real line breaks between the rest kept (see .page-card-desc's
// white-space: pre-line) -- CSS clips it to however much fits.
function pageDescription(lines: string[]): string {
  return lines
    .slice(1)
    .filter((l) => l.trim() !== '')
    .join('\n')
    .slice(0, 300);
}

export type SortKey = 'modified' | 'created' | 'linked' | 'viewed' | 'title' | 'lastVisited';

// "lastVisited" has no field on ReferencePage -- it's purely device-local
// (see visit-tracking.ts) -- so its value is looked up through
// getVisitedAt rather than read off the record like the others.
function compareBy(sort: SortKey, getVisitedAt: (title: string) => number): (a: ReferencePage, b: ReferencePage) => number {
  switch (sort) {
    case 'created':
      return (a, b) => b.created - a.created;
    case 'linked':
      return (a, b) => b.linkedCount - a.linkedCount;
    case 'viewed':
      return (a, b) => b.views - a.views;
    case 'title':
      return (a, b) => a.title.localeCompare(b.title);
    case 'lastVisited':
      return (a, b) => getVisitedAt(b.title) - getVisitedAt(a.title);
    case 'modified':
    default:
      return (a, b) => b.updated - a.updated;
  }
}

function toSummary(p: ReferencePage): ReferenceSummary {
  return {
    title: p.title,
    description: pageDescription(p.lines),
    updated: p.updated,
    created: p.created,
    views: p.views,
    linkedCount: p.linkedCount,
  };
}

// A single cursor pass over every page. 10k pages / a few MB of text is
// small enough for this (and searchPages below) to run in well under a
// second in practice -- revisit with a real index only if that stops
// holding.
async function scanAll(): Promise<ReferencePage[]> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readonly');
  const store = tx.objectStore(PAGES_STORE);
  const results: ReferencePage[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push(cursor.value as ReferencePage);
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
  return results;
}

// For the link exists/missing color-coding (see parser.ts's RenderOpts) --
// getAllKeys() reads only the keyPath (title) for every record, skipping
// the full page bodies that scanAll()'s cursor would otherwise pull in.
export async function getAllTitlesLowercased(): Promise<Set<string>> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readonly');
  const keys = await reqResult<IDBValidKey[]>(tx.objectStore(PAGES_STORE).getAllKeys());
  db.close();
  return new Set(keys.map((k) => String(k).toLowerCase()));
}

// Original-cased titles (unlike getAllTitlesLowercased, which throws away
// casing for exists/missing comparison) -- for anything that needs to
// actually navigate to or display a title, e.g. the home page's "ランダム"
// button.
export async function getAllTitles(): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readonly');
  const keys = await reqResult<IDBValidKey[]>(tx.objectStore(PAGES_STORE).getAllKeys());
  db.close();
  return keys.map((k) => String(k));
}

export async function listPages(
  limit: number,
  sort: SortKey = 'modified',
  getVisitedAt: (title: string) => number = () => 0
): Promise<{ summaries: ReferenceSummary[]; total: number }> {
  const all = await scanAll();
  all.sort(compareBy(sort, getVisitedAt));
  return { summaries: all.slice(0, limit).map(toSummary), total: all.length };
}

// Naive substring match across title + body.
export async function searchPages(
  query: string,
  limit: number,
  sort: SortKey = 'modified',
  getVisitedAt: (title: string) => number = () => 0
): Promise<{ summaries: ReferenceSummary[]; total: number }> {
  if (!query.trim()) return listPages(limit, sort, getVisitedAt);
  const all = await scanAll();
  const hits = all.filter((p) => matchQuery(p.title + '\n' + p.lines.join('\n'), query));
  hits.sort(compareBy(sort, getVisitedAt));
  return { summaries: hits.slice(0, limit).map(toSummary), total: hits.length };
}

export async function getBacklinks(
  title: string,
  extractLinks: (line: string) => string[]
): Promise<{ title: string; description: string }[]> {
  const all = await scanAll();
  const hits: { title: string; description: string }[] = [];
  for (const p of all) {
    if (p.title === title) continue;
    if (p.lines.some((line) => extractLinks(line).includes(title))) hits.push({ title: p.title, description: pageDescription(p.lines) });
  }
  return hits;
}
