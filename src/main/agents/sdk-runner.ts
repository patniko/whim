import { CopilotSession } from '@github/copilot-sdk';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { getCopilotClient, ensureEphemeralCopilotClient } from '../ai';
import { AgentAnchor, type LaunchDocumentAgentOptions } from '../../shared/types';
import { getConfig, getConfigValue, type AgentPersona } from '../config';
import { getAllMcpServers } from '../mcp';
import { AgentRegistry, truncate } from './agent-registry';
import { InMemoryFsProvider } from './in-memory-fs-provider';
import type { AgentRecord } from './agent-registry';
import { AgentNotifier } from './agent-notifier';
import { AgentPersistence } from './agent-persistence';
import { InteractionBroker } from './interaction-broker';
import type { SubagentTracker } from '../subagent-service';
import { getCustomTools, type CustomToolsContext } from '../tools';
import { appendSpaceActivity } from '../space-eventlog';
import { buildSandboxLaunchSetup } from './sandbox-launch';
import { SANDBOX_WORKSPACE_SYSTEM_PROMPT } from './sandbox-policies';
import { listSpaces, updateCanvasContent, listSkills } from '../database';
import { getWorkspaceRepo } from '../cloud-agent';
import { parseFrontmatter } from '../frontmatter';
import { resolveRunCanvasConfig } from '../canvas/canvas-launch';
import {
  handleCanvasSessionEvent,
  initCanvasLifecycle,
  reconcileOpenCanvases,
  releaseCanvasInstances,
} from '../canvas/canvas-lifecycle';

/**
 * Resolve cloud session options from the workspace. Attempts to detect the
 * GitHub repository so the cloud sandbox is provisioned with repo context.
 */
async function resolveCloudSessionOptions(workspaceRoot: string): Promise<{ repository?: { owner: string; name: string } }> {
  try {
    const repoInfo = await getWorkspaceRepo(workspaceRoot);
    if (repoInfo) {
      return { repository: { owner: repoInfo.owner, name: repoInfo.repo } };
    }
  } catch { /* non-git workspace — cloud sandbox without repo context */ }
  return {};
}

/**
 * Wait for a cloud session's remote worker to report `session.start` before
 * sending prompts. Until `hasSessionStarted` flips inside the runtime, calls
 * to `session.send` are silently swallowed (the runtime logs an error but
 * `sendForSchema` still resolves with a fresh messageId). See
 * copilot-agent-runtime: src/core/remote/remoteSession.ts:assertRemoteSessionStarted
 * and src/core/session.ts:sendForSchema (RemoteSession override).
 *
 * Exported so non-quick-launch entry points (e.g. canvas @mentions /
 * comments via `launchCommentAgent`) gate their first `session.send` the
 * same way the workers-tab path does — otherwise cloud comment agents
 * appear to spawn but silently drop the prompt.
 */
export async function waitForCloudSessionStart(
  session: CopilotSession,
  agentId: string,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let off: (() => void) | undefined;
    const timer = setTimeout(() => {
      try { off?.(); } catch { /* ignore */ }
      reject(new Error(`Cloud session did not emit session.start within ${timeoutMs}ms`));
    }, timeoutMs);
    off = (session as any).on('session.start', (event: any) => {
      const data = event?.data ?? event;
      // For cloud sessions, the runtime emits session.start ONLY when the
      // remote copilot-agent worker has connected (producer: "copilot-agent",
      // remoteSteerable: true). Local placeholder events don't fire this.
      console.log(
        `[sdk-send] agent=${agentId.slice(0, 8)} cloud session.start received ` +
        `(producer=${data?.producer ?? '?'}, remoteSteerable=${data?.remoteSteerable ?? '?'})`,
      );
      clearTimeout(timer);
      try { off?.(); } catch { /* ignore */ }
      resolve();
    });
  });
}

/** Shared dependencies injected from agent-service at init time. */
let registry: AgentRegistry;
let notifier: AgentNotifier;
let persistence: AgentPersistence;
let broker: InteractionBroker;
let subagentTracker: SubagentTracker;

/**
 * SDK event types that represent meaningful transcript milestones.  Any
 * event matching this set is persisted to `agent_chat_events` so the
 * conversation can be reconstructed and replayed into a fresh session if
 * the original session becomes unreachable.
 *
 * Deliberately omits:
 *  - `*_delta` events (partial chunks superseded by the matching
 *     complete event)
 *  - `tool.execution_progress` (noisy free-text status updates)
 *  - `assistant.message_partial`-style telemetry
 *
 * The set is closed-list rather than allow-by-default because new SDK
 * event types should be reviewed before they enter the transcript path
 * (some carry large internal payloads that bloat the event log).
 */
const PERSISTED_CHAT_EVENT_TYPES = new Set<string>([
  'user.message',
  'assistant.message',
  'assistant.reasoning',
  'tool.execution_start',
  'tool.execution_complete',
  'session.error',
  'session.warning',
  'session.idle',
  'session.start',
]);

export function initSdkRunner(deps: {
  registry: AgentRegistry;
  notifier: AgentNotifier;
  persistence: AgentPersistence;
  broker: InteractionBroker;
  subagentTracker: SubagentTracker;
}): void {
  registry = deps.registry;
  notifier = deps.notifier;
  persistence = deps.persistence;
  broker = deps.broker;
  subagentTracker = deps.subagentTracker;

  // Closing an artifact window has to reach the runtime, so the lifecycle needs
  // a way back to the live session for a run.
  initCanvasLifecycle({
    getSession: (agentId: string) => registry.get(agentId)?.session as any,
  });
}

interface InitialPromptOptions {
  prompt: string;
  attachments?: Array<{ type: 'file'; path: string; displayName: string }>;
  waitForCloud?: boolean;
  logLabel: string;
}

function launchStillWanted(record: AgentRecord): boolean {
  return !record.aborted && registry.get(record.agentId) === record;
}

async function disconnectLaunchSession(session: CopilotSession, preserveOnAbortFailure = false): Promise<boolean> {
  try {
    await session.abort();
  } catch {
    if (preserveOnAbortFailure) return false;
  }
  try { await session.disconnect(); } catch { /* best-effort cleanup */ }
  return true;
}

async function failInitialLaunch(
  session: CopilotSession,
  record: AgentRecord,
  error: unknown,
): Promise<void> {
  const stopped = await disconnectLaunchSession(session, record.runLocation === 'cloud');
  if (record.aborted) return;

  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (!stopped && record.runLocation === 'cloud') {
    record.phase = 'active';
    record.summary = `Initial launch failed and the cloud worker could not be stopped: ${message}. Retry abort before deleting it.`;
    broker.clearPendingInteractions(record);
    if (!record.ephemeral) persistence.updateStatus(record);
    notifier.notifyRenderer('agent:status-changed', {
      agentId: record.agentId,
      status: record.status,
      summary: record.summary,
      spaceId: record.spaceId,
      threadId: record.commentContext?.threadId,
      trackingError: true,
    });
    notifier.notifyRenderer(`chat:event:${record.agentId}`, {
      type: 'session.error',
      message: record.summary,
    });
    return;
  }
  record.aborted = true;
  record.status = 'failed';
  record.summary = `Error: ${message}`;
  broker.clearPendingInteractions(record);
  if (!record.ephemeral) persistence.updateStatus(record);
  notifier.notifyRenderer('agent:status-changed', {
    agentId: record.agentId,
    status: 'failed',
    summary: record.summary,
    spaceId: record.spaceId,
    threadId: record.commentContext?.threadId,
  });
  notifier.notifyRenderer(`chat:event:${record.agentId}`, {
    type: 'session.error',
    message,
  });
  if (record.commentContext) {
    notifier.notifyRenderer('agent:presence-ended', {
      agentId: record.agentId,
      spaceId: record.spaceId,
    });
  }
  if (record.sandbox) {
    const { cleanupSandboxConfigs } = require('../ai');
    cleanupSandboxConfigs(record.agentId);
  }
}

/**
 * Submit the first prompt for a newly-created session. Launch callers only
 * report success after the runtime accepts this request.
 */
export async function sendInitialPrompt(
  session: CopilotSession,
  record: AgentRecord,
  options: InitialPromptOptions,
): Promise<string> {
  try {
    if (options.waitForCloud) {
      await waitForCloudSessionStart(session, record.agentId);
    }
    if (!launchStillWanted(record)) {
      await disconnectLaunchSession(session);
      throw new Error('Agent launch cancelled');
    }

    console.log(
      `[sdk-send] ${options.logLabel} agent=${record.agentId.slice(0, 8)} ` +
      `session.send promptLen=${options.prompt.length}`,
    );
    const messageId = await session.send({
      prompt: options.prompt,
      ...(options.attachments ? { attachments: options.attachments } : {}),
    });
    if (!launchStillWanted(record)) {
      throw new Error('Agent launch cancelled');
    }
    record.phase = 'active';
    console.log(
      `[sdk-send] ${options.logLabel} agent=${record.agentId.slice(0, 8)} ` +
      `session.send resolved messageId=${messageId ?? '<undefined>'}`,
    );
    return messageId;
  } catch (error) {
    if (!record.aborted) {
      console.error(
        `[sdk-send] ${options.logLabel} agent=${record.agentId.slice(0, 8)} ` +
        `initial send failed:`,
        error instanceof Error ? error.message : error,
      );
      await failInitialLaunch(session, record, error);
    }
    throw error;
  }
}

function shouldEnableWhimTools(spaceId?: string | null): boolean {
  return !spaceId || spaceId === '__workspace__';
}

