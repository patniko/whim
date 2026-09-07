import type { AgentListAllItem } from '../../shared/ipc-contract';
import { equalPayload, reconcileByKey } from './reconcile';

export interface AgentApproval {
  agentId: string;
  requestId: string;
  permissionKind: string;
  intention?: string;
  path?: string;
}

export interface AgentStep {
  toolCallId: string;
  label: string;
  status: 'running' | 'done' | 'failed';
}

export interface AgentPresence {
  agentId: string;
  spaceId: string;
  persona: { name: string; handle: string; color?: string; imageUrl?: string };
}

export interface AgentRemoteInfo {
  enabled: boolean;
  url?: string;
}

/** A sandbox enforcement block awaiting user resolution. */
export interface AgentSandboxBlock {
  agentId: string;
  requestId: string;
  source: 'permission' | 'pre-tool' | 'post-tool-shell';
  kind: 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'web-fetch';
  toolName?: string;
  target: string;
  intention?: string;
  allowedDecisions?: Array<'allow-once' | 'allow-for-session' | 'disable'>;
  layer?: string;
  personaHandle?: string;
}

export interface AgentState {
  agents: AgentListAllItem[];
  page: import('../../shared/paging').AgentPage | null;
  processingSpaces: Set<string>;
  activeSessionSpaces: Set<string>;
  approvals: Map<string, AgentApproval>;
  /**
   * Pending sandbox blocks indexed first by agentId, then by requestId. An
   * agent can have multiple concurrent pending blocks (e.g. parallel tool
   * calls in mxc-only mode), so we key by requestId to avoid losing UI.
   */
  sandboxBlocks: Map<string, Map<string, AgentSandboxBlock>>;
  steps: Map<string, AgentStep[]>;
  presence: Map<string, AgentPresence>;
  yoloMode: Map<string, boolean>;
  remoteState: Map<string, AgentRemoteInfo>;
}

type Listener = () => void;
export const WORKER_PREVIEW_STEPS = 6;

function createInitialAgentState(): AgentState {
  return {
    agents: [],
    page: null,
    processingSpaces: new Set(),
    activeSessionSpaces: new Set(),
    approvals: new Map(),
    sandboxBlocks: new Map(),
    steps: new Map(),
    presence: new Map(),
    yoloMode: new Map(),
    remoteState: new Map(),
  };
}

class AgentStore {
  private state: AgentState = createInitialAgentState();
  private listeners: Set<Listener> = new Set();
  /** Monotonic counter for stale-fetch detection (replaces app.ts:renderGeneration). */
  private requestCounter = 0;
  private latestRequestId = 0;

  getState(): Readonly<AgentState> {
    return this.state;
  }

  setPage(page: import('../../shared/paging').AgentPage): void {
    const visible = new Set(page.items.map(agent => agent.agentId));
    const steps = new Map([...this.state.steps].filter(([id]) => visible.has(id)));
    this.state = { ...this.state, page, steps };
    this.setAgents(page.items, true);
    this.notify();
  }

  setAgents(agents: AgentListAllItem[], hydrateDetails = false): void {
    agents = reconcileByKey(this.state.agents, agents, agent => agent.agentId);
    let approvals = this.state.approvals;
    let yoloMode = this.state.yoloMode;
    if (hydrateDetails) {
      const nextApprovals = new Map(approvals);
      const nextYolo = new Map<string, boolean>();
      for (const agent of agents) {
        // A pending live request is newer than any snapshot fallback.
        if (agent.status === 'waiting-approval' && agent.pendingApprovalId && !nextApprovals.has(agent.agentId)) {
          nextApprovals.set(agent.agentId, {
            agentId: agent.agentId, requestId: agent.pendingApprovalId,
            permissionKind: agent.pendingPermissionKind || 'permission',
            intention: agent.pendingIntention ?? undefined, path: agent.pendingPath ?? undefined,
          });
        }
        if (agent.yoloMode) nextYolo.set(agent.agentId, true);
      }
      if (nextApprovals.size !== approvals.size) approvals = nextApprovals;
      if (nextYolo.size !== yoloMode.size || [...nextYolo.keys()].some(id => !yoloMode.has(id))) yoloMode = nextYolo;
    }
    if (agents === this.state.agents && approvals === this.state.approvals && yoloMode === this.state.yoloMode) return;
    this.state = { ...this.state, agents, approvals, yoloMode };
    this.notify();
  }

  reset(): void {
    this.state = createInitialAgentState();
    this.nextRequestId();
    this.notify();
  }

  // -- Processing spaces ----------------------------------------------------

  addProcessingIntent(spaceId: string): void {
    if (this.state.processingSpaces.has(spaceId)) return;
    const next = new Set(this.state.processingSpaces);
    next.add(spaceId);
    this.state = { ...this.state, processingSpaces: next };
    this.notify();
  }

  removeProcessingIntent(spaceId: string): void {
    if (!this.state.processingSpaces.has(spaceId)) return;
    const next = new Set(this.state.processingSpaces);
    next.delete(spaceId);
    this.state = { ...this.state, processingSpaces: next };
    this.notify();
  }

  // -- Active sessions -------------------------------------------------------

  setActiveSessionIntents(spaceIds: Set<string>): void {
    if (spaceIds.size === this.state.activeSessionSpaces.size
      && [...spaceIds].every(id => this.state.activeSessionSpaces.has(id))) return;
    this.state = { ...this.state, activeSessionSpaces: new Set(spaceIds) };
    this.notify();
  }

  // -- Approvals -------------------------------------------------------------

  setApproval(agentId: string, approval: AgentApproval): void {
    if (equalPayload(this.state.approvals.get(agentId), approval)) return;
    this.nextRequestId();
    const next = new Map(this.state.approvals);
    next.set(agentId, approval);
    this.state = { ...this.state, approvals: next };
    this.notify();
  }

