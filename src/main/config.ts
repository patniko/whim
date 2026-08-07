import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { app } from 'electron';
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from '../shared/ipc-contract';
import type { ExportFormat, ExportDestination } from '../shared/types';
import {
  classifyInterfaceScope,
  defaultBindSelections,
  listWebRemoteInterfaces,
  migrateBindAddresses,
  normalizeBindSelections,
} from './web/interfaces';
import type {
  WebRemoteBindSelection,
  WebRemoteInterface,
  WebRemoteTlsMode,
} from '../shared/ipc-contract';
import type { WebRemoteDeviceRecord } from './web/sessions';
import type { WebRemoteLockoutRecord } from './web/auth';

export type { SandboxPolicy };
export type { ExportFormat, ExportDestination };
export type { WebRemoteBindSelection, WebRemoteInterface };
export { DEFAULT_SANDBOX_POLICY };
export { classifyInterfaceScope, defaultBindSelections, listWebRemoteInterfaces, normalizeBindSelections };

export type SnapPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'left-center' | 'right-center';

export interface AgentPersona {
  id: string;
  handle: string;       // @mention name (stored lowercase, no @ prefix)
  instructions: string;
  model: string;        // model ID
  runLocation: 'local' | 'cca' | 'cloud';  // where to execute the agent
  sandboxed?: boolean;  // enable runtime sandbox for this persona
  emoji?: string;       // emoji avatar for presence and worker tabs
  cliRuntime?: string;  // id of a CliRuntime; null/empty = use default cliPath
  /**
   * Optional per-persona override of the global sandbox policy.
   * When `sandboxed` is true and this is undefined, the persona inherits
   * `AppConfig.sandboxDefaultPolicy`. When set, this fully replaces the default.
   */
  sandboxPolicyOverride?: SandboxPolicy;
  /** When true, agents launched with this persona automatically enable yolo mode. */
  yolo?: boolean;
  /** When true, session state is kept in-memory only — nothing persisted to disk or DB. */
  ephemeral?: boolean;
  /**
   * Whether an agent launched with this persona may publish canvas reports,
   * and which canvas type it uses. `true` selects the built-in `whim-report`.
   *
   * Skill runs derive the same capability from their space's frontmatter. A
   * persona carries it instead for comment-launched runs, which have no
   * invocation frontmatter to read it from.
   */
  canvas?: boolean | string;
}

/**
 * Which Copilot runtime the SDK connects to:
 * - 'bundled': the CLI shipped with the app (`@github/copilot`); the default.
 * - 'auto':    auto-detect a local install, preferring the self-updated CLI.
 * - 'path':    an explicit local CLI path/command (`cliPath`).
 * - 'server':  an already-running runtime at `cliServerUrl` (remote).
 */
export type CliSource = 'bundled' | 'auto' | 'path' | 'server';

export interface CliRuntime {
  id: string;
  label: string;        // user-friendly name, e.g. "Copilot Dev"
  path: string;         // bare command or full path, resolved like cliPath
}

export interface CliToolDefinition {
  name: string;         // e.g. "gh"
  description: string;  // e.g. "Used for GitHub operations including git, issues, pull requests, actions"
}

export interface CustomMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  tools: string[];
}

export interface HotkeyConfig {
  toggleWindow: string;        // Global: show/hide the app window
  canvasPinToTop: string;      // Canvas: pin/unpin window to top
  canvasNewPage: string;       // Canvas: create new page
  popOutWindow: string;        // Main: pop out in new window
  toggleSearch: string;        // Main: toggle search mode
  switchProfile: string;       // Main: cycle to next workspace profile
  close: string;               // Navigation: close/back
  navigateUp: string;          // Navigation: move selection up
  navigateDown: string;        // Navigation: move selection down
  openSubmit: string;          // Navigation: open/submit
  stopRecording: string;       // Voice: stop recording
}

