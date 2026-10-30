// Scrapbox's "telomere": a thin bar at the left edge of every line whose
// strength shows how recently that line was edited. The per-line times live in
// a StateField that follows the document through edits (lines touched by a
// change get "now", the rest shift with their text); the page's stored
// lineTimes (src/line-times.ts) only seed it.
import { StateField, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, gutter, GutterMarker } from '@codemirror/view';
import { telomereLevel } from '../src/line-times';

const nowSec = (): number => Math.floor(Date.now() / 1000);

function fit(times: number[], lines: number, fill: number): number[] {
  if (times.length === lines) return times;
  const out = times.slice(0, lines);
  while (out.length < lines) out.push(fill);
  return out;
}

// Times for the document after `tr`: lines inside a changed range are new
// (edited now); lines between ranges map one-to-one onto the old ones.
function mapTimes(times: number[], tr: Transaction, now: number): number[] {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  const out: number[] = [];
  let oldNext = 1;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const oldFirst = oldDoc.lineAt(fromA).number;
    const oldLast = oldDoc.lineAt(toA).number;
    const newLast = newDoc.lineAt(toB).number;
    while (oldNext < oldFirst) out.push(times[oldNext++ - 1] ?? now);
    // newDoc.lineAt(fromB) is `out.length + 1` here (or the line the previous
    // range already filled); either way everything up to newLast is touched.
    while (out.length < newLast) out.push(now);
    oldNext = Math.max(oldNext, oldLast + 1);
  });
  while (oldNext <= oldDoc.lines) out.push(times[oldNext++ - 1] ?? now);
  return fit(out, newDoc.lines, now);
}

class TelomereMarker extends GutterMarker {
  constructor(
    readonly level: number,
    readonly time: number
  ) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof TelomereMarker && other.level === this.level && other.time === this.time;
  }
  toDOM(): Node {
    const el = document.createElement('span');
    el.className = `sbe-tl sbe-tl-${this.level}`;
    el.title = new Date(this.time * 1000).toLocaleString();
    return el;
  }
}

export function telomere(initial: number[]): Extension {
  const field = StateField.define<number[]>({
    create: (state) => fit(initial, state.doc.lines, nowSec()),
    update: (times, tr) => (tr.docChanged ? mapTimes(times, tr, nowSec()) : times),
  });
  return [
    field,
    gutter({
      class: 'sbe-telomere',
      lineMarker(view: EditorView, block) {
        const time = view.state.field(field)[view.state.doc.lineAt(block.from).number - 1];
        return time === undefined ? null : new TelomereMarker(telomereLevel(time, nowSec()), time);
      },
      lineMarkerChange: (u) => u.docChanged,
    }),
  ];
}
