import { ElicitationContext, ElicitationResult } from '@github/copilot-sdk';
import type { PermissionRequest } from '@github/copilot-sdk';
import * as crypto from 'crypto';
import type { AgentNotifier } from './agent-notifier';
import type { AgentPersistence } from './agent-persistence';
import type { AgentRecord } from './agent-registry';
import type { PendingCanvasInteraction } from '../../shared/types';
import {
  checkPathScope,
  normalizePath,
  logSandboxLayerDenial,
  type ResolvedPathPolicy,
  type SandboxLayer,
} from './sandbox-policies';

/**
 * The agent-facing canvas tools.  Named explicitly rather than pattern-matched
 * so a future tool with "canvas" in its name is not silently auto-approved.
 */
const CANVAS_TOOL_NAMES = new Set(['list_canvas_capabilities', 'open_canvas', 'invoke_canvas_action']);

// UserInputRequest/UserInputResponse are not re-exported from the SDK index,
// so we define compatible interfaces here.
interface UserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

interface UserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

interface AgentInteractionContext {
  agentId: string;
  spaceId?: string;
  commentContext?: { threadId: string | null };
}

/** Source of a sandbox block emitted to the renderer. */
export type SandboxBlockSource = 'permission' | 'pre-tool' | 'post-tool-shell';

/**
 * Detail of a sandbox block emitted to the renderer. Persona-launch wiring
 * uses this to render the bubble-up prompt.
 */
export interface SandboxBlockRequest {
  requestId: string;
  agentId: string;
  source: SandboxBlockSource;
  /** Conceptual kind of resource being denied. */
  kind: 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'web-fetch';
  /** Tool name when the block originates from onPreToolUse / onPostToolUse. */
  toolName?: string;
  /** The path / command / url / server name that was out of policy. */
  target: string;
  /** Human-readable description from the SDK / runtime, when available. */
  intention?: string;
  /** Subset of decisions to offer.  When omitted, all three are shown. */
  allowedDecisions?: SandboxResolutionDecision[];
  /**
   * Which enforcement layer fired.  Surfaced in the renderer banner so the
   * user can tell whether MXC actually denied (`mxc:*`) or whether the host
   * intercepted before MXC (`host:*`).  Logs already include this; passing
   * it through the renderer event makes verification visible end-to-end.
   */
  layer?: SandboxLayer;
  /**
   * Handle of the persona that owns this agent.  Surfaced in the renderer
   * so the bubble-up banner's "Edit sandbox config" button can open the
   * persona editor for the correct entry.
   */
  personaHandle?: string;
  spaceId?: string;
  threadId?: string | null;
}

export type SandboxResolutionDecision = 'allow-once' | 'allow-for-session' | 'disable';

export interface SandboxResolution {
  decision: SandboxResolutionDecision;
}

export class InteractionBroker {
  private approvalCallbacks = new Map<string, (approved: boolean) => void>();
  private userInputCallbacks = new Map<string, (response: UserInputResponse) => void>();
  private elicitationCallbacks = new Map<string, (result: ElicitationResult) => void>();
  /** Pending sandbox-block resolutions, keyed by requestId. */
  private sandboxBlockCallbacks = new Map<string, (resolution: SandboxResolution) => void>();
  private interactionContexts = new Map<string, { agentId: string; spaceId?: string; threadId?: string | null }>();
  /**
   * Full payloads for interactions still awaiting the user, keyed by requestId.
   * Only populated for comment-thread agents (those with a threadId), since
   * that's the only state a canvas needs to rehydrate.  Entries are removed when
   * the interaction resolves or the agent is torn down.  Lets the main process
   * hand a fresh canvas a complete snapshot of in-flight prompts.
   */
  private pendingCanvasInteractions = new Map<string, PendingCanvasInteraction>();

  constructor(
    private notifier: AgentNotifier,
    private persistence: AgentPersistence,
  ) {}