  clearApproval(agentId: string): void {
    if (!this.state.approvals.has(agentId)) return;
    this.nextRequestId();
    const next = new Map(this.state.approvals);
    next.delete(agentId);
    this.state = { ...this.state, approvals: next };
    this.notify();
  }

  // -- Sandbox blocks --------------------------------------------------------

  setSandboxBlock(block: AgentSandboxBlock): void {
    const next = new Map(this.state.sandboxBlocks);
    const existing = next.get(block.agentId);
    const perAgent = existing ? new Map(existing) : new Map<string, AgentSandboxBlock>();
    perAgent.set(block.requestId, block);
    next.set(block.agentId, perAgent);
    this.state = { ...this.state, sandboxBlocks: next };
    this.notify();
  }

  clearSandboxBlock(agentId: string, requestId: string): void {
    const existing = this.state.sandboxBlocks.get(agentId);
    if (!existing || !existing.has(requestId)) return;
    const next = new Map(this.state.sandboxBlocks);
    const perAgent = new Map(existing);
    perAgent.delete(requestId);
    if (perAgent.size === 0) next.delete(agentId);
    else next.set(agentId, perAgent);
    this.state = { ...this.state, sandboxBlocks: next };
    this.notify();
  }

  /** Returns total pending sandbox-block count across all agents. */
  sandboxBlockCount(): number {
    let n = 0;
    for (const perAgent of this.state.sandboxBlocks.values()) n += perAgent.size;
    return n;
  }

  // -- Steps -----------------------------------------------------------------

  addStep(agentId: string, step: AgentStep): void {
    const next = new Map(this.state.steps);
    const existing = next.get(agentId) ?? [];
    next.set(agentId, [...existing, step].slice(-WORKER_PREVIEW_STEPS));
    this.state = { ...this.state, steps: next };
    this.notify();
  }

  setSteps(agentId: string, steps: AgentStep[]): void {
    const next = new Map(this.state.steps);
    next.set(agentId, steps.slice(-WORKER_PREVIEW_STEPS));
    this.state = { ...this.state, steps: next };
    this.notify();
  }

  // -- Presence --------------------------------------------------------------

  setPresence(agentId: string, presence: AgentPresence): void {
    if (equalPayload(this.state.presence.get(agentId), presence)) return;
    const next = new Map(this.state.presence);
    next.set(agentId, presence);
    this.state = { ...this.state, presence: next };
    this.notify();
  }

  clearPresence(agentId: string): void {
    if (!this.state.presence.has(agentId)) return;
    const next = new Map(this.state.presence);
    next.delete(agentId);
    this.state = { ...this.state, presence: next };
    this.notify();
  }

  // -- Yolo mode -------------------------------------------------------------

  setYoloMode(agentId: string, enabled: boolean): void {
    if (this.state.yoloMode.has(agentId) === enabled) return;
    const next = new Map(this.state.yoloMode);
    if (enabled) {
      next.set(agentId, true);
    } else {
      next.delete(agentId);
    }
    this.state = { ...this.state, yoloMode: next };
    this.notify();
  }

  // -- Remote control --------------------------------------------------------

  setRemoteState(agentId: string, info: AgentRemoteInfo | null): void {
    if (info?.enabled ? equalPayload(this.state.remoteState.get(agentId), info) : !this.state.remoteState.has(agentId)) return;
    const next = new Map(this.state.remoteState);
    if (info && info.enabled) {
      next.set(agentId, info);
    } else {
      next.delete(agentId);
    }
    this.state = { ...this.state, remoteState: next };
    this.notify();
  }

  // -- Stale-fetch guards (replaces app.ts:renderGeneration) -----------------

  /** Reserve a new request id. Latest reservation wins. */
  nextRequestId(): number {
    this.requestCounter += 1;
    this.latestRequestId = this.requestCounter;
    return this.latestRequestId;
  }

  /** True if the given id is still the latest reserved id. */
  isCurrentRequest(id: number): boolean {
    return id === this.latestRequestId;
  }

  updateAgent(agentId: string, updates: Partial<AgentListAllItem>): void {
    this.nextRequestId();
    const index = this.state.agents.findIndex(agent => agent.agentId === agentId);
    // A new agent may not be in the initial snapshot yet; the bridge schedules
    // hydration rather than inventing the rest of its metadata.
    if (index < 0) return;
    const agent = { ...this.state.agents[index], ...updates };
    if (equalPayload(agent, this.state.agents[index])) return;
    const agents = this.state.agents.slice();
    agents[index] = agent;
    this.state = { ...this.state, agents };
    this.notify();
  }

  /** Subscribe to state changes. Returns an unsubscribe function (useSyncExternalStore-compatible). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -- Derived state helpers --------------------------------------------------

  getAgentsForIntent(spaceId: string): AgentListAllItem[] {
    return this.state.agents.filter(a => a.spaceId === spaceId);
  }

  hasActiveAgent(spaceId: string): boolean {
    return this.state.agents.some(
      a => a.spaceId === spaceId && (a.status === 'running' || a.status === 'waiting-approval'),
    );
  }

  /** Group agents by spaceId (skipping the workspace-level pseudo space). */
  getAgentsBySpace(): Map<string, AgentListAllItem[]> {
    const map = new Map<string, AgentListAllItem[]>();
    for (const agent of this.state.agents) {
      if (!agent.spaceId || agent.spaceId === '__workspace__') continue;
      const list = map.get(agent.spaceId);
      if (list) list.push(agent);
      else map.set(agent.spaceId, [agent]);
    }
    return map;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const agentStore = new AgentStore();
