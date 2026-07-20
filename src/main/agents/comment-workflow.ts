import { v4 as uuid } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { getCopilotClient } from '../ai';
import { type AgentPersona, getConfigValue } from '../config';
import { AgentRegistry } from './agent-registry';
import type { AgentRecord } from './agent-registry';
import { AgentNotifier } from './agent-notifier';
import { AgentPersistence } from './agent-persistence';
import { InteractionBroker } from './interaction-broker';
import { buildCliToolsPrompt, waitForCloudSessionStart, enableRemoteControl } from './sdk-runner';
import { buildSandboxLaunchSetup } from './sandbox-launch';
import { SANDBOX_SYSTEM_PROMPT } from './sandbox-policies';
import { getWorkspaceRepo } from '../cloud-agent';

/** Shared dependencies injected from agent-service at init time. */
let registry: AgentRegistry;
let notifier: AgentNotifier;
let persistence: AgentPersistence;
let broker: InteractionBroker;

// Keep a reference to setupAgentEventListeners from sdk-runner
let setupListeners: (session: any, record: AgentRecord) => void;

export interface CommentAgentDocumentTarget {
  documentPath?: string;
  documentDisplayName?: string;
  documentLabel?: string;
}

export function initCommentWorkflow(deps: {
  registry: AgentRegistry;
  notifier: AgentNotifier;
  persistence: AgentPersistence;
  broker: InteractionBroker;
  setupAgentEventListeners: (session: any, record: AgentRecord) => void;
}): void {
  registry = deps.registry;
  notifier = deps.notifier;
  persistence = deps.persistence;
  broker = deps.broker;
  setupListeners = deps.setupAgentEventListeners;
}

