/**
 * Typed IPC contract — the single source of truth for every IPC channel,
 * its argument types, and its return type.
 *
 * This file is **types only** — no runtime code.
 */

import type { Space, CreateSpaceInput, Attachment, AgentAnchor, AgentSession, LinkPreviewMeta, RecurrenceResult, RecallMatch, Skill, SkillContent, SkillInvocationInput, SkillInvocationResult, SkillScheduleFrequency, CanvasTarget, SpaceCanvasArtifact, UpdateState, ExportFormat, ExportDestination } from './types';
import type { ChatEvent, ElicitationSchema, ElicitationFieldValue } from './chat-types';
import type { SubagentSummary, SubagentInfo } from './subagent-types';

// ---------------------------------------------------------------------------
// Helper types needed by the contract that don't exist in shared/ yet
// ---------------------------------------------------------------------------

export interface CanvasSaveResult {
  success: boolean;
  content?: string;
  error?: string;
}

export type SpaceUpdates = Partial<
  Pick<Space, 'description' | 'body' | 'client' | 'due_at' | 'due_at_utc' | 'status' | 'attachments'>
>;

export interface SpaceEvent {
  id: string;
  space_id: string;
  event_type: string;
  due_at: string | null;
  due_at_utc: string | null;
  completed_at: string | null;
  recurrence_json: string | null;
  created_at: string;
  space_description: string | null;
  space_client: string | null;
  session_id: string | null;
}

export interface AgentListItem {
  agentId: string;
  sessionId: string;
  status: 'running' | 'waiting-approval' | 'completed' | 'failed';
  summary: string;
  selectedText: string;
  quotedText: string;
  anchor: AgentAnchor;
}

export interface AgentListAllItem extends AgentListItem {
  spaceId: string;
  createdAt: string;
  pendingApprovalId: string | null;
  pendingPermissionKind: string | null;
  pendingIntention: string | null;
  pendingPath: string | null;
  source: 'sdk' | 'cli' | 'cca';
  personaHandle: string | null;
  yoloMode: boolean;
  sandboxed: boolean;
  quotedText: string;
  /**
   * Where the agent's runtime executes.  Cloud sessions survive across app
   * restarts — the renderer should not treat them as "session lost" when
   * they appear with `running` status but no live in-memory record.
   */
  runLocation: 'local' | 'cloud';
}

export interface CanvasCommit {
  sha: string;
  message: string;
  date: string;
}

export interface GitSyncStatus {
  /** false if not a git repo, no remote, or git unavailable */
  available: boolean;
  /** Why sync is unavailable, if applicable */
  unavailableReason?: 'not-a-repo' | 'no-upstream' | 'detached-head' | 'git-not-found';
  branch: string | null;
  /** Commits ahead of upstream (ready to push) */
  ahead: number;
  /** Commits behind upstream (available to pull) */
  behind: number;
}

// Types currently only in src/main/config.ts — duplicated here so both
// main and renderer can reference them.  A later phase will unify.

export interface AgentPersona {
  id: string;
  handle: string;
  instructions: string;
  model: string;
  runLocation: 'local' | 'cca' | 'cloud';
  sandboxed?: boolean;  // enable runtime sandbox for this persona
  emoji?: string;
  cliRuntime?: string;
  /** Optional per-persona override of the global sandbox policy. */
  sandboxPolicyOverride?: SandboxPolicy;
  /** When true, agents launched with this persona automatically enable yolo mode (auto-approve all permissions). */
  yolo?: boolean;
  /** When true, session state is kept in-memory only — nothing persisted to disk or DB. */
  ephemeral?: boolean;
}

/** Sandbox policy applied to a sandboxed agent.  See docs/mxc-sandbox-schema.md. */
export interface SandboxPolicy {
  scopeToSpaceFolder: boolean;
  extraReadwritePaths: string[];
  extraReadonlyPaths: string[];
  extraDeniedPaths: string[];
  allowMcpServers: boolean;
  allowWebFetch: boolean;
  allowOutbound: boolean;
  allowLocalNetwork: boolean;
  /**
   * Which enforcement layers run for sandboxed agents.
   *
   * - `'both'` (default): host-side guards (read-only shell classifier, path-policy
   *   hook, path-aware permission handler) run before MXC. Most denials are caught
   *   host-side and never reach MXC.
   * - `'mxc-only'`: host-side guards are skipped — MXC's AppContainer + network
   *   firewall is the sole enforcer for the shell tool. Path-bearing SDK tools
   *   (view/edit/create/glob/grep) become unrestricted because MXC does not see
   *   them. Use only when verifying MXC's own enforcement; less safe than `both`.
   */
  enforcementMode: 'both' | 'mxc-only';
}

