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

export class MergeLimitError extends Error {
  constructor() {
    super('merge_resource_limit: Both versions are unchanged. Save a separate copy before resolving this merge.');
    this.name = 'MergeLimitError';
  }
}

// Bound input, traceback storage and total work independently. There is no
// lossy fallback: callers must retain both inputs when a budget is exceeded.
const MAX_CHARACTERS = 8 * 1024 * 1024;
const MAX_LINES = 200_000;
const MAX_CELLS = 32 * 1024 * 1024;

export function needsMergeWorker(base: string, ours: string, theirs: string): boolean {
  if (base === theirs || base === ours || ours === theirs) return false;
  if (base.length + ours.length + theirs.length > 32_768) return true;
  let lines = 0;
  for (const text of [base, ours, theirs]) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 && ++lines > 256) return true;
    }
  }
  return false;
}

/**
 * Adaptive edit-distance band with packed traceback. Typical small edits use
 * O(lines * edits) work/storage, capped at 8 MiB of traceback per pass.
 * Exported for canonical-alignment regression tests.
 */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  // Suffix trimming follows the original bottom-right traceback exactly.
  let endA = a.length;
  let endB = b.length;
  while (endA > 0 && endB > 0 && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  let start = 0;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  // Repeated lines can make blindly trimming a prefix change conflict
  // boundaries. Only trim when no prefix line occurs in either remainder.
  const remainder = new Set([...a.slice(start, endA), ...b.slice(start, endB)]);
  if (a.slice(0, start).some(line => remainder.has(line))) start = 0;
  const m = endA - start;
  const n = endB - start;
  let band = Math.max(4, Math.abs(m - n));
  let budget = MAX_CELLS;
  let trace: Uint8Array;
  let width: number;
  for (;;) {
    band = Math.min(band, Math.max(m, n));
    width = 2 * band + 1;
    const cells = (m + 1) * width;
    if (cells > budget) throw new MergeLimitError();
    budget -= cells;
    trace = new Uint8Array(Math.ceil(cells / 4));
    let previous = new Int32Array(width).fill(MAX_LINES * 3);
    let current = new Int32Array(width);
    for (let i = 0; i <= m; i++) {
      current.fill(MAX_LINES * 3);
      for (let j = Math.max(0, i - band); j <= Math.min(n, i + band); j++) {
        const k = j - i + band;
        let direction = 0;
        if (i === 0 && j === 0) {
          current[k] = 0;
        } else if (i > 0 && j > 0 && a[start + i - 1] === b[start + j - 1]) {
          current[k] = previous[k];
        } else {
          const insert = j > 0 && k > 0 ? current[k - 1] + 1 : MAX_LINES * 3;
          const remove = i > 0 && k + 1 < width ? previous[k + 1] + 1 : MAX_LINES * 3;
          // LCS backtracking prefers insertion on ties; keep that canonical
          // alignment, including repeated blank lines and identical headings.
          direction = insert <= remove ? 1 : 2;
          current[k] = Math.min(insert, remove);
        }
        const cell = i * width + k;
        trace[cell >>> 2] |= direction << ((cell & 3) * 2);
      }
      [previous, current] = [current, previous];
    }
    // Every optimal path with edit distance <= band fits inside this band.
    // Thus the narrow traceback has exactly the full LCS's tie semantics.
    if (previous[n - m + band] <= band || band === Math.max(m, n)) break;
    band *= 2;
  }
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;

  // Backtrack from bottom-right to collect equal / delete / insert
  const raw: Array<{ kind: 'equal' | 'insert' | 'delete'; aIdx: number; bIdx: number; line: string }> = [];
  while (i > 0 || j > 0) {
    const cell = i * width + j - i + band;
    const direction = (trace[cell >>> 2] >>> ((cell & 3) * 2)) & 3;
    if (direction === 0 && i > 0 && j > 0) {
      raw.push({ kind: 'equal', aIdx: start + i - 1, bIdx: start + j - 1, line: a[start + i - 1] });
      i--;
      j--;
    } else if (direction === 1) {
      raw.push({ kind: 'insert', aIdx: start + i, bIdx: start + j - 1, line: b[start + j - 1] });
      j--;
    } else {
      raw.push({ kind: 'delete', aIdx: start + i - 1, bIdx: start + j, line: a[start + i - 1] });
      i--;
    }
  }
  raw.reverse();
  if (start > 0) ops.push({ kind: 'equal', lines: a.slice(0, start), aStart: 0, bStart: 0 });

  // Group consecutive operations of the same kind
  for (const r of raw) {
    const last = ops[ops.length - 1];
    if (last && last.kind === r.kind) {
      last.lines.push(r.line);
    } else {
      ops.push({ kind: r.kind, lines: [r.line], aStart: r.aIdx, bStart: r.bIdx });
    }
  }
  if (endA < a.length) {
    ops.push({ kind: 'equal', lines: a.slice(endA), aStart: endA, bStart: endB });
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
      for (const line of op.lines) pendingDelete.push(line);
      baseIdx += op.lines.length;
    } else {
      // insert
      if (deleteStart < 0) deleteStart = baseIdx;
      for (const line of op.lines) pendingInsert.push(line);
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

  const prefix = new Int32Array(needle.length);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j > 0 && needle[i] !== needle[j]) j = prefix[j - 1];
    if (needle[i] === needle[j]) j++;
    prefix[i] = j;
  }
  for (let i = 0, j = 0; i < hay.length; i++) {
    while (j > 0 && hay[i] !== needle[j]) j = prefix[j - 1];
    if (hay[i] === needle[j]) j++;
    if (j === needle.length) return true;
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

  if (base.length + ours.length + theirs.length > MAX_CHARACTERS) throw new MergeLimitError();
  let lineCount = 3;
  for (const text of [base, ours, theirs]) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 && ++lineCount > MAX_LINES) throw new MergeLimitError();
    }
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

  const conflictsByOurs = new Map<Hunk, number[]>();
  let firstOurs = 0;
  for (let ti = 0; ti < theirHunks.length; ti++) {
    const theirs = theirHunks[ti];
    while (firstOurs < ourHunks.length &&
      ourHunks[firstOurs].baseStart + ourHunks[firstOurs].baseCount < theirs.baseStart) firstOurs++;
    const overlapping: Hunk[] = [];
    for (let oi = firstOurs; oi < ourHunks.length &&
      ourHunks[oi].baseStart <= theirs.baseStart + theirs.baseCount; oi++) {
      const ours = ourHunks[oi];
      if (!hunksOverlap(ours, theirs)) continue;
      overlapping.push(ours);
      const indices = conflictsByOurs.get(ours) ?? [];
      indices.push(ti);
      conflictsByOurs.set(ours, indices);
    }
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
  type TaggedHunk = Hunk & { source: 'ours' | 'theirs'; conflictIdx?: number; original?: Hunk };
  const allHunks: TaggedHunk[] = [
    ...ourHunks.map(h => ({ ...h, source: 'ours' as const, original: h })),
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
      for (const line of hunk.lines) result.push(line);
      baseIdx = Math.max(baseIdx, hunk.baseStart + hunk.baseCount);
      appliedOurs.add(hunk);

      // For conflicting "their" hunks overlapping this one, append their version
      for (const ti of conflictsByOurs.get(hunk.original!) ?? []) {
        if (appliedTheirs.has(ti)) continue;
        if (!conflictingTheirHunks.has(ti)) continue;
        if (!hunksOverlap(hunk, theirHunks[ti])) continue;

        if (!duplicateTheirHunks.has(ti)) {
          result.push('');
          for (const line of theirHunks[ti].lines) result.push(line);
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
      for (const line of hunk.lines) result.push(line);
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