function createCustomToolsContext(agentId: string, enableWhimTools = false): CustomToolsContext {
  if (!enableWhimTools) {
    return { agentId, broker };
  }

  return {
    agentId,
    broker,
    enableWhimTools: true,
    registry,
    getSpaces: () =>
      listSpaces().map((space) => ({
        id: space.id,
        description: space.description,
        body: space.body,
        status: space.status,
        folder: space.folder,
      })),
    setYoloMode: async (targetAgentId: string, enabled: boolean) => {
      const record = registry.get(targetAgentId);
      if (!record) return { error: 'Agent not found' };

      record.yoloMode = enabled;
      console.log(`[agent-service] yolo mode ${enabled ? 'enabled' : 'disabled'} for agent=${targetAgentId}`);
      persistence.updateYolo(record, enabled);
      notifier.notifyRenderer('agent:yolo-changed', { agentId: targetAgentId, enabled });

      if (enabled && record.pendingApprovals.size > 0) {
        for (const requestId of [...record.pendingApprovals.keys()]) {
          broker.approveAgent(targetAgentId, requestId, true);
        }
      }

      return { ok: true };
    },
    sendChatMessage: async (targetAgentId: string, prompt: string) => sendChatMessage(targetAgentId, prompt),
    getAgentHistory: async (targetAgentId: string) => getAgentHistory(targetAgentId),
  };
}

/** Build a system prompt fragment describing available CLI tools */
export function buildCliToolsPrompt(): string {
  const tools = getConfigValue('cliTools') || [];
  if (tools.length === 0) return '';
  const lines = tools.map((t: { name: string; description: string }) => `- \`${t.name}\`: ${t.description}`);
  return `\n\nThe following CLI tools may be available in the environment (verify before use):\n${lines.join('\n')}`;
}

/**
 * Resolve skill config for a canvas-based session.
 * Reads the canvas frontmatter `skills` array and computes the
 * `skillDirectories` + `disabledSkills` config for createSession.
 * Returns undefined if no skills are linked (avoids auto-loading).
 */
export function resolveLinkedSkillConfig(
  canvasContent: string,
  workspaceRoot: string,
): { skillDirectories: string[]; disabledSkills: string[] } | undefined {
  const { frontmatter } = parseFrontmatter(canvasContent);
  const linkedIds: string[] = Array.isArray(frontmatter.skills) ? frontmatter.skills : [];
  if (linkedIds.length === 0) return undefined;

  const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
  const allSkills = listSkills();
  const linkedSet = new Set(linkedIds);
  const disabledSkills = allSkills
    .filter(s => !linkedSet.has(s.id))
    .map(s => s.name);

  return { skillDirectories: [skillsDir], disabledSkills };
}

export async function launchAgent(
  spaceId: string,
  selectedText: string,
  anchor: AgentAnchor,
  workspaceRoot: string,
  spaceFolder: string,
  _options?: { repo?: string; model?: string }
): Promise<{ agentId: string; sessionId: string } | { error: string }> {
  const client = getCopilotClient();
  if (!client) {
    return { error: 'Copilot SDK not initialized' };
  }

  const agentId = uuid();
  const workingDir = path.join(workspaceRoot, spaceFolder);

  // Snapshot canvas hash for change detection on completion
  const canvasPath = path.join(workingDir, 'canvas.md');
  let canvasHashBefore = '';
  let canvasContentRaw = '';
  try {
    canvasContentRaw = fs.readFileSync(canvasPath, 'utf-8');
    canvasHashBefore = crypto.createHash('md5').update(canvasContentRaw).digest('hex');
  } catch { /* file may not exist yet */ }

  // Resolve linked skills from canvas frontmatter
  const skillConfig = resolveLinkedSkillConfig(canvasContentRaw, workspaceRoot);

  try {
    const mcpServers = getAllMcpServers();
    const cliToolsPrompt = buildCliToolsPrompt();
    const findRecord = (sid: string) => registry.findBySessionId(sid);

    const session = await client.createSession({
      workingDirectory: workingDir,
      streaming: true,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      tools: getCustomTools(createCustomToolsContext(agentId)),
      onPermissionRequest: broker.createPermissionHandler(findRecord),
      onUserInputRequest: broker.createUserInputHandler(findRecord),
      onElicitationRequest: broker.createElicitationHandler(findRecord),
      ...(skillConfig ? { skillDirectories: skillConfig.skillDirectories, disabledSkills: skillConfig.disabledSkills } : {}),
      systemMessage: {
        mode: 'append',
        content: `\nThe user selected the following text from their canvas document and wants you to work on it:\n\n---\n${selectedText}\n---\n\nThe full canvas document is available as canvas.md in the working directory.${cliToolsPrompt}`,
      },
    });

    const sessionId = (session as any).sessionId || agentId;
    const now = new Date().toISOString();

    const record: AgentRecord = {
      agentId,
      sessionId,
      session,
      phase: 'starting',
      spaceId,
      selectedText,
      anchor,
      status: 'running',
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary: 'Starting...',
      canvasSnapshot: { path: canvasPath, hashBefore: canvasHashBefore },
    };
    registry.set(agentId, record);

    // Persist to DB (both canvas_agents for backward compat + agent_sessions as central registry)
    persistence.createCanvasAgentRecord({
      id: agentId,
      space_id: spaceId,
      selected_text: selectedText,
      session_id: sessionId,
      pid: null,
      status: 'running',
      created_at: now,
      updated_at: now,
    });

    persistence.createAgentSessionRecord({
      id: agentId,
      session_id: sessionId,
      space_id: spaceId,
      prompt: selectedText,
      status: 'running',
      summary: 'Starting...',
      working_dir: workingDir,
      source: 'sdk',
      persona_handle: null,
      quoted_text: null,
      run_location: 'local',
      created_at: now,
      updated_at: now,
    });

    // Set up event listeners
    setupAgentEventListeners(session, record);

    // Auto-enable remote if the user has opted into auto-remote for all workers
    if (getConfigValue('remoteAutoEnable')) {
      enableRemoteControl(agentId).catch((err: any) => {
        console.error(`[sdk-runner] Auto-enable remote failed for agent=${agentId}:`, err);
      });
    }

    // Log to per-space activity log
    logIntentActivity(record, 'agent.launched', {
      sessionId,
      prompt: truncate(selectedText, 200),
      cwd: workingDir,
    });

    await sendInitialPrompt(session, record, {
      prompt: selectedText,
      attachments: [{ type: 'file' as const, path: path.join(workingDir, 'canvas.md'), displayName: 'canvas.md' }],
      logLabel: 'selection-agent',
    });

    return { agentId, sessionId };
  } catch (err: any) {
    return { error: err.message || 'Failed to launch agent' };
  }
}

