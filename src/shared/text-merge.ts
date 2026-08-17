/**
 * Line-based three-way merge for canvas content.
 *
 * Given a common base, "ours" (the user's editor state), and "theirs" (the
 * agent's disk version), produces a merged result that preserves both sets
 * of changes.
 *
 * Non-overlapping edits merge cleanly. When both sides edit the same region,
 * the user's version is kept first with the agent's version appended below
 * (surrounded by blank lines for readability), so nothing is ever lost.
 */

export interface MergeResult {
  /** The merged text. */
  merged: string;
  /** True if any region was edited by both sides (overlap). */
  hasConflicts: boolean;
  /** True if theirs was identical to base (no remote changes). */
  noRemoteChanges: boolean;
}

// ── Diff primitives ────────────────────────────────────

interface DiffOp {
  kind: 'equal' | 'insert' | 'delete';
  /** Lines from source A (equal/delete) or source B (insert). */
  lines: string[];
  /** Starting index in source A (for equal/delete). */
  aStart: number;
  /** Starting index in source B (for equal/insert). */
  bStart: number;
}

/**
 * Compute the longest common subsequence table between two line arrays.
 * Returns a 2D table where lcs[i][j] = length of LCS of a[0..i-1], b[0..j-1].
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/**
 * Produce a sequence of diff operations between arrays `a` and `b` by
 * backtracking through the LCS table.
 */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const dp = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;

  // Backtrack from bottom-right to collect equal / delete / insert
  const raw: Array<{ kind: 'equal' | 'insert' | 'delete'; aIdx: number; bIdx: number; line: string }> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      raw.push({ kind: 'equal', aIdx: i - 1, bIdx: j - 1, line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ kind: 'insert', aIdx: i, bIdx: j - 1, line: b[j - 1] });
      j--;
    } else {
      raw.push({ kind: 'delete', aIdx: i - 1, bIdx: j, line: a[i - 1] });
      i--;
    }
  }
  raw.reverse();

  // Group consecutive operations of the same kind
  for (const r of raw) {
    const last = ops[ops.length - 1];
    if (last && last.kind === r.kind) {
      last.lines.push(r.line);
    } else {
      ops.push({ kind: r.kind, lines: [r.line], aStart: r.aIdx, bStart: r.bIdx });
    }
  }

  return ops;
}

// ── Hunk extraction ────────────────────────────────────

interface Hunk {
  /** Starting line in the base (0-indexed). */
  baseStart: number;
  /** Number of lines removed from base. */
  baseCount: number;
  /** Replacement lines. */
  lines: string[];
}

/** Extract change hunks from a diff: regions where base was modified. */
function extractHunks(diff: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let baseIdx = 0;

  let pendingDelete: string[] = [];
  let pendingInsert: string[] = [];
  let deleteStart = -1;

  function flushPending() {
    if (pendingDelete.length > 0 || pendingInsert.length > 0) {
      hunks.push({
        baseStart: deleteStart >= 0 ? deleteStart : baseIdx,
        baseCount: pendingDelete.length,
        lines: [...pendingInsert],
      });
      pendingDelete = [];
      pendingInsert = [];
      deleteStart = -1;
    }
  }

  for (const op of diff) {
    if (op.kind === 'equal') {
      flushPending();
      baseIdx += op.lines.length;
    } else if (op.kind === 'delete') {
      if (deleteStart < 0) deleteStart = baseIdx;
      pendingDelete.push(...op.lines);
      baseIdx += op.lines.length;
    } else {
      // insert
      if (deleteStart < 0) deleteStart = baseIdx;
      pendingInsert.push(...op.lines);
    }
  }
  flushPending();

  return hunks;
}

// ── Three-way merge ────────────────────────────────────

/**
 * Check if two hunks overlap (including adjacency, which we treat as conflict
 * to be safe).
 *
 * Pure insertions have a zero-length base range, so a strict interval test
 * would never report them as overlapping. Two sides inserting at the same
 * point (or one inserting inside the other's replaced range) do collide, so
 * insertions are compared with inclusive bounds.
 */
function hunksOverlap(a: Hunk, b: Hunk): boolean {
  const aEnd = a.baseStart + a.baseCount;
  const bEnd = b.baseStart + b.baseCount;
  if (a.baseCount === 0 || b.baseCount === 0) {
    return a.baseStart <= bEnd && b.baseStart <= aEnd;
  }
  return a.baseStart < bEnd && b.baseStart < aEnd;
}

/** Lines that carry content, normalized for comparison. */
function significantLines(lines: string[]): string[] {
  return lines.map(l => l.trim()).filter(l => l.length > 0);
}

/**
 * True if `outer` already contains every significant line of `inner` as a
 * contiguous run. Used to avoid re-emitting agent content the user's copy
 * already has (which is what produced duplicated sections).
 */
