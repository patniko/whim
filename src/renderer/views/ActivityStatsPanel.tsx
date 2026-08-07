import React from 'react';
import { getAPI } from '../ipc-client';
import type { ActivityStats, ActivityDay } from '../../shared/types';

/** Six months of dots is what fits the panel without horizontal scrolling. */
const WINDOW_DAYS = 182;

const EMPTY: ActivityStats = {
  days: [],
  totals: {
    tokens: 0, agents: 0, subagents: 0, spaces: 0, toolCalls: 0,
    peakParallelAgents: 0, activeDays: 0, currentStreak: 0, longestStreak: 0,
    busiestDay: null,
  },
};

/**
 * Short forms so a six-figure token count doesn't wrap its tile.
 * Deliberately lossy — this is a "how hard did I go" number, not an invoice.
 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}

/**
 * Bucket a day's work into one of five dot shades.
 *
 * The thresholds are relative to the busiest day in the window rather than
 * absolute, so the graph stays legible whether a heavy day is three spaces or
 * three hundred.
 */
export function intensityLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 0) return 0;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function dayWeight(day: ActivityDay): number {
  return day.spaces + day.agents;
}

function formatDayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/**
 * Lay the window out in GitHub-style columns of seven, each column a week
 * running Sunday→Saturday. Leading blanks keep weekday rows aligned when the
 * window doesn't start on a Sunday.
 */
export function buildWeeks(days: ActivityDay[]): Array<Array<ActivityDay | null>> {
  if (days.length === 0) return [];
  const weeks: Array<Array<ActivityDay | null>> = [];
  const [fy, fm, fd] = days[0].date.split('-').map(Number);
  let column: Array<ActivityDay | null> = [];
  for (let i = 0; i < new Date(fy, fm - 1, fd).getDay(); i++) column.push(null);
  for (const day of days) {
    column.push(day);
    if (column.length === 7) {
      weeks.push(column);
      column = [];
    }
  }
  if (column.length > 0) {
    while (column.length < 7) column.push(null);
    weeks.push(column);
  }
  return weeks;
}

/** Month names above the columns where a new month begins. */
function monthLabels(weeks: Array<Array<ActivityDay | null>>): Array<{ index: number; label: string }> {
  const labels: Array<{ index: number; label: string }> = [];
  let lastMonth = '';
  weeks.forEach((week, index) => {
    const first = week.find(Boolean);
    if (!first) return;
    const month = first.date.slice(0, 7);
    if (month === lastMonth) return;
    lastMonth = month;
    const [y, m] = month.split('-').map(Number);
    // A month that only owns the tail of a column has no room for its name.
    if (index > 0 && index >= weeks.length - 1) return;
    labels.push({ index, label: new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' }) });
  });
  return labels;
}

function StatTile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="activity-tile" title={hint}>
      <div className="activity-tile-value">{value}</div>
      <div className="activity-tile-label">{label}</div>
    </div>
  );
}

export function ActivityGraph({ days }: { days: ActivityDay[] }): React.ReactElement | null {
  const weeks = React.useMemo(() => buildWeeks(days), [days]);
  const max = React.useMemo(
    () => days.reduce((acc, d) => Math.max(acc, dayWeight(d)), 0),
    [days],
  );
  if (weeks.length === 0) return null;
  const labels = monthLabels(weeks);

  return (
    <div className="activity-graph">
      <div className="activity-graph-months">
        {labels.map(l => (
          <span key={l.label + l.index} className="activity-graph-month" style={{ gridColumn: l.index + 1 }}>
            {l.label}
          </span>
        ))}
      </div>
      <div className="activity-graph-grid" role="img" aria-label={`Activity over the last ${days.length} days`}>
        {weeks.map((week, wi) => (
          <div className="activity-graph-week" key={wi}>
            {week.map((day, di) => (
              day ? (
                <div
                  key={day.date}
                  className="activity-dot"
                  data-level={intensityLevel(dayWeight(day), max)}
                  title={`${formatDayLabel(day.date)} — ${day.spaces} space${day.spaces === 1 ? '' : 's'}, ${day.agents} agent${day.agents === 1 ? '' : 's'}${day.tokens > 0 ? `, ${compactNumber(day.tokens)} tokens` : ''}`}
                />
              ) : (
                <div key={`pad-${wi}-${di}`} className="activity-dot activity-dot--pad" />
              )
            ))}
          </div>
        ))}
      </div>
      <div className="activity-graph-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map(level => (
          <div key={level} className="activity-dot" data-level={level} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/**
 * The metrics header of the Activity tab: streaks, spend and throughput over
 * the trailing window, plus the contribution graph.
 */
export function ActivityStatsPanel(): React.ReactElement | null {
  const [stats, setStats] = React.useState<ActivityStats | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const api = getAPI();
    if (!api?.activityStats) return;
    api.activityStats(WINDOW_DAYS)
      .then(result => { if (!cancelled && result) setStats(result); })
      .catch(() => { if (!cancelled) setStats(EMPTY); });
    return () => { cancelled = true; };
  }, []);

  if (!stats) return null;
  const { totals, days } = stats;

  return (
    <div className="activity-panel">
      <div className="activity-tiles">
        <StatTile
          value={compactNumber(totals.tokens)}
          label="tokens"
          hint="Tokens spent by agents and their sub-agents over the last six months."
        />
        <StatTile
          value={compactNumber(totals.agents)}
          label={totals.agents === 1 ? 'agent run' : 'agent runs'}
          hint={totals.subagents > 0 ? `Plus ${totals.subagents} sub-agents.` : undefined}
        />
        <StatTile
          value={String(totals.peakParallelAgents)}
          label="peak parallel"
          hint="The most agents you had running at the same moment."
        />
        <StatTile
          value={compactNumber(totals.toolCalls)}
          label="tool calls"
        />
        <StatTile
          value={String(totals.currentStreak)}
          label={totals.currentStreak === 1 ? 'day streak' : 'day streak'}
          hint={totals.longestStreak > 0 ? `Your best is ${totals.longestStreak} days.` : undefined}
        />
        <StatTile
          value={compactNumber(totals.spaces)}
          label="spaces done"
        />
      </div>

      <ActivityGraph days={days} />

      {totals.busiestDay ? (
        <div className="activity-panel-note">
          Busiest day was <strong>{formatDayLabel(totals.busiestDay.date)}</strong> with {totals.busiestDay.count}
          {' '}
          {totals.busiestDay.count === 1 ? 'thing' : 'things'} done · active {totals.activeDays}
          {' '}
          {totals.activeDays === 1 ? 'day' : 'days'} in the last {days.length}.
        </div>
      ) : null}
    </div>
  );
}