  /**
   * Emit a sandbox block to the renderer and await user resolution.
   * Used by the path-aware permission handler and pre-tool path hook to ask
   * the user whether to allow once, allow for session, or disable sandbox
   * altogether.
   */
  emitSandboxBlock(record: AgentRecord, req: Omit<SandboxBlockRequest, 'agentId' | 'requestId'> & { requestId?: string }): Promise<SandboxResolution> {
    const requestId = req.requestId ?? crypto.randomUUID();
    const payload: SandboxBlockRequest = {
      ...req,
      requestId,
      agentId: record.agentId,
      ...(record.personaHandle ? { personaHandle: record.personaHandle } : {}),
      spaceId: record.spaceId,
      threadId: record.commentContext?.threadId,
    };
    record.status = 'waiting-approval';
    this.persistence.updateStatus(record);
    this.interactionContexts.set(requestId, {
      agentId: record.agentId,
      spaceId: record.spaceId,
      threadId: record.commentContext?.threadId,
    });
    if (record.commentContext?.threadId) {
      this.pendingCanvasInteractions.set(requestId, {
        kind: 'sandbox_block',
        agentId: record.agentId,
        requestId,
        source: req.source,
        blockKind: req.kind,
        toolName: req.toolName,
        target: req.target,
        intention: req.intention,
        allowedDecisions: req.allowedDecisions,
        layer: req.layer,
        ...(record.personaHandle ? { personaHandle: record.personaHandle } : {}),
      });
    }

    this.notifier.notifyRenderer('agent:sandbox-blocked', payload);
    this.notifier.notifyRenderer(`chat:event:${record.agentId}`, {
      type: 'sandbox.blocked',
      ...payload,
    });
    this.notifier.showSandboxBlockNotification({
      agentId: record.agentId,
      requestId,
      kind: req.kind,
      target: req.target,
      intention: req.intention,
      onAllowOnce: () => this.resolveSandboxBlock(record.agentId, requestId, 'allow-once'),
    });

    return new Promise<SandboxResolution>((resolve) => {
      this.sandboxBlockCallbacks.set(requestId, (resolution) => {
        if (record.status === 'waiting-approval') {
          record.status = 'running';
          this.persistence.updateStatus(record);
        }
        resolve(resolution);
      });
    });
  }

  /** Renderer-driven response to a sandbox block. */
  resolveSandboxBlock(_agentId: string, requestId: string, decision: SandboxResolutionDecision): void {
    const cb = this.sandboxBlockCallbacks.get(requestId);
    const context = this.interactionContexts.get(requestId);
    if (cb) {
      this.sandboxBlockCallbacks.delete(requestId);
      this.interactionContexts.delete(requestId);
      this.pendingCanvasInteractions.delete(requestId);
      cb({ decision });
    } else {
      console.warn(`[InteractionBroker] No sandbox-block callback for requestId=${requestId}`);
    }
    // Broadcast to ALL renderer windows so any window that rendered the
    // block panel (canvas + main app) can dismiss it. Without this, resolving
    // from one window leaves an orphaned panel in the other.
    this.notifier.notifyRenderer('agent:sandbox-resolved', {
      agentId: context?.agentId ?? _agentId,
      requestId,
      decision,
      spaceId: context?.spaceId,
      threadId: context?.threadId,
    });
    this.notifier.notifyRenderer(`chat:event:${_agentId}`, {
      type: 'sandbox.resolved',
      requestId,
      decision,
    });
  }

  /**
   * Permission handler for sandboxed agents.
   * Auto-approves reads, auto-denies writes. Shell permissions are handled
   * by the pre-tool hook (read-only classification). MCP and other kinds
   * fall through to the normal interactive handler.
   */
  createSandboxedPermissionHandler(findRecord: (sessionId: string) => AgentRecord | undefined) {
    return async (request: PermissionRequest, invocation: { sessionId: string }) => {
      const record = findRecord(invocation.sessionId);
      if (record?.yoloMode) {
        console.log(`[InteractionBroker] yolo-mode auto-approve: kind=${request.kind} agent=${record.agentId}`);
        return { kind: 'approve-once' as const };
      }
      if (request.kind === 'read') return { kind: 'approve-once' as const };
      if (request.kind === 'write') return { kind: 'reject' as const };
      // For shell, mcp, url, and other kinds, fall through to normal handler
      return this.createPermissionHandler(findRecord)(request, invocation);
    };
  }