export const DEFAULT_HOTKEYS: HotkeyConfig = {
  toggleWindow: 'CommandOrControl+Shift+Space',
  canvasPinToTop: 'CommandOrControl+Shift+T',
  canvasNewPage: 'CommandOrControl+Shift+N',
  popOutWindow: 'CommandOrControl+Enter',
  toggleSearch: 'Shift+Tab',
  switchProfile: 'CommandOrControl+Shift+P',
  close: 'Escape',
  navigateUp: 'ArrowUp',
  navigateDown: 'ArrowDown',
  openSubmit: 'Enter',
  stopRecording: 'Space',
};

export const HOTKEY_LABELS: Record<keyof HotkeyConfig, string> = {
  toggleWindow: 'Toggle Window',
  canvasPinToTop: 'Pin to Top (Canvas)',
  canvasNewPage: 'New Page (Canvas)',
  popOutWindow: 'Pop Out in New Window',
  toggleSearch: 'Toggle Search',
  switchProfile: 'Switch Profile',
  close: 'Close / Back',
  navigateUp: 'Navigate Up',
  navigateDown: 'Navigate Down',
  openSubmit: 'Open / Submit',
  stopRecording: 'Stop Recording',
};

export const HOTKEY_CATEGORIES: Record<string, (keyof HotkeyConfig)[]> = {
  'Global': ['toggleWindow'],
  'Canvas': ['canvasPinToTop', 'canvasNewPage'],
  'Actions': ['popOutWindow', 'toggleSearch', 'switchProfile'],
  'Navigation': ['close', 'navigateUp', 'navigateDown', 'openSubmit', 'stopRecording'],
};

export interface WorkspaceProfile {
  id: string;            // stable identifier
  path: string;          // workspace directory (git repo root)
  name: string | null;   // user override for the display name; null = use resolved default
  tint: string | null;   // hex color (e.g. "#7c66dc") applied as a subtle UI tint; null = none
}

