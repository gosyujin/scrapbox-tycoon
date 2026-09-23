// Click the page to edit it as one plain <textarea> (raw markup, `\n`
// separated), blur to render it back to clickable/rich view mode and save.
//
// An earlier version gave each line its own tiny textarea so only the
// clicked line left "view mode". That meant every native editing behavior
// a real textarea gives for free — Up/Down/Left/Right, word wrap,
// multi-line paste, Emacs bindings on platforms that bind them at the OS
// level — had to be reimplemented by hand to work across line boundaries,
// and kept surfacing new bugs. A single textarea for the whole page trades
// away "other lines stay rendered while I edit one" for getting all of
// that for free; outline-editing features (indent, move line) are also
// easier to add here later, as plain textarea-line manipulation, than they
// were juggling many separate elements.
import { renderLine, splitIndent } from './parser.js';

export interface EditorOptions {
  container: HTMLElement;
  lines: string[];
  onChange: (lines: string[]) => void | Promise<void>;
}

export class Editor {
  private container: HTMLElement;
  private lines: string[];
  private onChange: (lines: string[]) => void | Promise<void>;
  private editing = false;
  private textarea: HTMLTextAreaElement | null = null;

  constructor({ container, lines, onChange }: EditorOptions) {
    this.container = container;
    this.lines = [...lines];
    this.onChange = onChange;
    this.container.addEventListener('click', (e) => this.handleContainerClick(e));
    this.renderView();
  }

  private handleContainerClick(e: MouseEvent): void {
    if (this.editing) return; // clicks land on the textarea itself; nothing to do
    if ((e.target as HTMLElement).closest('a')) return; // let link clicks navigate
    this.enterEdit();
  }

  private renderView(): void {
    this.container.innerHTML = '';
    this.lines.forEach((text, i) => {
      const div = document.createElement('div');
      if (i === 0) {
        // The title line is never indented, matching Scrapbox.
        div.className = 'line-view line-title';
        div.innerHTML = renderLine(text);
        this.container.appendChild(div);
        return;
      }
      const { depth, content } = splitIndent(text);
      div.className = 'line-view';
      if (depth > 0) {
        div.style.paddingLeft = `${0.6 + depth * 1.2}em`;
        div.innerHTML = `<span class="indent-bullet">•</span>${renderLine(content)}`;
      } else {
        div.innerHTML = renderLine(content);
      }
      this.container.appendChild(div);
    });
  }

  private enterEdit(): void {
    this.editing = true;
    this.container.innerHTML = '';

    const ta = document.createElement('textarea');
    ta.className = 'page-edit';
    ta.value = this.lines.join('\n');
    this.textarea = ta;

    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    };
    ta.addEventListener('input', autosize);

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        ta.blur();
      }
    });

    ta.addEventListener('blur', () => this.commit());

    this.container.appendChild(ta);
    autosize();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  private commit(): void {
    const ta = this.textarea;
    if (!ta) return;
    this.lines = ta.value.split('\n');
    this.editing = false;
    this.textarea = null;
    this.renderView();
    void this.onChange([...this.lines]);
  }
}
