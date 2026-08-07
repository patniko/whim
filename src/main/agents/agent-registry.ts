import type { CopilotSession } from '@github/copilot-sdk';
import type { AgentAnchor } from '../../shared/types';
import type { ResolvedPathPolicy } from './sandbox-policies';
import type { SandboxConfigDirs } from '../ai';

export type AgentStatus = 'running' | 'waiting-approval' | 'completed' | 'failed';

/**
 * Per-agent sandbox state.  Lives only in memory while the agent runs.
 * Cleared on agent completion.
 */
export interface SandboxRuntimeState {
  /** Resolved path policy (space folder + extras, normalized). */
  policy: ResolvedPathPolicy;
  /** On/off configDirs materialized for this agent at launch. */
  configs: SandboxConfigDirs;
  /** Whether the agent currently runs sandboxed ('on') or has been disabled ('off'). */
  state: 'on' | 'off';
  /** Whether MCP is allowed for this agent (policy.allowMcpServers). */
  allowMcpServers: boolean;
  /** Whether web_fetch is allowed for this agent (policy.allowWebFetch). */
  allowWebFetch: boolean;
  /** Whether the sandbox allows outbound network (policy.allowOutbound). */
  allowOutbound: boolean;
  /** Per-agent host allow list — populated by user "Allow for session" decisions. */
  allowList: SandboxAllowList;
}

export interface SandboxAllowList {
  /** Normalized paths the user has approved for the rest of the session. */
  paths: Set<string>;
  /** Tool-specific allow-once for non-path resources (e.g. mcp servers, urls). */
  resources: Set<string>;
  /** True when web_fetch was approved for the session. */
  webFetch: boolean;
}

export interface CommentAgentContext {
  threadId: string | null;
  personaHandle: string;
  personaName: string;
  commentBody: string;
  quotedText: string;
  anchor: { prefix?: string; suffix?: string };
  canvasHashBefore: string;
  canvasPath: string;
  documentDisplayName?: string;
  documentLabel?: string;
}

export interface AgentRecord {
  agentId: string;
  sessionId: string;
  session?: CopilotSession;
  phase?: 'starting' | 'active';
  aborted?: boolean;
  spaceId: string;
  selectedText: string;
  anchor: AgentAnchor;
  status: AgentStatus;
  pendingApprovalId: string | null;
  pendingPermissionKind: string | null;
  pendingApprovals: Map<string, { permissionKind: string | null; intention?: string; path?: string }>;
  summary: string;
  commentContext?: CommentAgentContext;
  /** Canvas hash snapshot taken before agent starts, for change detection on completion. */
  canvasSnapshot?: { path: string; hashBefore: string };
  /** True when session was recreated after the original SDK session expired. */
  restarted?: boolean;
  /** Sandbox runtime state — present iff the agent was launched as sandboxed. */
  sandbox?: SandboxRuntimeState;
  /**
   * Handle of the persona that launched this agent, when known. Used by the
   * sandbox-block bubble-up so the renderer can open the persona editor on
   * "Edit sandbox config".
   */
  personaHandle?: string;
  /** When true, all permission requests are auto-approved without user interaction. Session-only. */
  yoloMode?: boolean;
  /**
   * When true, the canvas tools alone are auto-approved for this run.  Set for
   * scheduled runs that were launched to produce an artifact: nobody is at the
   * keyboard to answer a prompt, so without this the run would sit waiting for
   * approval until it timed out, which is the one failure mode that makes
   * scheduled reports useless.  Deliberately narrower than `yoloMode` — every
   * other permission still prompts.
   */
  autoApproveCanvasTools?: boolean;
  /** Remote control state — tracks Mission Control integration per session. */
  remote?: { enabled: boolean; remoteSteerable: boolean; url?: string };
  /**
   * Where the session's runtime is executing.  `'cloud'` means the runtime
   * lives in GitHub's cloud (created via `cloud:` option) and survives this
   * app process exiting; `'local'` (the default) means the worker dies when
   * the app does.  Persisted by `agent-persistence` into `agent_sessions`.
   */
  runLocation?: 'local' | 'cloud';
  /** When true, this agent is ephemeral — no DB persistence, in-memory session FS. */
  ephemeral?: boolean;
  /**
   * When true, this agent is the dedicated supervisor session launched by the
   * app-level remote-control flow (`setAppRemote(true)`).  Used to distinguish
   * the supervisor from other workspace-level (spaceId='__workspace__') agents
   * so we can safely reuse it across repeated toggles instead of launching a
   * new one each time.  Lives only in memory — not persisted.
   */
  appRemoteSupervisor?: boolean;
}

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();

  set(agentId: string, record: AgentRecord): void {
    this.agents.set(agentId, record);
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  delete(agentId: string): void {
    this.agents.delete(agentId);
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  findBySessionId(sessionId: string): AgentRecord | undefined {
    for (const record of this.agents.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  values(): IterableIterator<AgentRecord> {
    return this.agents.values();
  }

  entries(): IterableIterator<[string, AgentRecord]> {
    return this.agents.entries();
  }

  /** Remove all agents from the registry.  Intended for unit tests. */
  clear(): void {
    this.agents.clear();
  }
}

export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}