export interface AppConfig {
  workspace: string | null;
  theme: 'light' | 'dark' | 'system';
  model: string | null;
  cliPath: string | null;          // user override for Copilot CLI path; null = auto-detect
  cliSource: CliSource;            // which Copilot runtime to use (default: 'bundled')
  cliServerUrl: string | null;     // remote runtime URL when cliSource === 'server'
  cliServerToken: string | null;   // optional shared secret for the remote runtime
  sessions: Record<string, string>; // spaceId → copilot CLI sessionId
  pinned: boolean;
  autoHideSidePane: boolean;       // when true, side pane auto-hides on blur & stays alwaysOnTop
  snapPosition: SnapPosition;
  windowWidth: number;
  personas: AgentPersona[];
  personasSeeded: boolean;          // true after default personas have been injected once
  personasMigratedV2: boolean;      // true after legacy runLocation rename (cloud→cca) has run
  personasSandboxSeeded: boolean;   // true after @sandbox demo persona has been topped up once for existing installs
  personasArtifactSeeded: boolean;  // true after @artifact persona has been topped up once for existing installs
  cliRuntimes: CliRuntime[];
  cliTools: CliToolDefinition[];
  mcpServers: CustomMcpServer[];   // user-added MCP servers
  sandboxDefaultPolicy: SandboxPolicy;  // default policy for sandboxed personas
  autoDownloadUpdates: boolean;     // auto-download updates in the background (vs. notify only)
  remoteEnabled: boolean;           // app-level remote: enable Mission Control on all workspace-level agents
  remoteAutoEnable: boolean;        // auto-enable remote on every new worker session
  webRemoteEnabled: boolean;        // web UI served by this running app
  webRemotePort: number;
  webRemoteToken: string;
  webRemoteBindSelections: WebRemoteBindSelection[];  // durable intent, resolved to addresses at bind time
  webRemoteTlsMode: WebRemoteTlsMode;   // 'auto' = self-signed on non-loopback binds
  webRemoteTlsCertPath: string;         // used when webRemoteTlsMode is 'custom'
  webRemoteTlsKeyPath: string;
  webRemoteAllowedHosts: string[];      // extra Host header values (e.g. a reverse proxy hostname)
  webRemoteDevices: WebRemoteDeviceRecord[];  // browsers holding a session cookie, individually revocable
  webRemoteLockouts: WebRemoteLockoutRecord[]; // auth lockouts, persisted so a restart doesn't clear them
  hotkeys: Partial<HotkeyConfig>;   // user hotkey overrides (missing keys fall back to DEFAULT_HOTKEYS)
  quickStartCompleted: boolean;     // true once the hotkey/tray quick-start tour has been finished or skipped
  onboardingTipsSeen: boolean;      // true once the shortcuts coach overlay has been dismissed
  commentTrigger: 'hover-or-caret' | 'caret'; // how the canvas surfaces comment threads
  profiles: WorkspaceProfile[];     // saved workspace profiles (work / personal / …)
  activeProfileId: string | null;   // id of the currently-open profile in `profiles`
  exportDestinations: ExportDestination[]; // "push to folder" targets for canvas sharing
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
export const DEFAULT_WEB_REMOTE_PORT = 37373;

/**
 * Built-in personas seeded on first launch. Users can modify or remove
 * all except @agent after the initial seed.
 */
export const DEFAULT_PERSONAS: AgentPersona[] = [
  {
    id: 'default-agent',
    handle: 'agent',
    instructions: 'Follow the users instructions and respond to comments or create comments when you work on canvas.md documents.',
    model: '',
    runLocation: 'local',
  },
  {
    id: 'default-editor',
    handle: 'editor',
    instructions: `You are a document editor that works directly on canvas documents through comments.

When you receive a comment on selected text:
1. Read the selected text and the user's comment carefully
2. Research the topic if the comment asks for facts, references, or deeper analysis
3. Edit the selected text in canvas.md to address the request
4. Reply with a comment explaining what you changed and why

Guidelines:
- Make precise, targeted edits to the commented text
- Preserve the document's voice and tone unless asked to change it
- When asked to research, use available tools to gather information before editing
- If the request is ambiguous, reply with a clarifying question instead of guessing
- Keep comment replies concise but be thorough in your edits`,
    model: '',
    runLocation: 'local',
    emoji: '✏️',
  },
  {
    id: 'default-artifact',
    handle: 'artifact',
    instructions: `You turn writing into a visual report the user can open later.

You are mentioned from a comment on a space document. The comment and the text it is anchored to tell you what to analyse — treat them as the brief, and treat the rest of the document as context.

Workflow:
1. Read the passage the comment is anchored to, then the surrounding document.
2. Do the actual work the comment asks for: gather data, run the analysis, follow references.
3. Present the result as a report — the required steps for publishing one are described below.

Guidelines:
- Report on what you found, not on what you did. The user wants the analysis, not a transcript.
- Lead with the answer. Put the supporting detail underneath it.
- Use structure the eye can scan: headings, tables, and short sections beat paragraphs.
- Do not edit the document. The report is your output; the user decides what to fold back into their writing.
- If the brief is ambiguous, pick the most useful reading and say in your reply which one you chose.`,
    model: '',
    runLocation: 'local',
    emoji: '📊',
    canvas: true,
  },
  {
    id: 'default-dev',
    handle: 'dev',
    instructions: `You are a development agent. You make code changes safely using git worktrees and branches.

Workflow:
- If the user points you at a local git repository, create a git worktree in a hidden directory (e.g. .worktrees/) to isolate your work from the user's working tree
- If no local repo exists, clone the repository to ~/.whim/repos/ before working
- Always work on a feature branch — never commit directly to main or master
- Name branches descriptively (e.g. fix/login-validation, feat/search-api)

When finishing work:
- Run existing tests and linters before declaring work complete
- If changes are ready and the user approves, merge the worktree branch back and clean up
- If the user wants to review first, report the branch name and how to inspect changes
- Open a pull request with gh pr create if the user asks for one

Guidelines:
- Commit frequently with clear, conventional commit messages
- Summarize all changes when reporting back to the user
- If you encounter merge conflicts, describe them and ask for guidance`,
    model: '',
    runLocation: 'local',
    emoji: '🛠️',
  },
  {
    id: 'default-pr',
    handle: 'pr',
    instructions: `You handle development tasks using GitHub's Copilot coding agent (CCA) in the cloud. Work happens directly on github.com — you create branches, make changes, and open pull requests.

The user may ask you to:
- Implement features, fix bugs, or refactor code in a GitHub repository
- Create or update documentation
- Set up CI/CD workflows or GitHub Actions
- Any other task suited to a cloud development environment

Guidelines:
- Follow the user's instructions precisely
- If the task is unclear, ask for clarification before proceeding
- Report back with a summary of changes and links to any pull requests created`,
    model: '',
    runLocation: 'cca',
    emoji: '🔀',
  },
  {
    id: 'default-cloud',
    handle: 'cloud',
    instructions: `You are a cloud agent. Your session runs in an ephemeral cloud environment — a remote sandbox that is destroyed when the session ends. Nothing persists in the cloud after you finish.

Use this mode for:
- Experimenting with code changes without affecting the local machine
- Running untrusted builds, installs, or scripts in an isolated environment
- Exploring repository branches safely
- Any task that benefits from a disposable cloud workspace

Guidelines:
- Work normally using all available tools
- The cloud environment has its own filesystem and compute — changes stay remote
- Be explicit about what the environment contains if the user asks
- If the user needs results back locally, help them extract artifacts (patches, files, etc.)`,
    model: '',
    runLocation: 'cloud',
    emoji: '☁️',
    ephemeral: true,
  },
  {
    id: 'default-secret-agent',
    handle: 'secret-agent',
    instructions: `You are a private, zero-trace agent. Your session is fully ephemeral — no conversation history, checkpoints, or session state is written to disk. When you finish, nothing remains.

Use this mode when working on sensitive material: credentials, security reviews, private documents, confidential code, or anything the user doesn't want persisted.

Guidelines:
- Work normally using all available tools (bash, view, edit, grep, etc.)
- Do not create unnecessary files — prefer reporting findings directly in chat
- If you must create files, inform the user they will persist on disk even though the session itself won't
- Be thorough but concise — the user cannot revisit this conversation later`,
    model: '',
    runLocation: 'local',
    emoji: '🕵️',
    ephemeral: true,
  },
  {
    id: 'default-sandbox',
    handle: 'sandbox',
    instructions: `You are a demo agent for the MXC sandbox. The MXC sandbox is the SOLE enforcer for your shell calls — host-side path/permission guardrails are disabled (enforcementMode: 'mxc-only').

When asked to demonstrate the sandbox:
- Run each command as a SEPARATE \`bash\` tool call so the user can see allowed vs. denied results one at a time. Do NOT chain with \`&&\` (a single denial would mask later commands).
- Start with something that should succeed inside the workspace (e.g. \`ls\` of the workspace, \`cat\` a file in scope).
- Then try something the policy should block: writing outside the workspace (e.g. \`echo hi > ~/whim-sandbox-denied.txt\`) or an outbound network call (e.g. \`curl https://example.com\`).
- Report what happened for each command — the sandbox emits a clear footer when it blocks you, and the UI will bubble up a banner letting the user adjust policy.
- Do NOT attempt workarounds when a command is denied. The point of the demo is to show that the sandbox is enforcing.

This persona is for demonstrating MXC enforcement, not for general-purpose safe work — host-side approvals are off.`,
    model: '',
    runLocation: 'local',
    emoji: '🧪',
    sandboxed: true,
    sandboxPolicyOverride: {
      scopeToSpaceFolder: true,
      extraReadwritePaths: [],
      extraReadonlyPaths: [],
      extraDeniedPaths: [],
      allowMcpServers: true,
      allowWebFetch: true,
      allowOutbound: false,
      allowLocalNetwork: false,
      enforcementMode: 'mxc-only',
    },
  },
];

const DEFAULT_CONFIG: AppConfig = {
  workspace: null,
  theme: 'system',
  model: null,
  cliPath: null,
  cliSource: 'bundled',
  cliServerUrl: null,
  cliServerToken: null,
  sessions: {},
  pinned: false,
  autoHideSidePane: true,
  snapPosition: 'bottom-right',
  windowWidth: 420,
  personas: [],
  personasSeeded: false,
  personasMigratedV2: false,
  personasSandboxSeeded: false,
  personasArtifactSeeded: false,
  cliRuntimes: [],
  cliTools: [],
  mcpServers: [],
  sandboxDefaultPolicy: { ...DEFAULT_SANDBOX_POLICY },
  autoDownloadUpdates: true,
  remoteEnabled: false,
  remoteAutoEnable: false,
  webRemoteEnabled: false,
  webRemotePort: DEFAULT_WEB_REMOTE_PORT,
  webRemoteToken: '',
  webRemoteBindSelections: [],
  webRemoteTlsMode: 'auto',
  webRemoteTlsCertPath: '',
  webRemoteTlsKeyPath: '',
  webRemoteAllowedHosts: [],
  webRemoteDevices: [],
  webRemoteLockouts: [],
  hotkeys: {},
  quickStartCompleted: false,
  onboardingTipsSeen: false,
  commentTrigger: 'caret',
  profiles: [],
  activeProfileId: null,
  exportDestinations: [],
};

let config: AppConfig = { ...DEFAULT_CONFIG };

export function generateWebRemoteToken(): string {
  return randomBytes(18).toString('base64url');
}

export function normalizeWebRemotePort(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    return DEFAULT_WEB_REMOTE_PORT;
  }
  return parsed;
}