/** Default sandbox policy: maximum restriction (space folder only, no network, no MCP, no web fetch). */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  scopeToSpaceFolder: true,
  extraReadwritePaths: [],
  extraReadonlyPaths: [],
  extraDeniedPaths: [],
  allowMcpServers: false,
  allowWebFetch: false,
  allowOutbound: false,
  allowLocalNetwork: false,
  enforcementMode: 'both',
};

/**
 * Identifier of the enforcement layer that produced a sandbox denial. Surfaced
 * in `SandboxBlockRequest.layer` so the renderer's bubble-up banner can show
 * which guard fired and so logs can be filtered by layer.
 *
 * - `host:readonly-classifier` — read-only shell classifier (host-side, pre-tool)
 * - `host:path-policy` — path-policy hook for view/edit/create/glob/grep (host-side, pre-tool)
 * - `host:web-fetch` — web_fetch host-side denial (pre-tool)
 * - `host:permission` — path-aware permission handler (host-side, runtime read/write request)
 * - `mxc-only:auto-approve` — auto-approval breadcrumb in `mxc-only` mode (no host-side gate; logged for traceability)
 * - `mxc:shell-denial-suspected` — heuristic detection of MXC AppContainer denial in shell output (post-tool)
 */
export type SandboxLayer =
  | 'host:readonly-classifier'
  | 'host:path-policy'
  | 'host:web-fetch'
  | 'host:permission'
  | 'mxc-only:auto-approve'
  | 'mxc:shell-denial-suspected'   // legacy alias — kept for in-flight messages
  | 'mxc:shell-denial-high'
  | 'mxc:shell-denial-medium'
  | 'mxc:shell-denial-network';

export interface CliRuntime {
  id: string;
  label: string;
  path: string;
}

export interface CliToolDefinition {
  name: string;
  description: string;
}

export interface CustomMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  tools: string[];
}

export interface DiscoveredMcpServer {
  name: string;
  source: 'config' | 'plugin';
  type: string;
  command?: string;
  url?: string;
}

export interface WebRemoteInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
  tailscale: boolean;
  label: string;
}

export interface WebRemoteState {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  bindAddresses: string[];
  interfaces: WebRemoteInterface[];
  urls: string[];
  qrDataUrl: string | null;
  error: string | null;
}

export interface HotkeyConfig {
  toggleWindow: string;
  canvasPinToTop: string;
  canvasNewPage: string;
  popOutWindow: string;
  toggleSearch: string;
  switchProfile: string;
  close: string;
  navigateUp: string;
  navigateDown: string;
  openSubmit: string;
  stopRecording: string;
}

/** A workspace profile as resolved for the renderer (includes computed displayName). */
export interface ResolvedProfile {
  id: string;
  path: string;
  name: string | null;     // user override (null = using default)
  displayName: string;     // override, else git remote repo name, else folder name
  tint: string | null;     // hex color or null
}

export interface ProfilesState {
  profiles: ResolvedProfile[];
  activeProfileId: string | null;
}

export interface CloudJobResult {
  jobId: string;
  sessionId: string;
  actor: { id: string; login: string };
  createdAt: string;
  updatedAt: string;
}

export interface CloudJobPollResult {
  jobId: string;
  sessionId: string;
  problemStatement: string;
  status: string;
  result?: string;
  actor: { id: string; login: string };
  createdAt: string;
  updatedAt: string;
  pullRequest?: { id: string; number: number; url?: string };
  workflowRun?: { id: string };
  error?: { message: string };
  url?: string;
}

// ---------------------------------------------------------------------------
// 1. Commands — ipcMain.handle / ipcRenderer.invoke
// ---------------------------------------------------------------------------

