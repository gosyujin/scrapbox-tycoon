export interface Page {
  title: string;
  lines: string[];
  created: number;
  updated: number;
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
// mergeCandidate: omit to leave whatever is already stored untouched, a
// string to set it, or null to explicitly clear it (e.g. dismissing the
// banner) — unlike created/updated, an ordinary edit should not silently
// wipe it just by not mentioning it.
export type PageInput = Pick<Page, 'title' | 'lines'> &
  Partial<Pick<Page, 'created' | 'updated'>> & { mergeCandidate?: string | null };

export interface Store {
  listPages(): Promise<PageSummary[]>;
  getPage(title: string): Promise<Page | null>;
  savePage(page: PageInput): Promise<void>;
  deletePage(title: string): Promise<void>;
  renamePage(oldTitle: string, newTitle: string): Promise<void>;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error';
  dirtyCount: number;
  lastSyncedAt: number | null;
  // The remote branch's HEAD commit sha as observed right after the last
  // successful sync (not necessarily a commit *this* device made -- pull-
  // only syncs pick this up too). Null until the first successful sync.
  lastSyncedCommitSha: string | null;
  lastError: string | null;
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
