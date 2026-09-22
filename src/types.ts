export interface Page {
  title: string;
  lines: string[];
  created: number;
  updated: number;
}

export interface PageSummary {
  title: string;
  updated: number;
}

// created/updated are optional on write: omit them to let the store fill
// them in (now for a fresh page, or preserved from the existing record);
// pass them explicitly (e.g. from a Scrapbox import) to keep original dates.
export type PageInput = Pick<Page, 'title' | 'lines'> & Partial<Pick<Page, 'created' | 'updated'>>;

export interface Store {
  listPages(): Promise<PageSummary[]>;
  getPage(title: string): Promise<Page | null>;
  savePage(page: PageInput): Promise<void>;
  deletePage(title: string): Promise<void>;
  renamePage(oldTitle: string, newTitle: string): Promise<void>;
}
