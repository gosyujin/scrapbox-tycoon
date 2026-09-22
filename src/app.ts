import { LocalStore } from './store/local-store.js';
import { GitHubSyncStore } from './store/github-sync-store.js';
import { Editor } from './editor.js';
import { extractLinks } from './parser.js';
import { parseScrapboxExport, buildScrapboxExport } from './scrapbox-format.js';
import type { Page, Store, SyncCapable, SyncStatus } from './types.js';

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
const backendBadge = document.getElementById('backend-badge') as HTMLElement;

function describeSyncStatus(s: SyncStatus): string {
  if (s.state === 'syncing') return '同期中...';
  if (s.state === 'error') return `同期エラー: ${s.lastError}`;
  if (s.dirtyCount > 0) return `未同期の変更: ${s.dirtyCount}件`;
  return '同期済み';
}

function updateBadge(): void {
  if (isSyncCapable(store)) {
    backendBadge.textContent = `GitHub: ${settings.owner}/${settings.repo}@${settings.branch} — ${describeSyncStatus(store.getSyncStatus())}`;
  } else {
    backendBadge.textContent = 'Local (this browser only)';
  }
}

function wireStoreStatus(): void {
  if (isSyncCapable(store)) {
    store.onSyncStatusChange(() => updateBadge());
  }
}
wireStoreStatus();

function navigate(hash: string): void {
  location.hash = hash;
}

async function route(): Promise<void> {
  const hash = location.hash || '#/';
  updateBadge();

  if (hash === '#/' || hash === '') {
    await renderPageList();
  } else if (hash === '#/settings') {
    renderSettings();
  } else if (hash.startsWith('#/page/')) {
    const title = decodeURIComponent(hash.slice('#/page/'.length));
    await renderPage(title);
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
      <input id="quick-open" class="quick-open" placeholder="ページを開く/作成 (Enter)" />
      <nav>
        <a href="#/">一覧</a>
        <a href="#/settings">設定</a>
      </nav>
    </div>`;
}

function wireQuickOpen(): void {
  const input = document.getElementById('quick-open') as HTMLInputElement;
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
}

async function renderPageList(): Promise<void> {
  const pages = await store.listPages();
  app.innerHTML = `
    ${topBar()}
    <div class="content">
      <h1>ページ一覧 (${pages.length})</h1>
      <ul class="page-list">
        ${
          pages
            .map(
              (p) =>
                `<li><a href="#/page/${encodeURIComponent(p.title)}">${escapeHtml(p.title)}</a>
              <span class="muted">${new Date(p.updated * 1000).toLocaleString()}</span></li>`
            )
            .join('') || '<li class="muted">まだページがありません。上の入力欄から作成してください。</li>'
        }
      </ul>
    </div>`;
  wireQuickOpen();
}

async function renderPage(title: string): Promise<void> {
  const existing = await store.getPage(title);
  const isNew = !existing;
  const page: Page = existing || { title, lines: [title], created: 0, updated: 0 };

  app.innerHTML = `
    ${topBar()}
    <div class="content page-content">
      ${isNew ? '<p class="muted">新規ページ（最初の行を編集すると保存されます）</p>' : ''}
      <div id="editor"></div>
      <section class="linked">
        <h3 id="linked-heading">逆リンク</h3>
        <ul id="backlinks" class="muted">読み込み中...</ul>
      </section>
    </div>`;
  wireQuickOpen();

  // Saves go straight to localStorage (instant, no network), so there is no
  // need to serialize/queue them here — GitHubSyncStore buffers and pushes
  // them to GitHub on its own schedule (see src/store/github-sync-store.ts).
  let currentTitle = title;
  let existsLocally = !isNew;

  const editorEl = document.getElementById('editor') as HTMLElement;
  new Editor({
    container: editorEl,
    lines: page.lines,
    onChange: async (lines) => {
      const newTitle = lines[0] || currentTitle;
      await store.savePage({ title: newTitle, lines });
      if (newTitle !== currentTitle) {
        if (existsLocally) await store.deletePage(currentTitle);
        currentTitle = newTitle;
        history.replaceState(null, '', `#/page/${encodeURIComponent(newTitle)}`);
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
  const hits: string[] = [];
  for (const { title: t } of all) {
    if (t === title) continue;
    const p = await store.getPage(t);
    if (!p) continue;
    const linked = p.lines.some((line) => extractLinks(line).includes(title));
    if (linked) hits.push(t);
  }
  headingEl.textContent = `逆リンク (${hits.length})`;
  listEl.className = '';
  listEl.innerHTML =
    hits.map((t) => `<li><a href="#/page/${encodeURIComponent(t)}">${escapeHtml(t)}</a></li>`).join('') ||
    '<li class="muted">なし</li>';
}

function renderSettings(): void {
  const syncSection = isSyncCapable(store)
    ? `<p class="muted" id="sync-status-line">${escapeHtml(describeSyncStatus(store.getSyncStatus()))}</p>
       <button id="sync-now">今すぐ同期</button>`
    : '';

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
    el.textContent = `build: ${info.shortSha} (${built})`;
  } catch {
    el.textContent = 'build: (dev / unknown)';
  }
}

void route();
void loadBuildInfo();