export function ensureWebRemoteToken(): string {
  if (!config.webRemoteToken) {
    config.webRemoteToken = generateWebRemoteToken();
    saveConfig();
  }
  return config.webRemoteToken;
}

export function rotateWebRemoteToken(): string {
  config.webRemoteToken = generateWebRemoteToken();
  saveConfig();
  return config.webRemoteToken;
}

export function loadConfig(): AppConfig {
  let preserveInactiveProfileState = false;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      config = { ...DEFAULT_CONFIG, ...parsed };
      preserveInactiveProfileState =
        Object.prototype.hasOwnProperty.call(parsed, 'activeProfileId') &&
        parsed.activeProfileId === null &&
        parsed.workspace === null;
      // Deep-merge sandbox default so missing fields fall back to safe defaults
      // when the persisted config predates a newly-added SandboxPolicy field.
      config.sandboxDefaultPolicy = {
        ...DEFAULT_SANDBOX_POLICY,
        ...(parsed.sandboxDefaultPolicy || {}),
      };
      // Auto-mark V2 migration done for existing installs (anyone past the
      // initial seed). The legacy cca/cloud rename migration ran in their
      // previous app launches, so re-running it now would clobber any
      // intentional 'cloud' value the user just set.
      if (parsed.personasMigratedV2 === undefined && parsed.personasSeeded === true) {
        config.personasMigratedV2 = true;
      }
      // Runtime source: pre-source configs map an explicit cliPath to the
      // 'path' source; everything else (including auto-detect users) defaults
      // to the bundled CLI, which always works without a local install.
      if (parsed.cliSource === undefined) {
        config.cliSource = parsed.cliPath ? 'path' : 'bundled';
      }
      // Web remote: migrate the legacy address-list binding config to durable
      // interface selections. Runs only once — afterwards `webRemoteBindSelections`
      // is authoritative and the old field is dropped.
      if (parsed.webRemoteBindSelections === undefined && Array.isArray(parsed.webRemoteBindAddresses)) {
        config.webRemoteBindSelections = migrateBindAddresses(parsed.webRemoteBindAddresses);
      }
      delete (config as unknown as Record<string, unknown>).webRemoteBindAddresses;
    }
  } catch (err) {
    console.error('[config] Failed to load config:', err);
    config = { ...DEFAULT_CONFIG };
  }
  config.webRemotePort = normalizeWebRemotePort(config.webRemotePort);
  // Validate shape only. An interface that is currently down is *pending*, not
  // invalid — never rewrite the user's saved intent just because the network
  // happens to look different right now.
  config.webRemoteBindSelections = normalizeBindSelections(config.webRemoteBindSelections);
  ensureWebRemoteToken();
  migrateProfiles(preserveInactiveProfileState);
  return config;
}

