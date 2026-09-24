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
import { renderLinesInto, splitIndent, type RenderOpts } from './parser.js';

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

// Pixel position (relative to the textarea's own top-left, ignoring its
// scroll offset) of a character index -- there is no native textarea API
// for this, so it's measured with a hidden mirror element that copies
// every style affecting layout/wrapping, filled with the same text up to
// that index. Standard technique (see e.g. component-textarea-caret-position);
// reading the values from getComputedStyle rather than hardcoding them
// means this keeps working no matter what CSS .page-edit ends up with.
const MIRROR_STYLE_PROPS: (keyof CSSStyleDeclaration)[] = [
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textIndent',
  'textTransform',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'wordBreak',
];

function getCaretCoordinates(ta: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const div = document.createElement('div');
  const computed = window.getComputedStyle(ta);
  const style = div.style;
  style.position = 'absolute';
  style.visibility = 'hidden';
  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  for (const prop of MIRROR_STYLE_PROPS) {
    const value = computed[prop];
    if (typeof value === 'string') (style as unknown as Record<string, string>)[prop as string] = value;
  }
  document.body.appendChild(div);
  div.textContent = ta.value.slice(0, position);
  const span = document.createElement('span');
  // A trailing space renders zero-width, which would collapse the marker
  // onto the previous character -- '.' guarantees it has measurable extent.
  span.textContent = ta.value.slice(position) || '.';
  div.appendChild(span);
  const { offsetLeft: left, offsetTop: top } = span;
  document.body.removeChild(div);
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;
  return { top, left, height: lineHeight };
}

// Character offset -> {line, col} and back, against an arbitrary \n-joined
// string/line array (not tied to a particular Editor instance) -- used by
// the line-move and indent/outdent keyboard commands below to translate a
// selection into line indices, edit the lines array, and then translate
// back so the caret/selection lands in the equivalent spot afterward.
function lineColOf(value: string, offset: number): { line: number; col: number } {
  const before = value.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length - 1, col: before.length - lastNewline - 1 };
}
function offsetOfLineCol(lines: string[], line: number, col: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset + col;
}

export interface EditorOptions {
  container: HTMLElement;
  lines: string[];
  onChange: (lines: string[]) => void | Promise<void>;
  // Lower-cased titles of pages that currently exist, for the link
  // exists/missing color-coding (see parser.ts's RenderOpts). A snapshot
  // taken once when the page is opened -- doesn't need to track concurrent
  // edits live, same as the rest of this view.
  knownTitles: Set<string>;
  // Called when the user uses the selection toolbar's "ページ切り出し" button.
  // `lines` is the selected text split on '\n' (lines[0] is the new page's
  // title, same convention as every other page in this app). The caller is
  // responsible for actually creating the page (and deciding what to do if
  // a page with that title already exists) -- the Editor only replaces the
  // selection with a link to it.
  onExtractPage?: (title: string, lines: string[]) => void | Promise<void>;
}

export class Editor {
  private container: HTMLElement;
  private lines: string[];
  private onChange: (lines: string[]) => void | Promise<void>;
  private onExtractPage: ((title: string, lines: string[]) => void | Promise<void>) | undefined;
  private renderOpts: RenderOpts;
  private editing = false;
  private textarea: HTMLTextAreaElement | null = null;
  private selectionToolbar: HTMLElement | null = null;
  private selStart: number | null = null;
  private selEnd: number | null = null;
  private readonly boundUpdateToolbar = () => this.updateSelectionToolbar();