export async function launchQuickAgent(
  prompt: string,
  workspaceRoot: string,
  persona?: AgentPersona,
): Promise<{ agentId: string; sessionId: string } | { error: string }> {
  const isEphemeral = persona?.ephemeral === true;
  const isCloudSandbox = persona?.runLocation === 'cloud';
  // Cloud sessions use the regular client — the cloud environment provides its
  // own filesystem so we avoid the sessionFs + cloud interaction on the
  // ephemeral client.
  const client = (isEphemeral && !isCloudSandbox) ? await ensureEphemeralCopilotClient() : getCopilotClient();
  if (!client) {
    return { error: isEphemeral ? 'Ephemeral Copilot client not initialized' : 'Copilot SDK not initialized' };
  }

  const agentId = uuid();

  try {
    const cliToolsPrompt = buildCliToolsPrompt();
    const findRecord = (sid: string) => registry.findBySessionId(sid);

    const customToolsContext = createCustomToolsContext(agentId, true);
    const sandboxSetup = persona
      ? buildSandboxLaunchSetup({
        agentId,
        workingDir: workspaceRoot,
        persona,
        registry,
        broker,
        customToolsContext,
      })
      : null;
    const isSandboxed = sandboxSetup?.isSandboxed === true;
    const sandboxConfigs = sandboxSetup?.sandboxConfigs ?? null;
    const mcpServers = sandboxSetup ? sandboxSetup.mcpServers : getAllMcpServers();
    const customTools = sandboxSetup ? sandboxSetup.customTools : getCustomTools(customToolsContext);
    const sandboxState = sandboxSetup?.sandboxState;
    const hooks = sandboxSetup?.hooks;
    const enforcementMode = sandboxSetup?.enforcementMode ?? 'both';
    // Permission-handler routing:
    //   - both     → path-aware sandbox handler (host-side path checks +
    //                bubble-up dialog for out-of-scope writes)
    //   - mxc-only → auto-approve handler (MXC is sole enforcer; SDK calls
    //                proceed to MXC for shell, unrestricted for SDK file ops)
    //   - non-sandboxed → regular interactive handler
    const useHostPathAwareHandler = isSandboxed && enforcementMode === 'both';
    const useMxcOnlyAutoApprove = isSandboxed && enforcementMode === 'mxc-only';

    // When a persona is supplied, prepend its instructions to the system message
    // and use its preferred model.  Persona handles are matched against the
    // 'personas' config; cloud routing happens in the IPC handler so this path
    // only handles local and cloud sessions.
    const personaPreamble = persona ? `${persona.instructions}\n\n` : '';
    const baseSystemContent = `${personaPreamble}${cliToolsPrompt}`.trim();
    // In mxc-only mode the host-side guards are deliberately suppressed so MXC
    // is the sole enforcer; the agent must NOT be told it's sandboxed,
    // otherwise we can't observe MXC's own denials. Only append the
    // [SANDBOX MODE] fragment when host-side guards are also active.
    const systemContent = isSandboxed && enforcementMode === 'both'
      ? `${baseSystemContent}${SANDBOX_WORKSPACE_SYSTEM_PROMPT}`
      : baseSystemContent;

    // Resolve cloud session options for cloud personas
    const cloudOpts = isCloudSandbox ? await resolveCloudSessionOptions(workspaceRoot) : undefined;

    const sessionConfig = {
      workingDirectory: workspaceRoot,
      streaming: true,
      ...(sandboxConfigs ? { configDir: sandboxConfigs.onDir } : {}),
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      tools: customTools,
      ...(persona?.model ? { model: persona.model } : {}),
      ...(hooks ? { hooks } : {}),
      ...(systemContent ? {
        systemMessage: {
          mode: 'append' as const,
          content: `\n${systemContent}`,
        },
      } : {}),
      ...((isEphemeral && !isCloudSandbox) ? { createSessionFsHandler: () => new InMemoryFsProvider() } : {}),
      ...(cloudOpts ? { cloud: cloudOpts } : {}),
      onPermissionRequest: useHostPathAwareHandler
        ? broker.createPathAwareSandboxPermissionHandler(findRecord)
        : useMxcOnlyAutoApprove
          ? broker.createMxcOnlyPermissionHandler(findRecord)
          : broker.createPermissionHandler(findRecord),
      onUserInputRequest: broker.createUserInputHandler(findRecord),
      onElicitationRequest: broker.createElicitationHandler(findRecord),
    };

    const session = await client.createSession(sessionConfig);

    // The runtime does NOT auto-load sandbox enforcement from configDir. We
    // must explicitly push the sandboxConfig via options.update so MXC
    // wraps shell commands with sandbox-exec. This MUST resolve before
    // session.send so the first tool call is gated.
    // See cli/promptMode.ts:346 for the reference implementation; the
    // configDir we set above only isolates per-session-state (events, hooks).
    if (isSandboxed && sandboxSetup?.runtimeSandboxConfig && !isCloudSandbox) {
      try {
        const result = await (session as any).rpc.options.update({
          sandboxConfig: sandboxSetup.runtimeSandboxConfig,
        });
        if (result?.success === false) {
          console.error(
            `[sandbox] options.update returned success=false for agent ${agentId}; ` +
            `aborting launch to avoid running unsandboxed.`,
          );
          try { await (session as any).abort?.(); } catch { /* best-effort */ }
          return { error: 'Failed to apply sandbox configuration (runtime rejected the update)' };
        }
        console.log(`[sandbox] applied runtime sandbox enforcement for agent ${agentId}`);
      } catch (err: any) {
        console.error(
          `[sandbox] options.update threw for agent ${agentId}: ${err?.message ?? err}; ` +
          `aborting launch to avoid running unsandboxed.`,
        );
        try { await (session as any).abort?.(); } catch { /* best-effort */ }
        return { error: `Failed to apply sandbox configuration: ${err?.message ?? 'unknown error'}` };
      }
    }

    const sessionId = (session as any).sessionId || agentId;
    const now = new Date().toISOString();

    const summary = persona ? `Starting as @${persona.handle}...` : 'Starting...';

    const record: AgentRecord = {
      agentId,
      sessionId,
      session,
      phase: 'starting',
      spaceId: '__workspace__',
      selectedText: prompt,
      anchor: { quote: '', prefix: '', suffix: '' },
      status: 'running',
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary,
      runLocation: isCloudSandbox ? 'cloud' : 'local',
      ...(sandboxState ? { sandbox: sandboxState } : {}),
      ...(persona?.yolo ? { yoloMode: true } : {}),
      ...(persona?.handle ? { personaHandle: persona.handle } : {}),
      ...(isEphemeral ? { ephemeral: true } : {}),
    };
    registry.set(agentId, record);

    // Notify renderer of yolo mode if persona enables it
    if (persona?.yolo) {
      notifier.notifyRenderer('agent:yolo-changed', { agentId, enabled: true });
    }

    if (!isEphemeral) {
      persistence.createAgentSessionRecord({
        id: agentId,
        session_id: sessionId,
        space_id: null,
        prompt,
        status: 'running',
        summary,
        working_dir: workspaceRoot,
        source: 'sdk',
        persona_handle: persona?.handle ?? null,
        quoted_text: null,
        run_location: isCloudSandbox ? 'cloud' : 'local',
        yolo_mode: record.yoloMode === true,
        created_at: now,
        updated_at: now,
      });
    }

    setupAgentEventListeners(session, record);

    // Auto-enable remote if the user has opted into auto-remote for all workers
    if (getConfigValue('remoteAutoEnable')) {
      enableRemoteControl(agentId).catch((err: any) => {
        console.error(`[sdk-runner] Auto-enable remote failed for agent=${agentId}:`, err);
      });
    }

    await sendInitialPrompt(session, record, {
      prompt,
      waitForCloud: isCloudSandbox,
      logLabel: 'quick-agent',
    });

    return { agentId, sessionId };
  } catch (err: any) {
    return { error: err.message || 'Failed to launch agent' };
  }
}

/** Launch an SDK agent with the full canvas document as context, using the space folder as cwd. */
export async function launchDocumentAgent(
  spaceId: string,
  workspaceRoot: string,
  spaceFolder: string,
  options: LaunchDocumentAgentOptions = {},
): Promise<{ agentId: string; sessionId: string } | { error: string }> {
  const client = getCopilotClient();
  if (!client) {
    return { error: 'Copilot SDK not initialized' };
  }

  const agentId = uuid();
  const workingDir = path.join(workspaceRoot, spaceFolder);

  // Read the full canvas document
  const canvasPath = path.join(workingDir, 'canvas.md');
  let documentContent = '';
  try {
    if (fs.existsSync(canvasPath)) {
      documentContent = fs.readFileSync(canvasPath, 'utf-8');
    }
  } catch { /* proceed with empty content */ }

  if (!documentContent.trim()) {
    return { error: 'Canvas document is empty — add content before running' };
  }

  // Snapshot canvas hash for change detection on completion
  const canvasHashBefore = crypto.createHash('md5').update(documentContent).digest('hex');

  const parsedDocument = parseFrontmatter<Record<string, unknown>>(documentContent);
  const handleFromFrontmatter = typeof parsedDocument.frontmatter.preferred_agent === 'string'
    ? parsedDocument.frontmatter.preferred_agent.trim()
    : '';
  const hasExplicitPersona = Object.prototype.hasOwnProperty.call(options, 'personaHandle');
  const requestedPersonaHandle = hasExplicitPersona
    ? (options.personaHandle || '').trim()
    : handleFromFrontmatter;
  const allPersonas = (getConfigValue('personas') as AgentPersona[]) || [];
  const persona = requestedPersonaHandle
    ? allPersonas.find(p => p.handle === requestedPersonaHandle) || null
    : null;
  if (requestedPersonaHandle && !persona) {
    return { error: `Persona @${requestedPersonaHandle} not found` };
  }
  if (persona?.runLocation === 'cca') {
    return { error: 'CCA preferred agents are not supported for canvas runs yet' };
  }
  const isCloudSandbox = persona?.runLocation === 'cloud';
  const runPrompt = options.promptOverride?.trim()
    || (typeof parsedDocument.frontmatter.instructions === 'string' && parsedDocument.frontmatter.instructions.trim())
    || 'Execute the instructions in the document. Ask me if you need any clarification.';

  // Resolve linked skills from canvas frontmatter
  const skillConfig = resolveLinkedSkillConfig(documentContent, workspaceRoot);

  try {
    const cliToolsPrompt = buildCliToolsPrompt();
    const findRecord = (sid: string) => registry.findBySessionId(sid);
    const customToolsContext = createCustomToolsContext(agentId);
    const sandboxSetup = persona
      ? buildSandboxLaunchSetup({
        agentId,
        workingDir,
        persona,
        registry,
        broker,
        customToolsContext,
      })
      : null;
    const isSandboxed = sandboxSetup?.isSandboxed === true;
    const sandboxConfigs = sandboxSetup?.sandboxConfigs ?? null;
    const mcpServers = sandboxSetup ? sandboxSetup.mcpServers : getAllMcpServers();
    const customTools = sandboxSetup ? sandboxSetup.customTools : getCustomTools(customToolsContext);
    const sandboxState = sandboxSetup?.sandboxState;
    const hooks = sandboxSetup?.hooks;
    const enforcementMode = sandboxSetup?.enforcementMode ?? 'both';
    const useHostPathAwareHandler = isSandboxed && enforcementMode === 'both';
    const useMxcOnlyAutoApprove = isSandboxed && enforcementMode === 'mxc-only';
    const cloudOpts = isCloudSandbox ? await resolveCloudSessionOptions(workingDir) : undefined;
    const personaPreamble = persona ? `${persona.instructions}\n\n` : '';
    const canvasConfig = resolveRunCanvasConfig({
      workspaceRoot,
      workingDir,
      spaceId,
      runId: agentId,
    });
    const baseSystemPrompt = `${personaPreamble}The user has pressed "Run" on their space document. Execute all instructions in the document below. The full document is also available as canvas.md in your working directory.

Invocation instructions:

---
${runPrompt}
---

Document:

---
${documentContent}
---
${cliToolsPrompt}`;
    const systemPrompt = isSandboxed && enforcementMode === 'both'
      ? `${baseSystemPrompt}${SANDBOX_WORKSPACE_SYSTEM_PROMPT}`
      : baseSystemPrompt;

    const session = await client.createSession({
      workingDirectory: workingDir,
      streaming: true,
      ...(sandboxConfigs ? { configDir: sandboxConfigs.onDir } : {}),
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      tools: customTools,
      ...(persona?.model ? { model: persona.model } : {}),
      ...(hooks ? { hooks } : {}),
      ...(cloudOpts ? { cloud: cloudOpts } : {}),
      onPermissionRequest: useHostPathAwareHandler
        ? broker.createPathAwareSandboxPermissionHandler(findRecord)
        : useMxcOnlyAutoApprove
          ? broker.createMxcOnlyPermissionHandler(findRecord)
          : broker.createPermissionHandler(findRecord),
      onUserInputRequest: broker.createUserInputHandler(findRecord),
      onElicitationRequest: broker.createElicitationHandler(findRecord),
      ...(skillConfig ? { skillDirectories: skillConfig.skillDirectories, disabledSkills: skillConfig.disabledSkills } : {}),
      ...(canvasConfig?.session ?? {}),
      systemMessage: {
        mode: 'append',
        content: `\n${systemPrompt}`,
      },
    });

    if (isSandboxed && sandboxSetup?.runtimeSandboxConfig && !isCloudSandbox) {
      try {
        const result = await (session as any).rpc.options.update({
          sandboxConfig: sandboxSetup.runtimeSandboxConfig,
        });
        if (result?.success === false) {
          try { await (session as any).abort?.(); } catch { /* best-effort */ }
          return { error: 'Failed to apply sandbox configuration (runtime rejected the update)' };
        }
      } catch (err: any) {
        try { await (session as any).abort?.(); } catch { /* best-effort */ }
        return { error: `Failed to apply sandbox configuration: ${err?.message ?? 'unknown error'}` };
      }
    }

    const sessionId = (session as any).sessionId || agentId;
    const now = new Date().toISOString();
    const summary = persona ? `Executing document as @${persona.handle}...` : 'Executing document...';

    const record: AgentRecord = {
      agentId,
      sessionId,
      session,
      phase: 'starting',
      spaceId,
      selectedText: documentContent,
      anchor: { quote: '', prefix: '', suffix: '' },
      status: 'running',
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary,
      runLocation: isCloudSandbox ? 'cloud' : 'local',
      ...(sandboxState ? { sandbox: sandboxState } : {}),
      ...(persona?.yolo ? { yoloMode: true } : {}),
      ...(persona?.handle ? { personaHandle: persona.handle } : {}),
      ...(canvasConfig?.run.scheduled ? { autoApproveCanvasTools: true } : {}),
      canvasSnapshot: { path: canvasPath, hashBefore: canvasHashBefore },
    };
    registry.set(agentId, record);
    if (persona?.yolo) {
      notifier.notifyRenderer('agent:yolo-changed', { agentId, enabled: true });
    }

    persistence.createCanvasAgentRecord({
      id: agentId,
      space_id: spaceId,
      selected_text: truncate(documentContent, 500),
      session_id: sessionId,
      pid: null,
      status: 'running',
      created_at: now,
      updated_at: now,
    });

    persistence.createAgentSessionRecord({
      id: agentId,
      session_id: sessionId,
      space_id: spaceId,
      prompt: truncate(documentContent, 500),
      status: 'running',
      summary,
      working_dir: workingDir,
      source: 'sdk',
      persona_handle: persona?.handle ?? null,
      quoted_text: null,
      run_location: isCloudSandbox ? 'cloud' : 'local',
      yolo_mode: record.yoloMode === true,
      created_at: now,
      updated_at: now,
    });
    notifier.notifyRenderer('agent:status-changed', {
      agentId,
      status: 'running',
      summary,
      spaceId,
    });

    setupAgentEventListeners(session, record);

    // Auto-enable remote if the user has opted into auto-remote for all workers
    if (getConfigValue('remoteAutoEnable')) {
      enableRemoteControl(agentId).catch((err: any) => {
        console.error(`[sdk-runner] Auto-enable remote failed for agent=${agentId}:`, err);
      });
    }

    // Log to per-space activity log
    logIntentActivity(record, 'document.executed', {
      sessionId,
      cwd: workingDir,
    });

    await sendInitialPrompt(session, record, {
      prompt: runPrompt,
      attachments: [{ type: 'file' as const, path: canvasPath, displayName: 'canvas.md' }],
      waitForCloud: isCloudSandbox,
      logLabel: 'document-agent',
    });

    return { agentId, sessionId };
  } catch (err: any) {
    return { error: err.message || 'Failed to launch agent' };
  }
}

