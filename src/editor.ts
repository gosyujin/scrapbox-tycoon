// Line-based editor: click a line to edit it, blur/Enter/Escape to leave and
// save automatically. No explicit save button, matching the Scrapbox/Gyazz feel.
import { renderLine } from './parser.js';

export interface EditorOptions {
  container: HTMLElement;
  lines: string[];
  onChange: (lines: string[]) => void | Promise<void>;
}

export class Editor {
  private container: HTMLElement;
  private lines: string[];
  private onChange: (lines: string[]) => void | Promise<void>;
  private editingIndex: number | null = null;

  constructor({ container, lines, onChange }: EditorOptions) {
    this.container = container;
    this.lines = [...lines];
    this.onChange = onChange;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = '';
    this.lines.forEach((text, i) => {
      const row = document.createElement('div');
      row.className = 'line-row';
      if (i === this.editingIndex) {
        row.appendChild(this.buildTextarea(i, text));
      } else {
        const div = document.createElement('div');
        div.className = 'line-view' + (i === 0 ? ' line-title' : '');
        div.innerHTML = renderLine(text);
        div.addEventListener('click', (e) => {
          // let link clicks navigate instead of entering edit mode
          if ((e.target as HTMLElement).closest('a')) return;
          this.startEdit(i);
        });
        row.appendChild(div);
      }
      this.container.appendChild(row);
    });
  }

