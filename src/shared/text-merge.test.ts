import { describe, it, expect } from 'vitest';
import { merge3 } from './text-merge';

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
