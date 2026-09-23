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

// Cross-browser "what text position is under this point" lookup (Blink/
// WebKit vs Firefox spell it differently); returns the DOM node + offset
// the browser would place a native caret at.
function caretNodeOffsetFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

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
    this.enterEdit(this.offsetForClick(e));
  }

  // Maps a click in the rendered view to a character offset in the raw
  // (\n-joined) textarea value, so entering edit mode drops the caret near
  // where the user actually clicked instead of always at the very end.
  // Approximate, not exact: markup like [a link] renders shorter than its
  // raw source, so the column within a line is a best effort, not a
  // guaranteed match -- still far closer than the old fixed "end" caret.
  private offsetForClick(e: MouseEvent): number | null {
    const lineEl = (e.target as HTMLElement).closest('.line-view') as HTMLElement | null;
    if (!lineEl) return null;
    const lineIndex = Array.from(this.container.children).indexOf(lineEl);
    if (lineIndex < 0) return null;

    let column = 0;
    const caret = caretNodeOffsetFromPoint(e.clientX, e.clientY);
    if (caret && lineEl.contains(caret.node)) {
      const range = document.createRange();
      range.selectNodeContents(lineEl);
      range.setEnd(caret.node, caret.offset);
      column = range.toString().length;
    }
    column = Math.min(column, this.lines[lineIndex]?.length ?? 0);

    let offset = 0;
    for (let i = 0; i < lineIndex; i++) offset += (this.lines[i]?.length ?? 0) + 1; // +1 for the '\n'
    return offset + column;
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

  private enterEdit(caretOffset: number | null = null): void {
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
    const pos = caretOffset === null ? ta.value.length : Math.max(0, Math.min(caretOffset, ta.value.length));
    ta.setSelectionRange(pos, pos);
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