/** Launch an agent session triggered by an @mention in a canvas comment */
export async function launchCommentAgent(
  spaceId: string,
  commentBody: string,
  quotedText: string,
  anchor: { prefix?: string; suffix?: string },
  persona: AgentPersona,
  threadId: string | null,
  workspaceRoot: string,
  intentFolder: string,
  documentTarget?: CommentAgentDocumentTarget,
): Promise<{ agentId: string; sessionId: string } | { error: string }> {
  const client = getCopilotClient();
  if (!client) {
    return { error: 'Copilot SDK not initialized' };
  }

  const agentId = uuid();
  const workingDir = path.join(workspaceRoot, intentFolder);
  const canvasPath = documentTarget?.documentPath ?? path.join(workingDir, 'canvas.md');
  const documentDisplayName = documentTarget?.documentDisplayName ?? 'canvas.md';
  const documentLabel = documentTarget?.documentLabel ?? 'canvas document';
  const isCloudSandbox = persona.runLocation === 'cloud';

  // Snapshot canvas hash for change detection
  let canvasHashBefore = '';
  try {
    const canvasContent = fs.readFileSync(canvasPath, 'utf-8');
    canvasHashBefore = crypto.createHash('md5').update(canvasContent).digest('hex');
  } catch { /* file may not exist yet */ }

  const now = new Date().toISOString();
  const record: AgentRecord = {
    agentId,
    sessionId: agentId,
    phase: 'starting',
    spaceId,
    selectedText: commentBody,
    anchor: { quote: quotedText, prefix: anchor.prefix || '', suffix: anchor.suffix || '' },
    status: 'running',
    pendingApprovalId: null,
    pendingPermissionKind: null,
    pendingApprovals: new Map(),
    summary: 'Starting...',
    runLocation: isCloudSandbox ? 'cloud' : 'local',
    ...(persona.yolo ? { yoloMode: true } : {}),
    personaHandle: persona.handle,
    commentContext: {
      threadId,
      personaHandle: persona.handle,
      personaName: persona.handle,
      commentBody,
      quotedText,
      anchor,
      canvasHashBefore,
      canvasPath,
      documentDisplayName,
      documentLabel,
    },
  };

  registry.set(agentId, record);
  try {
    persistence.createAgentSessionRecord({
      id: agentId,
      session_id: agentId,
      space_id: spaceId,
      prompt: commentBody,
      status: 'running',
      summary: 'Starting...',
      working_dir: workingDir,
      source: 'sdk',
      persona_handle: persona.handle,
      quoted_text: quotedText || null,
      comment_thread_id: threadId,
      run_location: isCloudSandbox ? 'cloud' : 'local',
      yolo_mode: record.yoloMode === true,
      created_at: now,
      updated_at: now,
    });
  } catch (err: any) {
    registry.delete(agentId);
    return { error: err.message || 'Failed to create agent record' };
  }
  notifier.notifyRenderer('agent:status-changed', {
    agentId,
    status: 'running',
    summary: 'Starting...',
    spaceId,
    threadId,
  });
  if (persona.yolo) {
    notifier.notifyRenderer('agent:yolo-changed', { agentId, enabled: true });
  }

  const launchStillWanted = () => !record.aborted && registry.get(agentId) === record;
  let session: any;

  try {
    const cliToolsPrompt = buildCliToolsPrompt();
    const findRecord = (sid: string) => registry.findBySessionId(sid);

    const sandboxSetup = buildSandboxLaunchSetup({
      agentId,
      workingDir,
      persona,
      registry,
      broker,
      customToolsContext: { agentId, broker, registry },
    });
    const { isSandboxed, sandboxConfigs, mcpServers, customTools, sandboxState, hooks, enforcementMode } = sandboxSetup;
    if (sandboxState) record.sandbox = sandboxState;
    // Permission-handler routing:
    //   - both     → path-aware sandbox handler (host-side path checks +
    //                bubble-up dialog for out-of-scope writes)
    //   - mxc-only → auto-approve handler (MXC is sole enforcer; SDK calls
    //                proceed to MXC for shell, unrestricted for SDK file ops)
    //   - non-sandboxed → regular interactive handler
    const useHostPathAwareHandler = isSandboxed && enforcementMode === 'both';
    const useMxcOnlyAutoApprove = isSandboxed && enforcementMode === 'mxc-only';

    const systemPrompt = `${persona.instructions}

You are responding to a comment on a ${documentLabel}. The user wrote:

Comment: "${commentBody}"
On this text: "${quotedText}"

The full ${documentLabel} is available as ${documentDisplayName} in the working directory.
If you make changes to ${documentDisplayName}, clearly describe what you changed.${cliToolsPrompt}`;

    // Resolve cloud session options for cloud personas
    let cloudOpts: { repository?: { owner: string; name: string } } | undefined;
    if (isCloudSandbox) {
      try {
        const repoInfo = await getWorkspaceRepo(workingDir);
        cloudOpts = repoInfo ? { repository: { owner: repoInfo.owner, name: repoInfo.repo } } : {};
      } catch { cloudOpts = {}; }
    }
    if (!launchStillWanted()) return { error: 'Agent launch cancelled' };

    session = await client.createSession({
      workingDirectory: workingDir,
      ...(sandboxConfigs ? { configDir: sandboxConfigs.onDir } : {}),
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      tools: customTools,
      ...(persona.model ? { model: persona.model } : {}),
      ...(hooks ? { hooks } : {}),
      ...(cloudOpts ? { cloud: cloudOpts } : {}),
      onPermissionRequest: useHostPathAwareHandler
        ? broker.createPathAwareSandboxPermissionHandler(findRecord)
        : useMxcOnlyAutoApprove
          ? broker.createMxcOnlyPermissionHandler(findRecord)
          : broker.createPermissionHandler(findRecord),
      onUserInputRequest: broker.createUserInputHandler(findRecord),
      onElicitationRequest: broker.createElicitationHandler(findRecord),
      systemMessage: {
        mode: 'append',
        // In mxc-only mode the host-side guards are deliberately suppressed so
        // MXC is the sole enforcer; the agent must NOT be told it's sandboxed,
        // otherwise we can't observe MXC's own denials. Only append the
        // [SANDBOX MODE] fragment when host-side guards are also active.
        content: isSandboxed && enforcementMode === 'both'
          ? `\n${systemPrompt}${SANDBOX_SYSTEM_PROMPT}`
          : `\n${systemPrompt}`,
      },
    });
    if (!launchStillWanted()) {
      try { await (session as any).abort?.(); } catch { /* best-effort */ }
      return { error: 'Agent launch cancelled' };
    }

    // The runtime does NOT auto-load sandbox enforcement from configDir. We
    // must explicitly push the sandboxConfig via options.update so MXC
    // wraps shell commands with sandbox-exec. This MUST resolve before
    // session.send so the first tool call is gated.
    // See cli/promptMode.ts:346 for the reference implementation.
    if (isSandboxed && sandboxSetup.runtimeSandboxConfig && !isCloudSandbox) {
      try {
        const result = await (session as any).rpc.options.update({
          sandboxConfig: sandboxSetup.runtimeSandboxConfig,
        });
        if (result?.success === false) {
          console.error(
            `[sandbox] options.update returned success=false for comment agent ${agentId}; ` +
            `aborting launch to avoid running unsandboxed.`,
          );
          try { await (session as any).abort?.(); } catch { /* best-effort */ }
          throw new Error('runtime rejected the update');
        }
        console.log(`[sandbox] applied runtime sandbox enforcement for comment agent ${agentId}`);
      } catch (err: any) {
        console.error(
          `[sandbox] options.update threw for comment agent ${agentId}: ${err?.message ?? err}; ` +
          `aborting launch to avoid running unsandboxed.`,
        );
        try { await (session as any).abort?.(); } catch { /* best-effort */ }
        throw new Error(`Failed to apply sandbox configuration: ${err?.message ?? 'unknown error'}`);
      }
    }
    if (!launchStillWanted()) {
      try { await (session as any).abort?.(); } catch { /* best-effort */ }
      return { error: 'Agent launch cancelled' };
    }

    const sessionId = (session as any).sessionId || agentId;
    record.sessionId = sessionId;
    record.session = session;
    persistence.updateSessionId(agentId, sessionId);
    persistence.updateStatus(record);

    setupListeners(session, record);

    // Auto-enable remote if the user has opted into auto-remote for all
    // workers — mirrors launchQuickAgent so canvas @mentions/comments and
    // the workers-tab path have the same Mission Control behavior.
    if (getConfigValue('remoteAutoEnable')) {
      enableRemoteControl(agentId).catch((err: any) => {
        console.error(`[comment-workflow] Auto-enable remote failed for agent=${agentId}:`, err);
      });
    }

    // Notify renderer to show presence
    notifier.notifyRenderer('agent:presence-started', {
      agentId,
      spaceId,
      persona: { name: persona.handle, handle: persona.handle },
      anchor,
      ...(threadId ? { threadId } : {}),
    });
    notifier.notifyRenderer('agent:status-changed', {
      agentId,
      status: 'running',
      summary: record.summary,
      spaceId,
      threadId,
    });

    // Cloud sessions: wait for the remote worker's `session.start` event
    // before sending — otherwise the runtime silently swallows the prompt
    // (see waitForCloudSessionStart docs). Mirrors the gating
    // launchQuickAgent applies for the workers-tab @cloud path so canvas
    // @mentions/comments behave the same way.
    console.log(`[sdk-send] comment-agent agent=${agentId.slice(0, 8)} session.send promptLen=${commentBody.length}${isCloudSandbox ? ' (after cloud start)' : ''}`);
    if (isCloudSandbox) await waitForCloudSessionStart(session, agentId);
    if (!launchStillWanted()) {
      try { await session.abort?.(); } catch { /* best-effort */ }
      return { error: 'Agent launch cancelled' };
    }

    // Do not report a successful launch until the runtime accepts the initial
    // prompt. Otherwise a rejected send looks like an agent that never started.
    record.phase = 'active';
    const messageId = await session.send({
      prompt: commentBody,
      attachments: [{ type: 'file' as const, path: canvasPath, displayName: documentDisplayName }],
    });
    console.log(`[sdk-send] comment-agent agent=${agentId.slice(0, 8)} session.send resolved messageId=${messageId ?? '<undefined>'}`);

    return { agentId, sessionId };
  } catch (err: any) {
    if (!record.aborted) {
      try { await session?.abort?.(); } catch { /* best-effort cleanup */ }
      try { await session?.disconnect?.(); } catch { /* best-effort cleanup */ }
      record.status = 'failed';
      record.summary = `Error: ${err.message || 'Unknown'}`;
      persistence.updateStatus(record);
      notifier.notifyRenderer('agent:status-changed', {
        agentId,
        status: 'failed',
        summary: record.summary,
        spaceId,
        threadId,
      });
      notifier.notifyRenderer(`chat:event:${agentId}`, {
        type: 'session.error',
        message: err.message || 'Failed to launch comment agent',
      });
      notifier.notifyRenderer('agent:presence-ended', { agentId, spaceId });
    }
    return { error: err.message || 'Failed to launch comment agent' };
  }
}