export interface IpcCommands {
  // ── Intents ──────────────────────────────────────────────
  'space:create': { args: [input: CreateSpaceInput]; result: Space };
  'space:list': { args: []; result: Space[] };
  'space:update': { args: [id: string, updates: SpaceUpdates]; result: Space | null };
  'space:delete': { args: [id: string]; result: boolean };
  'space:dismiss-recurrence': { args: [id: string]; result: boolean };
  'space:events': { args: [limit?: number]; result: SpaceEvent[] };
  'space:resolve-date': { args: [dateText: string]; result: { due_at: string; due_at_utc: string | null } | null };
  'space:classify': { args: [text: string]; result: { type: 'space' | 'query'; answer?: string } };
  'space:summarize-title': { args: [canvasContent: string]; result: { title: string | null } };
  'space:search': { args: [query: string]; result: Space[] };
  'space:unarchive': { args: [id: string]; result: Space | null };

  // ── Voice ────────────────────────────────────────────────
  'voice:transcribe': { args: [audioData: number[]]; result: string };

  // ── Settings ─────────────────────────────────────────────
  'settings:get': { args: [key: string]; result: unknown };
  'settings:set': { args: [key: string, value: string]; result: string | null | undefined };
  'web-remote:get-state': { args: []; result: WebRemoteState };
  'web-remote:set-enabled': { args: [enabled: boolean]; result: WebRemoteState };
  'web-remote:set-config': {
    args: [config: { port?: number; bindAddresses?: string[] }];
    result: WebRemoteState | { error: string };
  };
  'web-remote:regenerate-token': { args: []; result: WebRemoteState };
  'web-remote:list-interfaces': { args: []; result: WebRemoteInterface[] };

  // ── Hotkeys ──────────────────────────────────────────────
  'hotkeys:get': { args: []; result: HotkeyConfig };
  'hotkeys:set': { args: [key: string, accelerator: string]; result: { ok: true } | { error: string } };
  'hotkeys:reset': { args: [key?: string]; result: { ok: true; hotkeys: HotkeyConfig } };
  'hotkeys:toggle-status': { args: []; result: { accelerator: string; registered: boolean } };

  // ── CLI / Models ─────────────────────────────────────────
  'cli:resolve-path': { args: []; result: string | null };
  'cli:check-version': { args: []; result: { path: string | null; version: string | null; compatible: boolean; minVersion: string } };
  'cli:check-mxc-capable': { args: []; result: { mxcCapable: boolean } };
  'cli:runtime-status': {
    args: [];
    result: {
      source: 'bundled' | 'auto' | 'path' | 'server';
      target: string | null;
      version: string | null;
      compatible: boolean;
      minVersion: string;
    };
  };
  'cli:test-connection': {
    args: [];
    result: {
      ok: boolean;
      source: 'bundled' | 'auto' | 'path' | 'server';
      target: string | null;
      version: string | null;
      compatible: boolean;
      minVersion: string;
      error?: string;
    };
  };
  'cli:discover': {
    args: [];
    result: Array<{
      path: string;
      version: string | null;
      source: 'bundled' | 'path';
      origin: string;
      compatible: boolean;
    }>;
  };
  'models:list': { args: []; result: Array<{ id: string; name: string }> };
  'models:list-detailed': {
    args: [];
    result: { models: Array<{ id: string; name?: string }>; error: string | null };
  };

  // ── Personas ─────────────────────────────────────────────
  'personas:list': { args: []; result: AgentPersona[] };
  'personas:save': { args: [personas: AgentPersona[]]; result: { ok: true } | { error: string } };

  // ── MCP servers ──────────────────────────────────────────
  'mcp:list-discovered': { args: []; result: DiscoveredMcpServer[] };
  'mcp:list-custom': { args: []; result: CustomMcpServer[] };
  'mcp:save-custom': { args: [servers: CustomMcpServer[]]; result: { ok: true } | { error: string } };

  // ── CLI tools ────────────────────────────────────────────
  'cli-tools:list': { args: []; result: CliToolDefinition[] };
  'cli-tools:save': { args: [tools: CliToolDefinition[]]; result: { ok: true } | { error: string } };

