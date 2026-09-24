import { LocalStore } from './store/local-store.js';
import { GitHubSyncStore } from './store/github-sync-store.js';
import { Editor } from './editor.js';
import { extractLinks, renderLinesInto } from './parser.js';
import { parseScrapboxExport, buildScrapboxExport } from './scrapbox-format.js';
import {
  importExport as importReferenceExport,
  clearAll as clearReference,
  getMeta as getReferenceMeta,
  getPage as getReferencePage,
  listPages as listReferencePages,
  searchPages as searchReferencePages,
  getBacklinks as getReferenceBacklinksRaw,
  getAllTitlesLowercased as getReferenceTitles,
  getAllTitles as getAllReferenceTitles,
  type SortKey as ReferenceSortKey,
} from './store/reference-store.js';
import { makeVisitTracker } from './visit-tracking.js';
import { matchQuery } from './search.js';
import type { Page, Store, SyncCapable, SyncStatus } from './types.js';

function getReferenceBacklinks(title: string): Promise<{ title: string; description: string }[]> {
  return getReferenceBacklinksRaw(title, extractLinks);
}

// Device-local only (see visit-tracking.ts) -- separate namespaces so a
// title that happens to exist in both the editable notes and the
// reference project doesn't share stats between the two.
const noteVisits = makeVisitTracker('scrapbox_tycoon_visits_v1');
const refVisits = makeVisitTracker('scrapbox_tycoon_ref_visits_v1');

type NoteSortKey = 'modified' | 'created' | 'lastVisited' | 'linked' | 'viewed' | 'title';
const NOTE_SORT_LABELS: Record<NoteSortKey, string> = {
  modified: 'Modified',
  created: 'Created',
  lastVisited: 'Last visited',
  linked: 'Most linked',
  viewed: 'Most viewed',
  title: 'Title',
};
const REF_SORT_LABELS: Record<ReferenceSortKey, string> = {
  modified: 'Modified',
  created: 'Created',
  lastVisited: 'Last visited',
  linked: 'Most linked',
  viewed: 'Most viewed',
  title: 'Title',
};

function sortSelectHtml(id: string, labels: Record<string, string>, current: string): string {
  const options = Object.entries(labels)
    .map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  return `<select id="${id}" class="sort-select">${options}</select>`;
}

// Remembers the last-picked sort choice across reloads (localStorage,
// device-local like the visit stats above). Validated against the current
// label set so a stale value from a removed sort option (e.g. the old
// "Modified in Cache") falls back to the default instead of silently
// breaking.
function loadSort<T extends string>(key: string, labels: Record<T, string>, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && Object.prototype.hasOwnProperty.call(labels, v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveSort(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sort choice just won't persist -- not worth surfacing an error for */
  }
}

const SETTINGS_KEY = 'scrapbox_tycoon_settings_v1';

interface Settings {
  backend: 'local' | 'github';
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

function loadSettings(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let settings: Settings = { backend: 'local', owner: '', repo: '', branch: 'main', token: '', ...loadSettings() };

function isSyncCapable(s: Store): s is Store & SyncCapable {
  return typeof (s as Partial<SyncCapable>).syncNow === 'function';
}

function makeStore(): Store {
  if (settings.backend === 'github' && settings.owner && settings.repo && settings.token) {
    return new GitHubSyncStore(settings);
  }
  return new LocalStore();
}

let store: Store = makeStore();

const app = document.getElementById('app') as HTMLElement;
const syncStatusEl = document.getElementById('sync-status') as HTMLElement;

function describeSyncStatus(s: SyncStatus): string {
  if (s.state === 'syncing') return '同期中...';
  if (s.state === 'error') return `同期エラー: ${s.lastError}`;
  if (s.dirtyCount > 0) return `未同期の変更: ${s.dirtyCount}件`;
  return '同期済み';
}

// Text for the badge shown inline at the top of the notes list (see
// renderPageList) -- unlike sync status, this only ever changes via the
// settings page's own save-and-navigate-away flow, so it's read fresh into
// each render rather than kept updated in place like syncStatusEl below.
function backendBadgeLabel(): string {
  return isSyncCapable(store) ? `${settings.owner}/${settings.repo}@${settings.branch}` : 'Local (this browser only)';
}

function updateBadge(): void {
  if (isSyncCapable(store)) {
    syncStatusEl.textContent = describeSyncStatus(store.getSyncStatus());
    syncStatusEl.style.display = '';
  } else {
    syncStatusEl.textContent = '';
    syncStatusEl.style.display = 'none';
  }
}

function wireStoreStatus(): void {
  if (isSyncCapable(store)) {
    store.onSyncStatusChange((s) => {
      updateBadge();
      // A change made on another device (e.g. the source page of a merge
      // being deleted) only reaches this tab's local copy via a pull, which
      // otherwise only runs when this tab makes its own edit. Once one
      // completes, refresh the list if that's what's on screen -- it has no
      // in-progress edit that a refresh could clobber, unlike a page view.
      if (s.state === 'idle' && (location.hash === '' || location.hash === '#/')) {
        void renderPageList();
      }
    });
  }
}
wireStoreStatus();

// Coming back to a backgrounded tab/PWA is exactly when the on-screen data
// is most likely stale (another device may have changed things in the
// meantime), so re-sync right away instead of waiting for this tab's own
// next edit.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isSyncCapable(store)) {
    void store.syncNow().catch(() => {
      /* status line already reflects the error */
    });
  }
});

