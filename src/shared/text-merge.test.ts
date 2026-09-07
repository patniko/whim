import { describe, it, expect } from 'vitest';
import { merge3, diffLines, needsMergeWorker, MergeLimitError } from './text-merge';

describe('merge3', () => {
  // ── Fast paths ──────────────────────────────────────────

  it('returns ours when theirs === base (no remote changes)', () => {
    const base = 'line1\nline2\nline3';
    const ours = 'line1\nEDITED\nline3';
    const theirs = base;
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe(ours);
    expect(r.hasConflicts).toBe(false);
    expect(r.noRemoteChanges).toBe(true);
  });

  describe('bounded canonical diff', () => {
    function reference(a: string[], b: string[]) {
      const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
        }
      }
      const ops: Array<{ kind: string; line: string }> = [];
      let i = a.length;
      let j = b.length;
      while (i || j) {
        if (i && j && a[i - 1] === b[j - 1]) {
          ops.push({ kind: 'equal', line: a[--i] });
          j--;
        } else if (j && (!i || table[i][j - 1] >= table[i - 1][j])) {
          ops.push({ kind: 'insert', line: b[--j] });
        } else {
          ops.push({ kind: 'delete', line: a[--i] });
        }
      }
      return ops.reverse();
    }

    it('preserves full-LCS tie alignment on repeated lines, blanks and insertions', () => {
      let seed = 9741;
      const random = (n: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed >>> 12) % n;
      };
      for (let trial = 0; trial < 2000; trial++) {
        const a = Array.from({ length: random(35) }, () => ['A', 'B', '', 'C'][random(4)]);
        const b = Array.from({ length: random(35) }, () => ['A', 'B', '', 'C'][random(4)]);
        expect(diffLines(a, b).flatMap(op => op.lines.map(line => ({ kind: op.kind, line }))))
          .toEqual(reference(a, b));
      }
    });

    it('merges separated edits in a 4000-line document without changing output shape', () => {
      const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
      const ours = [...lines];
      const theirs = [...lines];
      ours[10] = 'local';
      ours[3900] = 'local tail';
      theirs[2000] = 'remote';
      const expected = [...ours];
      expected[2000] = 'remote';
      expect(merge3(lines.join('\n'), ours.join('\n'), theirs.join('\n')))
        .toEqual({ merged: expected.join('\n'), hasConflicts: false, noRemoteChanges: false });
      expect(needsMergeWorker(lines.join('\n'), ours.join('\n'), theirs.join('\n'))).toBe(true);
    });

    it('rejects excessive input and edit-distance work rather than producing a lossy merge', () => {
      expect(() => merge3('base', 'x'.repeat(8 * 1024 * 1024), 'remote')).toThrow(MergeLimitError);
      expect(() => merge3('a\n'.repeat(70_000), 'b\n'.repeat(70_000), 'c\n'.repeat(70_000))).toThrow(MergeLimitError);
      const unrelated = (prefix: string) => Array.from({ length: 6000 }, (_, i) => `${prefix}${i}`).join('\n');
      expect(() => merge3(unrelated('a'), unrelated('b'), unrelated('c'))).toThrow(MergeLimitError);
    });

    it('does not require workers for identical-version fast paths', () => {
      const huge = 'x'.repeat(9 * 1024 * 1024);
      expect(needsMergeWorker('base', huge, 'base')).toBe(false);
      expect(merge3('base', huge, 'base').merged).toBe(huge);
    });
  });

  it('returns theirs when ours === base (no local changes)', () => {
    const base = 'line1\nline2\nline3';
    const ours = base;
    const theirs = 'line1\nAGENT\nline3';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe(theirs);
    expect(r.hasConflicts).toBe(false);
    expect(r.noRemoteChanges).toBe(false);
  });

  it('returns ours when both made identical changes', () => {
    const base = 'line1\nline2\nline3';
    const both = 'line1\nSAME\nline3';
    const r = merge3(base, both, both);
    expect(r.merged).toBe(both);
    expect(r.hasConflicts).toBe(false);
  });

  // ── Non-overlapping edits ───────────────────────────────

  it('merges non-overlapping edits cleanly (user edits top, agent edits bottom)', () => {
    const base = 'line1\nline2\nline3\nline4\nline5';
    const ours = 'USER\nline2\nline3\nline4\nline5';
    const theirs = 'line1\nline2\nline3\nline4\nAGENT';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe('USER\nline2\nline3\nline4\nAGENT');
    expect(r.hasConflicts).toBe(false);
  });

  it('merges non-overlapping edits (agent adds lines at end)', () => {
    const base = 'line1\nline2';
    const ours = 'USER\nline2';
    const theirs = 'line1\nline2\nnew agent line';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe('USER\nline2\nnew agent line');
    expect(r.hasConflicts).toBe(false);
  });

  it('merges non-overlapping edits (both add in different regions)', () => {
    const base = 'A\nB\nC\nD\nE';
    const ours = 'A\nB-user\nC\nD\nE';
    const theirs = 'A\nB\nC\nD-agent\nE';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe('A\nB-user\nC\nD-agent\nE');
    expect(r.hasConflicts).toBe(false);
  });

  // ── Overlapping edits (conflicts) ───────────────────────

  it('handles overlapping edits by keeping both (user first, then agent)', () => {
    const base = 'line1\nline2\nline3';
    const ours = 'line1\nUSER-EDIT\nline3';
    const theirs = 'line1\nAGENT-EDIT\nline3';
    const r = merge3(base, ours, theirs);
    expect(r.hasConflicts).toBe(true);
    expect(r.merged).toContain('USER-EDIT');
    expect(r.merged).toContain('AGENT-EDIT');
    // User's version should come first
    expect(r.merged.indexOf('USER-EDIT')).toBeLessThan(r.merged.indexOf('AGENT-EDIT'));
  });

  // ── Insertions ──────────────────────────────────────────

  it('merges when agent inserts new lines in the middle', () => {
    const base = 'A\nB\nC';
    const ours = 'A\nB\nC'; // no local changes
    const theirs = 'A\nB\nNEW\nC';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe('A\nB\nNEW\nC');
    expect(r.hasConflicts).toBe(false);
  });

  it('merges when user inserts and agent inserts at different positions', () => {
    const base = 'A\nB\nC\nD';
    const ours = 'A\nUSER-INSERT\nB\nC\nD';
    const theirs = 'A\nB\nC\nAGENT-INSERT\nD';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toContain('USER-INSERT');
    expect(r.merged).toContain('AGENT-INSERT');
    expect(r.hasConflicts).toBe(false);
  });

  // ── Deletions ───────────────────────────────────────────

  it('handles when agent deletes lines the user did not touch', () => {
    const base = 'A\nB\nC\nD';
    const ours = 'A-user\nB\nC\nD';
    const theirs = 'A\nC\nD'; // deleted B
    const r = merge3(base, ours, theirs);
    expect(r.merged).toContain('A-user');
    expect(r.merged).not.toContain('\nB\n');
    expect(r.hasConflicts).toBe(false);
  });

  // ── Empty content ───────────────────────────────────────

  it('handles empty base', () => {
    const base = '';
    const ours = 'user content';
    const theirs = 'agent content';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toContain('user content');
    expect(r.merged).toContain('agent content');
  });

  it('handles when all three are empty', () => {
    const r = merge3('', '', '');
    expect(r.merged).toBe('');
    expect(r.hasConflicts).toBe(false);
  });

  // ── Real-world scenario: user typing while agent appends ──

  it('preserves user typing while agent appends a new section', () => {
    const base = '# My Document\n\nSome content here.\n\n## Section 1\n\nDetails about section 1.';
    const ours = '# My Document\n\nSome content here with my edits.\n\n## Section 1\n\nDetails about section 1.';
    const theirs = '# My Document\n\nSome content here.\n\n## Section 1\n\nDetails about section 1.\n\n## Section 2\n\nAgent added this section.';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toContain('my edits');
    expect(r.merged).toContain('## Section 2');
    expect(r.merged).toContain('Agent added this section.');
    expect(r.hasConflicts).toBe(false);
  });

  it('preserves user typing in one paragraph while agent edits another', () => {
    const base = '# Title\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.';
    const ours = '# Title\n\nParagraph one with user edit.\n\nParagraph two.\n\nParagraph three.';
    const theirs = '# Title\n\nParagraph one.\n\nParagraph two revised by agent.\n\nParagraph three.';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toContain('user edit');
    expect(r.merged).toContain('revised by agent');
    expect(r.hasConflicts).toBe(false);
  });

  // ── Duplication regressions ──

  it('does not duplicate identical insertions made by both sides', () => {
    const base = 'A\nB';
    const ours = 'A\nNEW1\nNEW2\nB';
    const theirs = 'A\nNEW1\nNEW2\nB';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe('A\nNEW1\nNEW2\nB');
  });

  it('does not duplicate agent content the editor copy already has', () => {
    const base = 'A\nB';
    const ours = 'A\nNEW1\nNEW2\nB\ntail';
    const theirs = 'A\nNEW1\nNEW2\nB';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toBe('A\nNEW1\nNEW2\nB\ntail');
    expect(r.hasConflicts).toBe(false);
  });

  it('does not duplicate sections when the editor is a stale-base superset', () => {
    const base = ['# Doc', '', '## TL;DR', '', '* win', ''].join('\n');
    const theirs = ['# Doc', '', '**Date:** x', '', '## TL;DR', '', '* win', '', '## Metrics', '', '| a |', ''].join('\n');
    const ours = theirs + '\n';
    const r = merge3(base, ours, theirs);
    expect(r.merged.match(/## TL;DR/g)).toHaveLength(1);
    expect(r.merged.match(/## Metrics/g)).toHaveLength(1);
    expect(r.merged.match(/\*\*Date:\*\* x/g)).toHaveLength(1);
  });

  it('still keeps both versions when the sides genuinely differ at the same spot', () => {
    const base = 'A\nB';
    const ours = 'A\nMINE\nB';
    const theirs = 'A\nTHEIRS\nB';
    const r = merge3(base, ours, theirs);
    expect(r.merged).toContain('MINE');
    expect(r.merged).toContain('THEIRS');
    expect(r.hasConflicts).toBe(true);
  });
});