  /**
   * Permission handler for sandboxed agents running in `mxc-only` enforcement
   * mode. Auto-approves *every* SDK permission kind so the call reaches MXC's
   * AppContainer at the OS level (for shell tools) or proceeds unrestricted
   * (for path-bearing SDK tools that MXC does not see — view/edit/create/
   * glob/grep, per `docs/mxc-sandbox-flow.md#caveat`). The whole point of
   * `mxc-only` is to verify MXC's own enforcement; surfacing a host-side
   * approval prompt before the call ever reaches MXC defeats that purpose.
   *
   * Each auto-approval is logged via `logSandboxLayerDenial` with layer
   * `mxc-only:auto-approve` so the trail is still discoverable in logs and
   * reachable to tests via spies on `console.warn`.
   *
   * Mid-session disable: if the user clicks "Disable sandbox" on a
   * post-tool MXC-denial bubble-up (`record.sandbox.state === 'off'`),
   * we fall back to the regular interactive handler — same shape as
   * `createPathAwareSandboxPermissionHandler` (line 173-175) — so the user
   * regains control after explicitly opting out.
   */
  createMxcOnlyPermissionHandler(findRecord: (sessionId: string) => AgentRecord | undefined) {
    return async (request: PermissionRequest, invocation: { sessionId: string }) => {
      const record = findRecord(invocation.sessionId);
      if (!record) return { kind: 'reject' as const };

      // Mid-session opt-out → behave like the normal handler.
      if (!record.sandbox || record.sandbox.state === 'off') {
        return this.createPermissionHandler(findRecord)(request, invocation);
      }

      const req = request as unknown as Record<string, unknown>;
      const target = typeof req.path === 'string' ? req.path
        : typeof req.fileName === 'string' ? req.fileName
        : typeof req.command === 'string' ? req.command
        : typeof req.url === 'string' ? req.url
        : typeof req.serverName === 'string' ? req.serverName
        : '';

      logSandboxLayerDenial('mxc-only:auto-approve', {
        agentId: record.agentId,
        toolName: `permission:${request.kind ?? 'unknown'}`,
        target,
        reason: 'mxc-only mode: SDK permission auto-approved (MXC is sole enforcer)',
      });

      return { kind: 'approve-once' as const };
    };
  }

