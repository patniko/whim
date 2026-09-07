import React from 'react';
import { agentStore, WORKER_PREVIEW_STEPS } from '../state/agent-store';
import { spaceStore } from '../state/space-store';
import { personaStore } from '../state/persona-store';
import { useStore } from './useStore';
import { describeApproval } from './list-utils';
import { EmptyState } from './EmptyState';
import { AgentStatusIcon, StepIcon } from './icons';
import {
  aggregateSandboxBlocks,
  planIncidentResolve,
  type SandboxResolveDecision,
} from '../lib/sandbox-incidents';
import type { AgentListAllItem } from '../../shared/ipc-contract';
import type { AgentStep, AgentApproval, AgentRemoteInfo, AgentSandboxBlock } from '../state/agent-store';
import { VirtualRows } from './VirtualRows';
import { PageControls } from './PageControls';
import { loadAgentsSnapshot } from '../state/ipc-bridge';
import { getAPI } from '../ipc-client';

export interface AgentsListActions {
  onAgentClick: (
    agent: AgentListAllItem,
  ) => void;
  onApprove: (agentId: string, requestId: string) => void;
  onDeny: (agentId: string, requestId: string) => void;
  onDelete: (agentId: string) => void;
  onCanvas: (spaceId: string) => void;
  onToggleYolo: (agentId: string, currentlyEnabled: boolean) => void;
  onToggleSandbox: (agentId: string) => void;
  onToggleRemote: (agentId: string, current: AgentRemoteInfo | undefined, agent: AgentListAllItem) => void;
  /**
   * Resolve a pending sandbox block with the user's decision. Called from the
   * inline SandboxBlockPanel on the agent card.
   */
  onResolveSandboxBlock: (agentId: string, requestId: string, decision: 'allow-once' | 'allow-for-session' | 'disable') => void;
  /** Open the persona editor (Agents tab) scrolled to the sandbox section. */
  onEditSandboxConfig: (personaHandle: string) => void;
}

interface AgentCardProps {
  agent: AgentListAllItem;
  intentLabel: string;
  steps: AgentStep[];
  approval: AgentApproval | undefined;
  sandboxBlocks: AgentSandboxBlock[];
  yoloMode: boolean;
  remote: AgentRemoteInfo | undefined;
  personaEmoji: string;
  isSelected: boolean;
  actions: AgentsListActions;
}

