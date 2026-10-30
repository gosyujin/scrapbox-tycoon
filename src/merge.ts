// Line-level three-way merge for diverged copies of one page, and the helpers
// for the conflict markers it leaves behind. Used by GitHubSyncStore instead of
// splitting the other device's version off as a separate "(sync conflict)" page.
//
// Two properties matter more than cleverness here:
//
//  1. Symmetric: merge3(base, x, y) and merge3(base, y, x) give the same lines.
//     When two devices both notice the divergence and both merge it, they must
//     produce the *same* page, so that the second one to push finds the remote
//     already equal to its own result and has nothing left to conflict about.
//     (Hence markers carry no device names or times, and the two sides inside a
//     marker block are ordered by the pages' own `updated`, not by "mine/theirs".)
//  2. Never throws content away: whatever cannot be merged cleanly is kept, both
//     sides, inside the page between markers.
import { diffLines } from './diff.js';

export const CONFLICT_START = '<<<<<<< 競合: 先に保存された版';
export const CONFLICT_SEP = '=======';
export const CONFLICT_END = '>>>>>>> 競合: 後に保存された版';

export interface MergeSide {
  lines: string[];
  updated: number;
}

export interface MergeResult {
  lines: string[];
  // Number of marker blocks left in `lines` by this merge.
  conflicts: number;
}

// "Replace base[start, end) with `lines`." start === end is a pure insertion.
interface Change {
  start: number;
  end: number;
  lines: string[];
}

function changesOf(base: string[], side: string[]): Change[] {
  const changes: Change[] = [];
  let i = 0;
  let current: Change | null = null;
  for (const op of diffLines(base, side)) {
    if (op.kind === 'same') {
      current = null;
      i++;
      continue;
    }
    if (!current) {
      current = { start: i, end: i, lines: [] };
      changes.push(current);
    }
    if (op.kind === 'removed') {
      current.end++;
      i++;
    } else {
      current.lines.push(op.text);
    }
  }
  return changes;
}

// Touching ranges (one ends where the other starts) are independent; two
// insertions at the very same spot are treated as overlapping so they get
// combined by the caller.
function overlaps(x: { start: number; end: number }, y: { start: number; end: number }): boolean {
  if (x.start === x.end && y.start === y.end) return x.start === y.start;
  return x.start < y.end && y.start < x.end;
}

function apply(base: string[], start: number, end: number, changes: Change[]): string[] {
  const out: string[] = [];
  let pos = start;
  for (const change of changes) {
    out.push(...base.slice(pos, change.start), ...change.lines);
    pos = change.end;
  }
  out.push(...base.slice(pos, end));
  return out;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// Total order on the two sides that does not depend on which one is "mine".
function sideOrder(a: MergeSide, b: MergeSide): number {
  if (a.updated !== b.updated) return a.updated - b.updated;
  const ta = a.lines.join('\n');
  const tb = b.lines.join('\n');
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

export function merge3(base: string[], x: MergeSide, y: MergeSide): MergeResult {
  const [first, second] = sideOrder(x, y) <= 0 ? [x, y] : [y, x];
  const changesFirst = changesOf(base, first.lines);
  const changesSecond = changesOf(base, second.lines);
  const out: string[] = [];
  let conflicts = 0;
  let pos = 0;
  let i = 0;
  let j = 0;

  while (i < changesFirst.length || j < changesSecond.length) {
    const nf = changesFirst[i];
    const ns = changesSecond[j];
    const takeFirst = !ns || (nf !== undefined && (nf.start < ns.start || (nf.start === ns.start && nf.end <= ns.end)));
    const cluster = { start: 0, end: 0 };
    const fromFirst: Change[] = [];
    const fromSecond: Change[] = [];
    const seed = takeFirst ? nf! : ns!;
    cluster.start = seed.start;
    cluster.end = seed.end;
    (takeFirst ? fromFirst : fromSecond).push(seed);
    if (takeFirst) i++;
    else j++;

    // Pull in every change, from either side, that overlaps what we have so
    // far; one side's change can chain through the other's.
    for (let grew = true; grew; ) {
      grew = false;
      const cf = changesFirst[i];
      if (cf && overlaps(cluster, cf)) {
        fromFirst.push(cf);
        cluster.end = Math.max(cluster.end, cf.end);
        i++;
        grew = true;
      }
      const cs = changesSecond[j];
      if (cs && overlaps(cluster, cs)) {
        fromSecond.push(cs);
        cluster.end = Math.max(cluster.end, cs.end);
        j++;
        grew = true;
      }
    }

    out.push(...base.slice(pos, cluster.start));
    pos = cluster.end;

    const textFirst = apply(base, cluster.start, cluster.end, fromFirst);
    const textSecond = apply(base, cluster.start, cluster.end, fromSecond);
    if (fromSecond.length === 0) {
      out.push(...textFirst);
    } else if (fromFirst.length === 0 || sameLines(textFirst, textSecond)) {
      out.push(...textSecond);
    } else if (cluster.start === cluster.end) {
      // Both sides inserted different lines at the same spot (typically both
      // appended to the end of the page): keep both, older first. Not a
      // conflict -- nothing either side wrote was meant to replace the other.
      out.push(...textFirst, ...textSecond);
    } else {
      conflicts++;
      out.push(CONFLICT_START, ...textFirst, CONFLICT_SEP, ...textSecond, CONFLICT_END);
    }
  }
  out.push(...base.slice(pos));
  return { lines: out, conflicts };
}

// Stand-in base when the real one is unavailable: only the lines both sides
// still share. Everything that differs then counts as changed on both sides, so
// it ends up in markers rather than being guessed at.
export function commonLines(a: string[], b: string[]): string[] {
  return diffLines(a, b)
    .filter((op) => op.kind === 'same')
    .map((op) => op.text);
}

export interface ConflictHunk {
  // Indexes into the page's lines of the START, SEP and END marker lines.
  start: number;
  sep: number;
  end: number;
}

const isStart = (line: string) => line.startsWith('<<<<<<< ');
const isEnd = (line: string) => line.startsWith('>>>>>>> ');

export function findConflictHunks(lines: string[]): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let start = -1;
  let sep = -1;
  lines.forEach((line, index) => {
    if (isStart(line)) {
      start = index;
      sep = -1;
    } else if (line === CONFLICT_SEP && start >= 0 && sep < 0) {
      sep = index;
    } else if (isEnd(line) && start >= 0 && sep >= 0) {
      hunks.push({ start, sep, end: index });
      start = -1;
      sep = -1;
    }
  });
  return hunks;
}

export function hasConflictMarkers(lines: string[]): boolean {
  return findConflictHunks(lines).length > 0;
}

export function hunkSides(lines: string[], hunk: ConflictHunk): { first: string[]; second: string[] } {
  return { first: lines.slice(hunk.start + 1, hunk.sep), second: lines.slice(hunk.sep + 1, hunk.end) };
}

export type HunkChoice = 'first' | 'second' | 'both';

// Replaces one marker block by the chosen side(s). 'both' keeps first then second.
export function resolveConflictHunk(lines: string[], hunk: ConflictHunk, choice: HunkChoice): string[] {
  const { first, second } = hunkSides(lines, hunk);
  const kept = choice === 'first' ? first : choice === 'second' ? second : [...first, ...second];
  return [...lines.slice(0, hunk.start), ...kept, ...lines.slice(hunk.end + 1)];
}