  constructor({ container, lines, onChange, knownTitles, onExtractPage }: EditorOptions) {
    this.container = container;
    this.lines = [...lines];
    this.onChange = onChange;
    this.onExtractPage = onExtractPage;
    this.renderOpts = { linkBase: '#/page/', knownTitles };
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
    // Keyed off data-line-start/end (set by renderLinesInto) rather than
    // DOM child index: a code:/table: block renders as one node covering
    // several source lines, so "which child is this" no longer means
    // "which line is this" the way it did with one div per line.
    const target = (e.target as HTMLElement).closest('[data-line-start]') as HTMLElement | null;
    if (!target) return null;
    const lineStart = Number(target.dataset.lineStart);
    const lineEnd = Number(target.dataset.lineEnd);

    const lineOffset = (index: number) => {
      let offset = 0;
      for (let i = 0; i < index; i++) offset += (this.lines[i]?.length ?? 0) + 1; // +1 for the '\n'
      return offset;
    };

    if (lineStart !== lineEnd) {
      // A multi-line block: land at its start rather than guessing which
      // of its several source lines a point inside it corresponds to.
      return lineOffset(lineStart);
    }

    let column = 0;
    const caret = caretNodeOffsetFromPoint(e.clientX, e.clientY);
    if (caret && target.contains(caret.node)) {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.setEnd(caret.node, caret.offset);
      column = range.toString().length;
    }
    column = Math.min(column, this.lines[lineStart]?.length ?? 0);
    return lineOffset(lineStart) + column;
  }

