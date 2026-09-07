import { describe, expect, it } from 'vitest';
import { enablePerformance, getPerformanceTimings, recordTiming, startTiming } from './performance';
import { merge3 } from './text-merge';

describe('content-free performance fixtures', () => {
  it('records bounded aggregates only, with opt-in and idempotent spans', () => {
    enablePerformance(false);
    recordTiming('merge', 9);
    expect(getPerformanceTimings().merge).toBeUndefined();
    enablePerformance(true);
    const end = startTiming('merge');
    end(false);
    end();
    expect(getPerformanceTimings().merge).toMatchObject({ count: 1, failures: 1 });
    expect(Object.keys(getPerformanceTimings().merge!).sort()).toEqual(['count', 'failures', 'maxMs', 'totalMs']);
    enablePerformance(false);
  });
  it.each([1000, 4000, 10000])('measures exact sparse three-way edits at %i lines', lines => {
    const base = Array.from({ length: lines }, (_, i) => `synthetic line ${i}`);
    const ours = [...base];
    const theirs = [...base];
    ours[10] = 'local first';
    ours[lines - 10] = 'local last';
    theirs[Math.floor(lines / 2)] = 'remote middle';
    const expected = [...ours];
    expected[Math.floor(lines / 2)] = 'remote middle';
    const input = [base.join('\n'), ours.join('\n'), theirs.join('\n')] as const;
    const durations: number[] = [];
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      const result = merge3(...input);
      durations.push(performance.now() - started);
      expect(result).toEqual({ merged: expected.join('\n'), hasConflicts: false, noRemoteChanges: false });
    }
    durations.sort((a, b) => a - b);
    console.info('[fixture:sparse-merge]', {
      lines, samples: durations.length, p95Ms: durations[28], maxMs: durations[29],
      within50ms: durations[28] < 50,
    });
  });
});