  /**
   * Path-aware permission handler for sandboxed personas.
   *
   * For `read` and `write`: auto-approves when target is in the resolved policy
   * scope (or in the per-agent host allow list). When out of scope, emits a
   * sandbox-block to the renderer and awaits user decision (allow-once /
   * allow-for-session / disable).
   *
   * For `mcp`: auto-rejects when policy disallows MCP, unless the server has
   * been added to the per-agent host allow list.
   *
   * For `url`: bubbles up. (host-side URL allow list is a future extension.)
   *
   * For `shell` and other kinds: falls through to the normal interactive handler.
   *
   * NOTE: When `disableSandboxForSession` runs, the agent's
   * `record.sandbox.state` flips to `'off'` and this handler treats subsequent
   * requests as if they were unsandboxed — falling through to the regular
   * interactive handler.
   */
  createPathAwareSandboxPermissionHandler(findRecord: (sessionId: string) => AgentRecord | undefined) {
    return async (request: PermissionRequest, invocation: { sessionId: string }) => {
      const record = findRecord(invocation.sessionId);
      if (!record) return { kind: 'reject' as const };

      if (record.yoloMode) {
        console.log(`[InteractionBroker] yolo-mode auto-approve: kind=${request.kind} agent=${record.agentId}`);
        return { kind: 'approve-once' as const };
      }

      // If sandbox has been disabled mid-session, behave like the normal handler.
      if (!record.sandbox || record.sandbox.state === 'off') {
        return this.createPermissionHandler(findRecord)(request, invocation);
      }

      const policy = record.sandbox.policy;
      const allowList = record.sandbox.allowList;
      const req = request as unknown as Record<string, unknown>;

      if (request.kind === 'read') {
        const targetPath = typeof req.path === 'string' ? req.path : '';
        if (!targetPath) return { kind: 'approve-once' as const };
        const norm = normalizePath(targetPath);
        if (allowList.paths.has(norm)) return { kind: 'approve-once' as const };
        const r = checkPathScope(targetPath, policy, false);
        if (r.decision === 'allow-rw' || r.decision === 'allow-ro') {
          return { kind: 'approve-once' as const };
        }
        logSandboxLayerDenial('host:permission', {
          agentId: record.agentId,
          toolName: 'permission:read',
          target: targetPath,
          reason: r.decision === 'deny' ? r.reason : 'out-of-scope',
        });
        return this.handleSandboxBlockForPermission(record, request, {
          source: 'permission',
          kind: 'read',
          target: targetPath,
          intention: typeof req.intention === 'string' ? req.intention : undefined,
          layer: 'host:permission',
        });
      }

      if (request.kind === 'write') {
        const targetPath = typeof req.fileName === 'string' ? req.fileName
          : typeof req.path === 'string' ? req.path : '';
        if (!targetPath) {
          // No path info → require interactive approval to be safe.
          return this.createPermissionHandler(findRecord)(request, invocation);
        }
        const norm = normalizePath(targetPath);
        if (allowList.paths.has(norm)) return { kind: 'approve-once' as const };
        const r = checkPathScope(targetPath, policy, true);
        if (r.decision === 'allow-rw') return { kind: 'approve-once' as const };
        logSandboxLayerDenial('host:permission', {
          agentId: record.agentId,
          toolName: 'permission:write',
          target: targetPath,
          reason: r.decision === 'deny' ? r.reason : 'out-of-scope',
        });
        return this.handleSandboxBlockForPermission(record, request, {
          source: 'permission',
          kind: 'write',
          target: targetPath,
          intention: typeof req.intention === 'string' ? req.intention : undefined,
          layer: 'host:permission',
        });
      }

      if (request.kind === 'mcp' && !record.sandbox.allowMcpServers) {
        const serverName = typeof req.serverName === 'string' ? req.serverName : '';
        if (serverName && allowList.resources.has(`mcp:${serverName}`)) {
          return { kind: 'approve-once' as const };
        }
        logSandboxLayerDenial('host:permission', {
          agentId: record.agentId,
          toolName: 'permission:mcp',
          target: serverName,
          reason: 'mcp denied by policy',
        });
        return this.handleSandboxBlockForPermission(record, request, {
          source: 'permission',
          kind: 'mcp',
          target: serverName || '<unknown mcp>',
          intention: typeof req.intention === 'string' ? req.intention : undefined,
          layer: 'host:permission',
        });
      }

      if (request.kind === 'url') {
        const url = typeof req.url === 'string' ? req.url : '';
        if (url && allowList.resources.has(`url:${url}`)) {
          return { kind: 'approve-once' as const };
        }
        logSandboxLayerDenial('host:permission', {
          agentId: record.agentId,
          toolName: 'permission:url',
          target: url,
          reason: 'url denied by policy',
        });
        return this.handleSandboxBlockForPermission(record, request, {
          source: 'permission',
          kind: 'url',
          target: url || '<unknown url>',
          intention: typeof req.intention === 'string' ? req.intention : undefined,
          layer: 'host:permission',
        });
      }

      // shell + other kinds: fall through (mxc enforces shell at the OS level;
      // user gets standard approval prompt for anything else).
      return this.createPermissionHandler(findRecord)(request, invocation);
    };
  }