/**
 * Reconcile the profiles list with the legacy single-workspace field.
 *
 * - Seeds a first profile from `config.workspace` for installs that predate
 *   profiles (so existing users keep their workspace as "profile 1").
 * - Repairs missing or invalid active profile ids without undoing an explicit
 *   fresh-start state.
 * - Keeps `config.workspace` mirrored to the active profile's path so the
 *   large body of code that reads `getConfigValue('workspace')` is unaffected.
 */
function migrateProfiles(preserveInactiveProfileState: boolean): void {
  // Clone so we never mutate the shared DEFAULT_CONFIG.profiles array reference
  // (a shallow `{ ...DEFAULT_CONFIG }` in loadConfig would otherwise alias it).
  config.profiles = Array.isArray(config.profiles) ? config.profiles.slice() : [];

  if (config.profiles.length === 0 && config.workspace) {
    const profile: WorkspaceProfile = {
      id: generateProfileId(),
      path: config.workspace,
      name: null,
      tint: null,
    };
    config.profiles = [profile];
    config.activeProfileId = profile.id;
  }

  if (config.profiles.length > 0) {
    const activeExists = config.profiles.some((p) => p.id === config.activeProfileId);
    if (!activeExists && preserveInactiveProfileState) {
      config.activeProfileId = null;
      config.workspace = null;
      return;
    }
    if (!activeExists) {
      config.activeProfileId = config.profiles[0].id;
    }
    const active = config.profiles.find((p) => p.id === config.activeProfileId);
    if (active) config.workspace = active.path;
  } else {
    config.activeProfileId = null;
  }
}

