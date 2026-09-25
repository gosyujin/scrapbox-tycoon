// Local-first store: every edit writes straight to localStorage (instant,
// no network, no conflicts — matches "leave the line and it's saved"), and
// changes are pushed to GitHub in the background as a single batched commit
// instead of one commit per edit.
//
// This is a deliberate simplification for the tool's actual use case (one
// person, multiple devices, not many concurrent writers) — see
// GitHubStore's per-page atomic commit + retry machinery for what this
// replaces; batching one commit per *sync* instead of per *edit* removes
// almost all opportunity for the commit races that model was fighting.
//
// Sync is "local wins for what I changed, remote wins for what I didn't":
// on each sync, pages NOT in the local dirty set are refreshed from remote
// (picking up other devices' edits); pages IN the dirty set are pushed as
// they are locally, overwriting whatever is on GitHub. Editing the exact
// same page on two devices between syncs is the one case that is not
// merged — the more recent sync simply wins — acceptable for a single-user
// tool syncing every few seconds, not worth the complexity of a real
// merge/conflict UI here.
import { LocalStore } from './local-store.js';
import { GitHubStore, type GitHubStoreConfig, type PageChange } from './github-store.js';
import type { Page, PageSummary, PageInput, Store, SyncStatus, SyncCapable } from '../types.js';

const SYNC_META_KEY = 'scrapbox_tycoon_sync_meta_v1';
const AUTO_SYNC_DEBOUNCE_MS = 4000;
// A failed sync (e.g. GitHub's git/trees occasionally erroring transiently
// — see GitHubStore) would otherwise sit dirty until the next edit happens
// to trigger another attempt. Retry once on our own after a delay so a
// transient failure recovers even during a lull in editing.
const RETRY_AFTER_FAILURE_MS = 15000;

interface SyncMeta {
  dirty: string[];
  deleted: string[];
  // title -> remote `updated` as of the last successful sync; used to tell
  // whether a page changed on the remote since we last looked at it.
  lastSyncedUpdated: Record<string, number>;
}

function readMeta(): SyncMeta {
  try {
    const raw = JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}');
    return {
      dirty: Array.isArray(raw.dirty) ? raw.dirty : [],
      deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
      lastSyncedUpdated: raw.lastSyncedUpdated && typeof raw.lastSyncedUpdated === 'object' ? raw.lastSyncedUpdated : {},
    };
  } catch {
    return { dirty: [], deleted: [], lastSyncedUpdated: {} };
  }
}

function writeMeta(meta: SyncMeta): void {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
}

// A running history of setStatus() transitions -- localStorage-backed
// (not just an in-memory array on the instance) so it survives a reload
// and outlives the GitHubSyncStore instance that wrote it, since the
// whole point is catching something like "sync said 同期中 and never
// moved" after the fact, when reproducing it live on demand isn't
// practical. Capped so an old, long-forgotten stall doesn't grow this
// forever.
const SYNC_LOG_KEY = 'scrapbox_tycoon_sync_log_v1';
const SYNC_LOG_MAX_ENTRIES = 300;

interface SyncLogEntry {
  t: number; // Date.now(), not the page's own unix-seconds convention -- this needs to diff against wall-clock time for "stuck for how long".
  state: SyncStatus['state'];
  dirtyCount: number;
  lastError: string | null;
}

function readSyncLog(): SyncLogEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SYNC_LOG_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function appendSyncLog(entry: SyncLogEntry): void {
  const log = readSyncLog();
  log.push(entry);
  if (log.length > SYNC_LOG_MAX_ENTRIES) log.splice(0, log.length - SYNC_LOG_MAX_ENTRIES);
  localStorage.setItem(SYNC_LOG_KEY, JSON.stringify(log));
}

export class GitHubSyncStore implements Store, SyncCapable {
  private local = new LocalStore();
  private remote: GitHubStore;
  private meta: SyncMeta;
  private status: SyncStatus;
  private listeners = new Set<(status: SyncStatus) => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private syncPromise: Promise<void> | null = null;
  private disposed = false;
  private retryScheduled = false;

  constructor(config: GitHubStoreConfig) {
    this.remote = new GitHubStore(config);
    this.meta = readMeta();
    this.status = {
      state: 'idle',
      dirtyCount: this.meta.dirty.length + this.meta.deleted.length,
      lastSyncedAt: null,
      lastError: null,
    };
    // Pick up any changes made on other devices since we were last open.
    this.scheduleSync(0);
  }