/** Send a follow-up message to an active agent session (multi-turn chat). */
export async function sendChatMessage(
  agentId: string,
  prompt: string,
  attachments?: Array<{ type: 'file'; path: string; displayName?: string }>,
): Promise<{ error?: string; restarted?: boolean }> {
  let record = registry.get(agentId);
  let restarted = false;
  if (!record) {
    // Agent not in memory — might be historical (app restarted).
    // Try to re-create a session for it.
    const result = await resumeAgentSession(agentId);
    if (!result) return { error: 'Agent session expired — open in CLI to resume' };
    restarted = result === 'restarted';
    record = registry.get(agentId)!;
  }
  if (record.status !== 'completed' && record.status !== 'running') {
    return { error: `Agent is ${record.status}, cannot send message` };
  }

  // Reactivate completed agents for multi-turn
  record.status = 'running';
  persistence.updateStatus(record);
  notifier.notifyRenderer('agent:status-changed', {
    agentId, status: 'running', summary: record.summary,
  });

  // Notify renderer if session was restarted
  if (restarted) {
    notifier.notifyRenderer(`chat:event:${agentId}`, {
      type: 'session.restarted',
      message: 'Previous session expired — started a fresh session with context from the original conversation.',
    });
  }

  try {
    if (!record.session) {
      return { error: 'Agent is still starting; try again when it is active' };
    }
    const normalizedAttachments = attachments?.map(a => ({
      ...a,
      displayName: a.displayName ?? path.basename(a.path),
    }));
    await record.session.send({
      prompt,
      ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}),
    });
    return { ...(restarted ? { restarted: true } : {}) };
  } catch (err: any) {
    return { error: err.message || 'Failed to send message' };
  }
}

/**
 * Disable the sandbox for the rest of an agent's session.  Calls
 * `session.rpc.options.update({ sandboxConfig: { enabled: false } })` on the
 * existing session — no session swap needed. The runtime drops its sandboxed
 * shell context and restarts MCP stdio servers in response, so subsequent
 * tool calls run unsandboxed.
 *
 * Idempotent: returns silently when the agent is unknown, already disabled,
 * or non-sandboxed.
 *
 * Ordering: callers should `await` this BEFORE resolving the pending
 * sandbox-block broker callback so that the unblocked tool call runs after
 * the runtime has actually disabled enforcement.
 */
export async function disableSandboxForSession(agentId: string): Promise<void> {
  const record = registry.get(agentId);
  if (!record || !record.sandbox) {
    console.log(`[agent-service] disableSandboxForSession: no sandbox state for ${agentId}`);
    return;
  }
  if (record.sandbox.state === 'off') {
    console.log(`[agent-service] disableSandboxForSession: already off for ${agentId}`);
    return;
  }
  if (!record.session) {
    console.warn(`[agent-service] disableSandboxForSession: session not active for ${agentId}`);
    return;
  }

  try {
    const result = await (record.session as any).rpc.options.update({
      sandboxConfig: { enabled: false },
    });
    if (result?.success === false) {
      throw new Error('runtime rejected sandbox disable');
    }

    record.sandbox.state = 'off';
    record.status = 'running';
    persistence.updateStatus(record);

    notifier.notifyRenderer(`chat:event:${agentId}`, {
      type: 'sandbox.disabled',
      reason: 'user-requested',
    });
    notifier.notifyRenderer('agent:status-changed', {
      agentId, status: 'running', summary: 'Sandbox disabled',
    });

    // Re-prompt the agent so it retries the just-blocked operation now that
    // enforcement is off. Fire-and-forget; errors surface via the session
    // error listener.
    record.session.send({
      prompt: 'Sandbox is now disabled. Please retry the operation that was just blocked.',
    }).catch((err: any) => {
      console.error(`[agent-service] retry-after-disable send failed for ${agentId}:`, err);
    });

    console.log(`[agent-service] Disabled sandbox for agent ${agentId}`);
  } catch (err: any) {
    console.error('[agent-service] disableSandboxForSession failed:', err);
    notifier.notifyRenderer(`chat:event:${agentId}`, {
      type: 'session.error',
      message: `Failed to disable sandbox: ${err?.message ?? 'unknown error'}`,
    });
  }
}

/**
 * Reconstruct a minimal {@link CommentAgentContext} from a persisted session so
 * a resumed/restarted comment agent keeps routing live events (status, presence,
 * replies, interactions) to its canvas comment thread.  Only `comment_thread_id`,
 * `persona_handle`, `quoted_text`, and `prompt` survive persistence; the anchor
 * prefix/suffix and pre-edit canvas hash are not persisted, so anchor is left
 * empty and `canvasHashBefore` is '' (which disables completion-time change
 * detection — the reply falls back to the agent summary, which is correct after
 * a restart). Returns `undefined` for non-comment agents.
 */
function commentContextFromPersisted(
  persisted: import('../../shared/types').AgentSession,
  workingDir: string,
): import('./agent-registry').CommentAgentContext | undefined {
  if (!persisted.comment_thread_id) return undefined;
  return {
    threadId: persisted.comment_thread_id,
    personaHandle: persisted.persona_handle ?? '',
    personaName: persisted.persona_handle ?? '',
    commentBody: persisted.prompt,
    quotedText: persisted.quoted_text ?? '',
    anchor: {},
    canvasHashBefore: '',
    canvasPath: path.join(workingDir, 'canvas.md'),
    documentDisplayName: 'canvas.md',
    documentLabel: 'canvas document',
  };
}

/** Attempt to resume a historical agent by restoring its SDK session.
 *  Returns 'resumed' if the original session was restored, 'restarted' if a
 *  new session was created because the original expired, or false on failure. */