// Settings saved in another tab/window (e.g. a backgrounded PWA instance)
// only reach this one as a 'storage' event -- without this, that other
// instance keeps its old GitHubSyncStore alive with the old owner/repo/token
// baked in, and can push a later edit to the wrong repo whenever its
// debounce/retry timer next fires.
window.addEventListener('storage', (e) => {
  if (e.key !== SETTINGS_KEY) return;
  settings = { backend: 'local', owner: '', repo: '', branch: 'main', token: '', ...loadSettings() };
  if (isSyncCapable(store)) store.dispose();
  store = makeStore();
  wireStoreStatus();
  updateBadge();
});

function navigate(hash: string): void {
  location.hash = hash;
}

async function route(): Promise<void> {
  const hash = location.hash || '#/';
  updateBadge();

  if (hash === '#/' || hash === '') {
    await renderPageList();
  } else if (hash === '#/settings') {
    await renderSettings();
  } else if (hash.startsWith('#/page/')) {
    const title = decodeURIComponent(hash.slice('#/page/'.length));
    await renderPage(title);
  } else if (hash === '#/ref' || hash === '#/ref/') {
    await renderReferenceList();
  } else if (hash.startsWith('#/ref/')) {
    const title = decodeURIComponent(hash.slice('#/ref/'.length));
    await renderReferencePage(title);
  } else {
    app.innerHTML = '<p>Not found</p>';
  }
}

window.addEventListener('hashchange', () => {
  void route();
});

function topBar(): string {
  return `
    <div class="topbar">
      <a href="#/" class="brand">scrapbox-tycoon</a>
      <div class="quick-open-row">
        <button id="quick-add" class="quick-add" title="ページを追加" aria-label="ページを追加">+</button>
        <input id="quick-open" class="quick-open" placeholder="開く/作成 (Enter) ・ 一覧では検索にも使えます" />
      </div>
      <nav>
        <button id="random-btn" class="nav-btn" type="button" title="ランダム" aria-label="ランダム">🔀</button>
        <a href="#/settings" title="設定" aria-label="設定">⚙️</a>
      </nav>
    </div>`;
}

// Picks a random page from the reference project and jumps straight to it
// -- ported from scrapbox-pwa-viewer's random-page button, which this
// replaces the header's old "参照" link with (the reference list itself is
// still reachable from the home page's reference section). One retry if
// the pick happens to be the page already open, so the button doesn't
// visibly do nothing on a lucky/unlucky repeat.
async function goToRandomReferencePage(): Promise<void> {
  const titles = await getAllReferenceTitles();
  if (titles.length === 0) return;
  const currentTitle =
    location.hash.startsWith('#/ref/') ? decodeURIComponent(location.hash.slice('#/ref/'.length)) : null;
  let pick = titles[Math.floor(Math.random() * titles.length)]!;
  if (titles.length > 1 && pick === currentTitle) {
    pick = titles[Math.floor(Math.random() * titles.length)]!;
  }
  navigate(`#/ref/${encodeURIComponent(pick)}`);
}

