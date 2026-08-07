import { describe, it, expect } from 'vitest';
import {
  localDayKey,
  tokensFromUsagePayload,
  peakConcurrency,
  streakEndingToday,
  longestStreak,
  buildDaySeries,
} from './activity-stats';

/** Local midnight, so the expectations don't drift with the runner's timezone. */
function day(y: number, m: number, d: number, h = 12): Date {
  return new Date(y, m - 1, d, h);
}

describe('localDayKey', () => {
  it('files a timestamp under the calendar day the user was living in', () => {
    // 23:30 local is still today even though it is tomorrow in UTC for
    // anywhere east of the meridian.
    expect(localDayKey(day(2026, 3, 9, 23))).toBe('2026-03-09');
    expect(localDayKey(day(2026, 3, 10, 0))).toBe('2026-03-10');
  });

  it('zero-pads so the keys sort lexically', () => {
    expect(localDayKey(day(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('tokensFromUsagePayload', () => {
  it('sums input and output tokens', () => {
    expect(tokensFromUsagePayload(JSON.stringify({ inputTokens: 120, outputTokens: 30 }))).toBe(150);
  });

  it('accepts the snake_case spelling the SDK has also used', () => {
    expect(tokensFromUsagePayload(JSON.stringify({ input_tokens: 7, output_tokens: 3 }))).toBe(10);
  });

  it('counts nothing rather than NaN for a payload it cannot read', () => {
    expect(tokensFromUsagePayload('not json')).toBe(0);
    expect(tokensFromUsagePayload(JSON.stringify({ inputTokens: 'lots' }))).toBe(0);
  });
});

describe('peakConcurrency', () => {
  it('is zero with nothing running', () => {
    expect(peakConcurrency([])).toBe(0);
  });

  it('counts overlapping runs, not total runs', () => {
    expect(peakConcurrency([
      { start: 0, end: 100 },
      { start: 50, end: 150 },
      { start: 60, end: 70 },
    ])).toBe(3);
  });

  it('does not count runs that merely follow one another', () => {
    expect(peakConcurrency([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
      { start: 200, end: 300 },
    ])).toBe(1);
  });

  it('handles a run whose end was never recorded', () => {
    expect(peakConcurrency([{ start: 10, end: 10 }])).toBe(1);
  });
});

describe('streakEndingToday', () => {
  const today = day(2026, 5, 20);

  it('counts back through consecutive active days', () => {
    const active = new Set(['2026-05-20', '2026-05-19', '2026-05-18']);
    expect(streakEndingToday(active, today)).toBe(3);
  });

  it('keeps a streak alive on a day the user has not worked yet', () => {
    const active = new Set(['2026-05-19', '2026-05-18']);
    expect(streakEndingToday(active, today)).toBe(2);
  });

  it('is broken by a gap of two days', () => {
    const active = new Set(['2026-05-18', '2026-05-17']);
    expect(streakEndingToday(active, today)).toBe(0);
  });

  it('is zero with no activity at all', () => {
    expect(streakEndingToday(new Set(), today)).toBe(0);
  });
});

describe('longestStreak', () => {
  it('finds the longest run anywhere in the window', () => {
    const active = new Set([
      '2026-05-01', '2026-05-02', '2026-05-03',
      '2026-05-10',
      '2026-05-20', '2026-05-21',
    ]);
    expect(longestStreak(active)).toBe(3);
  });

  it('spans a month boundary', () => {
    expect(longestStreak(new Set(['2026-04-30', '2026-05-01', '2026-05-02']))).toBe(3);
  });

  it('is zero with no activity', () => {
    expect(longestStreak(new Set())).toBe(0);
  });
});

describe('buildDaySeries', () => {
  it('emits every day in the window, including the empty ones', () => {
    const days = buildDaySeries(new Map(), 5, day(2026, 5, 20));
    expect(days).toHaveLength(5);
    expect(days.map(d => d.date)).toEqual([
      '2026-05-16', '2026-05-17', '2026-05-18', '2026-05-19', '2026-05-20',
    ]);
    expect(days.every(d => d.spaces === 0 && d.agents === 0 && d.tokens === 0)).toBe(true);
  });

  it('ends on today so the calendar reads left to right into the present', () => {
    const days = buildDaySeries(new Map(), 3, day(2026, 5, 20));
    expect(days[days.length - 1].date).toBe('2026-05-20');
  });

  it('carries counts onto the day they belong to', () => {
    const counts = new Map([['2026-05-19', { spaces: 2, agents: 4, tokens: 900 }]]);
    const days = buildDaySeries(counts, 3, day(2026, 5, 20));
    expect(days.find(d => d.date === '2026-05-19')).toEqual({
      date: '2026-05-19', spaces: 2, agents: 4, tokens: 900,
    });
  });
});
