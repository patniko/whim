import React from 'react';
import { spaceStore } from '../state/space-store';
import { historyStore } from '../state/history-store';
import { agentStore } from '../state/agent-store';
import { useStore } from './useStore';
import { EmptyState } from './EmptyState';
import { ActivityStatsPanel } from './ActivityStatsPanel';
import { buildActivityDays, rowTime, type ActivityRow } from './activity-rows';

export interface HistoryViewProps {
  onCardClick: (spaceId: string) => void;
  onUnarchive: (spaceId: string) => void;
}

const ActivityRowItem = React.memo(function ActivityRowItem({
  row,
  onOpen,
  onUnarchive,
}: {
  row: ActivityRow;
  onOpen: (id: string) => void;
  onUnarchive: (id: string) => void;
}) {
  const clickable = row.spaceId !== null;
  const open = () => { if (row.spaceId) onOpen(row.spaceId); };

  return (
    <div
      className={`activity-row activity-row--${row.variant}`}
      data-id={row.spaceId ?? undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? open : undefined}
      onKeyDown={clickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      } : undefined}
    >
      <span className="activity-row-icon" aria-hidden="true">{row.icon}</span>
      <span className="activity-row-title" title={row.title}>{row.title}</span>
      <span className="activity-row-tags">
        {row.client ? <span className="activity-tag">{row.client}</span> : null}
        {row.agentCount > 0 ? (
          <span className="activity-tag activity-tag--agents" title={`${row.agentCount} agents`}>⚡{row.agentCount}</span>
        ) : null}
        {row.hasSession && row.agentCount === 0 ? (
          <span className="activity-tag activity-tag--agents" title="Had an agent session">⚡</span>
        ) : null}
        {row.rescheduled > 0 ? (
          <span className="activity-tag" title={`Rescheduled ${row.rescheduled} times`}>↻{row.rescheduled}</span>
        ) : null}
        {row.duration ? <span className="activity-tag">{row.duration}</span> : null}
      </span>
      <span className="activity-row-time">{rowTime(row.at)}</span>
      {row.spaceId ? (
        <button
          type="button"
          className="activity-row-restore"
          title="Restore to Spaces"
          aria-label={`Restore ${row.title} to Spaces`}
          onClick={(e) => { e.stopPropagation(); onUnarchive(row.spaceId as string); }}
        >
          ↺
        </button>
      ) : (
        <span className="activity-row-restore activity-row-restore--empty" aria-hidden="true" />
      )}
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

  const days = React.useMemo(
    () => buildActivityDays(closedSpaces, events, eventsBySpace, agentsBySpace, new Date()),
    [closedSpaces, events, eventsBySpace, agentsBySpace],
  );

  if (days.length === 0) {
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

  return (
    <>
      <ActivityStatsPanel />

      {days.map(day => (
        <div className="activity-day" key={day.key}>
          <div className="activity-day-header">
            <span className="activity-day-label">{day.label}</span>
            <span className="activity-day-count">{day.rows.length}</span>
          </div>
          <div className="activity-day-rows">
            {day.rows.map(row => (
              <ActivityRowItem
                key={row.key}
                row={row}
                onOpen={onCardClick}
                onUnarchive={onUnarchive}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
