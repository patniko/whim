import {
  createCanvasAgent,
  updateCanvasAgentStatus,
  createAgentSession as dbCreateAgentSession,
  updateAgentSessionStatus,
  updateAgentSessionId,
  updateAgentSessionYolo,
  getAgentSession,
  listAgentSessions,
  appendAgentChatEvent,
  listAgentChatEvents,
  clearAgentChatEvents,
} from '../storage';
import type { AgentSession, AgentChatEvent, CanvasAgent } from '../../shared/types';
import type { AgentRecord } from './agent-registry';

export class AgentPersistence {
  async createCanvasAgentRecord(data: CanvasAgent): Promise<void> {
    (await createCanvasAgent(data));
  }

  async createAgentSessionRecord(data: AgentSession): Promise<void> {
    (await dbCreateAgentSession(data));
  }

  /** Write status to both canvas_agents and agent_sessions tables. No-op for ephemeral agents. */
  async updateStatus(record: AgentRecord): Promise<void> {
    if (record.ephemeral) return;
    const { agentId, status, summary } = record;
    await updateCanvasAgentStatus(agentId, status);
    await updateAgentSessionStatus(agentId, status, summary);
  }

  /** Write summary to agent_sessions table only. No-op for ephemeral agents. */
  async persistSummary(record: AgentRecord): Promise<void> {
    if (record.ephemeral) return;
    await updateAgentSessionStatus(record.agentId, record.status, record.summary);
  }

  /** Persist the per-session yolo (auto-approve) flag. No-op for ephemeral agents. */
  async updateYolo(record: AgentRecord, enabled: boolean): Promise<void> {
    if (record.ephemeral) return;
    await updateAgentSessionYolo(record.agentId, enabled);
  }

  async getSession(agentId: string): Promise<AgentSession | null> {
    return (await getAgentSession(agentId));
  }

  async listSessions(): Promise<AgentSession[]> {
    return (await listAgentSessions());
  }

  async updateSessionStatus(agentId: string, status: string, summary: string): Promise<void> {
    (await updateAgentSessionStatus(agentId, status, summary));
  }

  /** Update session_id in both agent_sessions and canvas_agents tables. */
  async updateSessionId(agentId: string, newSessionId: string): Promise<void> {
    (await updateAgentSessionId(agentId, newSessionId));
  }

  /**
   * Append a chat event to the persisted transcript for `agentId`.
   * No-op for ephemeral agents — they're explicitly not persisted.
   * The caller observes failures; an acknowledgement means the log is durable.
   */
  async appendChatEvent(
    record: AgentRecord,
    event: { event_id: string | null; type: string; timestamp: string; payload: string },
  ): Promise<number | undefined> {
    if (record.ephemeral) return;
    return appendAgentChatEvent(record.agentId, event);
  }

  /** Read the persisted transcript for an agent, ordered oldest-first. */
  async listChatEvents(agentId: string): Promise<AgentChatEvent[]> {
    return await listAgentChatEvents(agentId);
  }

  /** Discard persisted transcript for an agent. */
  async clearChatEvents(agentId: string): Promise<void> {
    await clearAgentChatEvents(agentId);
  }
}
