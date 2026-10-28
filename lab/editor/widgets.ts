import { WidgetType, EditorView } from '@codemirror/view';

// Gyazo page URLs (gyazo.com/<id>) are HTML, not images; the raw image lives
// at i.gyazo.com/<id>.png.
export function imageSrc(url: string): string {
  const m = /^https?:\/\/(?:i\.)?gyazo\.com\/([0-9a-fA-F]+)(\.\w+)?/.exec(url);
  if (m) return `https://i.gyazo.com/${m[1]}${m[2] ?? '.png'}`;
  return url;
}

// Click on a rendered widget: put the caret where the widget lives so the
// line expands into raw text. CodeMirror ignores events inside widgets by
// default, so we do it explicitly.
function caretOnMouseDown(dom: HTMLElement, view: EditorView, pos: () => number): void {
  dom.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos() }, scrollIntoView: false });
    view.focus();
  });
}

export class ImageWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }
  eq(other: ImageWidget): boolean {
    return other.url === this.url;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'sb-img';
    const img = document.createElement('img');
    img.src = imageSrc(this.url);
    img.alt = this.url;
    img.loading = 'lazy';
    // Image height arrives late; tell CodeMirror to re-measure the layout.
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('error', () => {
      span.textContent = this.url;
      span.classList.add('sb-img-error');
      view.requestMeasure();
    });
    span.appendChild(img);
    caretOnMouseDown(span, view, () => view.posAtDOM(span));
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export class TableWidget extends WidgetType {
  // firstRowFrom is only here so eq() notices when the block moved; the click
  // handler re-derives line numbers from the live doc.
  constructor(
    readonly name: string,
    readonly rows: string[][],
    readonly firstRowFrom: number,
  ) {
    super();
  }
  eq(other: TableWidget): boolean {
    return (
      other.name === this.name &&
      other.firstRowFrom === this.firstRowFrom &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows)
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'sb-table-wrap';
    const table = document.createElement('table');
    table.className = 'sb-table';
    if (this.name) {
      const cap = document.createElement('caption');
      cap.textContent = this.name;
      table.appendChild(cap);
    }
    this.rows.forEach((cells, i) => {
      const tr = document.createElement('tr');
      tr.dataset.row = String(i);
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const tr = (e.target as HTMLElement).closest('tr');
      const base = view.posAtDOM(wrap);
      let pos = base;
      if (tr) {
        // Land the caret at the end of the clicked row's source line.
        const row = Number(tr.dataset.row);
        const doc = view.state.doc;
        const headLine = doc.lineAt(base);
        const line = doc.line(Math.min(doc.lines, headLine.number + 1 + row));
        pos = line.to;
      }
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
