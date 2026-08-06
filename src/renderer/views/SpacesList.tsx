import React from 'react';
import { spaceStore } from '../state/space-store';
import { agentStore } from '../state/agent-store';
import { skillStore } from '../state/skill-store';
import { canvasArtifactStore } from '../state/canvas-artifact-store';
import { useStore } from './useStore';
import { formatDueDate, timeAgo } from './list-utils';
import { EmptyState, focusCaptureInput } from './EmptyState';
import type { Space, SpaceCanvasArtifact } from '../../shared/types';
import type { AgentListAllItem } from '../../shared/ipc-contract';
import type { RecallMatch } from '../../shared/types';

export interface SpacesListActions {
  onSpaceClick: (spaceId: string) => void;
  onToggleStatus: (spaceId: string) => void;
  onDelete: (spaceId: string) => void;
  onFocus: (spaceId: string) => void;
  onOpenArtifact: (spaceId: string, artifactId: string) => void;
  onAgentClick: (
    agentId: string,
    selectedText: string,
    status: string,
    source: 'sdk' | 'cli' | 'cca',
    spaceId: string,
  ) => void;
}

interface MiniAgentInfo {
  agentId: string;
  status: string;
  summary: string;
  selectedText: string;
  quotedText?: string;
  source?: 'sdk' | 'cli' | 'cca';
}

function miniAgentVisual(agent: MiniAgentInfo): { icon: string; className: string } {
  const isCca = agent.source === 'cca';
  const icon = isCca ? '🔀' :
    agent.status === 'running' ? '⚡' :
    agent.status === 'waiting-approval' ? '⏳' :
    agent.status === 'completed' ? '✓' : '✗';
  const className = agent.status === 'running' ? (isCca ? 'mini-agent-cloud' : 'mini-agent-running') :
    agent.status === 'waiting-approval' ? 'mini-agent-waiting' :
    agent.status === 'completed' ? 'mini-agent-completed' : 'mini-agent-failed';
  return { icon, className };
}

const MiniAgent = React.memo(function MiniAgent({
  agent,
  spaceId,
  onClick,
}: {
  agent: MiniAgentInfo;
  spaceId: string;
  onClick: SpacesListActions['onAgentClick'];
}) {
  const { icon, className } = miniAgentVisual(agent);
  const label = agent.selectedText.length > 50 ? agent.selectedText.slice(0, 47) + '...' : agent.selectedText;
  const tooltip = agent.quotedText ? `${agent.selectedText}\n\nOn: "${agent.quotedText}"` : agent.selectedText;
  return (
    <div
      className={`mini-agent ${className}`}
      data-agent-id={agent.agentId}
      title={tooltip}
      onClick={(e) => {
        e.stopPropagation();
        onClick(agent.agentId, agent.selectedText, agent.status, (agent.source ?? 'sdk') as 'sdk' | 'cli' | 'cca', spaceId);
      }}
    >
      <span className="mini-agent-icon">{icon}</span>
      <span className="mini-agent-label">{label || agent.summary || 'Agent'}</span>
    </div>
  );
});