export function saveConfig(): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[config] Failed to save config:', err);
  }
}

export function getConfig(): AppConfig {
  return config;
}

export function getConfigValue<K extends keyof AppConfig>(key: K): AppConfig[K] {
  return config[key];
}

export function setConfigValue<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  config[key] = value;
  saveConfig();
}

/** Returns effective hotkeys with user overrides merged on top of defaults. */
export function getResolvedHotkeys(): HotkeyConfig {
  return { ...DEFAULT_HOTKEYS, ...(config.hotkeys || {}) };
}

export function getSessionId(spaceId: string): string | null {
  return config.sessions[spaceId] ?? null;
}

/**
 * Returns the effective sandbox policy for a persona: its override if set,
 * otherwise the global default. Caller should still gate on `persona.sandboxed`
 * before applying this policy.
 */
export function resolveSandboxPolicy(persona: AgentPersona): SandboxPolicy {
  if (persona.sandboxPolicyOverride) {
    // Defensive merge — guarantee all SandboxPolicy fields are present even if
    // the override was persisted before a new field was added.
    return { ...DEFAULT_SANDBOX_POLICY, ...persona.sandboxPolicyOverride };
  }
  return { ...DEFAULT_SANDBOX_POLICY, ...config.sandboxDefaultPolicy };
}

export function setSessionId(spaceId: string, sessionId: string): void {
  config.sessions[spaceId] = sessionId;
  saveConfig();
}

export function removeSession(spaceId: string): void {
  delete config.sessions[spaceId];
  saveConfig();
}

// ── Workspace profiles ──────────────────────────────────

export function generateProfileId(): string {
  return randomBytes(9).toString('base64url');
}

/** Normalize a path for equality checks across separators / trailing slashes. */
function normalizeProfilePath(p: string): string {
  return path.resolve(p);
}

export function getProfiles(): WorkspaceProfile[] {
  return config.profiles;
}

export function getActiveProfileId(): string | null {
  return config.activeProfileId;
}

