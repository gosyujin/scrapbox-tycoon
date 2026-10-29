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
// same page on two devices between syncs is not merged line-by-line — the
// more recent sync simply wins for that title — acceptable for a
// single-user tool syncing every few seconds, not worth the complexity of a
// real merge/conflict UI here. What is NOT acceptable is losing the other
// side's edit silently: if pull() sees that a locally-dirty page's remote
// `updated` no longer matches what we last synced (i.e. someone else really
// did change it in between, not just "we haven't looked yet"), it stashes
// the remote content as a separate page tagged with `mergeCandidate`, the
// same "don't overwrite, save alongside and let the user merge" mechanism
// app.ts already uses for rename collisions.
import { LocalStore } from './local-store.js';
import { GitHubStore, PushConflictError, type GitHubStoreConfig, type PageChange } from './github-store.js';
import type { Page, PageSummary, PageInput, Store, SyncStatus, SyncCapable } from '../types.js';

const SYNC_META_KEY = 'scrapbox_tycoon_sync_meta_v1';
// Short, because the point of syncing is "write on the phone, see it on the PC
// right away": this is the delay between the last edit and the push.
const AUTO_SYNC_DEBOUNCE_MS = 2000;
// How many times one sync re-pulls and re-pushes when the remote moved under a
// push (PushConflictError). Each pass is deterministic given the remote state,
// so a few are plenty; beyond that something is writing continuously and the
// normal failure retry takes over.
const MAX_SYNC_PASSES = 4;
const SYNC_LOCK_NAME = 'scrapbox_tycoon_sync';
// Don't wait forever on a lock held by a tab the OS has frozen.
const SYNC_LOCK_TIMEOUT_MS = 20000;
// A failed sync (e.g. GitHub's git/trees occasionally erroring transiently
// — see GitHubStore) would otherwise sit dirty until the next edit happens
// to trigger another attempt. Retry once on our own after a delay so a
// transient failure recovers even during a lull in editing.
const RETRY_AFTER_FAILURE_MS = 15000;