const AgentCard = React.memo(function AgentCard({
  agent,
  intentLabel,
  steps,
  approval,
  sandboxBlocks,
  yoloMode,
  remote,
  personaEmoji,
  isSelected,
  actions,
}: AgentCardProps) {
  const statusClass = agent.status === 'running' ? 'agent-running' :
    agent.status === 'waiting-approval' ? 'agent-waiting' :
    agent.status === 'completed' ? 'agent-completed' : 'agent-failed';

  const sourceLabel = agent.source === 'cca'
    ? <span className="agent-card-source">🤖 Copilot Cloud Agent</span>
    : agent.source === 'cli'
      ? <span className="agent-card-source">🖥 CLI</span>
      : null;

  const title = agent.selectedText.length > 80 ? agent.selectedText.slice(0, 77) + '...' : agent.selectedText;

  const visibleSteps = steps.slice(-WORKER_PREVIEW_STEPS);
  const showSummaryBox = (agent.status === 'completed' || agent.status === 'failed')
    && agent.summary
    && !['Completed', 'Failed', 'Starting...', ''].includes(agent.summary);

  const showLiveStatus = visibleSteps.length === 0 && agent.status === 'running';

  const canShowCanvas = agent.spaceId && agent.spaceId !== '__workspace__' && agent.source !== 'cli';
  const showYolo = agent.status === 'running' || agent.status === 'waiting-approval';
  const showRemote = agent.source === 'sdk' && (agent.status === 'running' || agent.status === 'waiting-approval');
  // sandboxed lives on AgentListAllItem at runtime (added by main); cast for the field access.
  const sandboxed = (agent as unknown as { sandboxed?: boolean }).sandboxed === true;
  const showSandbox = sandboxed && (agent.status === 'running' || agent.status === 'waiting-approval');

  const isYolo = yoloMode;
  const isRemote = !!remote?.enabled;

  const cardTitle = agent.source === 'cca' ? 'Click to open in browser' : 'Click to open chat';

  return (
    <div
      className={`agent-card ${statusClass}${isSelected ? ' kb-selected' : ''}`}
      data-agent-id={agent.agentId}
      title={cardTitle}
      onClick={() => actions.onAgentClick(agent)}
    >
      <div className="agent-card-header">
        <span className="agent-card-icon"><AgentStatusIcon status={agent.status} /></span>
        <span className="agent-card-name">{intentLabel}</span>
        {sourceLabel}
        <div className="agent-card-actions">
          {showSandbox ? (
            <button
              type="button"
              className="agent-card-sandbox-btn active"
              title="Sandbox active — click to disable for this session"
              onClick={(e) => { e.stopPropagation(); actions.onToggleSandbox(agent.agentId); }}
            >
              🔒
            </button>
          ) : null}
          {showYolo ? (
            <button
              type="button"
              className={`agent-card-yolo-btn${isYolo ? ' active' : ''}`}
              title={isYolo ? 'Yolo mode ON — click to disable' : 'Enable yolo mode (auto-approve all)'}
              onClick={(e) => { e.stopPropagation(); actions.onToggleYolo(agent.agentId, isYolo); }}
            >
              🔥
            </button>
          ) : null}
          {showRemote ? (
            <button
              type="button"
              className={`agent-card-remote-btn${isRemote ? ' active' : ''}`}
              title={isRemote ? 'Remote control ON — click to view link' : 'Enable remote control'}
              onClick={(e) => { e.stopPropagation(); actions.onToggleRemote(agent.agentId, remote, agent); }}
            >
              📱
            </button>
          ) : null}
          {canShowCanvas ? (
            <button
              type="button"
              className="agent-card-canvas-btn"
              title="Open canvas"
              onClick={(e) => { e.stopPropagation(); actions.onCanvas(agent.spaceId); }}
            >
              📄
            </button>
          ) : null}
          <button
            type="button"
            className="agent-card-delete-btn"
            title="Delete session"
            onClick={(e) => { e.stopPropagation(); actions.onDelete(agent.agentId); }}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="agent-card-title">
        {personaEmoji ? <span className="agent-card-persona-emoji">{personaEmoji}</span> : null}
        {personaEmoji ? ' ' : null}
        {title}
      </div>
      {agent.quotedText ? (
        <div className="agent-card-snippet" title={agent.quotedText}>{agent.quotedText}</div>
      ) : null}
      {visibleSteps.length > 0 ? (
        <div className="agent-card-steps">
          {visibleSteps.map((step, i) => (
            <React.Fragment key={step.toolCallId}>
              <div className="step-item">
                <StepIcon status={step.status} />
                <span className="step-label">{step.label}</span>
              </div>
              {i < visibleSteps.length - 1 ? <div className="step-connector" /> : null}
            </React.Fragment>
          ))}
        </div>
      ) : showLiveStatus ? (
        <div className="agent-card-steps">
          <div className="step-item">
            <StepIcon status="running" />
            <span className="step-label">{agent.summary}</span>
          </div>
        </div>
      ) : null}
      {showSummaryBox ? <div className="agent-card-summary">{agent.summary}</div> : null}
      {approval ? <ApprovalPanel agentId={agent.agentId} approval={approval} actions={actions} /> : null}
      {aggregateSandboxBlocks(sandboxBlocks).map(incident => (
        <SandboxBlockPanel
          key={incident.key}
          block={incident.sample}
          count={incident.count}
          extraRequestIds={incident.requestIds.slice(1)}
          actions={actions}
        />
      ))}
    </div>
  );
});

