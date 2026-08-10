import type { Space } from '../../shared/types';
import type { SpaceEvent } from '../../shared/ipc-contract';

export type ActivityRowKind = 'space' | 'event';

export interface ActivityRow {
  key: string;
  kind: ActivityRowKind;
  /** Present for rows that can be opened or restored. */
  spaceId: string | null;
  at: number;
  icon: string;
  variant: 'dismissed' | 'session' | 'recurring' | 'completed';
  title: string;
  client: string | null;
  agentCount: number;
  hasSession: boolean;
  /** Wall-clock duration of the space, pre-formatted; empty when unknown. */
  duration: string;
  rescheduled: number;
}

export interface ActivityDayGroup {
  /** Local day key, `YYYY-MM-DD` — stable for React and for sorting. */
  key: string;
  label: string;
  rows: ActivityRow[];
}

/** Compact wall-clock duration: 45m, 3h, 2d. Empty when it can't be known. */
export function formatDuration(createdAt: string, completedAt: string | null): string {
  if (!completedAt || !createdAt) return '';
  const diffMs = new Date(completedAt).getTime() - new Date(createdAt).getTime();
  if (diffMs <= 0) return '';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function classify(
  space: Space,
  events: SpaceEvent[],
  agentCount: number,
): { variant: ActivityRow['variant']; icon: string } {
  const dismissed = events.some(e => e.event_type === 'recurrence_dismissed');
  const hadAgentWork = !!space.session_id || agentCount > 0;
  const recurring = !!space.recurrence;
  if (dismissed) return { variant: 'dismissed', icon: hadAgentWork ? '▶' : recurring ? '↻' : '✓' };
  if (hadAgentWork) return { variant: 'session', icon: '▶' };
  if (recurring) return { variant: 'recurring', icon: '↻' };
  return { variant: 'completed', icon: '✓' };
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today" / "Yesterday" / "Wed, May 20" — relative to the caller's `now`. */
export function dayLabel(key: string, now: Date): string {
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Clock time for the row's right-hand column. */
export function rowTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Flatten closed spaces and loose timeline events into one list of rows
 * bucketed by local day, newest day and newest row first.
 *
 * Spaces and events are merged into the same day rather than listed in
 * separate sections: they happened on the same day, so splitting them made the
 * reader scan the same dates twice.
 */
export function buildActivityDays(
  closedSpaces: Space[],
  events: SpaceEvent[],
  eventsBySpace: Map<string, SpaceEvent[]>,
  agentsBySpace: Map<string, unknown[]>,
  now: Date,
): ActivityDayGroup[] {
  const rows: ActivityRow[] = [];

  for (const space of closedSpaces) {
    const spaceEvents = eventsBySpace.get(space.id) || [];
    const agentCount = (agentsBySpace.get(space.id) || []).length;
    const { variant, icon } = classify(space, spaceEvents, agentCount);
    const stamp = space.completed_at || space.updated_at;
    rows.push({
      key: `space-${space.id}`,
      kind: 'space',
      spaceId: space.id,
      at: new Date(stamp).getTime(),
      icon,
      variant,
      title: space.description || 'Untitled',
      client: space.client || null,
      agentCount,
      hasSession: !!space.session_id,
      duration: formatDuration(space.created_at, space.completed_at),
      rescheduled: spaceEvents.reduce((n, e) => n + (e.event_type === 'recycled' ? 1 : 0), 0),
    });
  }

  // Events whose space is no longer in the closed set — the only trace left of
  // work on a space that was deleted or reopened.
  const closedIds = new Set(closedSpaces.map(s => s.id));
  for (const event of events) {
    if (!event.space_id || closedIds.has(event.space_id)) continue;
    rows.push({
      key: `event-${event.id}`,
      kind: 'event',
      spaceId: null,
      at: new Date(event.created_at).getTime(),
      icon: event.event_type === 'completed' ? '✓' : event.event_type === 'recycled' ? '↻' : '•',
      variant: event.event_type === 'completed' ? 'completed' : 'dismissed',
      title: event.space_description || 'Untitled',
      client: event.space_client || null,
      agentCount: 0,
      hasSession: false,
      duration: '',
      rescheduled: 0,
    });
  }

  rows.sort((a, b) => b.at - a.at);

  const groups: ActivityDayGroup[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.at)) continue;
    const key = dayKey(row.at);
    const existing = index.get(key);
    if (existing !== undefined) {
      groups[existing].rows.push(row);
    } else {
      index.set(key, groups.length);
      groups.push({ key, label: dayLabel(key, now), rows: [row] });
    }
  }
  return groups;
}