export function handleCommentAgentCompletion(record: AgentRecord): void {
  const ctx = record.commentContext;
  if (!ctx) return;

  // End presence
  notifier.notifyRenderer('agent:presence-ended', {
    agentId: record.agentId,
    spaceId: record.spaceId,
  });

  // Detect if the agent modified the target document. Main canvases rely on
  // their file watcher; child pages need a completion-time push because they
  // don't have a watcher.
  let documentChanged = false;
  let newContent = '';
  try {
    newContent = fs.readFileSync(ctx.canvasPath, 'utf-8');
    const currentHash = crypto.createHash('md5').update(newContent).digest('hex');
    documentChanged = ctx.canvasHashBefore !== '' && currentHash !== ctx.canvasHashBefore;
  } catch { /* non-fatal */ }

  if (documentChanged && record.spaceId.startsWith('__page__')) {
    notifier.notifyRenderer('canvas:content-updated', {
      spaceId: record.spaceId,
      content: newContent,
    });
  }

  // Send reply to renderer
  const replyBody = documentChanged
    ? `[bot] I've made changes to the ${ctx.documentLabel ?? 'document'}. Ready for your review.`
    : `[bot] ${record.summary}`;

  notifier.notifyRenderer('agent:reply-ready', {
    agentId: record.agentId,
    spaceId: record.spaceId,
    threadId: ctx.threadId,
    body: replyBody,
  });
}