  /**
   * Render a sandbox block, await the user's decision, and translate it into
   * an SDK PermissionRequestResult. Side-effects: when the decision is
   * 'allow-for-session', the target is added to the agent's allow list. When
   * 'disable', the caller (sdk-runner) handles the session swap; we just
   * approve the call so the runtime keeps moving while resume is in flight.
   */
  private async handleSandboxBlockForPermission(
    record: AgentRecord,
    request: PermissionRequest,
    block: Omit<SandboxBlockRequest, 'agentId' | 'requestId'>,
  ): Promise<{ kind: 'approve-once' } | { kind: 'reject' }> {
    // For shell kinds, hide allow-for-session — mxc would still enforce.
    const allowedDecisions: SandboxResolutionDecision[] = block.kind === 'shell'
      ? ['allow-once', 'disable']
      : ['allow-once', 'allow-for-session', 'disable'];

    const resolution = await this.emitSandboxBlock(record, {
      ...block,
      allowedDecisions,
    });

    if (resolution.decision === 'allow-once') {
      return { kind: 'approve-once' };
    }

    if (resolution.decision === 'allow-for-session' && record.sandbox) {
      const target = block.target;
      switch (block.kind) {
        case 'read':
        case 'write':
          record.sandbox.allowList.paths.add(normalizePath(target));
          break;
        case 'mcp':
          record.sandbox.allowList.resources.add(`mcp:${target}`);
          break;
        case 'url':
          record.sandbox.allowList.resources.add(`url:${target}`);
          break;
        case 'web-fetch':
          record.sandbox.allowList.webFetch = true;
          break;
        // shell never reaches here (allowed-for-session not offered)
      }
      return { kind: 'approve-once' };
    }

    if (resolution.decision === 'disable') {
      // Caller (sdk-runner) listens for the resolution and orchestrates the
      // session swap. We approve this single call so the runtime can return,
      // since the resume flow will replace the session afterwards.
      return { kind: 'approve-once' };
    }

    void request; // currently unused beyond block payload but kept for symmetry
    return { kind: 'reject' };
  }

  /**
   * Whether a permission request is a canvas tool call that this run may make
   * unattended.
   *
   * Scheduled runs exist precisely because nobody is watching, so a permission
   * prompt does not get answered — it just hangs until the run times out and
   * the report never appears.  The exemption is deliberately narrow: only the
   * canvas tools, only for runs launched by the scheduler to produce an
   * artifact.  Everything else still prompts, so a scheduled run cannot quietly
   * gain shell or write access it would not otherwise have.
   */
  private isAutoApprovedCanvasTool(record: AgentRecord, request: PermissionRequest): boolean {
    if (!record.autoApproveCanvasTools) return false;
    if (request.kind !== 'custom-tool') return false;
    const toolName = (request as unknown as Record<string, unknown>).toolName;
    return typeof toolName === 'string' && CANVAS_TOOL_NAMES.has(toolName);
  }