function containsBlock(outer: string[], inner: string[]): boolean {
  const hay = significantLines(outer);
  const needle = significantLines(inner);
  if (needle.length === 0) return true;
  if (needle.length > hay.length) return false;

  for (let i = 0; i + needle.length <= hay.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Three-way merge.
 *
 * @param base  The common ancestor (last known synchronized content).
 * @param ours  The user's current editor content.
 * @param theirs The new content from disk (agent's version).
 * @returns The merged result.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  // Fast paths
  if (base === theirs) {
    return { merged: ours, hasConflicts: false, noRemoteChanges: true };
  }
  if (base === ours) {
    return { merged: theirs, hasConflicts: false, noRemoteChanges: false };
  }
  if (ours === theirs) {
    return { merged: ours, hasConflicts: false, noRemoteChanges: false };
  }

  const baseLines = base.split('\n');
  const ourLines = ours.split('\n');
  const theirLines = theirs.split('\n');

  const ourDiff = diffLines(baseLines, ourLines);
  const theirDiff = diffLines(baseLines, theirLines);

  const ourHunks = extractHunks(ourDiff);
  const theirHunks = extractHunks(theirDiff);

  // Detect overlapping hunks
  let hasConflicts = false;
  const conflictingTheirHunks = new Set<number>();
  // "Their" hunks whose content the user's version already contains. These are
  // suppressed rather than appended, so shared content isn't duplicated.
  const duplicateTheirHunks = new Set<number>();

  for (let ti = 0; ti < theirHunks.length; ti++) {
    const overlapping = ourHunks.filter(oh => hunksOverlap(oh, theirHunks[ti]));
    if (overlapping.length === 0) continue;
    conflictingTheirHunks.add(ti);
    if (overlapping.some(oh => containsBlock(oh.lines, theirHunks[ti].lines))) {
      duplicateTheirHunks.add(ti);
    } else {
      hasConflicts = true;
    }
  }

  // Apply non-conflicting "their" hunks to our content.
  // We start from `ourLines` (which already has the user's edits) and layer
  // in the agent's non-conflicting hunks.  We need to map base-indices to
  // our-indices, accounting for earlier hunks shifting line numbers.
  //
  // Strategy: rebuild from base, choosing the right version for each region.

  const result: string[] = [];
  let baseIdx = 0;

  // Merge all hunks into a single ordered stream with source annotations
  type TaggedHunk = Hunk & { source: 'ours' | 'theirs'; conflictIdx?: number };
  const allHunks: TaggedHunk[] = [
    ...ourHunks.map(h => ({ ...h, source: 'ours' as const })),
    ...theirHunks.map((h, i) => ({ ...h, source: 'theirs' as const, conflictIdx: i })),
  ];
  allHunks.sort((a, b) => a.baseStart - b.baseStart || (a.source === 'ours' ? -1 : 1));

  // Walk through base lines, applying hunks in order
  const appliedOurs = new Set<Hunk>();
  const appliedTheirs = new Set<number>();

  for (const hunk of allHunks) {
    if (hunk.source === 'ours') {
      if (appliedOurs.has(hunk)) continue;

      // Emit base lines up to this hunk
      while (baseIdx < hunk.baseStart) {
        result.push(baseLines[baseIdx]);
        baseIdx++;
      }

      // Emit our replacement
      result.push(...hunk.lines);
      baseIdx = Math.max(baseIdx, hunk.baseStart + hunk.baseCount);
      appliedOurs.add(hunk);

      // For conflicting "their" hunks overlapping this one, append their version
      for (let ti = 0; ti < theirHunks.length; ti++) {
        if (appliedTheirs.has(ti)) continue;
        if (!conflictingTheirHunks.has(ti)) continue;
        if (!hunksOverlap(hunk, theirHunks[ti])) continue;

        if (!duplicateTheirHunks.has(ti)) {
          result.push('');
          result.push(...theirHunks[ti].lines);
        }
        appliedTheirs.add(ti);
        baseIdx = Math.max(baseIdx, theirHunks[ti].baseStart + theirHunks[ti].baseCount);
      }
    } else {
      // "theirs" hunk
      const ti = hunk.conflictIdx!;
      if (appliedTheirs.has(ti)) continue;
      if (conflictingTheirHunks.has(ti)) continue; // handled by "ours" branch

      // Emit base lines up to this hunk
      while (baseIdx < hunk.baseStart) {
        result.push(baseLines[baseIdx]);
        baseIdx++;
      }

      // Emit their replacement
      result.push(...hunk.lines);
      baseIdx = Math.max(baseIdx, hunk.baseStart + hunk.baseCount);
      appliedTheirs.add(ti);
    }
  }

  // Emit remaining base lines
  while (baseIdx < baseLines.length) {
    result.push(baseLines[baseIdx]);
    baseIdx++;
  }

  return {
    merged: result.join('\n'),
    hasConflicts,
    noRemoteChanges: false,
  };
}
