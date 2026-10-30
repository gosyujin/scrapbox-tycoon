export interface Page {
  title: string;
  lines: string[];
  created: number;
  updated: number;
  // When each line was last edited (unix seconds), parallel to `lines` -- the
  // source of the editor's left-edge "telomere" bar (see line-times.ts).
  // Optional: records saved before this existed lack it, and readers then
  // treat every line as last edited at `updated`.
  lineTimes?: number[];
  // Set when this page was auto-created to avoid overwriting an
  // already-existing page of the same title (see app.ts's rename handling).
  // Names the other page it may want to be merged into, shown as a
  // dismissable banner on this page rather than a blocking prompt.
  mergeCandidate?: string;
}

export interface PageSummary {
  title: string;
  updated: number;
}

// created/updated are optional on write: omit them to let the store fill
// them in (now for a fresh page, or preserved from the existing record);
// pass them explicitly (e.g. from a Scrapbox import) to keep original dates.
// lineTimes: omit to carry the existing times over for unchanged lines (new or
// edited lines get `updated`/now); pass it to store exactly those times (sync).
// mergeCandidate: omit to leave whatever is already stored untouched, a
// string to set it, or null to explicitly clear it (e.g. dismissing the
// banner) — unlike created/updated, an ordinary edit should not silently
// wipe it just by not mentioning it.
export type PageInput = Pick<Page, 'title' | 'lines'> &
  Partial<Pick<Page, 'created' | 'updated' | 'lineTimes'>> & { mergeCandidate?: string | null };

export interface Store {
  listPages(): Promise<PageSummary[]>;
  getPage(title: string): Promise<Page | null>;
  savePage(page: PageInput): Promise<void>;
  deletePage(title: string): Promise<void>;
  renamePage(oldTitle: string, newTitle: string): Promise<void>;
}

// Finer-grained than SyncStatus.state, for the badge. In order of a normal sync:
//   waiting  - nothing started: never synced yet, or local edits queued for the
//              debounce timer
//   starting - a sync has begun and is asking GitHub where the branch is
//   pulling  - fetching other devices' changes
//   pushing  - sending this device's changes
//   done     - finished, nothing to look at
//   conflict - finished, but "(sync conflict)" pages still need a human
//   error    - the last attempt failed (a retry is scheduled)
export type SyncPhase = 'waiting' | 'starting' | 'pulling' | 'pushing' | 'done' | 'conflict' | 'error';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error';
  phase: SyncPhase;
  // Pages that still need a human, as of the end of the last successful sync:
  // ones holding conflict markers from a merge (see merge.ts), plus legacy
  // "(sync conflict)" copies.
  conflictCount: number;
  conflictTitles: string[];
  dirtyCount: number;
  lastSyncedAt: number | null;
  // The remote branch's HEAD commit sha as observed right after the last
  // successful sync (not necessarily a commit *this* device made -- pull-
  // only syncs pick this up too). Null until the first successful sync.
  lastSyncedCommitSha: string | null;
  lastError: string | null;
  // Bumped each time a sync changed pages in the local store (pulled in a
  // remote edit/delete, or stashed a conflict copy), so the UI can re-render
  // only when there is something new to show.
  dataVersion: number;
}

// Implemented by stores that buffer edits locally and push them to a remote
// on their own schedule (see GitHubSyncStore), rather than writing straight
// through on every edit.
export interface SyncCapable {
  syncNow(): Promise<void>;
  getSyncStatus(): SyncStatus;
  onSyncStatusChange(listener: (status: SyncStatus) => void): () => void;
  // Stops background sync. Call before discarding an instance (e.g.
  // replacing it with a freshly-configured one) so its debounce timer
  // cannot fire later and race the replacement.
  dispose(): void;
  // Maintenance for pages the remote still has but this device's local
  // store does not -- normally that only happens transiently (another
  // device hasn't synced yet), but a past sync bug could leave a page
  // stuck on the remote forever after it was deleted/merged away locally
  // (see github-sync-store.ts). listOrphanedRemotePages() is read-only
  // (it does sync first, to settle any pending local changes before
  // comparing); deleteOrphanedRemotePages() removes exactly the titles
  // passed in, so the caller can show them for confirmation first.
  listOrphanedRemotePages(): Promise<string[]>;
  deleteOrphanedRemotePages(titles: string[]): Promise<void>;
  // A persisted (survives reload/instance recreation), capped history of
  // every sync-status transition -- for pasting into a bug report when
  // something like "sync got stuck" is hard to catch live (see
  // github-sync-store.ts's syncLog helpers).
  getStatusLogText(): string;
}