  /**
   * Shared permission request handler for all agent types.
   * Each concurrent request gets a unique requestId so callbacks never overwrite each other.
   */
  createPermissionHandler(findRecord: (sessionId: string) => AgentRecord | undefined) {
    return async (request: PermissionRequest, invocation: { sessionId: string }) => {
      const record = findRecord(invocation.sessionId);
      if (!record) return { kind: 'reject' as const };

      // Auto-approve read operations (view, grep, glob, etc.)
      if (request.kind === 'read') return { kind: 'approve-once' as const };

      // Yolo mode: auto-approve everything without prompting
      if (record.yoloMode) {
        console.log(`[InteractionBroker] yolo-mode auto-approve: kind=${request.kind} agent=${record.agentId}`);
        return { kind: 'approve-once' as const };
      }

      if (this.isAutoApprovedCanvasTool(record, request)) {
        const toolName = (request as unknown as Record<string, unknown>).toolName;
        console.log(`[InteractionBroker] scheduled canvas auto-approve: tool=${toolName} agent=${record.agentId}`);
        return { kind: 'approve-once' as const };
      }

      const requestId = request.toolCallId ?? crypto.randomUUID();
      // Extract rich context from the SDK permission request
      const req = request as unknown as Record<string, unknown>;
      const intention = typeof req.intention === 'string' ? req.intention : undefined;
      const path = typeof req.path === 'string' ? req.path
        : typeof req.fileName === 'string' ? req.fileName
        : undefined;

      console.log(`[InteractionBroker] Permission requested: kind=${request.kind} requestId=${requestId} agent=${record.agentId}`);

      record.status = 'waiting-approval';
      record.pendingApprovalId = requestId;
      record.pendingPermissionKind = request.kind || null;
      record.pendingApprovals.set(requestId, { permissionKind: request.kind || null, intention, path });
      this.interactionContexts.set(requestId, {
        agentId: record.agentId,
        spaceId: record.spaceId,
        threadId: record.commentContext?.threadId,
      });
      if (record.commentContext?.threadId) {
        this.pendingCanvasInteractions.set(requestId, {
          kind: 'approval',
          agentId: record.agentId,
          requestId,
          permissionKind: request.kind || 'permission',
          intention,
          path,
        });
      }
      this.persistence.updateStatus(record);

      this.notifier.notifyRenderer('agent:approval-needed', {
        agentId: record.agentId,
        requestId,
        permissionKind: request.kind,
        intention,
        path,
        spaceId: record.spaceId,
        threadId: record.commentContext?.threadId,
      });

      this.notifier.notifyRenderer(`chat:event:${record.agentId}`, {
        type: 'approval.needed',
        requestId,
        agentId: record.agentId,
        permissionKind: request.kind,
        intention,
        path,
      });

      this.notifier.showApprovalNotification({
        agentId: record.agentId,
        requestId,
        permissionKind: request.kind || 'permission',
        intention,
        path,
        onApprove: () => this.approveAgent(record.agentId, requestId, true),
        onDeny: () => this.approveAgent(record.agentId, requestId, false),
      });

      return new Promise<{ kind: 'approve-once' } | { kind: 'reject' }>((resolve) => {
        this.approvalCallbacks.set(requestId, (approved: boolean) => {
          record.pendingApprovals.delete(requestId);
          if (record.pendingApprovals.size === 0) {
            record.pendingApprovalId = null;
            record.pendingPermissionKind = null;
            record.status = 'running';
          } else {
            // Update to reflect the next pending approval
            const [nextId, next] = [...record.pendingApprovals.entries()][0];
            record.pendingApprovalId = nextId;
            record.pendingPermissionKind = next.permissionKind;
          }
          this.persistence.updateStatus(record);
          const result = approved
            ? { kind: 'approve-once' as const }
            : { kind: 'reject' as const };
          console.log(`[InteractionBroker] Permission resolved: requestId=${requestId} result=${result.kind}`);
          resolve(result);
        });
      });
    };
  }

  createUserInputHandler(findRecord: (sessionId: string) => AgentRecord | undefined) {
    return async (request: UserInputRequest, invocation: { sessionId: string }): Promise<UserInputResponse> => {
      const record = findRecord(invocation.sessionId);
      if (!record) return { answer: '', wasFreeform: true };
      return this.requestUserInput(record, request);
    };
  }

