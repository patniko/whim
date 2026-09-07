/**
 * MIGRATION NOTE: This file is being incrementally migrated to React components.
 * See src/renderer/MIGRATION.md for the migration plan.
 * New features should use:
 *   - src/renderer/ipc-client.ts (typed IPC)
 *   - src/renderer/state/ (space-store, agent-store)
 *   - src/renderer/views/ (React components)
 */

import {
  acceleratorsConflict,
  eventMatchesAccelerator,
  formatAccelerator,
  keyboardEventToAccelerator,
  modifierEventToAccelerator,
} from './lib/hotkeys';
import { generateTintColor, isValidTint, hueOf } from './lib/tint';
import { parseFrontmatter } from '../shared/frontmatter';
import { deriveMarkdownTitle, ensureMarkdownH1Title } from '../shared/markdown-title';
import type { CanvasSaveResult, WindowToggleSource } from '../shared/ipc-contract';

interface ResolvedProfile {
  id: string;
  path: string;
  name: string | null;
  displayName: string;
  tint: string | null;
}

interface ProfilesState {
  profiles: ResolvedProfile[];
  activeProfileId: string | null;
}

interface RecurrenceResult {
  should_recur: boolean;
  reasoning: string;
  next_due: string | null;
  next_due_utc: string | null;
}

interface RecallMatch {
  space_id: string;
  description: string;
  completed_at: string | null;
  confidence: number;
}

interface SandboxPolicy {
  scopeToSpaceFolder: boolean;
  extraReadwritePaths: string[];
  extraReadonlyPaths: string[];
  extraDeniedPaths: string[];
  allowMcpServers: boolean;
  allowWebFetch: boolean;
  allowOutbound: boolean;
  allowLocalNetwork: boolean;
  enforcementMode: 'both' | 'mxc-only';
}

const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
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

interface AgentPersona {
  id: string;
  handle: string;
  instructions: string;
  model: string;
  runLocation: 'local' | 'cca' | 'cloud';  // where to execute the agent
  sandboxed?: boolean;
  emoji?: string;
  cliRuntime?: string;
  sandboxPolicyOverride?: SandboxPolicy;
  yolo?: boolean;
  ephemeral?: boolean;
}

interface CliRuntime {
  id: string;
  label: string;
  path: string;
}

interface CliToolDefinition {
  name: string;
  description: string;
}

interface CustomMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  tools: string[];
}

interface DiscoveredMcpServer {
  name: string;
  source: 'config' | 'plugin';
  type: string;
  command?: string;
  url?: string;
}

type InterfaceScope = 'loopback' | 'private' | 'vpn' | 'public';

interface WebRemoteInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
  scope: InterfaceScope;
  label: string;
}

type WebRemoteBindSelection =
  | { kind: 'interface'; interfaceName: string; family: 'IPv4' | 'IPv6' }
  | { kind: 'address'; address: string }
  | { kind: 'all'; family: 'IPv4' | 'IPv6' };

interface WebRemoteBindingStatus {
  selection: WebRemoteBindSelection;
  label: string;
  scope: InterfaceScope;
  state: 'listening' | 'pending' | 'failed';
  addresses: string[];
  detail: string | null;
}

type WebRemoteTlsMode = 'auto' | 'off' | 'custom';

interface WebRemoteTlsState {
  mode: WebRemoteTlsMode;
  active: boolean;
  fingerprint: string | null;
  expiresAt: string | null;
  error: string | null;
}

interface WebRemoteDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  lastAddress: string | null;
  userAgent: string | null;
}

interface WebRemoteState {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  selections: WebRemoteBindSelection[];
  bindings: WebRemoteBindingStatus[];
  interfaces: WebRemoteInterface[];
  urls: string[];
  qrDataUrl: string | null;
  error: string | null;
  tls: WebRemoteTlsState;
  allowedHosts: string[];
  devices: WebRemoteDevice[];
}

interface FolderCommit {
  sha: string;
  shortSha: string;
  message: string;
  date: string;
  relativeDate: string;
  filesChanged: string[];
}

interface WhimAPI {
  create(input: { body: string }): Promise<Space>;
  list(): Promise<Space[]>;
  update(id: string, updates: Record<string, unknown>): Promise<Space>;
  delete(id: string): Promise<boolean>;
  dismissRecurrence(id: string): Promise<boolean>;
  transcribe(audioData: number[]): Promise<string>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<string | null | undefined>;
  getWebRemoteState(): Promise<WebRemoteState>;
  setWebRemoteEnabled(enabled: boolean): Promise<WebRemoteState>;
  setWebRemoteConfig(config: {
    port?: number;
    selections?: WebRemoteBindSelection[];
    tlsMode?: WebRemoteTlsMode;
    tlsCertPath?: string;
    tlsKeyPath?: string;
    allowedHosts?: string[];
  }): Promise<WebRemoteState | { error: string }>;
  regenerateWebRemoteToken(): Promise<WebRemoteState>;
  revokeWebRemoteDevice(deviceId: string): Promise<WebRemoteState>;
  listWebRemoteInterfaces(): Promise<WebRemoteInterface[]>;
  getHotkeys(): Promise<Record<string, string>>;
  setHotkey(key: string, accelerator: string): Promise<{ ok?: boolean; error?: string }>;
  resetHotkeys(key?: string): Promise<{ ok?: boolean; hotkeys?: Record<string, string> }>;
  getToggleShortcutStatus(): Promise<{ accelerator: string; registered: boolean }>;
  resolveCliPath(): Promise<string | null>;
  checkCliVersion(): Promise<{ path: string | null; version: string | null; compatible: boolean; minVersion: string }>;
  checkCliMxcCapable(): Promise<{ mxcCapable: boolean }>;
  getCliRuntimeStatus(): Promise<{ source: string; target: string | null; version: string | null; compatible: boolean; minVersion: string }>;
  testCliConnection(): Promise<{ ok: boolean; source: string; target: string | null; version: string | null; compatible: boolean; minVersion: string; error?: string }>;
  listModels(): Promise<{ id: string; name?: string }[]>;
  listModelsDetailed(): Promise<{ models: { id: string; name?: string }[]; error: string | null }>;
  discoverClis(): Promise<{ path: string; version: string | null; source: 'bundled' | 'path'; origin: string; compatible: boolean }[]>;
  listPersonas(): Promise<AgentPersona[]>;
  savePersonas(personas: AgentPersona[]): Promise<{ ok?: boolean; error?: string }>;
  listRuntimes(): Promise<CliRuntime[]>;
  saveRuntimes(runtimes: CliRuntime[]): Promise<{ ok?: boolean; error?: string; runtimes?: CliRuntime[] }>;
  listDiscoveredMcp(): Promise<DiscoveredMcpServer[]>;
  listCustomMcp(): Promise<CustomMcpServer[]>;
  saveCustomMcp(servers: CustomMcpServer[]): Promise<{ ok?: boolean; error?: string }>;
  listCliTools(): Promise<CliToolDefinition[]>;
  saveCliTools(tools: CliToolDefinition[]): Promise<{ ok?: boolean; error?: string }>;
  getSandboxDefaultPolicy(): Promise<SandboxPolicy>;
  saveSandboxDefaultPolicy(policy: SandboxPolicy): Promise<{ ok?: boolean; policy?: SandboxPolicy; error?: string }>;
  openSandboxConfigPreview(policy: SandboxPolicy): Promise<{ ok?: boolean; path?: string; error?: string }>;
  resolveSandboxBlock(agentId: string, requestId: string, decision: 'allow-once' | 'allow-for-session' | 'disable'): Promise<{ ok?: boolean; error?: string }>;
  disableSandbox(agentId: string): Promise<{ ok?: boolean; error?: string }>;
  listEvents(limit?: number): Promise<any[]>;
  resolveDate(dateText: string): Promise<{ due_at: string; due_at_utc: string | null }>;
  classifyInput(text: string): Promise<{ type: 'space' | 'query'; query_answer?: string }>;
  launchSession(spaceId: string): Promise<{ success: boolean; error?: string; sessionId?: string }>;
  getActiveSessions(): Promise<string[]>;
  selectWorkspace(): Promise<{ selected: boolean; path: string | null }>;
  clearWorkspace(): Promise<{ ok: boolean }>;
  onWorkspaceChanged(callback: (path: string | null) => void): void;
  listProfiles(): Promise<ProfilesState>;
  addProfile(): Promise<{ added: boolean; profileId: string | null }>;
  activateProfile(id: string): Promise<{ ok: boolean; error?: string }>;
  cycleProfile(): Promise<{ ok: boolean; profileId?: string }>;
  updateProfile(id: string, patch: { name?: string | null; tint?: string | null }): Promise<{ ok: boolean }>;
  removeProfile(id: string): Promise<{ ok: boolean }>;
  onProfilesChanged(callback: (state: ProfilesState) => void): void;
  gitSyncStatus(): Promise<{ available: boolean; branch: string | null; ahead: number; behind: number; unavailableReason?: string }>;
  gitPush(): Promise<{ ok: true } | { error: string }>;
  gitPull(): Promise<{ ok: true } | { error: string; conflict?: boolean }>;
  onGitSyncChanged(callback: (status: { available: boolean; branch: string | null; ahead: number; behind: number; unavailableReason?: string }) => void): void;
  readCanvas(spaceId: string): Promise<{ content: string; error?: string }>;
  writeCanvas(spaceId: string, content: string): Promise<CanvasSaveResult>;
  closeCanvas(spaceId: string, content: string): Promise<CanvasSaveResult>;
  canvasHistory(spaceId: string): Promise<{ commits: FolderCommit[]; error?: string }>;
  canvasRestore(spaceId: string, sha: string): Promise<{ success: boolean; error?: string }>;
  canvasPreviewVersion(spaceId: string, sha: string): Promise<{ content: string; error?: string }>;
  searchSpaces(query: string): Promise<Space[]>;
  unarchive(id: string): Promise<Space | null>;
  summarizeTitle(canvasContent: string): Promise<{ title: string | null }>;
  pasteFile(spaceId: string, filename: string, dataArray: number[]): Promise<{ success?: boolean; relativePath?: string; filename?: string; error?: string }>;
  openSpaceFolder(spaceId: string): Promise<void>;
  getCanvasAgentState(spaceId: string): Promise<CanvasAgentStateSnapshot[]>;
  exportCanvas(spaceId: string, format: ExportFormat): Promise<{ path: string } | { error: string }>;
  shareCanvas(spaceId: string, format: ExportFormat): Promise<{ ok: true; method: 'os-share' | 'reveal' } | { error: string }>;
  exportCanvasToDestination(spaceId: string, destinationId: string, format?: ExportFormat): Promise<{ path: string } | { error: string }>;
  listExportDestinations(): Promise<ExportDestination[]>;
  saveExportDestinations(destinations: ExportDestination[]): Promise<{ ok: true; destinations: ExportDestination[] } | { error: string }>;
  selectFolder(options?: { title?: string }): Promise<{ path: string } | { canceled: true }>;
  listAgents(spaceId: string): Promise<any[]>;
  quickLaunchAgent(prompt: string, personaHandle?: string): Promise<{ agentId?: string; sessionId?: string; error?: string }>;
  listAllAgents(): Promise<any[]>;
  deleteAgentSession(agentId: string): Promise<{ ok?: boolean; error?: string }>;
  setAgentYolo(agentId: string, enabled: boolean): Promise<{ ok?: boolean; error?: string }>;
  launchCloudAgent(spaceId: string, prompt: string): Promise<{ agentId?: string; sessionId?: string; jobId?: string; error?: string }>;
  getCloudJobStatus(agentId: string): Promise<any>;
  launchCliSession(): Promise<{ agentId?: string; sessionId?: string; error?: string }>;
  getAgentHistory(agentId: string): Promise<{ events?: any[]; error?: string }>;
  openAgentCli(agentId: string): Promise<{ error?: string }>;
  onChatEvent(agentId: string, callback: (event: any) => void): () => void;
  launchAgent(spaceId: string, selectedText: string, anchor: any, options?: { repo?: string; model?: string }): Promise<any>;
  launchDocumentAgent(spaceId: string, options?: { personaHandle?: string | null; promptOverride?: string }): Promise<{ agentId: string; sessionId: string } | { error: string }>;
  launchCommentAgent(spaceId: string, commentBody: string, quotedText: string, anchor: any, personaHandle: string, threadId: string | null): Promise<{ agentId?: string; sessionId?: string; error?: string }>;
  approveAgent(agentId: string, requestId: string, approved: boolean): Promise<void>;
  respondUserInput(agentId: string, requestId: string, answer: string, wasFreeform: boolean): Promise<void>;
  respondElicitation(agentId: string, requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void>;
  abortAgent(agentId: string): Promise<void>;
  hideWindow(): void;
  expandWindow(): void;
  collapseWindow(): void;
  getPinned(): Promise<boolean>;
  setPinned(pinned: boolean): void;
  onPinnedChanged(callback: (pinned: boolean) => void): void;
  openCanvasWindow(target: { kind: string; id: string; title: string }): void;
  openNewCanvasWindow(target: { kind: string; id: string; title: string }): void;
  onLoadCanvasTarget(callback: (target: { kind: string; id: string; title: string }) => void): void;
  onCanvasWindowClosed(callback: () => void): void;
  updateCanvasWindowTitle(title: string): void;
  notifyCanvasThemeChanged(theme: string): void;
  onCanvasThemeChanged(callback: (theme: string) => void): void;
  onFontChanged(callback: (font: string) => void): void;
  onCanvasRequestHide(callback: () => void): void;
  canvasHideReady(): void;
  openAgentChatInPanel(data: { agentId: string; agentPrompt: string; agentStatus: string; agentSource?: 'sdk' | 'cli'; spaceId?: string }): void;
  onOpenAgentChatInPanel(callback: (data: { agentId: string; agentPrompt: string; agentStatus: string; agentSource?: 'sdk' | 'cli'; spaceId?: string }) => void): void;
  openPersonaSandboxEditor(personaHandle: string): void;
  onOpenPersonaSandboxEditor(callback: (data: { personaHandle: string }) => void): void;
  createPage(spaceId: string, pageName: string): Promise<{ success: boolean; page: string; error?: string }>;
  readPage(spaceId: string, pageName: string): Promise<{ content: string; error?: string }>;
  writePage(spaceId: string, pageName: string, content: string): Promise<CanvasSaveResult>;
  closePage(spaceId: string, pageName: string, content: string): Promise<CanvasSaveResult>;
  listPages(spaceId: string): Promise<{ pages: string[]; error?: string }>;
  openPageWindow(target: { kind: 'page'; spaceId: string; page: string; title: string }): void;
  openSettingsWindow(): void;
  onSettingsRefresh(callback: () => void): void;
  onHotkeysChanged(callback: () => void): void;
  onWindowShown(callback: (data: { side: 'left' | 'right'; expanded: boolean; source?: WindowToggleSource }) => void): void;
  onWindowToggle(callback: (data: { source?: WindowToggleSource }) => void): void;
  onRequestHide(callback: () => void): void;
  onWorkspaceCommitted(callback: () => void): void;
  onSpaceProcessed(callback: (id: string) => void): void;
  onSpaceTitleUpdated(callback: (data: { spaceId: string; title: string }) => void): void;
  onRecurrenceResult(callback: (spaceId: string, result: RecurrenceResult) => void): void;
  onRecurrenceApplied(callback: (spaceId: string) => void): void;
  onRecallHint(callback: (spaceId: string, match: RecallMatch) => void): void;
  onAgentStatusChanged(callback: (data: any) => void): void;
  onAgentApprovalNeeded(callback: (data: any) => void): void;
  onAgentApprovalResolved(callback: (data: { agentId: string; requestId: string; approved: boolean; spaceId?: string; threadId?: string | null }) => void): void;
  onAgentUserInputRequested(callback: (data: { agentId: string; requestId: string; question: string; choices?: string[]; allowFreeform?: boolean; spaceId?: string; threadId?: string | null }) => void): void;
  onAgentUserInputResolved(callback: (data: { agentId: string; requestId: string; answer: string; wasFreeform: boolean; spaceId?: string; threadId?: string | null }) => void): void;
  onAgentElicitationRequested(callback: (data: { agentId: string; requestId: string; message: string; requestedSchema?: any; mode?: 'form' | 'url'; elicitationSource?: string; spaceId?: string; threadId?: string | null }) => void): void;
  onAgentElicitationResolved(callback: (data: { agentId: string; requestId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown>; spaceId?: string; threadId?: string | null }) => void): void;
  onAgentSandboxBlocked(callback: (data: {
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
    spaceId?: string;
    threadId?: string | null;
  }) => void): void;
  onAgentSandboxResolved(callback: (data: { agentId: string; requestId: string; decision: 'allow-once' | 'allow-for-session' | 'disable'; spaceId?: string; threadId?: string | null }) => void): void;
  onAgentCompleted(callback: (data: any) => void): void;
  onAgentYoloChanged(callback: (data: { agentId: string; enabled: boolean }) => void): void;
  onAgentRemoteChanged(callback: (data: { agentId: string; enabled: boolean; remoteSteerable: boolean; url?: string }) => void): void;
  enableRemote(agentId: string): Promise<{ enabled?: boolean; remoteSteerable?: boolean; url?: string; error?: string }>;
  disableRemote(agentId: string): Promise<{ ok?: boolean; error?: string }>;
  setAppRemote(enabled: boolean): Promise<{ ok: boolean; enabled: boolean; agents: Array<{ agentId: string; url?: string }> } | { error: string }>;
  getAppRemoteStatus(): Promise<{ enabled: boolean; agents: Array<{ agentId: string; url?: string }> }>;
  onAppRemoteChanged(callback: (data: { enabled: boolean; agents: Array<{ agentId: string; url?: string }> }) => void): void;  onNotificationApprovalClicked(callback: (data: { agentId: string }) => void): void;
  onAgentPresenceStarted(callback: (data: { agentId: string; spaceId: string; persona: { name: string; handle: string; color?: string; imageUrl?: string }; anchor: { prefix?: string; suffix?: string }; threadId?: string }) => void): void;
  onAgentPresenceEnded(callback: (data: { agentId: string; spaceId: string }) => void): void;
  onAgentReplyReady(callback: (data: { agentId: string; spaceId: string; threadId: string | null; body: string }) => void): void;
  onCanvasContentUpdated(callback: (data: { spaceId: string; content: string }) => void): () => void;
  openPath(folderPath: string): Promise<void>;
  openExternal(url: string): Promise<{ ok: true }>;
  // ── Skills ──────────────────────────────────────────────
  listSkills(): Promise<any[]>;
  readSkill(skillId: string): Promise<{ frontmatter: Record<string, unknown>; body: string } | { error: string }>;
  writeSkill(skillId: string, frontmatter: Record<string, unknown>, body: string): Promise<{ success: boolean } | { error: string }>;
  createSkill(name: string): Promise<any>;
  createSkillFromPrompt(description: string): Promise<{ agentId?: string; sessionId?: string; error?: string }>;
  deleteSkill(skillId: string): Promise<boolean>;
  openSkillFolder(skillId: string): Promise<void>;
  createSpaceFromSkill(skillId: string): Promise<any>;
  launchSkill(skillId: string): Promise<any>;
  invokeSkill(input: SkillInvocationInput): Promise<SkillInvocationResult | { error: string }>;
  setSkillSchedule(skillId: string, frequency: string, time: string, day: number | null): Promise<any>;
  clearSkillSchedule(skillId: string): Promise<{ success: boolean } | { error: string }>;
  onSkillsChanged(callback: () => void): void;
  // ── Platform ─────────────────────────────────────────────
  getPlatform(): string;
}

interface Attachment {
  type: 'url' | 'file';
  name: string;
  url: string;
  relativePath?: string;
  mimeType?: string;
}

interface Space {
  id: string;
  description: string;
  body: string | null;
  raw_text: string | null;
  client: string | null;
  due_at: string | null;
  due_at_utc: string | null;
  recurrence: string | null;
  completed_at: string | null;
  folder: string | null;
  session_id: string | null;
  source_skill_id: string | null;
  attachments: Attachment[];
  status: 'captured' | 'in_progress' | 'done';
  created_at: string;
  updated_at: string;
}

declare const whimAPI: WhimAPI;

// ── Canvas window mode detection ────────────────────────
const isCanvasMode = new URLSearchParams(window.location.search).get('mode') === 'canvas';
const isSettingsMode = new URLSearchParams(window.location.search).get('mode') === 'settings';

const descInput = document.getElementById('description-input') as HTMLTextAreaElement;
const form = document.getElementById('capture-form') as HTMLFormElement;
const listEl = document.getElementById('space-list') as HTMLDivElement;
const countEl = document.getElementById('space-count') as HTMLSpanElement;
const statusBar = document.getElementById('status-bar') as HTMLDivElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const settingsOverlay = document.getElementById('settings-overlay') as HTMLDivElement;
const settingsBackdrop = settingsOverlay.querySelector('.settings-backdrop') as HTMLDivElement;
const settingsClose = document.getElementById('settings-close') as HTMLButtonElement;
const mainView = document.getElementById('main-view') as HTMLDivElement;

// ── Update banner ───────────────────────────────────────
import { mountUpdateBanner } from './views/UpdateBanner.tsx';
import { applyTheme, getResolvedTheme, normalizeChoice, type ThemeChoice } from './theme';
import { initFontSetting } from './font-setting';

// ── React migration: stores + IPC bridge + mount for the four main lists ──
// These run alongside the legacy imperative DOM code during the migration.
// The stores are the React source of truth; legacy module vars stay in
// sync via dual-writes at every mutation site (see Phase 6 in MIGRATION.md).
import { spaceStore } from './state/space-store';
import { agentStore } from './state/agent-store';
import { skillStore } from './state/skill-store';
import { historyStore } from './state/history-store';
import { personaStore } from './state/persona-store';
import {
  installIpcBridge,
  loadSpacesSnapshot,
  loadHistorySnapshot,
  loadCanvasArtifactsSnapshot,
  openCanvasArtifact as openCanvasArtifactAndReconcile,
} from './state/ipc-bridge';
import { mountLists } from './views/mount.tsx';
import { bootValue, UNKNOWN_CLI_RUNTIME } from './boot-guard';
import { isWebRemote } from './transport-mode';
import { shouldStartHidden, shouldHideWindow, shouldPopOutCanvas, shouldCloseWindowOnCanvasClose } from './window-chrome';
import type { WhimAPI as PreloadWhimAPI } from '../shared/whim-api';
import type { Skill as SharedSkill, CanvasAgentStateSnapshot, ExportFormat, ExportDestination, SkillInvocationInput, SkillInvocationResult, UpdateState } from '../shared/types';

// The local `interface WhimAPI` declared near the top of this file shadows the
// preload's structural type; the IPC bridge accepts the preload version. Cast
// once via `bridgeApi` to avoid noisy `as unknown as ...` at every call site.
const bridgeApi = whimAPI as unknown as PreloadWhimAPI;

const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const recordingIndicator = document.getElementById('recording-indicator') as HTMLDivElement;
const waveformCanvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
const inputHints = document.getElementById('input-hints') as HTMLDivElement;
const timelineBtn = document.getElementById('timeline-btn') as HTMLButtonElement | null;
const timelineView = document.getElementById('timeline-view') as HTMLDivElement;
const timelineBack = document.getElementById('timeline-back') as HTMLButtonElement;
const timelineContent = document.getElementById('timeline-content') as HTMLDivElement;
const pinBtn = document.getElementById('pin-btn') as HTMLButtonElement;
const remoteBtn = document.getElementById('remote-btn') as HTMLButtonElement;

// ── Welcome view refs ───────────────────────────────────
const welcomeView = document.getElementById('welcome-view') as HTMLDivElement;
const welcomeWorkspaceBtn = document.getElementById('welcome-workspace-btn') as HTMLButtonElement;
const welcomeWorkspaceHint = document.getElementById('welcome-workspace-hint') as HTMLDivElement;
const welcomeWorkspaceCheck = document.getElementById('welcome-workspace-check') as HTMLSpanElement;
const welcomeStepWorkspace = document.getElementById('welcome-step-workspace') as HTMLDivElement;
const welcomeCliStatus = document.getElementById('welcome-cli-status') as HTMLDivElement;
const welcomeCliCheck = document.getElementById('welcome-cli-check') as HTMLSpanElement;
const welcomeStepCli = document.getElementById('welcome-step-cli') as HTMLDivElement;
const welcomeCliPath = document.getElementById('welcome-cli-path') as HTMLInputElement;
const welcomeCliSelect = document.getElementById('welcome-cli-select') as HTMLSelectElement;
const welcomeCliPathRow = document.getElementById('welcome-cli-path-row') as HTMLDivElement;
const welcomeCliRefresh = document.getElementById('welcome-cli-refresh') as HTMLButtonElement;
const welcomeModelSelect = document.getElementById('welcome-model-select') as HTMLSelectElement;
const welcomeModelHint = document.getElementById('welcome-model-hint') as HTMLDivElement;
const WELCOME_MODEL_HINT = 'The AI model used for agents and space processing.';
const welcomeModelCheck = document.getElementById('welcome-model-check') as HTMLSpanElement;
const welcomeStepModel = document.getElementById('welcome-step-model') as HTMLDivElement;
const welcomeStartBtn = document.getElementById('welcome-start-btn') as HTMLButtonElement;

// ── Quick start tour refs ───────────────────────────────
const tourView = document.getElementById('tour-view') as HTMLDivElement;
const tourStepHotkey = document.getElementById('tour-step-hotkey') as HTMLElement;
const tourStepTray = document.getElementById('tour-step-tray') as HTMLElement;
const tourProgress = document.getElementById('tour-progress') as HTMLDivElement;
const tourHotkeyChip = document.getElementById('tour-hotkey-chip') as HTMLButtonElement;
const tourHotkeyReset = document.getElementById('tour-hotkey-reset') as HTMLButtonElement;
const tourHotkeyHint = document.getElementById('tour-hotkey-hint') as HTMLDivElement;
const tourCheckHide = document.getElementById('tour-check-hide') as HTMLLIElement;
const tourCheckShow = document.getElementById('tour-check-show') as HTMLLIElement;
const tourHotkeyNext = document.getElementById('tour-hotkey-next') as HTMLButtonElement;
const tourHotkeySkip = document.getElementById('tour-hotkey-skip') as HTMLButtonElement;
const tourTrayText = document.getElementById('tour-tray-text') as HTMLParagraphElement;
const tourTrayTitle = document.getElementById('tour-step-tray-title') as HTMLHeadingElement;
const tourTrayArrow = document.getElementById('tour-tray-arrow') as HTMLDivElement;
const tourTrayCaption = document.getElementById('tour-tray-caption') as HTMLDivElement;
const tourTrayKeys = document.getElementById('tour-tray-keys') as HTMLSpanElement;
const tourCheckTrayHide = document.getElementById('tour-check-tray-hide') as HTMLLIElement;
const tourCheckTrayClick = document.getElementById('tour-check-tray-click') as HTMLLIElement;
const tourTrayHideFallback = document.getElementById('tour-tray-hide-fallback') as HTMLButtonElement;
const tourTrayNext = document.getElementById('tour-tray-next') as HTMLButtonElement;
const tourTraySkip = document.getElementById('tour-tray-skip') as HTMLButtonElement;
const tourSkipAll = document.getElementById('tour-skip-all') as HTMLButtonElement;

let spaces: Space[] = [];
// Track spaces being processed by LLM
const processingSpaces = new Set<string>();
// Track spaces with active running terminal sessions
let activeSessionSpaces = new Set<string>();
// Track agents per space for Spaces view
let agentsBySpace = new Map<string, Array<{ agentId: string; status: string; summary: string; selectedText: string; quotedText?: string; source?: string }>>();
// Current filter
let currentFilter: 'open' | 'agents' | 'skills' | 'closed' = 'open';
const filterOrder: Array<'open' | 'agents' | 'skills' | 'closed'> = ['open', 'skills', 'agents', 'closed'];
let renderGeneration = 0;
const filterBar = document.getElementById('filter-bar') as HTMLDivElement;
const workspaceTabNameEl = document.getElementById('workspace-tab-name') as HTMLSpanElement | null;
const newAgentBtn = document.getElementById('new-agent-btn') as HTMLButtonElement;
const launchCliBtn = document.getElementById('launch-cli-btn') as HTMLButtonElement;

const agentSummaryEl = document.getElementById('agent-summary') as HTMLDivElement;
const queryResult = document.getElementById('query-result') as HTMLDivElement;
const focusBanner = document.getElementById('focus-banner') as HTMLDivElement;
const focusDesc = document.getElementById('focus-desc') as HTMLDivElement;
const focusMeta = document.getElementById('focus-meta') as HTMLDivElement;
const focusDone = document.getElementById('focus-done') as HTMLButtonElement;
const focusClear = document.getElementById('focus-clear') as HTMLButtonElement;
let focusedSpaceId: string | null = null;
let selectedIndex = -1;
let displayedSpaces: Space[] = [];
let searchResults: Space[] | null = null;
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let searchMode = false;
let activeSearchQuery = '';
const workersBadge = document.getElementById('workers-badge') as HTMLSpanElement;

// ── Git sync bar refs ───────────────────────────────────
const gitSyncBar = document.getElementById('git-sync-bar') as HTMLDivElement;
const gitSyncBranch = document.getElementById('git-sync-branch') as HTMLSpanElement;
const gitSyncStatusEl = document.getElementById('git-sync-status') as HTMLSpanElement;
const gitSyncPullBtn = document.getElementById('git-sync-pull') as HTMLButtonElement;
const gitSyncPushBtn = document.getElementById('git-sync-push') as HTMLButtonElement;
const gitSyncBehindCount = document.getElementById('git-sync-behind-count') as HTMLSpanElement;
const gitSyncAheadCount = document.getElementById('git-sync-ahead-count') as HTMLSpanElement;
const updateBannerRoot = document.getElementById('update-banner-root') as HTMLDivElement | null;
let lastGitSyncAhead = 0;
let lastGitSyncBehind = 0;
let gitSyncInitialized = false;
let gitSyncAvailable = false;
let updateBannerVisible = false;

// ── Platform detection ──────────────────────────────────
// Set platform class on body for platform-adaptive styling
const __platform = (window as any).__platform as string | undefined;
if (__platform) {
  document.body.classList.add(`platform-${__platform}`);
}

// The desktop window paints its own material (macOS vibrancy, Windows Mica) and
// the stylesheet leans on it: `body` and `#app` are transparent so it shows
// through. A browser tab has no material — the page canvas is plain white — so
// dark mode landed as pale text on white. Mark the browser so styles.css can
// paint the surface the window would have.
if (isWebRemote()) {
  document.body.classList.add('web-remote');
}

// ── Window slide animation ──────────────────────────────
const appEl = document.getElementById('app')!;
let windowSide: 'left' | 'right' = 'right';
let windowVisualState: 'hidden' | 'sliding-in' | 'visible' | 'sliding-out' = 'hidden';
let slideTransitionId = 0;

// Start with content off-screen (no transition) so first show() has no flash.
// Desktop only — see window-chrome.ts for why a browser must never do this.
if (shouldStartHidden({ isCanvasMode, isSettingsMode, isWebRemote: isWebRemote() })) {
  appEl.classList.add('app-hidden-right', 'app-no-transition');
}

// The browser has no window lifecycle, so the app is visible from the start
// and `slideOut()` must not mistake it for already-hidden.
if (isWebRemote()) {
  windowVisualState = 'visible';
}

/**
 * Whether a canvas is drawn in this window or handed to a new one.
 *
 * True in the desktop main window, which pops canvases out. False in the
 * popout itself, and false in a browser — which has no second window to open
 * and drops the request to open one. See window-chrome.ts.
 */
const canvasPopsOut = shouldPopOutCanvas({ isCanvasMode, isWebRemote: isWebRemote() });

/** True where a canvas shares the window with the spaces list and must yield it back. */
const canvasIsInline = !canvasPopsOut && !isCanvasMode;

function slideIn(side: 'left' | 'right'): void {
  slideTransitionId++;
  const myId = slideTransitionId;
  windowSide = side;
  windowVisualState = 'sliding-in';

  // Ensure the hidden class matches the desired side (no transition yet)
  appEl.classList.remove('app-hidden-left', 'app-hidden-right');
  appEl.classList.add(side === 'left' ? 'app-hidden-left' : 'app-hidden-right');
  appEl.classList.add('app-no-transition');
  void appEl.offsetHeight; // force reflow

  // Enable transitions, then remove hidden → content slides in
  appEl.classList.remove('app-no-transition');
  void appEl.offsetHeight; // force reflow
  appEl.classList.remove('app-hidden-left', 'app-hidden-right');

  const onEnd = (e: TransitionEvent): void => {
    if (e.target !== appEl || e.propertyName !== 'transform') return;
    if (slideTransitionId !== myId) return;
    appEl.removeEventListener('transitionend', onEnd);
    windowVisualState = 'visible';
  };
  appEl.addEventListener('transitionend', onEnd);

  // Fallback: mark visible after duration even if transitionend doesn't fire
  setTimeout(() => {
    if (slideTransitionId === myId && windowVisualState === 'sliding-in') {
      windowVisualState = 'visible';
    }
  }, 150);
}

function slideOut(callback?: () => void): void {
  // Nothing to slide out of in a browser: the page is the window, and hiding
  // the interface would strand the user at a blank tab with no hotkey to
  // bring it back. Callers still get their callback — dismissing a sub-view
  // and then "hiding" is a no-op here, not a failure.
  if (!shouldHideWindow({ isWebRemote: isWebRemote() })) {
    callback?.();
    return;
  }

  // If already hidden or the window is in canvas/expanded mode, hide immediately
  if (windowVisualState === 'hidden') {
    whimAPI.hideWindow();
    callback?.();
    return;
  }

  slideTransitionId++;
  const myId = slideTransitionId;
  windowVisualState = 'sliding-out';

  // Add hidden class → transition fires, content slides out
  appEl.classList.add(windowSide === 'left' ? 'app-hidden-left' : 'app-hidden-right');

  const finish = (): void => {
    if (slideTransitionId !== myId) return;
    windowVisualState = 'hidden';
    whimAPI.hideWindow();
    callback?.();
  };

  const onEnd = (e: TransitionEvent): void => {
    if (e.target !== appEl || e.propertyName !== 'transform') return;
    if (slideTransitionId !== myId) return;
    appEl.removeEventListener('transitionend', onEnd);
    clearTimeout(fallback);
    finish();
  };
  appEl.addEventListener('transitionend', onEnd);

  // Fallback timer in case transitionend doesn't fire
  const fallback = setTimeout(() => {
    appEl.removeEventListener('transitionend', onEnd);
    finish();
  }, 150);
}

// ── Status bar helpers ──────────────────────────────────
function showStatus(msg: string, isError = false): void {
  statusBar.textContent = msg;
  statusBar.classList.remove('hidden', 'error');
  if (isError) statusBar.classList.add('error');
}

function hideStatus(): void {
  statusBar.classList.add('hidden');
}

// ── Workers badge ───────────────────────────────────────
function updateWorkersBadge(): void {
  const sandboxPending = agentStore.sandboxBlockCount();
  if ((agentApprovals.size > 0 || sandboxPending > 0) && currentFilter !== 'agents') {
    workersBadge.classList.remove('hidden');
  } else {
    workersBadge.classList.add('hidden');
  }
}

// ── Git sync bar ────────────────────────────────────────

function syncGitBarVisibility(): void {
  gitSyncBar.classList.toggle('hidden', !gitSyncAvailable && !updateBannerVisible);
  gitSyncBar.classList.toggle('git-sync-bar--git-unavailable', !gitSyncAvailable);
}

if (updateBannerRoot) {
  mountUpdateBanner(updateBannerRoot, {
    onVisibilityChange: (visible) => {
      updateBannerVisible = visible;
      updateBannerRoot.classList.toggle('hidden', !visible);
      syncGitBarVisibility();
    },
  });
}

function updateGitSyncBar(status: { available: boolean; branch: string | null; ahead: number; behind: number; unavailableReason?: string }): void {
  gitSyncAvailable = status.available;

  if (!status.available) {
    gitSyncBranch.textContent = '';
    gitSyncStatusEl.textContent = '';
    gitSyncPullBtn.classList.add('hidden');
    gitSyncPushBtn.classList.add('hidden');
    syncGitBarVisibility();
    return;
  }

  syncGitBarVisibility();
  gitSyncBranch.textContent = status.branch ? `⎇ ${status.branch}` : '';
  gitSyncBehindCount.textContent = String(status.behind);
  gitSyncAheadCount.textContent = String(status.ahead);

  // Show/hide buttons based on counts
  gitSyncPullBtn.classList.toggle('hidden', status.behind === 0);
  gitSyncPushBtn.classList.toggle('hidden', status.ahead === 0);

  // Status text
  if (status.ahead === 0 && status.behind === 0) {
    gitSyncStatusEl.textContent = '✓ synced';
  } else {
    gitSyncStatusEl.textContent = '';
  }

  // Blink animation when counts change (skip initial load)
  if (gitSyncInitialized && (status.ahead !== lastGitSyncAhead || status.behind !== lastGitSyncBehind)) {
    gitSyncBar.classList.remove('blink');
    // Force reflow to restart animation
    void gitSyncBar.offsetWidth;
    gitSyncBar.classList.add('blink');
    gitSyncBar.addEventListener('animationend', () => {
      gitSyncBar.classList.remove('blink');
    }, { once: true });
  }

  lastGitSyncAhead = status.ahead;
  lastGitSyncBehind = status.behind;
  gitSyncInitialized = true;
}

async function refreshGitSync(): Promise<void> {
  try {
    const status = await whimAPI.gitSyncStatus();
    updateGitSyncBar(status);
  } catch {
    gitSyncAvailable = false;
    syncGitBarVisibility();
  }
}

if (gitSyncPushBtn) {
  gitSyncPushBtn.addEventListener('click', async () => {
    gitSyncPushBtn.classList.add('loading');
    gitSyncPushBtn.textContent = '↑ …';
    try {
      const result = await whimAPI.gitPush();
      if ('error' in result) {
        showStatus(result.error, true);
        setTimeout(hideStatus, 4000);
      } else {
        showStatus('✓ Pushed');
        setTimeout(hideStatus, 2000);
      }
    } catch (err: any) {
      showStatus(`Push failed: ${err.message}`, true);
      setTimeout(hideStatus, 4000);
    } finally {
      gitSyncPushBtn.classList.remove('loading');
      refreshGitSync();
    }
  });
}

if (gitSyncPullBtn) {
  gitSyncPullBtn.addEventListener('click', async () => {
    gitSyncPullBtn.classList.add('loading');
    gitSyncPullBtn.textContent = '↓ …';
    try {
      const result = await whimAPI.gitPull();
      if ('error' in result) {
        if ((result as any).conflict) {
          showStatus('⚠ Branches diverged — launching agent to resolve…', true);
          setTimeout(hideStatus, 4000);
          // Launch a worker to resolve the conflict
          try {
            await whimAPI.quickLaunchAgent(
              'The git workspace has diverging branches that cannot be fast-forwarded. ' +
              'Please resolve the git merge conflict. Run `git pull --no-ff origin` to pull and merge, ' +
              'then resolve any conflicts in the working directory and commit the result.'
            );
          } catch {
            showStatus('Failed to launch conflict resolver', true);
            setTimeout(hideStatus, 4000);
          }
        } else {
          showStatus(result.error, true);
          setTimeout(hideStatus, 4000);
        }
      } else {
        showStatus('✓ Pulled');
        setTimeout(hideStatus, 2000);
        loadSpaces();
      }
    } catch (err: any) {
      showStatus(`Pull failed: ${err.message}`, true);
      setTimeout(hideStatus, 4000);
    } finally {
      gitSyncPullBtn.classList.remove('loading');
      refreshGitSync();
    }
  });
}

// Listen for sync status changes from main process
whimAPI.onGitSyncChanged((status: any) => {
  updateGitSyncBar(status);
});

// Refresh sync on window focus / visibility change
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshGitSync();
});

// ── Filter bar ──────────────────────────────────────────

function getPlaceholderForFilter(filter: typeof currentFilter): string {
  switch (filter) {
    case 'agents': return 'What should an agent work on? (start with @ to pick a persona)';
    case 'skills': return 'Describe a skill to create...';
    default: return 'What needs to get done?';
  }
}

function getSearchPlaceholderForFilter(filter: typeof currentFilter): string {
  switch (filter) {
    case 'agents': return '🔍 Search agents...';
    case 'skills': return '🔍 Search skills...';
    default: return '🔍 Search spaces...';
  }
}


function updatePromptHint(): void {
  // Hint is now shown as placeholder text in the textarea
}

function setFilter(filter: typeof currentFilter): void {
  if (filter === currentFilter) return;
  currentFilter = filter;
  spaceStore.setFilter(filter);
  // History view fetches its events lazily when first activated.
  if (filter === 'closed') {
    void loadHistorySnapshot(bridgeApi);
  }
  filterBar.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  const btn = filterBar.querySelector(`[data-filter="${filter}"]`) as HTMLElement;
  if (btn) {
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
  }

  // Show capture form on Spaces, Workers, and Skills; hide on History
  if (filter === 'closed') {
    form.style.display = 'none';
  } else {
    form.style.display = '';
    descInput.placeholder = getPlaceholderForFilter(filter);
  }

  // Agents tab shows the summary panel; all others hide it
  if (filter === 'agents') {
    agentSummaryEl.classList.remove('hidden');
  } else {
    agentSummaryEl.classList.add('hidden');
  }

  // Old new-agent button is replaced by the prompt box
  newAgentBtn.classList.add('hidden');
  launchCliBtn.classList.add('hidden');

  // Exit search mode when switching tabs
  if (searchMode) {
    exitSearchMode();
  }

  // Close persona @-mention dropdown if open and clear any selection state.
  hideMentionDropdown();
  selectedPersonaHandle = null;
  selectedSkillMentionId = null;

  updatePromptHint();
  updateWorkersBadge();
  render();
}

function visibleFilterOrder(): Array<typeof currentFilter> {
  const fromDom = Array.from(filterBar.querySelectorAll<HTMLElement>('.filter-btn'))
    .map(b => b.dataset.filter as typeof currentFilter)
    .filter(f => filterOrder.includes(f));
  return fromDom.length ? fromDom : filterOrder;
}

function focusActiveFilter(): void {
  const btn = filterBar.querySelector('.filter-btn.active') as HTMLElement;
  if (btn) btn.focus();
}

filterBar.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.filter-btn') as HTMLElement;
  if (!btn) return;
  const filter = btn.dataset.filter as typeof currentFilter;
  if (filter) setFilter(filter);
});

/**
 * Only rows backed by a space are focusable — loose timeline events have no
 * space left to open, so arrow keys skip over them.
 */
const ACTIVITY_ROW_SELECTOR = '.activity-row[tabindex]';

filterBar.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const order = visibleFilterOrder();
    const idx = order.indexOf(currentFilter);
    const next = e.key === 'ArrowRight'
      ? order[(idx + 1) % order.length]
      : order[(idx - 1 + order.length) % order.length];
    setFilter(next);
    focusActiveFilter();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    if (currentFilter === 'closed') {
      // Activity tab: form is hidden, focus first activity row
      const firstCard = listEl.querySelector(ACTIVITY_ROW_SELECTOR) as HTMLElement;
      if (firstCard) firstCard.focus();
    } else {
      descInput.focus();
    }
    return;
  }
});

// ── Activity row keyboard navigation (Activity tab) ─────
listEl.addEventListener('keydown', (e) => {
  const card = (e.target as HTMLElement).closest(ACTIVITY_ROW_SELECTOR) as HTMLElement;
  if (!card || currentFilter !== 'closed') return;
  const cards = Array.from(listEl.querySelectorAll(ACTIVITY_ROW_SELECTOR)) as HTMLElement[];
  const idx = cards.indexOf(card);
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    if (idx <= 0) {
      focusActiveFilter();
    } else {
      cards[idx - 1].focus();
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    if (idx < cards.length - 1) {
      cards[idx + 1].focus();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    card.click();
  }
});

// ── New Agent button ────────────────────────────────────
newAgentBtn.addEventListener('click', () => {
  openAgentChat(undefined as any, '', 'new');
});

newAgentBtn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    focusActiveFilter();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    const items = listEl.querySelectorAll('.agent-card');
    if (items.length > 0) {
      selectedIndex = 0;
      updateAgentSelection();
      newAgentBtn.blur();
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    openAgentChat(undefined as any, '', 'new');
    return;
  }
});

// ── Launch CLI button ───────────────────────────────────
launchCliBtn.addEventListener('click', async () => {
  const result = await whimAPI.launchCliSession();
  if (result && 'error' in result) {
    console.error('[app] CLI launch failed:', result.error);
  } else {
    // Refresh agents list
    if (currentFilter === 'agents') renderAgentsList();
  }
});

// ── Settings modal ──────────────────────────────────────
let settingsModalOpen = false;

function showSettings(): void {
  // Open settings in a separate window
  whimAPI.openSettingsWindow();
}

function hideSettings(): void {
  settingsOverlay.classList.add('hidden');
  settingsModalOpen = false;
  settingsBtn.classList.remove('active');
  descInput.focus();
}

settingsBtn.addEventListener('click', showSettings);
settingsClose.addEventListener('click', hideSettings);
settingsBackdrop.addEventListener('click', hideSettings);

// ── Pin toggle ──────────────────────────────────────────
pinBtn.addEventListener('click', async () => {
  const current = pinBtn.classList.contains('active');
  const next = !current;
  whimAPI.setPinned(next);
  pinBtn.classList.toggle('active', next);
  pinBtn.title = next ? 'Unpin window' : 'Pin window (keep visible)';
  pinBtn.setAttribute('aria-pressed', String(next));
});

whimAPI.onPinnedChanged((pinned: boolean) => {
  pinBtn.classList.toggle('active', pinned);
  pinBtn.title = pinned ? 'Unpin window' : 'Pin window (keep visible)';
  pinBtn.setAttribute('aria-pressed', String(pinned));
});

async function loadPinState(): Promise<void> {
  const pinned = await whimAPI.getPinned();
  pinBtn.classList.toggle('active', pinned);
  pinBtn.title = pinned ? 'Unpin window' : 'Pin window (keep visible)';
}

// ── Remote toggle + QR overlay ──────────────────────────
let appRemoteUrl: string | null = null;
let appRemoteAgentId: string | null = null;
let appRemoteLoading = false;
let appRemoteResetting = false;
let appRemoteHint: string | null = null;
let appRemoteHintTimer: ReturnType<typeof setTimeout> | null = null;
let appRemoteOverlayEl: HTMLDivElement | null = null;

function hideAppRemoteOverlay(): void {
  if (appRemoteOverlayEl) {
    appRemoteOverlayEl.remove();
    appRemoteOverlayEl = null;
  }
}

async function showAppRemoteOverlay(): Promise<void> {
  hideAppRemoteOverlay();

  const overlay = document.createElement('div');
  overlay.className = 'remote-overlay app-remote-overlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';

  const backdrop = document.createElement('div');
  backdrop.className = 'remote-overlay-backdrop';
  backdrop.addEventListener('click', hideAppRemoteOverlay);
  overlay.appendChild(backdrop);

  const panel = document.createElement('div');
  panel.className = 'remote-overlay-panel';

  const header = document.createElement('div');
  header.className = 'remote-overlay-header';
  header.innerHTML = `<span class="remote-overlay-title">📱 Remote Control</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'remote-overlay-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', hideAppRemoteOverlay);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'remote-overlay-body';

  if (appRemoteUrl) {
    const desc = document.createElement('p');
    desc.className = 'remote-overlay-desc';
    desc.textContent = 'Scan the QR code or click the link to control this workspace from another device. Remote is enabled across all spaces.';
    body.appendChild(desc);

    try {
      const QRCode = (await import('qrcode')).default;
      const dataUrl = await QRCode.toDataURL(appRemoteUrl, { width: 200, margin: 2 });
      const qrWrap = document.createElement('div');
      qrWrap.className = 'remote-overlay-qr';
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = 'QR Code for remote session';
      qrWrap.appendChild(img);
      body.appendChild(qrWrap);
    } catch { /* QR generation failed */ }

    const link = document.createElement('a');
    link.className = 'remote-overlay-link';
    link.href = '#';
    link.textContent = appRemoteUrl;
    link.addEventListener('click', (e) => { e.preventDefault(); whimAPI.openExternal(appRemoteUrl!); });
    body.appendChild(link);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'remote-overlay-copy';
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', () => navigator.clipboard.writeText(appRemoteUrl!));
    body.appendChild(copyBtn);
  } else if (appRemoteLoading) {
    const desc = document.createElement('p');
    desc.className = 'remote-overlay-desc';
    desc.textContent = 'Launching workspace agent and enabling remote control…';
    body.appendChild(desc);
  } else {
    const desc = document.createElement('p');
    desc.className = 'remote-overlay-desc';
    desc.textContent = 'Remote control is enabled but no link is available yet. Make sure the workspace is a GitHub repository, then try again.';
    body.appendChild(desc);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'remote-overlay-copy';
    retryBtn.textContent = 'Launch workspace agent';
    retryBtn.addEventListener('click', () => { void bootstrapAppRemote(); });
    body.appendChild(retryBtn);
  }

  if (appRemoteHint) {
    const hint = document.createElement('div');
    hint.className = 'remote-overlay-hint';
    hint.textContent = appRemoteHint;
    body.appendChild(hint);
  }

  const resetBtn = document.createElement('button');
  resetBtn.className = 'remote-overlay-reset';
  resetBtn.title = 'Disable and re-enable remote control to recover from a stuck link';
  resetBtn.disabled = appRemoteResetting || appRemoteLoading;
  resetBtn.textContent = appRemoteResetting ? 'Resetting…' : 'Reset link';
  resetBtn.addEventListener('click', () => { void resetAppRemote(); });
  body.appendChild(resetBtn);

  const disableBtn = document.createElement('button');
  disableBtn.className = 'remote-overlay-disable';
  disableBtn.textContent = 'Disable Remote Control';
  disableBtn.addEventListener('click', async () => {
    await whimAPI.setAppRemote(false);
    hideAppRemoteOverlay();
  });
  body.appendChild(disableBtn);

  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  appRemoteOverlayEl = overlay;
}

/**
 * Bootstrap remote control: launch a workspace agent (if needed) and enable
 * remote on it.  Idempotent — safe to call when remote is already enabled.
 */
async function bootstrapAppRemote(): Promise<void> {
  if (appRemoteLoading) return;
  appRemoteLoading = true;
  // Refresh the overlay so the user sees the loading state.
  if (appRemoteOverlayEl) await showAppRemoteOverlay();
  try {
    const result = await whimAPI.setAppRemote(true);
    console.log('[remote] setAppRemote result:', JSON.stringify(result));
    if ('agents' in result) {
      const urlAgent = result.agents.find((a: { url?: string }) => a.url);
      if (urlAgent?.url) {
        appRemoteUrl = urlAgent.url;
        appRemoteAgentId = urlAgent.agentId;
      }
      // If still no URL, the onAppRemoteChanged or onAgentRemoteChanged
      // events will update appRemoteUrl and we refresh the overlay then.
    } else if ('error' in result) {
      console.error('[remote] setAppRemote error:', result.error);
    }
  } catch (err) {
    console.error('[remote] setAppRemote threw:', err);
  } finally {
    appRemoteLoading = false;
    if (appRemoteOverlayEl) await showAppRemoteOverlay();
  }
}

function showAppRemoteHint(msg: string): void {
  if (appRemoteHintTimer) clearTimeout(appRemoteHintTimer);
  appRemoteHint = msg;
  if (appRemoteOverlayEl) void showAppRemoteOverlay();
  appRemoteHintTimer = setTimeout(() => {
    appRemoteHint = null;
    if (appRemoteOverlayEl) void showAppRemoteOverlay();
  }, 3000);
}

/**
 * Force-reset the app-level remote link.  Targets the supervisor agent
 * (appRemoteAgentId) for an atomic main-process disable+enable.  Falls back
 * to bootstrapAppRemote() if no supervisor is known (e.g. nothing was ever
 * launched, or the supervisor died and was cleared).
 */
async function resetAppRemote(): Promise<void> {
  if (appRemoteResetting || appRemoteLoading) return;

  const targetAgentId = appRemoteAgentId;
  const api = whimAPI as typeof whimAPI & {
    resetAgentRemote?: (agentId: string) => Promise<
      { enabled: boolean; remoteSteerable: boolean; url?: string; changed: boolean } | { error: string }
    >;
  };

  if (!targetAgentId || !api.resetAgentRemote) {
    // Nothing to reset — bootstrap from scratch instead.
    await bootstrapAppRemote();
    return;
  }

  appRemoteResetting = true;
  if (appRemoteOverlayEl) await showAppRemoteOverlay();
  try {
    const result = await api.resetAgentRemote(targetAgentId);
    if ('error' in result) {
      console.error('[remote] reset error:', result.error);
      showAppRemoteHint(result.error);
    } else if (result.url) {
      // The push event will also update appRemoteUrl, but set it now so the
      // overlay refreshes immediately.
      appRemoteUrl = result.url;
      appRemoteAgentId = targetAgentId;
      showAppRemoteHint(result.changed ? 'Generated a new link' : 'Link is unchanged');
    } else {
      showAppRemoteHint('Remote was reset but no link was returned.');
    }
  } catch (err: any) {
    console.error('[remote] reset threw:', err);
    showAppRemoteHint(err?.message || 'Failed to reset remote control');
  } finally {
    appRemoteResetting = false;
    if (appRemoteOverlayEl) await showAppRemoteOverlay();
  }
}

remoteBtn.addEventListener('click', async () => {
  // Always show the overlay immediately so the user gets feedback.
  await showAppRemoteOverlay();
  // If we don't have a URL yet, bootstrap (launches a workspace supervisor
  // if needed and enables remote on it).  The backend coalesces concurrent
  // calls so multiple rapid clicks are safe.
  if (!appRemoteUrl && !appRemoteLoading) {
    await bootstrapAppRemote();
  }
});

whimAPI.onAppRemoteChanged((data: { enabled: boolean; agents: Array<{ agentId: string; url?: string }> }) => {
  remoteBtn.classList.toggle('active', data.enabled);
  const urlAgent = data.enabled ? data.agents.find(a => a.url) : undefined;
  if (data.enabled) {
    if (urlAgent?.url) {
      appRemoteUrl = urlAgent.url;
      appRemoteAgentId = urlAgent.agentId;
    } else {
      // Enabled but no URL yet — clear any stale state so the next click
      // can bootstrap a fresh worker.
      appRemoteUrl = null;
      appRemoteAgentId = null;
    }
    remoteBtn.title = appRemoteUrl
      ? 'Remote control ON — click to view link'
      : 'Remote control ON — click to launch a worker';
    if (appRemoteOverlayEl) showAppRemoteOverlay();
  } else {
    appRemoteUrl = null;
    appRemoteAgentId = null;
    remoteBtn.title = 'Enable remote control';
    hideAppRemoteOverlay();
  }
});

async function loadRemoteState(): Promise<void> {
  try {
    const status = await whimAPI.getAppRemoteStatus();
    if ('enabled' in status) {
      remoteBtn.classList.toggle('active', status.enabled);
      if (status.enabled) {
        const urlAgent = status.agents.find(a => a.url);
        if (urlAgent?.url) {
          appRemoteUrl = urlAgent.url;
          appRemoteAgentId = urlAgent.agentId;
        }
        remoteBtn.title = appRemoteUrl
          ? 'Remote control ON — click to view link'
          : 'Remote control ON — click to launch a worker';
      } else {
        remoteBtn.title = 'Enable remote control';
      }
    }
  } catch { /* not critical */ }
}

modelSelect.addEventListener('change', async () => {
  const model = modelSelect.value;
  if (model) {
    await whimAPI.setSetting('model', model);
    showStatus(`✓ Model set to ${model}`);
    setTimeout(hideStatus, 2000);
  }
});

async function loadModels(): Promise<void> {
  const currentModel = await whimAPI.getSetting('model');
  try {
    const models = await whimAPI.listModels();
    modelSelect.innerHTML = '';

    if (models.length === 0) {
      modelSelect.innerHTML = '<option value="">No models available</option>';
      return;
    }

    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      if (m.id === currentModel) opt.selected = true;
      modelSelect.appendChild(opt);
    }

    // If no saved model, select the first one
    if (!currentModel && models.length > 0) {
      modelSelect.value = models[0].id;
    }
  } catch {
    modelSelect.innerHTML = '<option value="">Failed to load models</option>';
  }
}

async function loadSettings(): Promise<void> {
  await loadThemeSetting();
}

// ── Theme ───────────────────────────────────────────────
void initFontSetting(whimAPI);

// Theme resolve/apply/persist + OS-change handling lives in ./theme.
// app.ts only loads the stored choice and wires the Settings control.

async function loadThemeSetting(): Promise<void> {
  const stored = normalizeChoice(await whimAPI.getSetting('theme'));
  applyTheme(stored);
  syncThemeControl(stored);
}

// ── Theme toggle (Settings → Appearance) ────────────────
const themeToggle = document.getElementById('theme-toggle') as HTMLDivElement | null;
const themeToggleBtns = themeToggle
  ? Array.from(themeToggle.querySelectorAll<HTMLButtonElement>('.theme-btn'))
  : [];

/** Reflect the active choice in the segmented control's button states. */
function syncThemeControl(choice: ThemeChoice): void {
  for (const btn of themeToggleBtns) {
    const active = btn.dataset.theme === choice;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  }
}

for (const btn of themeToggleBtns) {
  btn.addEventListener('click', async () => {
    const choice = normalizeChoice(btn.dataset.theme);
    applyTheme(choice);
    syncThemeControl(choice);
    await whimAPI.setSetting('theme', choice);
    // Broadcast so any open canvas / settings popout windows update live.
    whimAPI.notifyCanvasThemeChanged(choice);
  });
}

async function loadWorkspaceSetting(): Promise<void> {
  const ws = await whimAPI.getSetting('workspace_root');
  updateWorkspaceDisplay(ws);
}

// ── Agent Personas ──────────────────────────────────────
const agentsSelectionList = document.getElementById('agents-selection-list') as HTMLDivElement;
const agentsEditor = document.getElementById('agents-editor') as HTMLDivElement;
const personaAddBtn = document.getElementById('persona-add-btn') as HTMLButtonElement;
let personas: AgentPersona[] = [];
let personaModels: { id: string; name?: string }[] = [];
let selectedAgentId: string | null = null;

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_AGENT_HANDLE = 'agent';
const DEFAULT_AGENT_INSTRUCTIONS = 'Follow the users instructions and respond to comments or create comments when you work on canvas.md documents.';

function ensureDefaultAgent(): void {
  const hasDefault = personas.some(p => p.handle === DEFAULT_AGENT_HANDLE);
  if (!hasDefault) {
    personas.unshift({
      id: 'default-agent',
      handle: DEFAULT_AGENT_HANDLE,
      instructions: DEFAULT_AGENT_INSTRUCTIONS,
      model: '',
      runLocation: 'local',
    });
    // Persist immediately so backend knows about it
    whimAPI.savePersonas(personas);
  }
}

async function loadPersonas(): Promise<void> {
  personas = await whimAPI.listPersonas() || [];
  try { personaModels = await whimAPI.listModels(); } catch { personaModels = []; }
  ensureDefaultAgent();
  personaStore.setPersonas(personas);
  renderAgentsSidebar();
  // Auto-select @agent if nothing selected
  if (!selectedAgentId) {
    const defaultAgent = personas.find(p => p.handle === DEFAULT_AGENT_HANDLE);
    if (defaultAgent) selectAgent(defaultAgent.id);
  } else {
    // Re-render editor for currently selected agent
    const current = personas.find(p => p.id === selectedAgentId);
    if (current) renderAgentEditor(current);
    else {
      selectedAgentId = null;
      renderAgentEditorPlaceholder();
    }
  }
}

function renderAgentsSidebar(): void {
  agentsSelectionList.innerHTML = '';
  // Sort: @agent always first, then alphabetical
  const sorted = [...personas].sort((a, b) => {
    if (a.handle === DEFAULT_AGENT_HANDLE) return -1;
    if (b.handle === DEFAULT_AGENT_HANDLE) return 1;
    return a.handle.localeCompare(b.handle);
  });
  for (const persona of sorted) {
    const item = document.createElement('div');
    item.className = 'agent-list-item' + (persona.id === selectedAgentId ? ' active' : '');
    item.dataset.agentId = persona.id;

    const emoji = document.createElement('span');
    emoji.className = 'agent-list-emoji';
    emoji.textContent = persona.emoji || '🤖';

    const handle = document.createElement('span');
    handle.className = 'agent-list-handle';
    handle.textContent = '@' + persona.handle;

    item.appendChild(emoji);
    item.appendChild(handle);
    item.addEventListener('click', () => selectAgent(persona.id));
    agentsSelectionList.appendChild(item);
  }
}

function selectAgent(agentId: string): void {
  selectedAgentId = agentId;
  // Update active state in list
  agentsSelectionList.querySelectorAll('.agent-list-item').forEach(el => {
    el.classList.toggle('active', (el as HTMLElement).dataset.agentId === agentId);
  });
  const persona = personas.find(p => p.id === agentId);
  if (persona) renderAgentEditor(persona);
}

function renderAgentEditorPlaceholder(): void {
  agentsEditor.innerHTML = '<div class="agents-editor-placeholder">Select an agent to edit its settings.</div>';
}

function renderAgentEditor(persona: AgentPersona): void {
  agentsEditor.innerHTML = '';
  const isDefault = persona.handle === DEFAULT_AGENT_HANDLE;

  const form = document.createElement('div');
  form.className = 'persona-form';
  form.style.border = 'none';
  form.style.padding = '0';
  form.style.background = 'none';

  // Handle input — with emoji picker
  const handleRow = document.createElement('div');
  handleRow.className = 'persona-form-row';
  const emojiBtn = document.createElement('button');
  emojiBtn.type = 'button';
  emojiBtn.className = 'emoji-picker-btn';
  emojiBtn.textContent = persona.emoji || '🤖';
  emojiBtn.title = 'Pick emoji avatar';
  let selectedEmoji = persona.emoji || '';

  const EMOJI_OPTIONS = [
    '😀','😎','🤖','👻','🦊','🐱','🐶','🦁',
    '🧠','💡','🔥','⚡','🚀','🎯','💻','🛡️',
    '🌟','🎨','🔮','🧪','🪄','👾','🤠','🥷',
    '🦄','🐙','🦅','🐝','🌈','❄️','🌊','🍀',
  ];

  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing_popup = document.querySelector('.emoji-picker-popup');
    if (existing_popup) { existing_popup.remove(); return; }

    const popup = document.createElement('div');
    popup.className = 'emoji-picker-popup';
    for (const em of EMOJI_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = em;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedEmoji = em;
        emojiBtn.textContent = em;
        popup.remove();
      });
      popup.appendChild(btn);
    }

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear emoji';
    clearBtn.style.color = '#999';
    clearBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectedEmoji = '';
      emojiBtn.textContent = '🤖';
      popup.remove();
    });
    popup.appendChild(clearBtn);

    emojiBtn.style.position = 'relative';
    emojiBtn.appendChild(popup);

    const closePopup = () => { popup.remove(); document.removeEventListener('click', closePopup); };
    setTimeout(() => document.addEventListener('click', closePopup), 0);
  });

  const handleLabel = document.createElement('label');
  handleLabel.textContent = '@';
  handleLabel.className = 'persona-handle-prefix';
  const handleInput = document.createElement('input');
  handleInput.type = 'text';
  handleInput.className = 'persona-form-input';
  handleInput.placeholder = 'handle';
  handleInput.value = persona.handle;
  handleInput.maxLength = 32;
  if (isDefault) {
    handleInput.readOnly = true;
    handleInput.style.opacity = '0.6';
    handleInput.title = 'The default agent handle cannot be changed';
  }
  handleRow.appendChild(emojiBtn);
  handleRow.appendChild(handleLabel);
  handleRow.appendChild(handleInput);

  // Instructions textarea
  const instrRow = document.createElement('div');
  instrRow.className = 'persona-form-row';
  const instrInput = document.createElement('textarea');
  instrInput.className = 'persona-form-textarea';
  instrInput.placeholder = 'Instructions for this agent...';
  instrInput.value = persona.instructions;
  instrInput.rows = 4;
  instrInput.maxLength = 2000;
  instrRow.appendChild(instrInput);

  // Model dropdown
  const modelRow = document.createElement('div');
  modelRow.className = 'persona-form-row';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Model';
  modelLabel.className = 'persona-form-label';
  const modelSelect = document.createElement('select');
  modelSelect.className = 'persona-form-select';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Default';
  modelSelect.appendChild(defaultOpt);

  for (const m of personaModels) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    if (m.id === persona.model) opt.selected = true;
    modelSelect.appendChild(opt);
  }

  modelRow.appendChild(modelLabel);
  modelRow.appendChild(modelSelect);

  // Run location dropdown
  const locationRow = document.createElement('div');
  locationRow.className = 'persona-form-row';
  const locationLabel = document.createElement('label');
  locationLabel.textContent = 'Run location';
  locationLabel.className = 'persona-form-label';
  const locationSelect = document.createElement('select');
  locationSelect.className = 'persona-form-select';
  const localOpt = document.createElement('option');
  localOpt.value = 'local';
  localOpt.textContent = '💻 Local';
  const cloudOpt = document.createElement('option');
  cloudOpt.value = 'cloud';
  cloudOpt.textContent = '☁️ Cloud';
  const ccaOpt = document.createElement('option');
  ccaOpt.value = 'cca';
  ccaOpt.textContent = '🤖 Copilot Cloud Agent';
  locationSelect.appendChild(localOpt);
  locationSelect.appendChild(cloudOpt);
  locationSelect.appendChild(ccaOpt);
  if (persona.runLocation === 'cca') ccaOpt.selected = true;
  else if (persona.runLocation === 'cloud') cloudOpt.selected = true;
  locationRow.appendChild(locationLabel);
  locationRow.appendChild(locationSelect);

  // Sandbox checkbox (available on all platforms with runtime sandbox support)
  const sandboxRow = document.createElement('div');
  sandboxRow.className = 'persona-form-row persona-sandbox-row';
  if (persona.runLocation !== 'local') {
    sandboxRow.style.display = 'none';
  }
  const sandboxLabel = document.createElement('label');
  sandboxLabel.className = 'persona-form-checkbox-label';
  const sandboxCheck = document.createElement('input');
  sandboxCheck.type = 'checkbox';
  sandboxCheck.checked = persona.sandboxed === true;
  sandboxLabel.appendChild(sandboxCheck);
  sandboxLabel.appendChild(document.createTextNode(' 🔒 Run in sandbox (restrict writes & dangerous commands)'));
  sandboxRow.appendChild(sandboxLabel);

  const sandboxInfoNote = document.createElement('div');
  sandboxInfoNote.className = 'persona-sandbox-info';
  sandboxInfoNote.textContent = 'ℹ The agent\'s working directory is always included in read/write paths.';
  sandboxInfoNote.style.display = sandboxCheck.checked ? '' : 'none';
  sandboxRow.appendChild(sandboxInfoNote);

  locationSelect.addEventListener('change', () => {
    if (locationSelect.value !== 'local') {
      sandboxRow.style.display = 'none';
      sandboxCheck.checked = false;
      sandboxOverrideRow.style.display = 'none';
    } else {
      sandboxRow.style.display = '';
      updateSandboxOverrideVisibility();
    }
  });

  // Sandbox override
  const sandboxOverrideRow = document.createElement('div');
  sandboxOverrideRow.className = 'persona-form-row persona-sandbox-override-row';
  sandboxOverrideRow.style.display = 'none';
  sandboxOverrideRow.style.flexDirection = 'column';
  sandboxOverrideRow.style.gap = '6px';

  const inheritLabel = document.createElement('label');
  inheritLabel.className = 'persona-form-checkbox-label';
  const inheritCheck = document.createElement('input');
  inheritCheck.type = 'checkbox';
  // For @agent, there's no "inherit" — it IS the default
  if (isDefault) {
    inheritCheck.checked = false;
    inheritLabel.style.display = 'none';
  } else {
    inheritCheck.checked = persona.sandboxPolicyOverride == null;
  }
  inheritLabel.appendChild(inheritCheck);
  inheritLabel.appendChild(document.createTextNode(' Inherit sandbox policy from @agent'));
  sandboxOverrideRow.appendChild(inheritLabel);

  const overrideContainer = document.createElement('div');
  overrideContainer.className = 'sandbox-policy-form';
  overrideContainer.style.display = (isDefault || !inheritCheck.checked) ? '' : 'none';
  sandboxOverrideRow.appendChild(overrideContainer);

  let personaPolicyApi: { getPolicy: () => SandboxPolicy; setPolicy: (p: SandboxPolicy) => void } | null = null;

  async function ensurePolicyForm(): Promise<void> {
    if (personaPolicyApi) return;
    let initial: SandboxPolicy;
    if (isDefault) {
      // @agent reads/writes the global default sandbox policy
      try {
        initial = await whimAPI.getSandboxDefaultPolicy() ?? DEFAULT_SANDBOX_POLICY;
      } catch {
        initial = DEFAULT_SANDBOX_POLICY;
      }
    } else if (persona.sandboxPolicyOverride) {
      initial = persona.sandboxPolicyOverride;
    } else {
      try {
        initial = await whimAPI.getSandboxDefaultPolicy() ?? DEFAULT_SANDBOX_POLICY;
      } catch {
        initial = DEFAULT_SANDBOX_POLICY;
      }
    }
    personaPolicyApi = renderSandboxPolicyForm(overrideContainer, initial, { idPrefix: `persona-${persona.id}` });
  }

  inheritCheck.addEventListener('change', async () => {
    if (inheritCheck.checked) {
      overrideContainer.style.display = 'none';
    } else {
      await ensurePolicyForm();
      overrideContainer.style.display = '';
    }
  });

  function updateSandboxOverrideVisibility(): void {
    const show = sandboxCheck.checked && locationSelect.value === 'local';
    sandboxInfoNote.style.display = show ? '' : 'none';
    if (show) {
      sandboxOverrideRow.style.display = '';
      if (isDefault || !inheritCheck.checked) ensurePolicyForm();
    } else {
      sandboxOverrideRow.style.display = 'none';
    }
  }
  sandboxCheck.addEventListener('change', updateSandboxOverrideVisibility);
  if (sandboxCheck.checked) updateSandboxOverrideVisibility();

  // CLI Runtime dropdown
  const runtimeRow = document.createElement('div');
  runtimeRow.className = 'persona-form-row';
  const runtimeLabel = document.createElement('label');
  runtimeLabel.textContent = 'CLI Runtime';
  runtimeLabel.className = 'persona-form-label';
  const runtimeSelect = document.createElement('select');
  runtimeSelect.className = 'persona-form-select';
  const defaultRtOpt = document.createElement('option');
  defaultRtOpt.value = '';
  defaultRtOpt.textContent = 'Default';
  runtimeSelect.appendChild(defaultRtOpt);
  whimAPI.listRuntimes().then(runtimes => {
    for (const rt of runtimes) {
      const opt = document.createElement('option');
      opt.value = rt.id;
      opt.textContent = rt.label;
      if (rt.id === persona.cliRuntime) opt.selected = true;
      runtimeSelect.appendChild(opt);
    }
  });
  runtimeRow.appendChild(runtimeLabel);
  runtimeRow.appendChild(runtimeSelect);

  // Yolo mode checkbox
  const yoloRow = document.createElement('div');
  yoloRow.className = 'persona-form-row persona-yolo-row';
  const yoloLabel = document.createElement('label');
  yoloLabel.className = 'persona-form-checkbox-label';
  const yoloCheck = document.createElement('input');
  yoloCheck.type = 'checkbox';
  yoloCheck.checked = persona.yolo === true;
  yoloLabel.appendChild(yoloCheck);
  yoloLabel.appendChild(document.createTextNode(' 🔥 Auto-enable yolo mode (skip all permission prompts)'));
  yoloRow.appendChild(yoloLabel);

  // Ephemeral mode checkbox
  const ephemeralRow = document.createElement('div');
  ephemeralRow.className = 'persona-form-row persona-ephemeral-row';
  if (persona.runLocation === 'cca') {
    ephemeralRow.style.display = 'none';
  }
  const ephemeralLabel = document.createElement('label');
  ephemeralLabel.className = 'persona-form-checkbox-label';
  const ephemeralCheck = document.createElement('input');
  ephemeralCheck.type = 'checkbox';
  ephemeralCheck.checked = persona.ephemeral === true;
  ephemeralLabel.appendChild(ephemeralCheck);
  ephemeralLabel.appendChild(document.createTextNode(' 🕵️ Ephemeral mode (no session history — nothing persisted to disk or DB)'));
  ephemeralRow.appendChild(ephemeralLabel);

  // Hide ephemeral option for CCA personas
  locationSelect.addEventListener('change', () => {
    if (locationSelect.value === 'cca') {
      ephemeralRow.style.display = 'none';
      ephemeralCheck.checked = false;
    } else {
      ephemeralRow.style.display = '';
    }
  });

  // Error display
  const errorEl = document.createElement('div');
  errorEl.className = 'persona-form-error hidden';

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'persona-form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'persona-form-save';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const rawHandle = isDefault ? DEFAULT_AGENT_HANDLE : handleInput.value.trim().replace(/^@/, '').toLowerCase();
    const instructions = instrInput.value.trim();
    const model = modelSelect.value;
    const runLocation = locationSelect.value as 'local' | 'cca' | 'cloud';
    const sandboxed = sandboxCheck.checked && runLocation === 'local';
    const emoji = selectedEmoji;
    const cliRuntime = runtimeSelect.value;

    // For @agent, save sandbox policy to global default as well.
    // ensurePolicyForm() is materialized lazily (and its callers don't await
    // it), so read through it here — otherwise a quick check-then-save would
    // see personaPolicyApi === null and silently drop the policy.
    let sandboxOverride: SandboxPolicy | undefined;
    if (sandboxed) {
      if (isDefault) {
        await ensurePolicyForm();
        if (personaPolicyApi) {
          await whimAPI.saveSandboxDefaultPolicy(personaPolicyApi.getPolicy());
        }
        sandboxOverride = undefined; // @agent uses the global default
      } else if (!inheritCheck.checked) {
        await ensurePolicyForm();
        // Fall back to the persona's stored override rather than wiping it
        // if the form still couldn't be built.
        sandboxOverride = personaPolicyApi
          ? personaPolicyApi.getPolicy()
          : persona.sandboxPolicyOverride;
      }
    } else if (!isDefault) {
      // Sandboxing is off — main drops sandboxPolicyOverride in that case,
      // so leave it undefined here to stay in sync with what's persisted.
      sandboxOverride = undefined;
    }

    if (!isDefault && !HANDLE_RE.test(rawHandle)) {
      errorEl.textContent = 'Handle must be 1-32 lowercase letters, numbers, or dashes.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!instructions) {
      errorEl.textContent = 'Instructions are required.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!isDefault) {
      const duplicate = personas.find(p => p.handle === rawHandle && p.id !== persona.id);
      if (duplicate) {
        errorEl.textContent = `Handle @${rawHandle} is already taken.`;
        errorEl.classList.remove('hidden');
        return;
      }
    }

    personas = personas.map(p => p.id === persona.id
      ? {
          ...p,
          handle: rawHandle,
          instructions,
          model,
          runLocation,
          emoji: emoji || undefined,
          cliRuntime: cliRuntime || undefined,
          ...(sandboxed ? { sandboxed: true } : { sandboxed: undefined }),
          ...(sandboxOverride ? { sandboxPolicyOverride: sandboxOverride } : { sandboxPolicyOverride: undefined }),
          ...(yoloCheck.checked ? { yolo: true } : { yolo: undefined }),
          ...(ephemeralCheck.checked && (runLocation === 'local' || runLocation === 'cloud') ? { ephemeral: true } : { ephemeral: undefined }),
        }
      : p
    );

    const result = await whimAPI.savePersonas(personas);
    if (result && 'error' in result) {
      errorEl.textContent = result.error;
      errorEl.className = 'persona-form-error';
      errorEl.classList.remove('hidden');
      return;
    }
    // Adopt the persisted list. Main-side validation normalizes fields and
    // silently drops incomplete entries (e.g. an untouched "+ Add" draft), so
    // keeping the optimistic array would leave ghost rows in the sidebar.
    personas = await whimAPI.listPersonas() || [];
    personaStore.setPersonas(personas);
    renderAgentsSidebar();
    // Show animated save confirmation
    errorEl.textContent = '✓ Saved';
    errorEl.className = 'persona-form-error persona-save-toast';
    errorEl.classList.remove('hidden');
    setTimeout(() => { errorEl.classList.add('hidden'); errorEl.className = 'persona-form-error hidden'; }, 2000);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'persona-form-cancel';
  deleteBtn.textContent = 'Delete';
  deleteBtn.style.color = '#b91414';
  if (isDefault) {
    deleteBtn.style.display = 'none';
  }
  deleteBtn.addEventListener('click', async () => {
    if (isDefault) return;
    personas = personas.filter(p => p.id !== persona.id);
    await whimAPI.savePersonas(personas);
    personas = await whimAPI.listPersonas() || [];
    personaStore.setPersonas(personas);
    selectedAgentId = null;
    renderAgentsSidebar();
    // Select @agent after deletion
    const defaultAgent = personas.find(p => p.handle === DEFAULT_AGENT_HANDLE);
    if (defaultAgent) selectAgent(defaultAgent.id);
    else renderAgentEditorPlaceholder();
  });

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(deleteBtn);

  // "Open config preview" — materializes the persona's current sandbox
  // policy to a config.json file under userData/sandbox-config/preview/ and
  // opens it in the OS default text editor. Lets the user verify exactly
  // which config the runtime will load at agent launch (companion to the
  // [sandbox] launch-time logs in main).
  const previewBtn = document.createElement('button');
  previewBtn.className = 'persona-form-cancel';
  previewBtn.type = 'button';
  previewBtn.textContent = 'Open config preview';
  previewBtn.title = 'Materialize the runtime config.json for this policy and open it in your default text editor.';
  previewBtn.style.marginLeft = 'auto';
  previewBtn.addEventListener('click', async () => {
    if (!sandboxCheck.checked) {
      errorEl.textContent = 'Enable "Run in sandbox" to preview the config.';
      errorEl.classList.remove('hidden');
      return;
    }
    // Materialize the policy form lazily — covers both inherit-from-default
    // and explicit-override cases. Either way personaPolicyApi.getPolicy()
    // returns the values that would be saved on click.
    await ensurePolicyForm();
    if (!personaPolicyApi) {
      errorEl.textContent = 'Could not load sandbox policy form.';
      errorEl.classList.remove('hidden');
      return;
    }
    const policy = personaPolicyApi.getPolicy();
    const result = await whimAPI.openSandboxConfigPreview(policy);
    if (result?.ok) {
      errorEl.textContent = `Opened ${result.path}`;
      errorEl.style.color = '#2d8a3a';
      errorEl.classList.remove('hidden');
      setTimeout(() => { errorEl.classList.add('hidden'); errorEl.style.color = ''; }, 2500);
    } else {
      errorEl.textContent = result?.error || 'Failed to open config preview';
      errorEl.classList.remove('hidden');
    }
  });
  // Hide the preview button when sandbox is off (or the platform doesn't
  // support sandboxing at all) — there's nothing meaningful to materialize.
  const updatePreviewVisibility = () => {
    previewBtn.style.display = sandboxCheck.checked ? '' : 'none';
  };
  updatePreviewVisibility();
  sandboxCheck.addEventListener('change', updatePreviewVisibility);
  btnRow.appendChild(previewBtn);

  form.appendChild(handleRow);
  form.appendChild(instrRow);
  form.appendChild(modelRow);
  form.appendChild(locationRow);
  form.appendChild(sandboxRow);
  form.appendChild(sandboxOverrideRow);
  form.appendChild(runtimeRow);
  form.appendChild(yoloRow);
  form.appendChild(ephemeralRow);
  form.appendChild(errorEl);
  form.appendChild(btnRow);

  agentsEditor.appendChild(form);
}

personaAddBtn.addEventListener('click', () => {
  const newId = crypto.randomUUID();
  const newPersona: AgentPersona = {
    id: newId,
    handle: '',
    instructions: '',
    model: '',
    runLocation: 'local',
  };
  personas.push(newPersona);
  personaStore.setPersonas(personas);
  renderAgentsSidebar();
  selectAgent(newId);
});

// ── CLI Runtimes ────────────────────────────────────────
const runtimesList = document.getElementById('runtimes-list') as HTMLDivElement;
const runtimeAddBtn = document.getElementById('runtime-add-btn') as HTMLButtonElement;
let cliRuntimes: CliRuntime[] = [];

async function loadRuntimes(): Promise<void> {
  cliRuntimes = await whimAPI.listRuntimes() || [];
  renderRuntimes();
}

function renderRuntimes(): void {
  const openForm = runtimesList.querySelector('.persona-form');
  runtimesList.innerHTML = '';
  for (const rt of cliRuntimes) {
    runtimesList.appendChild(createRuntimeCard(rt));
  }
  if (openForm) runtimesList.appendChild(openForm);
}

function createRuntimeCard(rt: CliRuntime): HTMLElement {
  const card = document.createElement('div');
  card.className = 'persona-card';

  const info = document.createElement('div');
  info.className = 'persona-card-info';

  const label = document.createElement('div');
  label.className = 'persona-card-handle';
  label.textContent = rt.label;

  const pathEl = document.createElement('div');
  pathEl.className = 'persona-card-instructions';
  pathEl.textContent = rt.path;

  info.appendChild(label);
  info.appendChild(pathEl);

  const actions = document.createElement('div');
  actions.className = 'persona-card-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'persona-action-btn';
  editBtn.textContent = '✎';
  editBtn.title = 'Edit';
  editBtn.addEventListener('click', () => showRuntimeForm(rt));

  const delBtn = document.createElement('button');
  delBtn.className = 'persona-action-btn danger';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', async () => {
    cliRuntimes = cliRuntimes.filter(r => r.id !== rt.id);
    await whimAPI.saveRuntimes(cliRuntimes);
    renderRuntimes();
  });

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  card.appendChild(info);
  card.appendChild(actions);
  return card;
}

function showRuntimeForm(existing?: CliRuntime): void {
  const prev = runtimesList.querySelector('.persona-form');
  if (prev) prev.remove();

  const form = document.createElement('div');
  form.className = 'persona-form';

  const labelRow = document.createElement('div');
  labelRow.className = 'persona-form-row';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'persona-form-input';
  labelInput.placeholder = 'Label (e.g. Copilot Dev)';
  labelInput.value = existing?.label || '';
  labelInput.maxLength = 50;
  labelRow.appendChild(labelInput);

  const pathRow = document.createElement('div');
  pathRow.className = 'persona-form-row';
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'persona-form-input';
  pathInput.placeholder = 'Path or command (e.g. copilot-dev)';
  pathInput.value = existing?.path || '';
  pathInput.spellcheck = false;
  pathRow.appendChild(pathInput);

  const errorEl = document.createElement('div');
  errorEl.className = 'persona-form-error hidden';

  const btnRow = document.createElement('div');
  btnRow.className = 'persona-form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'persona-form-save';
  saveBtn.textContent = existing ? 'Save' : 'Add';
  saveBtn.addEventListener('click', async () => {
    const label = labelInput.value.trim();
    const rPath = pathInput.value.trim();
    if (!label) {
      errorEl.textContent = 'Label is required.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!rPath) {
      errorEl.textContent = 'Path is required.';
      errorEl.classList.remove('hidden');
      return;
    }

    if (existing) {
      cliRuntimes = cliRuntimes.map(r => r.id === existing.id ? { ...r, label, path: rPath } : r);
    } else {
      cliRuntimes.push({ id: crypto.randomUUID(), label, path: rPath });
    }

    const result = await whimAPI.saveRuntimes(cliRuntimes);
    // Update local state with resolved paths from the backend
    if (result && result.runtimes) {
      cliRuntimes = result.runtimes;
    }
    form.remove();
    renderRuntimes();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'persona-form-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => form.remove());

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);

  form.appendChild(labelRow);
  form.appendChild(pathRow);
  form.appendChild(errorEl);
  form.appendChild(btnRow);

  runtimesList.appendChild(form);
  labelInput.focus();
}

runtimeAddBtn.addEventListener('click', () => showRuntimeForm());

// ── Export Destinations ─────────────────────────────────
const exportDestinationsList = document.getElementById('export-destinations-list') as HTMLDivElement;
const exportDestAddBtn = document.getElementById('export-dest-add-btn') as HTMLButtonElement;
let exportDestinations: ExportDestination[] = [];

const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = { pdf: 'PDF', docx: 'Word', md: 'Markdown' };

async function loadExportDestinations(): Promise<void> {
  exportDestinations = await whimAPI.listExportDestinations() || [];
  renderExportDestinations();
}

function renderExportDestinations(): void {
  const openForm = exportDestinationsList.querySelector('.persona-form');
  exportDestinationsList.innerHTML = '';
  for (const dest of exportDestinations) {
    exportDestinationsList.appendChild(createExportDestCard(dest));
  }
  if (openForm) exportDestinationsList.appendChild(openForm);
}

function createExportDestCard(dest: ExportDestination): HTMLElement {
  const card = document.createElement('div');
  card.className = 'persona-card';

  const info = document.createElement('div');
  info.className = 'persona-card-info';

  const label = document.createElement('div');
  label.className = 'persona-card-handle';
  label.textContent = `${dest.label} · ${EXPORT_FORMAT_LABELS[dest.defaultFormat]}`;

  const pathEl = document.createElement('div');
  pathEl.className = 'persona-card-instructions';
  pathEl.textContent = dest.path;

  info.appendChild(label);
  info.appendChild(pathEl);

  const actions = document.createElement('div');
  actions.className = 'persona-card-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'persona-action-btn';
  editBtn.textContent = '✎';
  editBtn.title = 'Edit';
  editBtn.addEventListener('click', () => showExportDestForm(dest));

  const delBtn = document.createElement('button');
  delBtn.className = 'persona-action-btn danger';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', async () => {
    exportDestinations = exportDestinations.filter(d => d.id !== dest.id);
    await whimAPI.saveExportDestinations(exportDestinations);
    renderExportDestinations();
  });

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  card.appendChild(info);
  card.appendChild(actions);
  return card;
}

function showExportDestForm(existing?: ExportDestination): void {
  const prev = exportDestinationsList.querySelector('.persona-form');
  if (prev) prev.remove();

  const form = document.createElement('div');
  form.className = 'persona-form';

  const labelRow = document.createElement('div');
  labelRow.className = 'persona-form-row';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'persona-form-input';
  labelInput.placeholder = 'Label (e.g. Work SharePoint)';
  labelInput.value = existing?.label || '';
  labelInput.maxLength = 50;
  labelRow.appendChild(labelInput);

  const pathRow = document.createElement('div');
  pathRow.className = 'persona-form-row export-dest-path-row';
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'persona-form-input';
  pathInput.placeholder = 'Folder path (e.g. ~/OneDrive/Shared)';
  pathInput.value = existing?.path || '';
  pathInput.spellcheck = false;
  const browseBtn = document.createElement('button');
  browseBtn.className = 'workspace-btn';
  browseBtn.type = 'button';
  browseBtn.textContent = 'Browse…';
  browseBtn.addEventListener('click', async () => {
    const result = await whimAPI.selectFolder({ title: 'Select export destination folder' });
    if ('path' in result) pathInput.value = result.path;
  });
  pathRow.appendChild(pathInput);
  pathRow.appendChild(browseBtn);

  const formatRow = document.createElement('div');
  formatRow.className = 'persona-form-row';
  const formatSelect = document.createElement('select');
  formatSelect.className = 'persona-form-input';
  for (const fmt of ['pdf', 'docx', 'md'] as ExportFormat[]) {
    const opt = document.createElement('option');
    opt.value = fmt;
    opt.textContent = `Default format: ${EXPORT_FORMAT_LABELS[fmt]}`;
    if ((existing?.defaultFormat || 'pdf') === fmt) opt.selected = true;
    formatSelect.appendChild(opt);
  }
  formatRow.appendChild(formatSelect);

  const errorEl = document.createElement('div');
  errorEl.className = 'persona-form-error hidden';

  const btnRow = document.createElement('div');
  btnRow.className = 'persona-form-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'persona-form-save';
  saveBtn.textContent = existing ? 'Save' : 'Add';
  saveBtn.addEventListener('click', async () => {
    const label = labelInput.value.trim();
    const destPath = pathInput.value.trim();
    const defaultFormat = formatSelect.value as ExportFormat;
    if (!label) {
      errorEl.textContent = 'Label is required.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!destPath) {
      errorEl.textContent = 'Folder path is required.';
      errorEl.classList.remove('hidden');
      return;
    }

    if (existing) {
      exportDestinations = exportDestinations.map(d =>
        d.id === existing.id ? { ...d, label, path: destPath, defaultFormat } : d);
    } else {
      exportDestinations.push({ id: crypto.randomUUID(), label, path: destPath, defaultFormat });
    }

    const result = await whimAPI.saveExportDestinations(exportDestinations);
    if ('destinations' in result) exportDestinations = result.destinations;
    form.remove();
    renderExportDestinations();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'persona-form-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => form.remove());

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);

  form.appendChild(labelRow);
  form.appendChild(pathRow);
  form.appendChild(formatRow);
  form.appendChild(errorEl);
  form.appendChild(btnRow);

  exportDestinationsList.appendChild(form);
  labelInput.focus();
}

exportDestAddBtn?.addEventListener('click', () => showExportDestForm());

// ── MCP Servers ─────────────────────────────────────────
const mcpDiscoveredList = document.getElementById('mcp-discovered-list') as HTMLDivElement;
const mcpCustomList = document.getElementById('mcp-custom-list') as HTMLDivElement;
const mcpAddBtn = document.getElementById('mcp-add-btn') as HTMLButtonElement;
let customMcpServers: CustomMcpServer[] = [];

async function loadMcpServers(): Promise<void> {
  // Load discovered MCPs
  try {
    const discovered: DiscoveredMcpServer[] = await whimAPI.listDiscoveredMcp();
    mcpDiscoveredList.innerHTML = '';
    for (const s of discovered) {
      mcpDiscoveredList.appendChild(createMcpCard(s, true));
    }
  } catch { mcpDiscoveredList.innerHTML = ''; }

  // Load custom MCPs
  try {
    customMcpServers = await whimAPI.listCustomMcp() || [];
    renderCustomMcpServers();
  } catch { customMcpServers = []; }
}

function renderCustomMcpServers(): void {
  mcpCustomList.innerHTML = '';
  for (const s of customMcpServers) {
    mcpCustomList.appendChild(createMcpCard(s, false));
  }
}

function createMcpCard(server: DiscoveredMcpServer | CustomMcpServer, isDiscovered: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mcp-card';

  const info = document.createElement('div');
  info.className = 'mcp-card-info';

  const name = document.createElement('div');
  name.className = 'mcp-card-name';
  name.textContent = (server as any).name;

  const meta = document.createElement('div');
  meta.className = 'mcp-card-meta';
  const type = (server as any).type || 'stdio';
  const detail = type === 'http' || type === 'sse'
    ? ((server as any).url || '')
    : ((server as any).command || '');
  meta.textContent = `${type}${detail ? ' · ' + detail : ''}`;

  if (isDiscovered) {
    const source = document.createElement('span');
    source.className = 'mcp-card-source';
    source.textContent = (server as DiscoveredMcpServer).source === 'plugin' ? ' (plugin)' : ' (config)';
    meta.appendChild(source);
  }

  info.appendChild(name);
  info.appendChild(meta);
  card.appendChild(info);

  if (!isDiscovered) {
    const delBtn = document.createElement('button');
    delBtn.className = 'persona-action-btn danger';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', async () => {
      customMcpServers = customMcpServers.filter(s => s.name !== (server as CustomMcpServer).name);
      await whimAPI.saveCustomMcp(customMcpServers);
      customMcpServers = await whimAPI.listCustomMcp() || [];
      renderCustomMcpServers();
    });
    card.appendChild(delBtn);
  }

  return card;
}

function showMcpForm(): void {
  // The form is rendered with class `persona-form` — matching on `.mcp-form`
  // here never hit, so repeated "+ Add" clicks stacked duplicate forms.
  const prev = mcpCustomList.querySelector('.persona-form');
  if (prev) prev.remove();

  const form = document.createElement('div');
  form.className = 'persona-form';

  // Name
  const nameRow = document.createElement('div');
  nameRow.className = 'persona-form-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'persona-form-input';
  nameInput.placeholder = 'Server name';
  nameRow.appendChild(nameInput);

  // Type select
  const typeRow = document.createElement('div');
  typeRow.className = 'persona-form-row';
  const typeLabel = document.createElement('label');
  typeLabel.className = 'persona-form-label';
  typeLabel.textContent = 'Type';
  const typeSelect = document.createElement('select');
  typeSelect.className = 'persona-form-select';
  for (const t of ['stdio', 'http', 'sse']) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    typeSelect.appendChild(opt);
  }
  typeRow.appendChild(typeLabel);
  typeRow.appendChild(typeSelect);

  // Command (for stdio)
  const cmdRow = document.createElement('div');
  cmdRow.className = 'persona-form-row';
  const cmdInput = document.createElement('input');
  cmdInput.type = 'text';
  cmdInput.className = 'persona-form-input';
  cmdInput.placeholder = 'Command (e.g., npx -y @modelcontextprotocol/server-github)';
  cmdRow.appendChild(cmdInput);

  // URL (for http/sse)
  const urlRow = document.createElement('div');
  urlRow.className = 'persona-form-row hidden';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'persona-form-input';
  urlInput.placeholder = 'URL (e.g., http://localhost:3000/mcp)';
  urlRow.appendChild(urlInput);

  typeSelect.addEventListener('change', () => {
    const isRemote = typeSelect.value === 'http' || typeSelect.value === 'sse';
    cmdRow.classList.toggle('hidden', isRemote);
    urlRow.classList.toggle('hidden', !isRemote);
  });

  // Error
  const errorEl = document.createElement('div');
  errorEl.className = 'persona-form-error hidden';

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'persona-form-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'persona-form-save';
  saveBtn.textContent = 'Add';
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const type = typeSelect.value as 'stdio' | 'http' | 'sse';
    const command = cmdInput.value.trim();
    const url = urlInput.value.trim();

    if (!name) {
      errorEl.textContent = 'Name is required.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (customMcpServers.some(s => s.name === name)) {
      errorEl.textContent = 'A server with this name already exists.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (type === 'stdio' && !command) {
      errorEl.textContent = 'Command is required for stdio servers.';
      errorEl.classList.remove('hidden');
      return;
    }
    if ((type === 'http' || type === 'sse') && !url) {
      errorEl.textContent = 'URL is required for remote servers.';
      errorEl.classList.remove('hidden');
      return;
    }

    const entry: CustomMcpServer = {
      name,
      type,
      tools: ['*'],
      ...(type === 'stdio' ? { command, args: [] } : { url }),
    };

    customMcpServers.push(entry);
    const result = await whimAPI.saveCustomMcp(customMcpServers);
    if (result && 'error' in result) {
      customMcpServers = customMcpServers.filter(s => s !== entry);
      errorEl.textContent = result.error;
      errorEl.classList.remove('hidden');
      return;
    }
    // Adopt the persisted list — main-side validation may normalize or drop
    // entries, and keeping the optimistic copy would show rows that aren't
    // actually saved.
    customMcpServers = await whimAPI.listCustomMcp() || [];
    renderCustomMcpServers();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'persona-form-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => form.remove());

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);

  form.appendChild(nameRow);
  form.appendChild(typeRow);
  form.appendChild(cmdRow);
  form.appendChild(urlRow);
  form.appendChild(errorEl);
  form.appendChild(btnRow);

  mcpCustomList.appendChild(form);
  nameInput.focus();
}

mcpAddBtn.addEventListener('click', showMcpForm);

// ── CLI Tools ───────────────────────────────────────────
const cliToolsList = document.getElementById('cli-tools-list') as HTMLDivElement;
const cliToolAddBtn = document.getElementById('cli-tool-add-btn') as HTMLButtonElement;
let cliTools: CliToolDefinition[] = [];

async function loadCliTools(): Promise<void> {
  try {
    cliTools = await whimAPI.listCliTools() || [];
    renderCliTools();
  } catch { cliTools = []; }
}

function renderCliTools(): void {
  cliToolsList.innerHTML = '';
  for (const tool of cliTools) {
    cliToolsList.appendChild(createCliToolCard(tool));
  }
}

function createCliToolCard(tool: CliToolDefinition): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mcp-card';

  const info = document.createElement('div');
  info.className = 'mcp-card-info';

  const name = document.createElement('div');
  name.className = 'mcp-card-name';
  name.textContent = tool.name;

  const desc = document.createElement('div');
  desc.className = 'mcp-card-meta';
  desc.textContent = tool.description;

  info.appendChild(name);
  info.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'persona-card-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'persona-action-btn';
  editBtn.textContent = '✎';
  editBtn.title = 'Edit';
  editBtn.addEventListener('click', () => showCliToolForm(tool));

  const delBtn = document.createElement('button');
  delBtn.className = 'persona-action-btn danger';
  delBtn.textContent = '✕';
  delBtn.title = 'Remove';
  delBtn.addEventListener('click', async () => {
    cliTools = cliTools.filter(t => t.name !== tool.name);
    await whimAPI.saveCliTools(cliTools);
    cliTools = await whimAPI.listCliTools() || [];
    renderCliTools();
  });

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  card.appendChild(info);
  card.appendChild(actions);
  return card;
}

function showCliToolForm(existing?: CliToolDefinition): void {
  const prev = cliToolsList.querySelector('.persona-form');
  if (prev) prev.remove();

  const form = document.createElement('div');
  form.className = 'persona-form';

  const nameRow = document.createElement('div');
  nameRow.className = 'persona-form-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'persona-form-input';
  nameInput.placeholder = 'Command name (e.g., gh)';
  nameInput.value = existing?.name || '';
  nameRow.appendChild(nameInput);

  const descRow = document.createElement('div');
  descRow.className = 'persona-form-row';
  const descInput = document.createElement('textarea');
  descInput.className = 'persona-form-textarea';
  descInput.placeholder = 'Description (e.g., Used for GitHub operations including git, issues, pull requests, actions)';
  descInput.value = existing?.description || '';
  descInput.rows = 2;
  descInput.maxLength = 500;
  descRow.appendChild(descInput);

  const errorEl = document.createElement('div');
  errorEl.className = 'persona-form-error hidden';

  const btnRow = document.createElement('div');
  btnRow.className = 'persona-form-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'persona-form-save';
  saveBtn.textContent = existing ? 'Save' : 'Add';
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const description = descInput.value.trim();

    if (!name) {
      errorEl.textContent = 'Command name is required.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!description) {
      errorEl.textContent = 'Description is required.';
      errorEl.classList.remove('hidden');
      return;
    }
    const duplicate = cliTools.find(t => t.name === name && t.name !== (existing?.name || ''));
    if (duplicate) {
      errorEl.textContent = `Tool "${name}" already exists.`;
      errorEl.classList.remove('hidden');
      return;
    }

    if (existing) {
      cliTools = cliTools.map(t => t.name === existing.name ? { name, description } : t);
    } else {
      cliTools = [...cliTools, { name, description }];
    }

    const result = await whimAPI.saveCliTools(cliTools);
    if (result && 'error' in result) {
      errorEl.textContent = result.error;
      errorEl.classList.remove('hidden');
    }
    cliTools = await whimAPI.listCliTools() || [];
    renderCliTools();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'persona-form-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => form.remove());

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);

  form.appendChild(nameRow);
  form.appendChild(descRow);
  form.appendChild(errorEl);
  form.appendChild(btnRow);

  if (existing) {
    const cards = cliToolsList.querySelectorAll('.mcp-card');
    const idx = cliTools.findIndex(t => t.name === existing.name);
    if (cards[idx]) {
      cards[idx].after(form);
    } else {
      cliToolsList.appendChild(form);
    }
  } else {
    cliToolsList.appendChild(form);
  }

  nameInput.focus();
}

cliToolAddBtn.addEventListener('click', () => showCliToolForm());

// ── Voice Input (spacebar-triggered) ────────────────────
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let isRecording = false;
let isStartingRecording = false;
let audioStream: MediaStream | null = null;

// Waveform visualizer state
let analyserCtx: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let animFrameId: number | null = null;

function startWaveform(stream: MediaStream): void {
  analyserCtx = new AudioContext();
  const source = analyserCtx.createMediaStreamSource(stream);
  analyserNode = analyserCtx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.7;
  source.connect(analyserNode);

  // Size canvas to match textarea dimensions
  const rect = descInput.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  waveformCanvas.width = rect.width * dpr;
  waveformCanvas.height = rect.height * dpr;
  waveformCanvas.style.height = `${rect.height}px`;

  const ctx = waveformCanvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const bufLen = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufLen);

  // Use ~40 bars centered in the canvas
  const barCount = 40;
  const barGap = 2;
  const totalBarWidth = w * 0.7;
  const barWidth = (totalBarWidth - barGap * (barCount - 1)) / barCount;
  const startX = (w - totalBarWidth) / 2;
  const isDark = document.body.classList.contains('dark');

  function draw(): void {
    analyserNode!.getByteFrequencyData(dataArray);
    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < barCount; i++) {
      // Map bar index to frequency bin (skip very low frequencies)
      const binIndex = Math.floor((i + 2) * (bufLen * 0.6) / barCount);
      const val = dataArray[Math.min(binIndex, bufLen - 1)] / 255;
      const minBar = 3;
      const barH = Math.max(minBar, val * (h * 0.75));
      const x = startX + i * (barWidth + barGap);
      const y = (h - barH) / 2;

      const alpha = 0.4 + val * 0.6;
      ctx.fillStyle = isDark
        ? `rgba(248, 113, 113, ${alpha})`
        : `rgba(239, 68, 68, ${alpha})`;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barH, barWidth / 2);
      ctx.fill();
    }

    animFrameId = requestAnimationFrame(draw);
  }

  animFrameId = requestAnimationFrame(draw);
}

function stopWaveform(): void {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (analyserCtx) {
    analyserCtx.close().catch(() => {});
    analyserCtx = null;
    analyserNode = null;
  }
}

async function startRecording(): Promise<void> {
  if (isStartingRecording) return;
  isStartingRecording = true;
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stopWaveform();
      audioStream?.getTracks().forEach(t => t.stop());
      audioStream = null;

      if (audioChunks.length === 0) {
        showStatus('No audio captured', true);
        setInputState('idle');
        return;
      }

      setInputState('transcribing');
      showStatus('✨ Transcribing...');

      try {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const float32 = await blobToFloat32(blob);
        const text = await whimAPI.transcribe(Array.from(float32));

        if (text) {
          descInput.value = text;
          showStatus('✓ Voice captured — press Enter to save');
          setTimeout(hideStatus, 3000);
        } else {
          showStatus('No speech detected', true);
        }
      } catch (err) {
        console.error('Transcription failed:', err);
        showStatus('Transcription failed', true);
      } finally {
        setInputState('idle');
      }
    };

    isRecording = true;
    descInput.value = '';
    startWaveform(audioStream);
    setInputState('recording');
    showStatus('🎤 Listening... press space to stop');
    mediaRecorder.start();
  } catch (err: any) {
    console.error('Microphone error:', err);
    stopWaveform();
    audioStream?.getTracks().forEach(t => t.stop());
    audioStream = null;
    setInputState('idle');
    if (err.name === 'NotAllowedError') {
      showStatus('Microphone access denied', true);
    } else {
      showStatus(`Mic error: ${err.message}`, true);
    }
  } finally {
    isStartingRecording = false;
  }
}

function stopRecording(): void {
  isRecording = false;
  stopWaveform();
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

function setInputState(state: 'idle' | 'recording' | 'transcribing'): void {
  descInput.classList.remove('recording', 'transcribing');
  recordingIndicator.classList.add('hidden');
  const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement | null;

  switch (state) {
    case 'recording':
      descInput.classList.add('hidden');
      waveformCanvas.classList.remove('hidden');
      descInput.placeholder = 'Listening... press space to stop';
      inputHints.classList.add('hidden');
      if (submitBtn) submitBtn.style.display = 'none';
      break;
    case 'transcribing':
      waveformCanvas.classList.add('hidden');
      descInput.classList.remove('hidden');
      descInput.classList.add('transcribing');
      descInput.placeholder = 'Transcribing...';
      inputHints.classList.add('hidden');
      if (submitBtn) submitBtn.style.display = 'none';
      break;
    default:
      waveformCanvas.classList.add('hidden');
      descInput.classList.remove('hidden');
      descInput.placeholder = searchMode ? getSearchPlaceholderForFilter(currentFilter) : getPlaceholderForFilter(currentFilter);
      inputHints.classList.toggle('hidden', searchMode || descInput.value.length > 0);
      if (submitBtn) submitBtn.style.display = '';
  }
}

async function blobToFloat32(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  audioCtx.close();
  return channelData;
}

// Auto-resize textarea
function autoResize(): void {
  descInput.style.height = 'auto';
  const maxHeight = 120; // ~5 lines
  descInput.style.height = Math.min(descInput.scrollHeight, maxHeight) + 'px';
  descInput.style.overflowY = descInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

descInput.addEventListener('input', autoResize);

// Show/hide input hints based on whether textarea has content
descInput.addEventListener('input', () => {
  inputHints.classList.toggle('hidden', descInput.value.length > 0);
});

// ── Prompt @-mention autocomplete ────────────────────────
// When the prompt starts with @<token>, show a dropdown of matching personas
// and skills. Agent mentions launch workers; skill mentions create runnable
// canvases.
type PromptMentionCandidate =
  | { kind: 'agent'; handle: string; emoji?: string; instructions?: string }
  | { kind: 'skill'; handle: string; skillId: string; name: string; emoji?: string; description?: string };

const mentionDropdown = document.getElementById('persona-mention-dropdown') as HTMLDivElement;
let mentionMatches: PromptMentionCandidate[] = [];
let mentionSelectedIndex = 0;
// Persona handle the user has explicitly selected (via dropdown or by typing
// a complete valid handle).  Cleared if the user edits the leading mention
// away.  Used at submit time as the source of truth, with raw-text parsing
// as a fallback for hand-typed handles.
let selectedPersonaHandle: string | null = null;
let selectedSkillMentionId: string | null = null;
let mentionComposing = false;

descInput.addEventListener('compositionstart', () => { mentionComposing = true; });
descInput.addEventListener('compositionend', () => {
  mentionComposing = false;
  refreshMentionDropdown();
});

function isMentionEnabled(): boolean {
  return currentFilter !== 'closed' && !searchMode;
}

/** Parse a leading "@token" from the raw value if present (no whitespace consumed). */
function parseLeadingMentionToken(value: string): { token: string; afterIndex: number } | null {
  if (!value.startsWith('@')) return null;
  // Match leading @<chars-without-whitespace>
  const m = value.match(/^@(\S*)/);
  if (!m) return null;
  return { token: m[1], afterIndex: m[0].length };
}

/** Find the persona whose handle exactly matches the given token (case-insensitive). */
function findExactPersona(token: string): AgentPersona | null {
  const lower = token.toLowerCase();
  return personas.find(p => p.handle.toLowerCase() === lower) || null;
}

function normalizeMentionText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Find the skill whose slug or normalized name exactly matches the token. */
function findExactSkillMention(token: string): SkillData | null {
  const lower = normalizeMentionText(token);
  if (!lower) return null;
  return cachedSkills.find((skill) => (
    skill.id.toLowerCase() === lower
    || normalizeMentionText(skill.name) === lower
  )) || null;
}

function buildMentionCandidates(token: string): PromptMentionCandidate[] {
  const lower = token.toLowerCase();
  const normalized = normalizeMentionText(token);
  const agentMatches: PromptMentionCandidate[] = personas
    .filter(p => p.handle.toLowerCase().startsWith(lower))
    .map(p => ({ kind: 'agent' as const, handle: p.handle, emoji: p.emoji, instructions: p.instructions }));
  const skillMatches: PromptMentionCandidate[] = cachedSkills
    .filter((skill) => {
      if (!token) return true;
      return skill.id.toLowerCase().startsWith(normalized)
        || normalizeMentionText(skill.name).startsWith(normalized)
        || skill.name.toLowerCase().includes(lower)
        || skill.description.toLowerCase().includes(lower);
    })
    .map(skill => ({
      kind: 'skill' as const,
      handle: skill.id,
      skillId: skill.id,
      name: skill.name,
      emoji: skill.emoji,
      description: skill.description,
    }));
  return [...agentMatches, ...skillMatches].slice(0, 10);
}

function refreshMentionDropdown(): void {
  if (mentionComposing) return;
  if (!isMentionEnabled()) {
    hideMentionDropdown();
    return;
  }

  const value = descInput.value;
  const parsed = parseLeadingMentionToken(value);
  if (!parsed) {
    hideMentionDropdown();
    selectedPersonaHandle = null;
    selectedSkillMentionId = null;
    return;
  }

  // If user has typed past the @token (i.e. value contains whitespace after the token),
  // dropdown is closed.  Persona-handle state is locked-in based on what was selected/typed.
  const afterToken = value.slice(parsed.afterIndex);
  if (/^\s/.test(afterToken)) {
    hideMentionDropdown();
    // Only keep selected mention state if the locked-in handle matches exactly.
    const exact = findExactPersona(parsed.token);
    const exactSkill = findExactSkillMention(parsed.token);
    selectedPersonaHandle = exact ? exact.handle : null;
    selectedSkillMentionId = exactSkill && !exact ? exactSkill.id : null;
    return;
  }

  // Kick off a silent reload so personas saved in the settings popout window
  // become available without restarting the main window.  The current render
  // uses the cached `personas` array; the reload re-runs this function.
  void maybeRefreshPersonas();

  void maybeRefreshSkills();

  // Empty token matches all personas and skills.
  const matches = buildMentionCandidates(parsed.token);

  // Pre-set selected mention state if exact match is typed.
  const exact = findExactPersona(parsed.token);
  const exactSkill = findExactSkillMention(parsed.token);
  selectedPersonaHandle = exact ? exact.handle : null;
  selectedSkillMentionId = exactSkill && !exact ? exactSkill.id : null;

  if (matches.length === 0) {
    hideMentionDropdown();
    return;
  }

  mentionMatches = matches;
  // Keep selection within bounds.
  if (mentionSelectedIndex < 0 || mentionSelectedIndex >= matches.length) {
    mentionSelectedIndex = 0;
  }
  renderMentionDropdown();
}

// Throttle background persona reloads so we don't hammer the IPC on every keystroke.
let mentionPersonasReloadAt = 0;
let mentionPersonasReloadInflight = false;
async function maybeRefreshPersonas(): Promise<void> {
  if (mentionPersonasReloadInflight) return;
  const now = Date.now();
  if (now - mentionPersonasReloadAt < 1500) return;
  mentionPersonasReloadAt = now;
  mentionPersonasReloadInflight = true;
  try {
    const fresh = await whimAPI.listPersonas() || [];
    const changed = fresh.length !== personas.length
      || fresh.some((p, i) => p.handle !== personas[i]?.handle);
    if (changed) {
      personas = fresh;
      personaStore.setPersonas(personas);
      // Re-render only if the dropdown is open or if the input still starts with @
      if (descInput.value.startsWith('@')) refreshMentionDropdown();
    }
  } catch { /* leave cached personas in place */ }
  finally {
    mentionPersonasReloadInflight = false;
  }
}

let mentionSkillsReloadAt = 0;
let mentionSkillsReloadInflight = false;
async function maybeRefreshSkills(): Promise<void> {
  if (mentionSkillsReloadInflight) return;
  const now = Date.now();
  if (now - mentionSkillsReloadAt < 1500) return;
  mentionSkillsReloadAt = now;
  mentionSkillsReloadInflight = true;
  try {
    const fresh = await whimAPI.listSkills();
    const changed = fresh.length !== cachedSkills.length
      || fresh.some((skill, i) => skill.id !== cachedSkills[i]?.id || skill.updated_at !== cachedSkills[i]?.updated_at);
    if (changed) {
      cachedSkills = fresh;
      skillStore.setSkills(cachedSkills as unknown as SharedSkill[]);
      if (descInput.value.startsWith('@')) refreshMentionDropdown();
    }
  } catch { /* leave cached skills in place */ }
  finally {
    mentionSkillsReloadInflight = false;
  }
}

function renderMentionDropdown(): void {
  mentionDropdown.innerHTML = '';
  for (let i = 0; i < mentionMatches.length; i++) {
    const p = mentionMatches[i];
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `mention-item mention-item-${p.kind}${i === mentionSelectedIndex ? ' selected' : ''}`;
    item.setAttribute('role', 'option');
    item.dataset.handle = p.handle;
    item.dataset.kind = p.kind;

    const handleEl = document.createElement('span');
    handleEl.className = 'mention-item-handle';
    const label = p.kind === 'skill' ? p.name : `@${p.handle}`;
    handleEl.textContent = (p.emoji ? p.emoji + ' ' : '') + label;
    item.appendChild(handleEl);

    const description = p.kind === 'agent' ? p.instructions : p.description;
    if (description) {
      const instrEl = document.createElement('span');
      instrEl.className = 'mention-item-instructions';
      const firstLine = description.split('\n')[0];
      instrEl.textContent = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
      item.appendChild(instrEl);
    }

    item.addEventListener('mousedown', (e) => {
      // mousedown to fire before blur/input loses focus
      e.preventDefault();
      acceptMentionAt(i);
    });
    mentionDropdown.appendChild(item);
  }
  mentionDropdown.classList.remove('hidden');
}

function hideMentionDropdown(): void {
  mentionDropdown.classList.add('hidden');
  mentionMatches = [];
  mentionSelectedIndex = 0;
}

function isMentionDropdownOpen(): boolean {
  return !mentionDropdown.classList.contains('hidden');
}

/** Replace the leading @token with the selected mention token + trailing space. */
function acceptMentionAt(index: number): void {
  const mention = mentionMatches[index];
  if (!mention) return;
  const value = descInput.value;
  const parsed = parseLeadingMentionToken(value);
  if (!parsed) return;
  const rest = value.slice(parsed.afterIndex);
  const completion = rest.length > 0 && /^\s/.test(rest) ? '' : ' ';
  descInput.value = `@${mention.handle}${completion}${rest}`;
  // Place caret right after the trailing space.
  const caret = ('@' + mention.handle).length + completion.length;
  descInput.setSelectionRange(caret, caret);
  selectedPersonaHandle = mention.kind === 'agent' ? mention.handle : null;
  selectedSkillMentionId = mention.kind === 'skill' ? mention.skillId : null;
  hideMentionDropdown();
  autoResize();
  inputHints.classList.toggle('hidden', descInput.value.length > 0);
}

// Refresh dropdown on input changes.
descInput.addEventListener('input', refreshMentionDropdown);

// Hide dropdown when filter changes (e.g. user switches tabs).
window.addEventListener('blur', () => hideMentionDropdown());
descInput.addEventListener('blur', () => {
  // Delay so click on dropdown items can register.
  setTimeout(() => hideMentionDropdown(), 100);
});

// Live search: filter list when in search mode (supports all tabs)
descInput.addEventListener('input', () => {
  if (searchTimeout) clearTimeout(searchTimeout);

  if (!searchMode) {
    if (searchResults !== null) {
      searchResults = null;
      spaceStore.setSearchResults(null);
      selectedIndex = -1;
      render();
    }
    return;
  }

  const query = descInput.value.trim();
  activeSearchQuery = query;
  spaceStore.setActiveSearchQuery(query);

  if (!query) {
    searchResults = null;
    spaceStore.setSearchResults(null);
    selectedIndex = -1;
    if (currentFilter === 'agents') renderAgentsList();
    else if (currentFilter === 'skills') renderSkillsList();
    else render();
    return;
  }

  searchTimeout = setTimeout(async () => {
    if (currentFilter === 'agents') {
      renderAgentsList(query);
    } else if (currentFilter === 'skills') {
      renderSkillsList(query);
    } else {
      searchResults = await whimAPI.searchSpaces(query);
      spaceStore.setSearchResults(searchResults);
      selectedIndex = -1;
      render();
    }
  }, 150);
});

function enterSearchMode(): void {
  searchMode = true;
  spaceStore.setSearchMode(true);
  descInput.classList.add('search-mode');
  descInput.placeholder = getSearchPlaceholderForFilter(currentFilter);
  descInput.value = '';
  descInput.style.height = 'auto';
  searchResults = null;
  spaceStore.setSearchResults(null);
  activeSearchQuery = '';
  spaceStore.setActiveSearchQuery('');
  selectedIndex = -1;
  inputHints.classList.add('hidden');
  updatePromptHint();
  render();
  descInput.focus();
}

function exitSearchMode(): void {
  searchMode = false;
  spaceStore.setSearchMode(false);
  descInput.classList.remove('search-mode');
  descInput.placeholder = getPlaceholderForFilter(currentFilter);
  descInput.value = '';
  descInput.style.height = 'auto';
  searchResults = null;
  spaceStore.setSearchResults(null);
  activeSearchQuery = '';
  spaceStore.setActiveSearchQuery('');
  selectedIndex = -1;
  inputHints.classList.remove('hidden');
  updatePromptHint();
  render();
  descInput.focus();
}

// Spacebar handling on the textarea
//
// Persona @-mention dropdown takes precedence: arrow/enter/tab/escape are
// captured when the dropdown is open so they don't fall through to the
// existing nav/submit/voice logic below.
descInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (!isMentionDropdownOpen()) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopImmediatePropagation();
    mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionMatches.length;
    renderMentionDropdown();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopImmediatePropagation();
    mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionMatches.length) % mentionMatches.length;
    renderMentionDropdown();
    return;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    e.stopImmediatePropagation();
    acceptMentionAt(mentionSelectedIndex);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    hideMentionDropdown();
    return;
  }
  // Space: close dropdown but let the space character through naturally.
  if (e.key === ' ') {
    hideMentionDropdown();
    return;
  }
});

descInput.addEventListener('keydown', (e) => {
  // Toggle search mode on Spaces, Workers, and Skills tabs
  if (matchesHotkey(e, 'toggleSearch')) {
    if (currentFilter === 'closed') return; // no search on History tab
    e.preventDefault();
    if (searchMode) exitSearchMode();
    else enterSearchMode();
    return;
  }

  // Up arrow: go to filter bar (tabs are above the prompt now)
  if (matchesHotkey(e, 'navigateUp')) {
    e.preventDefault();
    e.stopPropagation();
    focusActiveFilter();
    return;
  }

  // Down arrow: go to list items below
  if (matchesHotkey(e, 'navigateDown')) {
    e.preventDefault();
    e.stopPropagation();
    if (currentFilter === 'agents') {
      const items = listEl.querySelectorAll('.agent-card');
      if (items.length > 0) {
        selectedIndex = 0;
        updateAgentSelection();
        descInput.blur();
      }
    } else if (currentFilter === 'skills') {
      const items = listEl.querySelectorAll('.skill-card');
      if (items.length > 0) {
        (items[0] as HTMLElement).focus();
        descInput.blur();
      }
    } else if (displayedSpaces.length > 0) {
      selectedIndex = 0;
      updateSelection();
      descInput.blur();
    }
    return;
  }

  // In search mode, Enter selects the first result instead of creating
  if (e.key === 'Enter' && !e.shiftKey && searchMode) {
    e.preventDefault();
    if (currentFilter === 'agents' && renderedAgents.length > 0) {
      openAgentChat(renderedAgents[0].agentId, renderedAgents[0].selectedText, renderedAgents[0].status, (renderedAgents[0] as any).source, renderedAgents[0].spaceId);
    } else if (currentFilter === 'skills' && cachedSkills.length > 0) {
      const q = activeSearchQuery.toLowerCase();
      const match = q ? cachedSkills.find(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : cachedSkills[0];
      if (match) openSkillEditor(match.id);
    } else if (displayedSpaces.length > 0) {
      openCanvas(displayedSpaces[0].id);
    }
    return;
  }

  // Enter submits by default; Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    const text = descInput.value.trim();
    if (currentFilter === 'open' && !text) {
      createAndOpenCanvas();
    } else {
      form.requestSubmit();
    }
    return;
  }

  if (e.key === ' ' && !e.repeat) {
    if (isRecording) {
      e.preventDefault();
      stopRecording();
      return;
    }
    if (descInput.value === '') {
      e.preventDefault();
      startRecording();
      return;
    }
  }
});

// ── Text refinement animation ───────────────────────────
function animateTextReplace(el: HTMLElement, oldText: string, newText: string, duration = 600): Promise<void> {
  return new Promise(resolve => {
    const startTime = performance.now();
    const maxLen = Math.max(oldText.length, newText.length);

    function step(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const revealedCount = Math.floor(eased * newText.length);

      let html = '';
      for (let i = 0; i < newText.length; i++) {
        if (i < revealedCount) {
          // Already placed — check if it just appeared (within last few chars of the wave)
          const justRevealed = i >= revealedCount - 3;
          if (justRevealed) {
            html += `<span class="letter-glow">${newText[i] === ' ' ? '&nbsp;' : escapeHtmlChar(newText[i])}</span>`;
          } else {
            html += newText[i] === ' ' ? ' ' : escapeHtmlChar(newText[i]);
          }
        } else {
          // Not yet revealed — show old char or nothing
          if (i < oldText.length) {
            html += `<span class="letter-fading">${oldText[i] === ' ' ? '&nbsp;' : escapeHtmlChar(oldText[i])}</span>`;
          }
        }
      }

      el.innerHTML = html;

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = newText;
        el.classList.add('refined');
        setTimeout(() => el.classList.remove('refined'), 600);
        resolve();
      }
    }

    requestAnimationFrame(step);
  });
}

function escapeHtmlChar(ch: string): string {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  if (ch === '"') return '&quot;';
  return ch;
}

async function animateRefinement(spaceId: string): Promise<void> {
  const oldIntent = spaces.find(i => i.id === spaceId);
  const oldText = oldIntent?.description || '';

  const updatedSpaces = await whimAPI.list();
  const newSpace = updatedSpaces.find(i => i.id === spaceId);

  if (!newSpace || oldText === newSpace.description) {
    spaces = updatedSpaces;
    render();
    return;
  }

  const itemEl = listEl.querySelector(`[data-id="${spaceId}"]`);
  const descEl = itemEl?.querySelector('.whim-desc') as HTMLElement | null;

  if (!descEl) {
    spaces = updatedSpaces;
    render();
    return;
  }

  itemEl?.classList.remove('processing');
  const badge = itemEl?.querySelector('.processing-badge');
  if (badge) badge.remove();

  await animateTextReplace(descEl, oldText, newSpace.description);

  // Fade in new meta
  const metaEl = itemEl?.querySelector('.whim-meta') as HTMLElement | null;
  if (metaEl) {
    const dueInfo = formatDueDate(newSpace.due_at_utc, newSpace.due_at);
    const hasDue = dueInfo.text !== '';
    const isRecurring = !!newSpace.recurrence;
    let metaHtml = '';
    if (newSpace.client) metaHtml += `<span class="meta-fade-in">👤 ${escapeHtml(newSpace.client)}</span>`;
    if (hasDue) metaHtml += `<span class="meta-fade-in due-badge ${dueInfo.overdue ? 'overdue' : ''}">📅 ${escapeHtml(dueInfo.text)}</span>`;
    if (isRecurring) metaHtml += `<span class="meta-fade-in recurring-badge">↻</span>`;
    metaHtml += `<span>${timeAgo(newSpace.updated_at)}</span>`;
    metaEl.innerHTML = metaHtml;
  }

  spaces = updatedSpaces;
}

// ── Space CRUD ─────────────────────────────────────────
let loadSpacesRequestId = 0;

/**
 * Optimistically add a freshly-created space to the store so its row renders
 * immediately, without the full three-call loadSpaces() reload. Background AI
 * refinement (space:processed → animateRefinement) reconciles the row in place.
 */
function insertSpaceOptimistically(space: Space): void {
  spaceStore.upsertSpace(space);
  spaces = [...spaceStore.getState().spaces];
  updateFocusBanner();
}

async function loadSpaces(): Promise<void> {
  const requestId = ++loadSpacesRequestId;

  // Atomic snapshot via the React migration's IPC bridge: fetches list +
  // getActiveSessions + listAllAgents in parallel and applies them to the
  // stores atomically (per-store stale-fetch guards drop late results).
  await loadSpacesSnapshot(bridgeApi);

  // Mirror store state into the legacy module vars so cross-file readers
  // (capture form, settings, canvas, chat) continue to work during the
  // migration. Phase 7 collapses these away.
  if (requestId !== loadSpacesRequestId) return;
  spaces = [...spaceStore.getState().spaces];
  activeSessionSpaces = new Set(agentStore.getState().activeSessionSpaces);
  agentsBySpace = agentStore.getAgentsBySpace();

  updateFocusBanner();
}

// ── Debounced refresh for agent status events ──────────
// Coalesces rapid-fire agent status/completion IPC events into a single
// sidebar re-render, preventing the full innerHTML replacement from running
// on every individual event (which causes visible flicker).
let _agentRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let _agentListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const AGENT_REFRESH_DELAY_MS = 300;

function scheduleAgentSpacesRefresh(): void {
  if (_agentRefreshTimer) clearTimeout(_agentRefreshTimer);
  _agentRefreshTimer = setTimeout(() => {
    _agentRefreshTimer = null;
    if (currentFilter === 'open') loadSpaces();
  }, AGENT_REFRESH_DELAY_MS);
}

function scheduleAgentListRefresh(): void {
  if (_agentListRefreshTimer) clearTimeout(_agentListRefreshTimer);
  _agentListRefreshTimer = setTimeout(() => {
    _agentListRefreshTimer = null;
    if (currentFilter === 'agents') renderAgentsList();
  }, AGENT_REFRESH_DELAY_MS);
}

function render(): void {
  let displayList: Space[];

  if (searchResults !== null) {
    // Search mode on Spaces — show search results directly
    displayList = searchResults;
  } else if (currentFilter === 'agents') {
    // Agents mode — render agent list (with search filter if active)
    renderAgentsList(searchMode ? activeSearchQuery || undefined : undefined);
    return;
  } else if (currentFilter === 'skills') {
    // Skills mode — render skills list (with search filter if active)
    renderSkillsList(searchMode ? activeSearchQuery || undefined : undefined);
    return;
  } else if (currentFilter === 'closed') {
    // History mode — render card-based combined view
    renderHistoryView();
    return;
  } else {
    // Normal mode — open spaces
    displayList = spaces.filter(i => i.status !== 'done');
  }
  displayedSpaces = displayList;

  countEl.textContent = String(spaces.filter(i => i.status !== 'done').length);

  // DOM rendering is now owned by React (mounted on #space-list by the
  // views/mount.tsx module). The store mutations earlier in this call chain
  // (or in loadSpaces()) cause the React tree to re-render. Keep
  // displayedSpaces and countEl in sync for the legacy keyboard nav and the
  // filter-bar badge.
  if (selectedIndex >= displayedSpaces.length) {
    selectedIndex = -1;
  }
  updateSelection();
}

async function renderHistoryView(): Promise<void> {
  const gen = ++renderGeneration;
  displayedSpaces = [];
  countEl.textContent = String(spaces.filter(i => i.status !== 'done').length);

  // React owns the History view DOM (HistoryView component reads spaces from
  // spaceStore and events from historyStore). We still fetch events here so
  // the store is populated for the React tree.
  try {
    const events = await whimAPI.listEvents(200);
    if (gen !== renderGeneration) return;
    historyStore.setEvents(events);
  } catch {
    /* leave existing events in place */
  }
}

function renderAgentSummary(_agents: Array<{ status: string; createdAt?: string }>): void {
  // React owns the agent summary card (rendered by AgentSummary component
  // from spaceStore + agentStore). Legacy callers are no-ops during the
  // migration.
}

// ── Agent step & approval tracking ────────────────────────
interface AgentStep {
  toolCallId: string;
  label: string;
  status: 'running' | 'done' | 'failed';
}
const agentSteps = new Map<string, AgentStep[]>();
const agentApprovals = new Map<string, { requestId: string; permissionKind: string; intention?: string; path?: string }>();
const agentYoloState = new Map<string, boolean>();
const agentRemoteState = new Map<string, { enabled: boolean; url?: string }>();
const agentChatUnsubs = new Map<string, () => void>();

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

function humanizeToolName(toolName: string, args?: Record<string, any>): string {
  const fileName = args?.path ? basename(args.path) : '';

  if (toolName === 'report_intent' && args?.intent) {
    return String(args.intent).slice(0, 80);
  }
  if (toolName === 'bash' && args?.command) {
    const cmd = String(args.command);
    return cmd.length > 80 ? cmd.slice(0, 77) + '…' : cmd;
  }
  if (toolName === 'edit' && fileName) return `Editing ${fileName}`;
  if (toolName === 'create' && fileName) return `Creating ${fileName}`;
  if (toolName === 'view' && fileName) return `Reading ${fileName}`;

  const map: Record<string, string> = {
    bash: 'Running command',
    edit: 'Editing file',
    create: 'Creating file',
    view: 'Reading file',
    grep: 'Searching code',
    glob: 'Finding files',
    web_fetch: 'Fetching web page',
    web_search: 'Searching the web',
    sql: 'Running query',
  };
  return map[toolName] || toolName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function subscribeAgentChat(agentId: string): void {
  if (agentChatUnsubs.has(agentId)) return;
  const unsub = whimAPI.onChatEvent(agentId, (event: any) => {
    if (event.type === 'tool.start') {
      const steps = agentSteps.get(agentId) || [];
      const step = {
        toolCallId: event.toolCallId,
        label: humanizeToolName(event.toolName || 'Working', event.args),
        status: 'running' as const,
      };
      steps.push(step);
      agentSteps.set(agentId, steps);
      agentStore.addStep(agentId, step);
      updateAgentCardSteps(agentId);
    } else if (event.type === 'tool.progress') {
      const steps = agentSteps.get(agentId);
      if (steps) {
        const step = steps.find(s => s.toolCallId === event.toolCallId);
        if (step && event.message) step.label = event.message;
        agentStore.setSteps(agentId, [...steps]);
        updateAgentCardSteps(agentId);
      }
    } else if (event.type === 'tool.complete') {
      const steps = agentSteps.get(agentId);
      if (steps) {
        const step = steps.find(s => s.toolCallId === event.toolCallId);
        if (step) step.status = event.success ? 'done' : 'failed';
        agentStore.setSteps(agentId, [...steps]);
        updateAgentCardSteps(agentId);
      }
    } else if (event.type === 'approval.needed') {
      agentApprovals.set(agentId, { requestId: event.requestId, permissionKind: event.permissionKind, intention: event.intention, path: event.path });
      agentStore.setApproval(agentId, {
        agentId,
        requestId: event.requestId,
        permissionKind: event.permissionKind,
        intention: event.intention,
        path: event.path,
      });
      updateAgentCardApproval(agentId);
    }
  });
  agentChatUnsubs.set(agentId, unsub);
}

function unsubscribeAllAgentChats(): void {
  for (const unsub of agentChatUnsubs.values()) unsub();
  agentChatUnsubs.clear();
}

function updateAgentCardSteps(_agentId: string): void {
  // React owns the agent step list (rendered by AgentsList from
  // agentStore.steps). Legacy callers are no-ops during the migration —
  // the store mutations in subscribeAgentChat drive the React re-render.
}

function describeApproval(approval: { permissionKind: string; intention?: string; path?: string }): { label: string; detail: string } {
  // Use the SDK's intention if available (e.g. "Read file: /path/to/file")
  let label: string;
  const kind = approval.permissionKind;
  if (kind.includes('file') || kind.includes('write')) label = 'Write to files';
  else if (kind.includes('bash') || kind.includes('exec') || kind.includes('command')) label = 'Execute a command';
  else if (kind.includes('read')) label = 'Read files';
  else label = kind.replace(/_/g, ' ');

  // Build a detail string with the specific path/intention
  let detail = '';
  if (approval.path) {
    const parts = approval.path.replace(/\\/g, '/').split('/').filter(Boolean);
    const shortPath = parts.length > 3
      ? '…/' + parts.slice(-3).join('/')
      : approval.path;
    detail = shortPath;
  } else if (approval.intention) {
    detail = approval.intention;
  }

  return { label, detail };
}

function updateAgentCardApproval(_agentId: string): void {
  // React owns the agent card approval panel (rendered by AgentsList from
  // agentStore.approvals). Legacy callers are no-ops during the migration —
  // the store mutations in subscribeAgentChat / the IPC bridge drive the
  // React re-render.
}

// ── Skills rendering ────────────────────────────────────

interface SkillData {
  id: string;
  name: string;
  description: string;
  emoji: string;
  folder: string;
  filePath: string;
  schedule: string | null;
  schedule_time: string | null;
  schedule_day: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

let cachedSkills: SkillData[] = [];

async function loadSkills(): Promise<SkillData[]> {
  try {
    cachedSkills = await whimAPI.listSkills();
    skillStore.setSkills(cachedSkills as unknown as SharedSkill[]);
    return cachedSkills;
  } catch {
    return cachedSkills;
  }
}

async function renderSkillsList(filterQuery?: string): Promise<void> {
  const gen = ++renderGeneration;
  displayedSpaces = [];
  countEl.textContent = String(spaces.filter(i => i.status !== 'done').length);

  // React owns the skills list DOM (SkillsList component reads from
  // skillStore). loadSkills() populates the store; client-side filtering
  // happens inside the component using filterQuery from spaceStore.
  await loadSkills();
  if (gen !== renderGeneration) return;
  // filterQuery is mirrored to spaceStore.activeSearchQuery by the search
  // handlers below; SkillsList reads it from there.
  void filterQuery;
}

async function createNewSkill(): Promise<void> {
  const name = prompt('Skill name:');
  if (!name || !name.trim()) return;

  const result = await whimAPI.createSkill(name.trim());
  if ('error' in result) {
    showStatus(`Failed: ${result.error}`, true);
    return;
  }
  showStatus(`✓ Created skill: ${result.name}`);
  setTimeout(hideStatus, 2000);
  render();
}

async function openSkillEditor(skillId: string): Promise<void> {
  const skill = cachedSkills.find(s => s.id === skillId);
  if (!skill) return;

  // See openCanvas: the browser has no popout to hand a skill to either.
  if (canvasPopsOut) {
    whimAPI.openCanvasWindow({ kind: 'skill', id: skillId, title: skill.name });
    return;
  }

  // ── Below draws the canvas in this window ──
  const result = await whimAPI.readSkill(skillId);
  if ('error' in result) {
    return;
  }

  canvasSpaceId = null;
  canvasSkillId = skillId;
  canvasPageSpaceId = null;
  canvasPageName = null;

  setCanvasHeaderTitle(skill.name);
  canvasTitle.contentEditable = 'false';
  canvasTitle.classList.remove('editing');
  canvasTitleAI.classList.add('hidden');
  canvasSaveStatus.textContent = '';
  canvasDirty = false;
  canvasSaveBtn.classList.add('hidden');
  updateModeToggleUI('rendered');

  // Configure dropdown for skill context
  closeCanvasMenu();
  updateCanvasMenuContext(true);

  revealCanvasView();

  const myGen = ++canvasMountGen;
  const currentTheme = getResolvedTheme();

  if (canvasMountGen !== myGen) return;

  // Pass frontmatter and body separately — canvas renders them independently
  mountCanvas(canvasRoot, {
    spaceId: '__skill__' + skillId,
    content: result.body,
    frontmatter: result.frontmatter,
    theme: currentTheme,
    personas: [],
    onDirtyChange: (dirty: boolean) => {
      canvasDirty = dirty;
      canvasSaveBtn.classList.toggle('hidden', !dirty);
    },
    onSaveStatus: (status: string) => {
      canvasSaveStatus.textContent = status;
    },
    onAgentMentioned: () => {},
  });
}

async function saveSkillFromCanvas(skillId: string, content: string): Promise<void> {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  await whimAPI.writeSkill(skillId, frontmatter, body);
}

async function openSkillFolder(skillId: string): Promise<void> {
  await whimAPI.openSkillFolder(skillId);
}

async function openInvokedSkillCanvas(space: { id?: string; description?: string }): Promise<void> {
  setFilter('open');
  await loadSpaces();
  if (space.id) {
    whimAPI.openNewCanvasWindow({ kind: 'space', id: space.id, title: space.description || '' });
  }
}

async function createSpaceFromSkill(skillId: string): Promise<void> {
  const result = await whimAPI.invokeSkill({ skillId, run: false, source: 'skill-card' });
  if ('error' in result && !('space' in result)) {
    showStatus(`Failed: ${result.error}`, true);
    return;
  }
  showStatus(`✓ Created space with linked skill`);
  setTimeout(hideStatus, 2000);
  await openInvokedSkillCanvas(result.space);
}

async function deleteSkill(skillId: string): Promise<void> {
  const skill = cachedSkills.find(s => s.id === skillId);
  if (!confirm(`Delete skill "${skill?.name || skillId}"?`)) return;

  await whimAPI.deleteSkill(skillId);
  render();
}

async function launchSkillAsSpace(
  skillId: string,
  source: 'skill-card' | 'skill-editor' = 'skill-editor',
): Promise<void> {
  const result = await whimAPI.invokeSkill({ skillId, run: true, source });
  if ('error' in result && !('space' in result)) {
    showStatus(`Failed: ${result.error}`, true);
    return;
  }
  if (result.error) {
    showStatus(`Created canvas, but launch failed: ${result.error}`, true);
  } else {
    showStatus(`✓ Running skill`);
  }
  setTimeout(hideStatus, 2000);
  await openInvokedSkillCanvas(result.space);
}

function resolveSkillInvocationFromPrompt(raw: string): { skillId: string; intent: string } | null {
  const parsed = parseLeadingMentionToken(raw);
  if (!parsed) return null;
  const token = parsed.token;
  if (!token) return null;
  const exactPersona = findExactPersona(token);
  const selectedSkill = selectedSkillMentionId ? cachedSkills.find(s => s.id === selectedSkillMentionId) || null : null;
  const exactSkill = selectedSkill && selectedSkill.id.toLowerCase() === normalizeMentionText(token)
    ? selectedSkill
    : findExactSkillMention(token);
  if (!exactSkill || (exactPersona && !selectedSkill)) return null;
  return {
    skillId: exactSkill.id,
    intent: raw.slice(parsed.afterIndex).trim(),
  };
}

async function invokeSkillFromPrompt(raw: string): Promise<boolean> {
  let invocation = resolveSkillInvocationFromPrompt(raw);
  if (!invocation && raw.startsWith('@')) {
    await loadSkills();
    invocation = resolveSkillInvocationFromPrompt(raw);
  }
  if (!invocation) return false;

  showStatus(`▶ Running ${cachedSkills.find(s => s.id === invocation.skillId)?.name || 'skill'}...`);
  const result = await whimAPI.invokeSkill({
    skillId: invocation.skillId,
    intent: invocation.intent,
    run: true,
    source: 'side-panel',
  });

  if ('error' in result && !('space' in result)) {
    showStatus(`Failed: ${result.error}`, true);
    setTimeout(hideStatus, 3000);
    return true;
  }

  descInput.value = '';
  descInput.style.height = 'auto';
  selectedPersonaHandle = null;
  selectedSkillMentionId = null;
  hideMentionDropdown();
  if (result.error) {
    showStatus(`Created canvas, but launch failed: ${result.error}`, true);
  } else {
    hideStatus();
  }
  await openInvokedSkillCanvas(result.space);
  return true;
}

/**
 * Run a skill immediately, from the skill card or the schedule picker.
 *
 * A manual run deliberately leaves `next_run_at` alone: "run it now" answers a
 * question you have now, and silently pushing the schedule out a day is not
 * something the button says it does.
 */
async function runSkillNow(skillId: string): Promise<void> {
  closeSchedulePicker();
  const skill = cachedSkills.find(s => s.id === skillId);
  showStatus(`▶ Running ${skill?.name || 'skill'}...`);
  await launchSkillAsSpace(skillId, 'skill-card');
}

// Wire up skills changed event
whimAPI.onSkillsChanged(() => {
  if (currentFilter === 'skills') {
    renderSkillsList();
  }
});

// Expose skill functions to onclick handlers
(window as any).createNewSkill = createNewSkill;
(window as any).openSkillFolder = openSkillFolder;
(window as any).createSpaceFromSkill = createSpaceFromSkill;
(window as any).launchSkillAsSpace = launchSkillAsSpace;
(window as any).runSkillNow = runSkillNow;
(window as any).deleteSkill = deleteSkill;
(window as any).openSchedulePicker = openSchedulePicker;

// ── Skill Schedule Helpers ──────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime12Hour(time: string | null): string {
  const [hStr, mStr] = (time || '09:00').split(':');
  let h = parseInt(hStr, 10);
  if (isNaN(h)) h = 9;
  const m = (mStr || '00').padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return m === '00' ? `${h} ${period}` : `${h}:${m} ${period}`;
}

function formatScheduleLabel(frequency: string, time: string | null, day: number | null): string {
  const timePart = formatTime12Hour(time);
  const dayIdx = day ?? 1;
  const dayFull = DAY_NAMES_FULL[dayIdx] ?? DAY_NAMES_FULL[1];
  switch (frequency) {
    case 'daily': return `Daily at ${timePart}`;
    case 'weekdays': return `Weekdays at ${timePart}`;
    case 'weekly': return `${dayFull}s at ${timePart}`;
    case 'biweekly': return `Every 2 weeks on ${dayFull} at ${timePart}`;
    case 'monthly': return `Monthly at ${timePart}`;
    default: return frequency;
  }
}

function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return 'soon';
  if (diffHours < 24) return `in ${diffHours}h`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 7) return `in ${diffDays}d`;
  return date.toLocaleDateString();
}

let activeSchedulePickerSkillId: string | null = null;

const WHIM_REPORT_CANVAS_ID = 'whim-report';

function openSchedulePicker(skillId: string): void {
  // Close any existing picker
  closeSchedulePicker();
  activeSchedulePickerSkillId = skillId;

  const skill = cachedSkills.find(s => s.id === skillId);
  if (!skill) return;

  const reportsOn = !!skill.canvas;
  const template = skill.canvas_template || null;
  // A skill that ships its own template offers a choice; one that does not
  // would render a select with a single option, so it does not get one.
  const templateOptions = template
    ? `
        <label>Layout</label>
        <select id="schedule-canvas-template">
          <option value="${WHIM_REPORT_CANVAS_ID}" ${skill.canvas !== template.id ? 'selected' : ''}>Built-in report</option>
          <option value="${escapeHtml(template.id)}" ${skill.canvas === template.id ? 'selected' : ''}>${escapeHtml(template.displayName)}</option>
        </select>`
    : '';

  const overlay = document.createElement('div');
  overlay.id = 'schedule-picker-overlay';
  overlay.className = 'schedule-picker-overlay';
  overlay.innerHTML = `
    <div class="schedule-picker" onclick="event.stopPropagation()">
      <div class="schedule-picker-header">
        <span>Schedule: ${escapeHtml(skill.name)}</span>
        <button class="schedule-picker-close" onclick="closeSchedulePicker()">✕</button>
      </div>
      <div class="schedule-picker-body">
        <label>Frequency</label>
        <select id="schedule-frequency">
          <option value="">Off</option>
          <option value="daily" ${skill.schedule === 'daily' ? 'selected' : ''}>Daily</option>
          <option value="weekdays" ${skill.schedule === 'weekdays' ? 'selected' : ''}>Weekdays</option>
          <option value="weekly" ${skill.schedule === 'weekly' ? 'selected' : ''}>Weekly</option>
          <option value="biweekly" ${skill.schedule === 'biweekly' ? 'selected' : ''}>Every 2 weeks</option>
          <option value="monthly" ${skill.schedule === 'monthly' ? 'selected' : ''}>Monthly</option>
        </select>

        <label>Time</label>
        <input type="time" id="schedule-time" value="${skill.schedule_time || '09:00'}" />

        <div id="schedule-day-row" style="${skill.schedule === 'weekly' || skill.schedule === 'biweekly' ? '' : 'display:none'}">
          <label>Day</label>
          <select id="schedule-day">
            ${DAY_NAMES.map((name, i) => `<option value="${i}" ${(skill.schedule_day ?? 1) === i ? 'selected' : ''}>${name}</option>`).join('')}
          </select>
        </div>

        <div class="schedule-section">
          <label class="schedule-check">
            <input type="checkbox" id="schedule-canvas" ${reportsOn ? 'checked' : ''} />
            <span>Publish a report</span>
          </label>
          <div class="schedule-hint">The run writes a page you can open later from the space, the tray, or a notification.</div>
          <div id="schedule-canvas-options" style="${reportsOn ? '' : 'display:none'}">
            ${templateOptions}
            <label>Space</label>
            <select id="schedule-space-mode">
              <option value="reuse" ${skill.space_mode !== 'new' ? 'selected' : ''}>Refresh one space</option>
              <option value="new" ${skill.space_mode === 'new' ? 'selected' : ''}>New space each run</option>
            </select>
          </div>
        </div>

        ${skill.next_run_at ? `<div class="schedule-next-run">Next run: ${formatRelativeDate(skill.next_run_at)}</div>` : ''}
        ${skill.schedule ? (skill.last_run_at ? `<div class="schedule-next-run">Last run: ${formatRelativeDate(skill.last_run_at)}</div>` : '<div class="schedule-next-run schedule-no-runs">Never run yet</div>') : ''}
      </div>
      <div class="schedule-picker-footer">
        <button class="schedule-run-btn" onclick="runScheduledSkillNow()">▶ Run now</button>
        <span class="schedule-footer-spacer"></span>
        ${skill.schedule ? '<button class="schedule-clear-btn" onclick="clearSchedule()">Remove schedule</button>' : ''}
        <button class="schedule-save-btn" onclick="saveSchedule()">Save</button>
      </div>
    </div>
  `;

  overlay.addEventListener('click', closeSchedulePicker);

  document.body.appendChild(overlay);

  // Toggle day row visibility when frequency changes
  const freqSelect = document.getElementById('schedule-frequency') as HTMLSelectElement;
  freqSelect.addEventListener('change', () => {
    const dayRow = document.getElementById('schedule-day-row') as HTMLDivElement;
    dayRow.style.display = (freqSelect.value === 'weekly' || freqSelect.value === 'biweekly') ? '' : 'none';
  });

  const canvasCheck = document.getElementById('schedule-canvas') as HTMLInputElement;
  canvasCheck.addEventListener('change', () => {
    const options = document.getElementById('schedule-canvas-options') as HTMLDivElement;
    options.style.display = canvasCheck.checked ? '' : 'none';
  });
}

function closeSchedulePicker(): void {
  const existing = document.getElementById('schedule-picker-overlay');
  if (existing) existing.remove();
  activeSchedulePickerSkillId = null;
}

/**
 * Persist the report settings the picker is showing.
 *
 * Kept separate from the schedule write because reports are not a scheduling
 * concept: a skill with no schedule at all can still publish one when you run
 * it by hand, so turning "Off" the frequency must not turn reports off too.
 */
async function saveCanvasSettingsFromPicker(skillId: string): Promise<void> {
  const canvasCheck = document.getElementById('schedule-canvas') as HTMLInputElement | null;
  if (!canvasCheck) return;

  if (!canvasCheck.checked) {
    await whimAPI.setSkillCanvas(skillId, null, null);
    return;
  }

  const templateSelect = document.getElementById('schedule-canvas-template') as HTMLSelectElement | null;
  const modeSelect = document.getElementById('schedule-space-mode') as HTMLSelectElement | null;
  const canvas = templateSelect?.value || WHIM_REPORT_CANVAS_ID;
  const spaceMode = modeSelect?.value === 'new' ? 'new' : 'reuse';
  await whimAPI.setSkillCanvas(skillId, canvas, spaceMode);
}

async function saveSchedule(): Promise<void> {
  if (!activeSchedulePickerSkillId) return;
  const skillId = activeSchedulePickerSkillId;

  const freqSelect = document.getElementById('schedule-frequency') as HTMLSelectElement;
  const timeInput = document.getElementById('schedule-time') as HTMLInputElement;
  const daySelect = document.getElementById('schedule-day') as HTMLSelectElement;

  const frequency = freqSelect.value;
  await saveCanvasSettingsFromPicker(skillId);

  if (!frequency) {
    await whimAPI.clearSkillSchedule(skillId);
    closeSchedulePicker();
    showStatus('✓ Saved');
    setTimeout(hideStatus, 2000);
    cachedSkills = await whimAPI.listSkills();
    if (currentFilter === 'skills') renderSkillsList();
    if (canvasSkillId) updateCanvasMenuContext(true);
    return;
  }

  const time = timeInput.value || '09:00';
  const day = (frequency === 'weekly' || frequency === 'biweekly') ? parseInt(daySelect.value, 10) : null;

  await whimAPI.setSkillSchedule(skillId, frequency, time, day);
  closeSchedulePicker();
  showStatus('✓ Schedule saved');
  setTimeout(hideStatus, 2000);
  cachedSkills = await whimAPI.listSkills();
  if (currentFilter === 'skills') renderSkillsList();
  // Refresh the canvas overflow menu label if we're viewing this skill
  if (canvasSkillId) updateCanvasMenuContext(true);
}

/** Save what the picker is showing, then run the skill straight away. */
async function runScheduledSkillNow(): Promise<void> {
  if (!activeSchedulePickerSkillId) return;
  const skillId = activeSchedulePickerSkillId;
  await saveCanvasSettingsFromPicker(skillId);
  cachedSkills = await whimAPI.listSkills();
  await runSkillNow(skillId);
}

async function clearSchedule(): Promise<void> {
  if (!activeSchedulePickerSkillId) return;

  await whimAPI.clearSkillSchedule(activeSchedulePickerSkillId);
  closeSchedulePicker();
  showStatus('✓ Schedule removed');
  setTimeout(hideStatus, 2000);
  cachedSkills = await whimAPI.listSkills();
  if (currentFilter === 'skills') renderSkillsList();
  if (canvasSkillId) updateCanvasMenuContext(true);
}

(window as any).closeSchedulePicker = closeSchedulePicker;
(window as any).saveSchedule = saveSchedule;
(window as any).clearSchedule = clearSchedule;
(window as any).runScheduledSkillNow = runScheduledSkillNow;

async function renderAgentsList(filterQuery?: string): Promise<void> {
  const gen = ++renderGeneration;
  displayedSpaces = [];
  countEl.textContent = String(spaces.filter(i => i.status !== 'done').length);

  // React owns the agents list DOM (AgentsList component reads from
  // agentStore + spaceStore + personaStore). We still need to fetch the
  // agents into the store and keep legacy module-level state
  // (renderedAgents, agentApprovals, agentYoloState) in sync for the
  // remaining non-list callers in this file.
  let allAgents: Array<{ agentId: string; sessionId: string; status: string; summary: string; selectedText: string; quotedText?: string; spaceId: string; createdAt?: string; pendingApprovalId?: string | null; pendingPermissionKind?: string | null; source?: 'sdk' | 'cli' | 'cca'; personaHandle?: string | null; sandboxed?: boolean; yoloMode?: boolean }> = [];

  try {
    allAgents = await whimAPI.listAllAgents();
  } catch {
    // Fallback: iterate spaces
    for (const space of spaces) {
      try {
        const agents = await whimAPI.listAgents(space.id);
        for (const agent of agents) {
          allAgents.push({ ...agent, spaceId: space.id });
        }
      } catch { /* skip */ }
    }
  }

  // Bail if user switched away from agents while loading.
  if (gen !== renderGeneration) return;

  // Push the snapshot to agentStore so React re-renders.
  agentStore.setAgents(allAgents as unknown as Parameters<typeof agentStore.setAgents>[0]);

  // Client-side filtering when in search mode (legacy renderedAgents).
  let filteredAgents = allAgents;
  if (filterQuery) {
    const q = filterQuery.toLowerCase();
    filteredAgents = allAgents.filter(a =>
      (a.selectedText || '').toLowerCase().includes(q) ||
      (a.summary || '').toLowerCase().includes(q)
    );
  }
  renderedAgents = filteredAgents;
  selectedIndex = -1;

  // Populate approvals + yolo state maps from the API payload.
  for (const agent of allAgents) {
    if (agent.status === 'waiting-approval' && agent.pendingApprovalId) {
      const approval = {
        requestId: agent.pendingApprovalId,
        permissionKind: agent.pendingPermissionKind || 'permission',
        intention: (agent as any).pendingIntention || undefined,
        path: (agent as any).pendingPath || undefined,
      };
      agentApprovals.set(agent.agentId, approval);
      agentStore.setApproval(agent.agentId, { agentId: agent.agentId, ...approval });
    }
    if ((agent as any).yoloMode) {
      agentYoloState.set(agent.agentId, true);
      agentStore.setYoloMode(agent.agentId, true);
    }
  }

  // Subscribe to chat events for live agents so steps + approvals flow.
  for (const agent of allAgents) {
    if (agent.status === 'running' || agent.status === 'waiting-approval') {
      subscribeAgentChat(agent.agentId);
    }
  }
}

let renderedAgents: Array<{ agentId: string; sessionId: string; status: string; summary: string; selectedText: string; spaceId: string; createdAt?: string; source?: 'sdk' | 'cli' | 'cca' }> = [];

function updateAgentSelection(): void {
  // Push the selection to spaceStore so React applies kb-selected via JSX.
  // Then scroll the selected row into view (read-only DOM access — safe).
  spaceStore.setSelectedIndex(selectedIndex);
  const items = listEl.querySelectorAll('.agent-card');
  if (selectedIndex >= 0 && items[selectedIndex]) {
    (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function updateSelection(): void {
  spaceStore.setSelectedIndex(selectedIndex);
  const items = listEl.querySelectorAll('.space-item');
  if (selectedIndex >= 0 && items[selectedIndex]) {
    (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDueDate(due_at_utc: string | null, due_at: string | null): { text: string; overdue: boolean } {
  if (!due_at_utc) {
    return due_at ? { text: due_at, overdue: false } : { text: '', overdue: false };
  }

  const due = new Date(due_at_utc);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const overdue = diffMs < 0;

  if (overdue) {
    const absDays = Math.abs(diffDays);
    if (absDays === 0) return { text: 'due today', overdue: true };
    if (absDays === 1) return { text: '1d overdue', overdue: true };
    return { text: `${absDays}d overdue`, overdue: true };
  }

  if (diffDays === 0) return { text: 'due today', overdue: false };
  if (diffDays === 1) return { text: 'tomorrow', overdue: false };
  if (diffDays <= 7) return { text: `in ${diffDays}d`, overdue: false };

  // Absolute date for further out
  return {
    text: due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    overdue: false,
  };
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (searchMode) return;
  const text = descInput.value.trim();

  if (text && await invokeSkillFromPrompt(descInput.value.trim())) {
    return;
  }

  // ── Workers tab: launch an agent ──────────────────────
  if (currentFilter === 'agents') {
    if (!text) {
      // Empty prompt → open new agent chat
      openAgentChat(undefined as any, '', 'new');
      return;
    }

    // Extract a leading @persona mention if present.  State (set when the
    // user picks from the dropdown or types a complete handle) is the
    // authoritative source; raw-text parse is a fallback for hand-typed
    // handles that survived the dropdown hide.
    const raw = descInput.value;
    const mentionMatch = raw.match(/^@([a-z0-9][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/i);
    let promptText = text;
    let personaHandleArg: string | undefined;
    if (mentionMatch) {
      const candidate = mentionMatch[1].toLowerCase();
      const fromState = selectedPersonaHandle && selectedPersonaHandle.toLowerCase() === candidate ? selectedPersonaHandle : null;
      const persona = fromState ? findExactPersona(fromState) : findExactPersona(candidate);
      if (persona) {
        personaHandleArg = persona.handle;
        promptText = (mentionMatch[2] || '').trim();
        if (!promptText) {
          // User hit submit with only "@handle" and no follow-up — open an
          // empty chat seeded with the persona instead of launching with no work.
          openAgentChat(undefined as any, '', 'new');
          return;
        }
      }
    }

    showStatus(personaHandleArg ? `⚡ Launching @${personaHandleArg}...` : '⚡ Launching agent...');

    const result = await whimAPI.quickLaunchAgent(promptText, personaHandleArg);
    if ('error' in result && result.error) {
      if (result.error === 'no_workspace') {
        showStatus('Select a workspace directory first');
        const ws = await whimAPI.selectWorkspace();
        if (ws.selected) updateWorkspaceDisplay(ws.path!);
      } else {
        showStatus(`Failed: ${result.error}`, true);
      }
      return;
    }
    descInput.value = '';
    descInput.style.height = 'auto';
    selectedPersonaHandle = null;
    selectedSkillMentionId = null;
    hideMentionDropdown();
    descInput.focus();
    hideStatus();

    renderAgentsList();
    return;
  }

  // ── Skills tab: create a skill from description ───────
  if (currentFilter === 'skills') {
    if (!text) return; // require a description
    showStatus('✨ Creating skill...');
    const result = await whimAPI.createSkillFromPrompt(text);
    if ('error' in result && result.error) {
      if (result.error === 'no_workspace') {
        showStatus('Select a workspace directory first');
        const ws = await whimAPI.selectWorkspace();
        if (ws.selected) updateWorkspaceDisplay(ws.path!);
      } else {
        showStatus(`Failed: ${result.error}`, true);
      }
      return;
    }
    descInput.value = '';
    descInput.style.height = 'auto';
    descInput.focus();
    showStatus('✨ Creating skill...');
    setTimeout(hideStatus, 4000);
    return;
  }

  // ── Spaces tab: create an space (original behavior) ──
  if (!text) return;

  descInput.value = '';
  descInput.style.height = 'auto';
  descInput.focus();
  searchResults = null;
  spaceStore.setSearchResults(null);

  // Create as space with body
  queryResult.classList.add('hidden');
  listEl.classList.remove('hidden');
  const space = await whimAPI.create({ body: text }) as any;
  if (space.error === 'no_workspace') {
    showStatus('Select a workspace directory first');
    const ws = await whimAPI.selectWorkspace();
    if (ws.selected) {
      updateWorkspaceDisplay(ws.path!);
      const retryIntent = await whimAPI.create({ body: text }) as any;
      if (retryIntent.error) {
        showStatus('Failed to create space', true);
        return;
      }
      processingSpaces.add(retryIntent.id);
      agentStore.addProcessingIntent(retryIntent.id);
      insertSpaceOptimistically(retryIntent);
    } else {
      hideStatus();
      return;
    }
  } else {
    processingSpaces.add(space.id);
    agentStore.addProcessingIntent(space.id);
    insertSpaceOptimistically(space);
  }
  hideStatus();
});

// Listen for background LLM processing completion
whimAPI.onSpaceProcessed(async (id: string) => {
  processingSpaces.delete(id);
  agentStore.removeProcessingIntent(id);
  await animateRefinement(id);
});

whimAPI.onSpaceTitleUpdated(({ spaceId, title }) => {
  const space = spaces.find(s => s.id === spaceId);
  if (space) space.description = title;
  spaceStore.updateSpaceTitle(spaceId, title);
  if (canvasSpaceId === spaceId) {
    setCanvasHeaderTitle(title);
  }
});

// Listen for recurrence evaluation results
whimAPI.onRecurrenceResult((spaceId: string, result: RecurrenceResult) => {
  if (!result.should_recur) return;

  const dueText = result.next_due || result.next_due_utc || 'soon';
  statusBar.innerHTML = `↻ Recurring — next due ${escapeHtml(dueText)} <button class="dismiss-recurrence" onclick="dismissRecurrence('${spaceId}')">✕</button>`;
  statusBar.classList.remove('hidden', 'error');
  statusBar.classList.add('recurrence');
});

// Listen for recurrence being applied (after undo window)
whimAPI.onRecurrenceApplied(async (_intentId: string) => {
  hideStatus();
  await loadSpaces();
});

// Listen for recall hints
whimAPI.onRecallHint((spaceId: string, match: RecallMatch) => {
  // Push the hint to spaceStore; the React SpaceRow reads it and renders.
  spaceStore.setRecallHint(spaceId, match);
  // Auto-dismiss after 5 seconds (React will hide once the hint is null).
  setTimeout(() => {
    spaceStore.setRecallHint(spaceId, null);
  }, 5000);
});

// @ts-ignore - called from onclick in status bar HTML
async function dismissRecurrence(spaceId: string): Promise<void> {
  await whimAPI.dismissRecurrence(spaceId);
  hideStatus();
}

(window as any).dismissRecurrence = dismissRecurrence;

// ── Session launch ──────────────────────────────────────
// @ts-ignore - called from onclick in HTML
async function launchSession(spaceId: string): Promise<void> {
  const result = await whimAPI.launchSession(spaceId);
  if (result.success) {
    whimAPI.hideWindow();
    await loadSpaces();
  } else if (result.error === 'no_workspace') {
    // Prompt to select workspace
    showStatus('Select a workspace directory first');
    const ws = await whimAPI.selectWorkspace();
    if (ws.selected) {
      updateWorkspaceDisplay(ws.path!);
      // Retry launch
      const retry = await whimAPI.launchSession(spaceId);
      if (retry.success) {
        whimAPI.hideWindow();
        await loadSpaces();
      } else {
        showStatus(retry.error || 'Launch failed', true);
      }
    } else {
      hideStatus();
    }
  } else {
    showStatus(result.error || 'Launch failed', true);
    setTimeout(hideStatus, 3000);
  }
}

(window as any).launchSession = launchSession;

// ── Workspace setting ───────────────────────────────────
const workspacePathEl = document.getElementById('workspace-path') as HTMLSpanElement;
const workspaceBtn = document.getElementById('workspace-btn') as HTMLButtonElement;
const workspaceClearBtn = document.getElementById('workspace-clear-btn') as HTMLButtonElement;
let currentWorkspacePath: string | null = null;

/** Folder name of the active workspace, used to label the Spaces tab. */
function workspaceTabLabel(): string {
  if (!currentWorkspacePath) return 'Spaces';
  const parts = currentWorkspacePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'Spaces';
}

function updateWorkspaceDisplay(path: string | null): void {
  currentWorkspacePath = path;
  if (path) {
    // Show last 2 path segments for brevity
    const parts = path.replace(/\\/g, '/').split('/');
    const short = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : path;
    workspacePathEl.textContent = short;
    workspacePathEl.title = path;
    workspacePathEl.classList.add('clickable');
    workspaceClearBtn.classList.remove('hidden');
  } else {
    workspacePathEl.textContent = 'Not set';
    workspacePathEl.title = '';
    workspacePathEl.classList.remove('clickable');
    workspaceClearBtn.classList.add('hidden');
  }
  renderWorkspaceTab();
}

workspaceBtn.addEventListener('click', async () => {
  const result = await whimAPI.selectWorkspace();
  if (result.selected) {
    updateWorkspaceDisplay(result.path);
  }
});

workspaceClearBtn.addEventListener('click', async () => {
  await whimAPI.clearWorkspace();
  updateWorkspaceDisplay(null);
});

workspacePathEl.addEventListener('click', () => {
  const path = workspacePathEl.title;
  if (path) {
    whimAPI.openPath(path);
  }
});

// ── Workspace profiles ──────────────────────────────────
const brandLogo = document.getElementById('brand-logo') as HTMLElement | null;
const profilesListEl = document.getElementById('profiles-list') as HTMLDivElement | null;
const profileAddBtn = document.getElementById('profile-add-btn') as HTMLButtonElement | null;

let profilesState: ProfilesState | null = null;

/** Paint (or clear) the per-profile tint wash + accent. Safe with null/invalid values. */
function applyProfileTint(tint: string | null): void {
  const root = document.documentElement;
  if (tint && isValidTint(tint)) {
    root.style.setProperty('--profile-tint', tint);
    document.body.classList.add('has-profile-tint');
  } else {
    root.style.removeProperty('--profile-tint');
    document.body.classList.remove('has-profile-tint');
  }
}

function getActiveProfile(): ResolvedProfile | null {
  if (!profilesState) return null;
  return profilesState.profiles.find(p => p.id === profilesState!.activeProfileId) ?? null;
}

/** Apply the active profile's tint to this window. */
function applyActiveProfileTint(): void {
  applyProfileTint(getActiveProfile()?.tint ?? null);
}

/**
 * Mark the "whim" logo with the active profile's tint dot. The name itself is
 * not repeated here — the leading Spaces tab already carries it, and two copies
 * of the same word crowded the bottom bar. The logo cycles profiles on click
 * when more than one exists.
 */
function renderProfileBrand(): void {
  if (!brandLogo) return;
  const mark = brandLogo.querySelector('.profile-mark') as HTMLElement | null;
  const active = getActiveProfile();
  if (!active) {
    if (mark) mark.classList.add('hidden');
    brandLogo.classList.remove('clickable');
    brandLogo.removeAttribute('title');
    return;
  }
  if (mark) {
    if (active.tint && isValidTint(active.tint)) {
      mark.style.background = active.tint;
      mark.classList.remove('hidden');
    } else {
      mark.classList.add('hidden');
    }
  }
  const canCycle = (profilesState?.profiles.length ?? 0) > 1;
  brandLogo.classList.toggle('clickable', canCycle);
  brandLogo.title = canCycle ? `Switch profile — currently ${active.displayName}` : active.displayName;
}

/**
 * Label the leading Spaces tab with the active workspace so the user is
 * oriented. Switching workspaces stays explicit (logo click / hotkey).
 */
function renderWorkspaceTab(): void {
  if (!workspaceTabNameEl) return;
  const active = getActiveProfile();
  const label = active?.displayName ?? workspaceTabLabel();
  workspaceTabNameEl.textContent = label;
  const tab = workspaceTabNameEl.closest('.filter-btn') as HTMLElement | null;
  if (tab) tab.title = active ? `${label}\n${active.path}` : label;
  const dot = tab?.querySelector('.workspace-tab-dot') as HTMLElement | null;
  if (dot) {
    if (active?.tint && isValidTint(active.tint)) {
      dot.style.background = active.tint;
      dot.classList.remove('hidden');
    } else {
      dot.classList.add('hidden');
    }
  }
}

/** Brief visual confirmation that the profile switched. */
function pulseProfileBrand(): void {
  if (!brandLogo) return;
  brandLogo.classList.remove('profile-switched');
  // Force reflow so re-adding the class restarts the animation.
  void brandLogo.offsetWidth;
  brandLogo.classList.add('profile-switched');
}

/** Logo/hotkey action: cycle to the next profile (no-op with fewer than two). */
async function cycleProfileFromUI(): Promise<void> {
  const count = profilesState?.profiles.length ?? 0;
  if (count < 2) return;
  await whimAPI.cycleProfile();
  // The profiles:changed broadcast updates the logo + tint.
}

/** Settings → Profiles list. Renders an editable row per saved profile. */
function renderProfilesSettings(): void {
  if (!profilesListEl) return;
  profilesListEl.innerHTML = '';
  const state = profilesState;
  if (!state || state.profiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'settings-hint';
    empty.textContent = 'No profiles yet. Add one to get started.';
    profilesListEl.appendChild(empty);
    return;
  }

  for (const profile of state.profiles) {
    const isActive = profile.id === state.activeProfileId;
    const row = document.createElement('div');
    row.className = 'profile-row' + (isActive ? ' active' : '');

    // Tint swatch — tap to generate a new reasonable color (no palette picker).
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'profile-swatch';
    swatch.title = 'Tap to change the tint color';
    const applySwatch = (tint: string | null) => {
      swatch.style.background = (tint && isValidTint(tint)) ? tint : '';
      swatch.classList.toggle('no-tint', !(tint && isValidTint(tint)));
    };
    applySwatch(profile.tint);
    swatch.addEventListener('click', async () => {
      const next = generateTintColor(profile.tint ? (hueOf(profile.tint) ?? undefined) : undefined);
      profile.tint = next;
      applySwatch(next);
      if (isActive) applyProfileTint(next);
      await whimAPI.updateProfile(profile.id, { tint: next });
    });
    row.appendChild(swatch);

    // Name override — placeholder shows the resolved default (git repo / folder) name.
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'profile-name-input';
    nameInput.value = profile.name ?? '';
    nameInput.placeholder = profile.displayName;
    nameInput.spellcheck = false;
    const commitName = async () => {
      const value = nameInput.value.trim();
      const next = value.length > 0 ? value : null;
      if (next === profile.name) return;
      profile.name = next;
      await whimAPI.updateProfile(profile.id, { name: next });
    };
    nameInput.addEventListener('blur', () => { void commitName(); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
    });
    row.appendChild(nameInput);

    // Path (muted, click to open in the file manager).
    const pathEl = document.createElement('button');
    pathEl.type = 'button';
    pathEl.className = 'profile-path';
    const parts = profile.path.replace(/\\/g, '/').split('/');
    pathEl.textContent = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : profile.path;
    pathEl.title = profile.path;
    pathEl.addEventListener('click', () => { whimAPI.openPath(profile.path); });
    row.appendChild(pathEl);

    // Switch button / active badge.
    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'profile-active-badge';
      badge.textContent = 'Active';
      row.appendChild(badge);
    } else {
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'workspace-btn';
      switchBtn.textContent = 'Switch';
      switchBtn.addEventListener('click', async () => {
        const res = await whimAPI.activateProfile(profile.id);
        if (!res.ok && res.error === 'missing_path') {
          showStatus('Profile folder not found', true);
        }
      });
      row.appendChild(switchBtn);
    }

    // Remove.
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'profile-remove-btn';
    removeBtn.title = 'Remove profile';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', async () => {
      await whimAPI.removeProfile(profile.id);
    });
    row.appendChild(removeBtn);

    profilesListEl.appendChild(row);
  }
}

/** Pull profile state from main and refresh the logo, tint, and settings list. */
async function refreshProfiles(): Promise<void> {
  try {
    profilesState = await whimAPI.listProfiles();
  } catch {
    profilesState = { profiles: [], activeProfileId: null };
  }
  renderProfileBrand();
  renderWorkspaceTab();
  applyActiveProfileTint();
  renderProfilesSettings();
}

function handleProfilesChanged(state: ProfilesState): void {
  const prevActive = profilesState?.activeProfileId ?? null;
  profilesState = state;
  renderProfileBrand();
  renderWorkspaceTab();
  applyActiveProfileTint();
  renderProfilesSettings();
  if (state.activeProfileId && state.activeProfileId !== prevActive) {
    pulseProfileBrand();
  }
}

if (brandLogo) {
  brandLogo.addEventListener('click', () => { void cycleProfileFromUI(); });
}
if (profileAddBtn) {
  profileAddBtn.addEventListener('click', () => { void whimAPI.addProfile(); });
}
whimAPI.onProfilesChanged(handleProfilesChanged);
void refreshProfiles();

// ── CLI Path setting ────────────────────────────────────
const cliPathInput = document.getElementById('cli-path-input') as HTMLInputElement;
const cliPathClear = document.getElementById('cli-path-clear') as HTMLButtonElement;
const cliPathDetected = document.getElementById('cli-path-detected') as HTMLSpanElement;

/**
 * Synchronous-ish part of CLI path setup — just sets the input value and
 * paints a "checking…" detected-label placeholder. Cheap enough to run
 * eagerly on settings-window init so the General tab renders without
 * waiting on the CLI binary.
 */
async function loadCliPathInputSync(): Promise<void> {
  const override = await whimAPI.getSetting('cli_path');
  cliPathInput.value = override || '';
  cliPathClear.classList.toggle('hidden', !override);
  cliPathDetected.textContent = 'Checking…';
  cliPathDetected.title = '';
  cliPathDetected.style.color = '';
  if (cliMxcIndicator) {
    cliMxcIndicator.textContent = 'checking…';
    cliMxcIndicator.className = 'cli-mxc-indicator';
  }
}

/**
 * Run the slow CLI subprocess probes (version check + MXC capability
 * check). Each spawns the CLI binary, so these can take ~200ms each on
 * cold disk caches. Settings-window init defers these to idle so the
 * General tab is interactive immediately.
 */
async function runCliPathChecks(): Promise<void> {
  await updateCliPathDetected();
  await updateCliMxcIndicator();
}

function cliSourceLabel(source: string): string {
  switch (source) {
    case 'bundled': return 'Bundled';
    case 'auto': return 'Auto-detected';
    case 'path': return 'Custom path';
    case 'server': return 'Remote server';
    default: return source;
  }
}

async function updateCliPathDetected(): Promise<void> {
  const info = await whimAPI.getCliRuntimeStatus();
  cliPathDetected.style.color = '';

  if (info.source === 'server') {
    cliPathDetected.textContent = info.target ? `Remote server — ${info.target}` : 'Remote server (no URL set)';
    cliPathDetected.title = info.target || '';
    if (!info.target) cliPathDetected.style.color = 'var(--color-warning, #d29922)';
    return;
  }

  if (!info.target) {
    cliPathDetected.textContent = 'Not found';
    cliPathDetected.title = '';
    return;
  }

  cliPathDetected.title = info.target;
  if (!info.compatible) {
    cliPathDetected.textContent = `${cliSourceLabel(info.source)} (v${info.version || '?'} — update to ${info.minVersion}+) — ${info.target}`;
    cliPathDetected.style.color = 'var(--color-warning, #d29922)';
  } else {
    const v = info.version ? ` (v${info.version})` : '';
    cliPathDetected.textContent = `${cliSourceLabel(info.source)}${v} — ${info.target}`;
  }
}

let cliPathDebounce: ReturnType<typeof setTimeout> | null = null;
cliPathInput.addEventListener('input', () => {
  if (cliPathDebounce) clearTimeout(cliPathDebounce);
  cliPathDebounce = setTimeout(async () => {
    const val = cliPathInput.value.trim();
    const resolved = await whimAPI.setSetting('cli_path', val);
    // Update input to show the resolved full path if it changed
    if (resolved && resolved !== val) {
      cliPathInput.value = resolved;
    }
    cliPathClear.classList.toggle('hidden', !cliPathInput.value);
    await updateCliPathDetected();
    await updateCliMxcIndicator();
  }, 500);
});

cliPathClear.addEventListener('click', async () => {
  cliPathInput.value = '';
  await whimAPI.setSetting('cli_path', '');
  cliPathClear.classList.add('hidden');
  await updateCliPathDetected();
  await updateCliMxcIndicator();
});

// ── Runtime source selector ─────────────────────────────
const cliSourceSelect = document.getElementById('cli-source-select') as HTMLSelectElement | null;
const cliPathField = document.getElementById('cli-path-field') as HTMLElement | null;
const cliPathCustomRow = document.getElementById('cli-path-custom-row') as HTMLElement | null;
const cliDiscoveredSelect = document.getElementById('cli-discovered-select') as HTMLSelectElement | null;
const cliServerFields = document.getElementById('cli-server-fields') as HTMLElement | null;
const cliServerUrlInput = document.getElementById('cli-server-url-input') as HTMLInputElement | null;
const cliServerTokenInput = document.getElementById('cli-server-token-input') as HTMLInputElement | null;
const cliTestBtn = document.getElementById('cli-test-btn') as HTMLButtonElement | null;
const cliRuntimeStatus = document.getElementById('cli-runtime-status') as HTMLSpanElement | null;

const CLI_CUSTOM_OPTION = '__custom__';

/** Short label for a discovered CLI: "Self-updated — v1.0.75". */
function discoveredCliLabel(cli: { version: string | null; origin: string; compatible: boolean }): string {
  const version = cli.version ? `v${cli.version}` : 'unknown version';
  return `${cli.origin} — ${version}${cli.compatible ? '' : ' (too old)'}`;
}

/**
 * Populate a <select> with every Copilot CLI found on the machine, plus a
 * "Custom path…" escape hatch. Returns the discovered list so callers can
 * decide what to preselect.
 */
async function populateCliSelect(
  select: HTMLSelectElement,
  selectedPath: string,
  includeCustom: boolean,
): Promise<Array<{ path: string; version: string | null; origin: string; compatible: boolean; source: string }>> {
  let clis: Awaited<ReturnType<typeof whimAPI.discoverClis>> = [];
  try {
    clis = await whimAPI.discoverClis();
  } catch {
    clis = [];
  }
  select.innerHTML = '';
  for (const cli of clis) {
    const opt = document.createElement('option');
    opt.value = cli.path;
    opt.textContent = discoveredCliLabel(cli);
    opt.title = cli.path;
    select.appendChild(opt);
  }
  if (clis.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No Copilot CLI found';
    select.appendChild(opt);
  }
  if (includeCustom) {
    const opt = document.createElement('option');
    opt.value = CLI_CUSTOM_OPTION;
    opt.textContent = 'Custom path…';
    select.appendChild(opt);
  }
  if (selectedPath && clis.some(c => c.path === selectedPath)) {
    select.value = selectedPath;
  } else if (selectedPath && includeCustom) {
    select.value = CLI_CUSTOM_OPTION;
  } else if (clis.length > 0) {
    select.value = clis[0].path;
  }
  return clis;
}

function applyCliSourceVisibility(source: string): void {
  if (cliPathField) cliPathField.hidden = source !== 'path';
  if (cliPathCustomRow) {
    cliPathCustomRow.hidden = source !== 'path' || cliDiscoveredSelect?.value !== CLI_CUSTOM_OPTION;
  }
  if (cliServerFields) cliServerFields.hidden = source !== 'server';
}

async function loadRuntimeSourceSettings(): Promise<void> {
  if (!cliSourceSelect) return;
  const source = (await whimAPI.getSetting('cli_source')) || 'bundled';
  cliSourceSelect.value = source;
  if (cliServerUrlInput) cliServerUrlInput.value = (await whimAPI.getSetting('cli_server_url')) || '';
  if (cliServerTokenInput) cliServerTokenInput.value = (await whimAPI.getSetting('cli_server_token')) || '';
  // Discovery version-probes candidate binaries, so only run it when the
  // custom-path picker is actually visible.
  if (cliDiscoveredSelect && source === 'path') {
    await populateCliSelect(cliDiscoveredSelect, cliPathInput.value.trim(), true);
  }
  applyCliSourceVisibility(source);
}

cliDiscoveredSelect?.addEventListener('change', async () => {
  const value = cliDiscoveredSelect.value;
  if (cliPathCustomRow) cliPathCustomRow.hidden = value !== CLI_CUSTOM_OPTION;
  if (value === CLI_CUSTOM_OPTION) {
    cliPathInput.focus();
    return;
  }
  cliPathInput.value = value;
  cliPathClear.classList.toggle('hidden', !value);
  await whimAPI.setSetting('cli_path', value);
  await updateCliPathDetected();
  await updateCliMxcIndicator();
});

cliSourceSelect?.addEventListener('change', async () => {
  const source = cliSourceSelect.value;
  if (source === 'path' && cliDiscoveredSelect) {
    await populateCliSelect(cliDiscoveredSelect, cliPathInput.value.trim(), true);
  }
  applyCliSourceVisibility(source);
  if (cliRuntimeStatus) cliRuntimeStatus.textContent = '—';
  await whimAPI.setSetting('cli_source', source);
  await updateCliPathDetected();
  await updateCliMxcIndicator();
});

let cliServerUrlDebounce: ReturnType<typeof setTimeout> | null = null;
cliServerUrlInput?.addEventListener('input', () => {
  if (cliServerUrlDebounce) clearTimeout(cliServerUrlDebounce);
  cliServerUrlDebounce = setTimeout(async () => {
    await whimAPI.setSetting('cli_server_url', cliServerUrlInput.value.trim());
    await updateCliPathDetected();
  }, 500);
});

let cliServerTokenDebounce: ReturnType<typeof setTimeout> | null = null;
cliServerTokenInput?.addEventListener('input', () => {
  if (cliServerTokenDebounce) clearTimeout(cliServerTokenDebounce);
  cliServerTokenDebounce = setTimeout(async () => {
    await whimAPI.setSetting('cli_server_token', cliServerTokenInput.value);
  }, 500);
});

cliTestBtn?.addEventListener('click', async () => {
  if (!cliRuntimeStatus) return;
  cliTestBtn.disabled = true;
  cliRuntimeStatus.textContent = 'Testing…';
  cliRuntimeStatus.style.color = '';
  try {
    const res = await whimAPI.testCliConnection();
    if (res.ok) {
      const v = res.version ? ` v${res.version}` : '';
      cliRuntimeStatus.textContent = `✓ Connected — ${cliSourceLabel(res.source)}${v}`;
      cliRuntimeStatus.style.color = 'var(--color-success, #3fb950)';
    } else {
      cliRuntimeStatus.textContent = `✗ ${res.error || 'Connection failed'}`;
      cliRuntimeStatus.style.color = 'var(--color-danger, #f85149)';
    }
  } catch {
    cliRuntimeStatus.textContent = '✗ Connection failed';
    cliRuntimeStatus.style.color = 'var(--color-danger, #f85149)';
  } finally {
    cliTestBtn.disabled = false;
  }
});

// ── MXC capability indicator ────────────────────────────
const cliMxcIndicator = document.getElementById('cli-mxc-indicator') as HTMLSpanElement | null;

async function updateCliMxcIndicator(): Promise<void> {
  if (!cliMxcIndicator) return;
  try {
    const r = await whimAPI.checkCliMxcCapable();
    if (r.mxcCapable) {
      cliMxcIndicator.textContent = '✓ runtime sandbox supported';
      cliMxcIndicator.className = 'cli-mxc-indicator ok';
    } else {
      cliMxcIndicator.textContent = '⚠ not detected — sandboxed personas will fall back to host-side path enforcement only';
      cliMxcIndicator.className = 'cli-mxc-indicator warn';
    }
  } catch {
    cliMxcIndicator.textContent = '?';
    cliMxcIndicator.className = 'cli-mxc-indicator';
  }
}

// ── Auto-hide side pane setting ──────────────────────────
const autoHideSidePaneCb = document.getElementById('auto-hide-side-pane-cb') as HTMLInputElement | null;

async function loadAutoHideSetting(): Promise<void> {
  if (!autoHideSidePaneCb) return;
  const val = await whimAPI.getSetting('auto_hide_side_pane');
  autoHideSidePaneCb.checked = val !== false; // default true
}

if (autoHideSidePaneCb) {
  autoHideSidePaneCb.addEventListener('change', () => {
    whimAPI.setSetting('auto_hide_side_pane', String(autoHideSidePaneCb.checked));
  });
}

const autoRemoteCb = document.getElementById('auto-remote-cb') as HTMLInputElement | null;

async function loadAutoRemoteSetting(): Promise<void> {
  if (!autoRemoteCb) return;
  const val = await whimAPI.getSetting('remoteAutoEnable');
  autoRemoteCb.checked = val === true || val === 'true';
}

if (autoRemoteCb) {
  autoRemoteCb.addEventListener('change', () => {
    whimAPI.setSetting('remoteAutoEnable', String(autoRemoteCb.checked));
  });
}

// ── Remote Web Access setting ───────────────────────────
const webRemoteEnabledCb = document.getElementById('web-remote-enabled-cb') as HTMLInputElement | null;
const webRemotePortInput = document.getElementById('web-remote-port-input') as HTMLInputElement | null;
const webRemoteSaveBtn = document.getElementById('web-remote-save-btn') as HTMLButtonElement | null;
const webRemoteRegenerateBtn = document.getElementById('web-remote-regenerate-btn') as HTMLButtonElement | null;
const webRemoteTokenInput = document.getElementById('web-remote-token-input') as HTMLInputElement | null;
const webRemoteInterfaceList = document.getElementById('web-remote-interface-list') as HTMLDivElement | null;
const webRemoteUrlList = document.getElementById('web-remote-url-list') as HTMLDivElement | null;
const webRemoteQr = document.getElementById('web-remote-qr') as HTMLImageElement | null;
const webRemoteStatus = document.getElementById('web-remote-status') as HTMLDivElement | null;
const webRemoteTlsMode = document.getElementById('web-remote-tls-mode') as HTMLSelectElement | null;
const webRemoteTlsCustom = document.getElementById('web-remote-tls-custom') as HTMLDivElement | null;
const webRemoteTlsCert = document.getElementById('web-remote-tls-cert') as HTMLInputElement | null;
const webRemoteTlsKey = document.getElementById('web-remote-tls-key') as HTMLInputElement | null;
const webRemoteTlsStatus = document.getElementById('web-remote-tls-status') as HTMLDivElement | null;
const webRemoteAllowedHosts = document.getElementById('web-remote-allowed-hosts') as HTMLInputElement | null;
const webRemoteDeviceList = document.getElementById('web-remote-device-list') as HTMLDivElement | null;
const webRemoteActivityList = document.getElementById('web-remote-activity-list') as HTMLDivElement | null;

function setWebRemoteStatus(message: string, error = false): void {
  if (!webRemoteStatus) return;
  webRemoteStatus.textContent = message;
  webRemoteStatus.classList.toggle('web-remote-error', error);
}

const SCOPE_WARNINGS: Record<InterfaceScope, string> = {
  loopback: 'Only reachable from this machine.',
  private: 'Reachable by any device on this local network.',
  vpn: 'Reachable by devices on this VPN or tunnel.',
  public: 'Warning: this address may be reachable from the public internet.',
};

const BINDING_STATE_LABELS: Record<WebRemoteBindingStatus['state'], string> = {
  listening: 'Listening',
  pending: 'Waiting for interface',
  failed: 'Failed',
};

/**
 * Selections are keyed by a stable string so the checkbox list can round-trip
 * them without smuggling raw addresses through the DOM. Addresses change; the
 * user's intent shouldn't.
 */
function selectionKey(selection: WebRemoteBindSelection): string {
  switch (selection.kind) {
    case 'interface': return `i:${selection.interfaceName}:${selection.family}`;
    case 'address': return `a:${selection.address}`;
    case 'all': return `*:${selection.family}`;
  }
}

let webRemoteSelectionIndex = new Map<string, WebRemoteBindSelection>();

function selectedWebRemoteSelections(): WebRemoteBindSelection[] {
  if (!webRemoteInterfaceList) return [];
  return Array.from(webRemoteInterfaceList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
    .map(input => webRemoteSelectionIndex.get(input.value))
    .filter((selection): selection is WebRemoteBindSelection => selection !== undefined);
}

/**
 * Build the option list from the union of live interfaces and saved selections,
 * so an interface that is currently down still shows up (checked, pending)
 * rather than silently vanishing from the user's configuration.
 */
function renderWebRemoteInterfaces(state: WebRemoteState): void {
  if (!webRemoteInterfaceList) return;
  webRemoteInterfaceList.innerHTML = '';
  webRemoteSelectionIndex = new Map();

  const bindingByKey = new Map(state.bindings.map(binding => [selectionKey(binding.selection), binding]));
  const selectedKeys = new Set(state.selections.map(selectionKey));

  type Option = { key: string; selection: WebRemoteBindSelection; label: string; scope: InterfaceScope };
  const options: Option[] = [];
  const seen = new Set<string>();

  const push = (selection: WebRemoteBindSelection, label: string, scope: InterfaceScope) => {
    const key = selectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ key, selection, label, scope });
  };

  for (const iface of state.interfaces) {
    if (iface.family !== 'IPv4') continue;
    const selection: WebRemoteBindSelection = iface.scope === 'loopback'
      ? { kind: 'address', address: iface.address }
      : { kind: 'interface', interfaceName: iface.name, family: iface.family };
    push(selection, iface.label, iface.scope);
  }

  for (const selection of state.selections) {
    const binding = bindingByKey.get(selectionKey(selection));
    push(selection, binding?.label ?? describeSelection(selection), binding?.scope ?? 'private');
  }

  push({ kind: 'all', family: 'IPv4' }, 'All IPv4 interfaces (0.0.0.0)', 'public');

  if (options.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'settings-hint';
    empty.textContent = 'No network interfaces detected.';
    webRemoteInterfaceList.appendChild(empty);
    return;
  }

  for (const option of options) {
    webRemoteSelectionIndex.set(option.key, option.selection);

    const label = document.createElement('label');
    label.className = 'settings-checkbox-label web-remote-interface-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = option.key;
    checkbox.checked = selectedKeys.has(option.key);
    label.appendChild(checkbox);

    const text = document.createElement('span');
    text.textContent = option.label;
    text.title = SCOPE_WARNINGS[option.scope];
    label.appendChild(text);

    const binding = bindingByKey.get(option.key);
    if (binding && state.enabled) {
      const status = document.createElement('span');
      status.className = `web-remote-binding-state web-remote-binding-${binding.state}`;
      status.textContent = binding.state === 'listening' && binding.addresses.length > 0
        ? `${BINDING_STATE_LABELS[binding.state]} on ${binding.addresses.join(', ')}:${state.port}`
        : `${BINDING_STATE_LABELS[binding.state]} — ${binding.detail}`;
      label.appendChild(status);
    }

    webRemoteInterfaceList.appendChild(label);
  }
}

function describeSelection(selection: WebRemoteBindSelection): string {
  switch (selection.kind) {
    case 'interface': return `${selection.interfaceName} (${selection.family}, not currently available)`;
    case 'address': return selection.address;
    case 'all': return `All ${selection.family} interfaces`;
  }
}

function renderWebRemoteTls(state: WebRemoteState): void {
  if (webRemoteTlsMode) webRemoteTlsMode.value = state.tls.mode;
  webRemoteTlsCustom?.classList.toggle('hidden', state.tls.mode !== 'custom');

  if (!webRemoteTlsStatus) return;
  const loopbackOnly = state.selections.every(selection =>
    selection.kind === 'address' && (selection.address === '127.0.0.1' || selection.address === '::1'));

  if (state.tls.error) {
    webRemoteTlsStatus.textContent = `Certificate error: ${state.tls.error}`;
  } else if (state.tls.active) {
    webRemoteTlsStatus.textContent = state.tls.fingerprint
      ? `HTTPS is on. Certificate fingerprint (SHA-256): ${state.tls.fingerprint}`
      : 'HTTPS is on.';
  } else if (state.tls.mode === 'auto' && loopbackOnly) {
    webRemoteTlsStatus.textContent = 'Loopback only, so plain HTTP is used — localhost is already a secure origin.';
  } else if (state.tls.mode === 'off') {
    webRemoteTlsStatus.textContent = 'HTTPS is off. The microphone, clipboard and home-screen install will not work in the browser.';
  } else {
    webRemoteTlsStatus.textContent = 'HTTPS is not active yet.';
  }
}

function renderWebRemoteDevices(state: WebRemoteState): void {
  if (!webRemoteDeviceList) return;
  webRemoteDeviceList.innerHTML = '';

  if (state.devices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'settings-hint';
    empty.textContent = 'No paired browsers yet.';
    webRemoteDeviceList.appendChild(empty);
    return;
  }

  for (const device of state.devices) {
    const row = document.createElement('div');
    row.className = 'web-remote-device';

    const name = document.createElement('span');
    name.textContent = device.label;
    row.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'web-remote-device-meta';
    meta.textContent = `last seen ${new Date(device.lastSeenAt).toLocaleString()}`
      + (device.lastAddress ? ` from ${device.lastAddress}` : '');
    row.appendChild(meta);

    const revoke = document.createElement('button');
    revoke.className = 'workspace-btn';
    revoke.type = 'button';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      renderWebRemoteState(await whimAPI.revokeWebRemoteDevice(device.id));
    });
    row.appendChild(revoke);

    webRemoteDeviceList.appendChild(row);
  }
}

/**
 * A single `lastError` string told you nothing about what had actually
 * happened over the connection. This is the smallest thing that lets you
 * answer "what has been talking to my machine?".
 */
function renderWebRemoteActivity(state: WebRemoteState): void {
  if (!webRemoteActivityList) return;
  webRemoteActivityList.innerHTML = '';

  if (state.activity.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'settings-hint';
    empty.textContent = 'No requests yet.';
    webRemoteActivityList.appendChild(empty);
    return;
  }

  for (const entry of state.activity) {
    const row = document.createElement('div');
    row.className = `web-remote-activity ${entry.outcome}`;

    const when = document.createElement('span');
    when.className = 'web-remote-activity-time';
    when.textContent = new Date(entry.at).toLocaleTimeString();
    row.appendChild(when);

    const what = document.createElement('span');
    what.className = 'web-remote-activity-what';
    what.textContent = entry.channel ? entry.channel : `${entry.method} ${entry.path}`;
    row.appendChild(what);

    const who = document.createElement('span');
    who.className = 'web-remote-activity-who';
    who.textContent = `${entry.identity} · ${entry.remoteAddress}`;
    row.appendChild(who);

    const status = document.createElement('span');
    status.className = 'web-remote-activity-status';
    status.textContent = `${entry.status} · ${entry.durationMs}ms`;
    row.appendChild(status);

    webRemoteActivityList.appendChild(row);
  }
}

function renderWebRemoteState(state: WebRemoteState): void {
  if (webRemoteEnabledCb) webRemoteEnabledCb.checked = state.enabled;
  if (webRemotePortInput) webRemotePortInput.value = String(state.port);
  if (webRemoteTokenInput) webRemoteTokenInput.value = state.token;
  if (webRemoteTlsCert) webRemoteTlsCert.value = webRemoteTlsCert.value || '';
  if (webRemoteAllowedHosts) webRemoteAllowedHosts.value = state.allowedHosts.join(', ');
  renderWebRemoteInterfaces(state);
  renderWebRemoteTls(state);
  renderWebRemoteDevices(state);
  renderWebRemoteActivity(state);

  if (webRemoteUrlList) {
    webRemoteUrlList.innerHTML = '';
    for (const url of state.urls) {
      const row = document.createElement('div');
      row.className = 'web-remote-url';
      row.textContent = url;
      webRemoteUrlList.appendChild(row);
    }
  }

  if (webRemoteQr) {
    if (state.qrDataUrl && state.enabled) {
      webRemoteQr.src = state.qrDataUrl;
      webRemoteQr.classList.remove('hidden');
    } else {
      webRemoteQr.removeAttribute('src');
      webRemoteQr.classList.add('hidden');
    }
  }

  if (!state.enabled) {
    setWebRemoteStatus('Remote web access is off.');
  } else if (state.running) {
    setWebRemoteStatus("Remote web access is running. Scan the QR code to open whim on your phone.");
  } else if (state.bindings.some(binding => binding.state === 'listening')) {
    // Partially bound: serving on what's up, still waiting on the rest.
    const waiting = state.bindings.filter(binding => binding.state !== 'listening');
    setWebRemoteStatus(
      `Running, but ${waiting.length} selected interface${waiting.length === 1 ? '' : 's'} not yet bound: `
        + waiting.map(binding => `${binding.label} — ${binding.detail}`).join('; '),
      true,
    );
  } else {
    setWebRemoteStatus(state.error || 'Remote web access is enabled but not running.', true);
  }
}

async function loadWebRemoteSetting(): Promise<void> {
  if (!webRemoteEnabledCb) return;
  try {
    renderWebRemoteState(await whimAPI.getWebRemoteState());
  } catch (err: any) {
    setWebRemoteStatus(err?.message || 'Failed to load remote web settings.', true);
  }
}

if (webRemoteEnabledCb) {
  webRemoteEnabledCb.addEventListener('change', async () => {
    setWebRemoteStatus(webRemoteEnabledCb.checked ? 'Starting remote web access…' : 'Stopping remote web access…');
    try {
      renderWebRemoteState(await whimAPI.setWebRemoteEnabled(webRemoteEnabledCb.checked));
    } catch (err: any) {
      setWebRemoteStatus(err?.message || 'Failed to update remote web access.', true);
      await loadWebRemoteSetting();
    }
  });
}

if (webRemoteSaveBtn) {
  webRemoteSaveBtn.addEventListener('click', async () => {
    const port = Number(webRemotePortInput?.value || 0);
    const selections = selectedWebRemoteSelections();
    if (selections.length === 0) {
      setWebRemoteStatus('Select at least one network interface.', true);
      return;
    }
    setWebRemoteStatus('Saving remote web settings…');
    const result = await whimAPI.setWebRemoteConfig({
      port,
      selections,
      tlsMode: (webRemoteTlsMode?.value as WebRemoteTlsMode | undefined) ?? undefined,
      tlsCertPath: webRemoteTlsCert?.value.trim(),
      tlsKeyPath: webRemoteTlsKey?.value.trim(),
      allowedHosts: (webRemoteAllowedHosts?.value ?? '')
        .split(',')
        .map(host => host.trim())
        .filter(Boolean),
    });
    if ('error' in result) {
      setWebRemoteStatus(result.error, true);
      return;
    }
    renderWebRemoteState(result);
  });
}

if (webRemoteRegenerateBtn) {
  webRemoteRegenerateBtn.addEventListener('click', async () => {
    setWebRemoteStatus('Regenerating token and signing out every paired browser…');
    renderWebRemoteState(await whimAPI.regenerateWebRemoteToken());
  });
}

if (webRemoteTlsMode) {
  webRemoteTlsMode.addEventListener('change', () => {
    webRemoteTlsCustom?.classList.toggle('hidden', webRemoteTlsMode.value !== 'custom');
  });
}

// ── Comment trigger setting ──────────────────────────────
const commentHoverCb = document.getElementById('comment-hover-cb') as HTMLInputElement | null;

async function loadCommentTriggerSetting(): Promise<void> {
  if (!commentHoverCb) return;
  const val = await whimAPI.getSetting('comment_trigger');
  commentHoverCb.checked = val === 'hover-or-caret';
}

if (commentHoverCb) {
  commentHoverCb.addEventListener('change', () => {
    whimAPI.setSetting('comment_trigger', commentHoverCb.checked ? 'hover-or-caret' : 'caret');
  });
}

// ── Update settings (Settings → General → Updates) ───────
const updateVersionEl = document.getElementById('update-current-version');
const updateLineEl = document.getElementById('update-settings-line');
const updateCheckBtn = document.getElementById('update-check-btn') as HTMLButtonElement | null;
const updateOpenLogBtn = document.getElementById('update-open-log-btn') as HTMLButtonElement | null;
const autoDownloadUpdatesCb = document.getElementById('auto-download-updates-cb') as HTMLInputElement | null;

function formatCheckedAt(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function renderUpdateSettings(state: UpdateState): void {
  if (updateVersionEl) {
    updateVersionEl.textContent = state.currentVersion ? `whim v${state.currentVersion}` : 'whim';
  }
  if (updateCheckBtn) {
    updateCheckBtn.disabled = state.status === 'checking' || state.status === 'downloading';
  }
  if (!updateLineEl) return;

  updateLineEl.classList.remove('update-settings-line--error');
  const checked = state.lastCheckedAt ? ` · last checked ${formatCheckedAt(state.lastCheckedAt)}` : '';

  switch (state.status) {
    case 'disabled':
      updateLineEl.textContent = 'Auto-updates run only in the installed app, not in dev builds.';
      break;
    case 'checking':
      updateLineEl.textContent = 'Checking for updates…';
      break;
    case 'available':
      updateLineEl.textContent = `Update available${state.version ? ` (v${state.version})` : ''}.`;
      break;
    case 'downloading':
      updateLineEl.textContent = `Downloading update${state.version ? ` (v${state.version})` : ''}… ${state.progress ?? 0}%`;
      break;
    case 'downloaded':
      updateLineEl.textContent = `Update ready${state.version ? ` (v${state.version})` : ''} — restart to apply.`;
      break;
    case 'up-to-date':
      updateLineEl.textContent = `You're on the latest version${checked}.`;
      break;
    case 'error':
      updateLineEl.textContent = `Update check failed${state.error ? `: ${state.error}` : ''}.`;
      updateLineEl.classList.add('update-settings-line--error');
      break;
    case 'idle':
    default:
      updateLineEl.textContent = state.lastCheckedAt ? `You're on the latest version${checked}.` : 'Ready.';
      break;
  }
}

async function loadUpdateSettings(): Promise<void> {
  if (autoDownloadUpdatesCb) {
    const val = await whimAPI.getSetting('auto_download_updates');
    autoDownloadUpdatesCb.checked = val !== false; // default true
  }
  try {
    renderUpdateSettings(await bridgeApi.getUpdateState());
  } catch {
    /* updater not ready yet — the live subscription will fill this in */
  }
}

if (updateCheckBtn) {
  updateCheckBtn.addEventListener('click', () => {
    if (updateLineEl) updateLineEl.textContent = 'Checking for updates…';
    updateCheckBtn.disabled = true;
    bridgeApi.checkForUpdate();
  });
}

if (updateOpenLogBtn) {
  updateOpenLogBtn.addEventListener('click', async () => {
    const res = await bridgeApi.openUpdateLog();
    if (res && 'error' in res && updateLineEl) {
      updateLineEl.textContent = `Couldn't open log: ${res.error}`;
      updateLineEl.classList.add('update-settings-line--error');
    }
  });
}

if (autoDownloadUpdatesCb) {
  autoDownloadUpdatesCb.addEventListener('change', () => {
    whimAPI.setSetting('auto_download_updates', String(autoDownloadUpdatesCb.checked));
  });
}

// Live-update the Updates panel as the main process broadcasts state changes.
bridgeApi.onUpdateStateChanged((state) => {
  renderUpdateSettings(state);
});

// ── Settings tabs ───────────────────────────────────────
const SETTINGS_TAB_KEY = 'whim.settingsTab';
const SETTINGS_TAB_TITLES: Record<string, string> = {
  general: 'General',
  environment: 'Environment',
  remote: 'Remote',
  tools: 'Tools',
  personas: 'Agents',
  hotkeys: 'Hotkeys',
};
function initSettingsTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.settings-tab-btn');
  const panels = document.querySelectorAll<HTMLElement>('.settings-tab-panel');
  const titleEl = document.getElementById('settings-active-title');
  if (!tabs.length || !panels.length) return;
  const stored = localStorage.getItem(SETTINGS_TAB_KEY);
  const activate = (name: string) => {
    let matched = false;
    tabs.forEach(t => {
      const isActive = t.dataset.tab === name;
      t.classList.toggle('active', isActive);
      if (isActive) matched = true;
    });
    panels.forEach(p => {
      p.classList.toggle('active', p.dataset.tab === name);
    });
    if (matched) {
      if (titleEl) titleEl.textContent = SETTINGS_TAB_TITLES[name] ?? 'Settings';
      try { localStorage.setItem(SETTINGS_TAB_KEY, name); } catch { /* ignore */ }
    }
  };
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      if (t.dataset.tab) activate(t.dataset.tab);
    });
  });
  if (stored) {
    activate(stored);
  }
  // Fallback: if no tab is active (e.g. stored tab was removed), activate general
  const anyActive = Array.from(tabs).some(t => t.classList.contains('active'));
  if (!anyActive) activate('general');
}
initSettingsTabs();

// ── Hotkeys tab ────────────────────────────────────────
const HOTKEY_LABELS: Record<string, string> = {
  toggleWindow: 'Toggle Window',
  canvasPinToTop: 'Pin to Top (Canvas)',
  canvasNewPage: 'New Page (Canvas)',
  popOutWindow: 'Pop Out in New Window',
  toggleSearch: 'Toggle Search',
  close: 'Close / Back',
  navigateUp: 'Navigate Up',
  navigateDown: 'Navigate Down',
  openSubmit: 'Open / Submit',
  stopRecording: 'Stop Recording',
};

const HOTKEY_CATEGORIES: Record<string, string[]> = {
  'Global': ['toggleWindow'],
  'Canvas': ['canvasPinToTop', 'canvasNewPage'],
  'Actions': ['popOutWindow', 'toggleSearch'],
  'Navigation': ['close', 'navigateUp', 'navigateDown', 'openSubmit', 'stopRecording'],
};

const DEFAULT_HOTKEYS: Record<string, string> = {
  toggleWindow: 'CommandOrControl+Shift+Space',
  canvasPinToTop: 'CommandOrControl+Shift+T',
  canvasNewPage: 'CommandOrControl+Shift+N',
  popOutWindow: 'CommandOrControl+Enter',
  toggleSearch: 'Shift+Tab',
  close: 'Escape',
  navigateUp: 'ArrowUp',
  navigateDown: 'ArrowDown',
  openSubmit: 'Enter',
  stopRecording: 'Space',
};

// Current hotkeys loaded from config — renderer-side cache
let currentHotkeys: Record<string, string> = { ...DEFAULT_HOTKEYS };
let hotkeyRecordingKey: string | null = null;
let hotkeyFeedback: { key: string; message: string } | null = null;
let hotkeyFeedbackTimer: number | null = null;

const hotkeyPlatform = navigator.platform;
const hotkeyCleanupByElement = new WeakMap<HTMLElement, () => void>();

function findConflict(accel: string, excludeKey: string): string | null {
  for (const [k, v] of Object.entries(currentHotkeys)) {
    if (k !== excludeKey && acceleratorsConflict(v, accel, hotkeyPlatform)) {
      return HOTKEY_LABELS[k] || k;
    }
  }
  return null;
}

function setHotkeyFeedback(key: string, message: string): void {
  hotkeyFeedback = { key, message };
  if (hotkeyFeedbackTimer !== null) {
    window.clearTimeout(hotkeyFeedbackTimer);
  }
  hotkeyFeedbackTimer = window.setTimeout(() => {
    if (hotkeyFeedback?.key === key && hotkeyFeedback.message === message) {
      hotkeyFeedback = null;
      hotkeyFeedbackTimer = null;
      renderHotkeysTab();
    }
  }, 3000);
}

const hotkeysList = document.getElementById('hotkeys-list') as HTMLDivElement;
const hotkeysResetAll = document.getElementById('hotkeys-reset-all') as HTMLButtonElement;

function clearHotkeyFeedback(): void {
  hotkeyFeedback = null;
  if (hotkeyFeedbackTimer !== null) {
    window.clearTimeout(hotkeyFeedbackTimer);
    hotkeyFeedbackTimer = null;
  }
}

function renderHotkeysTab(): void {
  hotkeysList.innerHTML = '';
  for (const [category, keys] of Object.entries(HOTKEY_CATEGORIES)) {
    const titleEl = document.createElement('div');
    titleEl.className = 'hotkey-group-title';
    titleEl.textContent = category;
    hotkeysList.appendChild(titleEl);

    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'hotkey-row';
      row.dataset.hotkeyKey = key;

      const label = document.createElement('div');
      label.className = 'hotkey-label';
      label.textContent = HOTKEY_LABELS[key] || key;

      const binding = document.createElement('button');
      binding.className = 'hotkey-binding';
      binding.type = 'button';
      const accel = currentHotkeys[key] || DEFAULT_HOTKEYS[key];
      binding.textContent = formatAccelerator(accel, hotkeyPlatform);
      if (accel !== DEFAULT_HOTKEYS[key]) {
        binding.classList.add('modified');
      }
      binding.title = 'Click to change';
      binding.setAttribute('aria-label', `Change ${HOTKEY_LABELS[key] || key} hotkey`);

      binding.addEventListener('click', () => {
        startHotkeyRecording(key, binding);
      });

      const resetBtn = document.createElement('button');
      resetBtn.className = 'hotkey-reset-btn';
      resetBtn.textContent = '↩';
      resetBtn.title = 'Reset to default';
      if (accel === DEFAULT_HOTKEYS[key]) {
        resetBtn.style.visibility = 'hidden';
      }
      resetBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await whimAPI.resetHotkeys(key);
        currentHotkeys[key] = DEFAULT_HOTKEYS[key];
        renderHotkeysTab();
      });

      row.appendChild(label);
      row.appendChild(binding);
      row.appendChild(resetBtn);
      if (hotkeyFeedback?.key === key) {
        const feedbackEl = document.createElement('span');
        feedbackEl.className = 'hotkey-conflict';
        feedbackEl.textContent = `⚠ ${hotkeyFeedback.message}`;
        row.appendChild(feedbackEl);
      }
      hotkeysList.appendChild(row);
    }
  }
}

function startHotkeyRecording(key: string, bindingEl: HTMLElement): void {
  // Cancel any previous recording
  stopRecording_hotkey();
  clearHotkeyFeedback();

  hotkeyRecordingKey = key;
  bindingEl.classList.add('recording');
  bindingEl.textContent = 'Press shortcut…';

  const handler = async (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (e.key === 'Escape') {
      stopRecording_hotkey();
      renderHotkeysTab();
      return;
    }

    const accel = keyboardEventToAccelerator(e, hotkeyPlatform);
    if (!accel) {
      const modifiers = modifierEventToAccelerator(e, hotkeyPlatform);
      bindingEl.textContent = modifiers
        ? `${formatAccelerator(modifiers, hotkeyPlatform)}…`
        : 'Press shortcut…';
      return;
    }

    const conflict = findConflict(accel, key);
    if (conflict) {
      bindingEl.parentElement?.querySelectorAll('.hotkey-conflict').forEach(el => el.remove());
      bindingEl.classList.remove('recording');
      bindingEl.textContent = formatAccelerator(accel, hotkeyPlatform);
      // Show conflict warning — block the save, let user try again
      const conflictEl = document.createElement('span');
      conflictEl.className = 'hotkey-conflict';
      conflictEl.textContent = `⚠ Conflicts with "${conflict}" — press a different combo`;
      bindingEl.parentElement?.appendChild(conflictEl);
      setTimeout(() => {
        conflictEl.remove();
        // Re-enter recording so user can try again
        bindingEl.classList.add('recording');
        bindingEl.textContent = 'Press shortcut…';
      }, 1500);
      return;
    }

    document.removeEventListener('keydown', handler, true);
    await saveHotkeyAndStop(key, accel);
  };

  document.addEventListener('keydown', handler, true);

  // Store cleanup reference
  hotkeyCleanupByElement.set(bindingEl, () => {
    document.removeEventListener('keydown', handler, true);
  });
}

async function saveHotkeyAndStop(key: string, accel: string): Promise<void> {
  const result = await whimAPI.setHotkey(key, accel);
  if (result.error) {
    setHotkeyFeedback(key, result.error);
  } else {
    clearHotkeyFeedback();
    currentHotkeys[key] = accel;
  }
  hotkeyRecordingKey = null;
  renderHotkeysTab();
}

function stopRecording_hotkey(): void {
  if (hotkeyRecordingKey) {
    const bindingEl = hotkeysList.querySelector(
      `[data-hotkey-key="${hotkeyRecordingKey}"] .hotkey-binding`
    ) as HTMLElement | null;
    if (bindingEl) {
      bindingEl.classList.remove('recording');
      hotkeyCleanupByElement.get(bindingEl)?.();
      hotkeyCleanupByElement.delete(bindingEl);
    }
    hotkeyRecordingKey = null;
  }
}

async function loadHotkeys(): Promise<void> {
  try {
    const hotkeys = await whimAPI.getHotkeys();
    currentHotkeys = hotkeys as Record<string, string>;
  } catch {
    currentHotkeys = { ...DEFAULT_HOTKEYS };
  }
  renderHotkeysTab();
  syncToggleHotkeyLabels();
}

hotkeysResetAll.addEventListener('click', async () => {
  await whimAPI.resetHotkeys();
  currentHotkeys = { ...DEFAULT_HOTKEYS };
  renderHotkeysTab();
});

// Load hotkeys on init, and follow changes made from any other window
// (e.g. the settings popout) so renderer-level shortcuts don't go stale.
loadHotkeys();
whimAPI.onHotkeysChanged(() => { void loadHotkeys(); });

/**
 * Check if a KeyboardEvent matches an Electron accelerator string from the hotkey config.
 * e.g. matchesHotkey(e, 'toggleWindow') checks against currentHotkeys.toggleWindow
 */
function matchesHotkey(e: KeyboardEvent, hotkeyName: string): boolean {
  const accel = currentHotkeys[hotkeyName];
  if (!accel) return false;
  return eventMatchesAccelerator(e, accel, hotkeyPlatform);
}

// ── Sandbox policy form helpers ─────────────────────────

function pathListToTextarea(paths: string[]): string {
  return (paths || []).join('\n');
}

function textareaToPathList(text: string): string[] {
  return text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0).slice(0, 64);
}

/**
 * Render an editable sandbox-policy form into `container`. Returns a
 * `getPolicy()` accessor that reads the current values back as a SandboxPolicy.
 */
function renderSandboxPolicyForm(
  container: HTMLElement,
  initial: SandboxPolicy,
  opts?: { idPrefix?: string },
): { getPolicy: () => SandboxPolicy; setPolicy: (p: SandboxPolicy) => void } {
  const id = (s: string) => `${opts?.idPrefix ?? 'sandbox'}-${s}`;
  container.innerHTML = '';

  function checkbox(name: string, label: string, checked: boolean, hint?: string): HTMLInputElement {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id(name);
    cb.checked = checked;
    lbl.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = label;
    lbl.appendChild(span);
    container.appendChild(lbl);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'sandbox-field-hint';
      h.textContent = hint;
      container.appendChild(h);
    }
    return cb;
  }

  function pathTextarea(name: string, label: string, value: string[], hint?: string): HTMLTextAreaElement {
    const title = document.createElement('div');
    title.className = 'sandbox-section-title';
    title.textContent = label;
    container.appendChild(title);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'sandbox-field-hint';
      h.textContent = hint;
      container.appendChild(h);
    }
    const ta = document.createElement('textarea');
    ta.id = id(name);
    ta.value = pathListToTextarea(value);
    ta.placeholder = 'One path per line';
    ta.spellcheck = false;
    container.appendChild(ta);
    return ta;
  }

  // Filesystem section
  const fsTitle = document.createElement('div');
  fsTitle.className = 'sandbox-section-title';
  fsTitle.textContent = 'Filesystem';
  container.appendChild(fsTitle);

  const scopeBox = checkbox(
    'scope',
    'Read & write inside the space folder',
    initial.scopeToSpaceFolder,
    'When checked, the agent can read and write anywhere inside its space folder. Recommended ON.',
  );
  const rwArea = pathTextarea('rw', 'Extra read-write paths', initial.extraReadwritePaths,
    'Optional. Each line is an absolute path the agent may read AND write.');
  const roArea = pathTextarea('ro', 'Extra read-only paths', initial.extraReadonlyPaths,
    'Optional. Each line is an absolute path the agent may read only.');
  const denyArea = pathTextarea('deny', 'Denied paths', initial.extraDeniedPaths,
    'Optional. Each line is an absolute path the agent must never access (overrides RW/RO).');

  // Tool surface section
  const toolsTitle = document.createElement('div');
  toolsTitle.className = 'sandbox-section-title';
  toolsTitle.textContent = 'Tool surface';
  container.appendChild(toolsTitle);

  const mcpBox = checkbox(
    'mcp',
    'Allow MCP servers',
    initial.allowMcpServers,
    'When unchecked, sandboxed agents launch with MCP servers hidden. Default OFF.',
  );
  const wfBox = checkbox(
    'web-fetch',
    'Allow web_fetch tool',
    initial.allowWebFetch,
    'When unchecked, sandboxed agents launch without the web_fetch tool. Default OFF.',
  );

  // Network section
  const netTitle = document.createElement('div');
  netTitle.className = 'sandbox-section-title';
  netTitle.textContent = 'Network (applies to shell sandbox)';
  container.appendChild(netTitle);

  const outBox = checkbox(
    'allow-out',
    'Allow outbound network',
    initial.allowOutbound,
    'When checked, shell commands inside the sandbox may reach the internet (e.g. git fetch). Default OFF.',
  );
  const localBox = checkbox(
    'allow-local',
    'Allow local network',
    initial.allowLocalNetwork,
    'When checked, shell commands may reach localhost / LAN. Default OFF.',
  );

  // Enforcement section — lets the user pick between defense-in-depth (host
  // guards on top of MXC) and MXC-only (test mode that disables host guards
  // so denials come from MXC's AppContainer alone).
  const enforceTitle = document.createElement('div');
  enforceTitle.className = 'sandbox-section-title';
  enforceTitle.textContent = 'Enforcement';
  container.appendChild(enforceTitle);

  const enforceWrap = document.createElement('label');
  const enforceLbl = document.createElement('span');
  enforceLbl.textContent = 'Enforcement mode';
  enforceWrap.appendChild(enforceLbl);
  const enforceSelect = document.createElement('select');
  enforceSelect.id = id('enforcement');
  const optBoth = document.createElement('option');
  optBoth.value = 'both';
  optBoth.textContent = 'Both: host guards + MXC (Recommended)';
  enforceSelect.appendChild(optBoth);
  const optMxc = document.createElement('option');
  optMxc.value = 'mxc-only';
  optMxc.textContent = 'MXC only (test mode — host guards disabled)';
  enforceSelect.appendChild(optMxc);
  enforceSelect.value = initial.enforcementMode === 'mxc-only' ? 'mxc-only' : 'both';
  enforceWrap.appendChild(enforceSelect);
  container.appendChild(enforceWrap);

  const enforceHint = document.createElement('div');
  enforceHint.className = 'sandbox-field-hint';
  enforceHint.textContent =
    'Both: host-side read-only classifier + path-policy hook deny most things before MXC sees them. ' +
    'MXC only: skip those host guards so MXC AppContainer is the sole enforcer for shell commands. ' +
    'Use MXC-only to verify MXC is actually doing the work — note that path-bearing SDK tools ' +
    '(view/edit/create/glob/grep) are NOT covered by MXC and become unrestricted in this mode.';
  container.appendChild(enforceHint);

  const enforceWarn = document.createElement('div');
  enforceWarn.className = 'sandbox-field-hint';
  enforceWarn.style.color = '#c0392b';
  enforceWarn.style.fontWeight = '600';
  enforceWarn.textContent = '⚠ MXC-only is a test mode. Use only to verify MXC enforcement; less safe than Both.';
  enforceWarn.style.display = enforceSelect.value === 'mxc-only' ? '' : 'none';
  container.appendChild(enforceWarn);
  enforceSelect.addEventListener('change', () => {
    enforceWarn.style.display = enforceSelect.value === 'mxc-only' ? '' : 'none';
  });

  function getPolicy(): SandboxPolicy {
    return {
      scopeToSpaceFolder: scopeBox.checked,
      extraReadwritePaths: textareaToPathList(rwArea.value),
      extraReadonlyPaths: textareaToPathList(roArea.value),
      extraDeniedPaths: textareaToPathList(denyArea.value),
      allowMcpServers: mcpBox.checked,
      allowWebFetch: wfBox.checked,
      allowOutbound: outBox.checked,
      allowLocalNetwork: localBox.checked,
      enforcementMode: enforceSelect.value === 'mxc-only' ? 'mxc-only' : 'both',
    };
  }

  function setPolicy(p: SandboxPolicy): void {
    scopeBox.checked = p.scopeToSpaceFolder;
    rwArea.value = pathListToTextarea(p.extraReadwritePaths);
    roArea.value = pathListToTextarea(p.extraReadonlyPaths);
    denyArea.value = pathListToTextarea(p.extraDeniedPaths);
    mcpBox.checked = p.allowMcpServers;
    wfBox.checked = p.allowWebFetch;
    outBox.checked = p.allowOutbound;
    localBox.checked = p.allowLocalNetwork;
    enforceSelect.value = p.enforcementMode === 'mxc-only' ? 'mxc-only' : 'both';
    enforceWarn.style.display = enforceSelect.value === 'mxc-only' ? '' : 'none';
  }

  return { getPolicy, setPolicy };
}

// ── Default sandbox policy form (now managed through @agent editor) ──
// Legacy function kept as no-op for any remaining calls
let sandboxDefaultFormApi: { getPolicy: () => SandboxPolicy; setPolicy: (p: SandboxPolicy) => void } | null = null;

async function renderDefaultSandboxPolicyForm(): Promise<void> {
  // No-op: sandbox policy is now configured through the @agent editor in the Agents tab
}
renderDefaultSandboxPolicyForm();

// ── Inline editing ──────────────────────────────────────
// @ts-ignore - called from onclick in HTML
async function editDate(spaceId: string): Promise<void> {
  const space = spaces.find(i => i.id === spaceId);
  if (!space) return;

  const itemEl = listEl.querySelector(`[data-id="${spaceId}"]`);
  const badge = itemEl?.querySelector('.due-badge') as HTMLElement;
  if (!badge || badge.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit-input inline-edit-date';
  input.placeholder = 'e.g. next Friday, May 1...';
  input.value = space.due_at || '';

  badge.textContent = '';
  badge.appendChild(input);
  input.focus();
  input.select();

  const save = async () => {
    const dateText = input.value.trim();
    if (dateText) {
      badge.textContent = '📅 resolving...';
      const resolved = await whimAPI.resolveDate(dateText);
      await whimAPI.update(spaceId, { due_at: resolved.due_at, due_at_utc: resolved.due_at_utc });
    } else {
      // Clear the date
      await whimAPI.update(spaceId, { due_at: null, due_at_utc: null });
    }
    await loadSpaces();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { loadSpaces(); }
  });
  input.addEventListener('blur', save);
}

(window as any).editDate = editDate;

// ── Body toggle & edit ──────────────────────────────────
function toggleBody(el: HTMLElement): void {
  const isCollapsed = el.classList.contains('collapsed');
  const preview = el.querySelector('.body-preview') as HTMLElement;
  const full = el.querySelector('.body-full') as HTMLElement;
  if (!preview || !full) return;

  if (isCollapsed) {
    el.classList.remove('collapsed');
    el.classList.add('expanded');
    preview.classList.add('hidden');
    full.classList.remove('hidden');
  } else {
    el.classList.add('collapsed');
    el.classList.remove('expanded');
    preview.classList.remove('hidden');
    full.classList.add('hidden');
  }
}

(window as any).toggleBody = toggleBody;

async function editBody(spaceId: string): Promise<void> {
  const space = spaces.find(i => i.id === spaceId);
  if (!space || !space.body) return;

  const itemEl = listEl.querySelector(`[data-id="${spaceId}"]`);
  let bodyEl = itemEl?.querySelector('.whim-body') as HTMLElement | null;

  // If no body element exists, create one
  const contentEl = itemEl?.querySelector('.whim-content') as HTMLElement;
  if (!contentEl) return;

  if (!bodyEl) {
    bodyEl = document.createElement('div');
    bodyEl.className = 'space-body expanded';
    const descEl = contentEl.querySelector('.whim-desc');
    if (descEl) descEl.after(bodyEl);
    else contentEl.prepend(bodyEl);
  }

  if (bodyEl.querySelector('textarea')) return; // Already editing

  const textarea = document.createElement('textarea');
  textarea.className = 'inline-edit-body';
  textarea.value = space.body;
  textarea.rows = Math.min(space.body.split('\n').length + 1, 8);

  bodyEl.innerHTML = '';
  bodyEl.classList.remove('collapsed');
  bodyEl.classList.add('expanded');
  bodyEl.appendChild(textarea);
  textarea.focus();

  const save = async () => {
    const newBody = textarea.value.trim();
    if (newBody && newBody !== space.body) {
      await whimAPI.update(spaceId, { body: newBody });
    }
    await loadSpaces();
  };

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { loadSpaces(); }
  });
  textarea.addEventListener('blur', save);
}

(window as any).editBody = editBody;

// ── Attachments ─────────────────────────────────────────
async function addAttachment(spaceId: string): Promise<void> {
  const space = spaces.find(i => i.id === spaceId);
  if (!space) return;

  const itemEl = listEl.querySelector(`[data-id="${spaceId}"]`);
  const contentEl = itemEl?.querySelector('.whim-content') as HTMLElement;
  if (!contentEl) return;

  // Check if already has an input open
  if (contentEl.querySelector('.attachment-input-row')) return;

  const row = document.createElement('div');
  row.className = 'attachment-input-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit-input attachment-url-input';
  input.placeholder = 'Paste a URL...';
  row.appendChild(input);

  const metaEl = contentEl.querySelector('.whim-meta');
  if (metaEl) metaEl.before(row);
  else contentEl.appendChild(row);
  input.focus();

  const save = async () => {
    const url = input.value.trim();
    if (url && /^https?:\/\//i.test(url)) {
      // Auto-name from URL hostname + path
      let name = '';
      try {
        const u = new URL(url);
        const pathParts = u.pathname.split('/').filter(Boolean);
        name = pathParts.length > 0 ? pathParts[pathParts.length - 1] : u.hostname;
      } catch {
        name = url.slice(0, 40);
      }
      const attachments = [...(space.attachments || []), { type: 'url' as const, name, url }];
      await whimAPI.update(spaceId, { attachments });
    } else if (url) {
      // Not a valid URL — just remove the input
    }
    row.remove();
    await loadSpaces();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { row.remove(); }
  });
  input.addEventListener('blur', save);
}

async function removeAttachment(spaceId: string, index: number): Promise<void> {
  const space = spaces.find(i => i.id === spaceId);
  if (!space) return;
  const attachments = [...(space.attachments || [])];
  attachments.splice(index, 1);
  await whimAPI.update(spaceId, { attachments });
  await loadSpaces();
}

(window as any).addAttachment = addAttachment;
(window as any).removeAttachment = removeAttachment;

// @ts-ignore - called from onclick in query result
function dismissQuery(): void {
  queryResult.classList.add('hidden');
  listEl.classList.remove('hidden');
}
(window as any).dismissQuery = dismissQuery;

// ── Focus mode ──────────────────────────────────────────
async function setFocus(spaceId: string): Promise<void> {
  if (focusedSpaceId === spaceId) {
    // Toggle off
    clearFocus();
    return;
  }
  focusedSpaceId = spaceId;
  spaceStore.setFocusedSpace(spaceId);
  await whimAPI.setSetting('focused_intent', spaceId);
  updateFocusBanner();
  render();
}

function clearFocus(): void {
  focusedSpaceId = null;
  spaceStore.setFocusedSpace(null);
  whimAPI.setSetting('focused_intent', '');
  focusBanner.classList.add('hidden');
  render();
}

function updateFocusBanner(): void {
  // React owns the focus banner (FocusBanner component reads
  // spaceStore.focusedSpaceId + spaces). Legacy callers no-op during the
  // migration, except for the "drop focus if space is missing or done"
  // guard which still applies to legacy state.
  if (!focusedSpaceId) return;
  const space = spaces.find(i => i.id === focusedSpaceId);
  if (!space || space.status === 'done') {
    clearFocus();
  }
}

focusDone.addEventListener('click', async () => {
  if (!focusedSpaceId) return;
  await whimAPI.update(focusedSpaceId, { status: 'done' });
  clearFocus();
  await loadSpaces();
});

focusClear.addEventListener('click', clearFocus);

async function loadFocusState(): Promise<void> {
  const saved = await whimAPI.getSetting('focused_intent');
  if (saved) {
    focusedSpaceId = saved;
    spaceStore.setFocusedSpace(saved);
    updateFocusBanner();
  }
}

(window as any).setFocus = setFocus;

// ── Timeline view ───────────────────────────────────────
function showTimeline(): void {
  mainView.classList.add('hidden');
  hideSettings();
  timelineView.classList.remove('hidden');
  loadTimeline();
}

function hideTimeline(): void {
  timelineView.classList.add('hidden');
  mainView.classList.remove('hidden');
  descInput.focus();
}

timelineBtn?.addEventListener('click', showTimeline);
timelineBack.addEventListener('click', hideTimeline);

async function loadTimeline(): Promise<void> {
  const events = await whimAPI.listEvents(200);

  if (events.length === 0) {
    timelineContent.innerHTML = `
      <div class="empty-state">
        <span class="icon">📋</span>
        <span>No activity yet.</span>
      </div>`;
    return;
  }

  // Group events by date
  const groups = new Map<string, typeof events>();
  for (const event of events) {
    const date = new Date(event.created_at).toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric'
    });
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(event);
  }

  let html = '';
  for (const [date, dateEvents] of groups) {
    html += `<div class="timeline-date-group">
      <div class="timeline-date">${date}</div>`;

    for (const event of dateEvents) {
      const time = new Date(event.created_at).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit'
      });
      const icon = event.event_type === 'completed' ? '✅' :
                   event.event_type === 'recycled' ? '↻' :
                   event.event_type === 'recurrence_dismissed' ? '✕' : '•';
      const label = event.event_type === 'completed' ? 'Completed' :
                    event.event_type === 'recycled' ? 'Rescheduled' :
                    event.event_type === 'recurrence_dismissed' ? 'Recurrence dismissed' :
                    event.event_type;
      const desc = event.space_description ? escapeHtml(event.space_description) : 'Unknown space';
      const sessionTag = event.session_id ? '<span class="timeline-session-tag">has session</span>' : '';

      html += `
        <div class="timeline-event">
          <span class="timeline-icon">${icon}</span>
          <div class="timeline-event-content">
            <div class="timeline-event-desc">${desc}</div>
            <div class="timeline-event-meta">
              <span>${label}</span>
              ${event.due_at ? `<span>📅 ${escapeHtml(event.due_at)}</span>` : ''}
              ${sessionTag}
              <span>${time}</span>
            </div>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  timelineContent.innerHTML = html;
}


// @ts-ignore - called from onclick in HTML
async function toggleStatus(id: string): Promise<void> {
  const space = spaces.find(i => i.id === id);
  if (!space) return;
  const newStatus = space.status === 'done' ? 'captured' : 'done';
  await whimAPI.update(id, { status: newStatus });
  await loadSpaces();
}

// @ts-ignore - called from onclick in HTML
async function deleteSpace(id: string): Promise<void> {
  if (!confirm('Delete this space? Its folder and files will be permanently removed.')) return;
  await whimAPI.delete(id);
  await loadSpaces();
}

(window as any).toggleStatus = toggleStatus;
(window as any).deleteSpace = deleteSpace;

// @ts-ignore - called from onclick in HTML
async function unarchiveIntent(id: string): Promise<void> {
  const result = await whimAPI.unarchive(id);
  if (result) {
    showStatus('✓ Restored to Spaces');
    setTimeout(hideStatus, 2000);
    await loadSpaces();
  }
}

(window as any).unarchiveIntent = unarchiveIntent;

// ── Canvas view ─────────────────────────────────────────
import { mountCanvas, unmountCanvas, getCanvasContent, saveCanvas as saveCanvasEditor, updateCanvasPresence, updateCanvasAgentThreadStatuses, updateCanvasAgentInteractions, updateCanvasDecorations, updateCanvasAgentUsers, addCanvasCommentReply, updateCanvasFrontmatter, toggleCanvasMode, getCanvasEditorMode, replaceCanvasContent, appendCanvasLink, replaceCanvasText, getCanvasSelectedText, focusCanvasEditor } from './canvas/mount.tsx';
import { mountCanvasWorkerPanel, unmountCanvasWorkerPanel, isCanvasChatPaneOpen, closeCanvasChatPane } from './canvas/worker-panel-mount.tsx';
import type { CanvasAgentInteraction, CanvasPresence, CanvasUser, CanvasDecoration, CanvasThreadAgentStatus } from './canvas/types';
import type { MentionEvent } from './canvas/MarkdownCanvas';
import { normalizeMentionLaunchText } from './canvas/editor/mentions';

const canvasView = document.getElementById('canvas-view') as HTMLDivElement;
const canvasBack = document.getElementById('canvas-back') as HTMLButtonElement;
const canvasTitle = document.getElementById('canvas-title') as HTMLHeadingElement;
const canvasTitleAI = document.getElementById('canvas-title-ai') as HTMLButtonElement;
const canvasScheduleIndicator = document.getElementById('canvas-schedule-indicator') as HTMLButtonElement;
const canvasScheduleIndicatorLabel = document.getElementById('canvas-schedule-indicator-label') as HTMLSpanElement;
const canvasSkillLaunchBtn = document.getElementById('canvas-skill-launch') as HTMLButtonElement;
const canvasSaveStatus = document.getElementById('canvas-save-status') as HTMLSpanElement;
const canvasLaunchBtn = document.getElementById('canvas-launch') as HTMLButtonElement;
const canvasSaveBtn = document.getElementById('canvas-save') as HTMLButtonElement;
const canvasRoot = document.getElementById('canvas-root') as HTMLDivElement;
const canvasWorkerTilesRoot = document.getElementById('canvas-worker-tiles-root') as HTMLDivElement;
const canvasChatPane = document.getElementById('canvas-chat-pane') as HTMLDivElement;
const canvasHistoryBtn = document.getElementById('canvas-history-btn') as HTMLButtonElement;
const canvasHistoryPanel = document.getElementById('canvas-history-panel') as HTMLDivElement;
const canvasHistoryClose = document.getElementById('canvas-history-close') as HTMLButtonElement;
const canvasHistoryList = document.getElementById('canvas-history-list') as HTMLDivElement;
const canvasPreviewBanner = document.getElementById('canvas-preview-banner') as HTMLDivElement;
const canvasPreviewLabel = document.getElementById('canvas-preview-label') as HTMLSpanElement;
const canvasPreviewRestore = document.getElementById('canvas-preview-restore') as HTMLButtonElement;
const canvasPreviewBack = document.getElementById('canvas-preview-back') as HTMLButtonElement;
const canvasPinTopBtn = document.getElementById('canvas-pin-top') as HTMLButtonElement;
const canvasOpenFolder = document.getElementById('canvas-open-folder') as HTMLButtonElement;
const modeToggleRendered = document.getElementById('mode-toggle-rendered') as HTMLButtonElement;
const modeToggleRaw = document.getElementById('mode-toggle-raw') as HTMLButtonElement;
const canvasMenuBtn = document.getElementById('canvas-menu-btn') as HTMLButtonElement;
const canvasMenuDropdown = document.getElementById('canvas-menu-dropdown') as HTMLDivElement;
const canvasShareBtn = document.getElementById('canvas-share-btn') as HTMLButtonElement;
const canvasShareWrap = canvasShareBtn?.closest('.canvas-share-wrap') as HTMLDivElement | null;
const canvasShareDropdown = document.getElementById('canvas-share-dropdown') as HTMLDivElement;
const canvasShareDestinations = document.getElementById('canvas-share-destinations') as HTMLDivElement;
const canvasShareManageDest = document.getElementById('canvas-share-manage-dest') as HTMLButtonElement;
const canvasCopyMdBtn = document.getElementById('canvas-copy-md') as HTMLButtonElement | null;
const canvasMarkComplete = document.getElementById('canvas-mark-complete') as HTMLButtonElement;
const canvasSaveAsSkill = document.getElementById('canvas-save-as-skill') as HTMLButtonElement;
const canvasManageSkills = document.getElementById('canvas-manage-skills') as HTMLButtonElement;
const canvasSkillChips = document.getElementById('canvas-skill-chips') as HTMLDivElement;
const canvasSkillPicker = document.getElementById('canvas-skill-picker') as HTMLDivElement;
const canvasPinLabel = document.getElementById('canvas-pin-label') as HTMLSpanElement;
const canvasLaunchLabel = document.getElementById('canvas-launch-label') as HTMLSpanElement;
const canvasScheduleBtn = document.getElementById('canvas-schedule') as HTMLButtonElement;
const canvasScheduleLabel = document.getElementById('canvas-schedule-label') as HTMLSpanElement;
let canvasSpaceId: string | null = null;
let canvasSkillId: string | null = null;
let canvasPageName: string | null = null;
let canvasPageSpaceId: string | null = null;
let canvasFilePath: string | null = null;
let canvasDirty = false;
let canvasIsNewIntent = false;
let canvasChatPaneOpen = false;
let canvasMountGen = 0;
let canvasLinkedSkillIds: string[] = [];

/**
 * Give the window over to the canvas, and take it back again.
 *
 * The popout does this once at startup because the canvas is all it ever
 * shows. Inline — which is how a browser sees it — the canvas and the spaces
 * list share one window, so the swap happens on every open and close. The
 * back button already exists in the header; only the popout hides it, so it
 * needs no new affordance here.
 */
function revealCanvasView(): void {
  canvasView.classList.remove('hidden');
  if (canvasIsInline) mainView.classList.add('hidden');
}

function hideInlineCanvas(): void {
  canvasView.classList.add('hidden');
  mainView.classList.remove('hidden');
}

function setCanvasHeaderTitle(title: string): void {
  const displayTitle = title.trim() || 'Untitled';
  canvasTitle.textContent = displayTitle;
  if (isCanvasMode) {
    whimAPI.updateCanvasWindowTitle(displayTitle);
  }
}

function pageCanvasSpaceId(spaceId: string, pageName: string): string {
  return `__page__${spaceId}/${encodeURIComponent(pageName)}`;
}

function currentCanvasAgentSpaceId(): string | null {
  if (canvasSpaceId) return canvasSpaceId;
  if (canvasPageSpaceId && canvasPageName) return pageCanvasSpaceId(canvasPageSpaceId, canvasPageName);
  return null;
}

/**
 * The id the export engine should load for the currently-open canvas. Mirrors
 * the canvas:read id scheme (real space, child page, or workspace .md file).
 * Returns null for targets that can't be exported yet (e.g. skills).
 */
function currentCanvasExportId(): string | null {
  if (canvasSpaceId) return canvasSpaceId;
  if (canvasPageSpaceId && canvasPageName) return pageCanvasSpaceId(canvasPageSpaceId, canvasPageName);
  if (canvasFilePath) return `__file__${encodeURIComponent(canvasFilePath)}`;
  return null;
}

const MENTION_LAUNCH_DEDUPE_MS = 15_000;
const mentionLaunchDedupeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function reserveMentionLaunch(key: string): boolean {
  if (mentionLaunchDedupeTimers.has(key)) return false;
  const timer = setTimeout(() => {
    mentionLaunchDedupeTimers.delete(key);
  }, MENTION_LAUNCH_DEDUPE_MS);
  mentionLaunchDedupeTimers.set(key, timer);
  return true;
}

function releaseMentionLaunch(key: string): void {
  const timer = mentionLaunchDedupeTimers.get(key);
  if (timer) clearTimeout(timer);
  mentionLaunchDedupeTimers.delete(key);
}

function mentionAnchorKey(anchor: { prefix?: string; suffix?: string }): string {
  return `${normalizeMentionLaunchText(anchor.prefix ?? '')}|${normalizeMentionLaunchText(anchor.suffix ?? '')}`;
}

function showMentionLaunchError(error: unknown): void {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error ? error.message : 'Agent launch failed';
  canvasSaveStatus.textContent = `✗ ${message}`;
  setTimeout(() => { canvasSaveStatus.textContent = ''; }, 3000);
}

function beginOptimisticAgentDecoration(key: string, text: string): string | null {
  const decorationText = text.trim();
  if (!decorationText) return null;
  const optimisticId = `optimistic:${key}`;
  agentDecorationMap.set(optimisticId, { status: 'running', decorationText });
  syncCanvasDecorations();
  return optimisticId;
}

function clearOptimisticAgentDecoration(optimisticId: string | null): void {
  if (!optimisticId) return;
  if (agentDecorationMap.delete(optimisticId)) syncCanvasDecorations();
}

function beginOptimisticThreadStatus(key: string, threadId: string, handle: string): string {
  const optimisticId = `optimistic:${key}`;
  canvasAgentRawStatus.set(optimisticId, 'running');
  canvasThreadAgentStatuses.set(threadId, {
    threadId,
    agentId: optimisticId,
    status: 'starting',
    label: `@${handle} starting...`,
  });
  syncCanvasAgentThreadStatuses();
  return optimisticId;
}

function clearOptimisticThreadStatus(threadId: string, optimisticId: string | null): void {
  if (!optimisticId) return;
  const existing = canvasThreadAgentStatuses.get(threadId);
  if (existing?.agentId === optimisticId) canvasThreadAgentStatuses.delete(threadId);
  commentThreadAgents.delete(optimisticId);
  commentThreadByAgent.delete(optimisticId);
  canvasAgentRawStatus.delete(optimisticId);
  syncCanvasAgentThreadStatuses();
}

function inlineMentionAnchor(handle: string, lineMarkdown: string): { prefix?: string; suffix?: string } {
  const token = `@${handle}`;
  const idx = lineMarkdown.indexOf(token);
  if (idx < 0) return {};
  const end = idx + token.length;
  return {
    prefix: lineMarkdown.slice(Math.max(0, end - 32), end),
    suffix: lineMarkdown.slice(end, end + 32),
  };
}

function launchMentionedAgents(targetSpaceId: string, event: MentionEvent): void {
  for (const handle of event.handles) {
    const key = [
      'comment',
      targetSpaceId,
      event.threadId ?? '',
      handle,
      normalizeMentionLaunchText(event.commentBody),
      normalizeMentionLaunchText(event.quote),
      mentionAnchorKey(event.anchor),
    ].join(':');
    if (!reserveMentionLaunch(key)) continue;
    const optimisticId = event.threadId ? beginOptimisticThreadStatus(key, event.threadId, handle) : null;
    void whimAPI.launchCommentAgent(
      targetSpaceId,
      event.commentBody,
      event.quote,
      event.anchor,
      handle,
      event.threadId,
    ).then((result: any) => {
      if (result?.error) {
        clearOptimisticThreadStatus(event.threadId ?? '', optimisticId);
        releaseMentionLaunch(key);
        showMentionLaunchError(result.error);
        return;
      }
      if (event.threadId) {
        setTimeout(() => clearOptimisticThreadStatus(event.threadId!, optimisticId), 1500);
      }
    }).catch((err) => {
      clearOptimisticThreadStatus(event.threadId ?? '', optimisticId);
      releaseMentionLaunch(key);
      showMentionLaunchError(err);
    });
  }
}

function launchInlineMention(targetSpaceId: string, handle: string, lineMarkdown: string, lineNumber: number): void {
  const normalizedLine = normalizeMentionLaunchText(lineMarkdown);
  const key = ['inline', targetSpaceId, handle, lineNumber, normalizedLine].join(':');
  if (!reserveMentionLaunch(key)) return;
  const optimisticId = beginOptimisticAgentDecoration(key, lineMarkdown.trim() || `@${handle}`);
  void whimAPI.launchCommentAgent(
    targetSpaceId,
    lineMarkdown,
    lineMarkdown,
    inlineMentionAnchor(handle, lineMarkdown),
    handle,
    null,
  ).then((result: any) => {
    if (result?.error) {
      clearOptimisticAgentDecoration(optimisticId);
      releaseMentionLaunch(key);
      showMentionLaunchError(result.error);
      return;
    }
    setTimeout(() => clearOptimisticAgentDecoration(optimisticId), 1500);
    void refreshAgentDecorations();
  }).catch((err) => {
    clearOptimisticAgentDecoration(optimisticId);
    releaseMentionLaunch(key);
    showMentionLaunchError(err);
  });
}

canvasTitle.contentEditable = 'false';
canvasTitle.setAttribute('aria-readonly', 'true');
canvasTitleAI.classList.add('hidden');

// ── Canvas Dropdown Menu ────────────────────────────────
function toggleCanvasMenu(): void {
  canvasMenuDropdown.classList.toggle('hidden');
}

function closeCanvasMenu(): void {
  canvasMenuDropdown.classList.add('hidden');
}

canvasMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleCanvasMenu();
});

document.addEventListener('click', (e) => {
  if (!canvasMenuDropdown.classList.contains('hidden') &&
      !(e.target as HTMLElement).closest('.canvas-menu-wrap')) {
    closeCanvasMenu();
  }
});

// ── Canvas Share menu ───────────────────────────────────
let shareInFlight = false;
let shareStatusTimer: ReturnType<typeof setTimeout> | null = null;

function flashCanvasStatus(msg: string): void {
  canvasSaveStatus.textContent = msg;
  if (shareStatusTimer) clearTimeout(shareStatusTimer);
  shareStatusTimer = setTimeout(() => {
    if (canvasSaveStatus.textContent === msg) canvasSaveStatus.textContent = '';
    shareStatusTimer = null;
  }, 3000);
}

function closeShareMenu(): void {
  canvasShareDropdown?.classList.add('hidden');
}

function openShareMenu(): void {
  void renderShareDestinations();
  canvasShareDropdown.classList.remove('hidden');
}

function toggleShareMenu(): void {
  if (canvasShareDropdown.classList.contains('hidden')) openShareMenu();
  else closeShareMenu();
}

async function renderShareDestinations(): Promise<void> {
  const destinations = await bridgeApi.listExportDestinations();
  canvasShareDestinations.innerHTML = '';
  if (!destinations || destinations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'canvas-share-dest-empty';
    empty.textContent = 'No folders yet. Add a synced folder (OneDrive, Google Drive…) in settings to push copies there.';
    canvasShareDestinations.appendChild(empty);
    return;
  }
  for (const dest of destinations) {
    const btn = document.createElement('button');
    btn.className = 'canvas-menu-item';
    btn.innerHTML =
      '<span class="canvas-menu-icon">📁</span>' +
      '<span class="canvas-share-dest-label"></span>' +
      '<span class="canvas-share-dest-format"></span>';
    (btn.querySelector('.canvas-share-dest-label') as HTMLElement).textContent = dest.label;
    (btn.querySelector('.canvas-share-dest-format') as HTMLElement).textContent = dest.defaultFormat;
    btn.title = `Save ${dest.defaultFormat.toUpperCase()} to ${dest.path}`;
    btn.addEventListener('click', () => saveCanvasToDestination(dest.id));
    canvasShareDestinations.appendChild(btn);
  }
}

async function shareCanvasAs(format: ExportFormat): Promise<void> {
  closeShareMenu();
  const id = currentCanvasExportId();
  if (!id || shareInFlight) return;
  shareInFlight = true;
  flashCanvasStatus('Preparing share…');
  try {
    // Flush pending edits so the export reflects the latest content.
    if (canvasDirty) { try { await saveCanvasEditor(); } catch { /* fall back to on-disk content */ } }
    const result = await bridgeApi.shareCanvas(id, format);
    if ('error' in result) {
      flashCanvasStatus(`Share failed: ${result.error}`);
    } else if (result.method === 'reveal') {
      flashCanvasStatus('Exported — revealed in file manager');
    } else {
      // Native OS share sheet is open; nothing more to say.
      canvasSaveStatus.textContent = '';
    }
  } finally {
    shareInFlight = false;
  }
}

async function saveCanvasToDestination(destinationId: string): Promise<void> {
  closeShareMenu();
  const id = currentCanvasExportId();
  if (!id || shareInFlight) return;
  shareInFlight = true;
  flashCanvasStatus('Saving to folder…');
  try {
    // Flush pending edits so the export reflects the latest content.
    if (canvasDirty) { try { await saveCanvasEditor(); } catch { /* fall back to on-disk content */ } }
    const result = await bridgeApi.exportCanvasToDestination(id, destinationId);
    flashCanvasStatus('error' in result ? `Save failed: ${result.error}` : 'Saved to folder');
  } finally {
    shareInFlight = false;
  }
}

canvasShareBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleShareMenu();
});

async function copyCanvasMarkdown(): Promise<void> {
  closeShareMenu();
  if (shareInFlight) return;
  // Flush pending edits so the copy reflects the latest content.
  if (canvasDirty) { try { await saveCanvasEditor(); } catch { /* fall back to in-memory content */ } }
  const md = getCanvasContent();
  if (!md.trim()) { flashCanvasStatus('Nothing to copy'); return; }
  try {
    await navigator.clipboard.writeText(md);
    flashCanvasStatus('Copied as Markdown');
  } catch {
    flashCanvasStatus('Copy failed');
  }
}

canvasCopyMdBtn?.addEventListener('click', () => void copyCanvasMarkdown());

canvasShareDropdown?.querySelectorAll('[data-share-format]').forEach((el) => {
  el.addEventListener('click', () => {
    const format = (el as HTMLElement).dataset.shareFormat as ExportFormat;
    void shareCanvasAs(format);
  });
});

canvasShareManageDest?.addEventListener('click', () => {
  closeShareMenu();
  whimAPI.openSettingsWindow();
});

document.addEventListener('click', (e) => {
  if (canvasShareDropdown && !canvasShareDropdown.classList.contains('hidden') &&
      !(e.target as HTMLElement).closest('.canvas-share-wrap')) {
    closeShareMenu();
  }
});

function updateCanvasMenuContext(isSkill: boolean): void {
  // Items tagged data-context="space" are shown only for spaces
  canvasMenuDropdown.querySelectorAll('[data-context="space"]').forEach(el => {
    el.classList.toggle('hidden', isSkill);
  });
  // Items tagged data-context="skill" are shown only for skills
  canvasMenuDropdown.querySelectorAll('[data-context="skill"]').forEach(el => {
    el.classList.toggle('hidden', !isSkill);
  });
  canvasLaunchLabel.textContent = isSkill ? 'Run Skill' : 'Run Canvas';

  // Sharing isn't supported for skill templates yet — hide the share control.
  canvasShareWrap?.classList.toggle('hidden', isSkill);
  if (isSkill) closeShareMenu();

  // Skill-only header chrome: schedule indicator + launch button
  const skill = isSkill && canvasSkillId ? cachedSkills.find(s => s.id === canvasSkillId) : null;

  // Update the schedule menu label based on whether this skill already has one
  if (isSkill && skill) {
    canvasScheduleLabel.textContent = skill.schedule ? 'Edit Schedule…' : 'Set Schedule…';
  }

  // Inline schedule indicator (visible at-a-glance when skill is scheduled)
  if (skill && skill.schedule) {
    const label = formatScheduleLabel(skill.schedule, skill.schedule_time, skill.schedule_day);
    canvasScheduleIndicatorLabel.textContent = label;
    const tooltipParts: string[] = [`Scheduled: ${label}`];
    if (skill.next_run_at) tooltipParts.push(`Next: ${formatRelativeDate(skill.next_run_at)}`);
    if (skill.last_run_at) tooltipParts.push(`Last run: ${formatRelativeDate(skill.last_run_at)}`);
    canvasScheduleIndicator.title = tooltipParts.join('\n');
    canvasScheduleIndicator.classList.remove('hidden');
  } else {
    canvasScheduleIndicator.classList.add('hidden');
  }

  // Run-skill button (only meaningful for skill templates)
  canvasSkillLaunchBtn.classList.toggle('hidden', !isSkill);
}

canvasMarkComplete.addEventListener('click', async () => {
  closeCanvasMenu();
  if (!canvasSpaceId) return;
  const spaceId = canvasSpaceId;
  const saveResult = await saveCanvasEditor();
  if (!saveResult.success) {
    showStatus('Save failed — canvas not completed', true);
    setTimeout(hideStatus, 3000);
    return;
  }
  await whimAPI.update(spaceId, { status: 'done' });
  showStatus('✓ Marked complete');
  setTimeout(hideStatus, 2000);
  closeCanvas();
});

canvasScheduleBtn.addEventListener('click', () => {
  closeCanvasMenu();
  if (!canvasSkillId) return;
  openSchedulePicker(canvasSkillId);
});

canvasScheduleIndicator.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!canvasSkillId) return;
  openSchedulePicker(canvasSkillId);
});

canvasSkillLaunchBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!canvasSkillId) return;
  await launchSkillAsSpace(canvasSkillId);
});

canvasSaveAsSkill.addEventListener('click', async () => {
  closeCanvasMenu();
  if (!canvasSpaceId) return;
  const space = spaces.find(s => s.id === canvasSpaceId);
  const defaultName = space?.description || 'New Skill';
  const name = prompt('Skill name:', defaultName);
  if (!name) return;

  const content = getCanvasContent();
  const result = await whimAPI.createSkill(name);
  if ('error' in result) {
    showStatus(`Failed: ${(result as any).error}`, true);
    setTimeout(hideStatus, 3000);
    return;
  }

  // Parse frontmatter from canvas content if present, otherwise wrap content as skill body
  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  const frontmatter: Record<string, unknown> = { name, description: '', ...parsed.frontmatter };
  const body = parsed.body;
  frontmatter.name = name;

  await whimAPI.writeSkill(result.id, frontmatter, body);
  showStatus('✓ Saved as skill');
  setTimeout(hideStatus, 2000);
});

// ── Canvas Skill Linking ────────────────────────────────

/** Parse the `skills` array from canvas frontmatter (YAML). */
function parseLinkedSkillIds(content: string): string[] {
  const { frontmatter } = parseFrontmatter<{ skills?: unknown }>(content);
  const skills = frontmatter.skills;
  if (Array.isArray(skills)) {
    return skills.filter((skill): skill is string => typeof skill === 'string' && skill.length > 0);
  }
  return typeof skills === 'string' && skills.length > 0 ? [skills] : [];
}

/** Update the `skills` frontmatter in canvas content and save. */
async function updateCanvasLinkedSkills(skillIds: string[]): Promise<void> {
  if (!canvasSpaceId) return;

  const content = getCanvasContent();
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
  const updatedFrontmatter = { ...frontmatter };
  if (skillIds.length > 0) {
    updatedFrontmatter.skills = skillIds;
  } else {
    delete updatedFrontmatter.skills;
  }

  updateCanvasFrontmatter(updatedFrontmatter);
  canvasLinkedSkillIds = skillIds;
  renderSkillChips();
}

/** Render clickable chips for linked skills. */
function renderSkillChips(): void {
  if (canvasLinkedSkillIds.length === 0) {
    canvasSkillChips.classList.add('hidden');
    canvasSkillChips.innerHTML = '';
    return;
  }

  const chips = canvasLinkedSkillIds.map(id => {
    const skill = cachedSkills.find(s => s.id === id);
    const emoji = skill?.emoji || '🧩';
    const name = skill?.name || id;
    return `<button class="skill-chip" data-skill-id="${escapeHtml(id)}" title="Open ${escapeHtml(name)} skill">
      <span class="skill-chip-emoji">${emoji}</span>
      <span class="skill-chip-name">${escapeHtml(name)}</span>
    </button>`;
  }).join('');

  canvasSkillChips.innerHTML = chips;
  canvasSkillChips.classList.remove('hidden');

  // Click handlers to open skill as canvas
  canvasSkillChips.querySelectorAll('.skill-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const skillId = (chip as HTMLElement).dataset.skillId!;
      const skill = cachedSkills.find(s => s.id === skillId);
      whimAPI.openNewCanvasWindow({ kind: 'skill', id: skillId, title: skill?.name || skillId });
    });
  });
}

/** Show/hide the skill picker panel. */
function toggleSkillPicker(): void {
  const isHidden = canvasSkillPicker.classList.contains('hidden');
  if (isHidden) {
    renderSkillPicker();
    canvasSkillPicker.classList.remove('hidden');
  } else {
    canvasSkillPicker.classList.add('hidden');
  }
}

/** Render the skill picker with checkboxes. */
async function renderSkillPicker(): Promise<void> {
  const skills = await loadSkills();

  if (skills.length === 0) {
    canvasSkillPicker.innerHTML = `
      <div class="skill-picker-header">
        <span class="skill-picker-title">Link Skills</span>
        <button class="skill-picker-close" onclick="this.closest('.canvas-skill-picker').classList.add('hidden')">✕</button>
      </div>
      <div class="skill-picker-empty">No skills available. Create a skill first.</div>
    `;
    return;
  }

  const items = skills.map(skill => {
    const checked = canvasLinkedSkillIds.includes(skill.id) ? 'checked' : '';
    const desc = skill.description.length > 60 ? skill.description.slice(0, 57) + '...' : skill.description;
    return `<label class="skill-picker-item">
      <input type="checkbox" class="skill-picker-checkbox" data-skill-id="${escapeHtml(skill.id)}" ${checked}>
      <span class="skill-picker-emoji">${skill.emoji || '🧩'}</span>
      <div class="skill-picker-info">
        <div class="skill-picker-name">${escapeHtml(skill.name)}</div>
        ${desc ? `<div class="skill-picker-desc">${escapeHtml(desc)}</div>` : ''}
      </div>
    </label>`;
  }).join('');

  canvasSkillPicker.innerHTML = `
    <div class="skill-picker-header">
      <span class="skill-picker-title">Link Skills</span>
      <button class="skill-picker-close">✕</button>
    </div>
    <div class="skill-picker-list">${items}</div>
  `;

  // Close button
  canvasSkillPicker.querySelector('.skill-picker-close')!.addEventListener('click', () => {
    canvasSkillPicker.classList.add('hidden');
  });

  // Checkbox change handlers
  canvasSkillPicker.querySelectorAll('.skill-picker-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const checkbox = cb as HTMLInputElement;
      const skillId = checkbox.dataset.skillId!;
      let updated: string[];
      if (checkbox.checked) {
        updated = [...canvasLinkedSkillIds, skillId];
      } else {
        updated = canvasLinkedSkillIds.filter(id => id !== skillId);
      }
      updateCanvasLinkedSkills(updated);
    });
  });
}

canvasManageSkills.addEventListener('click', () => {
  closeCanvasMenu();
  toggleSkillPicker();
});

// Create a new blank space and immediately open it in the full canvas editor
async function createAndOpenCanvas(): Promise<void> {
  const space = await whimAPI.create({ body: '' }) as any;
  if (space.error === 'no_workspace') {
    showStatus('Select a workspace directory first');
    const ws = await whimAPI.selectWorkspace();
    if (!ws.selected) { hideStatus(); return; }
    updateWorkspaceDisplay(ws.path!);
    const retry = await whimAPI.create({ body: '' }) as any;
    if (retry.error) { showStatus('Failed to create space', true); return; }
    await loadSpaces();
    openCanvas(retry.id, true);
    canvasIsNewIntent = true;
    return;
  }
  await loadSpaces();
  openCanvas(space.id, true);
  canvasIsNewIntent = true;
}

/** Show an in-page input dialog (replaces window.prompt which Electron doesn't support). */
function showCanvasInputDialog(label: string, onSubmit: (value: string) => void): void {
  const existing = document.getElementById('canvas-input-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'canvas-input-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '99999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)',
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    background: '#1e1e1e', borderRadius: '8px', padding: '16px 20px',
    minWidth: '300px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    fontFamily: 'var(--font-body)',
  });

  const labelEl = document.createElement('div');
  labelEl.textContent = label;
  Object.assign(labelEl.style, { color: '#ccc', marginBottom: '8px', fontSize: '13px' });

  const input = document.createElement('input');
  input.type = 'text';
  Object.assign(input.style, {
    width: '100%', boxSizing: 'border-box', padding: '6px 8px',
    background: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
    color: '#eee', fontSize: '14px', outline: 'none',
  });

  const close = () => overlay.remove();

  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      const val = input.value.trim();
      close();
      if (val) onSubmit(val);
    } else if (ev.key === 'Escape') {
      close();
    }
  });

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });

  box.appendChild(labelEl);
  box.appendChild(input);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  input.focus();
}

async function openCanvas(spaceId: string, expanded = false): Promise<void> {
  const space = spaces.find(i => i.id === spaceId);
  if (!space) return;

  // The desktop main window hands canvases to a dedicated window; the popout
  // and the browser draw them here. See window-chrome.ts.
  if (canvasPopsOut) {
    whimAPI.openCanvasWindow({ kind: 'space', id: spaceId, title: space.description });
    return;
  }

  // Inline, the canvas shares the window with the spaces list, so it has to
  // take the space over rather than appear behind it — `revealCanvasView`
  // below does that.
  canvasSpaceId = spaceId;
  canvasSkillId = null;
  canvasPageSpaceId = null;
  canvasPageName = null;
  canvasLinkedSkillIds = [];
  // Clear any comment-thread agent state carried over from a previously-open
  // canvas so this document's editor mounts with a clean slate; the authoritative
  // state is rehydrated from the main process after mount.
  resetCanvasAgentMaps();
  canvasSkillChips.classList.add('hidden');
  canvasSkillPicker.classList.add('hidden');
  setCanvasHeaderTitle(space.description);
  canvasTitle.contentEditable = 'false';
  canvasTitle.classList.remove('editing');
  canvasTitleAI.classList.add('hidden');
  canvasSaveStatus.textContent = '';
  canvasDirty = false;
  canvasSaveBtn.classList.add('hidden');
  updateModeToggleUI('rendered');

  // Configure dropdown for space context
  closeCanvasMenu();
  updateCanvasMenuContext(false);

  revealCanvasView();

  const myGen = ++canvasMountGen;

  // Load all data in parallel
  const [result, currentTheme, canvasPersonas] = await Promise.all([
    whimAPI.readCanvas(spaceId),
    Promise.resolve(getResolvedTheme()),
    whimAPI.listPersonas().then(p => p || []),
    loadSkills(),
  ]);

  // Abort if user already switched to another space
  if (canvasMountGen !== myGen) return;

  if (result.error === 'no_workspace') {
    return;
  }

  // Parse linked skills from canvas frontmatter and render chips
  const parsedCanvas = parseFrontmatter<Record<string, unknown>>(result.content || '');
  setCanvasHeaderTitle(deriveMarkdownTitle(result.content || '', space.description || 'Untitled'));
  canvasLinkedSkillIds = parseLinkedSkillIds(result.content || '');
  renderSkillChips();

  // Mount the canvas editor
  mountCanvas(canvasRoot, {
    spaceId,
    content: parsedCanvas.body,
    frontmatter: parsedCanvas.frontmatter,
    theme: currentTheme,
    titleFallback: space.description || 'Untitled',
    onTitleChange: (title) => {
      setCanvasHeaderTitle(title);
      const current = spaces.find(s => s.id === spaceId);
      if (current && current.description !== title) {
        current.description = title;
        spaceStore.updateSpaceTitle(spaceId, title);
      }
    },
    personas: canvasPersonas,
    agentThreadStatuses: Array.from(canvasThreadAgentStatuses.values()),
    agentInteractions: Array.from(canvasAgentInteractions.values()),
    onDirtyChange: (dirty: boolean) => {
      canvasDirty = dirty;
      canvasSaveBtn.classList.toggle('hidden', !dirty);
    },
    onSaveStatus: (status: string) => {
      canvasSaveStatus.textContent = status;
    },
    onAgentMentioned: (event) => launchMentionedAgents(spaceId, event),
    onInlineMention: (handle, lineMarkdown, lineNumber) => {
      launchInlineMention(spaceId, handle, lineMarkdown, lineNumber);
    },
    onForkSelection: async (selectedText) => {
      const space = await whimAPI.create({ body: selectedText });
      if (!space || (space as any).error || !space.id) return;
      await loadSpaces();
      whimAPI.openNewCanvasWindow({ kind: 'space', id: space.id, title: space.description });
    },
    onExtractToPage: (selectedText) => {
      if (!canvasSpaceId) return;
      const sid = canvasSpaceId;
      const pageName = selectedText.trim().split(/\s+/).slice(0, 5).join(' ');
      whimAPI.createPage(sid, pageName).then(async (result) => {
        if (result.error) return;
        await whimAPI.writePage(sid, result.page, ensureMarkdownH1Title(selectedText, pageName).content);
        replaceCanvasText(selectedText, `[${selectedText}](${result.page}.md)`);
        whimAPI.openPageWindow({ kind: 'page', spaceId: sid, page: result.page, title: pageName });
      });
    },
  });

  // A space that was just created has nothing to read, so leaving the caret
  // outside the editor means the first thing the user does is click. Focusing
  // an empty document is safe wherever it opens — inline or in the popout —
  // and needs no flag threaded through the window-open IPC.
  if (!parsedCanvas.body.trim()) focusCanvasEditor();

  // Mount worker tiles + chat side pane
  mountCanvasWorkerPanel(canvasWorkerTilesRoot, canvasChatPane, {
    spaceId,
    onChatPaneToggle: (open: boolean) => {
      canvasChatPaneOpen = open;
    },
  });

  // Load initial agent activity decorations
  refreshAgentDecorations();

  // Rehydrate comment-thread agents so the canvas shows any that are still
  // alive/working (or failed and needing redeploy) after navigation, a pop-out,
  // or an app restart.
  void rehydrateCanvasAgents(spaceId);
}

async function openPage(spaceId: string, pageName: string): Promise<void> {
  canvasSpaceId = null;
  canvasSkillId = null;
  canvasPageSpaceId = spaceId;
  canvasPageName = pageName;
  const pageSpaceId = pageCanvasSpaceId(spaceId, pageName);
  // Clean slate before mount; rehydrated from main after mount.
  resetCanvasAgentMaps();

  setCanvasHeaderTitle(pageName);
  canvasTitle.contentEditable = 'false';
  canvasTitle.classList.remove('editing');
  canvasTitleAI.classList.add('hidden');
  canvasSaveStatus.textContent = '';
  canvasDirty = false;
  canvasSaveBtn.classList.add('hidden');
  updateModeToggleUI('rendered');

  closeCanvasMenu();
  updateCanvasMenuContext(false);
  revealCanvasView();

  const [result, canvasPersonas] = await Promise.all([
    whimAPI.readPage(spaceId, pageName),
    whimAPI.listPersonas().then(p => p || []),
  ]);
  if (result.error) return;
  setCanvasHeaderTitle(deriveMarkdownTitle(result.content || '', pageName));

  mountCanvas(canvasRoot, {
    spaceId: pageSpaceId,
    content: result.content || '',
    theme: getResolvedTheme(),
    titleFallback: pageName,
    onTitleChange: setCanvasHeaderTitle,
    personas: canvasPersonas,
    agentThreadStatuses: Array.from(canvasThreadAgentStatuses.values()),
    agentInteractions: Array.from(canvasAgentInteractions.values()),
    onDirtyChange: (dirty: boolean) => {
      canvasDirty = dirty;
      canvasSaveBtn.classList.toggle('hidden', !dirty);
    },
    onSaveStatus: (status: string) => {
      canvasSaveStatus.textContent = status;
    },
    onAgentMentioned: (event) => launchMentionedAgents(pageSpaceId, event),
    onInlineMention: (handle, lineMarkdown, lineNumber) => {
      launchInlineMention(pageSpaceId, handle, lineMarkdown, lineNumber);
    },
  });

  void rehydrateCanvasAgents(pageSpaceId);
}

async function openWorkspaceFile(filePath: string, title: string): Promise<void> {
  canvasSpaceId = null;
  canvasSkillId = null;
  canvasPageSpaceId = null;
  canvasPageName = null;
  canvasFilePath = filePath;

  setCanvasHeaderTitle(title);
  canvasTitle.contentEditable = 'false';
  canvasTitle.classList.remove('editing');
  canvasTitleAI.classList.add('hidden');
  canvasSaveStatus.textContent = '';
  canvasDirty = false;
  canvasSaveBtn.classList.add('hidden');
  updateModeToggleUI('rendered');

  closeCanvasMenu();
  updateCanvasMenuContext(false);
  revealCanvasView();

  const fileSpaceId = `__file__${encodeURIComponent(filePath)}`;
  const result = await whimAPI.readCanvas(fileSpaceId);
  if (result.error) return;

  mountCanvas(canvasRoot, {
    spaceId: fileSpaceId,
    content: result.content || '',
    theme: getResolvedTheme(),
    personas: [],
    onDirtyChange: (dirty: boolean) => {
      canvasDirty = dirty;
      canvasSaveBtn.classList.toggle('hidden', !dirty);
    },
    onSaveStatus: (status: string) => {
      canvasSaveStatus.textContent = status;
    },
  });
}

async function saveCanvas(): Promise<void> {
  await saveCanvasEditor();
}

async function closeCanvas(): Promise<void> {
  const wasPreviewActive = previewActive;
  const savedContent = previewSavedContent;
  const spaceId = canvasSpaceId;
  const wasNewIntent = canvasIsNewIntent;
  const skillId = canvasSkillId;
  const pageSpaceId = canvasPageSpaceId;
  const pageName = canvasPageName;
  const filePath = canvasFilePath;

  const saveResult = await saveCanvasEditor();
  if (!saveResult.success) {
    canvasSaveStatus.textContent = '✗ save failed — canvas kept open';
    return;
  }
  const finalContent = wasPreviewActive ? (savedContent || '') : getCanvasContent();

  let closeResult: CanvasSaveResult = { success: true };
  if (skillId) {
    await saveSkillFromCanvas(skillId, finalContent);
  } else if (filePath) {
    closeResult = await whimAPI.closeCanvas(`__file__${encodeURIComponent(filePath)}`, finalContent);
  } else if (pageSpaceId && pageName) {
    closeResult = await whimAPI.closePage(pageSpaceId, pageName, finalContent);
  } else if (spaceId) {
    closeResult = await whimAPI.closeCanvas(spaceId, finalContent);
  }

  if (!closeResult.success) {
    canvasSaveStatus.textContent = '✗ close save failed — canvas kept open';
    return;
  }

  canvasClosing = true;
  if (previewActive) {
    previewActive = false;
    previewSha = null;
    previewSavedContent = null;
    canvasPreviewBanner.classList.add('hidden');
  }
  closeHistoryPanel();
  unmountCanvasWorkerPanel();
  clearAgentDecorations();
  canvasChatPaneOpen = false;
  await unmountCanvas(false);
  canvasSpaceId = null;
  canvasSkillId = null;
  canvasPageSpaceId = null;
  canvasPageName = null;
  canvasFilePath = null;
  canvasIsNewIntent = false;
  canvasLinkedSkillIds = [];
  canvasSkillChips.classList.add('hidden');
  canvasSkillPicker.classList.add('hidden');

  if (spaceId) {
    // If this was a new space created from Enter on empty input,
    // trigger AI refinement using the canvas content as the body
    if (wasNewIntent && finalContent.trim()) {
      await whimAPI.update(spaceId, { body: finalContent.trim() });
      processingSpaces.add(spaceId);
      agentStore.addProcessingIntent(spaceId);
    } else if (wasNewIntent && !finalContent.trim()) {
      // Empty canvas — delete the blank space
      await whimAPI.delete(spaceId);
    }
  }

  canvasDirty = false;

  // Canvas always runs in the popout window now — close it.
  // Keep canvasClosing=true so beforeunload doesn't double-save.
  if (shouldCloseWindowOnCanvasClose({ isWebRemote: isWebRemote() })) {
    window.close();
    return;
  }

  // In a browser the canvas is drawn over the spaces list, and the tab is not
  // ours to close — reveal the list again instead.
  hideInlineCanvas();
  canvasClosing = false;
  await loadSpaces();
}

// Guard against double-save in beforeunload
let canvasClosing = false;

canvasSaveBtn.addEventListener('click', saveCanvas);
canvasBack.addEventListener('click', closeCanvas);

canvasOpenFolder.addEventListener('click', () => {
  closeCanvasMenu();
  if (canvasSpaceId) {
    whimAPI.openSpaceFolder(canvasSpaceId);
  }
});

canvasLaunchBtn.addEventListener('click', async () => {
  closeCanvasMenu();
  if (canvasSkillId) {
    await launchSkillAsSpace(canvasSkillId);
  } else if (canvasSpaceId) {
    const saveResult = await saveCanvasEditor();
    if (!saveResult.success) {
      showStatus('Save failed — agent not launched', true);
      setTimeout(hideStatus, 3000);
      return;
    }

    const result = await whimAPI.launchDocumentAgent(canvasSpaceId);
    if ('error' in result) {
      showStatus(result.error || 'Launch failed', true);
      setTimeout(hideStatus, 3000);
      return;
    }
    showStatus('✓ Running canvas');
    setTimeout(hideStatus, 2000);
  }
});

// ── Canvas History Panel ────────────────────────────────
let historyPanelOpen = false;

// ── Canvas Preview State ───────────────────────────────
let previewActive = false;
let previewSha: string | null = null;
let previewSavedContent: string | null = null;

function toggleHistoryPanel(): void {
  if (historyPanelOpen) {
    closeHistoryPanel();
  } else {
    openHistoryPanel();
  }
}

async function openHistoryPanel(): Promise<void> {
  if (!canvasSpaceId) return;
  closeCanvasChatPane();
  canvasHistoryPanel.classList.remove('hidden');
  canvasHistoryBtn.classList.add('active');
  historyPanelOpen = true;
  canvasHistoryList.innerHTML = '<div class="history-loading">Loading history…</div>';

  const result = await whimAPI.canvasHistory(canvasSpaceId);
  if (result.error || result.commits.length === 0) {
    canvasHistoryList.innerHTML = '<div class="history-empty">No history available</div>';
    return;
  }

  canvasHistoryList.innerHTML = '';
  for (const commit of result.commits) {
    canvasHistoryList.appendChild(createHistoryItem(commit));
  }
}

function closeHistoryPanel(): void {
  canvasHistoryPanel.classList.add('hidden');
  canvasHistoryBtn.classList.remove('active');
  historyPanelOpen = false;
  if (previewActive) {
    exitPreview();
  }
}

function createHistoryItem(commit: FolderCommit): HTMLElement {
  const item = document.createElement('div');
  item.className = 'history-item';
  item.dataset.sha = commit.sha;

  const meta = document.createElement('div');
  meta.className = 'history-item-meta';
  meta.textContent = commit.relativeDate;

  const msg = document.createElement('div');
  msg.className = 'history-item-message';
  msg.textContent = commit.message;

  const files = document.createElement('div');
  files.className = 'history-item-files';
  const fileNames = commit.filesChanged.map(f => {
    const parts = f.split('/');
    return parts[parts.length - 1];
  });
  if (fileNames.length > 0) {
    files.textContent = fileNames.join(', ');
  }

  const actions = document.createElement('div');
  actions.className = 'history-item-actions';

  const viewBtn = document.createElement('button');
  viewBtn.className = 'history-view-btn';
  viewBtn.textContent = 'View';
  viewBtn.title = `Preview version ${commit.shortSha}`;
  viewBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await enterPreview(commit);
  });

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'history-restore-btn';
  restoreBtn.textContent = 'Restore';
  restoreBtn.title = `Restore to ${commit.shortSha}`;
  restoreBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!canvasSpaceId) return;

    restoreBtn.disabled = true;
    restoreBtn.textContent = '…';

    const result = await whimAPI.canvasRestore(canvasSpaceId, commit.sha);
    if (result.success) {
      // Exit preview mode if active (content is now the restored version)
      if (previewActive) {
        previewActive = false;
        previewSha = null;
        previewSavedContent = null;
        canvasPreviewBanner.classList.add('hidden');
      }
      // Reload the canvas with restored content — re-mount in place
      const readResult = await whimAPI.readCanvas(canvasSpaceId!);
      if (!readResult.error) {
        const spaceId = canvasSpaceId!;
        await unmountCanvas();
        canvasSpaceId = null;
        await openCanvas(spaceId);
      }
      closeHistoryPanel();
    } else {
      restoreBtn.textContent = 'Failed';
      setTimeout(() => {
        restoreBtn.textContent = 'Restore';
        restoreBtn.disabled = false;
      }, 2000);
    }
  });

  actions.appendChild(viewBtn);
  actions.appendChild(restoreBtn);

  item.appendChild(meta);
  item.appendChild(msg);
  if (fileNames.length > 0) item.appendChild(files);
  item.appendChild(actions);

  // Clicking the item itself also triggers preview
  item.addEventListener('click', () => enterPreview(commit));

  return item;
}

async function enterPreview(commit: FolderCommit): Promise<void> {
  if (!canvasSpaceId) return;

  // Save current content before first preview
  if (!previewActive) {
    previewSavedContent = getCanvasContent();
  }

  previewSha = commit.sha;
  previewActive = true;

  // Update banner
  canvasPreviewLabel.textContent = `Viewing version from ${commit.relativeDate}`;
  canvasPreviewBanner.classList.remove('hidden');

  // Highlight the previewed item in the history list
  canvasHistoryList.querySelectorAll('.history-item').forEach(el => {
    el.classList.toggle('previewing', (el as HTMLElement).dataset.sha === commit.sha);
  });

  // Fetch version content and mount read-only
  const result = await whimAPI.canvasPreviewVersion(canvasSpaceId, commit.sha);
  if (result.error) return;

  const spaceId = canvasSpaceId!;
  await unmountCanvas();
  const currentTheme = getResolvedTheme();
  const parsedPreview = parseFrontmatter<Record<string, unknown>>(result.content);
  setCanvasHeaderTitle(deriveMarkdownTitle(result.content, canvasTitle.textContent || 'Untitled'));
  mountCanvas(canvasRoot, {
    spaceId,
    content: parsedPreview.body,
    frontmatter: parsedPreview.frontmatter,
    theme: currentTheme,
    titleFallback: canvasTitle.textContent || 'Untitled',
    onTitleChange: setCanvasHeaderTitle,
    agentThreadStatuses: Array.from(canvasThreadAgentStatuses.values()),
    agentInteractions: Array.from(canvasAgentInteractions.values()),
    onDirtyChange: () => {},   // no-op: preview edits are not tracked
    onSaveStatus: () => {},    // no-op: preview edits are not saved
  });
}

async function exitPreview(): Promise<void> {
  if (!previewActive || !canvasSpaceId) return;

  const savedContent = previewSavedContent;
  previewActive = false;
  previewSha = null;
  previewSavedContent = null;
  canvasPreviewBanner.classList.add('hidden');

  // Remove highlight from history items
  canvasHistoryList.querySelectorAll('.history-item.previewing').forEach(el => {
    el.classList.remove('previewing');
  });

  // Remount with the original content
  const spaceId = canvasSpaceId!;
  await unmountCanvas();
  const currentTheme = getResolvedTheme();
  const canvasPersonas = await whimAPI.listPersonas().then(p => p || []);
  const parsedSaved = parseFrontmatter<Record<string, unknown>>(savedContent || '');
  setCanvasHeaderTitle(deriveMarkdownTitle(savedContent || '', canvasTitle.textContent || 'Untitled'));
  mountCanvas(canvasRoot, {
    spaceId,
    content: parsedSaved.body,
    frontmatter: parsedSaved.frontmatter,
    theme: currentTheme,
    titleFallback: canvasTitle.textContent || 'Untitled',
    onTitleChange: (title) => {
      setCanvasHeaderTitle(title);
      const current = spaces.find(s => s.id === spaceId);
      if (current && current.description !== title) {
        current.description = title;
        spaceStore.updateSpaceTitle(spaceId, title);
      }
    },
    personas: canvasPersonas,
    agentThreadStatuses: Array.from(canvasThreadAgentStatuses.values()),
    agentInteractions: Array.from(canvasAgentInteractions.values()),
    onDirtyChange: (dirty: boolean) => {
      canvasDirty = dirty;
      canvasSaveBtn.classList.toggle('hidden', !dirty);
    },
    onSaveStatus: (status: string) => {
      canvasSaveStatus.textContent = status;
    },
    onAgentMentioned: (event) => launchMentionedAgents(spaceId, event),
    onInlineMention: (handle, lineMarkdown, lineNumber) => {
      launchInlineMention(spaceId, handle, lineMarkdown, lineNumber);
    },
    onForkSelection: async (selectedText) => {
      const space = await whimAPI.create({ body: selectedText });
      if (!space || (space as any).error || !space.id) return;
      await loadSpaces();
      whimAPI.openNewCanvasWindow({ kind: 'space', id: space.id, title: space.description });
    },
    onExtractToPage: (selectedText) => {
      const sid = canvasPageSpaceId || canvasSpaceId;
      if (!sid) return;
      const pageName = selectedText.trim().split(/\s+/).slice(0, 5).join(' ');
      whimAPI.createPage(sid, pageName).then(async (result) => {
        if (result.error) return;
        await whimAPI.writePage(sid, result.page, ensureMarkdownH1Title(selectedText, pageName).content);
        replaceCanvasText(selectedText, `[${selectedText}](${result.page}.md)`);
        whimAPI.openPageWindow({ kind: 'page', spaceId: sid, page: result.page, title: pageName });
      });
    },
  });
}

async function restoreFromPreview(): Promise<void> {
  if (!previewActive || !previewSha || !canvasSpaceId) return;

  const sha = previewSha;
  canvasPreviewRestore.disabled = true;
  canvasPreviewRestore.textContent = '…';

  const result = await whimAPI.canvasRestore(canvasSpaceId, sha);
  if (result.success) {
    previewActive = false;
    previewSha = null;
    previewSavedContent = null;
    canvasPreviewBanner.classList.add('hidden');

    const readResult = await whimAPI.readCanvas(canvasSpaceId!);
    if (!readResult.error) {
      const spaceId = canvasSpaceId!;
      await unmountCanvas();
      canvasSpaceId = null;
      await openCanvas(spaceId);
    }
    closeHistoryPanel();
  } else {
    canvasPreviewRestore.textContent = 'Failed';
    setTimeout(() => {
      canvasPreviewRestore.textContent = 'Restore this version';
      canvasPreviewRestore.disabled = false;
    }, 2000);
  }
}

canvasPreviewBack.addEventListener('click', exitPreview);
canvasPreviewRestore.addEventListener('click', restoreFromPreview);

canvasHistoryBtn.addEventListener('click', () => { closeCanvasMenu(); toggleHistoryPanel(); });
canvasHistoryClose.addEventListener('click', closeHistoryPanel);

// Refresh history panel when a new auto-commit happens
whimAPI.onWorkspaceCommitted(() => {
  if (historyPanelOpen && canvasSpaceId) {
    openHistoryPanel();
  }
});

function updateModeToggleUI(mode: string): void {
  modeToggleRendered.classList.toggle('active', mode === 'rendered');
  modeToggleRaw.classList.toggle('active', mode === 'raw');
}

modeToggleRendered.addEventListener('click', () => {
  if (getCanvasEditorMode() === 'rendered') return;
  const result = toggleCanvasMode();
  updateModeToggleUI(result.mode);
});

modeToggleRaw.addEventListener('click', () => {
  if (getCanvasEditorMode() === 'raw') return;
  const result = toggleCanvasMode();
  updateModeToggleUI(result.mode);
});


/**
 * Open a canvas target, saving and unmounting whatever is open first.
 *
 * The popout receives targets from the main process over
 * `canvas-window:load-target`. Inline — in a browser — nothing sends that
 * event, so navigation calls this directly. Both need the same
 * save-then-swap sequence, so it lives in one place rather than being
 * reimplemented on the side that came second.
 */
export type CanvasTarget = {
  kind: string;
  id: string;
  title: string;
  spaceId?: string;
  page?: string;
  filePath?: string;
};

async function saveAndUnmountCurrent(): Promise<boolean> {
  const saveResult = await saveCanvasEditor();
  if (!saveResult.success) {
    canvasSaveStatus.textContent = '✗ save failed — current canvas kept open';
    return false;
  }
  const finalContent = getCanvasContent();
  let closeResult: CanvasSaveResult = { success: true };
  if (canvasSkillId) {
    await saveSkillFromCanvas(canvasSkillId, finalContent);
  } else if (canvasFilePath) {
    const fileSpaceId = `__file__${encodeURIComponent(canvasFilePath)}`;
    closeResult = await whimAPI.closeCanvas(fileSpaceId, finalContent);
  } else if (canvasPageSpaceId && canvasPageName) {
    closeResult = await whimAPI.closePage(canvasPageSpaceId, canvasPageName, finalContent);
  } else if (canvasSpaceId) {
    closeResult = await whimAPI.closeCanvas(canvasSpaceId, finalContent);
  }
  if (!closeResult.success) {
    canvasSaveStatus.textContent = '✗ close save failed — current canvas kept open';
    return false;
  }
  await unmountCanvas(false);
  canvasSkillId = null;
  canvasFilePath = null;
  canvasPageSpaceId = null;
  canvasPageName = null;
  canvasSpaceId = null;
  resetCanvasAgentMaps();
  syncCanvasAgentThreadStatuses();
  return true;
}

async function openCanvasTarget(target: CanvasTarget): Promise<void> {
  // If a canvas is already open, save and close it first
  if (canvasSpaceId || canvasSkillId || canvasPageSpaceId || canvasFilePath) {
    if (!await saveAndUnmountCurrent()) return;
  }

  if (target.kind === 'skill') {
    cachedSkills = await whimAPI.listSkills();
    await openSkillEditor(target.id);
  } else if (target.kind === 'page') {
    await openPage(target.spaceId!, target.page!);
  } else if (target.kind === 'file') {
    await openWorkspaceFile(target.filePath!, target.title);
  } else {
    // Populate space data so openCanvas() can find it
    const targetTitle = target.title?.trim();
    if (!spaces.find(i => i.id === target.id)) {
      spaces.push({
        id: target.id,
        description: targetTitle || 'Untitled',
        body: null, raw_text: null, client: null,
        due_at: null, due_at_utc: null, recurrence: null,
        completed_at: null, folder: null, session_id: null,
        attachments: [],
        status: 'captured',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } else {
      const existing = spaces.find(i => i.id === target.id)!;
      if (targetTitle) existing.description = targetTitle;
    }

    await openCanvas(target.id);
  }
}

(window as any).openCanvas = openCanvas;

// Inline navigation — `whim://` links inside a canvas, and anywhere else that
// would have asked the main process for a window. Only meaningful where the
// canvas shares this window; the popout is driven by the main process instead.
if (!canvasPopsOut) {
  (window as any).openCanvasTarget = openCanvasTarget;
}

// ── Agent Chat View ────────────────────────────────────
import { mountChat, unmountChat } from './chat/mount.tsx';

const chatView = document.getElementById('chat-view') as HTMLDivElement;
const chatRoot = document.getElementById('chat-root') as HTMLDivElement;

async function openAgentChat(agentId: string | undefined, agentPrompt: string, agentStatus: string, agentSource?: 'sdk' | 'cli' | 'cca', spaceId?: string): Promise<void> {
  // Hide other views, show chat inline
  mainView.classList.add('hidden');
  hideSettings();
  timelineView.classList.add('hidden');
  canvasView.classList.add('hidden');
  chatView.classList.remove('hidden');

  // Look up pending approval info if agent is waiting
  const approval = agentId ? agentApprovals.get(agentId) : undefined;

  // Look up sandbox + yolo state from the most recent agent list data
  const agentData = renderedAgents?.find((a: any) => a.agentId === agentId);
  const sandboxed = (agentData as any)?.sandboxed === true;
  const yolo = (agentData as any)?.yoloMode === true;

  mountChat(chatRoot, {
    agentId,
    agentPrompt,
    agentStatus,
    agentSource,
    spaceId,
    sandboxed,
    yolo,
    pendingApprovalId: approval?.requestId,
    pendingPermissionKind: approval?.permissionKind,
    onClose: () => closeAgentChat(),
    onOpenCli: (id: string) => whimAPI.openAgentCli(id),
    onOpenCanvas: spaceId ? (id: string) => {
      const space = spaces.find(i => i.id === id);
      if (space) {
        whimAPI.openCanvasWindow({ kind: 'space', id, title: space.description });
      }
    } : undefined,
  });
}

function closeAgentChat(): void {
  unmountChat();

  chatView.classList.add('hidden');
  mainView.classList.remove('hidden');
  descInput.focus();
  // Refresh the agents list in case a new agent was created
  if (currentFilter === 'agents') renderAgentsList();
}

(window as any).openAgentChat = openAgentChat;

// Listen for cross-window agent chat requests from canvas window
if (!isCanvasMode) {
  whimAPI.onOpenAgentChatInPanel((data) => {
    openAgentChat(data.agentId, data.agentPrompt, data.agentStatus, data.agentSource, data.spaceId);
  });

  // Canvas can ask the main window to open the persona sandbox editor for the
  // persona that launched a blocked agent. Routed through the same renderer
  // helper used by AgentsList's "Edit sandbox config" button.
  whimAPI.onOpenPersonaSandboxEditor(({ personaHandle }) => {
    if (personaHandle) {
      openPersonaEditorForSandbox(personaHandle);
    }
  });
}

// ── Agent Presence Management ──────────────────────────
const canvasAgentPresence = new Map<string, CanvasPresence>();
const canvasAgentUserMap = new Map<string, CanvasUser>();
// Agents anchored to a comment thread — presence handles their busy state,
// so the text-decoration system should skip them.
const commentThreadAgents = new Set<string>();
const commentThreadByAgent = new Map<string, string>();
const canvasAgentRawStatus = new Map<string, string>();
const canvasThreadAgentStatuses = new Map<string, CanvasThreadAgentStatus>();
const canvasAgentInteractions = new Map<string, CanvasAgentInteraction>();

const AGENT_PRESENCE_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f97316', // orange
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f43f5e', // rose
];

function agentColor(handle: string): string {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) hash = ((hash << 5) - hash + handle.charCodeAt(i)) | 0;
  return AGENT_PRESENCE_COLORS[Math.abs(hash) % AGENT_PRESENCE_COLORS.length];
}

/** Map a raw agent status to a short label shown next to the presence cursor. */
function presenceStatusLabel(status: string): string {
  switch (status) {
    case 'running':          return 'Running…';
    case 'idle':             return 'Idle';
    case 'waiting-approval': return 'Needs approval';
    case 'completed':        return 'Done';
    case 'failed':           return 'Failed';
    case 'cancelled':        return 'Cancelled';
    default:                 return status;
  }
}

/** Patch the status field on an active agent's presence and resync. */
function updateAgentPresenceStatus(agentId: string, status: string): void {
  const entry = canvasAgentPresence.get(agentId);
  if (!entry) return;
  const label = presenceStatusLabel(status);
  if (entry.status === label) return;
  canvasAgentPresence.set(agentId, { ...entry, status: label });
  syncCanvasPresence();
}

function syncCanvasPresence(): void {
  updateCanvasPresence(Array.from(canvasAgentPresence.values()));
  updateCanvasAgentUsers(Array.from(canvasAgentUserMap.values()));
}

function hasPendingCanvasInteraction(agentId: string): boolean {
  for (const interaction of canvasAgentInteractions.values()) {
    if (interaction.agentId === agentId && !interaction.responded) return true;
  }
  return false;
}

function threadStatusForAgent(agentId: string, status: string): CanvasThreadAgentStatus['status'] {
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'completed') return 'completed';
  if (status === 'waiting-approval' || hasPendingCanvasInteraction(agentId)) return 'waiting';
  return canvasAgentPresence.has(agentId) ? 'active' : 'starting';
}

function threadStatusLabel(status: CanvasThreadAgentStatus['status']): string {
  switch (status) {
    case 'starting': return 'Agent starting...';
    case 'active': return 'Agent working in this thread';
    case 'waiting': return 'Agent waiting for you';
    case 'completed': return 'Agent completed';
    case 'failed': return 'Agent failed';
  }
}

function syncCanvasAgentThreadStatuses(): void {
  updateCanvasAgentThreadStatuses(Array.from(canvasThreadAgentStatuses.values()));
  updateCanvasAgentInteractions(Array.from(canvasAgentInteractions.values()));
}

/** Drop all in-memory comment-thread agent state. Used when switching canvases
 *  and as the first step of rehydration so a fresh canvas never inherits the
 *  previously-open document's agents. Pure data reset — callers sync as needed. */
function resetCanvasAgentMaps(): void {
  canvasAgentPresence.clear();
  canvasAgentUserMap.clear();
  commentThreadAgents.clear();
  commentThreadByAgent.clear();
  canvasAgentRawStatus.clear();
  canvasThreadAgentStatuses.clear();
  canvasAgentInteractions.clear();
}

/**
 * Rebuild the canvas's live agent state from the main process so a (re)mounted
 * canvas shows its comment-thread agents as still alive — after in-app
 * navigation, opening a pop-out window, or an app restart. The main-process
 * snapshot is authoritative: it overlays the live registry on persisted
 * sessions, so cloud agents that survived a restart appear active while local
 * agents whose process is gone appear failed ("needs redeploy").
 */
async function rehydrateCanvasAgents(spaceId: string): Promise<void> {
  let snapshot: CanvasAgentStateSnapshot[];
  try {
    snapshot = await whimAPI.getCanvasAgentState(spaceId);
  } catch {
    return;
  }
  // Bail if the user navigated to a different canvas while we were fetching.
  if (currentCanvasAgentSpaceId() !== spaceId) return;

  resetCanvasAgentMaps();

  for (const agent of snapshot) {
    const { agentId, threadId, personaHandle, status } = agent;
    commentThreadAgents.add(agentId);
    commentThreadByAgent.set(agentId, threadId);
    canvasAgentRawStatus.set(
      agentId,
      status === 'waiting' ? 'waiting-approval' : status === 'failed' ? 'failed' : 'running',
    );

    canvasThreadAgentStatuses.set(threadId, {
      threadId,
      agentId,
      status,
      label: threadStatusLabel(status),
    });

    // Show a live presence cursor only for agents that are still alive.
    if (status === 'starting' || status === 'active' || status === 'waiting') {
      canvasAgentPresence.set(agentId, {
        userId: agentId,
        color: agentColor(personaHandle),
        cursor: { threadId },
        status: presenceStatusLabel(status === 'waiting' ? 'waiting-approval' : 'running'),
      });
      canvasAgentUserMap.set(agentId, { id: agentId, username: personaHandle });
    }

    for (const interaction of agent.pendingInteractions) {
      canvasAgentInteractions.set(
        canvasInteractionKey(interaction.kind, interaction.requestId),
        interaction as CanvasAgentInteraction,
      );
    }
  }

  syncCanvasPresence();
  syncCanvasAgentThreadStatuses();
}

function updateCommentThreadAgentStatus(agentId: string, rawStatus?: string, explicitThreadId?: string | null): void {
  const threadId = explicitThreadId ?? commentThreadByAgent.get(agentId);
  if (!threadId) return;
  commentThreadAgents.add(agentId);
  commentThreadByAgent.set(agentId, threadId);
  if (rawStatus) canvasAgentRawStatus.set(agentId, rawStatus);
  const status = threadStatusForAgent(agentId, canvasAgentRawStatus.get(agentId) ?? 'running');
  canvasThreadAgentStatuses.set(threadId, {
    threadId,
    agentId,
    status,
    label: threadStatusLabel(status),
  });
  syncCanvasAgentThreadStatuses();
}

function clearCommentThreadAgent(agentId: string): void {
  const threadId = commentThreadByAgent.get(agentId);
  if (threadId) {
    const existing = canvasThreadAgentStatuses.get(threadId);
    if (existing?.agentId === agentId) canvasThreadAgentStatuses.delete(threadId);
  }
  commentThreadAgents.delete(agentId);
  commentThreadByAgent.delete(agentId);
  canvasAgentRawStatus.delete(agentId);
  for (const [key, interaction] of canvasAgentInteractions.entries()) {
    if (interaction.agentId === agentId) canvasAgentInteractions.delete(key);
  }
  syncCanvasAgentThreadStatuses();
}

function canvasInteractionKey(kind: CanvasAgentInteraction['kind'], requestId: string): string {
  return `${kind}:${requestId}`;
}

function shouldTrackCanvasInteraction(agentId: string, spaceId?: string, threadId?: string | null): boolean {
  const activeSpaceId = currentCanvasAgentSpaceId();
  if (!activeSpaceId) return false;
  if (spaceId && spaceId !== activeSpaceId) return false;
  return !!threadId || commentThreadByAgent.has(agentId);
}

function upsertCanvasAgentInteraction(interaction: CanvasAgentInteraction, threadId?: string | null): void {
  if (threadId) {
    commentThreadAgents.add(interaction.agentId);
    commentThreadByAgent.set(interaction.agentId, threadId);
  }
  canvasAgentInteractions.set(canvasInteractionKey(interaction.kind, interaction.requestId), interaction);
  updateCommentThreadAgentStatus(interaction.agentId, 'waiting-approval', threadId);
}

function markCanvasAgentInteractionResolved(
  kind: CanvasAgentInteraction['kind'],
  agentId: string,
  requestId: string,
  patch: Partial<CanvasAgentInteraction>,
): void {
  const key = canvasInteractionKey(kind, requestId);
  const existing = canvasAgentInteractions.get(key);
  if (existing) {
    canvasAgentInteractions.set(key, { ...existing, ...patch, responded: true } as CanvasAgentInteraction);
  }
  if (!hasPendingCanvasInteraction(agentId) && canvasAgentRawStatus.get(agentId) === 'waiting-approval') {
    canvasAgentRawStatus.set(agentId, 'running');
  }
  updateCommentThreadAgentStatus(agentId);
}

whimAPI.onAgentPresenceStarted((data) => {
  const activeSpaceId = currentCanvasAgentSpaceId();
  if (!activeSpaceId || data.spaceId !== activeSpaceId) return;
  const cursor = data.threadId
    ? { threadId: data.threadId }
    : (data.anchor?.prefix || data.anchor?.suffix ? data.anchor : undefined);
  if (data.threadId) {
    commentThreadAgents.add(data.agentId);
    commentThreadByAgent.set(data.agentId, data.threadId);
  }
  canvasAgentPresence.set(data.agentId, {
    userId: data.agentId,
    color: agentColor(data.persona.handle),
    cursor,
    status: presenceStatusLabel('running'),
  });
  canvasAgentUserMap.set(data.agentId, {
    id: data.agentId,
    username: data.persona.handle,
  });
  syncCanvasPresence();
  if (data.threadId) updateCommentThreadAgentStatus(data.agentId, 'running', data.threadId);
});

whimAPI.onAgentPresenceEnded((data) => {
  canvasAgentPresence.delete(data.agentId);
  canvasAgentUserMap.delete(data.agentId);
  clearCommentThreadAgent(data.agentId);
  syncCanvasPresence();
});

whimAPI.onAgentReplyReady((data) => {
  const activeSpaceId = currentCanvasAgentSpaceId();
  if (!activeSpaceId || data.spaceId !== activeSpaceId) return;
  if (data.threadId) addCanvasCommentReply(data.threadId, data.body);
});

whimAPI.onCanvasContentUpdated((data) => {
  const activeSpaceId = currentCanvasExportId();
  if (!activeSpaceId || data.spaceId !== activeSpaceId) return;
  replaceCanvasContent(data.content);
});

// ── Agent Activity Decorations ─────────────────────────
// Tracks active agents and decorates the text they were spawned on

interface AgentDecorationEntry {
  status: string;
  decorationText: string;
}

const agentDecorationMap = new Map<string, AgentDecorationEntry>();
let decorationFlashTimers: ReturnType<typeof setTimeout>[] = [];

const DECORATION_COLORS: Record<string, { bg: string; pulse?: boolean }> = {
  'running':          { bg: 'rgba(96, 165, 250, 0.15)', pulse: true },
  'waiting-approval': { bg: 'rgba(251, 191, 36, 0.18)', pulse: true },
  'completed':        { bg: 'rgba(74, 222, 128, 0.18)' },
  'failed':           { bg: 'rgba(248, 113, 113, 0.18)' },
};

const MIN_DECORATION_TEXT = 5;
const MAX_DECORATION_TEXT = 300;

/** Escape a string for use in a RegExp literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pick the best text to use for a decoration pattern.
 * Prefer quotedText (actual document text) over selectedText (may be prompt or full doc).
 */
function pickDecorationText(agent: { selectedText: string; quotedText?: string }): string {
  const quoted = agent.quotedText?.trim() ?? '';
  if (quoted.length >= MIN_DECORATION_TEXT && quoted.length <= MAX_DECORATION_TEXT) return quoted;
  const selected = agent.selectedText?.trim() ?? '';
  if (selected.length >= MIN_DECORATION_TEXT && selected.length <= MAX_DECORATION_TEXT) return selected;
  return '';
}

/** Rebuild CanvasDecoration[] from the tracking map and push to canvas. */
function syncCanvasDecorations(): void {
  if (!currentCanvasAgentSpaceId()) return;

  const decorations: CanvasDecoration[] = [];
  for (const entry of agentDecorationMap.values()) {
    if (!entry.decorationText) continue;
    const colors = DECORATION_COLORS[entry.status];
    if (!colors) continue;
    try {
      decorations.push({
        pattern: new RegExp(escapeRegex(entry.decorationText)),
        backgroundColor: colors.bg,
        ...(colors.pulse ? { pulse: true } : {}),
      });
    } catch { /* invalid regex — skip */ }
  }
  updateCanvasDecorations(decorations);
}

/** Refresh agent decorations from the current canvas's agent list. */
async function refreshAgentDecorations(): Promise<void> {
  const activeSpaceId = currentCanvasAgentSpaceId();
  if (!activeSpaceId) return;
  try {
    const agents = await whimAPI.listAgents(activeSpaceId);
    // Remove stale entries
    const activeIds = new Set(agents.map((a: any) => a.agentId));
    for (const id of agentDecorationMap.keys()) {
      if (!activeIds.has(id)) agentDecorationMap.delete(id);
    }
    // Update/add entries for active agents
    for (const agent of agents) {
      // Comment-thread agents use presence for busy state — no text decoration
      if (commentThreadAgents.has(agent.agentId)) continue;
      const text = pickDecorationText(agent);
      if (agent.status === 'completed' || agent.status === 'failed') {
        // Terminal states get a brief flash then removal
        if (!agentDecorationMap.has(agent.agentId)) continue;
        agentDecorationMap.set(agent.agentId, { status: agent.status, decorationText: text });
      } else {
        agentDecorationMap.set(agent.agentId, { status: agent.status, decorationText: text });
      }
    }
    syncCanvasDecorations();
  } catch { /* ignore — canvas may not be active */ }
}

function clearAgentDecorations(): void {
  agentDecorationMap.clear();
  for (const t of decorationFlashTimers) clearTimeout(t);
  decorationFlashTimers = [];
  updateCanvasDecorations([]);
}

// ── Global agent status/approval listeners ─────────────
whimAPI.onAgentStatusChanged((data: any) => {
  scheduleAgentListRefresh();
  scheduleAgentSpacesRefresh();
  // Clear steps if agent restarted
  if (data.status === 'running' && !agentSteps.has(data.agentId)) {
    agentSteps.set(data.agentId, []);
  }
  // Clear approval and badge when agent is no longer waiting
  if (data.status !== 'waiting-approval') {
    agentApprovals.delete(data.agentId);
    updateWorkersBadge();
  }

  // Update presence status badge so collaborators see live agent state next
  // to the cursor in the document.
  const activeAgentSpaceId = currentCanvasAgentSpaceId();
  if (!data.spaceId || data.spaceId === activeAgentSpaceId) {
    updateAgentPresenceStatus(data.agentId, data.status);
    updateCommentThreadAgentStatus(data.agentId, data.status, data.threadId);
  }

  // If the agent serving the app-level remote URL completed or failed, clear
  // stale state so the next click on the remote button reconciles.
  if (
    (data.status === 'completed' || data.status === 'failed') &&
    appRemoteAgentId === data.agentId
  ) {
    appRemoteUrl = null;
    appRemoteAgentId = null;
    if (appRemoteOverlayEl) showAppRemoteOverlay();
  }

  // Update agent activity decorations on canvas (skip comment-thread agents — presence handles those)
  if (currentCanvasAgentSpaceId() && !commentThreadAgents.has(data.agentId)) {
    if (data.status === 'completed' || data.status === 'failed') {
      // Flash terminal color for 2s, then remove
      const existing = agentDecorationMap.get(data.agentId);
      if (existing) {
        agentDecorationMap.set(data.agentId, { ...existing, status: data.status });
        syncCanvasDecorations();
        const timer = setTimeout(() => {
          agentDecorationMap.delete(data.agentId);
          syncCanvasDecorations();
        }, 2000);
        decorationFlashTimers.push(timer);
      }
    } else {
      refreshAgentDecorations();
    }
  }
});

whimAPI.onAgentApprovalNeeded((data: any) => {
  agentApprovals.set(data.agentId, {
    requestId: data.requestId,
    permissionKind: data.permissionKind || 'permission',
    intention: data.intention,
    path: data.path,
  });
  if (currentFilter === 'agents') {
    updateAgentCardApproval(data.agentId);
  }
  updateWorkersBadge();

  // Approval transitions don't always emit `agent:status-changed`, so update
  // the presence badge directly so the "Needs approval" label appears next to
  // the cursor in the canvas.
  updateAgentPresenceStatus(data.agentId, 'waiting-approval');
  if (shouldTrackCanvasInteraction(data.agentId, data.spaceId, data.threadId)) {
    upsertCanvasAgentInteraction({
      kind: 'approval',
      agentId: data.agentId,
      requestId: data.requestId,
      permissionKind: data.permissionKind || 'permission',
      intention: data.intention,
      path: data.path,
    }, data.threadId);
  }

  // Update decoration to waiting-approval color (skip comment-thread agents)
  if (currentCanvasAgentSpaceId() && !commentThreadAgents.has(data.agentId)) {
    refreshAgentDecorations();
  }
});

whimAPI.onAgentApprovalResolved((data) => {
  markCanvasAgentInteractionResolved('approval', data.agentId, data.requestId, { approved: data.approved });
});

whimAPI.onAgentUserInputRequested((data) => {
  if (!shouldTrackCanvasInteraction(data.agentId, data.spaceId, data.threadId)) return;
  upsertCanvasAgentInteraction({
    kind: 'user_input',
    agentId: data.agentId,
    requestId: data.requestId,
    question: data.question,
    choices: data.choices,
    allowFreeform: data.allowFreeform,
  }, data.threadId);
});

whimAPI.onAgentUserInputResolved((data) => {
  markCanvasAgentInteractionResolved('user_input', data.agentId, data.requestId, {
    answer: data.answer,
    wasFreeform: data.wasFreeform,
  });
});

whimAPI.onAgentElicitationRequested((data) => {
  if (!shouldTrackCanvasInteraction(data.agentId, data.spaceId, data.threadId)) return;
  upsertCanvasAgentInteraction({
    kind: 'elicitation',
    agentId: data.agentId,
    requestId: data.requestId,
    message: data.message,
    requestedSchema: data.requestedSchema,
    mode: data.mode,
    elicitationSource: data.elicitationSource,
  }, data.threadId);
});

whimAPI.onAgentElicitationResolved((data) => {
  markCanvasAgentInteractionResolved('elicitation', data.agentId, data.requestId, {
    action: data.action,
    content: data.content,
  });
});

whimAPI.onAgentCompleted(() => {
  scheduleAgentListRefresh();
  scheduleAgentSpacesRefresh();
});

whimAPI.onAgentYoloChanged((data: { agentId: string; enabled: boolean }) => {
  agentYoloState.set(data.agentId, data.enabled);
  // Update the yolo button if visible
  const btn = document.querySelector(`.agent-card-yolo-btn[data-agent-id="${data.agentId}"]`) as HTMLElement | null;
  if (btn) {
    btn.classList.toggle('active', data.enabled);
    btn.title = data.enabled ? 'Yolo mode ON — click to disable' : 'Enable yolo mode (auto-approve all)';
  }
});

whimAPI.onAgentRemoteChanged((data: { agentId: string; enabled: boolean; remoteSteerable: boolean; url?: string }) => {
  agentRemoteState.set(data.agentId, { enabled: data.enabled, url: data.url });
  // Track the latest remote URL for the app-level overlay
  if (data.enabled && data.url && !appRemoteUrl) {
    appRemoteUrl = data.url;
    appRemoteAgentId = data.agentId;
    // Refresh the app-level overlay if it's open and was showing the no-link state
    if (appRemoteOverlayEl) showAppRemoteOverlay();
  } else if (appRemoteAgentId === data.agentId && (!data.enabled || !data.url)) {
    // The agent backing the app-level URL lost remote — clear stale state so
    // the next click can bootstrap a fresh worker.
    appRemoteUrl = null;
    appRemoteAgentId = null;
    if (appRemoteOverlayEl) showAppRemoteOverlay();
  }
  // Update the remote button if visible
  const btn = document.querySelector(`.agent-card-remote-btn[data-agent-id="${data.agentId}"]`) as HTMLElement | null;
  if (btn) {
    btn.classList.toggle('active', data.enabled);
    btn.title = data.enabled ? 'Remote control ON — click to view link' : 'Enable remote control';
  }
});

// ── Sandbox bubble-up handler ───────────────────────────
// Pending sandbox blocks live in agentStore.sandboxBlocks and render inline
// on each worker tile (canvas) and agent card (main app) via React. Cross-
// window dismissal is driven by the broker broadcasting both
// 'agent:sandbox-blocked' (set) and 'agent:sandbox-resolved' (clear).

/**
 * Switch to the Agents tab and scroll the persona editor to its sandbox
 * section, hydrating persona data first if needed. Used by the inline
 * sandbox-block panel's "Edit sandbox config" button. The pending block
 * stays in the store so the user can still Allow / Disable for that call.
 */
async function openPersonaEditorForSandbox(personaHandle: string): Promise<void> {
  if (personas.length === 0) {
    try { await loadPersonas(); } catch { /* fall through; lookup may fail */ }
  }
  const persona = personas.find(p => p.handle === personaHandle);
  if (persona) {
    setFilter('agents');
    selectAgent(persona.id);
    setTimeout(() => {
      const sandboxSection = document.querySelector('.persona-sandbox-row') as HTMLElement | null;
      sandboxSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }
}

whimAPI.onAgentSandboxBlocked((data: any) => {
  agentStore.setSandboxBlock(data);
  if (shouldTrackCanvasInteraction(data.agentId, data.spaceId, data.threadId)) {
    upsertCanvasAgentInteraction({
      kind: 'sandbox_block',
      agentId: data.agentId,
      requestId: data.requestId,
      source: data.source,
      blockKind: data.kind,
      toolName: data.toolName,
      target: data.target,
      intention: data.intention,
      allowedDecisions: data.allowedDecisions,
      layer: data.layer,
      personaHandle: data.personaHandle,
    }, data.threadId);
  }
  updateWorkersBadge();
});

whimAPI.onAgentSandboxResolved((data: { agentId: string; requestId: string; decision: 'allow-once' | 'allow-for-session' | 'disable'; spaceId?: string; threadId?: string | null }) => {
  agentStore.clearSandboxBlock(data.agentId, data.requestId);
  markCanvasAgentInteractionResolved('sandbox_block', data.agentId, data.requestId, { decision: data.decision });
  updateWorkersBadge();
});

// When the user clicks an OS notification, switch to Workers tab
whimAPI.onNotificationApprovalClicked(() => {
  setFilter('agents');
});

// ── Init ────────────────────────────────────────────────
descInput.focus();
loadSettings();
loadFocusState();
loadPinState();
loadRemoteState();

// Flush canvas saves when the window is about to close (app quit, reload)
window.addEventListener('beforeunload', (event) => {
  if (canvasClosing) return;
  if (!canvasSkillId && !canvasPageSpaceId && !canvasSpaceId && !canvasFilePath) return;
  event.preventDefault();
  void closeCanvas();
});

document.addEventListener('keydown', (e) => {
  // The tour has its own key handling (and Esc must not hide the pane there —
  // the whole point is teaching the global shortcut).
  if (tourActive) return;
  // When settings modal is open, only close shortcut is handled
  if (settingsModalOpen) {
    if (matchesHotkey(e, 'close')) {
      if (isSettingsMode) {
        window.close();
      } else {
        hideSettings();
      }
    }
    return;
  }

  // Cycle workspace profiles (main window only — popouts close on switch).
  if (!isCanvasMode && !isSettingsMode && matchesHotkey(e, 'switchProfile')) {
    e.preventDefault();
    void cycleProfileFromUI();
    return;
  }

  // Arrow/Enter navigation in the space list
  if (!mainView.classList.contains('hidden')) {
    // Agent list navigation
    if (currentFilter === 'agents') {
      const agentItems = listEl.querySelectorAll('.agent-card');
      if (matchesHotkey(e, 'navigateDown') && selectedIndex >= 0) {
        e.preventDefault();
        if (selectedIndex < agentItems.length - 1) {
          selectedIndex++;
          updateAgentSelection();
        }
        return;
      }
      if (matchesHotkey(e, 'navigateUp') && selectedIndex >= 0) {
        e.preventDefault();
        if (selectedIndex === 0) {
          selectedIndex = -1;
          updateAgentSelection();
          newAgentBtn.classList.contains('hidden') ? descInput.focus() : newAgentBtn.focus();
        } else {
          selectedIndex--;
          updateAgentSelection();
        }
        return;
      }
      // Pop out agent chat in a new canvas window
      if (matchesHotkey(e, 'popOutWindow')) {
        e.preventDefault();
        const agent = selectedIndex >= 0
          ? renderedAgents[selectedIndex]
          : renderedAgents[0];
        if (agent?.spaceId && agent.spaceId !== '__workspace__') {
          const space = spaces.find(s => s.id === agent.spaceId);
          whimAPI.openNewCanvasWindow({ kind: 'space', id: agent.spaceId, title: space?.description || agent.summary || 'Agent' });
        }
        return;
      }
      if (matchesHotkey(e, 'openSubmit') && selectedIndex >= 0 && document.activeElement !== newAgentBtn) {
        e.preventDefault();
        const agent = renderedAgents[selectedIndex];
        if (agent) {
          openAgentChat(agent.agentId, agent.selectedText, agent.status, agent.source, agent.spaceId);
        }
        return;
      }
    } else {
      // Space list navigation
      if (matchesHotkey(e, 'navigateDown') && selectedIndex >= 0) {
        e.preventDefault();
        if (selectedIndex < displayedSpaces.length - 1) {
          selectedIndex++;
          updateSelection();
        }
        return;
      }
      if (matchesHotkey(e, 'navigateUp') && selectedIndex >= 0) {
        e.preventDefault();
        if (selectedIndex === 0) {
          selectedIndex = -1;
          updateSelection();
          descInput.focus();
        } else {
          selectedIndex--;
          updateSelection();
        }
        return;
      }
      // Pop out: open canvas in a new window
      if (matchesHotkey(e, 'popOutWindow')) {
        e.preventDefault();
        const target = selectedIndex >= 0
          ? displayedSpaces[selectedIndex]
          : displayedSpaces[0];
        if (target) {
          whimAPI.openNewCanvasWindow({ kind: 'space', id: target.id, title: target.description });
        }
        return;
      }
      // Open/Submit: open full editor for selected space
      if (matchesHotkey(e, 'openSubmit') && selectedIndex >= 0 && document.activeElement !== descInput) {
        e.preventDefault();
        const space = displayedSpaces[selectedIndex];
        if (space) openCanvas(space.id, true);
        return;
      }
    }
  }

  // Stop voice recording
  if (matchesHotkey(e, 'stopRecording') && isRecording) {
    e.preventDefault();
    stopRecording();
    return;
  }

  if (matchesHotkey(e, 'close')) {
    if (isRecording) stopRecording();
    if (!chatView.classList.contains('hidden')) {
      closeAgentChat();
      return;
    }
    if (!canvasView.classList.contains('hidden')) {
      closeCanvas();
      return;
    }
    if (!timelineView.classList.contains('hidden')) {
      hideTimeline();
      return;
    }
    slideOut();
  }
});

whimAPI.onWindowShown((data) => {
  // Quick-start tour owns the window while it runs: don't reset the (hidden)
  // main view, just slide back in and credit whatever the user just did.
  if (tourActive) {
    if (!data.expanded) {
      slideIn(data.side);
    } else {
      appEl.classList.remove('app-hidden-left', 'app-hidden-right', 'app-no-transition');
      windowVisualState = 'visible';
    }
    noteTourShow(data.source);
    return;
  }

  // Close any sub-views that were open when the window was hidden
  if (!chatView.classList.contains('hidden')) closeAgentChat();
  if (!canvasView.classList.contains('hidden')) closeCanvas();
  if (settingsModalOpen) hideSettings();
  if (!timelineView.classList.contains('hidden')) hideTimeline();

  selectedIndex = -1;
  searchResults = null;
  spaceStore.setSearchResults(null);
  if (searchMode) exitSearchMode();
  // Always land on Spaces tab with focus in capture field
  setFilter('open');
  descInput.focus();
  descInput.select();
  hideStatus();
  // Refresh active session state when window reappears
  loadSpaces();
  refreshGitSync();

  // Slide in from the appropriate edge
  if (!data.expanded) {
    slideIn(data.side);
  } else {
    // Expanded mode: no slide, just make visible immediately
    appEl.classList.remove('app-hidden-left', 'app-hidden-right', 'app-no-transition');
    windowVisualState = 'visible';
  }
});

whimAPI.onWindowToggle((data) => {
  // Always hide the window immediately — Escape handles sub-view navigation
  if (tourActive) noteTourHide(data?.source);
  slideOut();
});

whimAPI.onRequestHide(() => {
  // The tour asks the user to hide the pane deliberately — an incidental blur
  // hide would both confuse the lesson and lose the window mid-instruction.
  if (tourActive) return;
  // Blur-triggered hide: check if we should stay visible
  const hasInput = descInput && descInput.value.trim().length > 0;
  const canvasOpen = !canvasView.classList.contains('hidden');
  const chatOpen = !chatView.classList.contains('hidden');
  if (hasInput || canvasOpen || chatOpen) return;

  slideOut();
});

// ── Quick start tour (hotkey + tray coach, runs before setup) ──
/**
 * A fresh install drops the user into a side pane with no indication that it
 * hides, how to bring it back, or that a tray icon exists. This short tour runs
 * *before* the setup view and has the user actually perform both actions, so the
 * muscle memory is there before they ever lose the window.
 */
type TourStep = 'hotkey' | 'tray';

let tourActive = false;
let tourStep: TourStep = 'hotkey';
let tourReturnTo: 'welcome' | 'main' = 'welcome';
let tourToggleRegistered = true;
let tourHotkeyRecording = false;
let tourAdvanceTimer: number | null = null;
const tourDone = { hide: false, show: false, trayHide: false, trayClick: false };

const isMacTray = navigator.platform.toLowerCase().includes('mac');

function toggleAccelerator(): string {
  return currentHotkeys.toggleWindow || DEFAULT_HOTKEYS.toggleWindow;
}

function formattedToggleAccelerator(): string {
  return formatAccelerator(toggleAccelerator(), hotkeyPlatform);
}

/** Per-key labels for the toggle accelerator, e.g. ['\u2318', '\u21e7', 'Space']. */
function toggleAcceleratorParts(): string[] {
  return toggleAccelerator()
    .split('+')
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => formatAccelerator(token, hotkeyPlatform));
}

/** Keep every "toggle whim" hint in the UI showing the *current* binding. */
function syncToggleHotkeyLabels(): void {
  const label = formattedToggleAccelerator();
  const parts = toggleAcceleratorParts();
  document.querySelectorAll('[data-toggle-hotkey]').forEach(el => {
    el.textContent = '';
    for (const part of parts) {
      const kbd = document.createElement('kbd');
      kbd.textContent = part;
      el.appendChild(kbd);
    }
    if (!el.childElementCount) el.textContent = label;
  });
  if (tourHotkeyChip && !tourHotkeyRecording) tourHotkeyChip.textContent = label;
  if (tourTrayKeys) tourTrayKeys.textContent = label;
}

function setTourHint(message: string, warn = false): void {
  if (!tourHotkeyHint) return;
  tourHotkeyHint.textContent = message;
  tourHotkeyHint.classList.toggle('warn', warn);
}

const TOUR_DEFAULT_HINT = 'Prefer a different combo? Click the shortcut above and press the keys you want.';

function markCheck(el: HTMLElement | null, done: boolean, active: boolean): void {
  if (!el) return;
  el.classList.toggle('done', done);
  el.classList.toggle('active', !done && active);
}

function renderTour(): void {
  if (!tourView) return;
  const onHotkey = tourStep === 'hotkey';
  tourStepHotkey?.classList.toggle('hidden', !onHotkey);
  tourStepTray?.classList.toggle('hidden', onHotkey);

  tourProgress?.querySelectorAll('[data-tour-dot]').forEach(dot => {
    const key = (dot as HTMLElement).dataset.tourDot;
    dot.classList.toggle('active', key === tourStep);
    dot.classList.toggle('done', key === 'hotkey' && !onHotkey);
  });
  tourProgress?.setAttribute('aria-valuenow', onHotkey ? '1' : '2');

  markCheck(tourCheckHide, tourDone.hide, true);
  markCheck(tourCheckShow, tourDone.show, tourDone.hide);
  markCheck(tourCheckTrayHide, tourDone.trayHide, true);
  markCheck(tourCheckTrayClick, tourDone.trayClick, tourDone.trayHide);

  const hotkeyStepDone = tourDone.hide && tourDone.show;
  if (tourHotkeyNext) {
    tourHotkeyNext.textContent = hotkeyStepDone ? 'Nice — next' : 'Next';
  }
  // Without a working global shortcut the user can't hide the pane themselves,
  // so offer a button that does it for them (the tray lesson still lands).
  tourTrayHideFallback?.classList.toggle('hidden', tourToggleRegistered || tourDone.trayHide);
  tourHotkeyReset?.classList.toggle('hidden', toggleAccelerator() === DEFAULT_HOTKEYS.toggleWindow);

  syncToggleHotkeyLabels();
}

function tourGoToStep(step: TourStep): void {
  tourStep = step;
  if (tourAdvanceTimer !== null) {
    window.clearTimeout(tourAdvanceTimer);
    tourAdvanceTimer = null;
  }
  renderTour();
}

/** Credit a hide that the user performed themselves. */
function noteTourHide(source: string | undefined): void {
  if (!tourActive) return;
  if (tourStep === 'hotkey') {
    // Older/stale preload bundles may omit the source metadata even though
    // the global shortcut successfully toggled the window. Blur hides use a
    // separate event, so any non-tray toggle here is safe to count.
    if (source === 'tray' || source === 'startup') return;
    tourDone.hide = true;
  } else {
    tourDone.trayHide = true;
  }
  renderTour();
}

/** Credit a show, but only when it came from the mechanism we're teaching. */
function noteTourShow(source: string | undefined): void {
  if (!tourActive) return;
  if (tourStep === 'hotkey') {
    if (source === 'hotkey') {
      // Showing via the hotkey means they pressed it — credit the hide too, in
      // case the pane was already hidden (e.g. a blur) when the tour began.
      tourDone.hide = true;
      tourDone.show = true;
    } else if (source === 'tray') {
      // They discovered the tray early — bank it for step 2.
      tourDone.trayHide = true;
      tourDone.trayClick = true;
    } else if (source !== 'startup' && tourDone.hide) {
      // A missing/legacy source still proves the second half of the cycle
      // when this renderer already observed the corresponding toggle hide.
      tourDone.show = true;
    }
  } else if (tourStep === 'tray') {
    if (source === 'tray') {
      tourDone.trayHide = true;
      tourDone.trayClick = true;
    } else if (source === 'hotkey') {
      setTourHint(TOUR_DEFAULT_HINT);
    }
  }
  renderTour();

  if (tourStep === 'hotkey' && tourDone.hide && tourDone.show && tourAdvanceTimer === null) {
    tourAdvanceTimer = window.setTimeout(() => {
      tourAdvanceTimer = null;
      if (tourActive && tourStep === 'hotkey') tourGoToStep('tray');
    }, 1100);
  }
}

/** Record a replacement accelerator for the global toggle, inline in the tour. */
function startTourHotkeyRecording(): void {
  if (!tourHotkeyChip || tourHotkeyRecording) return;
  tourHotkeyRecording = true;
  tourHotkeyChip.classList.add('recording');
  tourHotkeyChip.textContent = 'Press shortcut…';
  setTourHint('Hold your modifiers and press a key. Esc cancels.');

  const stop = (): void => {
    tourHotkeyRecording = false;
    tourHotkeyChip.classList.remove('recording');
    document.removeEventListener('keydown', handler, true);
  };

  const handler = async (e: KeyboardEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (e.key === 'Escape') {
      stop();
      setTourHint(TOUR_DEFAULT_HINT);
      renderTour();
      return;
    }

    const accel = keyboardEventToAccelerator(e, hotkeyPlatform);
    if (!accel) {
      const modifiers = modifierEventToAccelerator(e, hotkeyPlatform);
      tourHotkeyChip.textContent = modifiers
        ? `${formatAccelerator(modifiers, hotkeyPlatform)}…`
        : 'Press shortcut…';
      return;
    }

    const conflict = findConflict(accel, 'toggleWindow');
    if (conflict) {
      setTourHint(`⚠ Conflicts with "${conflict}" — try another combo.`, true);
      return;
    }

    stop();
    const result = await whimAPI.setHotkey('toggleWindow', accel);
    if (result.error) {
      setTourHint(`⚠ ${result.error}`, true);
      renderTour();
      return;
    }
    currentHotkeys.toggleWindow = accel;
    tourToggleRegistered = true;
    renderHotkeysTab();
    setTourHint(`Shortcut set to ${formatAccelerator(accel, hotkeyPlatform)}. Give it a try.`);
    renderTour();
  };

  document.addEventListener('keydown', handler, true);
}

async function showTourView(returnTo: 'welcome' | 'main' = 'welcome'): Promise<void> {
  if (isCanvasMode || isSettingsMode) return;
  tourActive = true;
  tourReturnTo = returnTo;
  tourStep = 'hotkey';
  tourDone.hide = false;
  tourDone.show = false;
  tourDone.trayHide = false;
  tourDone.trayClick = false;

  mainView.classList.add('hidden');
  welcomeView.classList.add('hidden');
  tourView.classList.remove('hidden');

  // Platform wording: menu bar (top-right) on macOS, system tray (bottom-right)
  // everywhere else — where Windows may also tuck it behind the "^" overflow.
  tourView.classList.toggle('tray-bottom', !isMacTray);
  if (tourTrayTitle) {
    tourTrayTitle.textContent = isMacTray
      ? 'whim also lives in your menu bar'
      : 'whim also lives in your system tray';
  }
  if (tourTrayText) {
    tourTrayText.textContent = isMacTray
      ? 'Forget the shortcut? Click the whim icon in the menu bar and the pane comes right back.'
      : 'Forget the shortcut? Click the whim icon in the system tray and the pane comes right back.';
  }
  if (tourTrayArrow) tourTrayArrow.textContent = isMacTray ? '↑' : '↓';
  if (tourTrayCaption) {
    tourTrayCaption.textContent = isMacTray
      ? 'Look for it at the top-right of your screen.'
      : 'Look for it near the clock — you may need to expand the “^” overflow first.';
  }

  if (tourTrayNext) {
    tourTrayNext.textContent = returnTo === 'welcome' ? 'Continue to setup' : 'Done';
  }
  setTourHint(TOUR_DEFAULT_HINT);

  try {
    const status = await whimAPI.getToggleShortcutStatus();
    tourToggleRegistered = status.registered !== false;
    if (status.accelerator) currentHotkeys.toggleWindow = status.accelerator;
    if (!tourToggleRegistered) {
      setTourHint(
        `⚠ ${formattedToggleAccelerator()} is already taken by another app. Click it above to pick a different combo.`,
        true,
      );
    }
  } catch {
    tourToggleRegistered = true;
  }

  renderTour();
  tourHotkeyChip?.focus();
}

async function finishTour(): Promise<void> {
  if (!tourActive) return;
  tourActive = false;
  if (tourAdvanceTimer !== null) {
    window.clearTimeout(tourAdvanceTimer);
    tourAdvanceTimer = null;
  }
  tourView.classList.add('hidden');
  await whimAPI.setSetting('quick_start_completed', '1');
  if (tourReturnTo === 'welcome') {
    void showWelcomeView();
  } else {
    mainView.classList.remove('hidden');
    descInput.focus();
    // The tour suppressed the usual on-show refresh, so catch the list up.
    void loadSpaces();
    refreshGitSync();
  }
}

tourHotkeyChip?.addEventListener('click', startTourHotkeyRecording);

tourHotkeyReset?.addEventListener('click', async () => {
  await whimAPI.resetHotkeys('toggleWindow');
  currentHotkeys.toggleWindow = DEFAULT_HOTKEYS.toggleWindow;
  tourToggleRegistered = true;
  renderHotkeysTab();
  setTourHint(TOUR_DEFAULT_HINT);
  renderTour();
});

tourHotkeyNext?.addEventListener('click', () => tourGoToStep('tray'));
tourHotkeySkip?.addEventListener('click', () => tourGoToStep('tray'));
tourTrayHideFallback?.addEventListener('click', () => {
  tourDone.trayHide = true;
  renderTour();
  slideOut();
});
tourTrayNext?.addEventListener('click', () => void finishTour());
tourTraySkip?.addEventListener('click', () => void finishTour());
tourSkipAll?.addEventListener('click', () => void finishTour());

// ── Welcome / Onboarding ────────────────────────────────
let welcomeWorkspaceSelected = false;
let welcomeCliReady = false;
let welcomeModelSelected = false;
/** Installs backing the onboarding CLI picker, kept to map a path to a source. */
let welcomeDiscoveredClis: Awaited<ReturnType<typeof populateCliSelect>> = [];

function updateWelcomeStartBtn(): void {
  welcomeStartBtn.disabled = !(welcomeWorkspaceSelected && welcomeCliReady && welcomeModelSelected);
}

async function showWelcomeView(): Promise<void> {
  mainView.classList.add('hidden');
  welcomeView.classList.remove('hidden');
  const savedWorkspace = await whimAPI.getSetting('workspace_root');
  welcomeWorkspaceSelected = !!savedWorkspace;
  welcomeCliReady = false;
  welcomeModelSelected = false;

  // Reset step states
  welcomeWorkspaceHint.textContent = savedWorkspace || 'A folder where your spaces, skills, and agent data will live.';
  welcomeWorkspaceHint.title = savedWorkspace || '';
  welcomeWorkspaceBtn.textContent = savedWorkspace ? 'Change…' : 'Choose Folder…';
  welcomeWorkspaceCheck.classList.toggle('hidden', !savedWorkspace);
  welcomeStepWorkspace.classList.toggle('done', !!savedWorkspace);
  welcomeCliCheck.classList.add('hidden');
  welcomeStepCli.classList.remove('done');
  welcomeCliStatus.textContent = 'Checking…';
  welcomeCliStatus.style.color = '';
  welcomeModelCheck.classList.add('hidden');
  welcomeStepModel.classList.remove('done');
  welcomeModelHint.textContent = WELCOME_MODEL_HINT;
  welcomeModelHint.style.color = '';
  welcomeModelSelect.innerHTML = '<option value="">Loading models…</option>';
  updateWelcomeStartBtn();

  // Load saved CLI path override into input, and list every install found
  const savedCliPath = await whimAPI.getSetting('cli_path');
  welcomeCliPath.value = savedCliPath || '';
  await populateWelcomeCliSelect(savedCliPath || '');

  // Report the CLI whim will actually run, then load models
  const cliOk = await checkWelcomeCli();
  if (cliOk) {
    void loadWelcomeModels();
  } else {
    welcomeModelSelect.innerHTML = '<option value="">Waiting for valid CLI…</option>';
  }
}

/**
 * Fill the onboarding CLI picker with every install discovered on the machine.
 * A fresh machine may have several (bundled, self-updated, Homebrew, npm), and
 * the auto-picked default isn't always the one that works — so the user needs
 * to be able to switch.
 */
async function populateWelcomeCliSelect(selectedPath: string): Promise<void> {
  welcomeDiscoveredClis = await populateCliSelect(welcomeCliSelect, selectedPath, true);
  welcomeCliPathRow.hidden = welcomeCliSelect.value !== CLI_CUSTOM_OPTION;
  // Nothing saved yet: adopt whichever install the picker landed on so the
  // runtime and the displayed selection agree from the first render.
  if (!selectedPath && welcomeDiscoveredClis.length > 0 && welcomeCliSelect.value) {
    await applyWelcomeCliChoice(welcomeCliSelect.value);
  }
}

/**
 * Persist a CLI choice from the onboarding picker as the effective runtime.
 * The bundled copy maps to `cli_source: 'bundled'` rather than a hard-coded
 * path, so it keeps tracking whatever ships with the app across upgrades.
 */
async function applyWelcomeCliChoice(value: string): Promise<void> {
  if (value === CLI_CUSTOM_OPTION) return;
  const chosen = welcomeDiscoveredClis.find(c => c.path === value);
  if (!value || chosen?.source === 'bundled') {
    await whimAPI.setSetting('cli_path', '');
    await whimAPI.setSetting('cli_source', 'bundled');
    welcomeCliPath.value = '';
    return;
  }
  welcomeCliPath.value = value;
  await whimAPI.setSetting('cli_path', value);
  await whimAPI.setSetting('cli_source', 'path');
}

/** Generation counter so a stale retry chain can't clobber a newer load. */
let welcomeModelLoadToken = 0;

async function loadWelcomeModels(retries = 5, token = ++welcomeModelLoadToken): Promise<void> {
  if (token !== welcomeModelLoadToken) return;
  const { models, error } = await whimAPI.listModelsDetailed();
  if (token !== welcomeModelLoadToken) return;

  if (models.length === 0 && retries > 0) {
    welcomeModelSelect.innerHTML = '<option value="">Loading models…</option>';
    setTimeout(() => void loadWelcomeModels(retries - 1, token), 2000);
    return;
  }
  welcomeModelSelect.innerHTML = '';
  if (models.length === 0) {
    welcomeModelSelected = false;
    updateWelcomeStartBtn();
    // Surface *why* rather than a dead-end "No models available" — on a new
    // machine this is almost always an unauthenticated or failed-to-start CLI.
    welcomeModelSelect.innerHTML = '<option value="">No models available</option>';
    welcomeModelHint.textContent = error
      ? `Couldn't load models: ${error}`
      : "Couldn't load models. Try another Copilot CLI above, or run `copilot` once in a terminal to sign in.";
    welcomeModelHint.style.color = 'var(--color-warning, #d29922)';
    return;
  }
  welcomeModelHint.textContent = WELCOME_MODEL_HINT;
  welcomeModelHint.style.color = '';
  const saved = await whimAPI.getSetting('model');
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    welcomeModelSelect.appendChild(opt);
  }
  if (saved && models.some(m => m.id === saved)) {
    welcomeModelSelect.value = saved;
  } else {
    welcomeModelSelect.value = models[0].id;
  }
  welcomeModelSelected = !!welcomeModelSelect.value;
  welcomeModelCheck.classList.remove('hidden');
  welcomeStepModel.classList.add('done');
  updateWelcomeStartBtn();
}

function hideWelcomeView(): void {
  welcomeView.classList.add('hidden');
  mainView.classList.remove('hidden');
  descInput.focus();
}

/**
 * Report the runtime whim will actually spawn. This reads `cli:runtime-status`
 * rather than the bare auto-detect result, so what onboarding shows matches
 * what the SDK connects to (they diverge whenever `cli_source` isn't 'auto').
 */
async function checkWelcomeCli(): Promise<boolean> {
  welcomeCliReady = false;
  updateWelcomeStartBtn();
  welcomeCliStatus.textContent = 'Checking…';
  welcomeCliStatus.style.color = '';
  welcomeCliCheck.classList.add('hidden');
  welcomeStepCli.classList.remove('done');

  const info = await whimAPI.getCliRuntimeStatus();

  if (!info.target) {
    welcomeCliStatus.textContent = 'Not found — install the Copilot CLI or pick a path below.';
    return false;
  }
  if (!info.compatible) {
    const ver = info.version || 'unknown';
    welcomeCliStatus.textContent = `Version ${ver} selected — update to ${info.minVersion}+ required (run: copilot update)`;
    welcomeCliStatus.style.color = 'var(--color-warning, #d29922)';
    return false;
  }
  const short = info.target.length > 40 ? '…' + info.target.slice(-38) : info.target;
  welcomeCliStatus.textContent = `Using: ${short} (v${info.version})`;
  welcomeCliStatus.title = info.target;
  welcomeCliCheck.classList.remove('hidden');
  welcomeStepCli.classList.add('done');
  welcomeCliReady = true;
  updateWelcomeStartBtn();
  return true;
}

/** Re-check the CLI and reload the model list after a runtime change. */
async function refreshWelcomeCliAndModels(): Promise<void> {
  welcomeModelSelected = false;
  updateWelcomeStartBtn();
  const cliOk = await checkWelcomeCli();
  welcomeModelSelect.innerHTML = '<option value="">Loading models…</option>';
  welcomeModelCheck.classList.add('hidden');
  welcomeStepModel.classList.remove('done');
  if (cliOk) {
    void loadWelcomeModels();
  } else {
    welcomeModelLoadToken++;
    welcomeModelSelect.innerHTML = '<option value="">Waiting for valid CLI…</option>';
  }
}

welcomeCliSelect.addEventListener('change', async () => {
  const value = welcomeCliSelect.value;
  welcomeCliPathRow.hidden = value !== CLI_CUSTOM_OPTION;
  if (value === CLI_CUSTOM_OPTION) {
    welcomeCliPath.focus();
    return;
  }
  await applyWelcomeCliChoice(value);
  await refreshWelcomeCliAndModels();
});

// Custom path entry: a non-empty path opts into the 'path' source; empty falls
// back to the bundled CLI (the default that works without a local install).
welcomeCliPath.addEventListener('change', async () => {
  const val = welcomeCliPath.value.trim();
  await whimAPI.setSetting('cli_path', val);
  await whimAPI.setSetting('cli_source', val ? 'path' : 'bundled');
  await refreshWelcomeCliAndModels();
});

// Refresh button re-scans for installs after the user upgrades or installs one
welcomeCliRefresh.addEventListener('click', async () => {
  welcomeCliSelect.innerHTML = '<option value="">Detecting…</option>';
  const saved = (await whimAPI.getSetting('cli_path')) || '';
  await populateWelcomeCliSelect(saved);
  await refreshWelcomeCliAndModels();
});

welcomeWorkspaceBtn.addEventListener('click', async () => {
  const result = await whimAPI.selectWorkspace();
  if (result.selected && result.path) {
    welcomeWorkspaceSelected = true;
    welcomeWorkspaceHint.textContent = result.path;
    welcomeWorkspaceHint.title = result.path;
    welcomeWorkspaceBtn.textContent = 'Change…';
    welcomeWorkspaceCheck.classList.remove('hidden');
    welcomeStepWorkspace.classList.add('done');
    updateWelcomeStartBtn();
  }
});

welcomeModelSelect.addEventListener('change', () => {
  const model = welcomeModelSelect.value;
  welcomeModelSelected = !!model;
  if (model) {
    welcomeModelCheck.classList.remove('hidden');
    welcomeStepModel.classList.add('done');
  } else {
    welcomeModelCheck.classList.add('hidden');
    welcomeStepModel.classList.remove('done');
  }
  updateWelcomeStartBtn();
});

welcomeStartBtn.addEventListener('click', async () => {
  if (!welcomeWorkspaceSelected || !welcomeCliReady || !welcomeModelSelected) return;

  // Save model selection
  const model = welcomeModelSelect.value;
  if (model) {
    await whimAPI.setSetting('model', model);
  }

  hideWelcomeView();
  loadSpaces();
  loadSkills();
  refreshGitSync();
  void maybeShowFirstRunHelp();
});

// ── Help / shortcuts overlay (first-run coach + on-demand) ──
const helpOverlay = document.getElementById('help-overlay') as HTMLDivElement | null;
const helpBtn = document.getElementById('help-btn') as HTMLButtonElement | null;
const helpCloseBtn = document.getElementById('help-close') as HTMLButtonElement | null;
const helpGotItBtn = document.getElementById('help-got-it') as HTMLButtonElement | null;
const helpReplayTourBtn = document.getElementById('help-replay-tour') as HTMLButtonElement | null;
const helpDismissBackdrop = helpOverlay?.querySelector('[data-help-dismiss]') as HTMLElement | null;

function isHelpOpen(): boolean {
  return !!helpOverlay && !helpOverlay.classList.contains('hidden');
}

function openHelp(): void {
  if (!helpOverlay) return;
  syncToggleHotkeyLabels();
  helpOverlay.classList.remove('hidden');
  helpGotItBtn?.focus();
}

function closeHelp(): void {
  if (!helpOverlay) return;
  helpOverlay.classList.add('hidden');
  void whimAPI.setSetting('onboarding_tips_seen', '1');
  descInput?.focus();
}

helpBtn?.addEventListener('click', openHelp);
helpReplayTourBtn?.addEventListener('click', () => {
  if (!helpOverlay) return;
  helpOverlay.classList.add('hidden');
  void whimAPI.setSetting('onboarding_tips_seen', '1');
  void showTourView(welcomeView.classList.contains('hidden') ? 'main' : 'welcome');
});
helpCloseBtn?.addEventListener('click', closeHelp);
helpGotItBtn?.addEventListener('click', closeHelp);
helpDismissBackdrop?.addEventListener('click', closeHelp);

// `?` opens help (unless typing); Esc closes it before other Esc handlers run.
document.addEventListener('keydown', (e) => {
  if (isHelpOpen() && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeHelp();
    return;
  }
  if (e.key === '?' && !isHelpOpen() && !tourActive) {
    const t = e.target as HTMLElement | null;
    const editable = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!editable) {
      e.preventDefault();
      openHelp();
    }
  }
}, true);

// Show the coach once, right after a brand-new user finishes setup.
async function maybeShowFirstRunHelp(): Promise<void> {
  const seen = await whimAPI.getSetting('onboarding_tips_seen');
  if (!seen) openHelp();
}

// ── Init ────────────────────────────────────────────────
// Check if workspace is set — show welcome or main view

/**
 * Mount the React tree for the four main lists, the agent summary card,
 * and the focus banner. Action callbacks delegate to the legacy window.*
 * globals defined elsewhere in this file. The mount is gated on
 * !isCanvasMode && !isSettingsMode because canvas/settings windows reuse
 * the same renderer bundle but render entirely different UIs.
 */
function mountReactLists(): void {
  if (isCanvasMode || isSettingsMode) return;
  const spaceListHost = document.getElementById('space-list') as HTMLElement | null;
  const agentSummaryHost = document.getElementById('agent-summary') as HTMLElement | null;
  const focusBannerHost = document.getElementById('focus-banner') as HTMLElement | null;
  if (!spaceListHost || !agentSummaryHost || !focusBannerHost) return;

  // Clear any pre-existing legacy children so React's createRoot starts clean.
  spaceListHost.innerHTML = '';
  agentSummaryHost.innerHTML = '';
  focusBannerHost.innerHTML = '';

  mountLists({
    spaceListHost,
    agentSummaryHost,
    focusBannerHost,
    mainList: {
      spacesActions: {
        onSpaceClick: (id) => (window as any).openCanvas?.(id, true),
        onToggleStatus: (id) => (window as any).toggleStatus?.(id),
        onDelete: (id) => (window as any).deleteSpace?.(id),
        onFocus: (id) => (window as any).setFocus?.(id),
        onOpenArtifact: (spaceId, artifactId) => {
          void openCanvasArtifactAndReconcile(bridgeApi, spaceId, artifactId);
        },
        onAgentClick: (agentId, selectedText, status, source, spaceId) =>
          (window as any).openAgentChat?.(agentId, selectedText, status, source, spaceId),
      },
      agentsActions: {
        onAgentClick: async (agent) => {
          if (agent.source === 'cca') {
            try {
              const apiStatus = await whimAPI.getCloudJobStatus(agent.agentId);
              const url = (apiStatus as any)?.url || 'https://github.com';
              whimAPI.openExternal(url);
            } catch { /* ignore */ }
            return;
          }
          (window as any).openAgentChat?.(agent.agentId, agent.selectedText, agent.status, agent.source, agent.spaceId);
        },
        onApprove: (agentId, requestId) => {
          whimAPI.approveAgent(agentId, requestId, true);
          agentApprovals.delete(agentId);
          agentStore.clearApproval(agentId);
          updateWorkersBadge();
        },
        onDeny: (agentId, requestId) => {
          whimAPI.approveAgent(agentId, requestId, false);
          agentApprovals.delete(agentId);
          agentStore.clearApproval(agentId);
          updateWorkersBadge();
        },
        onDelete: async (agentId) => {
          await whimAPI.deleteAgentSession(agentId);
          renderAgentsList();
        },
        onCanvas: (spaceId) => (window as any).openCanvas?.(spaceId, true),
        onToggleYolo: (agentId, currentlyEnabled) => {
          whimAPI.setAgentYolo(agentId, !currentlyEnabled);
        },
        onToggleSandbox: async (agentId) => {
          await whimAPI.disableSandbox(agentId);
          renderAgentsList();
        },
        onResolveSandboxBlock: (agentId, requestId, decision) => {
          whimAPI.resolveSandboxBlock(agentId, requestId, decision);
        },
        onEditSandboxConfig: (personaHandle) => {
          openPersonaEditorForSandbox(personaHandle);
        },
        onToggleRemote: async (agentId, current, agent) => {
          if (current?.enabled) {
            if (current.url) {
              (window as any).openAgentChat?.(agentId, agent.selectedText, agent.status, agent.source, agent.spaceId);
            } else {
              await whimAPI.disableRemote(agentId);
            }
          } else {
            await whimAPI.enableRemote(agentId);
          }
        },
      },
      skillsActions: {
        onSkillClick: (id) => { void openSkillEditor(id); },
        onRunNow: (id) => (window as any).runSkillNow?.(id),
        onSchedule: (id) => (window as any).openSchedulePicker?.(id),
        onCreateSpace: (id) => (window as any).createSpaceFromSkill?.(id),
        onOpenFolder: (id) => (window as any).openSkillFolder?.(id),
        onDelete: (id) => (window as any).deleteSkill?.(id),
      },
      historyActions: {
        onCardClick: (id) => (window as any).openCanvas?.(id, true),
        onUnarchive: (id) => (window as any).unarchiveIntent?.(id),
      },
    },
    focusBanner: {
      onComplete: async (id) => {
        await whimAPI.update(id, { status: 'done' });
        clearFocus();
        await loadSpaces();
      },
      onClear: clearFocus,
    },
  });
}

/*
 * Each input is read independently: over the web remote one of the three can
 * be refused, and a `Promise.all` turned that into a page that never started.
 * See boot-guard.ts.
 */
Promise.all([
  bootValue(() => whimAPI.getSetting('workspace_root'), null, 'workspace_root'),
  bootValue(() => whimAPI.getSetting('model'), null, 'model'),
  bootValue(() => whimAPI.getCliRuntimeStatus(), UNKNOWN_CLI_RUNTIME, 'cli runtime status'),
]).then(async ([ws, model, cli]) => {
  // Install the IPC -> store bridge once at boot. The bridge runs alongside
  // the legacy IPC handlers during the migration (Phase 6).
  installIpcBridge(bridgeApi);

  const setupRequired = !ws || !model || !cli.target || !cli.compatible;
  if (setupRequired && !isCanvasMode && !isSettingsMode) {
    // Brand-new install: teach the hotkey and the tray icon *before* the setup
    // form, so the user can never lose the window without knowing how to get
    // it back. Returning users (tour already done) go straight to setup.
    const quickStartDone = await whimAPI.getSetting('quick_start_completed');
    if (quickStartDone) {
      showWelcomeView();
    } else {
      void showTourView('welcome');
    }
    // Still mount React so the lists are ready when a workspace is selected;
    // they render empty states while no workspace is configured.
    mountReactLists();
  } else if (!isSettingsMode) {
    // Mount AFTER the first snapshot lands so React's first paint sees real
    // data instead of an empty-state flash for workspaces with content.
    await loadSpaces();
    mountReactLists();
    refreshGitSync();
    void loadCanvasArtifactsSnapshot(bridgeApi);
  }
}).catch((err) => {
  // Last line of defence. Everything above is now individually guarded, but
  // an unguarded call added to this block later would otherwise reproduce the
  // exact failure this catch exists to end: a page that renders nothing and
  // says nothing. Mounting is idempotent, so recovering here is safe.
  console.error('[boot] startup failed; mounting the interface anyway', err);
  mountReactLists();
});

// Load personas in the main window so the @-mention dropdown on the Workers
// tab has data.  (Settings popout has its own loadPersonas() call.)
if (!isCanvasMode && !isSettingsMode) {
  loadPersonas().catch(() => { /* leaves personas[] empty */ });
}

// Refresh the space list when the canvas popout window is closed
whimAPI.onCanvasWindowClosed(() => {
  if (!isCanvasMode) loadSpaces();
});

// Listen for theme changes broadcast from other windows
if (!isCanvasMode && !isSettingsMode) {
  whimAPI.onCanvasThemeChanged((theme: string) => {
    const choice = normalizeChoice(theme);
    applyTheme(choice);
    syncThemeControl(choice);
  });
}

// Reload all data when workspace changes (select or clear)
whimAPI.onWorkspaceChanged((path: string | null) => {
  if (isCanvasMode || isSettingsMode) {
    // In canvas/settings window, close it — the workspace changed underneath
    window.close();
    return;
  }
  updateWorkspaceDisplay(path);
  hideSettings();
  if (path) {
    loadSpaces();
    loadSkills();
    refreshGitSync();
  } else {
    // Workspace cleared — show welcome view
    spaces = [];
    cachedSkills = [];
    spaceStore.setSpaces([]);
    skillStore.setSkills([]);
    personaStore.setPersonas([]);
    render();
    showWelcomeView();
    gitSyncAvailable = false;
    syncGitBarVisibility();
    gitSyncInitialized = false;
  }
});

// ── Canvas popout window mode ───────────────────────────
if (isCanvasMode) {
  // Hide everything except canvas view
  mainView.classList.add('hidden');
  revealCanvasView();
  document.body.classList.add('canvas-window');

  // ── Always-on-top toggle ────────────────────────────────
  async function toggleCanvasOnTop(): Promise<void> {
    closeCanvasMenu();
    const current = await whimAPI.getCanvasAlwaysOnTop();
    const next = !current;
    whimAPI.setCanvasAlwaysOnTop(next);
    canvasPinTopBtn.classList.toggle('active', next);
    canvasPinLabel.textContent = next ? 'Unpin from Top' : 'Pin to Top';
    canvasPinTopBtn.title = next ? 'Unpin from Top' : 'Pin to Top';
  }

  canvasPinTopBtn.addEventListener('click', toggleCanvasOnTop);

  // Canvas keyboard shortcuts — use capture phase so the editor can't swallow them
  window.addEventListener('keydown', (e) => {
    if (matchesHotkey(e, 'canvasPinToTop')) {
      e.preventDefault();
      e.stopPropagation();
      toggleCanvasOnTop();
      return;
    }

    if (matchesHotkey(e, 'canvasNewPage')) {
      if (!canvasSpaceId) return;
      e.preventDefault();
      e.stopPropagation();
      const spaceId = canvasSpaceId;
      const selected = getCanvasSelectedText().trim();

      if (selected) {
        // Derive page name from first few words of selection
        const pageName = selected.split(/\s+/).slice(0, 5).join(' ');
        whimAPI.createPage(spaceId, pageName).then(async (result) => {
          if (result.error) return;
          await whimAPI.writePage(spaceId, result.page, ensureMarkdownH1Title(selected, pageName).content);
          replaceCanvasText(selected, `[${selected}](${result.page}.md)`);
          whimAPI.openPageWindow({ kind: 'page', spaceId, page: result.page, title: pageName });
        });
      } else {
        showCanvasInputDialog('New page name', (name) => {
          whimAPI.createPage(spaceId, name).then(result => {
            if (result.error) return;
            appendCanvasLink(name, `${result.page}.md`);
            whimAPI.openPageWindow({ kind: 'page', spaceId, page: result.page, title: name });
          });
        });
      }
    }
  }, true);

  // Sync initial state
  whimAPI.getCanvasAlwaysOnTop().then(pinned => {
    canvasPinTopBtn.classList.toggle('active', pinned);
    canvasPinLabel.textContent = pinned ? 'Unpin from Top' : 'Pin to Top';
    canvasPinTopBtn.title = pinned ? 'Unpin from Top' : 'Pin to Top';
  });

  // Apply the stored theme and follow live changes from the main window
  whimAPI.getSetting('theme').then(v => applyTheme(normalizeChoice(v)));

  whimAPI.onCanvasThemeChanged((theme: string) => {
    applyTheme(normalizeChoice(theme));
  });
  // Load a target handed over by the main process.
  whimAPI.onLoadCanvasTarget(openCanvasTarget);

  // Hide-on-close path: main intercepts the user's close click and asks
  // the renderer to flush unsaved edits before actually hiding. This keeps
  // the renderer warm so the next canvas-window:open is instant. Reset
  // the shell back to its post-pre-warm state (empty title, no dirty
  // marker) so the next open paints cleanly.
  whimAPI.onCanvasRequestHide(async () => {
    try {
      if (canvasSpaceId || canvasSkillId || canvasPageSpaceId || canvasFilePath) {
        const saved = await saveAndUnmountCurrent();
        if (!saved) return;
      }
      canvasTitle.textContent = '';
      canvasTitle.contentEditable = 'false';
      canvasTitle.classList.remove('editing');
      canvasTitleAI.classList.add('hidden');
      canvasSaveStatus.textContent = '';
      canvasDirty = false;
      canvasSaveBtn.classList.add('hidden');
      canvasSkillChips.classList.add('hidden');
      canvasSkillPicker.classList.add('hidden');
      closeCanvasMenu();
      // Reset the beforeunload guard so the next session's unsaved edits
      // (e.g. on app quit) still flush via the beforeunload listener.
      canvasClosing = false;
      whimAPI.canvasHideReady();
    } catch (error) {
      console.error('[canvas] failed to save before close:', error);
      canvasSaveStatus.textContent = '✗ save failed';
    }
  });

  // Also load full spaces and skills in background for metadata
  whimAPI.list().then(list => { spaces = list; });
  whimAPI.listSkills().then(list => { cachedSkills = list; });
}

// ── Settings popout window mode ─────────────────────────
if (isSettingsMode) {
  // Hide everything except settings overlay
  mainView.classList.add('hidden');
  document.body.classList.add('settings-window');

  // Show the settings content as full page (not overlay)
  settingsOverlay.classList.remove('hidden');
  settingsOverlay.classList.add('settings-fullpage');
  settingsModalOpen = true;

  // Apply the stored theme and follow live changes from the main window.
  // (settings popout also runs loadThemeSetting() below, which sets the control.)
  whimAPI.onCanvasThemeChanged((theme: string) => {
    applyTheme(normalizeChoice(theme));
  });

  // Fire all settings data loads in parallel so the slow ones (listModels
  // network call, MCP fs reads) overlap. Use allSettled so one failure
  // doesn't break sibling loads.
  // Note: loadCliPathInputSync() paints the input + "checking…" labels
  // immediately; the actual CLI subprocess probes (checkCliVersion +
  // checkCliMxcCapable, each spawns the CLI binary) are deferred below
  // so the General tab is interactive without waiting on them.
  const loadAllSettings = () => Promise.allSettled([
    loadModels(),
    loadWorkspaceSetting(),
    loadThemeSetting(),
    loadAutoHideSetting(),
    loadAutoRemoteSetting(),
    loadWebRemoteSetting(),
    loadCommentTriggerSetting(),
    loadUpdateSettings(),
    loadPersonas(),
    loadRuntimes(),
    loadExportDestinations(),
    loadCliPathInputSync(),
    loadRuntimeSourceSettings(),
    loadMcpServers(),
    loadCliTools(),
    loadHotkeys(),
    refreshProfiles(),
  ]);

  loadAllSettings();

  // Defer the CLI subprocess probes to idle so they don't block first
  // paint. requestIdleCallback isn't on the WebKit type lib by default,
  // so fall back to setTimeout when unavailable.
  const runChecks = () => runCliPathChecks();
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(runChecks, { timeout: 2000 });
  } else {
    setTimeout(runChecks, 0);
  }

  // The settings window is hidden (not destroyed) on close and pre-warmed at
  // app start, so without this its controls would keep showing whatever was
  // loaded when the process started. Main re-sends this every time the window
  // is shown.
  whimAPI.onSettingsRefresh(() => {
    void loadAllSettings().then(runChecks);
  });

  // Close button closes the window
  settingsClose.addEventListener('click', () => window.close());
}
