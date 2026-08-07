import { describe, it, expect } from 'vitest';
import { compactNumber, intensityLevel, buildWeeks } from './ActivityStatsPanel';
import type { ActivityDay } from '../../shared/types';

function day(date: string, spaces = 0, agents = 0, tokens = 0): ActivityDay {
  return { date, spaces, agents, tokens };
}

describe('compactNumber', () => {
  it('leaves small counts alone', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(7)).toBe('7');
    expect(compactNumber(999)).toBe('999');
  });

  it('abbreviates thousands and millions so a tile never wraps', () => {
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(12_400)).toBe('12k');
    expect(compactNumber(2_300_000)).toBe('2.3M');
  });

  it('drops a trailing .0 rather than showing "1.0k"', () => {
    expect(compactNumber(1000)).toBe('1k');
    expect(compactNumber(3_000_000)).toBe('3M');
  });

  it('treats nonsense as zero instead of rendering NaN', () => {
    expect(compactNumber(NaN)).toBe('0');
    expect(compactNumber(-5)).toBe('0');
  });
});

describe('intensityLevel', () => {
  it('gives an empty day the empty shade', () => {
    expect(intensityLevel(0, 10)).toBe(0);
  });

  it('scales relative to the busiest day, not an absolute count', () => {
    // The same count reads as "heavy" in a quiet window and "light" in a busy one.
    expect(intensityLevel(4, 4)).toBe(4);
    expect(intensityLevel(4, 100)).toBe(1);
  });

  it('spreads work across all four filled shades', () => {
    expect(intensityLevel(1, 100)).toBe(1);
    expect(intensityLevel(40, 100)).toBe(2);
    expect(intensityLevel(60, 100)).toBe(3);
    expect(intensityLevel(90, 100)).toBe(4);
  });

  it('does not divide by zero on a window with no activity', () => {
    expect(intensityLevel(0, 0)).toBe(0);
  });
});

describe('buildWeeks', () => {
  it('returns nothing for an empty window', () => {
    expect(buildWeeks([])).toEqual([]);
  });

  it('pads the first column so weekday rows line up', () => {
    // 2026-05-20 is a Wednesday, so Sun/Mon/Tue must be blank above it.
    const weeks = buildWeeks([day('2026-05-20')]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]?.date).toBe('2026-05-20');
  });

  it('always emits full seven-cell columns', () => {
    const days = Array.from({ length: 30 }, (_, i) =>
      day(`2026-06-${String(i + 1).padStart(2, '0')}`));
    const weeks = buildWeeks(days);
    expect(weeks.every(w => w.length === 7)).toBe(true);
  });

  it('starts a new column on each Sunday', () => {
    // 2026-05-17 is a Sunday; 2026-05-24 is the next one.
    const days = Array.from({ length: 14 }, (_, i) =>
      day(`2026-05-${String(17 + i).padStart(2, '0')}`));
    const weeks = buildWeeks(days);
    expect(weeks).toHaveLength(2);
    expect(weeks[0][0]?.date).toBe('2026-05-17');
    expect(weeks[1][0]?.date).toBe('2026-05-24');
  });

  it('keeps every day it was given', () => {
    const days = Array.from({ length: 45 }, (_, i) => {
      const d = new Date(2026, 0, 1 + i);
      return day(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    });
    const flat = buildWeeks(days).flat().filter(Boolean);
    expect(flat).toHaveLength(45);
  });
});