function wireQuickOpen(): void {
  const input = document.getElementById('quick-open') as HTMLInputElement;
  const addBtn = document.getElementById('quick-add') as HTMLButtonElement;
  document.getElementById('random-btn')!.addEventListener('click', () => {
    void goToRandomReferencePage();
  });
  let composing = false;
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
  });
  input.addEventListener('keydown', (e) => {
    if (composing || e.isComposing) return;
    if (e.key === 'Enter' && input.value.trim()) {
      navigate(`#/page/${encodeURIComponent(input.value.trim())}`);
    }
  });
  // Matches Scrapbox: a title in the box opens/creates that page, empty
  // goes to a blank new-page screen (renderPage treats "" as just another
  // not-yet-existing title, so this needs no special case beyond that).
  addBtn.addEventListener('click', () => {
    navigate(`#/page/${encodeURIComponent(input.value.trim())}`);
  });
}

// Debounces search-as-you-type without breaking IME composition. An
// 'input' event fires on every intermediate kana/kanji candidate while
// composing (e.g. typing "korona" toward "コロナ"); if that were allowed to
// trigger a DOM-replacing render after the usual pause-based debounce, the
// browser force-commits whatever partial conversion was on screen at that
// moment, because destroying/recreating the focused element ends
// composition -- which looked like every keystroke committing immediately
// instead of letting IME conversion happen. Only 'compositionend' (the
// conversion is actually confirmed) or an ordinary, non-IME 'input' is
// allowed to schedule a search.
function wireDebouncedSearch(input: HTMLInputElement, onSearch: (query: string) => void, delayMs = 250): void {
  let composing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    clearTimeout(timer);
    const value = input.value;
    timer = setTimeout(() => {
      // A result link, or Enter opening/creating an exact-titled note, can
      // navigate away before this fires; without this check that stale
      // render would clobber whatever page we're now on.
      if (!document.body.contains(input)) return;
      onSearch(value);
    }, delayMs);
  };

  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    schedule();
  });
  input.addEventListener('input', (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    schedule();
  });
}

const HOME_REF_LIMIT = 30;

const NOTE_SORT_KEY = 'scrapbox_tycoon_note_sort_v1';
const REF_SORT_KEY = 'scrapbox_tycoon_ref_sort_v1';

let homeNoteSort: NoteSortKey = loadSort(NOTE_SORT_KEY, NOTE_SORT_LABELS, 'modified');
// Shared between the home page's reference section and #/ref's own list --
// both sort the same underlying data, so one remembered choice applies to
// both rather than tracking them independently.
let refSort: ReferenceSortKey = loadSort(REF_SORT_KEY, REF_SORT_LABELS, 'modified');

interface NoteRow {
  title: string;
  description: string;
  created: number;
  updated: number;
}

// The card preview text: everything but the title line (lines[0]), blank
// lines dropped but real line breaks between the rest kept (.page-card-desc
// is white-space: pre-line) -- CSS does the actual clipping to however much
// fits in a card, this just avoids handing it megabytes of full page text
// to lay out and then throw away.
function pageDescription(lines: string[]): string {
  return lines
    .slice(1)
    .filter((l) => l.trim() !== '')
    .join('\n')
    .slice(0, 300);
}

async function loadNoteRows(query: string): Promise<NoteRow[]> {
  const summaries = await store.listPages();
  const rows: NoteRow[] = [];
  for (const s of summaries) {
    const full = await store.getPage(s.title);
    if (!full) continue;
    if (!matchQuery(full.lines.join('\n'), query)) continue;
    rows.push({ title: full.title, description: pageDescription(full.lines), created: full.created, updated: full.updated });
  }
  return rows;
}

// Shared by the notes list, the home page's reference section, and #/ref's
// full list -- Scrapbox-style square cards (title + as much body text as
// fits) instead of a plain link-per-row list.
function pageCardsHtml(items: { title: string; description: string }[], linkBase: string, emptyMessage: string): string {
  if (items.length === 0) return `<p>${escapeHtml(emptyMessage)}</p>`;
  const cards = items
    .map(
      (p) => `
      <a class="page-card" href="${linkBase}${encodeURIComponent(p.title)}">
        <div class="page-card-title">${escapeHtml(p.title)}</div>
        <div class="page-card-desc">${escapeHtml(p.description)}</div>
      </a>`
    )
    .join('');
  return `<div class="page-cards">${cards}</div>`;
}

