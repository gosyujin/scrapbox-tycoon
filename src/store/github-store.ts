// Low-level GitHub I/O: reads and a batched write, both via the Git Data API
// (blobs/trees/commits), not the simpler Contents API. Two reasons:
//
// 1. Atomicity: a batch of page changes and the shared index
//    (pages/_index.json) must land in ONE commit — with separate
//    Contents-API PUTs, a failure or a concurrent writer partway through
//    could leave the index and the actual files out of sync (a page
//    missing from the list, or the list pointing at nothing).
// 2. Consistency: the Contents API can lag a moment behind a just-created
//    commit (a fresh page briefly reading back as 404). Git objects
//    (blobs/trees), once created, are immutable and addressed by sha, so
//    reading them back does not race the same way.
//
// This class only talks to GitHub; it does not decide *when* to write.
// GitHubSyncStore is the one implementing the app's Store interface — it
// buffers edits in localStorage and calls pushBatch() here to sync them in
// one commit, which is what keeps this simple: no per-edit conflict
// handling is needed at this layer (see github-sync-store.ts for why).
//
// Layout in the repo:
//   pages/_index.json -> [{title, path, updated}, ...]
//   pages/<title>.json -> {title, lines, created, updated}
import type { Page, PageSummary } from '../types.js';

const API = 'https://api.github.com';
const MAX_COMMIT_ATTEMPTS = 8;