const SpaceRow = React.memo(function SpaceRow({
  space,
  isActiveSession,
  isFocused,
  isSelected,
  spaceAgents,
  sourceSkill,
  artifact,
  recallHint,
  actions,
}: {
  space: Space;
  isActiveSession: boolean;
  isFocused: boolean;
  isSelected: boolean;
  spaceAgents: AgentListAllItem[];
  sourceSkill: { name: string; emoji: string } | null;
  artifact: SpaceCanvasArtifact | null;
  recallHint: RecallMatch | undefined;
  actions: SpacesListActions;
}) {
  const isRecurring = !!space.recurrence;
  const dueInfo = formatDueDate(space.due_at_utc, space.due_at);
  const hasDue = dueInfo.text !== '';
  const hasRunningAgents = spaceAgents.some(a => a.status === 'running');
  const hasWaitingAgents = spaceAgents.some(a => a.status === 'waiting-approval');
  const hasFailedAgents = spaceAgents.some(a => a.status === 'failed');
  const runningCount = spaceAgents.filter(a => a.status === 'running').length;

  const classes = [
    'space-item',
    space.status === 'done' ? 'done' : '',
    isFocused ? 'focused' : '',
    isSelected ? 'kb-selected' : '',
    hasRunningAgents ? 'has-running-agents' : '',
    hasWaitingAgents ? 'has-waiting-agents' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      data-id={space.id}
      role="button"
      tabIndex={0}
      onClick={() => actions.onSpaceClick(space.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          actions.onSpaceClick(space.id);
        }
      }}
    >
      <div
        className={`space-check ${space.status === 'done' ? 'checked' : ''}`}
        onClick={(e) => { e.stopPropagation(); actions.onToggleStatus(space.id); }}
      >
        {space.status === 'done' ? '✓' : ''}
      </div>
      <div className="space-content">
        <div className={`space-desc ${hasRunningAgents ? 'agent-active' : ''}`}>{space.description}</div>
        <div className="space-meta">
          {sourceSkill ? (
            <span className="source-skill-badge" title={`From skill: ${sourceSkill.name}`}>
              {sourceSkill.emoji || '🧩'} {sourceSkill.name}
            </span>
          ) : null}
          {artifact ? (
            <button
              type="button"
              className="canvas-artifact-chip"
              title={artifact.status ? `${artifact.title} — ${artifact.status}` : `Open ${artifact.title}`}
              onClick={(e) => { e.stopPropagation(); actions.onOpenArtifact(space.id, artifact.artifactId); }}
            >
              📊 {artifact.status || 'Report'}
            </button>
          ) : null}
          {space.client ? <span>👤 {space.client}</span> : null}
          {hasDue ? <span className={`due-badge ${dueInfo.overdue ? 'overdue' : ''}`}>📅 {dueInfo.text}</span> : null}
          {isRecurring ? <span className="recurring-badge">↻</span> : null}
          {isActiveSession
            ? <span className="session-badge running">● running</span>
            : space.session_id
              ? <span className="session-badge">○ session</span>
              : null}
          {hasRunningAgents ? <span className="session-badge running">⚡ {runningCount} working</span> : null}
          {hasWaitingAgents ? <span className="session-badge agent-attention">⏳ needs attention</span> : null}
          {hasFailedAgents ? <span className="session-badge agent-failed-badge">✗ failed</span> : null}
          <span>{timeAgo(space.updated_at)}</span>
        </div>
        {spaceAgents.length > 0 ? (
          <div className="space-agents">
            {spaceAgents.map(agent => (
              <MiniAgent
                key={agent.agentId}
                agent={agent}
                spaceId={space.id}
                onClick={actions.onAgentClick}
              />
            ))}
          </div>
        ) : null}
        <div className={`recall-hint${recallHint ? '' : ' hidden'}`} data-recall-for={space.id}>
          {recallHint ? (
            <>💡 Similar: &quot;{recallHint.description}&quot;{recallHint.completed_at ? ` (done ${timeAgo(recallHint.completed_at)})` : ''}</>
          ) : null}
        </div>
      </div>
      {space.status !== 'done' ? (
        <button
          type="button"
          className={`space-focus ${isFocused ? 'is-focused' : ''}`}
          title={isFocused ? 'Unfocus' : 'Focus'}
          aria-label={isFocused ? 'Unfocus space' : 'Focus space'}
          aria-pressed={isFocused}
          onClick={(e) => { e.stopPropagation(); actions.onFocus(space.id); }}
        >
          🎯
        </button>
      ) : null}
      <button
        type="button"
        className="space-delete"
        title="Delete space"
        aria-label="Delete space"
        onClick={(e) => { e.stopPropagation(); actions.onDelete(space.id); }}
      >
        ✕
      </button>
    </div>
  );
});

export interface SpacesListProps extends SpacesListActions {
  /** When non-null, render these search results instead of the filtered list. */
  searchResults?: Space[] | null;
}

export function SpacesList(props: SpacesListProps): React.ReactElement {
  const { spaces, focusedSpaceId, recallHints, selectedIndex } = useStore(spaceStore);
  const agentState = useStore(agentStore);
  const { skills } = useStore(skillStore);
  useStore(canvasArtifactStore);

  const displayList = React.useMemo<Space[]>(() => {
    if (props.searchResults) return props.searchResults;
    return spaces.filter(s => s.status !== 'done');
  }, [spaces, props.searchResults]);

  const agentsBySpace = React.useMemo(
    () => agentStore.getAgentsBySpace(),
    [agentState.agents],
  );

  const skillByid = React.useMemo(() => {
    const m = new Map<string, { name: string; emoji: string }>();
    for (const s of skills) m.set(s.id, { name: s.name, emoji: s.emoji });
    return m;
  }, [skills]);

  if (displayList.length === 0) {
    return props.searchResults ? (
      <EmptyState icon="🔍" title="No matching spaces" text="Try a different search." />
    ) : (
      <EmptyState
        icon="🎯"
        title="No spaces yet"
        text="Type or speak above to capture your first idea — whim refines it for you."
        cta={{ label: 'Capture a space', onClick: focusCaptureInput }}
      />
    );
  }

  return (
    <>
      {displayList.map((space, idx) => (
        <SpaceRow
          key={space.id}
          space={space}
          isActiveSession={agentState.activeSessionSpaces.has(space.id)}
          isFocused={space.id === focusedSpaceId}
          isSelected={idx === selectedIndex}
          spaceAgents={agentsBySpace.get(space.id) || []}
          sourceSkill={space.source_skill_id ? skillByid.get(space.source_skill_id) || null : null}
          artifact={canvasArtifactStore.getPrimary(space.id)}
          recallHint={recallHints.get(space.id)}
          actions={props}
        />
      ))}
    </>
  );
}
