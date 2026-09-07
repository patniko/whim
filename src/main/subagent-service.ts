/**
 * SubagentTracker — main-process service that tracks all sub-agent state.
 * Single source of truth; renderer fetches summaries/details via IPC.
 * Persists completed state to database so it survives app restart.
 *
 * Mirrors the github-tokens SubagentTracker but uses parentAgentId
 * (space's session key) instead of panelId.
 */
import type {
  SubagentInfo,
  SubagentSummary,
  SubagentToolCall,
  SubagentTurn,
} from '../shared/subagent-types';
import {
  isInitialized,
  createSubagentRecord,
  updateSubagentRecord,
  createSubagentToolCall,
  updateSubagentToolCall,
  listSubagentRecords,
  listSubagentToolCalls,
} from './storage';

/** Max completed turns to retain per agent (prevents unbounded memory) */
const MAX_TURNS_PER_AGENT = 50;
/** Max streaming content length before truncation */
const MAX_STREAMING_CONTENT = 100_000;
/** Max tool calls to retain per agent */
const MAX_TOOL_CALLS_PER_AGENT = 200;

type ChangeListener = (parentAgentId: string) => void;

export class SubagentTracker {
  /** parentAgentId → agentId → SubagentInfo */
  private agents = new Map<string, Map<string, SubagentInfo>>();
  /** toolCallId → { parentAgentId, agentId } for linking subagent.started to agents */
  private toolCallIndex = new Map<string, { parentAgentId: string; agentId: string }>();

  private changeListeners: ChangeListener[] = [];
  private throttleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  private notifyChange(parentAgentId: string): void {
    // Throttle to max 1 notification per 500ms per parent
    if (this.throttleTimers.has(parentAgentId)) return;
    this.throttleTimers.set(
      parentAgentId,
      setTimeout(() => {
        this.throttleTimers.delete(parentAgentId);
        for (const listener of this.changeListeners) {
          listener(parentAgentId);
        }
      }, 500),
    );
  }

  private ensureParent(parentAgentId: string): Map<string, SubagentInfo> {
    if (!this.agents.has(parentAgentId)) {
      this.agents.set(parentAgentId, new Map());
    }
    return this.agents.get(parentAgentId)!;
  }

  private resolveAgentId(event: { agentId?: string; toolCallId?: string }, parentAgentId: string): string | undefined {
    if (event.agentId) return event.agentId;
    if (event.toolCallId) {
      const ref = this.toolCallIndex.get(event.toolCallId);
      if (ref && ref.parentAgentId === parentAgentId) return ref.agentId;
    }
    return undefined;
  }

  // --- Lifecycle events ---

  async trackStarted(parentAgentId: string, data: {
    agentId?: string;
    toolCallId: string;
    agentName: string;
    agentDisplayName: string;
    agentDescription: string;
  }): Promise<void> {
    const parent = this.ensureParent(parentAgentId);
    const agentId = data.agentId || `agent-${data.toolCallId}`;

    const info: SubagentInfo = {
      agentId,
      parentAgentId,
      toolCallId: data.toolCallId,
      name: data.agentName,
      displayName: data.agentDisplayName,
      description: data.agentDescription,
      agentType: data.agentName,
      status: 'running',
      startedAt: Date.now(),
      progress: {
        toolCallsCompleted: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      streamingContent: '',
      turns: [],
      toolCalls: [],
    };

    parent.set(agentId, info);
    this.toolCallIndex.set(data.toolCallId, { parentAgentId, agentId });
    (await this.persistCreated(info));
    this.notifyChange(parentAgentId);
  }

  async trackCompleted(parentAgentId: string, data: {
    agentId?: string;
    toolCallId: string;
    agentName?: string;
    agentDisplayName?: string;
    durationMs?: number;
    model?: string;
    totalTokens?: number;
    totalToolCalls?: number;
  }): Promise<void> {
    const agentId = this.resolveAgentId(data, parentAgentId);
    if (!agentId) return;
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;

    // Finalize the current streaming content as the last turn
    this.finalizeTurn(agent);

    agent.status = 'completed';
    agent.completedAt = Date.now();
    agent.durationMs = data.durationMs ?? (Date.now() - agent.startedAt);
    if (data.model) agent.model = data.model;
    if (data.totalTokens != null) agent.totalTokens = data.totalTokens;
    if (data.totalToolCalls != null) agent.totalToolCalls = data.totalToolCalls;
    if (data.agentDisplayName) agent.displayName = data.agentDisplayName;
    (await this.persistCompleted(agent));
    this.notifyChange(parentAgentId);
  }

  async trackFailed(parentAgentId: string, data: {
    agentId?: string;
    toolCallId: string;
    agentName?: string;
    error: string;
    durationMs?: number;
    model?: string;
    totalTokens?: number;
    totalToolCalls?: number;
  }): Promise<void> {
    const agentId = this.resolveAgentId(data, parentAgentId);
    if (!agentId) return;
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;

    this.finalizeTurn(agent);

    agent.status = 'failed';
    agent.completedAt = Date.now();
    agent.durationMs = data.durationMs ?? (Date.now() - agent.startedAt);
    agent.error = data.error;
    if (data.model) agent.model = data.model;
    if (data.totalTokens != null) agent.totalTokens = data.totalTokens;
    if (data.totalToolCalls != null) agent.totalToolCalls = data.totalToolCalls;
    (await this.persistCompleted(agent));
    this.notifyChange(parentAgentId);
  }

  // --- Streaming / progress events (tagged with agentId) ---

  trackStreamingDelta(parentAgentId: string, agentId: string, delta: string): void {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;
    if (agent.streamingContent.length < MAX_STREAMING_CONTENT) {
      agent.streamingContent += delta;
    }
    // Don't notify on every delta — too noisy; the overlay polls when open
  }

  trackIntent(parentAgentId: string, agentId: string, space: string): void {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;
    agent.progress.currentIntent = space;
    this.notifyChange(parentAgentId);
  }

  async trackToolStart(parentAgentId: string, agentId: string, data: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;
    if (agent.toolCalls.length >= MAX_TOOL_CALLS_PER_AGENT) {
      agent.toolCalls.shift();
    }
    agent.toolCalls.push({
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      args: data.args,
      completed: false,
      startedAt: Date.now(),
    });
    (await this.persistToolStart(agentId, parentAgentId, data));
  }

  async trackToolComplete(parentAgentId: string, agentId: string, data: {
    toolCallId: string;
    success: boolean;
    result?: string;
    error?: string;
  }): Promise<void> {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;
    const tc = agent.toolCalls.find((t) => t.toolCallId === data.toolCallId);
    if (tc) {
      tc.completed = true;
      tc.success = data.success;
      tc.result = data.result;
      tc.error = data.error;
      tc.completedAt = Date.now();
    }
    agent.progress.toolCallsCompleted++;
    (await this.persistToolComplete(agent.agentId, agent.parentAgentId, data));
  }

  trackUsage(parentAgentId: string, agentId: string, inputTokens: number, outputTokens: number): void {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;
    agent.progress.totalInputTokens += inputTokens;
    agent.progress.totalOutputTokens += outputTokens;
  }

  trackModel(parentAgentId: string, agentId: string, model: string): void {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;
    agent.model = model;
    agent.progress.resolvedModel = model;
  }

  /** Called when a new assistant turn starts — finalize previous turn content */
  trackTurnStart(parentAgentId: string, agentId: string): void {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent) return;
    this.finalizeTurn(agent);
  }