  private startEdit(i: number): void {
    this.editingIndex = i;
    this.render();
    const ta = this.container.querySelector<HTMLTextAreaElement>('textarea');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  // A logical "line" is one array entry, but its textarea can still wrap
  // across several visual rows when the text is long. Arrow-key navigation
  // between logical lines should only kick in at the visual top/bottom row,
  // so wrapped text still lets the browser move within it as usual.
  //
  // Checking only "caret at character 0 / at the end" is not enough: from
  // the second visual row, native ArrowUp first snaps the caret to the
  // start of the *first* row (wherever that lands column-wise), which is
  // usually not character 0 — so a single Up press looked like it did
  // nothing, requiring a second press. A hidden mirror element (same font
  // and width, so it wraps identically) measures which visual row the
  // caret is actually on.
  private mirror: HTMLDivElement | null = null;

  private getMirror(ta: HTMLTextAreaElement): HTMLDivElement {
    if (!this.mirror) {
      this.mirror = document.createElement('div');
      this.mirror.style.position = 'absolute';
      this.mirror.style.visibility = 'hidden';
      this.mirror.style.top = '0';
      this.mirror.style.left = '-9999px';
      this.mirror.style.whiteSpace = 'pre-wrap';
      this.mirror.style.wordWrap = 'break-word';
      document.body.appendChild(this.mirror);
    }
    const cs = getComputedStyle(ta);
    const el = this.mirror;
    el.style.width = cs.width;
    el.style.boxSizing = cs.boxSizing;
    el.style.padding = cs.padding;
    el.style.border = cs.border;
    el.style.fontFamily = cs.fontFamily;
    el.style.fontSize = cs.fontSize;
    el.style.fontWeight = cs.fontWeight;
    el.style.fontStyle = cs.fontStyle;
    el.style.letterSpacing = cs.letterSpacing;
    el.style.lineHeight = cs.lineHeight;
    return el;
  }

  private lineHeightOf(ta: HTMLTextAreaElement): number {
    const cs = getComputedStyle(ta);
    return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  }

  // Which visual row (0-based) a character offset falls on, via the mirror.
  private rowOfPosition(ta: HTMLTextAreaElement, pos: number, lineHeight: number): number {
    const mirror = this.getMirror(ta);
    mirror.textContent = ta.value.slice(0, pos) || '​';
    return Math.max(0, Math.round(mirror.scrollHeight / lineHeight) - 1);
  }

  // First character offset belonging to `targetRow` (binary search: row
  // index is monotonically non-decreasing as the offset increases).
  private rowStartOffset(ta: HTMLTextAreaElement, lineHeight: number, targetRow: number): number {
    if (targetRow <= 0) return 0;
    let lo = 0;
    let hi = ta.value.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rowOfPosition(ta, mid, lineHeight) < targetRow) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private caretRow(ta: HTMLTextAreaElement): { row: number; totalRows: number } {
    const lineHeight = this.lineHeightOf(ta);
    if (lineHeight <= 0) return { row: 0, totalRows: 1 };
    const row = this.rowOfPosition(ta, ta.selectionStart ?? 0, lineHeight);
    const totalRows = this.rowOfPosition(ta, ta.value.length, lineHeight) + 1;
    return { row, totalRows };
  }

  private caretAtTopRow(ta: HTMLTextAreaElement): boolean {
    return this.caretRow(ta).row === 0;
  }

  private caretAtBottomRow(ta: HTMLTextAreaElement): boolean {
    const { row, totalRows } = this.caretRow(ta);
    return row >= totalRows - 1;
  }

  // Moves the caret up/down one visual row *within* the current line's
  // (possibly wrapped) text, preserving column. Used by Ctrl+N/P, which —
  // unlike plain Arrow keys — cannot be left to the browser/OS's native
  // handling: it is not reliably bound to line-down/up movement inside a
  // <textarea> across browsers, and on some platforms produces surprising
  // results (jumping to the end of the field) instead.
  private moveRowWithin(ta: HTMLTextAreaElement, direction: 1 | -1): void {
    const lineHeight = this.lineHeightOf(ta);
    if (lineHeight <= 0) return;
    const pos = ta.selectionStart ?? 0;
    const curRow = this.rowOfPosition(ta, pos, lineHeight);
    const column = pos - this.rowStartOffset(ta, lineHeight, curRow);
    const targetRow = curRow + direction;
    const totalRows = this.rowOfPosition(ta, ta.value.length, lineHeight) + 1;
    const targetRowStart = this.rowStartOffset(ta, lineHeight, targetRow);
    const targetRowEnd = targetRow < totalRows - 1 ? this.rowStartOffset(ta, lineHeight, targetRow + 1) : ta.value.length;
    const pos2 = Math.min(targetRowStart + column, targetRowEnd);
    ta.setSelectionRange(pos2, pos2);
  }

  // Crosses into an adjacent *logical* line, landing on whichever of its
  // visual rows is adjacent to where the caret left off (its last row when
  // moving up into it, first row when moving down into it), preserving
  // column within that row. Column is measured relative to the *current*
  // row's start, not the absolute character offset — using the raw offset
  // would, on a long wrapped line, often overshoot a short target line and
  // always land at its very end.
  private moveToLine(fromIndex: number, ta: HTMLTextAreaElement, toIndex: number): void {
    const lineHeight = this.lineHeightOf(ta);
    const pos = ta.selectionStart ?? 0;
    const column = lineHeight > 0 ? pos - this.rowStartOffset(ta, lineHeight, this.rowOfPosition(ta, pos, lineHeight)) : pos;

    this.commit(fromIndex, ta.value);
    this.editingIndex = toIndex;
    this.render();
    const target = this.container.querySelector<HTMLTextAreaElement>('textarea');
    if (!target) return;
    target.focus();

    const targetLineHeight = this.lineHeightOf(target);
    if (targetLineHeight <= 0) {
      const pos2 = Math.min(column, target.value.length);
      target.setSelectionRange(pos2, pos2);
      return;
    }
    const targetTotalRows = this.rowOfPosition(target, target.value.length, targetLineHeight) + 1;
    const targetRow = toIndex < fromIndex ? targetTotalRows - 1 : 0; // entering from below vs. above
    const targetRowStart = this.rowStartOffset(target, targetLineHeight, targetRow);
    const targetRowEnd = targetRow < targetTotalRows - 1 ? this.rowStartOffset(target, targetLineHeight, targetRow + 1) : target.value.length;
    const pos2 = Math.min(targetRowStart + column, targetRowEnd);
    target.setSelectionRange(pos2, pos2);
  }

  // Crosses into an adjacent logical line at its very start/end — used by
  // Left/Right and Ctrl+B/F, which move character-by-character rather than
  // by visual row.
  private moveToLineEdge(fromIndex: number, ta: HTMLTextAreaElement, toIndex: number, edge: 'start' | 'end'): void {
    this.commit(fromIndex, ta.value);
    this.editingIndex = toIndex;
    this.render();
    const target = this.container.querySelector<HTMLTextAreaElement>('textarea');
    if (!target) return;
    target.focus();
    const pos = edge === 'start' ? 0 : target.value.length;
    target.setSelectionRange(pos, pos);
  }

  private buildTextarea(i: number, text: string): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.className = 'line-edit' + (i === 0 ? ' line-title' : '');
    ta.value = text;
    ta.rows = 1;
    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    };
    ta.addEventListener('input', autosize);
    setTimeout(autosize, 0);