  async listPages(): Promise<PageSummary[]> {
    return this.local.listPages();
  }

  async getPage(title: string): Promise<Page | null> {
    return this.local.getPage(title);
  }

  async savePage(page: PageInput): Promise<void> {
    await this.local.savePage(page);
    this.markDirty(page.title);
    this.scheduleSync();
  }

  async deletePage(title: string): Promise<void> {
    await this.local.deletePage(title);
    this.markDeleted(title);
    this.scheduleSync();
  }

  async renamePage(oldTitle: string, newTitle: string): Promise<void> {
    await this.local.renamePage(oldTitle, newTitle);
    this.markDeleted(oldTitle);
    this.markDirty(newTitle);
    this.scheduleSync();
  }

  getSyncStatus(): SyncStatus {
    return this.status;
  }

  onSyncStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async syncNow(): Promise<void> {
    if (this.disposed) return;
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  // Stops this instance's background sync. Without this, replacing `store`
  // with a fresh instance (e.g. re-saving settings) leaves the old
  // instance's debounce timer alive — setTimeout holds its own reference to
  // the closure regardless of whether anything else still points at the
  // instance — so it fires later and can race a newer instance's sync,
  // repeatedly bouncing the branch out from under each other's commits.
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.debounceTimer);
  }

  async listOrphanedRemotePages(): Promise<string[]> {
    // Settle any pending local edits first -- a page that's simply mid-sync
    // (dirty locally, not yet pushed) would otherwise briefly look
    // "orphaned" on the remote the wrong way around.
    await this.syncNow();
    const localTitles = new Set((await this.local.listPages()).map((p) => p.title));
    const remoteEntries = await this.remote.listPages();
    return remoteEntries.map((e) => e.title).filter((t) => !localTitles.has(t));
  }

  // Pushes a direct deletion for exactly the given titles, bypassing the
  // local dirty/deleted queue -- there's nothing to mark dirty for a page
  // this device never had locally to begin with. One-off maintenance for
  // pages a past sync bug could leave stranded on the remote forever (see
  // push()'s comment); not part of the normal edit path.
  async deleteOrphanedRemotePages(titles: string[]): Promise<void> {
    if (titles.length === 0) return;
    await this.remote.pushBatch(
      titles.map((title) => ({ title, lines: null })),
      `cleanup: remove ${titles.length} orphaned remote page(s)`
    );
    for (const title of titles) delete this.meta.lastSyncedUpdated[title];
    writeMeta(this.meta);
  }

  private markDirty(title: string): void {
    if (!this.meta.dirty.includes(title)) this.meta.dirty.push(title);
    this.meta.deleted = this.meta.deleted.filter((t) => t !== title);
    writeMeta(this.meta);
    this.setStatus({ dirtyCount: this.meta.dirty.length + this.meta.deleted.length });
  }

  private markDeleted(title: string): void {
    this.meta.dirty = this.meta.dirty.filter((t) => t !== title);
    if (!this.meta.deleted.includes(title)) this.meta.deleted.push(title);
    writeMeta(this.meta);
    this.setStatus({ dirtyCount: this.meta.dirty.length + this.meta.deleted.length });
  }

  private scheduleSync(delayMs: number = AUTO_SYNC_DEBOUNCE_MS): void {
    if (this.disposed) return;
    clearTimeout(this.debounceTimer);
    // runSync() already records the failure (status + the retry-after-
    // failure timer below) before re-throwing -- that re-throw is for a
    // direct awaiter like syncNow() or listOrphanedRemotePages() to react
    // to, which nothing does here, so an uncaught one would otherwise
    // surface as a raw "Uncaught (in promise)" console error on every
    // transient/conflicting sync failure even though it's already handled.
    this.debounceTimer = setTimeout(() => void this.syncNow().catch(() => {}), delayMs);
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    appendSyncLog({
      t: Date.now(),
      state: this.status.state,
      dirtyCount: this.status.dirtyCount,
      lastError: this.status.lastError,
    });
    for (const listener of this.listeners) listener(this.status);
  }

  getStatusLogText(): string {
    const log = readSyncLog();
    if (log.length === 0) return '(記録なし)';
    return log
      .map((e) => {
        const time = new Date(e.t).toLocaleString();
        const err = e.lastError ? ` error=${e.lastError}` : '';
        return `${time}  state=${e.state} dirty=${e.dirtyCount}${err}`;
      })
      .join('\n');
  }

  private async runSync(): Promise<void> {
    clearTimeout(this.debounceTimer);
    this.setStatus({ state: 'syncing' });
    try {
      await this.pull();
      await this.push();
      writeMeta(this.meta);
      this.retryScheduled = false;
      this.setStatus({
        state: 'idle',
        dirtyCount: this.meta.dirty.length + this.meta.deleted.length,
        lastSyncedAt: Math.floor(Date.now() / 1000),
        lastError: null,
      });
    } catch (err) {
      writeMeta(this.meta);
      this.setStatus({ state: 'error', lastError: (err as Error).message });
      if (!this.retryScheduled && !this.disposed) {
        this.retryScheduled = true;
        this.debounceTimer = setTimeout(() => {
          this.retryScheduled = false;
          void this.syncNow().catch(() => {});
        }, RETRY_AFTER_FAILURE_MS);
      }
      throw err;
    }
  }

  private async pull(): Promise<void> {
    const remoteEntries = await this.remote.listPages();

    for (const entry of remoteEntries) {
      // Checked live (not a Set snapshotted before the listPages() round
      // trip above) so a markDirty() that lands *during* that await -- e.g.
      // the user starts another merge while this pull is still in flight --
      // is still honored: without this, a remote copy fetched a moment
      // later here could overwrite that brand-new local edit before it's
      // ever pushed.
      if (this.meta.dirty.includes(entry.title)) continue; // our local edit will win on push
      if (this.meta.lastSyncedUpdated[entry.title] === entry.updated) continue; // unchanged
      const remotePage = await this.remote.getPage(entry.title);
      if (remotePage) {
        await this.local.savePage(remotePage);
        this.meta.lastSyncedUpdated[entry.title] = remotePage.updated;
      }
    }

    const remoteTitles = new Set(remoteEntries.map((e) => e.title));
    for (const title of Object.keys(this.meta.lastSyncedUpdated)) {
      if (remoteTitles.has(title) || this.meta.dirty.includes(title) || this.meta.deleted.includes(title)) continue;
      // Known to us before, gone from the remote now, and not something we
      // deleted ourselves -> another device deleted it.
      await this.local.deletePage(title);
      delete this.meta.lastSyncedUpdated[title];
    }
  }

  private async push(): Promise<void> {
    // Snapshotted up front, before any await: pushBatch() below makes
    // several real GitHub API round trips (hundreds of ms each), and
    // markDirty()/markDeleted() can fire again in that window -- e.g. the
    // user starts another page merge while this push is still in flight.
    // Those new marks must not be included in *this* batch (it's already
    // being built/sent) but must also not be lost -- see the filtered
    // reset below, which is the actual fix: the previous unconditional
    // `this.meta.dirty = []` wiped out exactly this kind of mid-flight
    // addition, silently dropping that page's change forever (it looked
    // synced locally, but the edit -- e.g. a merge's savePage+deletePage
    // pair -- had never actually reached GitHub), which is how
    // pages/_index.json drifted from the real page list after doing
    // several merges back to back. LocalStore has no comparable network
    // delay, which is why this never reproduced without GitHub involved.
    const dirtyTitles = [...this.meta.dirty];
    const deletedTitles = [...this.meta.deleted];

    const changes: PageChange[] = [];
    for (const title of dirtyTitles) {
      const page = await this.local.getPage(title);
      if (page) changes.push({ title, lines: page.lines, created: page.created, updated: page.updated, mergeCandidate: page.mergeCandidate });
    }
    for (const title of deletedTitles) {
      changes.push({ title, lines: null });
    }
    if (changes.length === 0) return;

    await this.remote.pushBatch(changes, `sync: ${changes.length} page(s)`);

    for (const change of changes) {
      if (change.lines === null) {
        delete this.meta.lastSyncedUpdated[change.title];
      } else {
        this.meta.lastSyncedUpdated[change.title] = change.updated ?? Math.floor(Date.now() / 1000);
      }
    }
    // Only drop the titles this push actually sent -- anything
    // markDirty()/markDeleted() added since the snapshot above stays
    // queued for the next sync instead of being silently discarded.
    const pushedDirty = new Set(dirtyTitles);
    const pushedDeleted = new Set(deletedTitles);
    this.meta.dirty = this.meta.dirty.filter((t) => !pushedDirty.has(t));
    this.meta.deleted = this.meta.deleted.filter((t) => !pushedDeleted.has(t));
  }
}