  trackIdle(parentAgentId: string, agentId: string): void {
    const agent = this.ensureParent(parentAgentId).get(agentId);
    if (!agent || agent.status !== 'running') return;
    agent.status = 'idle';
    this.finalizeTurn(agent);
    this.notifyChange(parentAgentId);
  }

  // --- Queries ---

  listSubagents(parentAgentId: string): SubagentSummary[] {
    const parent = this.agents.get(parentAgentId);
    if (!parent) return [];
    return Array.from(parent.values()).map((a) => this.toSummary(a));
  }

  getSubagent(parentAgentId: string, agentId: string): SubagentInfo | undefined {
    return this.agents.get(parentAgentId)?.get(agentId);
  }

  getAgentIdForToolCall(toolCallId: string): { parentAgentId: string; agentId: string } | undefined {
    return this.toolCallIndex.get(toolCallId);
  }

  /** Clean up completed agents older than maxAge (ms) to free memory */
  pruneCompleted(parentAgentId: string, maxAge = 10 * 60 * 1000): void {
    const parent = this.agents.get(parentAgentId);
    if (!parent) return;
    const cutoff = Date.now() - maxAge;
    for (const [id, agent] of parent) {
      if ((agent.status === 'completed' || agent.status === 'failed') && (agent.completedAt ?? 0) < cutoff) {
        parent.delete(id);
        this.toolCallIndex.delete(agent.toolCallId);
      }
    }
  }

  /** Remove all agents for a parent (on session destroy) */
  clearParent(parentAgentId: string): void {
    // Clear pending throttle timer to prevent leaks
    const timer = this.throttleTimers.get(parentAgentId);
    if (timer) {
      clearTimeout(timer);
      this.throttleTimers.delete(parentAgentId);
    }
    const parent = this.agents.get(parentAgentId);
    if (parent) {
      for (const agent of parent.values()) {
        this.toolCallIndex.delete(agent.toolCallId);
      }
      parent.clear();
    }
    this.agents.delete(parentAgentId);
  }

  // --- Internals ---

  private finalizeTurn(agent: SubagentInfo): void {
    if (agent.streamingContent.length === 0) return;
    if (agent.turns.length >= MAX_TURNS_PER_AGENT) {
      agent.turns.shift();
    }
    agent.turns.push({
      turnIndex: agent.turns.length,
      response: agent.streamingContent,
      timestamp: Date.now(),
    });
    agent.streamingContent = '';
  }

