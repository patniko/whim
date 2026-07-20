import { ipcMain } from 'electron';
import { isInitialized, getSpace } from '../database';
import { getConfigValue } from '../config';
import * as path from 'path';
import { resolveCommentLaunchTarget } from '../services/comment-launch-target';

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:launch', async (_event, spaceId: string, selectedText: string, anchor: any, options?: { repo?: string; model?: string }) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { error: 'space_not_found' };

    const { launchAgent } = await import('../agent-service');
    return launchAgent(spaceId, selectedText, anchor, workspace, space.folder, options);
  });

  ipcMain.handle('agent:launch-from-comment', async (_event, spaceId: string, commentBody: string, quotedText: string, anchor: any, personaHandle: string, threadId: string | null) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const target = resolveCommentLaunchTarget(spaceId, workspace);
    if ('error' in target) return { error: target.error };

    const allPersonas = getConfigValue('personas') || [];
    const persona = allPersonas.find(p => p.handle === personaHandle);
    if (!persona) return { error: 'persona_not_found' };

    // Route to CCA (Copilot Coding Agent) if persona is configured for PR-based cloud execution
    if (persona.runLocation === 'cca') {
      const documentPath = target.documentPath ? path.relative(workspace, target.documentPath) : path.join(target.folder, 'canvas.md');
      const prompt = `${persona.instructions}\n\nDocument: ${documentPath}\nComment: "${commentBody}"\nOn text: "${quotedText}"`;
      const { launchTrackedCloudAgent } = await import('../cloud-agent-poller');
      return launchTrackedCloudAgent({
        spaceId: target.launchSpaceId,
        prompt,
        displayPrompt: commentBody,
        workspace,
        personaHandle: persona.handle,
        quotedText: quotedText || undefined,
        threadId,
      });
    }

    const { launchCommentAgent } = await import('../agent-service');
    return launchCommentAgent(target.launchSpaceId, commentBody, quotedText, anchor, persona, threadId, workspace, target.folder, {
      documentPath: target.documentPath,
      documentDisplayName: target.documentDisplayName,
      documentLabel: target.documentLabel,
    });
  });

  ipcMain.handle('agent:list', async (_event, spaceId: string) => {
    const { listAgents } = await import('../agent-service');
    return listAgents(spaceId);
  });

  ipcMain.handle('agent:approve', async (_event, agentId: string, requestId: string, approved: boolean) => {
    const { approveAgent } = await import('../agent-service');
    approveAgent(agentId, requestId, approved);
  });

  ipcMain.handle('agent:respond-user-input', async (_event, agentId: string, requestId: string, answer: string, wasFreeform: boolean) => {
    const { respondToUserInput } = await import('../agent-service');
    respondToUserInput(agentId, requestId, answer, wasFreeform);
  });

  ipcMain.handle('agent:respond-elicitation', async (_event, agentId: string, requestId: string, action: string, content?: Record<string, unknown>) => {
    const { respondToElicitation } = await import('../agent-service');
    respondToElicitation(agentId, requestId, action as 'accept' | 'decline' | 'cancel', content);
  });

  ipcMain.handle('agent:resolve-sandbox', async (_event, agentId: string, requestId: string, decision: string) => {
    if (decision !== 'allow-once' && decision !== 'allow-for-session' && decision !== 'disable') {
      return { error: 'invalid decision' };
    }
    const { resolveSandboxBlock } = await import('../agent-service');
    await resolveSandboxBlock(agentId, requestId, decision);
    return { ok: true };
  });

  ipcMain.handle('agent:disable-sandbox', async (_event, agentId: string) => {
    try {
      const { disableSandboxForSession } = await import('../agent-service');
      await disableSandboxForSession(agentId);
      return { ok: true };
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to disable sandbox' };
    }
  });

  ipcMain.handle('agent:abort', async (_event, agentId: string) => {
    const { abortAgent } = await import('../agent-service');
    await abortAgent(agentId);
  });

  ipcMain.handle('agent:open-cli', async (_event, agentId: string) => {
    const { openAgentCli } = await import('../agent-service');
    return openAgentCli(agentId);
  });

  ipcMain.handle('agent:quick-launch', async (_event, prompt: string, personaHandle?: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { error: 'no_workspace' };

    // Resolve persona (if any) before launching so cloud routing can be
    // applied appropriately.  Sandboxed personas are allowed: launchQuickAgent
    // applies their sandbox policy rooted at the workspace root, see
    // src/main/agents/sandbox-launch.ts.
    let persona: any = null;
    if (personaHandle) {
      const allPersonas = (getConfigValue('personas') as any[]) || [];
      persona = allPersonas.find(p => p.handle === personaHandle) || null;
      if (!persona) return { error: `Persona @${personaHandle} not found` };
    }

    if (persona && persona.runLocation === 'cca') {
      const fullPrompt = `${persona.instructions}\n\n${prompt}`;
      const { launchTrackedCloudAgent } = await import('../cloud-agent-poller');
      return launchTrackedCloudAgent({
        spaceId: null,
        prompt: fullPrompt,
        displayPrompt: prompt,
        workspace,
        personaHandle: persona.handle,
      });
    }

    const { launchQuickAgent } = await import('../agent-service');
    return launchQuickAgent(prompt, workspace, persona ?? undefined);
  });

  ipcMain.handle('agent:launch-document', async (_event, spaceId: string, options?: { personaHandle?: string | null; promptOverride?: string }) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const space = getSpace(spaceId);
    if (!space || !space.folder) return { error: 'space_not_found' };

    const { launchDocumentAgent } = await import('../agent-service');
    return launchDocumentAgent(spaceId, workspace, space.folder, options);
  });

  ipcMain.handle('agent:list-all', async () => {
    const { listAllAgents } = await import('../agent-service');
    return listAllAgents();
  });

  ipcMain.handle('agent:delete-session', async (_event, agentId: string) => {
    const { deleteAgent } = await import('../agent-service');
    await deleteAgent(agentId);
    return { ok: true };
  });

  ipcMain.handle('agent:set-yolo', async (_event, agentId: string, enabled: boolean) => {
    const { setAgentYolo } = await import('../agent-service');
    return setAgentYolo(agentId, enabled);
  });

  // ── Remote control ──────────────────────────────────────
  ipcMain.handle('agent:enable-remote', async (_event, agentId: string) => {
    const { enableRemoteControl } = await import('../agent-service');
    return enableRemoteControl(agentId);
  });

  ipcMain.handle('agent:disable-remote', async (_event, agentId: string) => {
    const { disableRemoteControl } = await import('../agent-service');
    return disableRemoteControl(agentId);
  });

  ipcMain.handle('agent:get-remote-state', async (_event, agentId: string) => {
    const { getRemoteState } = await import('../agent-service');
    return getRemoteState(agentId);
  });

  ipcMain.handle('agent:reset-remote', async (_event, agentId: string) => {
    const { resetRemoteControl } = await import('../agent-service');
    return resetRemoteControl(agentId);
  });

  // ── App-level remote ──────────────────────────────────────
  ipcMain.handle('app:set-remote', async (_event, enabled: boolean) => {
    const { setAppRemote } = await import('../agent-service');
    return setAppRemote(enabled);
  });

  ipcMain.handle('app:get-remote-status', async () => {
    const { getAppRemoteStatus } = await import('../agent-service');
    return getAppRemoteStatus();
  });

  // ── Cloud agent launch ────────────────────────────────────
  ipcMain.handle('agent:launch-cloud', async (_event, spaceId: string, prompt: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { error: 'no_workspace' };

    const { launchTrackedCloudAgent } = await import('../cloud-agent-poller');
    return launchTrackedCloudAgent({
      spaceId: spaceId || null,
      prompt,
      workspace,
    });
  });

  ipcMain.handle('agent:cloud-status', async (_event, agentId: string) => {
    const { getCloudJobPollResult } = await import('../cloud-agent-poller');
    return getCloudJobPollResult(agentId) || { status: 'unknown' };
  });

  // ── CLI session launch ──────────────────────────────────
  ipcMain.handle('cli:launch-session', async () => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { error: 'no_workspace' };

    const { launchCliSession } = await import('../agent-service');
    return launchCliSession(workspace);
  });

  // ── Agent history ───────────────────────────────────────
  ipcMain.handle('agent:get-history', async (_event, agentId: string) => {
    const { getAgentHistory } = await import('../agent-service');
    return getAgentHistory(agentId);
  });

  ipcMain.handle('agent:get-working-dir', async (_event, agentId: string) => {
    const { getAgentSession } = await import('../database');
    const session = getAgentSession(agentId);
    return session?.working_dir ?? null;
  });

}
