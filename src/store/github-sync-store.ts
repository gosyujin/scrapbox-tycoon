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
    this.debounceTimer = setTimeout(() => void this.syncNow(), delayMs);
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
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
          void this.syncNow();
        }, RETRY_AFTER_FAILURE_MS);
      }
      throw err;
    }
  }

  private async pull(): Promise<void> {
    const dirtySet = new Set(this.meta.dirty);
    const remoteEntries = await this.remote.listPages();

    for (const entry of remoteEntries) {
      if (dirtySet.has(entry.title)) continue; // our local edit will win on push
      if (this.meta.lastSyncedUpdated[entry.title] === entry.updated) continue; // unchanged
      const remotePage = await this.remote.getPage(entry.title);
      if (remotePage) {
        await this.local.savePage(remotePage);
        this.meta.lastSyncedUpdated[entry.title] = remotePage.updated;
      }
    }

    const remoteTitles = new Set(remoteEntries.map((e) => e.title));
    for (const title of Object.keys(this.meta.lastSyncedUpdated)) {
      if (remoteTitles.has(title) || dirtySet.has(title) || this.meta.deleted.includes(title)) continue;
      // Known to us before, gone from the remote now, and not something we
      // deleted ourselves -> another device deleted it.
      await this.local.deletePage(title);
      delete this.meta.lastSyncedUpdated[title];
    }
  }

  private async push(): Promise<void> {
    const changes: PageChange[] = [];

    for (const title of this.meta.dirty) {
      const page = await this.local.getPage(title);
      if (page) changes.push({ title, lines: page.lines, created: page.created, updated: page.updated });
    }
    for (const title of this.meta.deleted) {
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
    this.meta.dirty = [];
    this.meta.deleted = [];
  }
}