async function resumeAgentSession(agentId: string): Promise<'resumed' | 'restarted' | false> {
  const persisted = persistence.getSession(agentId);
  if (!persisted) return false;

  const client = getCopilotClient();
  if (!client) return false;

  const config = getConfig();
  const workspaceRoot = config.workspace;
  if (!workspaceRoot) return false;

  const workingDir = persisted.working_dir || workspaceRoot;
  const isCloud = persisted.run_location === 'cloud';

  try {
    const mcpServers = getAllMcpServers();
    const findRecord = (sid: string) => registry.findBySessionId(sid);
    const customToolsContext = createCustomToolsContext(agentId, shouldEnableWhimTools(persisted.space_id));

    // Cloud sessions: the local SDK runtime has no record of the session
    // after an app restart (the runtime process is fresh; only the cloud
    // worker persisted). `session.resume` would fail with
    // "Session not found: <id>" because activeSessions/disk-store don't
    // contain it.  `sessions.connect` re-registers the cloud session with
    // the runtime by fetching the remote task metadata and constructing a
    // RemoteSession — see copilot-agent-runtime
    // src/core/server.ts:543 (sessions.connect → initializeConnectedRemoteSession).
    // After connect succeeds the session is in activeSessions and the
    // subsequent `resumeSession` finds it (server.ts:2079) and wires up
    // our handlers without reloading from disk.
    if (isCloud) {
      try {
        await (client as any).rpc.sessions.connect({ sessionId: persisted.session_id });
        console.log(`[agent-service] Reconnected to cloud session ${persisted.session_id} for agent ${agentId}`);
      } catch (connectErr: any) {
        const msg = connectErr?.message ?? String(connectErr);
        console.warn(`[agent-service] sessions.connect failed for cloud agent ${agentId}: ${msg}`);
        // Cloud worker unreachable (expired / deleted / network).  Skip
        // resumeSession (that path would just produce the misleading
        // "Session not found") and fall through to the outer catch so
        // restartExpiredSession can replay the persisted transcript into
        // a fresh local session — preserving the user's conversation.
        throw connectErr;
      }
    }

    // Use resumeSession to restore full conversation history (not createSession
    // which would start a fresh session with no history).
    // Canvases are re-registered from the space document, not from persisted
    // instances: the runtime restores open canvases from its own durable
    // projection and re-issues `canvas.open` against whatever provider
    // reconnects, so a resumed run keeps refreshing its artifact only if the
    // provider comes back with it.
    const canvasConfig = resolveRunCanvasConfig({
      workspaceRoot,
      workingDir,
      spaceId: persisted.space_id,
      runId: agentId,
    });
    const session = await client.resumeSession(persisted.session_id, {
      workingDirectory: workingDir,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      tools: getCustomTools(customToolsContext),
      onPermissionRequest: broker.createPermissionHandler(findRecord),
      onUserInputRequest: broker.createUserInputHandler(findRecord),
      onElicitationRequest: broker.createElicitationHandler(findRecord),
      ...(canvasConfig?.session ?? {}),
    });

    const validStatuses = new Set(['running', 'waiting-approval', 'completed', 'failed']);
    const restoredStatus = validStatuses.has(persisted.status)
      ? persisted.status as import('./agent-registry').AgentStatus
      : 'completed';

    const record: AgentRecord = {
      agentId,
      sessionId: persisted.session_id,
      session,
      spaceId: persisted.space_id || '__workspace__',
      selectedText: persisted.prompt,
      anchor: { quote: '', prefix: '', suffix: '' },
      status: restoredStatus,
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary: persisted.summary || 'Resumed',
      runLocation: isCloud ? 'cloud' : 'local',
      ...(canvasConfig?.run.scheduled ? { autoApproveCanvasTools: true } : {}),
      ...(persisted.yolo_mode ? { yoloMode: true } : {}),
      ...(persisted.persona_handle ? { personaHandle: persisted.persona_handle } : {}),
      ...(commentContextFromPersisted(persisted, workingDir)
        ? { commentContext: commentContextFromPersisted(persisted, workingDir) }
        : {}),
    };
    registry.set(agentId, record);

    setupAgentEventListeners(session, record);

    // The runtime restores the canvases that were open before the app closed.
    // Adopting them means a window the user closes after a restart is still
    // reported back, instead of lingering in the runtime's projection.
    if (canvasConfig) {
      try {
        reconcileOpenCanvases(agentId, (session as any).openCanvases);
      } catch { /* reconciliation is best-effort */ }
    }

    // For cloud sessions, rediscover the Mission Control URL by re-enabling
    // remote control on the resumed session.  The cloud worker is still
    // running (it didn't die with the app), so `remote.enable({mode:'on'})`
    // returns the existing GitHub URL and re-broadcasts an
    // `agent:remote-changed` so the renderer can re-attach to Mission
    // Control without the user having to manually re-enable remote.
    //
    // This is fire-and-forget; if remote re-enable fails, the user can still
    // chat with the resumed session and toggle remote manually.
    if (isCloud) {
      enableRemoteControl(agentId).catch((err: any) => {
        console.warn(`[sdk-runner] Failed to rediscover remote URL on cloud session resume agent=${agentId}:`, err?.message ?? err);
      });
    }

    return 'resumed';
  } catch (err) {
    console.warn('[agent-service] resumeSession failed, attempting fresh session fallback:', err);

    // CLI sessions must be resumed via CLI — no SDK fallback path.
    if (persisted.source !== 'sdk') {
      return false;
    }

    // For SDK (including cloud sessions whose `sessions.connect` raised
    // earlier in this try-block or whose `resumeSession` failed): roll
    // forward into a fresh local session preloaded with the persisted
    // chat transcript so the user can continue without losing context.
    // Cloud-worker orphaning is not a concern here — if we reached this
    // catch it means the remote side was unreachable, so there is no
    // live worker to orphan.
    return restartExpiredSession(agentId, persisted, workingDir);
  }
}

export function isCloudSessionGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session (?:was )?not found|not found:.*session|session .*expired|session .*deleted/i.test(message);
}

export async function abortRestoredCloudAgent(agentId: string): Promise<'aborted' | 'missing' | 'retry'> {
  const persisted = persistence.getSession(agentId);
  if (!persisted || persisted.source !== 'sdk' || persisted.run_location !== 'cloud') return 'retry';

  const client = getCopilotClient();
  if (!client) return 'retry';

  try {
    await (client as any).rpc.sessions.connect({ sessionId: persisted.session_id });
    const session = await client.resumeSession(persisted.session_id, {
      workingDirectory: persisted.working_dir || getConfig().workspace || undefined,
    });
    await session.abort();
    try {
      await session.disconnect();
    } catch (error) {
      console.warn(`[sdk-runner] Cloud agent ${agentId} aborted but disconnect failed:`, error);
    }
    return 'aborted';
  } catch (error) {
    if (isCloudSessionGone(error)) return 'missing';
    console.warn(`[sdk-runner] Failed to reconnect and abort cloud agent ${agentId}:`, error);
    return 'retry';
  }
}

/**
 * Build a system-message replay from the persisted chat transcript.
 *
 * The transcript is rendered as a Markdown-formatted conversation so the
 * model can pick up where the previous session left off, even when the
 * SDK's own event log isn't available (cloud expired, runtime restarted
 * without local store).
 *
 * Returns `null` when no usable transcript exists; callers should then
 * fall back to a prompt+summary system message.
 *
 * @internal exported for tests
 */
export function buildTranscriptReplayContent(
  events: import('../../shared/types').AgentChatEvent[],
  options: { maxBodyChars?: number; maxEvents?: number } = {},
): string | null {
  const maxBodyChars = options.maxBodyChars ?? 2000;
  const maxEvents = options.maxEvents ?? 40;

  // Keep the most recent N events — older context is summarized into a
  // single placeholder line so we don't blow the model context window.
  let selected = events;
  let dropped = 0;
  if (events.length > maxEvents) {
    dropped = events.length - maxEvents;
    selected = events.slice(-maxEvents);
  }

  const lines: string[] = [];
  if (dropped > 0) {
    lines.push(`*(${dropped} earlier turn${dropped === 1 ? '' : 's'} omitted for brevity)*`);
    lines.push('');
  }

  let appended = 0;
  for (const evt of selected) {
    let payload: any;
    try { payload = JSON.parse(evt.payload); } catch { continue; }

    switch (evt.type) {
      case 'user.message': {
        const content = payload?.content ?? payload?.message ?? payload?.prompt ?? '';
        if (!content) continue;
        lines.push(`**User:** ${truncate(String(content), maxBodyChars)}`);
        appended++;
        break;
      }
      case 'assistant.message': {
        const content = payload?.content ?? payload?.message ?? '';
        if (!content) continue;
        lines.push(`**Assistant:** ${truncate(String(content), maxBodyChars)}`);
        appended++;
        break;
      }
      case 'assistant.reasoning': {
        const content = payload?.content ?? '';
        if (!content) continue;
        lines.push(`*(Assistant reasoning: ${truncate(String(content), 400)})*`);
        appended++;
        break;
      }
      case 'tool.execution_start': {
        const toolName = payload?.toolName ?? 'tool';
        let argsPreview = '';
        try { argsPreview = JSON.stringify(payload?.arguments ?? payload?.toolArgs ?? {}); } catch { /* ignore */ }
        lines.push(`*(Tool call: \`${toolName}\` ${truncate(argsPreview, 200)})*`);
        appended++;
        break;
      }
      case 'tool.execution_complete': {
        const raw = payload?.result;
        const result = typeof raw === 'string' ? raw : raw?.content ?? raw?.detailedContent ?? '';
        const success = payload?.success !== false;
        lines.push(`*(Tool result ${success ? 'ok' : 'failed'}: ${truncate(String(result), 400)})*`);
        appended++;
        break;
      }
      case 'session.error': {
        const msg = payload?.message ?? payload?.error ?? '';
        if (msg) {
          lines.push(`*(Previous session error: ${truncate(String(msg), 200)})*`);
          appended++;
        }
        break;
      }
      // Skip session.start / session.idle / session.warning — they're
      // bookkeeping, not user-meaningful turns.
      default: break;
    }
    lines.push('');
  }

  if (appended === 0) return null;
  return lines.join('\n').trim();
}

