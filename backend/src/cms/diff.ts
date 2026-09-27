import type { DiffLineDto } from '@kachnadocs/shared';

// The response shape is the shared DTO, so the diff the frontend renders and the
// diff this file computes cannot drift apart.
export type DiffLine = DiffLineDto;

/**
 * Line-level diff of two Markdown snapshots, for "compare an older version with
 * the current one" (SPEC.md §1).
 *
 * Plain LCS on lines, deliberately: it is ~40 lines, has no dependency, and is
 * the algorithm every diff viewer's output is judged by — the edits a doc
 * author makes move whole blocks, so line granularity is what reads correctly.
 * ProseMirror JSON would give a structurally better diff, but the frontend would
 * then have to render a tree diff, and this phase's UI is a side panel.
 *
 * Markdown is the comparison basis because it is what a human can read in a
 * panel; the JSON snapshot stays the source of truth for rendering and restore.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // lengths[i][j] = LCS length of a[i..] and b[j..], computed bottom-up so the
  // forward walk below can make the greedy-but-optimal choice at each cell.
  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  // `lengths` has n+1 rows of m+1 columns by construction, so the bounds guards
  // below never fire; they exist because strict indexing types every access as
  // possibly-undefined and a non-null assertion here would only hide that.
  const cell = (row: number, col: number): number => lengths[row]?.[col] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const left = a[i];
      const right = b[j];
      const row = lengths[i];
      if (left === undefined || right === undefined || row === undefined) continue;
      row[j] = left === right ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = a[i];
    const right = b[j];
    if (left === undefined || right === undefined) break;
    if (left === right) {
      out.push({ op: 'equal', text: left, before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      out.push({ op: 'remove', text: left, before: i + 1, after: null });
      i += 1;
    } else {
      out.push({ op: 'add', text: right, before: null, after: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    const left = a[i];
    if (left === undefined) break;
    out.push({ op: 'remove', text: left, before: i + 1, after: null });
    i += 1;
  }
  while (j < m) {
    const right = b[j];
    if (right === undefined) break;
    out.push({ op: 'add', text: right, before: null, after: j + 1 });
    j += 1;
  }
  return out;
}

/** Trailing newline is a line ending, not an empty final line. */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface DiffSummary {
  added: number;
  removed: number;
  unchanged: number;
}

export function summarize(lines: DiffLine[]): DiffSummary {
  return {
    added: lines.filter((l) => l.op === 'add').length,
    removed: lines.filter((l) => l.op === 'remove').length,
    unchanged: lines.filter((l) => l.op === 'equal').length,
  };
}
