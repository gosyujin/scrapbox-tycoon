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

  private caretRow(ta: HTMLTextAreaElement): { row: number; totalRows: number } {
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    if (lineHeight <= 0) return { row: 0, totalRows: 1 };

    const mirror = this.getMirror(ta);
    const caretPos = ta.selectionStart ?? 0;

    mirror.textContent = ta.value.slice(0, caretPos) || '​';
    const beforeHeight = mirror.scrollHeight;
    mirror.textContent = ta.value || '​';
    const totalHeight = mirror.scrollHeight;

    const row = Math.max(0, Math.round(beforeHeight / lineHeight) - 1);
    const totalRows = Math.max(1, Math.round(totalHeight / lineHeight));
    return { row, totalRows };
  }

  private caretAtTopRow(ta: HTMLTextAreaElement): boolean {
    return this.caretRow(ta).row === 0;
  }

  private caretAtBottomRow(ta: HTMLTextAreaElement): boolean {
    const { row, totalRows } = this.caretRow(ta);
    return row >= totalRows - 1;
  }

  private moveToLine(fromIndex: number, ta: HTMLTextAreaElement, toIndex: number): void {
    const caretOffset = ta.selectionStart ?? 0;
    this.commit(fromIndex, ta.value);
    this.editingIndex = toIndex;
    this.render();
    const target = this.container.querySelector<HTMLTextAreaElement>('textarea');
    if (target) {
      target.focus();
      const pos = Math.min(caretOffset, target.value.length);
      target.setSelectionRange(pos, pos);
    }
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
      } else if ((e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) && i > 0 && this.caretAtTopRow(ta)) {
        e.preventDefault();
        this.moveToLine(i, ta, i - 1);
      } else if (
        (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) &&
        i < this.lines.length - 1 &&
        this.caretAtBottomRow(ta)
      ) {
        e.preventDefault();
        this.moveToLine(i, ta, i + 1);
      } else if (e.key === 'ArrowLeft' && i > 0 && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        this.commit(i, ta.value);
        this.editingIndex = i - 1;
        this.render();
        const prev = this.container.querySelector<HTMLTextAreaElement>('textarea');
        if (prev) {
          prev.focus();
          prev.setSelectionRange(prev.value.length, prev.value.length);
        }
      } else if (
        e.key === 'ArrowRight' &&
        i < this.lines.length - 1 &&
        ta.selectionStart === ta.value.length &&
        ta.selectionEnd === ta.value.length
      ) {
        e.preventDefault();
        this.commit(i, ta.value);
        this.editingIndex = i + 1;
        this.render();
        const next = this.container.querySelector<HTMLTextAreaElement>('textarea');
        if (next) {
          next.focus();
          next.setSelectionRange(0, 0);
        }
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