  // ── Sandbox default policy ───────────────────────────────
  'sandbox:get-default': { args: []; result: SandboxPolicy };
  'sandbox:save-default': { args: [policy: SandboxPolicy]; result: { ok: true; policy: SandboxPolicy } | { error: string } };
  'sandbox:open-config-preview': { args: [policy: SandboxPolicy]; result: { ok: true; path: string } | { error: string } };

  // ── Sessions ─────────────────────────────────────────────
  'session:launch': { args: [spaceId: string]; result: { success: boolean; error?: string } };
  'session:active-spaces': { args: []; result: string[] };

  // ── Workspace / Shell ────────────────────────────────────
  'workspace:select': { args: []; result: { selected: boolean; path: string | null } };
  'workspace:clear': { args: []; result: { ok: true } };

  // ── Workspace profiles ───────────────────────────────────
  'profiles:list': { args: []; result: ProfilesState };
  'profiles:add': { args: []; result: { added: boolean; profileId: string | null } };
  'profiles:activate': { args: [id: string]; result: { ok: boolean; error?: string } };
  'profiles:cycle': { args: []; result: { ok: boolean; profileId?: string } };
  'profiles:update': { args: [id: string, patch: { name?: string | null; tint?: string | null }]; result: { ok: boolean } };
  'profiles:remove': { args: [id: string]; result: { ok: boolean } };
  'shell:openPath': { args: [folderPath: string]; result: string };
  'shell:openExternal': { args: [url: string]; result: { ok: true } };

  // ── Git sync ────────────────────────────────────────────
  'workspace:git-status': { args: []; result: GitSyncStatus };
  'workspace:git-push': { args: []; result: { ok: true } | { error: string } };
  'workspace:git-pull': { args: []; result: { ok: true } | { error: string; conflict?: boolean } };

  // ── Canvas artifacts ─────────────────────────────────────
  'canvas-artifact:list': { args: [spaceId: string]; result: { artifacts: SpaceCanvasArtifact[] } };
  'canvas-artifact:list-all': { args: []; result: { artifacts: SpaceCanvasArtifact[] } };
  'canvas-artifact:open': {
    args: [spaceId: string, artifactId: string];
    result: { ok: true } | { error: string };
  };

  // ── Canvas ───────────────────────────────────────────────
  'canvas:read': { args: [spaceId: string]; result: { content: string; error?: string } };
  'canvas:has-content': { args: [spaceId: string]; result: { hasContent: boolean } };
  'canvas:write': { args: [spaceId: string, content: string]; result: CanvasSaveResult };
  'canvas:close': { args: [spaceId: string, content: string]; result: CanvasSaveResult };
  'canvas:paste-file': { args: [spaceId: string, filename: string, dataArray: number[]]; result: { path: string } | { error: string } };
  'canvas:resolve-attachment': { args: [spaceId: string, relativePath: string]; result: { path: string; mimeType: string } | { error: string } };
  'canvas:fetch-link-meta': { args: [url: string]; result: LinkPreviewMeta };
  'canvas:history': { args: [spaceId: string]; result: { commits: CanvasCommit[]; error?: string } };
  'canvas:restore': { args: [spaceId: string, sha: string]; result: { success: boolean; error?: string } };
  'canvas:preview-version': { args: [spaceId: string, sha: string]; result: { content: string; error?: string } };

  // ── Canvas child pages ────────────────────────────────────
  'canvas:create-page': { args: [spaceId: string, pageName: string]; result: { success: boolean; page: string; error?: string } };
  'canvas:read-page': { args: [spaceId: string, pageName: string]; result: { content: string; error?: string } };
  'canvas:write-page': { args: [spaceId: string, pageName: string, content: string]; result: CanvasSaveResult };
  'canvas:close-page': { args: [spaceId: string, pageName: string, content: string]; result: CanvasSaveResult };
  'canvas:list-pages': { args: [spaceId: string]; result: { pages: string[]; error?: string } };
  'canvas:open-link': { args: [spaceId: string, url: string]; result: { action: 'canvas' | 'external' | 'none'; error?: string } };
  'canvas:read-file': { args: [spaceId: string, relativePath: string]; result: { data?: number[]; mimeType?: string; error?: string } };