    // IME composition (e.g. Japanese kana->kanji conversion) confirms with
    // Enter too; without this guard that keydown is misread as "commit the
    // line", splitting it and duplicating the in-progress text.
    let composing = false;
    ta.addEventListener('compositionstart', () => {
      composing = true;
    });
    ta.addEventListener('compositionend', () => {
      composing = false;
    });

    ta.addEventListener('keydown', (e) => {
      if (composing || e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.commit(i, ta.value);
        this.lines.splice(i + 1, 0, '');
        this.editingIndex = i + 1;
        this.render();
        const next = this.container.querySelector<HTMLTextAreaElement>('textarea');
        if (next) next.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.commit(i, ta.value);
        this.editingIndex = null;
        this.render();
      } else if (e.key === 'Backspace' && ta.value === '' && i > 0) {
        e.preventDefault();
        this.lines.splice(i, 1);
        this.notifyChange();
        this.editingIndex = i - 1;
        this.render();
        const prev = this.container.querySelector<HTMLTextAreaElement>('textarea');
        if (prev) prev.setSelectionRange(prev.value.length, prev.value.length);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        // Ctrl+P is not reliably native line-up movement in a <textarea>
        // across browsers/platforms, so it is handled entirely ourselves
        // rather than partly delegated like plain ArrowUp is.
        e.preventDefault();
        if (i > 0 && this.caretAtTopRow(ta)) this.moveToLine(i, ta, i - 1);
        else this.moveRowWithin(ta, -1);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        if (i < this.lines.length - 1 && this.caretAtBottomRow(ta)) this.moveToLine(i, ta, i + 1);
        else this.moveRowWithin(ta, 1);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const pos = ta.selectionStart ?? 0;
        if (pos > 0) ta.setSelectionRange(pos - 1, pos - 1);
        else if (i > 0) this.moveToLineEdge(i, ta, i - 1, 'end');
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const pos = ta.selectionEnd ?? ta.value.length;
        if (pos < ta.value.length) ta.setSelectionRange(pos + 1, pos + 1);
        else if (i < this.lines.length - 1) this.moveToLineEdge(i, ta, i + 1, 'start');
      } else if (e.key === 'ArrowUp' && i > 0 && this.caretAtTopRow(ta)) {
        e.preventDefault();
        this.moveToLine(i, ta, i - 1);
      } else if (e.key === 'ArrowDown' && i < this.lines.length - 1 && this.caretAtBottomRow(ta)) {
        e.preventDefault();
        this.moveToLine(i, ta, i + 1);
      } else if (e.key === 'ArrowLeft' && i > 0 && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        this.moveToLineEdge(i, ta, i - 1, 'end');
      } else if (
        e.key === 'ArrowRight' &&
        i < this.lines.length - 1 &&
        ta.selectionStart === ta.value.length &&
        ta.selectionEnd === ta.value.length
      ) {
        e.preventDefault();
        this.moveToLineEdge(i, ta, i + 1, 'start');
      }
    });

    ta.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (!text || !text.includes('\n')) return; // single line: let the browser paste normally
      e.preventDefault();

      const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
      const after = ta.value.slice(ta.selectionEnd ?? ta.value.length);
      const pasted = text.split(/\r\n|\r|\n/);

      const lastPasted = pasted[pasted.length - 1] ?? '';
      this.lines[i] = before + (pasted[0] ?? '');
      const middle = pasted.slice(1, -1);
      this.lines.splice(i + 1, 0, ...middle, lastPasted + after);
      this.notifyChange();

      this.editingIndex = i + pasted.length - 1;
      this.render();
      const target = this.container.querySelector<HTMLTextAreaElement>('textarea');
      if (target) {
        target.focus();
        target.setSelectionRange(lastPasted.length, lastPasted.length);
      }
    });

    ta.addEventListener('blur', () => {
      // Defer so a click on another line's div can register first.
      setTimeout(() => {
        if (this.editingIndex === i) {
          this.commit(i, ta.value);
          this.editingIndex = null;
          this.render();
        }
      }, 0);
    });

    return ta;
  }

  private commit(i: number, value: string): void {
    this.lines[i] = value;
    this.notifyChange();
  }

  private notifyChange(): void {
    // Ensure there's always at least one line (the title line).
    if (this.lines.length === 0) this.lines.push('');
    void this.onChange([...this.lines]);
  }
}