// Title suffix of the page stashConflictIfDiverged() creates. app.ts keys its
// "conflict" banner (as opposed to the plain rename-collision one) off this.
export const SYNC_CONFLICT_SUFFIX = ' (sync conflict)';
export function isSyncConflictTitle(title: string): boolean {
  return /\(sync conflict\)(_\d+)?$/.test(title);
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

interface SyncMeta {
  dirty: string[];
  deleted: string[];
  // title -> remote `updated` as of the last successful sync; used to tell
  // whether a page changed on the remote since we last looked at it.
  lastSyncedUpdated: Record<string, number>;
  // title -> remote `updated` value we've already split off into a
  // "(sync conflict)" page for. Without this, a locally-dirty page that
  // keeps failing to push (see RETRY_AFTER_FAILURE_MS) would get a fresh
  // conflict copy stashed on every retry's pull(), since the divergence
  // that triggered it is still there until our push actually lands.
  conflictSeen: Record<string, number>;
  // title -> the `updated` value of the page content we were about to hand to
  // pushBatch(), written BEFORE the network call and cleared once it's
  // acknowledged. If the commit lands on GitHub but we never hear back (iOS
  // freezing the PWA right after the PATCH, a dropped connection, ...), this
  // is the only record that the remote's new `updated` is OUR OWN write, not
  // another device's -- see pull().
  pendingPush: Record<string, number>;
  // Persisted (not just kept on the instance) so the debug display in the
  // page list still shows the last-known-good commit across a reload,
  // before this device has synced again.
  lastSyncedCommitSha: string | null;
  // Branch HEAD as read right BEFORE the last successful pull(). If HEAD is
  // still this and nothing is dirty, there is nothing new to fetch, so a
  // background poll costs one ref read instead of the full pull. Kept apart
  // from lastSyncedCommitSha (a display value read AFTER push, which can
  // include a commit by another device that this device never pulled).
  lastPulledHeadSha: string | null;
}

function readMeta(): SyncMeta {
  try {
    const raw = JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}');
    return {
      dirty: Array.isArray(raw.dirty) ? raw.dirty : [],
      deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
      lastSyncedUpdated: raw.lastSyncedUpdated && typeof raw.lastSyncedUpdated === 'object' ? raw.lastSyncedUpdated : {},
      conflictSeen: raw.conflictSeen && typeof raw.conflictSeen === 'object' ? raw.conflictSeen : {},
      pendingPush: raw.pendingPush && typeof raw.pendingPush === 'object' ? raw.pendingPush : {},
      lastSyncedCommitSha: typeof raw.lastSyncedCommitSha === 'string' ? raw.lastSyncedCommitSha : null,
      lastPulledHeadSha: typeof raw.lastPulledHeadSha === 'string' ? raw.lastPulledHeadSha : null,
    };
  } catch {
    return { dirty: [], deleted: [], lastSyncedUpdated: {}, conflictSeen: {}, pendingPush: {}, lastSyncedCommitSha: null, lastPulledHeadSha: null };
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
      phase: 'waiting',
      conflictCount: 0,
      dirtyCount: this.meta.dirty.length + this.meta.deleted.length,
      lastSyncedAt: null,
      lastSyncedCommitSha: this.meta.lastSyncedCommitSha,
      lastError: null,
      dataVersion: 0,
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

  // The sync meta lives in localStorage, which every tab/PWA window of this
  // origin shares, so this instance's `this.meta` is only a snapshot. Anything
  // that decides or mutates must go through these two instead of trusting the
  // in-memory copy: a stale copy written back wipes the other tab's dirty marks
  // (and makes this tab blind to them).
  private fresh(): SyncMeta {
    this.meta = readMeta();
    return this.meta;
  }

  private updateMeta(fn: (meta: SyncMeta) => void): void {
    const meta = readMeta();
    fn(meta);
    writeMeta(meta);
    this.meta = meta;
  }

  async savePage(page: PageInput): Promise<void> {
    // The editor commits on every blur, including a blur after merely
    // opening a page. Writing that would bump `updated` and mark the page
    // dirty without any change, so a later edit of the same page on another
    // device looks like a divergence on the next pull() and produces a
    // "(sync conflict)" copy for what was just a look at the page.
    if (await this.isNoopSave(page)) return;
    await this.local.savePage(page);
    this.markDirty(page.title);
    this.scheduleSync();
  }

  private async isNoopSave(page: PageInput): Promise<boolean> {
    const existing = await this.local.getPage(page.title);
    if (!existing || !sameLines(existing.lines, page.lines)) return false;
    if (page.created !== undefined && page.created !== existing.created) return false;
    if (page.updated !== undefined && page.updated !== existing.updated) return false;
    // mergeCandidate: undefined = keep, null = clear, string = set.
    if (page.mergeCandidate === null) return existing.mergeCandidate === undefined;
    return page.mergeCandidate === undefined || page.mergeCandidate === existing.mergeCandidate;
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
    this.syncPromise = this.withCrossTabLock(() => this.runSync()).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  // At most one sync at a time per browser (all tabs/PWA windows), so two
  // windows never push the same dirty pages against each other. Web Locks is
  // missing on old browsers -- then it is simply skipped. A holder the OS has
  // frozen would block us indefinitely, hence the timeout and unlocked fallback
  // (the compare-and-swap push keeps that fallback safe).
  private async withCrossTabLock(fn: () => Promise<void>): Promise<void> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks || typeof locks.request !== 'function') return fn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_LOCK_TIMEOUT_MS);
    let granted = false;
    try {
      return await locks.request(SYNC_LOCK_NAME, { signal: controller.signal }, async () => {
        granted = true;
        clearTimeout(timer);
        await fn();
      });
    } catch (err) {
      // fn()'s own failures propagate as they are; only a timed-out wait for
      // the lock falls through to an unlocked sync.
      if (granted || (err as Error).name !== 'AbortError') throw err;
      return fn();
    } finally {
      clearTimeout(timer);
    }
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
    this.updateMeta((m) => {
      for (const title of titles) delete m.lastSyncedUpdated[title];
    });
  }

  // Status patch after an edit is queued: back to "waiting to send" unless a
  // sync is running right now (that one keeps its own phase; the edit is picked
  // up by the next).
  private queuedStatus(): Partial<SyncStatus> {
    const dirtyCount = this.meta.dirty.length + this.meta.deleted.length;
    return this.status.state === 'syncing' ? { dirtyCount } : { dirtyCount, phase: 'waiting' };
  }

  private markDirty(title: string): void {
    this.updateMeta((m) => {
      if (!m.dirty.includes(title)) m.dirty.push(title);
      m.deleted = m.deleted.filter((t) => t !== title);
    });
    this.setStatus(this.queuedStatus());
  }

  private markDeleted(title: string): void {
    this.updateMeta((m) => {
      m.dirty = m.dirty.filter((t) => t !== title);
      if (!m.deleted.includes(title)) m.deleted.push(title);
    });
    this.setStatus(this.queuedStatus());
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

  // `log: false` for transitions that would only add noise to the debug log
  // (phase changes inside a sync, and the start of a poll that turns out to
  // have nothing to do -- at one poll per 10s they would push the history that
  // matters out of the capped log within minutes).
  private setStatus(patch: Partial<SyncStatus>, log = true): void {
    this.status = { ...this.status, ...patch };
    if (log) this.logStatus();
    for (const listener of this.listeners) listener(this.status);
  }

  private logStatus(): void {
    const entry: SyncLogEntry = {
      t: Date.now(),
      state: this.status.state,
      dirtyCount: this.status.dirtyCount,
      lastError: this.status.lastError,
    };
    const last = readSyncLog().at(-1);
    // An idle poll that finds nothing: don't repeat the identical "idle" line.
    if (last && last.state === 'idle' && entry.state === 'idle' && last.dirtyCount === entry.dirtyCount && last.lastError === entry.lastError) return;
    appendSyncLog(entry);
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
    this.setStatus({ state: 'syncing', phase: 'starting' }, false);
    try {
      let changedLocal = false;
      let touchedRemote = false;
      let head = '';
      // pull -> push is one logical step, but the remote can move between
      // the two. push() verifies that (compare-and-swap against the page
      // versions this pass pulled) and throws PushConflictError instead of
      // overwriting; we then pull again, which stashes/adopts the other
      // side's change, and push again.
      for (let pass = 1; ; pass++) {
        head = await this.remote.getHeadCommitSha();
        const meta = this.fresh();
        const hasLocalChanges = meta.dirty.length > 0 || meta.deleted.length > 0;
        if (!hasLocalChanges && head === meta.lastPulledHeadSha) break; // idle poll: nothing to do
        if (!touchedRemote) this.logStatus(); // real work: record that a sync started
        touchedRemote = true;
        this.setStatus({ phase: 'pulling' }, false);
        if (await this.pull()) changedLocal = true;
        this.updateMeta((m) => {
          m.lastPulledHeadSha = head;
        });
        try {
          await this.push();
          break;
        } catch (err) {
          if (!(err instanceof PushConflictError) || pass >= MAX_SYNC_PASSES) throw err;
        }
      }
      // Display value only. When this sync touched the remote, HEAD may have
      // moved (our own push), so read it again; an idle poll already has it.
      const lastSyncedCommitSha = touchedRemote ? await this.remote.getHeadCommitSha() : head;
      this.updateMeta((m) => {
        m.lastSyncedCommitSha = lastSyncedCommitSha;
      });
      this.retryScheduled = false;
      const conflictCount = (await this.local.listPages()).filter((p) => isSyncConflictTitle(p.title)).length;
      this.setStatus({
        state: 'idle',
        phase: conflictCount > 0 ? 'conflict' : 'done',
        conflictCount,
        dirtyCount: this.meta.dirty.length + this.meta.deleted.length,
        lastSyncedAt: Math.floor(Date.now() / 1000),
        lastSyncedCommitSha,
        lastError: null,
        dataVersion: this.status.dataVersion + (changedLocal ? 1 : 0),
      });
    } catch (err) {
      this.setStatus({ state: 'error', phase: 'error', lastError: (err as Error).message, dirtyCount: this.fresh().dirty.length + this.meta.deleted.length });
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

  // Called from pull() for a title that's locally dirty (so push() is about
  // to overwrite it on the remote). If remoteUpdated no longer matches what
  // we last synced for this title, someone else genuinely changed it in
  // between -- not just "we haven't looked since our own edit". Rather than
  // let push() silently discard that other change, fetch it and save it as
  // a separate page tagged with mergeCandidate pointing back at the real
  // title, so the existing rename-collision banner (see app.ts) lets the
  // user merge it in whenever they notice.
  private async stashConflictIfDiverged(title: string, remoteUpdated: number): Promise<boolean> {
    // A conflict copy is a disposable scratch page. Stashing the other side of
    // a conflict copy would make "X (sync conflict) (sync conflict)" and so on
    // without end; for these the later push simply wins.
    if (isSyncConflictTitle(title)) return false;
    const meta = this.fresh();
    // undefined = never synced this title: a page created locally whose title
    // also exists remotely (made on another device) is a divergence too.
    if (meta.lastSyncedUpdated[title] === remoteUpdated) return false;
    if (meta.conflictSeen[title] === remoteUpdated) return false; // already stashed this exact divergence
    // The remote's `updated` is exactly what we were mid-way through pushing:
    // that commit landed but its acknowledgement never reached us (see
    // SyncMeta.pendingPush). It's our own write, not a divergence.
    if (meta.pendingPush[title] === remoteUpdated) {
      this.updateMeta((m) => {
        m.lastSyncedUpdated[title] = remoteUpdated;
        delete m.pendingPush[title];
      });
      return false;
    }
    const remotePage = await this.remote.getPage(title);
    if (!remotePage) return false;
    // Belt and braces for the case above when pendingPush wasn't available
    // (e.g. meta written by an older build): identical content is never a
    // conflict, whatever its timestamp says.
    const localPage = await this.local.getPage(title);
    if (localPage && sameLines(localPage.lines, remotePage.lines)) {
      this.updateMeta((m) => {
        m.lastSyncedUpdated[title] = remoteUpdated;
      });
      return false;
    }
    const conflictTitle = await this.uniqueConflictTitle(`${title}${SYNC_CONFLICT_SUFFIX}`);
    await this.local.savePage({
      title: conflictTitle,
      // lines[0] is the page's identity (Editor/app.ts treat a title !=
      // lines[0] as a rename on the next edit). Keeping the original's
      // first line here made any edit to the copy "rename" it back to the
      // original title, collide, and get re-saved as "<title>_2" -- no
      // longer a sync-conflict page at all.
      lines: [conflictTitle, ...remotePage.lines.slice(1)],
      created: remotePage.created,
      updated: remotePage.updated,
      mergeCandidate: title,
    });
    this.markDirty(conflictTitle); // so this same sync's push() also lands it on the remote
    // We have now seen (and preserved) the remote version, so our push is
    // based on it: record it as the synced base, which is also what lets
    // push()'s compare-and-swap accept our overwrite.
    this.updateMeta((m) => {
      m.conflictSeen[title] = remoteUpdated;
      m.lastSyncedUpdated[title] = remoteUpdated;
    });
    return true;
  }

  private async uniqueConflictTitle(base: string): Promise<string> {
    if (!(await this.local.getPage(base))) return base;
    let n = 2;
    while (await this.local.getPage(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  // Returns whether this changed anything in the local store (so the UI knows
  // a re-render is worth it).
  private async pull(): Promise<boolean> {
    let changed = false;
    const remoteEntries = await this.remote.listPages();

    for (const entry of remoteEntries) {
      // Meta is re-read per entry (not snapshotted before the listPages()
      // round trip above) so a markDirty() that lands *during* that await --
      // e.g. the user starts another merge while this pull is still in
      // flight, or another tab edits -- is still honored: without this, a
      // remote copy fetched a moment later here could overwrite that
      // brand-new local edit before it's ever pushed.
      const meta = this.fresh();
      if (meta.dirty.includes(entry.title)) {
        if (await this.stashConflictIfDiverged(entry.title, entry.updated)) changed = true;
        continue; // our local edit still wins on push for this title
      }
      if (meta.lastSyncedUpdated[entry.title] === entry.updated) continue; // unchanged
      const remotePage = await this.remote.getPage(entry.title);
      if (remotePage) {
        await this.local.savePage(remotePage);
        this.updateMeta((m) => {
          m.lastSyncedUpdated[entry.title] = remotePage.updated;
          // Deleted here but edited elsewhere since: the edit wins. Keeping the
          // pending delete would make push() erase that edit from the remote.
          m.deleted = m.deleted.filter((t) => t !== entry.title);
        });
        changed = true;
      }
    }

    const remoteTitles = new Set(remoteEntries.map((e) => e.title));
    for (const title of Object.keys(this.fresh().lastSyncedUpdated)) {
      const meta = this.fresh();
      if (remoteTitles.has(title) || meta.dirty.includes(title) || meta.deleted.includes(title)) continue;
      // Known to us before, gone from the remote now, and not something we
      // deleted ourselves -> another device deleted it.
      await this.local.deletePage(title);
      this.updateMeta((m) => {
        delete m.lastSyncedUpdated[title];
      });
      changed = true;
    }
    return changed;
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
    const snapshot = this.fresh();
    const dirtyTitles = [...snapshot.dirty];
    const deletedTitles = [...snapshot.deleted];

    // Every change carries the remote version it is based on, so pushBatch()
    // can refuse (PushConflictError) to overwrite a page that changed after
    // pull(). Conflict copies are exempt: they are disposable, last push wins.
    const guard = (title: string): Pick<PageChange, 'expectedUpdated' | 'acceptRemoteUpdated'> =>
      isSyncConflictTitle(title)
        ? {}
        : { expectedUpdated: snapshot.lastSyncedUpdated[title] ?? null, acceptRemoteUpdated: snapshot.pendingPush[title] };

    const changes: PageChange[] = [];
    for (const title of dirtyTitles) {
      const page = await this.local.getPage(title);
      if (page) changes.push({ title, lines: page.lines, created: page.created, updated: page.updated, mergeCandidate: page.mergeCandidate, ...guard(title) });
    }
    for (const title of deletedTitles) {
      // A page that never reached the remote has nothing to compare against.
      changes.push({ title, lines: null, ...(snapshot.lastSyncedUpdated[title] === undefined ? {} : guard(title)) });
    }
    if (changes.length === 0) return;

    this.updateMeta((m) => {
      for (const change of changes) {
        if (change.lines !== null && change.updated !== undefined) m.pendingPush[change.title] = change.updated;
      }
    });

    this.setStatus({ phase: 'pushing' }, false);
    await this.remote.pushBatch(changes, `sync: ${changes.length} page(s)`);

    // Only drop the titles this push actually sent -- anything
    // markDirty()/markDeleted() added since the snapshot above stays
    // queued for the next sync instead of being silently discarded.
    const pushedDirty = new Set(dirtyTitles);
    const pushedDeleted = new Set(deletedTitles);
    this.updateMeta((m) => {
      for (const change of changes) {
        delete m.pendingPush[change.title];
        if (change.lines === null) {
          delete m.lastSyncedUpdated[change.title];
        } else {
          m.lastSyncedUpdated[change.title] = change.updated ?? Math.floor(Date.now() / 1000);
        }
      }
      m.dirty = m.dirty.filter((t) => !pushedDirty.has(t));
      m.deleted = m.deleted.filter((t) => !pushedDeleted.has(t));
      // The divergence that triggered a stashed conflict is resolved once our
      // own push for that title actually lands -- lastSyncedUpdated above is
      // about to be reset to it, so any future divergence is a new one.
      for (const title of dirtyTitles) delete m.conflictSeen[title];
    });
  }
}