  // ── Canvas export / sharing ───────────────────────────────
  'canvas:export': { args: [spaceId: string, format: ExportFormat]; result: { path: string } | { error: string } };
  'canvas:share': { args: [spaceId: string, format: ExportFormat]; result: { ok: true; method: 'os-share' | 'reveal' } | { error: string } };
  'canvas:export-to-destination': { args: [spaceId: string, destinationId: string, format?: ExportFormat]; result: { path: string } | { error: string } };
  'export-destinations:list': { args: []; result: ExportDestination[] };
  'export-destinations:save': { args: [destinations: ExportDestination[]]; result: { ok: true; destinations: ExportDestination[] } | { error: string } };
  'dialog:select-folder': { args: [options?: { title?: string }]; result: { path: string } | { canceled: true } };

  // ── Agent ────────────────────────────────────────────────
  'agent:launch': {
    args: [spaceId: string, selectedText: string, anchor: AgentAnchor, options?: { repo?: string; model?: string }];
    result: { agentId: string; sessionId: string } | { error: string };
  };
  'agent:launch-from-comment': {
    args: [spaceId: string, commentBody: string, quotedText: string, anchor: AgentAnchor, personaHandle: string, threadId: string | null];
    result: { agentId: string; sessionId: string } | { error: string };
  };
  'agent:list': { args: [spaceId: string]; result: AgentListItem[] };
  'agent:approve': { args: [agentId: string, requestId: string, approved: boolean]; result: void };
  'agent:respond-user-input': { args: [agentId: string, requestId: string, answer: string, wasFreeform: boolean]; result: void };
  'agent:respond-elicitation': {
    args: [agentId: string, requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>];
    result: void;
  };
  'agent:abort': { args: [agentId: string]; result: void };
  'agent:open-cli': { args: [agentId: string]; result: { error?: string } };
  'agent:resolve-sandbox': {
    args: [agentId: string, requestId: string, decision: 'allow-once' | 'allow-for-session' | 'disable'];
    result: { ok: true } | { error: string };
  };
  'agent:quick-launch': { args: [prompt: string, personaHandle?: string]; result: { agentId: string; sessionId: string } | { error: string } };
  'agent:launch-document': {
    args: [spaceId: string, options?: { personaHandle?: string | null; promptOverride?: string }];
    result: { agentId: string; sessionId: string } | { error: string };
  };
  'agent:list-all': { args: []; result: AgentListAllItem[] };
  'agent:delete-session': { args: [agentId: string]; result: { ok: true } };
  'agent:launch-cloud': {
    args: [spaceId: string, prompt: string];
    result: { agentId: string; sessionId: string; jobId: string } | { error: string };
  };
  'agent:cloud-status': { args: [agentId: string]; result: CloudJobPollResult };
  'agent:get-history': { args: [agentId: string]; result: { events: unknown[]; restarted?: boolean } | { error: string } };
  'agent:set-yolo': { args: [agentId: string, enabled: boolean]; result: { ok: true } | { error: string } };
  'agent:enable-remote': { args: [agentId: string]; result: { enabled: boolean; remoteSteerable: boolean; url?: string } | { error: string } };
  'agent:disable-remote': { args: [agentId: string]; result: { ok: true } | { error: string } };
  'agent:get-remote-state': { args: [agentId: string]; result: { enabled: boolean; remoteSteerable: boolean; url?: string } | { error: string } };
  'agent:reset-remote': { args: [agentId: string]; result: { enabled: boolean; remoteSteerable: boolean; url?: string; changed: boolean } | { error: string } };

  // ── App-level remote ────────────────────────────────────
  'app:set-remote': {
    args: [enabled: boolean];
    result: { enabled: boolean; agents: Array<{ agentId: string; url?: string }> } | { error: string };
  };
  'app:get-remote-status': {
    args: [];
    result: { enabled: boolean; agents: Array<{ agentId: string; url?: string }> };
  };

  // ── CLI session ──────────────────────────────────────────
  'cli:launch-session': { args: []; result: { agentId: string; sessionId: string } | { error: string } };

