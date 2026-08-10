import { describe, it, expect } from 'vitest';
import { buildActivityDays, dayLabel, formatDuration } from './activity-rows';
import type { Space } from '../../shared/types';
import type { SpaceEvent } from '../../shared/ipc-contract';

function space(over: Partial<Space> & { id: string }): Space {
  return {
    id: over.id,
    description: 'A space',
    status: 'done',
    created_at: '2026-05-20T09:00:00.000Z',
    updated_at: '2026-05-20T10:00:00.000Z',
    completed_at: '2026-05-20T10:00:00.000Z',
    ...over,
  } as Space;
}

function event(over: Partial<SpaceEvent> & { id: string }): SpaceEvent {
  return {
    id: over.id,
    space_id: 'gone',
    event_type: 'completed',
    due_at: null,
    due_at_utc: null,
    completed_at: null,
    recurrence_json: null,
    created_at: '2026-05-20T11:00:00.000Z',
    space_description: 'An orphan',
    space_client: null,
    session_id: null,
    ...over,
  } as SpaceEvent;
}

/** A local timestamp, so grouping doesn't depend on the runner's timezone. */
function localIso(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

describe('formatDuration', () => {
  it('scales the unit to the length of the work', () => {
    expect(formatDuration('2026-05-20T09:00:00Z', '2026-05-20T09:45:00Z')).toBe('45m');
    expect(formatDuration('2026-05-20T09:00:00Z', '2026-05-20T12:00:00Z')).toBe('3h');
    expect(formatDuration('2026-05-20T09:00:00Z', '2026-05-23T09:00:00Z')).toBe('3d');
  });

  it('shows nothing rather than a bogus duration', () => {
    expect(formatDuration('2026-05-20T09:00:00Z', null)).toBe('');
    // Clock skew or a bad record must not render "-4m".
    expect(formatDuration('2026-05-20T09:00:00Z', '2026-05-20T08:56:00Z')).toBe('');
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 4, 20, 15);

  it('names the recent days instead of dating them', () => {
    expect(dayLabel('2026-05-20', now)).toBe('Today');
    expect(dayLabel('2026-05-19', now)).toBe('Yesterday');
  });

  it('dates anything older', () => {
    expect(dayLabel('2026-05-17', now)).toBe('Sun, May 17');
  });

  it('adds the year once the day is from another one', () => {
    expect(dayLabel('2025-11-03', now)).toContain('2025');
  });
});

describe('buildActivityDays', () => {
  const now = new Date(2026, 4, 20, 15);
  const noEvents = new Map<string, SpaceEvent[]>();
  const noAgents = new Map<string, unknown[]>();

  it('groups rows under the local day they happened on', () => {
    const days = buildActivityDays(
      [
        space({ id: 'a', completed_at: localIso(2026, 5, 20, 10) }),
        space({ id: 'b', completed_at: localIso(2026, 5, 20, 14) }),
        space({ id: 'c', completed_at: localIso(2026, 5, 18, 9) }),
      ],
      [], noEvents, noAgents, now,
    );
    expect(days.map(d => d.label)).toEqual(['Today', 'Mon, May 18']);
    expect(days[0].rows).toHaveLength(2);
    expect(days[1].rows).toHaveLength(1);
  });

  it('orders days and rows newest first', () => {
    const days = buildActivityDays(
      [
        space({ id: 'old', completed_at: localIso(2026, 5, 18, 9) }),
        space({ id: 'early', completed_at: localIso(2026, 5, 20, 8) }),
        space({ id: 'late', completed_at: localIso(2026, 5, 20, 16) }),
      ],
      [], noEvents, noAgents, now,
    );
    expect(days[0].label).toBe('Today');
    expect(days[0].rows.map(r => r.spaceId)).toEqual(['late', 'early']);
  });

  it('merges loose events into the same day as spaces, not a separate section', () => {
    const days = buildActivityDays(
      [space({ id: 'a', completed_at: localIso(2026, 5, 20, 10) })],
      [event({ id: 'e1', space_id: 'deleted', created_at: localIso(2026, 5, 20, 12) })],
      noEvents, noAgents, now,
    );
    expect(days).toHaveLength(1);
    expect(days[0].rows.map(r => r.kind)).toEqual(['event', 'space']);
  });

  it('drops events whose space is already listed, so nothing is shown twice', () => {
    const days = buildActivityDays(
      [space({ id: 'a', completed_at: localIso(2026, 5, 20, 10) })],
      [event({ id: 'e1', space_id: 'a', created_at: localIso(2026, 5, 20, 12) })],
      noEvents, noAgents, now,
    );
    expect(days[0].rows).toHaveLength(1);
    expect(days[0].rows[0].kind).toBe('space');
  });

  it('leaves orphan events unopenable, since their space is gone', () => {
    const days = buildActivityDays(
      [], [event({ id: 'e1', created_at: localIso(2026, 5, 20, 12) })], noEvents, noAgents, now,
    );
    expect(days[0].rows[0].spaceId).toBeNull();
  });

  it('marks a space that had agent work', () => {
    const days = buildActivityDays(
      [space({ id: 'a', completed_at: localIso(2026, 5, 20, 10) })],
      [], noEvents,
      new Map([['a', [{}, {}]]]),
      now,
    );
    expect(days[0].rows[0].variant).toBe('session');
    expect(days[0].rows[0].agentCount).toBe(2);
  });

  it('counts reschedules instead of listing each one', () => {
    const spaceEvents = new Map<string, SpaceEvent[]>([
      ['a', [
        event({ id: 'e1', space_id: 'a', event_type: 'recycled' }),
        event({ id: 'e2', space_id: 'a', event_type: 'recycled' }),
        event({ id: 'e3', space_id: 'a', event_type: 'completed' }),
      ]],
    ]);
    const days = buildActivityDays(
      [space({ id: 'a', completed_at: localIso(2026, 5, 20, 10) })],
      [], spaceEvents, noAgents, now,
    );
    expect(days[0].rows[0].rescheduled).toBe(2);
  });

  it('falls back to updated_at when a space was never stamped complete', () => {
    const days = buildActivityDays(
      [space({ id: 'a', completed_at: null, updated_at: localIso(2026, 5, 19, 10) })],
      [], noEvents, noAgents, now,
    );
    expect(days[0].label).toBe('Yesterday');
  });

  it('returns nothing when there is nothing to show', () => {
    expect(buildActivityDays([], [], noEvents, noAgents, now)).toEqual([]);
  });

  it('skips rows with an unparseable timestamp rather than making an "Invalid Date" group', () => {
    const days = buildActivityDays(
      [space({ id: 'bad', completed_at: 'not a date', updated_at: 'not a date' })],
      [], noEvents, noAgents, now,
    );
    expect(days).toEqual([]);
  });
});
