// GitHub Contents API-backed store. Reads/writes one JSON file per page
// directly to a repo from the browser, using a repo-scoped fine-grained PAT.
// No server, no build step: GitHub itself is the backend.
//
// Layout in the repo:
//   pages/_index.json          -> [{title, path, updated}, ...]
//   pages/<encoded-title>.json -> {title, lines, created, updated}
import type { Page, PageSummary, PageInput, Store } from '../types.js';

const API = 'https://api.github.com';

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

function slug(title: string): string {
  return encodeURIComponent(title) + '.json';
}

export interface GitHubStoreConfig {
  owner: string;
  repo: string;
  branch?: string;
  token: string;
}

interface FileContent {
  sha: string;
  content: string;
}

interface IndexEntry {
  title: string;
  path: string;
  updated: number;
}

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
    };
  }

  private url(filePath: string): string {
    return `${API}/repos/${this.owner}/${this.repo}/contents/${filePath}`;
  }

  private async getFile(filePath: string): Promise<FileContent | null> {
    const res = await fetch(`${this.url(filePath)}?ref=${this.branch}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${filePath} failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return { sha: json.sha, content: base64ToUtf8(json.content) };
  }

  private async putFile(filePath: string, content: string, sha: string | undefined, message: string): Promise<void> {
    const res = await fetch(this.url(filePath), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({
        message,
        content: utf8ToBase64(content),
        branch: this.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`GitHub PUT ${filePath} failed: ${res.status} ${await res.text()}`);
  }

  private async deleteFile(filePath: string, sha: string, message: string): Promise<void> {
    const res = await fetch(this.url(filePath), {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({ message, sha, branch: this.branch }),
    });
    if (!res.ok) throw new Error(`GitHub DELETE ${filePath} failed: ${res.status} ${await res.text()}`);
  }

  private async readIndex(): Promise<{ sha: string | undefined; entries: IndexEntry[] }> {
    const file = await this.getFile('pages/_index.json');
    if (!file) return { sha: undefined, entries: [] };
    return { sha: file.sha, entries: JSON.parse(file.content) };
  }

  private async writeIndex(entries: IndexEntry[], sha: string | undefined, message: string): Promise<void> {
    return this.putFile('pages/_index.json', JSON.stringify(entries, null, 2), sha, message);
  }

  async listPages(): Promise<PageSummary[]> {
    const { entries } = await this.readIndex();
    return entries
      .map((e) => ({ title: e.title, updated: e.updated }))
      .sort((a, b) => b.updated - a.updated);
  }

  async getPage(title: string): Promise<Page | null> {
    const file = await this.getFile(`pages/${slug(title)}`);
    if (!file) return null;
    return JSON.parse(file.content);
  }

  async savePage(page: PageInput): Promise<void> {
    const path = `pages/${slug(page.title)}`;
    const now = Math.floor(Date.now() / 1000);
    const existingFile = await this.getFile(path);
    const existing: Page | null = existingFile ? JSON.parse(existingFile.content) : null;
    const record: Page = {
      title: page.title,
      lines: page.lines,
      created: page.created ?? (existing ? existing.created : now),
      updated: page.updated ?? now,
    };
    await this.putFile(
      path,
      JSON.stringify(record, null, 2),
      existingFile ? existingFile.sha : undefined,
      `update: ${page.title}`
    );

    const { entries, sha } = await this.readIndex();
    const next = entries.filter((e) => e.title !== page.title);
    next.push({ title: page.title, path, updated: record.updated });
    await this.writeIndex(next, sha, `index: update ${page.title}`);
  }

  async deletePage(title: string): Promise<void> {
    const path = `pages/${slug(title)}`;
    const file = await this.getFile(path);
    if (file) await this.deleteFile(path, file.sha, `delete: ${title}`);

    const { entries, sha } = await this.readIndex();
    const next = entries.filter((e) => e.title !== title);
    await this.writeIndex(next, sha, `index: remove ${title}`);
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