  // ── Chat ─────────────────────────────────────────────────
  'chat:send-message': {
    args: [agentId: string, prompt: string, attachments?: Array<{ type: 'file'; path: string }>];
    result: { error?: string; restarted?: boolean };
  };
  'chat:set-model': { args: [agentId: string, model: string]; result: { error?: string } };

  // ── Sub-agents ───────────────────────────────────────────
  'subagent:list': { args: [parentAgentId: string]; result: SubagentSummary[] };
  'subagent:read': { args: [parentAgentId: string, agentId: string]; result: SubagentInfo | null };
  'subagent:write': { args: [parentAgentId: string, agentId: string, message: string]; result: { success: boolean; error?: string } };
  'subagent:cancel': { args: [parentAgentId: string, agentId: string]; result: { success: boolean; error?: string } };

  // ── Window ───────────────────────────────────────────────
  'window:get-pinned': { args: []; result: boolean };

  // ── Skills ──────────────────────────────────────────────
  'skill:list': { args: []; result: Skill[] };
  'skill:read': { args: [skillId: string]; result: SkillContent | { error: string } };
  'skill:write': { args: [skillId: string, frontmatter: Record<string, unknown>, body: string]; result: { success: boolean } | { error: string } };
  'skill:create': { args: [name: string]; result: Skill | { error: string } };
  'skill:create-from-prompt': { args: [description: string]; result: { agentId: string; sessionId: string } | { error: string } };
  'skill:delete': { args: [skillId: string]; result: boolean };
  'skill:open-folder': { args: [skillId: string]; result: void };
  'skill:create-space': { args: [skillId: string]; result: Space | { error: string } };
  'skill:launch': { args: [skillId: string]; result: Space | { error: string } };
  'skill:invoke': { args: [input: SkillInvocationInput]; result: SkillInvocationResult | { error: string } };
  'skill:set-schedule': { args: [skillId: string, frequency: SkillScheduleFrequency, time: string, day: number | null]; result: Skill | { error: string } };
  'skill:clear-schedule': { args: [skillId: string]; result: { success: boolean } | { error: string } };

  // ── Updates ──────────────────────────────────────────────
  'update:install': { args: []; result: void };
  'update:check': { args: []; result: void };
  'update:download': { args: []; result: void };
  'update:get-state': { args: []; result: UpdateState };
  'update:open-log': { args: []; result: { ok: true } | { error: string } };
}

// ---------------------------------------------------------------------------
// 2. Fire-and-forget messages — ipcRenderer.send / ipcMain.on
// ---------------------------------------------------------------------------

export interface IpcMessages {
  'window:hide': { args: [] };
  'window:expand': { args: [] };
  'window:collapse': { args: [] };
  'window:set-pinned': { args: [pinned: boolean] };
  'canvas-window:open': { args: [target: CanvasTarget] };
  'canvas-window:open-page': { args: [target: { kind: 'page'; spaceId: string; page: string; title: string }] };
  'canvas-window:update-title': { args: [title: string] };
  'canvas-window:theme-changed': { args: [theme: string] };
  'canvas-window:hide-ready': { args: [] };
}

// ---------------------------------------------------------------------------
// 3. Events — main → renderer via webContents.send
// ---------------------------------------------------------------------------

/**
 * What caused the main window to show or hide. The quick-start tour uses this
 * to tell "the user pressed the global hotkey" apart from "the user clicked the
 * tray icon", so it can check off each lesson only when it was really performed.
 */
export type WindowToggleSource = 'hotkey' | 'tray' | 'startup' | 'other';

