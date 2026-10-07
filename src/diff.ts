// Line-level diff (classic LCS) used by the sync-conflict banner to show how a
// "(sync conflict)" copy differs from the page it was split off from. Pages
// are a few hundred lines at most, so the O(n*m) table is fine.
export type DiffOp = { kind: 'same' | 'removed' | 'added'; text: string };

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'removed', text: a[i++]! });
    } else {
      ops.push({ kind: 'added', text: b[j++]! });
    }
  }
  while (i < n) ops.push({ kind: 'removed', text: a[i++]! });
  while (j < m) ops.push({ kind: 'added', text: b[j++]! });
  return ops;
}

export function isIdentical(ops: DiffOp[]): boolean {
  return ops.every((op) => op.kind === 'same');
}