  /**
   * Request user input for a given agent. Emits `user_input.requested` to the
   * renderer, shows a notification, and returns a promise that resolves when the
   * user responds. Used by both the SDK's onUserInputRequest callback and the
   * custom ask_user tool.
   */
  async requestUserInput(agentOrRecord: string | AgentInteractionContext, request: UserInputRequest): Promise<UserInputResponse> {
    const agentId = typeof agentOrRecord === 'string' ? agentOrRecord : agentOrRecord.agentId;
    const context = typeof agentOrRecord === 'string'
      ? { agentId }
      : { agentId, spaceId: agentOrRecord.spaceId, threadId: agentOrRecord.commentContext?.threadId };
    const requestId = crypto.randomUUID();
    this.interactionContexts.set(requestId, context);
    const userInputThreadId = (context as { threadId?: string | null }).threadId;
    if (userInputThreadId) {
      this.pendingCanvasInteractions.set(requestId, {
        kind: 'user_input',
        agentId,
        requestId,
        question: request.question,
        choices: request.choices,
        allowFreeform: request.allowFreeform,
      });
    }

    this.notifier.notifyRenderer(`chat:event:${agentId}`, {
      type: 'user_input.requested',
      requestId,
      agentId,
      question: request.question,
      choices: request.choices,
      allowFreeform: request.allowFreeform,
    });
    this.notifier.notifyRenderer('agent:user-input-requested', {
      ...context,
      requestId,
      question: request.question,
      choices: request.choices,
      allowFreeform: request.allowFreeform,
    });

    this.notifier.showUserInputNotification({
      agentId,
      requestId,
      question: request.question,
    });

    return new Promise<UserInputResponse>((resolve) => {
      this.userInputCallbacks.set(requestId, resolve);
    });
  }

  createElicitationHandler(findRecord: (sessionId: string) => AgentRecord | undefined) {
    return async (context: ElicitationContext): Promise<ElicitationResult> => {
      const record = findRecord(context.sessionId);
      if (!record) return { action: 'cancel' };

      const requestId = crypto.randomUUID();

      this.notifier.notifyRenderer(`chat:event:${record.agentId}`, {
        type: 'elicitation.requested',
        requestId,
        agentId: record.agentId,
        message: context.message,
        requestedSchema: context.requestedSchema,
        mode: context.mode,
        elicitationSource: context.elicitationSource,
      });
      this.interactionContexts.set(requestId, {
        agentId: record.agentId,
        spaceId: record.spaceId,
        threadId: record.commentContext?.threadId,
      });
      if (record.commentContext?.threadId) {
        this.pendingCanvasInteractions.set(requestId, {
          kind: 'elicitation',
          agentId: record.agentId,
          requestId,
          message: context.message,
          requestedSchema: context.requestedSchema,
          mode: context.mode,
          elicitationSource: context.elicitationSource,
        });
      }
      this.notifier.notifyRenderer('agent:elicitation-requested', {
        agentId: record.agentId,
        requestId,
        message: context.message,
        requestedSchema: context.requestedSchema,
        mode: context.mode,
        elicitationSource: context.elicitationSource,
        spaceId: record.spaceId,
        threadId: record.commentContext?.threadId,
      });

      this.notifier.showElicitationNotification({
        agentId: record.agentId,
        requestId,
        message: context.message,
      });

      return new Promise<ElicitationResult>((resolve) => {
        this.elicitationCallbacks.set(requestId, resolve);
      });
    };
  }

  approveAgent(agentId: string, requestId: string, approved: boolean): void {
    const cb = this.approvalCallbacks.get(requestId);
    const context = this.interactionContexts.get(requestId);
    if (cb) {
      this.approvalCallbacks.delete(requestId);
      cb(approved);
    } else {
      console.warn(`[InteractionBroker] No approval callback for requestId=${requestId} (agentId=${agentId}, approved=${approved})`);
    }
    // Notify chat channel so both workers list and chat view stay in sync
    this.notifier.notifyRenderer(`chat:event:${agentId}`, {
      type: 'approval.resolved',
      requestId,
      approved,
    });
    this.notifier.notifyRenderer('agent:approval-resolved', {
      agentId: context?.agentId ?? agentId,
      requestId,
      approved,
      spaceId: context?.spaceId,
      threadId: context?.threadId,
    });
    this.notifier.notifyRenderer('agent:status-changed', {
      agentId: context?.agentId ?? agentId,
      status: 'running',
      summary: approved ? 'Permission approved' : 'Permission denied',
      spaceId: context?.spaceId,
      threadId: context?.threadId,
    });
    this.interactionContexts.delete(requestId);
    this.pendingCanvasInteractions.delete(requestId);
  }

