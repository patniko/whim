import React from 'react';
import { spaceStore } from '../state/space-store';
import { historyStore } from '../state/history-store';
import { agentStore } from '../state/agent-store';
import { useStore } from './useStore';
import { timeAgo } from './list-utils';
import { EmptyState } from './EmptyState';
import { ActivityStatsPanel } from './ActivityStatsPanel';
import type { Space } from '../../shared/types';
import type { SpaceEvent } from '../../shared/ipc-contract';

export interface HistoryViewProps {
  onCardClick: (spaceId: string) => void;
  onUnarchive: (spaceId: string) => void;
}

function activeDuration(createdAt: string, completedAt: string | null): string {
  if (!completedAt || !createdAt) return '';
  const diffMs = new Date(completedAt).getTime() - new Date(createdAt).getTime();
  if (diffMs <= 0) return '';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h`;
  return `${Math.floor(diffHrs / 24)}d`;
}

interface CardVariantInfo {
  variant: 'dismissed' | 'session' | 'recurring' | 'completed';
  statusIcon: string;
}

function classifyCard(space: Space, events: SpaceEvent[], agentCount: number): CardVariantInfo {
  const hasDismissed = events.some(e => e.event_type === 'recurrence_dismissed');
  const hadAgentWork = !!space.session_id || agentCount > 0;
  const isRecurring = !!space.recurrence;
  if (hasDismissed) return { variant: 'dismissed', statusIcon: hadAgentWork ? '▶' : isRecurring ? '↻' : '✓' };
  if (hadAgentWork) return { variant: 'session', statusIcon: '▶' };
  if (isRecurring) return { variant: 'recurring', statusIcon: '↻' };
  return { variant: 'completed', statusIcon: '✓' };
}

const HistoryCard = React.memo(function HistoryCard({
  space,
  events,
  agentCount,
  onClick,
  onUnarchive,
}: {
  space: Space;
  events: SpaceEvent[];
  agentCount: number;
  onClick: (id: string) => void;
  onUnarchive: (id: string) => void;
}) {
  const { variant, statusIcon } = classifyCard(space, events, agentCount);
  const completedAgo = space.completed_at ? timeAgo(space.completed_at) : timeAgo(space.updated_at);
  const duration = activeDuration(space.created_at, space.completed_at);

  // A count reads faster than a step-by-step timeline, and the full history is
  // one click away inside the space.
  const rescheduled = events.reduce((n, e) => n + (e.event_type === 'recycled' ? 1 : 0), 0);

  return (
    <div
      className={`history-card history-card--${variant}`}
      data-id={space.id}
      tabIndex={0}
      role="button"
      onClick={() => onClick(space.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(space.id);
        }
      }}
    >
      <span className="history-card-icon">{statusIcon}</span>
      <div className="history-card-body">
        <div className="history-card-title">{space.description}</div>
        <div className="history-card-meta">
          {space.client ? <><span>👤 {space.client}</span><span className="meta-sep">·</span></> : null}
          {agentCount > 0 ? <><span className="history-meta-badge history-meta-badge--agents">⚡ {agentCount}</span><span className="meta-sep">·</span></> : null}
          {space.session_id ? <><span className="history-meta-badge history-meta-badge--session">● session</span><span className="meta-sep">·</span></> : null}
          {duration ? <><span className="history-meta-badge history-meta-badge--duration">⏱ {duration}</span><span className="meta-sep">·</span></> : null}
          {rescheduled > 0 ? <><span className="history-meta-badge history-meta-badge--recycled">↻ {rescheduled}</span><span className="meta-sep">·</span></> : null}
          <span>{completedAgo}</span>
        </div>
      </div>
      <button
        type="button"
        className="history-card-restore"
        title="Restore to Spaces"
        onClick={(e) => { e.stopPropagation(); onUnarchive(space.id); }}
      >
        ↺
      </button>
    </div>
  );
});

const HistoryMiniCard = React.memo(function HistoryMiniCard({ event }: { event: SpaceEvent }) {
  const icon = event.event_type === 'completed' ? '✅' : event.event_type === 'recycled' ? '↻' : '•';
  const time = new Date(event.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const variant = event.event_type === 'completed' ? 'completed' : 'dismissed';
  return (
    <div className={`history-card history-card-mini history-card--${variant}`}>
      <span className="history-card-icon">{icon}</span>
      <div className="history-card-body">
        <div className="history-card-title">{event.space_description || 'Unknown'}</div>
        <div className="history-card-meta">
          <span>{time}</span>
        </div>
      </div>
    </div>
  );
});

export function HistoryView({ onCardClick, onUnarchive }: HistoryViewProps): React.ReactElement {
  const { spaces } = useStore(spaceStore);
  const { events } = useStore(historyStore);
  const agentState = useStore(agentStore);

  const closedSpaces = React.useMemo(() => spaces.filter(s => s.status === 'done'), [spaces]);
  const eventsBySpace = React.useMemo(() => historyStore.getEventsBySpace(), [events]);
  const agentsBySpace = React.useMemo(() => agentStore.getAgentsBySpace(), [agentState.agents]);

  if (closedSpaces.length === 0 && events.length === 0) {
    return (
      <>
        <ActivityStatsPanel />
        <EmptyState
          icon="✨"
          title="Nothing here yet"
          text="Completed spaces and their activity timeline will appear here."
        />
      </>
    );
  }

  // ── Summary stats ────────────────────────────────────
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - (now.getDay() * 86400000);
  let completedToday = 0;
  let completedThisWeek = 0;
  for (const s of closedSpaces) {
    const t = new Date(s.completed_at || s.updated_at).getTime();
    if (t >= todayStart) completedToday++;
    if (t >= weekStart) completedThisWeek++;
  }

  // Sort closed spaces newest first
  const sorted = [...closedSpaces].sort((a, b) =>
    (b.completed_at || b.updated_at).localeCompare(a.completed_at || a.updated_at),
  );

  // Group by date label
  const groups: { label: string; items: Space[] }[] = [];
  const labelIndex = new Map<string, number>();
  for (const space of sorted) {
    const dt = new Date(space.completed_at || space.updated_at);
    const dayStart = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
    let label: string;
    if (dayStart === todayStart) label = 'Today';
    else if (dayStart === todayStart - 86400000) label = 'Yesterday';
    else label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const idx = labelIndex.get(label);
    if (idx !== undefined) {
      groups[idx].items.push(space);
    } else {
      labelIndex.set(label, groups.length);
      groups.push({ label, items: [space] });
    }
  }

  // Orphan events: events that point at spaces no longer in the closed set
  const closedIds = new Set(closedSpaces.map(s => s.id));
  const orphanEvents = events.filter(e => e.space_id && !closedIds.has(e.space_id));
  const orphanGroups: { date: string; items: SpaceEvent[] }[] = [];
  const orphanIndex = new Map<string, number>();
  for (const event of orphanEvents) {
    const date = new Date(event.created_at).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    });
    const idx = orphanIndex.get(date);
    if (idx !== undefined) {
      orphanGroups[idx].items.push(event);
    } else {
      orphanIndex.set(date, orphanGroups.length);
      orphanGroups.push({ date, items: [event] });
    }
  }

  return (
    <>
      <ActivityStatsPanel />

      <div className="activity-summary">
        <div className="activity-summary-stat"><span className="stat-value">{completedToday}</span> today</div>
        <div className="activity-summary-sep" />
        <div className="activity-summary-stat"><span className="stat-value">{completedThisWeek}</span> this week</div>
        <div className="activity-summary-sep" />
        <div className="activity-summary-stat"><span className="stat-value">{sorted.length}</span> total</div>
      </div>

      {groups.map(group => (
        <React.Fragment key={group.label}>
          <div className="history-date-label">{group.label}</div>
          {group.items.map(space => (
            <HistoryCard
              key={space.id}
              space={space}
              events={eventsBySpace.get(space.id) || []}
              agentCount={(agentsBySpace.get(space.id) || []).length}
              onClick={onCardClick}
              onUnarchive={onUnarchive}
            />
          ))}
        </React.Fragment>
      ))}

      {orphanGroups.map(group => (
        <React.Fragment key={`orphan-${group.date}`}>
          <div className="history-date-label">{group.date}</div>
          {group.items.map(event => (
            <HistoryMiniCard key={event.id} event={event} />
          ))}
        </React.Fragment>
      ))}
    </>
  );
}
