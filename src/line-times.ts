// Per-line "last edited" times (Scrapbox's "telomere": a bar at the left edge
// of each line that fades as the line gets older). Stored on the page as
// `lineTimes`, a unix-seconds array parallel to `lines`. Pure logic, no DOM.
//
// The editor only ever hands back the new text, so times are carried across an
// edit by diffing old text against new: a line that survives keeps its time,
// anything else counts as edited at `now`.
import { diffLines } from './diff.js';

// Above this many lines in the differing middle section the LCS table (O(n*m))
// is skipped and the whole section is treated as new.
const MAX_DIFF_CELLS = 2_000_000;

// `times` if it is a usable array parallel to `lines`, else `fallback` for every
// line. Pages written before this feature (or by an older client that dropped
// the field) land in the fallback branch.
export function normalizeLineTimes(lines: string[], times: number[] | undefined, fallback: number): number[] {
  if (Array.isArray(times) && times.length === lines.length && times.every((t) => typeof t === 'number' && Number.isFinite(t))) {
    return times;
  }
  return lines.map(() => fallback);
}

// Times for `newLines`, carrying over `oldTimes` for lines that did not change.
export function reconcileLineTimes(oldLines: string[], oldTimes: number[], newLines: string[], now: number): number[] {
  let head = 0;
  const max = Math.min(oldLines.length, newLines.length);
  while (head < max && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < max - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;

  const out: number[] = oldTimes.slice(0, head);
  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);
  if (newMid.length > 0) {
    if (oldMid.length === 0 || oldMid.length * newMid.length > MAX_DIFF_CELLS) {
      for (let i = 0; i < newMid.length; i++) out.push(now);
    } else {
      let o = head;
      for (const op of diffLines(oldMid, newMid)) {
        if (op.kind === 'same') out.push(oldTimes[o++] ?? now);
        else if (op.kind === 'removed') o++;
        else out.push(now);
      }
    }
  }
  for (let i = 0; i < tail; i++) out.push(oldTimes[oldLines.length - tail + i] ?? now);
  return out;
}

export interface TimedLines {
  lines: string[];
  times: number[];
}

// Times for a merged page: each line takes the newest time of the same line in
// the sources it came from (matched by diff, so duplicates line up in order).
// Deterministic for a given set of sources, whatever order they are passed in.
export function mergeLineTimes(lines: string[], sources: TimedLines[], now: number): number[] {
  const best: number[] = lines.map(() => -Infinity);
  for (const src of sources) {
    const t = reconcileLineTimes(src.lines, src.times, lines, -Infinity);
    t.forEach((v, i) => {
      if (v > best[i]!) best[i] = v;
    });
  }
  return best.map((v) => (v === -Infinity ? now : v));
}

// How "fresh" a line looks: 0 = edited moments ago ... 5 = over a year old.
export const TELOMERE_LEVELS = 6;
const LEVEL_LIMITS_SEC = [60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60, 30 * 24 * 60 * 60, 365 * 24 * 60 * 60];

export function telomereLevel(time: number, now: number): number {
  const age = Math.max(0, now - time);
  const i = LEVEL_LIMITS_SEC.findIndex((limit) => age < limit);
  return i === -1 ? LEVEL_LIMITS_SEC.length : i;
}
