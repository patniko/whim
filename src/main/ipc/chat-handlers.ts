import { registerIpcHandler } from './registry';

export function registerChatHandlers(): void {
  registerIpcHandler('chat:send-message', async (_event, agentId: string, prompt: string, attachments?: Array<{ type: 'file'; path: string }>) => {
    const { sendChatMessage } = await import('../agent-service');
    return sendChatMessage(agentId, prompt, attachments);
  });

  registerIpcHandler('chat:set-model', async (_event, agentId: string, model: string) => {
    const { setAgentModel } = await import('../agent-service');
    return setAgentModel(agentId, model);
  });

  // ── Sub-agent tracking ─────────────────────────────────
  registerIpcHandler('subagent:list', async (_event, parentAgentId: string) => {
    const { subagentTracker } = await import('../agent-service');
    return subagentTracker.listSubagents(parentAgentId);
  });

  registerIpcHandler('subagent:read', async (_event, parentAgentId: string, agentId: string) => {
    const { subagentTracker } = await import('../agent-service');
    const live = subagentTracker.getSubagent(parentAgentId, agentId);
    if (live) return live;
    // Fall back to persisted data after parent completion/restart
    const persisted = subagentTracker.loadPersistedSubagents(parentAgentId);
    return persisted.find(a => a.agentId === agentId) ?? null;
  });

  registerIpcHandler('subagent:write', async (_event, _parentAgentId: string, _agentId: string, _message: string) => {
    // Requires SDK support — stub for now
    return { success: false, error: 'Not yet supported' };
  });

  registerIpcHandler('subagent:cancel', async (_event, _parentAgentId: string, _agentId: string) => {
    // Requires SDK support — stub for now
    return { success: false, error: 'Not yet supported' };
  });

  registerIpcHandler('subagent:list-persisted', async (_event, parentAgentId: string) => {
    const { subagentTracker } = await import('../agent-service');
    // Try live data first, fall back to persisted
    const live = subagentTracker.listSubagents(parentAgentId);
    if (live.length > 0) return live;
    return subagentTracker.loadPersistedSubagents(parentAgentId);
  });
}
