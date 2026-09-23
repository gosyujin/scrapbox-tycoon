// IndexedDB-backed store for a "reference project": a read-only snapshot
// imported from a real Scrapbox project's own export JSON (Settings ->
// Export -> JSON on scrapbox.io). Kept completely separate from the
// editable notes (local-store.ts / github-sync-store.ts) -- this data is
// never edited or pushed anywhere, only viewed. IndexedDB instead of
// localStorage because a long-running real Scrapbox project's export can
// run tens of MB, well past localStorage's practical ~5-10MB limit.
const DB_NAME = 'scrapbox_tycoon_reference_v1';
const PAGES_STORE = 'pages';
const META_STORE = 'meta';

export interface ReferencePage {
  title: string;
  lines: string[];
  created: number;
  updated: number;
  views: number;
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

  const db = await openDb();
  const tx = db.transaction([PAGES_STORE, META_STORE], 'readwrite');
  const pagesStore = tx.objectStore(PAGES_STORE);
  pagesStore.clear();
  let count = 0;
  for (const p of rawPages) {
    const title = p.title || (p.lines && normalizeLines(p.lines, '')[0]) || 'Untitled';
    const page: ReferencePage = {
      title,
      lines: normalizeLines(p.lines, title),
      created: p.created ?? now,
      updated: p.updated ?? now,
      views: p.views ?? 0,
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
  updated: number;
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

export async function listPages(limit: number): Promise<{ summaries: ReferenceSummary[]; total: number }> {
  const all = await scanAll();
  all.sort((a, b) => b.updated - a.updated);
  return { summaries: all.slice(0, limit).map((p) => ({ title: p.title, updated: p.updated })), total: all.length };
}

// Naive substring match across title + body.
export async function searchPages(query: string, limit: number): Promise<{ summaries: ReferenceSummary[]; total: number }> {
  const q = query.trim().toLowerCase();
  if (!q) return listPages(limit);
  const all = await scanAll();
  const hits = all.filter((p) => (p.title + '\n' + p.lines.join('\n')).toLowerCase().includes(q));
  hits.sort((a, b) => b.updated - a.updated);
  return { summaries: hits.slice(0, limit).map((p) => ({ title: p.title, updated: p.updated })), total: hits.length };
}

export async function getBacklinks(title: string, extractLinks: (line: string) => string[]): Promise<string[]> {
  const all = await scanAll();
  const hits: string[] = [];
  for (const p of all) {
    if (p.title === title) continue;
    if (p.lines.some((line) => extractLinks(line).includes(title))) hits.push(p.title);
  }
  return hits;
}