  private renderView(): void {
    renderLinesInto(this.container, this.lines, this.renderOpts);
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
        return;
      }
      // Plain ctrl+arrow only -- not ctrl+shift+arrow or ctrl+alt+arrow,
      // which some platforms/extensions already bind to something else.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          this.moveLines(e.key === 'ArrowUp' ? -1 : 1);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          this.indentLines(e.key === 'ArrowRight' ? 1 : -1);
        }
        return;
      }
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        this.moveOutline(e.key === 'ArrowUp' ? -1 : 1);
      }
    });

    ta.addEventListener('blur', () => this.commit());

    // selectionchange (rather than select/mouseup/keyup) catches every way a
    // selection can change -- mouse drag, shift+arrows, double/triple-click,
    // and iOS's native selection handles after a long-press -- without
    // juggling several event types. It fires on every caret move too, but
    // updateSelectionToolbar() is cheap when there's nothing selected.
    document.addEventListener('selectionchange', this.boundUpdateToolbar);
    window.addEventListener('scroll', this.boundUpdateToolbar, true);

    this.container.appendChild(ta);
    autosize();
    // The textarea is sized to fit all its content (autosize above), so it
    // never scrolls internally -- the page scrolls instead. A plain
    // .focus() asks the browser to scroll the (now much taller) element
    // into view on its own terms, which on a long page means jumping to
    // wherever it decides, in practice the bottom, discarding the caret
    // position set below and the scroll position the click already had.
    // preventScroll skips that; the page simply stays where it was, which
    // is already showing the line that was clicked.
    ta.focus({ preventScroll: true });
    const pos = caretOffset === null ? ta.value.length : Math.max(0, Math.min(caretOffset, ta.value.length));
    ta.setSelectionRange(pos, pos);
  }

  private commit(): void {
    const ta = this.textarea;
    if (!ta) return;
    document.removeEventListener('selectionchange', this.boundUpdateToolbar);
    window.removeEventListener('scroll', this.boundUpdateToolbar, true);
    this.hideSelectionToolbar();
    this.lines = ta.value.split('\n');
    this.editing = false;
    this.textarea = null;
    this.renderView();
    void this.onChange([...this.lines]);
  }

  // --- Selection toolbar (Scrapbox-style "select text -> act on it") ---

  private hideSelectionToolbar(): void {
    if (this.selectionToolbar) {
      this.selectionToolbar.remove();
      this.selectionToolbar = null;
    }
  }

  private ensureSelectionToolbar(): HTMLElement {
    if (this.selectionToolbar) return this.selectionToolbar;
    const bar = document.createElement('div');
    bar.className = 'selection-toolbar';
    // Clicking a button would otherwise blur the textarea first (which
    // commits and tears down the whole editor DOM before the click handler
    // even runs). preventDefault on mousedown keeps focus -- and the
    // selection -- on the textarea instead.
    bar.addEventListener('mousedown', (e) => e.preventDefault());

    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'selection-toolbar-btn';
    linkBtn.textContent = '[ ] リンク化';
    linkBtn.title = '選択範囲を [ ] で囲んでリンクにする';
    linkBtn.addEventListener('click', () => this.linkifySelection());

    const extractBtn = document.createElement('button');
    extractBtn.type = 'button';
    extractBtn.className = 'selection-toolbar-btn';
    extractBtn.textContent = 'ページ切り出し';
    extractBtn.title = '選択範囲を新しいページに切り出してリンクする';
    extractBtn.addEventListener('click', () => void this.extractSelection());

    bar.append(linkBtn, extractBtn);
    document.body.appendChild(bar);
    this.selectionToolbar = bar;
    return bar;
  }

  private updateSelectionToolbar(): void {
    const ta = this.textarea;
    if (!this.editing || !ta || document.activeElement !== ta) {
      this.hideSelectionToolbar();
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start === end || !ta.value.slice(start, end).trim()) {
      this.hideSelectionToolbar();
      return;
    }
    this.selStart = start;
    this.selEnd = end;

    const bar = this.ensureSelectionToolbar();
    const caret = getCaretCoordinates(ta, start);
    const taRect = ta.getBoundingClientRect();
    const anchorTop = taRect.top + caret.top - ta.scrollTop;
    const anchorLeft = taRect.left + caret.left - ta.scrollLeft;

    bar.style.position = 'fixed';
    bar.style.visibility = 'hidden';
    bar.style.display = 'flex';
    requestAnimationFrame(() => {
      // The selection (or edit mode itself) may already be gone by the
      // time this runs -- nothing to position in that case.
      if (!this.selectionToolbar || this.selStart === null) return;
      const barRect = bar.getBoundingClientRect();
      let top = anchorTop - barRect.height - 8;
      if (top < 4) top = anchorTop + caret.height + 8; // no room above -> show below instead
      let left = anchorLeft;
      left = Math.max(4, Math.min(left, window.innerWidth - barRect.width - 4));
      bar.style.top = `${top}px`;
      bar.style.left = `${left}px`;
      bar.style.visibility = 'visible';
    });
  }

  private replaceSelectionWithLink(title: string): void {
    const ta = this.textarea;
    if (!ta || this.selStart === null || this.selEnd === null) return;
    const before = ta.value.slice(0, this.selStart);
    const after = ta.value.slice(this.selEnd);
    ta.value = `${before}[${title}]${after}`;
    ta.dispatchEvent(new Event('input')); // re-run the autosize listener
    ta.focus();
    const newStart = before.length + 1;
    ta.setSelectionRange(newStart, newStart + title.length);
    this.hideSelectionToolbar();
  }

  private linkifySelection(): void {
    const ta = this.textarea;
    if (!ta || this.selStart === null || this.selEnd === null) return;
    this.replaceSelectionWithLink(ta.value.slice(this.selStart, this.selEnd));
  }

  private async extractSelection(): Promise<void> {
    const ta = this.textarea;
    if (!ta || this.selStart === null || this.selEnd === null) return;
    const selected = ta.value.slice(this.selStart, this.selEnd);
    const selectedLines = selected.split('\n');
    const title = (selectedLines[0] || '').trim();
    if (!title) {
      this.hideSelectionToolbar();
      return;
    }
    // Everything after the selection's own first line -- e.g. selecting a
    // whole paragraph carries its later lines into the new page's body.
    // Selecting just a single term/phrase (the common case) leaves this
    // empty, so the new page is just a title + backlink stub.
    const body = selectedLines.slice(1);
    const sourceTitle = ta.value.split('\n', 1)[0] || '';

    this.replaceSelectionWithLink(title);

    // Matches Scrapbox's own "split into a new page" layout: title, a
    // backlink to where it came from, then whatever body text was cut.
    const newPageLines = [title, '', `from [${sourceTitle}]`, ...(body.length ? ['', ...body] : [])];
    try {
      await this.onExtractPage?.(title, newPageLines);
      // So the new link renders as "exists" (not "missing") the moment
      // this page is next rendered, without waiting for a full reload.
      this.renderOpts.knownTitles.add(title.toLowerCase());
    } catch {
      // The link is already in the text either way; the new page just
      // didn't get created (e.g. a save error) -- same recoverable state
      // as any other failed save in this app, nothing extra to do here.
    }
  }

  // --- ctrl+arrow: move current line(s) up/down, indent/outdent ---

  // {from, to} are 0-indexed, inclusive line numbers covering the current
  // selection (or just the caret's own line, if nothing is selected).
  private selectedLineRange(ta: HTMLTextAreaElement): { from: number; to: number } {
    const startPos = lineColOf(ta.value, ta.selectionStart);
    const endPos = lineColOf(ta.value, ta.selectionEnd);
    let to = endPos.line;
    // A selection that ends exactly at column 0 of a later line (e.g. two
    // full lines picked via shift+Down twice) has nothing highlighted on
    // that line -- exclude it, matching most editors' line-oriented commands.
    if (to > startPos.line && endPos.col === 0) to -= 1;
    return { from: startPos.line, to };
  }

  private moveLines(direction: -1 | 1): void {
    const ta = this.textarea;
    if (!ta) return;
    const lines = ta.value.split('\n');
    const { from, to } = this.selectedLineRange(ta);
    if (direction === -1 && from === 0) return; // already at the top
    if (direction === 1 && to === lines.length - 1) return; // already at the bottom

    // Swap the selected block with the single adjacent line it's moving
    // past, by pulling that line out and reinserting it on the far side of
    // the block -- simpler than recomputing every index by hand.
    const startPos = lineColOf(ta.value, ta.selectionStart);
    const endPos = lineColOf(ta.value, ta.selectionEnd);
    if (direction === -1) {
      const above = lines[from - 1];
      lines.splice(from - 1, 1);
      lines.splice(to, 0, above ?? '');
    } else {
      const below = lines[to + 1];
      lines.splice(to + 1, 1);
      lines.splice(from, 0, below ?? '');
    }

    ta.value = lines.join('\n');
    ta.dispatchEvent(new Event('input')); // re-run the autosize listener
    ta.focus();
    // Content within the moved lines is unchanged, only shifted by one
    // line -- so the same {line, col} pair, offset by `direction`, is
    // exactly where the selection should end up.
    const newStart = offsetOfLineCol(lines, startPos.line + direction, startPos.col);
    const newEnd = offsetOfLineCol(lines, endPos.line + direction, endPos.col);
    ta.setSelectionRange(newStart, newEnd);
  }

  private indentLines(direction: 1 | -1): void {
    const ta = this.textarea;
    if (!ta) return;
    const lines = ta.value.split('\n');
    const { from, to } = this.selectedLineRange(ta);
    const startPos = lineColOf(ta.value, ta.selectionStart);
    const endPos = lineColOf(ta.value, ta.selectionEnd);
    // How much each touched line's own column offsets shift by -- only the
    // lines actually changed (outdenting a line with no leading space is a
    // no-op) get a delta, so the caret/selection tracks precisely.
    const colDelta = new Map<number, number>();

    for (let i = from; i <= to; i++) {
      const line = lines[i] ?? '';
      if (direction === 1) {
        lines[i] = ' ' + line;
        colDelta.set(i, 1);
      } else if (line.startsWith(' ') || line.startsWith('\t') || line.startsWith('　')) {
        lines[i] = line.slice(1);
        colDelta.set(i, -1);
      }
    }
    if (colDelta.size === 0) return; // outdent with nothing to remove -- leave the caret alone

    ta.value = lines.join('\n');
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    const newStartCol = Math.max(0, startPos.col + (colDelta.get(startPos.line) ?? 0));
    const newEndCol = Math.max(0, endPos.col + (colDelta.get(endPos.line) ?? 0));
    const newStart = offsetOfLineCol(lines, startPos.line, newStartCol);
    const newEnd = offsetOfLineCol(lines, endPos.line, newEndCol);
    ta.setSelectionRange(newStart, newEnd);
  }

  // --- alt+arrow: move the current outline node (line + its nested
  // children) past its previous/next sibling, also as a whole ---

  // Index of the last line of `start`'s own subtree: every line
  // immediately after it that's indented deeper than `rootDepth`.
  private subtreeEnd(lines: string[], start: number, rootDepth: number): number {
    let end = start;
    while (end + 1 < lines.length && splitIndent(lines[end + 1] ?? '').depth > rootDepth) end++;
    return end;
  }

  // The start line of the sibling subtree immediately above `from` at
  // `rootDepth` -- i.e. skip back over that sibling's own (deeper) children
  // until a line at exactly `rootDepth` is found. null if the line above is
  // shallower (that's the parent, not a sibling) or `from` is already the
  // first line.
  private prevSiblingStart(lines: string[], from: number, rootDepth: number): number | null {
    let i = from - 1;
    while (i >= 0 && splitIndent(lines[i] ?? '').depth > rootDepth) i--;
    return i >= 0 && splitIndent(lines[i] ?? '').depth === rootDepth ? i : null;
  }

  // [start, end] of the sibling subtree immediately after `to` at
  // `rootDepth`. null if there's nothing there or it's shallower (end of
  // the parent's children, not a sibling).
  private nextSiblingRange(lines: string[], to: number, rootDepth: number): [number, number] | null {
    const start = to + 1;
    if (start >= lines.length || splitIndent(lines[start] ?? '').depth !== rootDepth) return null;
    return [start, this.subtreeEnd(lines, start, rootDepth)];
  }

  private moveOutline(direction: -1 | 1): void {
    const ta = this.textarea;
    if (!ta) return;
    const lines = ta.value.split('\n');
    const startPos = lineColOf(ta.value, ta.selectionStart);
    const endPos = lineColOf(ta.value, ta.selectionEnd);
    const { from, to: selectedTo } = this.selectedLineRange(ta);
    // The block being moved is rooted at `from`'s own depth -- every
    // selected sibling at that depth, each dragged along with its own
    // children, so a subtree never gets orphaned behind or split apart.
    const rootDepth = splitIndent(lines[from] ?? '').depth;
    const to = this.subtreeEnd(lines, selectedTo, rootDepth);

    let newLines: string[];
    let lineShift: number;
    if (direction === -1) {
      const prevStart = this.prevSiblingStart(lines, from, rootDepth);
      if (prevStart === null) return; // no previous sibling at this level -- nothing to swap with
      const prevBlock = lines.slice(prevStart, from);
      const currentBlock = lines.slice(from, to + 1);
      newLines = [...lines.slice(0, prevStart), ...currentBlock, ...prevBlock, ...lines.slice(to + 1)];
      lineShift = -prevBlock.length;
    } else {
      const nextRange = this.nextSiblingRange(lines, to, rootDepth);
      if (nextRange === null) return; // no next sibling at this level
      const [nextStart, nextEnd] = nextRange;
      const currentBlock = lines.slice(from, to + 1);
      const nextBlock = lines.slice(nextStart, nextEnd + 1);
      newLines = [...lines.slice(0, from), ...nextBlock, ...currentBlock, ...lines.slice(nextEnd + 1)];
      lineShift = nextBlock.length;
    }

    ta.value = newLines.join('\n');
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    const newStart = offsetOfLineCol(newLines, startPos.line + lineShift, startPos.col);
    const newEnd = offsetOfLineCol(newLines, endPos.line + lineShift, endPos.col);
    ta.setSelectionRange(newStart, newEnd);
  }
}
