// GitHub-backed store. All reads and writes go through the Git Data API
// (blobs/trees/commits), not the simpler Contents API. Two reasons:
//
// 1. Atomicity: a page's own file and the shared index (pages/_index.json)
//    must land in ONE commit. With two separate Contents-API PUTs, a
//    failure or a concurrent writer between them could leave the index and
//    the actual files out of sync (a page missing from the list, or the
//    list pointing at nothing) — this is exactly what was observed.
// 2. Consistency: the Contents API can lag a moment behind a just-created
//    commit (a fresh page briefly reading back as 404). Git objects
//    (blobs/trees), once created, are immutable and addressed by sha, so
//    reading them back does not race the same way.
//
// Commits are retried against the latest branch state on conflict, so two
// devices saving *different* pages at nearly the same time resolve
// transparently (the shared index just gets both entries merged in). Only a
// real collision — another device changing the *same* page's content
// between our attempts — surfaces as an error to the user.
//
// Layout in the repo:
//   pages/_index.json          -> [{title, path, updated}, ...]
//   pages/<encoded-title>.json -> {title, lines, created, updated}
import type { Page, PageSummary, PageInput, Store } from '../types.js';

const API = 'https://api.github.com';
const MAX_COMMIT_ATTEMPTS = 5;

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

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

// Thrown when the page being saved was genuinely changed by someone else
// since we started (not just an unrelated page bumping the shared index).
// Retrying would not help — the caller needs to reload and re-apply.
class SaveConflictError extends Error {}

export class GitHubStore implements Store {
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
      // Without this, fetch() sends a plain string body as text/plain, and
      // GitHub's git/trees endpoint has been observed to fail (422
      // GitRPC::BadObjectState) on bodies containing multi-byte UTF-8 (e.g.
      // Japanese page titles in the index) when the content type is not
      // explicitly declared as JSON.
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
  // Retries cover two distinct situations: the branch tip moving under us
  // (someone else committed first — expected under concurrent use, and
  // `buildChanges` re-running against the new tip resolves it), and GitHub's
  // git/trees or git/commits endpoints occasionally failing transiently
  // (e.g. "GitRPC::BadObjectState") — observed in practice to succeed when
  // the identical request is simply retried. A real same-page conflict
  // (SaveConflictError) is the one case that is not retried, since retrying
  // cannot fix it.
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
        if (err instanceof SaveConflictError) throw err;
        lastError = err;
      }
      if (attempt < MAX_COMMIT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not save after ${MAX_COMMIT_ATTEMPTS} attempts: ${reason}`);
  }

  async listPages(): Promise<PageSummary[]> {
    const entries = await this.readIndexAt(await this.currentBranchCommit());
    return entries.map((e) => ({ title: e.title, updated: e.updated })).sort((a, b) => b.updated - a.updated);
  }

  async getPage(title: string): Promise<Page | null> {
    const content = await this.readFileAt(await this.currentBranchCommit(), `pages/${slug(title)}`);
    return content ? JSON.parse(content) : null;
  }

  async savePage(page: PageInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const path = `pages/${slug(page.title)}`;

    // Retries re-derive `changes` from the latest branch tip so an unrelated
    // page's update (which only moved the shared index) resolves silently.
    // But if THIS page's own content changed between attempts, that is a
    // real conflict — e.g. another device edited the same page seconds ago
    // — and must not be silently overwritten.
    let baselineContent: string | null | undefined;

    await this.commit(`update: ${page.title}`, async (baseCommitSha) => {
      const existingContent = await this.readFileAt(baseCommitSha, path);
      const existing: Page | null = existingContent ? JSON.parse(existingContent) : null;
      const record: Page = {
        title: page.title,
        lines: page.lines,
        created: page.created ?? (existing ? existing.created : now),
        updated: page.updated ?? now,
      };

      // `record` (including `updated`, fixed once above as `now`) is the
      // same on every attempt within this call. If a retry finds the file
      // already holding exactly that content, an earlier attempt's write
      // actually landed even though its response looked like a failure
      // (e.g. a flaky connection) — that is us, not a conflict, so let the
      // retry proceed rather than reporting a false "changed by another
      // device" error.
      const isOwnPriorWrite =
        existing !== null && existing.updated === record.updated && JSON.stringify(existing.lines) === JSON.stringify(record.lines);

      if (baselineContent === undefined) {
        baselineContent = existingContent;
      } else if (existingContent !== baselineContent && !isOwnPriorWrite) {
        throw new SaveConflictError(
          `"${page.title}" was changed by another device just now. Reload the page and re-apply your edit.`
        );
      }

      const entries = await this.readIndexAt(baseCommitSha);
      const nextEntries = entries.filter((e) => e.title !== page.title);
      nextEntries.push({ title: page.title, path, updated: record.updated });

      return [
        { path, content: JSON.stringify(record, null, 2) },
        { path: 'pages/_index.json', content: JSON.stringify(nextEntries, null, 2) },
      ];
    });
  }

  async deletePage(title: string): Promise<void> {
    const path = `pages/${slug(title)}`;

    await this.commit(`delete: ${title}`, async (baseCommitSha) => {
      const entries = await this.readIndexAt(baseCommitSha);
      const nextEntries = entries.filter((e) => e.title !== title);

      return [
        { path, content: null },
        { path: 'pages/_index.json', content: JSON.stringify(nextEntries, null, 2) },
      ];
    });
  }

  async renamePage(oldTitle: string, newTitle: string): Promise<void> {
    const page = await this.getPage(oldTitle);
    if (!page) return;
    page.title = newTitle;
    page.lines[0] = newTitle;
    await this.savePage(page);
    await this.deletePage(oldTitle);
  }
}