function base64ToUtf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Git tree entries take a literal path, not a URL-encoded one — encoding it
// (e.g. via encodeURIComponent) creates a *different* path than the one any
// existing file actually has, which is silently wrong for a create and
// breaks delete/rename entirely (the "path to remove" no longer matches
// anything in the tree). `/` is replaced because it would otherwise nest
// the file into a subdirectory instead of naming it.
function slug(title: string): string {
  return title.replace(/\//g, '／') + '.json';
}

export interface GitHubStoreConfig {
  owner: string;
  repo: string;
  branch?: string;
  token: string;
}

interface IndexEntry {
  title: string;
  path: string;
  updated: number;
}

// A file to write (content set) or delete (content null) as part of a commit.
interface FileChange {
  path: string;
  content: string | null;
}

export interface PageChange {
  title: string;
  lines: string[] | null; // null = delete this page
  created?: number;
  updated?: number;
  mergeCandidate?: string;
}

export class GitHubStore {
  private owner: string;
  private repo: string;
  private branch: string;
  private token: string;

  constructor({ owner, repo, branch, token }: GitHubStoreConfig) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || 'main';
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  private repoUrl(path: string): string {
    return `${API}/repos/${this.owner}/${this.repo}/${path}`;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.repoUrl(path), { ...init, headers: this.headers() });
    if (!res.ok) throw new Error(`GitHub ${init?.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  private async currentBranchCommit(): Promise<string> {
    const ref = await this.api<{ object: { sha: string } }>(`git/ref/heads/${this.branch}`);
    return ref.object.sha;
  }

  // Flat map of path -> blob sha for every file in a commit's tree. Reads at
  // an exact commit sha are strongly consistent (git objects are immutable),
  // unlike the Contents API which can briefly lag a fresh commit.
  private async treeAt(commitSha: string): Promise<Map<string, string>> {
    const commit = await this.api<{ tree: { sha: string } }>(`git/commits/${commitSha}`);
    const tree = await this.api<{ tree: Array<{ path: string; type: string; sha: string }> }>(
      `git/trees/${commit.tree.sha}?recursive=1`
    );
    const map = new Map<string, string>();
    for (const entry of tree.tree) {
      if (entry.type === 'blob') map.set(entry.path, entry.sha);
    }
    return map;
  }

  private async blobContent(blobSha: string): Promise<string> {
    const blob = await this.api<{ content: string }>(`git/blobs/${blobSha}`);
    return base64ToUtf8(blob.content);
  }

  private async readFileAt(commitSha: string, path: string): Promise<string | null> {
    const tree = await this.treeAt(commitSha);
    const blobSha = tree.get(path);
    return blobSha ? this.blobContent(blobSha) : null;
  }

  private async readIndexAt(commitSha: string): Promise<IndexEntry[]> {
    const content = await this.readFileAt(commitSha, 'pages/_index.json');
    return content ? JSON.parse(content) : [];
  }

  // Builds and lands one commit containing all of `changes`, atomically.
  // `changes` is a function (not a static list) because on a retry it must
  // be recomputed against the *new* base commit — otherwise a retried write
  // would blindly reapply a stale index computed before the conflict.
  //
  // Retries cover two situations: the branch tip moving under us (someone
  // else committed first), and GitHub's git/trees or git/commits endpoints
  // occasionally failing transiently (e.g. "GitRPC::BadObjectState") —
  // observed in practice to succeed when the identical request is simply
  // retried.
  private async commit(message: string, buildChanges: (baseCommitSha: string) => Promise<FileChange[]>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
      try {
        const baseCommitSha = await this.currentBranchCommit();
        const baseCommit = await this.api<{ tree: { sha: string } }>(`git/commits/${baseCommitSha}`);

        const changes = await buildChanges(baseCommitSha);
        const treeEntries = changes.map((c) =>
          c.content === null
            ? { path: c.path, mode: '100644', type: 'blob', sha: null }
            : { path: c.path, mode: '100644', type: 'blob', content: c.content }
        );

        const newTree = await this.api<{ sha: string }>('git/trees', {
          method: 'POST',
          body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries }),
        });

        const newCommit = await this.api<{ sha: string }>('git/commits', {
          method: 'POST',
          body: JSON.stringify({ message, tree: newTree.sha, parents: [baseCommitSha] }),
        });

        const updateRes = await fetch(this.repoUrl(`git/refs/heads/${this.branch}`), {
          method: 'PATCH',
          headers: this.headers(),
          body: JSON.stringify({ sha: newCommit.sha, force: false }),
        });
        if (updateRes.ok) return;
        if (updateRes.status !== 409 && updateRes.status !== 422) {
          throw new Error(`GitHub ref update failed: ${updateRes.status} ${await updateRes.text()}`);
        }
        // Someone else moved the branch between our read and our commit.
        lastError = new Error('branch moved during save');
      } catch (err) {
        lastError = err;
      }
      if (attempt < MAX_COMMIT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not save after ${MAX_COMMIT_ATTEMPTS} attempts: ${reason}`);
  }

  // The remote branch's current HEAD commit sha -- used by GitHubSyncStore
  // purely for display (debugging "did my sync actually land, and when"),
  // not for any conflict logic here.
  async getHeadCommitSha(): Promise<string> {
    return this.currentBranchCommit();
  }

  async listPages(): Promise<PageSummary[]> {
    const entries = await this.readIndexAt(await this.currentBranchCommit());
    return entries.map((e) => ({ title: e.title, updated: e.updated })).sort((a, b) => b.updated - a.updated);
  }

  async getPage(title: string): Promise<Page | null> {
    const content = await this.readFileAt(await this.currentBranchCommit(), `pages/${slug(title)}`);
    return content ? JSON.parse(content) : null;
  }

  // Writes many pages (and/or deletes) in ONE commit — used to push a batch
  // of locally-buffered edits at once instead of one commit per edit.
  async pushBatch(changes: PageChange[], message: string): Promise<void> {
    if (changes.length === 0) return;
    const now = Math.floor(Date.now() / 1000);

    await this.commit(message, async (baseCommitSha) => {
      const entries = await this.readIndexAt(baseCommitSha);
      const entryMap = new Map(entries.map((e) => [e.title, e]));
      const fileChanges: FileChange[] = [];

      for (const change of changes) {
        const path = `pages/${slug(change.title)}`;
        if (change.lines === null) {
          // A page created and deleted locally before it was ever synced
          // has no entry here -- and asking git/trees to delete (sha: null)
          // a path that was never in base_tree fails every attempt with
          // "GitRPC::BadObjectState" (confirmed against the live API), not
          // just occasionally, so retrying never helps. Skip it: there is
          // nothing on the remote to remove.
          if (!entryMap.has(change.title)) continue;
          entryMap.delete(change.title);
          fileChanges.push({ path, content: null });
          continue;
        }
        const existingContent = await this.readFileAt(baseCommitSha, path);
        const existing: Page | null = existingContent ? JSON.parse(existingContent) : null;
        const record: Page = {
          title: change.title,
          lines: change.lines,
          created: change.created ?? (existing ? existing.created : now),
          updated: change.updated ?? now,
          ...(change.mergeCandidate !== undefined ? { mergeCandidate: change.mergeCandidate } : {}),
        };
        fileChanges.push({ path, content: JSON.stringify(record, null, 2) });
        entryMap.set(change.title, { title: change.title, path, updated: record.updated });
      }

      fileChanges.push({ path: 'pages/_index.json', content: JSON.stringify([...entryMap.values()], null, 2) });
      return fileChanges;
    });
  }
}
