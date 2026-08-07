/**
 * Aggregates for the Activity view.
 *
 * Everything here is derived from tables that already exist — no counters are
 * maintained alongside the data, so the numbers cannot drift out of step with
 * what actually happened, and a cache rebuilt from the event log produces the
 * same answers.
 *
 * Day bucketing is deliberately done in JS rather than with SQLite's `date()`.
 * The stored timestamps are UTC, and a calendar the user reads is a local one;
 * `date()` would quietly file late-evening work under tomorrow.
 */

import { getDatabase } from './database';
import type { ActivityDay, ActivityStats } from '../shared/types';

const DAY_MS = 86400000;

/** Local `YYYY-MM-DD` for a Date, as the calendar grid keys on. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function keyFromTimestamp(value: string | number | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return localDayKey(date);
}

function toMillis(value: string | number | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Tokens recorded on one `assistant.usage` payload.
 *
 * The SDK has spelled these both ways across versions, and a run whose totals
 * silently read as zero is worse than one that reads slightly high, so both
 * spellings are accepted.
 */
export function tokensFromUsagePayload(payload: string): number {
  let parsed: any;
  try { parsed = JSON.parse(payload); } catch { return 0; }
  const input = Number(parsed?.inputTokens ?? parsed?.input_tokens ?? 0);
  const output = Number(parsed?.outputTokens ?? parsed?.output_tokens ?? 0);
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

/**
 * The largest number of agents that were running at the same moment.
 *
 * A sweep over the start and end of each run: every start raises the count and
 * every end lowers it, so the running maximum is the peak. Ends are processed
 * before starts at an identical timestamp — an agent that finished exactly as
 * another began was never actually concurrent with it.
 */
export function peakConcurrency(
  intervals: ReadonlyArray<{ start: number; end: number }>,
): number {
  const points: Array<{ at: number; delta: number }> = [];
  for (const { start, end } of intervals) {
    points.push({ at: start, delta: 1 });
    // A run that never ticked has end === start. Closing it at the same instant
    // would cancel it out below, since ties close before they open; give it the
    // smallest possible extent so it still counts as one agent.
    points.push({ at: Math.max(end, start + 1), delta: -1 });
  }
  points.sort((a, b) => (a.at - b.at) || (a.delta - b.delta));

  let running = 0;
  let peak = 0;
  for (const point of points) {
    running += point.delta;
    if (running > peak) peak = running;
  }
  return peak;
}

/**
 * Length of the run of consecutive active days ending today.
 *
 * A streak that ends yesterday still counts: the day is not over, and zeroing
 * somebody's streak at midnight for work they have not had the chance to do
 * yet is the one thing that would make the number worth ignoring.
 */
export function streakEndingToday(activeDays: ReadonlySet<string>, today: Date): number {
  if (activeDays.size === 0) return 0;
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!activeDays.has(localDayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!activeDays.has(localDayKey(cursor))) return 0;
  }
  let streak = 0;
  while (activeDays.has(localDayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Longest run of consecutive active days anywhere in the window. */
export function longestStreak(activeDays: ReadonlySet<string>): number {
  const sorted = [...activeDays].sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const key of sorted) {
    const time = new Date(`${key}T00:00:00`).getTime();
    run = previous !== null && time - previous === DAY_MS ? run + 1 : 1;
    previous = time;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * Build the contiguous day series the calendar renders.
 *
 * Days with nothing in them are still emitted: the grid is a shape the user
 * reads at a glance, and a sparse array would collapse the gaps that are the
 * whole point of looking.
 */
export function buildDaySeries(
  counts: Map<string, { spaces: number; agents: number; tokens: number }>,
  windowDays: number,
  today: Date,
): ActivityDay[] {
  const days: ActivityDay[] = [];
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  cursor.setDate(cursor.getDate() - (windowDays - 1));
  for (let i = 0; i < windowDays; i++) {
    const key = localDayKey(cursor);
    const found = counts.get(key);
    days.push({
      date: key,
      spaces: found?.spaces ?? 0,
      agents: found?.agents ?? 0,
      tokens: found?.tokens ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** Read every input the Activity view needs, in one pass over the window. */
export function getActivityStats(windowDays = 182): ActivityStats {
  const db = getDatabase();
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  windowStart.setDate(windowStart.getDate() - (windowDays - 1));
  const cutoffIso = windowStart.toISOString();
  const cutoffMs = windowStart.getTime();

  const counts = new Map<string, { spaces: number; agents: number; tokens: number }>();
  const bump = (key: string | null, field: 'spaces' | 'agents' | 'tokens', by = 1) => {
    if (!key) return;
    const entry = counts.get(key) ?? { spaces: 0, agents: 0, tokens: 0 };
    entry[field] += by;
    counts.set(key, entry);
  };

  const spaceRows = db.prepare(
    `SELECT completed_at, updated_at FROM spaces
     WHERE status = 'done' AND COALESCE(completed_at, updated_at) >= ?`
  ).all(cutoffIso) as Array<{ completed_at: string | null; updated_at: string }>;
  for (const row of spaceRows) bump(keyFromTimestamp(row.completed_at ?? row.updated_at), 'spaces');

  const agentRows = db.prepare(
    `SELECT created_at, updated_at, status FROM agent_sessions WHERE created_at >= ?`
  ).all(cutoffIso) as Array<{ created_at: string; updated_at: string; status: string }>;
  for (const row of agentRows) bump(keyFromTimestamp(row.created_at), 'agents');

  const usageRows = db.prepare(
    `SELECT timestamp, payload FROM agent_chat_events
     WHERE type = 'assistant.usage' AND timestamp >= ?`
  ).all(cutoffIso) as Array<{ timestamp: string; payload: string }>;
  let tokens = 0;
  for (const row of usageRows) {
    const rowTokens = tokensFromUsagePayload(row.payload);
    tokens += rowTokens;
    bump(keyFromTimestamp(row.timestamp), 'tokens', rowTokens);
  }

  const toolCalls = (db.prepare(
    `SELECT COUNT(*) AS n FROM agent_chat_events
     WHERE type = 'tool.execution_start' AND timestamp >= ?`
  ).get(cutoffIso) as { n: number }).n;

  const subagents = (db.prepare(
    `SELECT COUNT(*) AS n FROM subagent_records WHERE started_at >= ?`
  ).get(cutoffMs) as { n: number }).n;

  // A run with no recorded end is still going, so it is concurrent with
  // everything happening now rather than with nothing.
  const nowMs = now.getTime();
  const intervals = agentRows.flatMap(row => {
    const start = toMillis(row.created_at);
    if (start === null) return [];
    const isOpen = row.status === 'running' || row.status === 'waiting-approval';
    const end = isOpen ? nowMs : toMillis(row.updated_at) ?? start;
    return [{ start, end }];
  });

  const days = buildDaySeries(counts, windowDays, now);
  const activeDays = new Set(
    days.filter(d => d.spaces > 0 || d.agents > 0 || d.tokens > 0).map(d => d.date),
  );
  const busiest = days.reduce<ActivityDay | null>(
    (best, day) => (day.spaces + day.agents > (best ? best.spaces + best.agents : 0) ? day : best),
    null,
  );

  return {
    days,
    totals: {
      tokens,
      agents: agentRows.length,
      subagents,
      spaces: spaceRows.length,
      toolCalls,
      peakParallelAgents: peakConcurrency(intervals),
      activeDays: activeDays.size,
      currentStreak: streakEndingToday(activeDays, now),
      longestStreak: longestStreak(activeDays),
      busiestDay: busiest && busiest.spaces + busiest.agents > 0
        ? { date: busiest.date, count: busiest.spaces + busiest.agents }
        : null,
    },
  };
}