export interface IpcEvents {
  'chat:event': { agentId: string } & ChatEvent;
  'subagent:changed': { parentAgentId: string };
  'window:pinned-changed': { pinned: boolean };
  'canvas-window:load-target': CanvasTarget;
  'canvas-window:closed': void;
  'canvas-window:theme-changed': { theme: string };
  'canvas-window:request-hide': void;
  'window:shown': { side: 'left' | 'right'; expanded: boolean; source: WindowToggleSource };
  'window:toggle': { source: WindowToggleSource };
  'workspace:committed': void;
  'workspace:changed': { path: string | null };
  'profiles:changed': ProfilesState;
  'workspace:git-sync-changed': GitSyncStatus;
  'agent:status-changed': { agentId: string; status: string; summary?: string; spaceId?: string; threadId?: string | null };
  'agent:approval-needed': { agentId: string; requestId: string; permissionKind: string; intention?: string; path?: string; spaceId?: string; threadId?: string | null };
  'agent:approval-resolved': { agentId: string; requestId: string; approved: boolean; spaceId?: string; threadId?: string | null };
  'agent:user-input-requested': { agentId: string; requestId: string; question: string; choices?: string[]; allowFreeform?: boolean; spaceId?: string; threadId?: string | null };
  'agent:user-input-resolved': { agentId: string; requestId: string; answer: string; wasFreeform: boolean; spaceId?: string; threadId?: string | null };
  'agent:elicitation-requested': { agentId: string; requestId: string; message: string; requestedSchema?: ElicitationSchema; mode?: 'form' | 'url'; elicitationSource?: string; spaceId?: string; threadId?: string | null };
  'agent:elicitation-resolved': { agentId: string; requestId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, ElicitationFieldValue>; spaceId?: string; threadId?: string | null };
  'agent:sandbox-blocked': {
    agentId: string;
    requestId: string;
    source: 'permission' | 'pre-tool' | 'post-tool-shell';
    kind: 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'web-fetch';
    toolName?: string;
    target: string;
    intention?: string;
    allowedDecisions?: Array<'allow-once' | 'allow-for-session' | 'disable'>;
    layer?: SandboxLayer;
    /** Handle of the persona that launched this agent. Used by the renderer
     *  to open the persona editor on "Edit sandbox config". */
    personaHandle?: string;
    spaceId?: string;
    threadId?: string | null;
  };
  /** Companion to `agent:sandbox-blocked`. Broadcast to ALL renderer windows
   *  on resolution so any window that rendered the block panel can dismiss it
   *  when the user resolved it from another window (e.g. canvas → main app). */
  'agent:sandbox-resolved': {
    agentId: string;
    requestId: string;
    decision: 'allow-once' | 'allow-for-session' | 'disable';
    spaceId?: string;
    threadId?: string | null;
  };
  'agent:completed': { agentId: string; summary: string };
  'agent:yolo-changed': { agentId: string; enabled: boolean };
  'agent:remote-changed': { agentId: string; enabled: boolean; remoteSteerable: boolean; url?: string };
  'app:remote-changed': { enabled: boolean; agents: Array<{ agentId: string; url?: string }> };
  'notification:approval-clicked': { agentId: string };
  'agent:presence-started': { agentId: string; spaceId: string; persona: { name: string; handle: string }; anchor: AgentAnchor; threadId?: string };
  'agent:presence-ended': { agentId: string; spaceId: string };
  'agent:reply-ready': { agentId: string; spaceId: string; threadId: string | null; body: string };
  'canvas:content-updated': { spaceId: string; content: string };
  'space:processed': { spaceId: string };
  'space:title-updated': { spaceId: string; title: string };
  'space:recurrence': { spaceId: string; result: RecurrenceResult };
  'space:recurrence-applied': { spaceId: string };
  'space:recall': { spaceId: string; match: RecallMatch };
  'skills:changed': void;
  'update:state-changed': UpdateState;
}

// ---------------------------------------------------------------------------
// Utility types — will be consumed by typed preload / handler wrappers
// ---------------------------------------------------------------------------

/** Extract the channel names for each category */
export type IpcCommandChannel = keyof IpcCommands;
export type IpcMessageChannel = keyof IpcMessages;
export type IpcEventChannel = keyof IpcEvents;

/** Extract args tuple for a command */
export type IpcCommandArgs<C extends IpcCommandChannel> = IpcCommands[C]['args'];

/** Extract return type for a command */
export type IpcCommandResult<C extends IpcCommandChannel> = IpcCommands[C]['result'];

/** Extract args tuple for a fire-and-forget message */
export type IpcMessageArgs<C extends IpcMessageChannel> = IpcMessages[C]['args'];

/** Extract payload for a main→renderer event */
export type IpcEventPayload<C extends IpcEventChannel> = IpcEvents[C];