/** Create a fresh SDK session to replace an expired one, preserving context. */
async function restartExpiredSession(
  agentId: string,
  persisted: import('../../shared/types').AgentSession,
  workingDir: string,
): Promise<'restarted' | false> {
  const client = getCopilotClient();
  if (!client) return false;

  try {
    const mcpServers = getAllMcpServers();
    const cliToolsPrompt = buildCliToolsPrompt();
    const findRecord = (sid: string) => registry.findBySessionId(sid);
    const customToolsContext = createCustomToolsContext(agentId, shouldEnableWhimTools(persisted.space_id));

    const isCanvasAgent = persisted.space_id && persisted.space_id !== '__workspace__';

    // Resolve linked skills for canvas agents (read from current canvas content)
    let skillConfig: { skillDirectories: string[]; disabledSkills: string[] } | undefined;
    if (isCanvasAgent) {
      try {
        const canvasPath = path.join(workingDir, 'canvas.md');
        if (fs.existsSync(canvasPath)) {
          const canvasContent = fs.readFileSync(canvasPath, 'utf-8');
          // workingDir is workspace/spaceFolder — go up one level for workspace root
          const workspaceRoot = path.dirname(workingDir);
          skillConfig = resolveLinkedSkillConfig(canvasContent, workspaceRoot);
        }
      } catch { /* proceed without skills */ }
    }

    // A restarted session is a new runtime session for the same space, so it
    // must re-register canvases or the run would come back unable to refresh
    // the artifact it was created to maintain.
    const restartWorkspaceRoot = getConfig().workspace;
    const canvasConfig = restartWorkspaceRoot
      ? resolveRunCanvasConfig({
        workspaceRoot: restartWorkspaceRoot,
        workingDir,
        spaceId: persisted.space_id,
        runId: agentId,
      })
      : null;

    // Build system message with previous context.  Prefer the rich
    // persisted transcript when available; fall back to prompt+summary
    // when the transcript is empty (e.g. agent crashed before producing
    // a single chat event).
    const transcriptEvents = persistence.listChatEvents(agentId);
    const transcriptReplay = buildTranscriptReplayContent(transcriptEvents);
    const continuationPreamble = transcriptReplay
      ? `Note: This is a continuation of a previous session that became unreachable. ` +
        `The transcript below captures what was discussed; pick up from where it left off and ` +
        `address the most recent user request.\n\n` +
        `--- previous conversation ---\n${transcriptReplay}\n--- end of transcript ---`
      : `Note: This is a continuation of a previous session that expired. ` +
        `The original request was: "${truncate(persisted.prompt, 500)}". ` +
        `The previous session summary was: "${truncate(persisted.summary || 'No summary', 500)}". ` +
        `Continue helping from where things left off.`;

    let systemContent: string;
    if (isCanvasAgent) {
      // Reconstruct canvas-style system prompt with prior context
      systemContent =
        `\nThe user selected the following text from their canvas document and wants you to work on it:\n\n` +
        `---\n${persisted.prompt}\n---\n\n` +
        `The full canvas document is available as canvas.md in the working directory.${cliToolsPrompt}\n\n` +
        continuationPreamble;
    } else {
      systemContent =
        (cliToolsPrompt ? cliToolsPrompt + '\n\n' : '') +
        continuationPreamble;
    }

    const session = await client.createSession({
      workingDirectory: workingDir,
      streaming: true,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      tools: getCustomTools(customToolsContext),
      onPermissionRequest: broker.createPermissionHandler(findRecord),
      onUserInputRequest: broker.createUserInputHandler(findRecord),
      onElicitationRequest: broker.createElicitationHandler(findRecord),
      ...(skillConfig ? { skillDirectories: skillConfig.skillDirectories, disabledSkills: skillConfig.disabledSkills } : {}),
      ...(canvasConfig?.session ?? {}),
      systemMessage: { mode: 'append', content: systemContent },
    });

    const newSessionId = (session as any).sessionId || agentId;

    const record: AgentRecord = {
      agentId,
      sessionId: newSessionId,
      session,
      spaceId: persisted.space_id || '__workspace__',
      selectedText: persisted.prompt,
      anchor: { quote: '', prefix: '', suffix: '' },
      status: 'completed',
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary: persisted.summary || 'Session restarted',
      restarted: true,
      ...(canvasConfig?.run.scheduled ? { autoApproveCanvasTools: true } : {}),
      // The replacement session is always local — even when the original
      // was cloud — because we no longer have access to the original
      // remote worker.  Record `run_location='local'` so subsequent
      // resume attempts don't try sessions.connect on a session that
      // never had a cloud counterpart.
      runLocation: 'local',
      ...(persisted.yolo_mode ? { yoloMode: true } : {}),
      ...(persisted.persona_handle ? { personaHandle: persisted.persona_handle } : {}),
      ...(commentContextFromPersisted(persisted, workingDir)
        ? { commentContext: commentContextFromPersisted(persisted, workingDir) }
        : {}),
    };
    registry.set(agentId, record);

    // Update DB with new session_id
    persistence.updateSessionId(agentId, newSessionId);

    setupAgentEventListeners(session, record);
    console.info(`[agent-service] Restarted expired session for agent ${agentId} (new session: ${newSessionId})${transcriptReplay ? ` with ${transcriptEvents.length}-event transcript replay` : ''}`);
    return 'restarted';
  } catch (err) {
    console.error('[agent-service] Failed to restart expired session:', err);
    return false;
  }
}

/** Change the model for an active agent session. */
export async function setAgentModel(agentId: string, model: string): Promise<{ error?: string }> {
  let record = registry.get(agentId);
  if (!record) {
    const resumed = await resumeAgentSession(agentId);
    if (!resumed) return { error: 'Agent session not found' };
    record = registry.get(agentId)!;
  }

  try {
    if (!record.session) {
      return { error: 'Agent is still starting; try again when it is active' };
    }
    await record.session.setModel(model);
    return {};
  } catch (err: any) {
    return { error: err.message || 'Failed to change model' };
  }
}

/** Resume an agent session and return its conversation history. */
export async function getAgentHistory(agentId: string): Promise<{ events: any[]; restarted?: boolean; transcript?: boolean } | { error: string }> {
  // Resume if not already in memory
  let record = registry.get(agentId);
  if (!record) {
    const persisted = persistence.getSession(agentId);
    if (!persisted) return { error: 'Agent session not found in database' };

    const result = await resumeAgentSession(agentId);
    if (!result) {
      // Resume + restart fallback both failed.  Surface the persisted
      // transcript so the renderer can at least show the user what was
      // said, instead of just blanking the chat.  When the transcript
      // exists, the renderer can keep the conversation usable; the
      // separate `transcript: true` flag tells it the events come from
      // host storage (not the SDK session, which is gone).
      const transcript = persistence.listChatEvents(agentId);
      if (transcript.length > 0) {
        const events = transcript.map(toSdkEventShape);
        console.info(`[agent-service] getAgentHistory: serving persisted transcript for ${agentId} (${events.length} events) — session unrecoverable`);
        return { events, transcript: true };
      }
      const sourceLabel = persisted.source === 'cli'
        ? 'CLI'
        : persisted.run_location === 'cloud'
          ? 'cloud'
          : 'SDK';
      const detail = persisted.run_location === 'cloud'
        ? ' — the cloud worker may have been stopped or expired'
        : ' — the session may have expired or been deleted';
      return { error: `Failed to resume ${sourceLabel} session${detail}` };
    }
    record = registry.get(agentId);
  }
  if (!record) return { error: 'Agent not found after resume' };

  const restarted = record.restarted === true;

  try {
    if (!record.session) {
      const transcript = persistence.listChatEvents(agentId);
      if (transcript.length > 0) {
        const events = transcript.map(toSdkEventShape);
        return { events, transcript: true, ...(restarted ? { restarted: true } : {}) };
      }
      return { events: [], ...(restarted ? { restarted: true } : {}) };
    }
    const events = await record.session.getEvents();
    return { events: events || [], ...(restarted ? { restarted: true } : {}) };
  } catch (err: any) {
    console.warn('[agent-service] Failed to get history from session; falling back to persisted transcript:', err?.message ?? err);
    // SDK getEvents failure shouldn't blank the UI — try the persisted
    // transcript as a last resort.  Same reasoning as the resume-failure
    // path above.
    const transcript = persistence.listChatEvents(agentId);
    if (transcript.length > 0) {
      const events = transcript.map(toSdkEventShape);
      return { events, transcript: true, ...(restarted ? { restarted: true } : {}) };
    }
    return { error: err.message || 'Failed to load conversation history' };
  }
}

/**
 * Convert a row from `agent_chat_events` back into an SDK-style event
 * object the renderer expects from `session.getEvents()`.  The payload
 * was serialized as JSON at capture time; we round-trip it back into
 * `event.data` so existing renderer code reads the same shape.
 */
function toSdkEventShape(row: import('../../shared/types').AgentChatEvent): any {
  let data: any = {};
  try { data = JSON.parse(row.payload); } catch { /* ignore */ }
  return {
    type: row.type,
    data,
    ...(row.event_id ? { id: row.event_id } : {}),
    timestamp: row.timestamp,
  };
}

// ── Event Listener Setup ──────────────────────────────────────

