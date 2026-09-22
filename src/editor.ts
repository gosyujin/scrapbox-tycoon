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

    ta.addEventListener('keydown', (e) => {
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
