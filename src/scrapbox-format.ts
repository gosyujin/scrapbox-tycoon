// Import/export compatible with Scrapbox's project export JSON.
// Real exports look like:
//   { name, displayName, exported, pages: [{ title, lines: [string,...], created, updated, ... }] }
// `lines` may also arrive as [{text: string}, ...] in some export variants; normalize both.
import type { Page } from './types.js';

interface RawScrapboxLine {
  text?: string;
}

interface RawScrapboxPage {
  title?: string;
  lines?: (string | RawScrapboxLine)[];
  created?: number;
  updated?: number;
}

interface RawScrapboxExport {
  pages?: RawScrapboxPage[];
}

export interface ScrapboxExport {
  name: string;
  displayName: string;
  exported: number;
  pages: Pick<Page, 'title' | 'lines' | 'created' | 'updated'>[];
}

export function parseScrapboxExport(json: string | RawScrapboxExport): Page[] {
  const data: RawScrapboxExport = typeof json === 'string' ? JSON.parse(json) : json;
  const now = Math.floor(Date.now() / 1000);
  return (data.pages || []).map((p) => {
    const lines = (p.lines || []).map((l) => (typeof l === 'string' ? l : l.text || ''));
    const title = p.title || lines[0] || 'Untitled';
    return {
      title,
      lines: lines.length ? lines : [title],
      created: p.created ?? now,
      updated: p.updated ?? now,
    };
  });
}

export function buildScrapboxExport(pages: Page[], projectName = 'scrapbox-tycoon'): ScrapboxExport {
  return {
    name: projectName,
    displayName: projectName,
    exported: Math.floor(Date.now() / 1000),
    pages: pages.map((p) => ({
      title: p.title,
      lines: p.lines,
      created: p.created,
      updated: p.updated,
    })),
  };
}