function SandboxBlockPanel({
  block,
  count,
  extraRequestIds,
  actions,
}: {
  block: AgentSandboxBlock;
  /** Total number of blocks collapsed into this incident (1 when not aggregated). */
  count: number;
  /** Additional requestIds beyond `block.requestId`, in insertion order. */
  extraRequestIds: string[];
  actions: AgentsListActions;
}): React.ReactElement {
  const decisions = block.allowedDecisions ?? ['allow-once', 'allow-for-session', 'disable'];
  // For post-tool blocks, "Disable" actually disables sandbox AND fires a
  // retry prompt at the agent (see `disableSandboxForSession`), so the
  // button label is "Disable & retry" to set the right expectation. For
  // pre-tool blocks, "Disable" just disables; the tool call that triggered
  // the block proceeds via the broker callback's `allow` result.
  const labels: Record<'allow-once' | 'allow-for-session' | 'disable', string> = {
    'allow-once': 'Allow once',
    'allow-for-session': 'Allow for session',
    'disable': block.source === 'post-tool-shell' ? 'Disable sandbox & retry' : 'Disable sandbox',
  };
  const title = block.source === 'post-tool-shell'
    ? 'Possible sandbox denial'
    : `Sandbox blocked: ${block.kind}${block.toolName ? ` (${block.toolName})` : ''}`;
  const layerLabel = block.layer
    ? (block.layer.startsWith('mxc:') || block.layer.startsWith('mxc-only:')
      ? `Enforced by: MXC (${block.layer})`
      : `Enforced by: host (${block.layer})`)
    : null;

  const allRequestIds = [block.requestId, ...extraRequestIds];
  const resolveIncident = (d: SandboxResolveDecision) => {
    const plan = planIncidentResolve({ requestIds: allRequestIds }, d);
    for (const step of plan) {
      actions.onResolveSandboxBlock(block.agentId, step.requestId, step.decision);
    }
  };

  return (
    <div className="agent-card-sandbox-block" onClick={e => e.stopPropagation()}>
      <div className="sandbox-block-header">
        <span className="sandbox-block-icon">🔒</span>
        <div className="sandbox-block-info">
          <span className="sandbox-block-title">
            {title}
            {count > 1 ? (
              <span
                className="sandbox-incident-count"
                title={`${count} identical attempts collapsed into this incident`}
              >
                ×{count}
              </span>
            ) : null}
          </span>
          {block.personaHandle ? (
            <span className="sandbox-block-persona">@{block.personaHandle}</span>
          ) : null}
          {layerLabel ? <span className="sandbox-block-layer">{layerLabel}</span> : null}
        </div>
      </div>
      <div className="sandbox-block-body">
        {block.intention ? <div className="sandbox-block-intention">{block.intention}</div> : null}
        <div className="sandbox-block-target">Target: {block.target}</div>
      </div>
      <div className="sandbox-block-actions">
        {decisions.map(d => (
          <button
            key={d}
            type="button"
            className="sandbox-block-btn"
            onClick={() => resolveIncident(d)}
          >
            {labels[d]}
          </button>
        ))}
        {block.source === 'post-tool-shell' ? (
          <button
            type="button"
            className="sandbox-block-btn"
            onClick={() => resolveIncident('allow-once')}
          >
            Ignore
          </button>
        ) : null}
        {block.personaHandle ? (
          <button
            type="button"
            className="sandbox-block-btn sandbox-block-btn-edit"
            title={`Open the @${block.personaHandle} persona to tweak its sandbox policy. ` +
              'Changes apply to FUTURE sessions launched with this persona — they do ' +
              'not modify the currently blocked agent.'}
            onClick={() => actions.onEditSandboxConfig(block.personaHandle!)}
          >
            Edit sandbox config
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ApprovalPanel({
  agentId,
  approval,
  actions,
}: {
  agentId: string;
  approval: AgentApproval;
  actions: AgentsListActions;
}): React.ReactElement {
  const { label, detail } = describeApproval(approval);
  return (
    <div className="agent-card-approval">
      <div className="approval-header">
        <span className="approval-icon">⚠️</span>
        <div className="approval-info">
          <span className="approval-label">Permission requested</span>
          <span className="approval-kind">{label}</span>
          {detail ? <span className="approval-detail">{detail}</span> : null}
        </div>
      </div>
      <div className="approval-actions">
        <button
          type="button"
          className="approval-btn approve"
          onClick={(e) => { e.stopPropagation(); actions.onApprove(agentId, approval.requestId); }}
        >
          Approve
        </button>
        <button
          type="button"
          className="approval-btn deny"
          onClick={(e) => { e.stopPropagation(); actions.onDeny(agentId, approval.requestId); }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export interface AgentsListProps extends AgentsListActions {
  /** Optional search filter applied client-side. */
  filterQuery?: string;
}

export function AgentsList(props: AgentsListProps): React.ReactElement {
  const { spaces, selectedIndex } = useStore(spaceStore);
  const agentState = useStore(agentStore);
  const { personas } = useStore(personaStore);

  const intentMap = React.useMemo(() => new Map(spaces.map(s => [s.id, s.description])), [spaces]);
  const personaByHandle = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of personas) if (p.emoji) m.set(p.handle, p.emoji);
    return m;
  }, [personas]);

  let allAgents = agentState.agents;
  if (props.filterQuery && !agentState.page) {
    const q = props.filterQuery.toLowerCase();
    allAgents = allAgents.filter(a =>
      (a.selectedText || '').toLowerCase().includes(q) ||
      (a.summary || '').toLowerCase().includes(q),
    );
  }

  if (allAgents.length === 0) {
    const empty = props.filterQuery ? (
      <EmptyState icon="🔍" title="No matching agents" text="Try a different search." />
    ) : (
      <EmptyState
        icon="⚡"
        title="No agents yet"
        text="Describe a task above, or launch a standalone agent to get help."
        cta={{
          label: '+ New agent',
          onClick: () => (document.getElementById('new-agent-btn') as HTMLButtonElement | null)?.click(),
        }}
      />
    );
    return <>{agentState.page && <PageControls nextCursor={agentState.page.nextCursor}
      scope={props.filterQuery ?? ''}
      load={cursor => loadAgentsSnapshot(getAPI(), { cursor, invalidate: true })} />}{empty}</>;
  }

  // Newest first
  const sorted = [...allAgents].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return (
    <>
      {agentState.page && <PageControls nextCursor={agentState.page.nextCursor}
        scope={props.filterQuery ?? ''}
        load={cursor => loadAgentsSnapshot(getAPI(), { cursor, invalidate: true })} />}
      <VirtualRows rows={sorted} rowId={agent => agent.agentId} selectedIndex={selectedIndex} total={agentState.page?.total} offset={agentState.page?.offset}
        render={(agent, idx) => {
        const intentLabel = agent.source === 'cli'
          ? 'CLI Session'
          : agent.source === 'cca'
            ? 'Copilot Cloud Agent'
            : agent.spaceId === '__workspace__'
              ? 'Workspace'
              : (intentMap.get(agent.spaceId) || agent.spaceId);

        const personaEmoji = agent.personaHandle ? personaByHandle.get(agent.personaHandle) || '' : '';

        return (
          <AgentCard
            key={agent.agentId}
            agent={agent}
            intentLabel={intentLabel}
            steps={agentState.steps.get(agent.agentId) || []}
            approval={agentState.approvals.get(agent.agentId)}
            sandboxBlocks={Array.from(
              (agentState.sandboxBlocks.get(agent.agentId) ?? new Map()).values(),
            )}
            yoloMode={agentState.yoloMode.get(agent.agentId) || false}
            remote={agentState.remoteState.get(agent.agentId)}
            personaEmoji={personaEmoji}
            isSelected={idx === selectedIndex}
            actions={props}
          />
        );
      }} />
    </>
  );
}