/** Resolve workspace + spaceFolder for activity logging. Returns null if unavailable. */
function resolveSpaceActivityContext(record: AgentRecord): { workspaceRoot: string; spaceFolder: string } | null {
  if (!record.spaceId || record.spaceId === '__workspace__') return null;
  const workspace = getConfigValue('workspace');
  if (!workspace) return null;
  try {
    const { getSpace } = require('../database');
    const space = getSpace(record.spaceId);
    if (!space?.folder) return null;
    return { workspaceRoot: workspace, spaceFolder: space.folder };
  } catch { return null; }
}

/** Append to the per-space activity log (non-fatal on failure). */
function logIntentActivity(record: AgentRecord, type: string, data: Record<string, any>): void {
  if (record.ephemeral) return;
  const ctx = resolveSpaceActivityContext(record);
  if (!ctx) return;
  appendSpaceActivity(ctx.workspaceRoot, ctx.spaceFolder, type, { agentId: record.agentId, ...data });
}

export function setupAgentEventListeners(session: CopilotSession, record: AgentRecord): void {
  const agentId = record.agentId;
  const chatChannel = `chat:event:${agentId}`;

  session.on((event: any) => {
    if (record.aborted) return;
    // Persist meaningful events to the chat transcript so we can replay
    // them into a fresh session if the original session is unreachable
    // later (e.g. cloud worker expired, SDK runtime restarted with
    // missing local store).  Skip noisy/derivative event types — we keep
    // only the "logical message" events that matter for reconstructing
    // the conversation.
    try {
      const t = event?.type;
      if (typeof t === 'string' && PERSISTED_CHAT_EVENT_TYPES.has(t)) {
        const data = event?.data ?? event;
        const eventIdRaw = data?.id ?? event?.id;
        const eventId = typeof eventIdRaw === 'string' ? eventIdRaw : null;
        let payload: string;
        try { payload = JSON.stringify(data); }
        catch { payload = JSON.stringify({ _serializationError: true, type: t }); }
        persistence.appendChatEvent(record, {
          event_id: eventId,
          type: t,
          timestamp: new Date().toISOString(),
          payload,
        });
      }
    } catch { /* persistence is best-effort */ }

    // Canvas instances are shared state: the agent opens and closes them while
    // the user closes windows, so both directions have to be reconciled or the
    // runtime keeps rehydrating canvases the user already dismissed.
    try {
      if (typeof event?.type === 'string' && event.type.startsWith('session.canvas.')) {
        handleCanvasSessionEvent(agentId, event);
      }
    } catch { /* canvas reconciliation is best-effort */ }
  });

  // SDK events wrap payloads in event.data; fall back to top-level for compat
  session.on('assistant.message_delta', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    const delta = d.deltaContent ?? d.delta ?? '';
    notifier.notifyRenderer(chatChannel, { type: 'assistant.message_delta', delta });
  });

  session.on('assistant.message', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    const content = d.content || d.message || '';
    record.summary = truncate(content || 'Agent responded', 100);
    persistence.persistSummary(record);
    notifier.notifyRenderer('agent:status-changed', {
      agentId, status: record.status, summary: record.summary,
    });
    notifier.notifyRenderer(chatChannel, { type: 'assistant.message', content });
  });

  session.on('assistant.reasoning_delta', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    notifier.notifyRenderer(chatChannel, {
      type: 'assistant.reasoning_delta',
      reasoningId: d.reasoningId ?? '',
      delta: d.deltaContent ?? d.delta ?? '',
    });
  });

  session.on('assistant.reasoning', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    notifier.notifyRenderer(chatChannel, {
      type: 'assistant.reasoning',
      reasoningId: d.reasoningId ?? '',
      content: d.content ?? '',
    });
  });

  session.on('tool.execution_start', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    record.summary = `Using ${d.toolName || 'tool'}...`;
    notifier.notifyRenderer('agent:status-changed', {
      agentId, status: record.status, summary: record.summary,
    });
    notifier.notifyRenderer(chatChannel, {
      type: 'tool.start',
      toolCallId: d.toolCallId ?? '',
      toolName: d.toolName ?? '',
      args: d.arguments ?? d.toolArgs ?? {},
    });
    logIntentActivity(record, 'agent.tool_start', {
      toolName: d.toolName ?? '',
      toolCallId: d.toolCallId ?? '',
    });
  });

  session.on('tool.execution_progress', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    notifier.notifyRenderer(chatChannel, {
      type: 'tool.progress',
      toolCallId: d.toolCallId ?? '',
      message: d.progressMessage ?? '',
    });
  });

  session.on('tool.execution_complete', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    // SDK result is { content, detailedContent? } — flatten to string
    const rawResult = d.result;
    const result = typeof rawResult === 'string'
      ? rawResult
      : rawResult?.detailedContent ?? rawResult?.content ?? '';
    const success = d.success !== false;
    const errorMessage = d.error?.message ?? undefined;
    if (!success) {
      console.warn(`[agent-service] Tool ${d.toolCallId} completed with success=false (raw: ${d.success})${errorMessage ? `: ${errorMessage}` : ''}`);
    }
    notifier.notifyRenderer(chatChannel, {
      type: 'tool.complete',
      toolCallId: d.toolCallId ?? '',
      result,
      success,
      ...(errorMessage ? { error: errorMessage } : {}),
    });
    logIntentActivity(record, 'agent.tool_complete', {
      toolName: d.toolName ?? '',
      toolCallId: d.toolCallId ?? '',
      success,
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  });

  session.on('session.idle', () => {
    if (record.aborted) return;
    // A newly-created session can emit an idle event before its initial prompt
    // has been submitted. Comment launches keep phase='starting' until send()
    // is accepted so that startup idle cannot falsely complete the worker.
    if (record.phase === 'starting') return;
    if (record.status === 'running') {
      record.status = 'completed';
      record.summary = 'Completed';
      persistence.updateStatus(record);
      notifier.notifyRenderer('agent:completed', { agentId, summary: record.summary });
      notifier.notifyRenderer(chatChannel, { type: 'session.idle' });
      logIntentActivity(record, 'agent.completed', { summary: record.summary });

      // Clean up sub-agent state
      subagentTracker.clearParent(agentId);

      // Clean up per-agent sandbox config dirs (if any)
      if (record.sandbox) {
        const { cleanupSandboxConfigs } = require('../ai');
        cleanupSandboxConfigs(agentId);
      }

      // Handle comment agent auto-reply + presence cleanup
      if (record.commentContext) {
        // Dynamically import to avoid circular dependency
        const { handleCommentAgentCompletion } = require('./comment-workflow');
        handleCommentAgentCompletion(record);
      }

      // Fallback canvas change detection for ALL agent types.
      // The file watcher handles real-time detection while the canvas is open,
      // but this catches changes when the canvas was closed or the watcher missed something.
      if (record.canvasSnapshot && !record.commentContext) {
        try {
          const newContent = fs.readFileSync(record.canvasSnapshot.path, 'utf-8');
          const currentHash = crypto.createHash('md5').update(newContent).digest('hex');
          if (record.canvasSnapshot.hashBefore && currentHash !== record.canvasSnapshot.hashBefore) {
            updateCanvasContent(record.spaceId, newContent);
            notifier.notifyRenderer('canvas:content-updated', {
              spaceId: record.spaceId,
              content: newContent,
            });
          }
        } catch { /* non-fatal: file may not exist */ }
      }

      // Ephemeral agents: remove from registry after a short delay so the
      // renderer has time to process final events, then they vanish from history.
      if (record.ephemeral) {
        setTimeout(() => { releaseCanvasInstances(agentId); registry.delete(agentId); }, 30_000);
      }
    }
  });

  session.on('session.error', (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    record.status = 'failed';
    record.summary = `Error: ${d.message || 'Unknown error'}`;
    persistence.updateStatus(record);
    notifier.notifyRenderer('agent:status-changed', {
      agentId, status: 'failed', summary: record.summary,
    });
    notifier.notifyRenderer(chatChannel, {
      type: 'session.error',
      message: d.message || 'Unknown error',
    });
    logIntentActivity(record, 'agent.failed', { error: d.message || 'Unknown error' });

    // Clean up presence on failure too
    if (record.commentContext) {
      notifier.notifyRenderer('agent:presence-ended', { agentId, spaceId: record.spaceId });
    }

    // Clean up per-agent sandbox config dirs on failure
    if (record.sandbox) {
      const { cleanupSandboxConfigs } = require('../ai');
      cleanupSandboxConfigs(agentId);
    }

    if (record.ephemeral) {
      setTimeout(() => { releaseCanvasInstances(agentId); registry.delete(agentId); }, 30_000);
    }
  });

  // Sub-agent tracking via catch-all listener
  installSubagentSubscription(session, record);

  // Remote steering state changes
  session.on('session.remote_steerable_changed' as any, (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    const remoteSteerable = !!d.remoteSteerable;
    if (record.remote) {
      record.remote.remoteSteerable = remoteSteerable;
    }
    notifier.notifyRenderer('agent:remote-changed', {
      agentId,
      enabled: record.remote?.enabled ?? false,
      remoteSteerable,
      url: record.remote?.url,
    });
  });

  // Capture remote URL emitted by the runtime as session.info{infoType:"remote"}.
  // Cloud sessions emit this automatically once the remote worker connects
  // (URL like https://github.com/copilot/tasks/{id}). Local sessions only emit
  // it when the user enables remote control explicitly. Either way, record
  // the URL so the renderer can surface a shareable link without the user
  // having to call enableRemoteControl first.
  session.on('session.info' as any, (event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    if (d?.infoType !== 'remote' || !d?.url) return;
    const url: string = d.url;
    const prev = record.remote;
    record.remote = {
      enabled: true,
      remoteSteerable: prev?.remoteSteerable ?? true,
      url,
    };
    if (prev?.url === url && prev?.enabled === true) return;
    notifier.notifyRenderer('agent:remote-changed', {
      agentId,
      enabled: true,
      remoteSteerable: record.remote.remoteSteerable,
      url,
    });
  });
}