  private toSummary(agent: SubagentInfo): SubagentSummary {
    return {
      agentId: agent.agentId,
      parentAgentId: agent.parentAgentId,
      toolCallId: agent.toolCallId,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      agentType: agent.agentType,
      status: agent.status,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      durationMs: agent.durationMs,
      model: agent.model,
      totalTokens: agent.totalTokens,
      totalToolCalls: agent.totalToolCalls,
      error: agent.error,
      progress: { ...agent.progress },
    };
  }

  // --- DB persistence helpers ---

  private async persistCreated(agent: SubagentInfo): Promise<void> {
    if (!isInitialized()) return;
    try {
      (await createSubagentRecord({
        id: agent.agentId,
        parent_agent_id: agent.parentAgentId,
        tool_call_id: agent.toolCallId,
        agent_name: agent.name,
        display_name: agent.displayName,
        description: agent.description,
        agent_type: agent.agentType,
        status: agent.status,
        started_at: agent.startedAt,
        completed_at: null,
        duration_ms: null,
        model: agent.model ?? null,
        total_tokens: null,
        total_tool_calls: null,
        error: null,
        streaming_content: '',
        turns_json: '[]',
        progress_json: JSON.stringify(agent.progress),
      }));
    } catch { /* non-fatal */ }
  }

  private async persistCompleted(agent: SubagentInfo): Promise<void> {
    if (!isInitialized()) return;
    try {
      (await updateSubagentRecord(agent.agentId, {
        status: agent.status,
        completed_at: agent.completedAt ?? null,
        duration_ms: agent.durationMs ?? null,
        model: agent.model ?? null,
        total_tokens: agent.totalTokens ?? null,
        total_tool_calls: agent.totalToolCalls ?? null,
        error: agent.error ?? null,
        streaming_content: agent.streamingContent,
        turns_json: JSON.stringify(agent.turns),
        progress_json: JSON.stringify(agent.progress),
      }));
    } catch { /* non-fatal */ }
  }

  private async persistToolStart(subagentId: string, parentAgentId: string, data: { toolCallId: string; toolName: string; args: Record<string, unknown> }): Promise<void> {
    if (!isInitialized()) return;
    try {
      (await createSubagentToolCall({
        subagent_id: subagentId,
        parent_agent_id: parentAgentId,
        tool_call_id: data.toolCallId,
        tool_name: data.toolName,
        arguments_json: JSON.stringify(data.args),
        result: null,
        success: 1,
        error: null,
        started_at: Date.now(),
        completed_at: null,
      }));
    } catch { /* non-fatal */ }
  }

  private async persistToolComplete(subagentId: string, _parentAgentId: string, data: { toolCallId: string; success: boolean; result?: string; error?: string }): Promise<void> {
    if (!isInitialized()) return;
    try {
      (await updateSubagentToolCall(subagentId, data.toolCallId, {
        success: data.success ? 1 : 0,
        result: data.result,
        error: data.error,
        completed_at: Date.now(),
      }));
    } catch { /* non-fatal */ }
  }

  /** Load persisted subagent data from DB for a historical parent agent. */
  async loadPersistedSubagents(parentAgentId: string): Promise<SubagentInfo[]> {
    if (!isInitialized()) return [];
    try {
      const rows = (await listSubagentRecords(parentAgentId));
      const result: SubagentInfo[] = [];
      for (const row of rows) {
        const toolCalls = (await listSubagentToolCalls(row.id)).map((tc): SubagentToolCall => {
          const resultText = tc.result;
          return {
            toolCallId: tc.tool_call_id ?? '',
            toolName: tc.tool_name,
            args: tc.arguments_json ? JSON.parse(tc.arguments_json) : {},
            completed: tc.completed_at != null,
            success: tc.success === 1,
            result: resultText || undefined,
            error: tc.error ?? undefined,
            startedAt: tc.started_at ?? 0,
            completedAt: tc.completed_at ?? undefined,
          };
        });
        // Resolve potentially off-loaded turns_json + streaming_content via
        // the side-file store. Parse failures fall back to safe defaults so
        // a corrupt side file never breaks the overlay.
        const turnsText = row.turns_json;
        let turns: SubagentTurn[] = [];
        if (turnsText) {
          try { turns = JSON.parse(turnsText); } catch { turns = []; }
        }
        const streamingContent = row.streaming_content;
        result.push({
          agentId: row.id,
          parentAgentId: row.parent_agent_id,
          toolCallId: row.tool_call_id ?? '',
          name: row.agent_name,
          displayName: row.display_name ?? row.agent_name,
          description: row.description ?? '',
          agentType: row.agent_type ?? row.agent_name,
          status: row.status as SubagentInfo['status'],
          startedAt: row.started_at,
          completedAt: row.completed_at ?? undefined,
          durationMs: row.duration_ms ?? undefined,
          model: row.model ?? undefined,
          totalTokens: row.total_tokens ?? undefined,
          totalToolCalls: row.total_tool_calls ?? undefined,
          error: row.error ?? undefined,
          progress: row.progress_json ? JSON.parse(row.progress_json) : { toolCallsCompleted: 0, totalInputTokens: 0, totalOutputTokens: 0 },
          streamingContent,
          turns,
          toolCalls,
        });
      }
      return result;
    } catch { return []; }
  }
}