export function getActiveProfile(): WorkspaceProfile | null {
  return config.profiles.find((p) => p.id === config.activeProfileId) ?? null;
}

export function getProfileById(id: string): WorkspaceProfile | null {
  return config.profiles.find((p) => p.id === id) ?? null;
}

/** Find an existing profile for `dir`, or create one. Returns the profile. */
export function upsertProfileForPath(dir: string): WorkspaceProfile {
  const target = normalizeProfilePath(dir);
  const existing = config.profiles.find((p) => normalizeProfilePath(p.path) === target);
  if (existing) return existing;
  const profile: WorkspaceProfile = { id: generateProfileId(), path: dir, name: null, tint: null };
  config.profiles.push(profile);
  saveConfig();
  return profile;
}

/** Update the name/tint override of a profile. Returns the updated profile or null. */
export function updateProfile(
  id: string,
  patch: { name?: string | null; tint?: string | null },
): WorkspaceProfile | null {
  const profile = config.profiles.find((p) => p.id === id);
  if (!profile) return null;
  if ('name' in patch) {
    const trimmed = (patch.name ?? '').trim();
    profile.name = trimmed.length > 0 ? trimmed : null;
  }
  if ('tint' in patch) {
    profile.tint = patch.tint || null;
  }
  saveConfig();
  return profile;
}

/** Remove a profile. If it was active, the active id is cleared. */
export function removeProfileById(id: string): void {
  config.profiles = config.profiles.filter((p) => p.id !== id);
  if (config.activeProfileId === id) {
    config.activeProfileId = null;
  }
  saveConfig();
}

/**
 * Mark a profile active and mirror its path into `config.workspace`.
 * Pass `null` to clear the active profile (fresh-start state).
 * Returns the now-active profile, or null when cleared / not found.
 */
export function setActiveProfile(id: string | null): WorkspaceProfile | null {
  if (id === null) {
    config.activeProfileId = null;
    config.workspace = null;
    saveConfig();
    return null;
  }
  const profile = config.profiles.find((p) => p.id === id);
  if (!profile) {
    saveConfig();
    return null;
  }
  config.activeProfileId = profile.id;
  config.workspace = profile.path;
  saveConfig();
  return profile;
}

/** The profile whose order follows the active one, wrapping around. Null if <2 profiles. */
export function getNextProfile(): WorkspaceProfile | null {
  if (config.profiles.length < 2) return null;
  const idx = config.profiles.findIndex((p) => p.id === config.activeProfileId);
  const nextIdx = idx < 0 ? 0 : (idx + 1) % config.profiles.length;
  return config.profiles[nextIdx];
}

// ── Export destinations ─────────────────────────────────

export function generateExportDestinationId(): string {
  return randomBytes(9).toString('base64url');
}

export function getExportDestinations(): ExportDestination[] {
  return config.exportDestinations || [];
}

/**
 * Validate and normalize a raw list of export destinations (e.g. from the
 * settings UI). Drops entries missing a label or path, clamps formats to the
 * supported set, and preserves/generates stable ids. Capped at 32 entries.
 */
export function validateExportDestinations(value: unknown): ExportDestination[] {
  if (!Array.isArray(value)) return [];
  const valid: ExportDestination[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    const destPath = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!label || !destPath) continue;
    const format = entry.defaultFormat;
    const defaultFormat: ExportFormat =
      format === 'pdf' || format === 'docx' || format === 'md' ? format : 'pdf';
    const id = typeof entry.id === 'string' && entry.id.trim()
      ? entry.id.trim()
      : generateExportDestinationId();
    valid.push({ id, label, path: destPath, defaultFormat });
    if (valid.length >= 32) break;
  }
  return valid;
}

export function setExportDestinations(value: unknown): ExportDestination[] {
  const validated = validateExportDestinations(value);
  config.exportDestinations = validated;
  saveConfig();
  return validated;
}

export function getExportDestinationById(id: string): ExportDestination | null {
  return (config.exportDestinations || []).find((d) => d.id === id) ?? null;
}