/**
 * Subscribe to all SDK events and route sub-agent events to the SubagentTracker.
 * The SDK supports session.on(callback) as a catch-all — it receives every event
 * including ones tagged with event.agentId for sub-agents.
 */
function installSubagentSubscription(session: CopilotSession, record: AgentRecord): void {
  const parentAgentId = record.agentId;
  const chatChannel = `chat:event:${parentAgentId}`;

  (session as any).on((event: any) => {
    if (record.aborted) return;
    const d = event.data ?? event;
    const type = event.type ?? d.type;

    // --- Sub-agent lifecycle events ---
    if (type === 'subagent.started') {
      subagentTracker.trackStarted(parentAgentId, {
        agentId: d.agentId,
        toolCallId: d.toolCallId ?? '',
        agentName: d.name ?? d.agentName ?? '',
        agentDisplayName: d.displayName ?? d.agentDisplayName ?? d.name ?? '',
        agentDescription: d.description ?? d.agentDescription ?? '',
      });
      notifier.notifyRenderer(chatChannel, {
        type: 'subagent.started',
        toolCallId: d.toolCallId ?? '',
        name: d.name ?? d.agentName ?? '',
        displayName: d.displayName ?? d.agentDisplayName ?? d.name ?? '',
        description: d.description ?? d.agentDescription ?? '',
        agentId: d.agentId,
      });
      logIntentActivity(record, 'subagent.started', {
        subagentId: d.agentId,
        name: d.name ?? d.agentName ?? '',
        description: d.description ?? d.agentDescription ?? '',
      });
      return;
    }

    if (type === 'subagent.completed') {
      subagentTracker.trackCompleted(parentAgentId, {
        agentId: d.agentId,
        toolCallId: d.toolCallId ?? '',
        agentName: d.name ?? d.agentName,
        agentDisplayName: d.displayName ?? d.agentDisplayName,
        durationMs: d.durationMs,
        model: d.model,
        totalTokens: d.totalTokens,
        totalToolCalls: d.totalToolCalls,
      });
      notifier.notifyRenderer(chatChannel, {
        type: 'subagent.completed',
        toolCallId: d.toolCallId ?? '',
        name: d.name ?? d.agentName ?? '',
        agentId: d.agentId,
        durationMs: d.durationMs,
        model: d.model,
        totalTokens: d.totalTokens,
        totalToolCalls: d.totalToolCalls,
      });
      logIntentActivity(record, 'subagent.completed', {
        subagentId: d.agentId,
        name: d.name ?? d.agentName ?? '',
        durationMs: d.durationMs,
        model: d.model,
        totalTokens: d.totalTokens,
      });
      return;
    }

    if (type === 'subagent.failed') {
      subagentTracker.trackFailed(parentAgentId, {
        agentId: d.agentId,
        toolCallId: d.toolCallId ?? '',
        agentName: d.name ?? d.agentName,
        error: d.error ?? 'Unknown error',
        durationMs: d.durationMs,
        model: d.model,
        totalTokens: d.totalTokens,
        totalToolCalls: d.totalToolCalls,
      });
      notifier.notifyRenderer(chatChannel, {
        type: 'subagent.failed',
        toolCallId: d.toolCallId ?? '',
        name: d.name ?? d.agentName ?? '',
        error: d.error ?? 'Unknown error',
        agentId: d.agentId,
      });
      logIntentActivity(record, 'subagent.failed', {
        subagentId: d.agentId,
        name: d.name ?? d.agentName ?? '',
        error: d.error ?? 'Unknown error',
      });
      return;
    }

    // --- agentId-tagged events route to the tracker ---
    const subAgentId = d.agentId || event.agentId;
    if (!subAgentId) return; // parent-level events already handled above

    if (type === 'assistant.message_delta') {
      const delta = d.deltaContent ?? d.delta ?? '';
      subagentTracker.trackStreamingDelta(parentAgentId, subAgentId, delta);
    } else if (type === 'assistant.message') {
      subagentTracker.trackTurnStart(parentAgentId, subAgentId);
    } else if (type === 'assistant.intent') {
      const intent = d.intent ?? d.content ?? '';
      subagentTracker.trackIntent(parentAgentId, subAgentId, intent);
    } else if (type === 'tool.execution_start') {
      subagentTracker.trackToolStart(parentAgentId, subAgentId, {
        toolCallId: d.toolCallId ?? '',
        toolName: d.toolName ?? '',
        args: d.arguments ?? d.toolArgs ?? {},
      });
    } else if (type === 'tool.execution_complete') {
      const rawResult = d.result;
      const result = typeof rawResult === 'string'
        ? rawResult
        : rawResult?.detailedContent ?? rawResult?.content ?? '';
      subagentTracker.trackToolComplete(parentAgentId, subAgentId, {
        toolCallId: d.toolCallId ?? '',
        success: d.success !== false,
        result,
        error: d.error,
      });
    } else if (type === 'assistant.usage') {
      subagentTracker.trackUsage(
        parentAgentId,
        subAgentId,
        d.inputTokens ?? d.input_tokens ?? 0,
        d.outputTokens ?? d.output_tokens ?? 0,
      );
      if (d.model) {
        subagentTracker.trackModel(parentAgentId, subAgentId, d.model);
      }
    } else if (type === 'session.idle') {
      subagentTracker.trackIdle(parentAgentId, subAgentId);
    }
  });
}

// ── Remote control ─────────────────────────────────────

export async function enableRemoteControl(agentId: string): Promise<{ enabled: boolean; remoteSteerable: boolean; url?: string } | { error: string }> {
  const record = registry.get(agentId);
  if (!record) return { error: 'Agent not found' };
  if (!record.session) return { error: 'Agent is still starting; try again when it is active' };

  try {
    const result = await record.session.rpc.remote.enable({ mode: 'on' });
    if (!result.url) {
      console.warn(`[sdk-runner] remote.enable returned no URL for agent=${agentId}. Result:`, JSON.stringify(result));
    }
    record.remote = {
      enabled: true,
      remoteSteerable: result.remoteSteerable,
      url: result.url,
    };
    notifier.notifyRenderer('agent:remote-changed', {
      agentId,
      enabled: true,
      remoteSteerable: result.remoteSteerable,
      url: result.url,
    });
    return { enabled: true, remoteSteerable: result.remoteSteerable, url: result.url };
  } catch (err: any) {
    return { error: err.message || 'Failed to enable remote control' };
  }
}

export async function disableRemoteControl(agentId: string): Promise<{ ok: true } | { error: string }> {
  const record = registry.get(agentId);
  if (!record) return { error: 'Agent not found' };
  if (!record.session) return { error: 'Agent is still starting; try again when it is active' };

  try {
    await record.session.rpc.remote.disable();
    record.remote = { enabled: false, remoteSteerable: false };
    notifier.notifyRenderer('agent:remote-changed', {
      agentId,
      enabled: false,
      remoteSteerable: false,
    });
    return { ok: true };
  } catch (err: any) {
    return { error: err.message || 'Failed to disable remote control' };
  }
}

/**
 * Return the current remote control state for an agent.  Used by the renderer
 * to restore overlay state on mount so the link sticks for the life of the
 * session even if the chat view remounts.
 */
export function getRemoteState(
  agentId: string,
): { enabled: boolean; remoteSteerable: boolean; url?: string } | { error: string } {
  const record = registry.get(agentId);
  if (!record) return { error: 'Agent not found' };
  return record.remote
    ? { enabled: record.remote.enabled, remoteSteerable: record.remote.remoteSteerable, url: record.remote.url }
    : { enabled: false, remoteSteerable: false };
}

/**
 * Force-reset remote control on an agent by disabling then re-enabling it.
 * Performs the disable/enable atomically with respect to renderer events:
 * emits exactly ONE final `agent:remote-changed` so the renderer never sees
 * the intermediate "disabled" state and overlays don't flicker.
 *
 * Returns `changed: true` if the URL rotated, `changed: false` if the SDK
 * returned the same URL (so callers can show a meaningful hint to the user).
 */
export async function resetRemoteControl(
  agentId: string,
): Promise<{ enabled: boolean; remoteSteerable: boolean; url?: string; changed: boolean } | { error: string }> {
  const record = registry.get(agentId);
  if (!record) return { error: 'Agent not found' };
  if (!record.session) return { error: 'Agent is still starting; try again when it is active' };

  const oldUrl = record.remote?.url;

  try {
    await record.session.rpc.remote.disable();
  } catch (err: any) {
    console.error(`[sdk-runner] reset: disable failed for agent=${agentId}:`, err);
    return { error: err.message || 'Failed to disable remote control during reset' };
  }

  try {
    const result = await record.session.rpc.remote.enable({ mode: 'on' });
    record.remote = {
      enabled: true,
      remoteSteerable: result.remoteSteerable,
      url: result.url,
    };
    notifier.notifyRenderer('agent:remote-changed', {
      agentId,
      enabled: true,
      remoteSteerable: result.remoteSteerable,
      url: result.url,
    });
    return {
      enabled: true,
      remoteSteerable: result.remoteSteerable,
      url: result.url,
      changed: oldUrl !== result.url,
    };
  } catch (err: any) {
    console.error(`[sdk-runner] reset: enable failed for agent=${agentId}:`, err);
    record.remote = { enabled: false, remoteSteerable: false };
    notifier.notifyRenderer('agent:remote-changed', {
      agentId,
      enabled: false,
      remoteSteerable: false,
    });
    return { error: err.message || 'Failed to re-enable remote control during reset' };
  }
}
