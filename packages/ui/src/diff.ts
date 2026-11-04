export interface DiffLine {
  op: '=' | '+' | '-';
  text: string;
}

/**
 * Line diff by longest common subsequence. Inputs past `maxLines` fall back to
 * "all removed, all added" so a huge body cannot stall the renderer.
 */
export function diffLines(before: string, after: string, maxLines = 3000): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim the common prefix and suffix first; most diffs are small edits in big bodies.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ op: '=' as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: '=' as const, text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  let middle: DiffLine[];
  if (ma.length > maxLines || mb.length > maxLines) {
    middle = [...ma.map((text) => ({ op: '-' as const, text })), ...mb.map((text) => ({ op: '+' as const, text }))];
  } else {
    const n = ma.length;
    const m = mb.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = ma[i] === mb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        middle.push({ op: '=', text: ma[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) middle.push({ op: '-', text: ma[i++]! });
      else middle.push({ op: '+', text: mb[j++]! });
    }
    while (i < n) middle.push({ op: '-', text: ma[i++]! });
    while (j < m) middle.push({ op: '+', text: mb[j++]! });
  }
  return [...head, ...middle, ...tail];
}