  respondToUserInput(agentId: string, requestId: string, answer: string, wasFreeform: boolean): void {
    const cb = this.userInputCallbacks.get(requestId);
    const context = this.interactionContexts.get(requestId);
    if (cb) {
      this.userInputCallbacks.delete(requestId);
      cb({ answer, wasFreeform });
    }
    this.notifier.notifyRenderer(`chat:event:${agentId}`, {
      type: 'user_input.resolved',
      requestId,
      answer,
      wasFreeform,
    });
    this.notifier.notifyRenderer('agent:user-input-resolved', {
      agentId: context?.agentId ?? agentId,
      requestId,
      answer,
      wasFreeform,
      spaceId: context?.spaceId,
      threadId: context?.threadId,
    });
    this.interactionContexts.delete(requestId);
    this.pendingCanvasInteractions.delete(requestId);
  }

  respondToElicitation(agentId: string, requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): void {
    const cb = this.elicitationCallbacks.get(requestId);
    const context = this.interactionContexts.get(requestId);
    if (cb) {
      this.elicitationCallbacks.delete(requestId);
      cb({ action, content: content as ElicitationResult['content'] });
    }
    this.notifier.notifyRenderer(`chat:event:${agentId}`, {
      type: 'elicitation.resolved',
      requestId,
      action,
      content,
    });
    this.notifier.notifyRenderer('agent:elicitation-resolved', {
      agentId: context?.agentId ?? agentId,
      requestId,
      action,
      content,
      spaceId: context?.spaceId,
      threadId: context?.threadId,
    });
    this.interactionContexts.delete(requestId);
    this.pendingCanvasInteractions.delete(requestId);
  }

  /** Deny and clean up all pending approval callbacks for a given agent. */
  clearPendingApprovals(record: AgentRecord): void {
    for (const requestId of record.pendingApprovals.keys()) {
      const cb = this.approvalCallbacks.get(requestId);
      if (cb) {
        this.approvalCallbacks.delete(requestId);
        cb(false);
      }
      this.pendingCanvasInteractions.delete(requestId);
    }
    record.pendingApprovals.clear();
    record.pendingApprovalId = null;
    record.pendingPermissionKind = null;
  }

  /** Cancel all pending interactive requests (user input + elicitation) for a given agent. */
  clearPendingInteractions(record: AgentRecord): void {
    this.clearPendingApprovals(record);

    // Cancel any pending user-input callbacks
    for (const [requestId, cb] of this.userInputCallbacks.entries()) {
      // We can't easily filter by agent, so we resolve with empty answer.
      // In practice the session abort will handle cleanup, but this prevents leaks.
      cb({ answer: '', wasFreeform: true });
      this.userInputCallbacks.delete(requestId);
    }

    // Cancel any pending elicitation callbacks
    for (const [requestId, cb] of this.elicitationCallbacks.entries()) {
      cb({ action: 'cancel' });
      this.elicitationCallbacks.delete(requestId);
    }

    // Cancel any pending sandbox-block callbacks (resolve as 'allow-once' so
    // the SDK doesn't hang; the agent itself is being torn down anyway).
    for (const [requestId, cb] of this.sandboxBlockCallbacks.entries()) {
      cb({ decision: 'allow-once' });
      this.sandboxBlockCallbacks.delete(requestId);
    }

    // Drop any retained canvas-interaction snapshots for this agent.
    for (const [requestId, interaction] of this.pendingCanvasInteractions.entries()) {
      if (interaction.agentId === record.agentId) this.pendingCanvasInteractions.delete(requestId);
    }
  }

  /**
   * Snapshot the interactions still awaiting the user for a given agent.
   * Used by `canvas:get-agent-state` so a freshly mounted canvas can rehydrate
   * in-flight approvals/prompts that were emitted while it wasn't listening.
   */
  snapshotPendingInteractions(agentId: string): PendingCanvasInteraction[] {
    const out: PendingCanvasInteraction[] = [];
    for (const interaction of this.pendingCanvasInteractions.values()) {
      if (interaction.agentId === agentId) out.push(interaction);
    }
    return out;
  }
}