// One full-content pass tallying how many *other* notes link to each note
// -- cheap enough for a personal note set to just recompute on demand
// rather than maintaining a persistent index (contrast reference-store's
// precomputed linkedCount, needed there because the reference project can
// run into the thousands of pages).
async function computeNoteLinkCounts(): Promise<Map<string, number>> {
  const summaries = await store.listPages();
  const counts = new Map<string, number>();
  for (const { title } of summaries) counts.set(title.toLowerCase(), 0);
  for (const { title } of summaries) {
    const page = await store.getPage(title);
    if (!page) continue;
    const seen = new Set<string>();
    for (const line of page.lines) {
      for (const link of extractLinks(line)) {
        const key = link.toLowerCase();
        if (key === title.toLowerCase() || !counts.has(key) || seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function compareNoteRows(sort: NoteSortKey, linkCounts: Map<string, number> | null): (a: NoteRow, b: NoteRow) => number {
  switch (sort) {
    case 'created':
      return (a, b) => b.created - a.created;
    case 'title':
      return (a, b) => a.title.localeCompare(b.title);
    case 'lastVisited':
      return (a, b) => noteVisits.getStats(b.title).lastVisited - noteVisits.getStats(a.title).lastVisited;
    case 'viewed':
      return (a, b) => noteVisits.getStats(b.title).views - noteVisits.getStats(a.title).views;
    case 'linked':
      return (a, b) => (linkCounts?.get(b.title.toLowerCase()) ?? 0) - (linkCounts?.get(a.title.toLowerCase()) ?? 0);
    case 'modified':
    default:
      return (a, b) => b.updated - a.updated;
  }
}

async function renderPageList(query = ''): Promise<void> {
  // Only a debounced re-render triggered by typing in #quick-open should
  // restore focus/caret afterward -- app.innerHTML below destroys the old
  // input, so this has to be captured before that happens. A plain
  // navigation to #/ should not steal focus and pop the keyboard.
  const hadFocus = (document.activeElement as HTMLElement | null)?.id === 'quick-open';

  let rows = await loadNoteRows(query);
  const linkCounts = homeNoteSort === 'linked' ? await computeNoteLinkCounts() : null;
  rows = rows.slice().sort(compareNoteRows(homeNoteSort, linkCounts));

  const refMeta = await getReferenceMeta();
  let refSection = '';
  if (refMeta) {
    const getVisitedAt = (title: string) => refVisits.getStats(title).lastVisited;
    const { summaries, total } = query
      ? await searchReferencePages(query, HOME_REF_LIMIT, refSort, getVisitedAt)
      : await listReferencePages(HOME_REF_LIMIT, refSort, getVisitedAt);
    const moreNote =
      total > summaries.length ? `<p>先頭${summaries.length}件のみ表示中（全${total}件）。<a href="#/ref">参照一覧</a>で続きを検索できます。</p>` : '';
    refSection = `
      <section class="home-ref-section">
        <div class="sort-bar">
          <span>${escapeHtml(refMeta.projectName)}</span>
          <span>${total} pages</span>
          ${sortSelectHtml('home-ref-sort', REF_SORT_LABELS, refSort)}
        </div>
        ${pageCardsHtml(summaries, '#/ref/', '一致するページがありません。')}
        ${moreNote}
      </section>`;
  }

  app.innerHTML = `
    ${topBar()}
    <div class="content">
      <div class="sort-bar">
        <span id="backend-badge" class="backend-badge">${escapeHtml(backendBadgeLabel())}</span>
        <span>${rows.length} pages</span>
        ${sortSelectHtml('home-note-sort', NOTE_SORT_LABELS, homeNoteSort)}
      </div>
      ${pageCardsHtml(rows, '#/page/', query ? '一致するページがありません。' : 'まだページがありません。上の入力欄から作成してください。')}
      ${refSection}
    </div>`;
  wireQuickOpen();

  const input = document.getElementById('quick-open') as HTMLInputElement;
  input.value = query;
  wireDebouncedSearch(input, (nextQuery) => void renderPageList(nextQuery));
  if (hadFocus) {
    input.focus();
    input.setSelectionRange(query.length, query.length);
  }

  document.getElementById('home-note-sort')?.addEventListener('change', (e) => {
    homeNoteSort = (e.target as HTMLSelectElement).value as NoteSortKey;
    saveSort(NOTE_SORT_KEY, homeNoteSort);
    void renderPageList(query);
  });
  document.getElementById('home-ref-sort')?.addEventListener('change', (e) => {
    refSort = (e.target as HTMLSelectElement).value as ReferenceSortKey;
    saveSort(REF_SORT_KEY, refSort);
    void renderPageList(query);
  });
}

// Scrapbox's own behavior when a rename collides with an existing page: ask
// whether to merge, and if not, keep both by suffixing _2 (_3, ... if that
// is *also* taken) rather than silently overwriting the existing page.
async function uniqueTitle(base: string): Promise<string> {
  let n = 2;
  while (await store.getPage(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

async function renderPage(title: string): Promise<void> {
  const existing = await store.getPage(title);
  const isNew = !existing;
  const page: Page = existing || { title, lines: [title], created: 0, updated: 0 };
  if (!isNew) noteVisits.recordVisit(title);

  const mergeBanner = page.mergeCandidate
    ? `<div class="merge-banner">
         <span>"${escapeHtml(page.mergeCandidate)}" と同じタイトルになったため別ページとして保存されています。</span>
         <button id="merge-now">統合する</button>
         <button id="merge-dismiss" class="secondary">この提案を消す</button>
       </div>`
    : '';

  // Notes and the reference project are separate namespaces (see the
  // fallback comment on Editor's knownTitles below), so having the same
  // title in both is entirely possible -- just easy to not notice, since
  // opening this note never otherwise surfaces the reference page. Purely
  // informational: the reference page stays reachable either way.
  const referenceTitles = await getReferenceTitles();
  const refDuplicateBanner = referenceTitles.has(title.toLowerCase())
    ? `<p class="ref-banner">参照プロジェクトにも同名タイトル "${escapeHtml(title)}" のページがあります。
         <a href="#/ref/${encodeURIComponent(title)}">参照ページを見る →</a></p>`
    : '';

  app.innerHTML = `
    ${topBar()}
    <div class="content page-content">
      ${isNew ? '<p class="muted">新規ページ（最初の行を編集すると保存されます）</p>' : ''}
      ${mergeBanner}
      ${refDuplicateBanner}
      <div id="editor"></div>
      <section class="linked">
        <h3 id="linked-heading">逆リンク</h3>
        <div id="backlinks">読み込み中...</div>
      </section>
    </div>`;
  wireQuickOpen();

  if (page.mergeCandidate) {
    const targetTitle = page.mergeCandidate;
    document.getElementById('merge-now')!.addEventListener('click', async () => {
      const target = await store.getPage(targetTitle);
      if (target) {
        const separator = target.lines[target.lines.length - 1] === '' ? [] : [''];
        const mergedLines = [...target.lines, ...separator, ...page.lines.slice(1)];
        await store.savePage({ title: targetTitle, lines: mergedLines });
        await store.deletePage(title);
        navigate(`#/page/${encodeURIComponent(targetTitle)}`);
      } else {
        // The target page is gone (deleted meanwhile) -> nothing to merge into.
        await store.savePage({ title, lines: page.lines, mergeCandidate: null });
        await renderPage(title);
      }
    });
    document.getElementById('merge-dismiss')!.addEventListener('click', async () => {
      await store.savePage({ title, lines: page.lines, mergeCandidate: null });
      await renderPage(title);
    });
  }

  // Saves go straight to localStorage (instant, no network), so there is no
  // need to serialize/queue them here — GitHubSyncStore buffers and pushes
  // them to GitHub on its own schedule (see src/store/github-sync-store.ts).
  //
  // A title collision is never resolved inline here: seizing control with a
  // blocking prompt mid-edit, and mutating `lines` to someone else's merged
  // content behind the Editor's back, left its own in-memory state stale —
  // a further edit before navigating away would silently overwrite the
  // merge. Instead, on a collision this page is just saved under a free
  // "_N" title (never destroying the existing page) and tagged with
  // mergeCandidate, surfaced above as a banner the user can act on
  // whenever they choose — see the merge-now handler above, which merges
  // and navigates away immediately, so there is no stale Editor to worry
  // about.
  let currentTitle = title;
  let existsLocally = !isNew;

  const knownTitles = new Set((await store.listPages()).map((p) => p.title.toLowerCase()));

  const editorEl = document.getElementById('editor') as HTMLElement;
  new Editor({
    container: editorEl,
    lines: page.lines,
    knownTitles,
    fallback: { linkBase: '#/ref/', knownTitles: referenceTitles },
    onExtractPage: async (extractedTitle, extractedLines) => {
      // Never overwrite an existing page -- selecting text that happens to
      // match an existing title should just link to it, same as Scrapbox.
      if (!(await store.getPage(extractedTitle))) {
        await store.savePage({ title: extractedTitle, lines: extractedLines });
      }
    },
    onChange: async (lines) => {
      let newTitle = lines[0] || currentTitle;
      let mergeCandidate: string | undefined;

      if (newTitle !== currentTitle) {
        const collision = await store.getPage(newTitle);
        if (collision) {
          mergeCandidate = newTitle;
          newTitle = await uniqueTitle(newTitle);
          lines = [newTitle, ...lines.slice(1)];
        }
      }

      await store.savePage({ title: newTitle, lines, ...(mergeCandidate ? { mergeCandidate } : {}) });

      if (newTitle !== currentTitle) {
        if (existsLocally) await store.deletePage(currentTitle);
        history.replaceState(null, '', `#/page/${encodeURIComponent(newTitle)}`);
        // Rebuild the page from what was actually saved rather than just
        // updating the URL: on a collision, the saved title/content
        // (deduped to "_N") differs from what was typed, and this Editor
        // instance's own state still holds the pre-dedupe version — an
        // in-place update would leave the view showing stale content until
        // a full reload.
        await renderPage(newTitle);
        return;
      }
      existsLocally = true;
    },
  });

  await renderBacklinks(title);
}

async function renderBacklinks(title: string): Promise<void> {
  const listEl = document.getElementById('backlinks') as HTMLElement;
  const headingEl = document.getElementById('linked-heading') as HTMLElement;
  const all = await store.listPages();
  const hits: { title: string; description: string }[] = [];
  for (const { title: t } of all) {
    if (t === title) continue;
    const p = await store.getPage(t);
    if (!p) continue;
    const linked = p.lines.some((line) => extractLinks(line).includes(title));
    if (linked) hits.push({ title: t, description: pageDescription(p.lines) });
  }
  headingEl.textContent = `逆リンク (${hits.length})`;
  listEl.innerHTML = pageCardsHtml(hits, '#/page/', 'なし');
}

const REFERENCE_LIST_LIMIT = 200;

function referenceBanner(meta: { projectName: string; importedAt: number }): string {
  return `<p class="ref-banner">読み取り専用: ${escapeHtml(meta.projectName)} のスナップショット（${new Date(
    meta.importedAt * 1000
  ).toLocaleString()}時点）</p>`;
}

// Search lives on the home page now (one box covering notes + reference
// together) -- this view is just the sorted full list, with its own sort
// control for browsing beyond the home page's capped preview.
async function renderReferenceList(): Promise<void> {
  const meta = await getReferenceMeta();
  if (!meta) {
    app.innerHTML = `
      ${topBar()}
      <div class="content">
        <h1>参照プロジェクト</h1>
        <p class="muted">まだインポートされていません。設定画面からScrapboxのエクスポートJSONを読み込んでください。</p>
      </div>`;
    wireQuickOpen();
    return;
  }

  const getVisitedAt = (title: string) => refVisits.getStats(title).lastVisited;
  const { summaries, total } = await listReferencePages(REFERENCE_LIST_LIMIT, refSort, getVisitedAt);
  const truncatedNote =
    total > summaries.length ? `<p>先頭${summaries.length}件のみ表示中（全${total}件）。ホームの検索で絞り込めます。</p>` : '';

  app.innerHTML = `
    ${topBar()}
    <div class="content">
      ${referenceBanner(meta)}
      <div class="sort-bar">
        <span>${escapeHtml(meta.projectName)}</span>
        <span>${total} pages</span>
        ${sortSelectHtml('ref-list-sort', REF_SORT_LABELS, refSort)}
      </div>
      ${truncatedNote}
      ${pageCardsHtml(summaries, '#/ref/', '一致するページがありません。')}
    </div>`;
  wireQuickOpen();

  document.getElementById('ref-list-sort')?.addEventListener('change', (e) => {
    refSort = (e.target as HTMLSelectElement).value as ReferenceSortKey;
    saveSort(REF_SORT_KEY, refSort);
    void renderReferenceList();
  });
}

async function renderReferencePage(title: string): Promise<void> {
  const meta = await getReferenceMeta();
  const page = meta ? await getReferencePage(title) : null;

  if (!meta || !page) {
    app.innerHTML = `
      ${topBar()}
      <div class="content">
        <p class="muted">${meta ? `ページが見つかりません: ${escapeHtml(title)}` : '参照プロジェクトが未インポートです。'}</p>
        <p><a href="#/ref">参照一覧に戻る</a></p>
      </div>`;
    wireQuickOpen();
    return;
  }
  refVisits.recordVisit(title);

  app.innerHTML = `
    ${topBar()}
    <div class="content page-content">
      ${referenceBanner(meta)}
      <div id="ref-view"></div>
      <section class="linked">
        <h3 id="ref-linked-heading">逆リンク</h3>
        <div id="ref-backlinks">読み込み中...</div>
      </section>
    </div>`;
  wireQuickOpen();

  const viewEl = document.getElementById('ref-view') as HTMLElement;
  const knownTitles = await getReferenceTitles();
  renderLinesInto(viewEl, page.lines, { linkBase: '#/ref/', knownTitles });

  const hits = await getReferenceBacklinks(title);
  const headingEl = document.getElementById('ref-linked-heading') as HTMLElement;
  const listEl = document.getElementById('ref-backlinks') as HTMLElement;
  headingEl.textContent = `逆リンク (${hits.length})`;
  listEl.innerHTML = pageCardsHtml(hits, '#/ref/', 'なし');
}

async function renderSettings(): Promise<void> {
  const syncSection = isSyncCapable(store)
    ? `<p class="muted" id="sync-status-line">${escapeHtml(describeSyncStatus(store.getSyncStatus()))}</p>
       <button id="sync-now">今すぐ同期</button>
       <button id="cleanup-orphans-btn" class="secondary">同期先の孤立ページを確認して削除</button>
       <p id="cleanup-status" class="muted"></p>`
    : '';

  const refMeta = await getReferenceMeta();
  const refStatus = refMeta
    ? `${escapeHtml(refMeta.projectName)} / ${refMeta.pageCount}ページ / ${new Date(refMeta.importedAt * 1000).toLocaleString()}時点`
    : '未インポートです';

  app.innerHTML = `
    ${topBar()}
    <div class="content settings">
      <h1>設定</h1>
      <label><input type="radio" name="backend" value="local" ${settings.backend === 'local' ? 'checked' : ''}> ローカル（このブラウザのみ・すぐ試せる）</label>
      <label><input type="radio" name="backend" value="github" ${settings.backend === 'github' ? 'checked' : ''}> GitHub リポジトリ（複数端末・永続化）</label>

      <div class="github-fields">
        <label>Owner <input id="gh-owner" value="${escapeAttr(settings.owner)}" placeholder="your-github-username"></label>
        <label>Repo <input id="gh-repo" value="${escapeAttr(settings.repo)}" placeholder="my-notes"></label>
        <label>Branch <input id="gh-branch" value="${escapeAttr(settings.branch)}" placeholder="main"></label>
        <label>Fine-grained PAT (Contents: read/write, repo限定) <input id="gh-token" type="password" value="${escapeAttr(settings.token)}"></label>
        <p class="muted">トークンはこのブラウザの localStorage にのみ保存され、GitHub API 以外には送信されません。編集は常にこのブラウザに即座に保存され、GitHubへは数秒後または「今すぐ同期」でまとめて送られます。</p>
        ${syncSection}
      </div>

      <button id="save-settings">保存</button>

      <hr>
      <h2>インポート / エクスポート（Scrapbox JSON）</h2>
      <label>Scrapboxからエクスポートした .json を読み込む <input id="import-file" type="file" accept="application/json"></label>
      <button id="export-btn">現在のページを Scrapbox JSON としてダウンロード</button>
      <p id="io-status" class="muted"></p>

      <hr>
      <h2>参照プロジェクト（Scrapboxエクスポートの読み取り専用スナップショット）</h2>
      <p class="muted">
        自分で編集するノートとは別に、実際に運用しているScrapboxプロジェクトのエクスポートJSONを
        丸ごと取り込んでオフラインで閲覧できます（このブラウザの中だけに保存され、どこにも送信・同期されません）。
        再インポートすると前のスナップショットは置き換わります。
      </p>
      <p id="ref-status" class="muted">${refStatus}</p>
      <label>Scrapboxからエクスポートした .json を読み込む <input id="ref-import-file" type="file" accept="application/json"></label>
      ${refMeta ? '<button id="ref-clear-btn" class="secondary">参照データを削除</button>' : ''}
      <p id="ref-io-status" class="muted"></p>
    </div>`;
  wireQuickOpen();

  if (isSyncCapable(store)) {
    const syncStore = store;
    const statusLine = document.getElementById('sync-status-line') as HTMLElement;
    syncStore.onSyncStatusChange((s) => {
      statusLine.textContent = describeSyncStatus(s);
    });
    document.getElementById('sync-now')!.addEventListener('click', () => {
      void syncStore.syncNow().catch(() => {
        /* status line already reflects the error */
      });
    });

    document.getElementById('cleanup-orphans-btn')!.addEventListener('click', async () => {
      const status = document.getElementById('cleanup-status') as HTMLElement;
      status.textContent = '確認中...';
      try {
        const orphans = await syncStore.listOrphanedRemotePages();
        if (orphans.length === 0) {
          status.textContent = '孤立ページはありませんでした。';
          return;
        }
        const ok = confirm(
          `このブラウザには存在しない ${orphans.length} 件のページが同期先に残っています:\n\n${orphans.join('\n')}\n\n削除しますか？（他の端末でまだ未同期の変更がある場合、そのページも消えます）`
        );
        if (!ok) {
          status.textContent = 'キャンセルしました。';
          return;
        }
        status.textContent = '削除中...';
        await syncStore.deleteOrphanedRemotePages(orphans);
        status.textContent = `${orphans.length} 件のページを同期先から削除しました。`;
      } catch (err) {
        status.textContent = `失敗: ${(err as Error).message}`;
      }
    });
  }

  document.getElementById('save-settings')!.addEventListener('click', () => {
    const backendInput = document.querySelector<HTMLInputElement>('input[name=backend]:checked')!;
    settings = {
      backend: backendInput.value as Settings['backend'],
      owner: (document.getElementById('gh-owner') as HTMLInputElement).value.trim(),
      repo: (document.getElementById('gh-repo') as HTMLInputElement).value.trim(),
      branch: (document.getElementById('gh-branch') as HTMLInputElement).value.trim() || 'main',
      token: (document.getElementById('gh-token') as HTMLInputElement).value.trim(),
    };
    saveSettings(settings);
    if (isSyncCapable(store)) store.dispose();
    store = makeStore();
    wireStoreStatus();
    updateBadge();
    navigate('#/');
  });

  document.getElementById('import-file')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const status = document.getElementById('io-status') as HTMLElement;
    try {
      const text = await file.text();
      const pages = parseScrapboxExport(text);
      status.textContent = `${pages.length} ページを読み込み中...`;
      for (const p of pages) await store.savePage(p);
      status.textContent = `${pages.length} ページを取り込みました。`;
    } catch (err) {
      status.textContent = `失敗: ${(err as Error).message}`;
    }
  });

  document.getElementById('export-btn')!.addEventListener('click', async () => {
    const list = await store.listPages();
    const pages: Page[] = [];
    for (const { title } of list) {
      const p = await store.getPage(title);
      if (p) pages.push(p);
    }
    const json = buildScrapboxExport(pages, settings.repo || 'scrapbox-tycoon');
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${json.name}.json`;
    a.click();
  });

  document.getElementById('ref-import-file')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const status = document.getElementById('ref-io-status') as HTMLElement;
    status.textContent = '読み込み中...（ページ数が多いと数秒かかります）';
    try {
      const text = await file.text();
      const meta = await importReferenceExport(text);
      status.textContent = `${meta.pageCount}ページを取り込みました。`;
      await renderSettings();
    } catch (err) {
      status.textContent = `失敗: ${(err as Error).message}`;
    }
  });

  document.getElementById('ref-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('参照プロジェクトのスナップショットを削除します。よろしいですか？')) return;
    await clearReference();
    await renderSettings();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s || '').replace(/"/g, '&quot;');
}

interface BuildInfo {
  shortSha: string;
  builtAt: string;
}

async function loadBuildInfo(): Promise<void> {
  const el = document.getElementById('build-info') as HTMLElement | null;
  if (!el) return;
  try {
    const res = await fetch('./build-info.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const info: BuildInfo = await res.json();
    const built = new Date(info.builtAt).toLocaleString();
    el.textContent = `${info.shortSha} (${built})`;
  } catch {
    el.textContent = '(dev / unknown)';
  }
}

void route();
void loadBuildInfo();

// Lets the app shell (this file, css/style.css, index.html) load with no
// network at all after the first successful visit -- see sw.js for what it
// caches and why. Registration failing (unsupported browser, dev server
// quirks) should never block the app itself.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support just won't be available; nothing else to do */
    });
  });
}
