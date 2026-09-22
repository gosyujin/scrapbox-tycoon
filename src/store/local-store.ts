// LocalStorage-backed store. Same interface as GitHubStore, used for
// instant local demo/dev without any GitHub repo or token.
import type { Page, PageSummary, PageInput, Store } from '../types.js';

const KEY = 'scrapbox_tycoon_pages_v1';

function readAll(): Record<string, Page> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAll(pages: Record<string, Page>): void {
  localStorage.setItem(KEY, JSON.stringify(pages));
}

export class LocalStore implements Store {
  async listPages(): Promise<PageSummary[]> {
    const pages = readAll();
    return Object.values(pages)
      .map((p) => ({ title: p.title, updated: p.updated }))
      .sort((a, b) => b.updated - a.updated);
  }

  async getPage(title: string): Promise<Page | null> {
    const pages = readAll();
    return pages[title] || null;
  }

  async savePage(page: PageInput): Promise<void> {
    const pages = readAll();
    const now = Math.floor(Date.now() / 1000);
    const existing = pages[page.title];
    pages[page.title] = {
      title: page.title,
      lines: page.lines,
      created: page.created ?? (existing ? existing.created : now),
      updated: page.updated ?? now,
    };
    writeAll(pages);
  }

  async deletePage(title: string): Promise<void> {
    const pages = readAll();
    delete pages[title];
    writeAll(pages);
  }

  async renamePage(oldTitle: string, newTitle: string): Promise<void> {
    const pages = readAll();
    const page = pages[oldTitle];
    if (!page) return;
    delete pages[oldTitle];
    page.title = newTitle;
    page.lines[0] = newTitle;
    pages[newTitle] = page;
    writeAll(pages);
  }
}
