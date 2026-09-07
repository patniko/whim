import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { CopilotClient, CopilotSession, RuntimeConnection, type CopilotClientOptions } from '@github/copilot-sdk';
import { getConfigValue, type CliSource } from './config';
import {
  resolveAutoDetectedCliPath,
  resolveConfiguredCliPath,
  probeCliVersion,
  compareVersions,
  MIN_CLI_VERSION,
} from './session';
import { getCliShimPath } from './cli-electron-shim';
import { getBundledSdkRuntimePaths } from './copilot-runtime-path';
import { startRuntimeClient } from './sdk-runtime-start';
import { RecurrenceResult, RecallMatch, Space } from '../shared/types';
import type { SandboxPolicy } from '../shared/ipc-contract';

/**
 * Per-agent sandbox config dirs that the SDK can pass to `createSession`/
 * `resumeSession`.  We pre-materialize both `on` and `off` so the
 * "Disable sandbox for session" bubble-up flow can `resumeSession` into the
 * off-dir cleanly without rewriting files mid-flight.
 */
export interface SandboxConfigDirs {
  onDir: string;
  offDir: string;
}

/**
 * Build the unwrapped runtime sandbox config (`{ enabled, userPolicy }` shape)
 * that the SDK's `session.rpc.options.update({ sandboxConfig })` expects.
 *
 * The runtime's `SandboxConfig` (copilot-agent-runtime/src/core/sandbox/sandboxConfig.ts)
 * is the inner block of the settings-file shape — i.e. the contents of
 * `sandbox: {...}` without the wrapper. This is what `userRequestedShell.ts`
 * checks via `options.sandboxConfig?.enabled` for sandbox-exec wrapping.
 *
 * The runtime reads `sandbox.userPolicy.{filesystem,network,experimental}` —
 * NOT `sandbox.filesystem`/`sandbox.network` directly. Writing the flat shape
 * means the runtime silently ignores the policy and falls back to defaults
 * (notably `allowOutbound: true`), making the per-agent overrides a no-op.
 */
export function buildRuntimeSandboxConfig(
  enabled: boolean,
  intentWorkingDir: string,
  policy: SandboxPolicy,
): { enabled: boolean; userPolicy: Record<string, unknown> } {
  const readwritePaths: string[] = [];
  if (policy.scopeToSpaceFolder) readwritePaths.push(intentWorkingDir);
  for (const p of policy.extraReadwritePaths) {
    if (!readwritePaths.includes(p)) readwritePaths.push(p);
  }

  return {
    enabled,
    userPolicy: {
      filesystem: {
        readwritePaths,
        readonlyPaths: [...policy.extraReadonlyPaths],
        deniedPaths: [...policy.extraDeniedPaths],
        clearPolicyOnExit: true,
      },
      network: {
        allowOutbound: policy.allowOutbound,
        allowLocalNetwork: policy.allowLocalNetwork,
      },
    },
  };
}

/**
 * Build the file-format sandbox config object that `<configDir>/config.json`
 * uses. Wraps `buildRuntimeSandboxConfig` in `{ sandbox: {...} }`. The settings
 * file is still useful for "Open config preview" UX and for the runtime to
 * pick up at startup IF it does config-discovery (it currently does NOT for
 * per-session configDirs — enforcement is driven by options.update).
 */
function materializeRuntimeConfig(
  enabled: boolean,
  intentWorkingDir: string,
  policy: SandboxPolicy,
): Record<string, unknown> {
  return { sandbox: buildRuntimeSandboxConfig(enabled, intentWorkingDir, policy) };
}

function getSandboxRoot(): string {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'sandbox-config');
}

/**
 * Materialize on/ and off/ sandbox config dirs for a single agent. Both dirs
 * receive `config.json` files that the runtime reads as its `COPILOT_HOME`.
 *
 * Caller passes `policy` already resolved via `resolveSandboxPolicy(persona)`.
 */
export function buildSandboxConfigs(
  agentId: string,
  intentWorkingDir: string,
  policy: SandboxPolicy,
): SandboxConfigDirs | null {

  const root = getSandboxRoot();
  const agentRoot = path.join(root, agentId);
  const onDir = path.join(agentRoot, 'on');
  const offDir = path.join(agentRoot, 'off');

  fs.mkdirSync(onDir, { recursive: true });
  fs.mkdirSync(offDir, { recursive: true });

  const onConfig = materializeRuntimeConfig(true, intentWorkingDir, policy);
  const offConfig = materializeRuntimeConfig(false, intentWorkingDir, policy);

  fs.writeFileSync(path.join(onDir, 'config.json'), JSON.stringify(onConfig, null, 2));
  fs.writeFileSync(path.join(offDir, 'config.json'), JSON.stringify(offConfig, null, 2));

  // Surfaces the exact paths and policy applied so users can verify which
  // config the runtime is loading. Matches the "Open config preview" button
  // in the persona editor — both pull from materializeRuntimeConfig().
  console.log(
    `[sandbox] Materialized configs for agent ${agentId}:\n` +
    `  on:  ${path.join(onDir, 'config.json')}\n` +
    `  off: ${path.join(offDir, 'config.json')}\n` +
    `  policy: enforcementMode=${policy.enforcementMode} scopeToSpaceFolder=${policy.scopeToSpaceFolder} ` +
    `allowMcpServers=${policy.allowMcpServers} allowWebFetch=${policy.allowWebFetch} ` +
    `allowOutbound=${policy.allowOutbound} allowLocalNetwork=${policy.allowLocalNetwork}\n` +
    `  on-config: ${JSON.stringify(onConfig)}`,
  );

  return { onDir, offDir };
}

/**
 * Materialize a "preview" config.json for a sandbox policy without writing
 * any per-agent state. The space folder is left as a placeholder so the
 * user can see where it'd be substituted at real agent launch time.
 *
 * Returns the JSON object — callers (e.g., the IPC handler that opens the
 * preview in the default text editor) decide where to write it.
 */
export function previewSandboxConfig(policy: SandboxPolicy): Record<string, unknown> {
  return materializeRuntimeConfig(true, '<space folder — replaced at agent launch>', policy);
}

/**
 * Remove the per-agent sandbox config directory (both on/ and off/). Safe to
 * call on a directory that doesn't exist.
 */
export function cleanupSandboxConfigs(agentId: string): void {
  if (!agentId) return;
  const agentRoot = path.join(getSandboxRoot(), agentId);
  try {
    fs.rmSync(agentRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[ai] Failed to cleanup sandbox config for agent ${agentId}:`, err);
  }
}

export interface ParsedSpace {
  description: string;
  client: string | null;
  due_at: string | null;
  due_at_utc: string | null;
}

let client: CopilotClient | null = null;
let ephemeralClient: CopilotClient | null = null;
let parseSession: CopilotSession | null = null;
let recurrenceSession: CopilotSession | null = null;
let recallSession: CopilotSession | null = null;

const PARSE_SYSTEM_MESSAGE = `You are an space parser. Given user input that may range from a short phrase to a long voice transcript (covering initiatives, goals, overviews, etc.), extract structured fields.
The user's current local time will be provided for resolving relative dates.

Return ONLY a JSON object with these fields (no markdown, no explanation):
- "title": a concise, action-oriented title (max ~10 words) that captures the core space
- "client": the client/company name if mentioned, otherwise null
- "due_at": a human-readable due date/time if mentioned, otherwise null
- "due_at_utc": the due date as ISO 8601 UTC (e.g. "2026-04-21T17:00:00Z") if a date was mentioned, otherwise null

Examples:
Input: "make a powerpoint deck for Acme by Friday"
(Current local time: 2026-04-16T10:00:00-07:00, Wednesday)
Output: {"title":"Create PowerPoint deck for Acme","client":"Acme","due_at":"Friday","due_at_utc":"2026-04-18T23:59:00Z"}

Input: "I've been thinking about the roadmap for next quarter. We need to align with the Contoso team on their API changes, finalize the migration plan, and get the security audit done before end of month. The main priority is making sure we don't break existing integrations."
Output: {"title":"Plan Q3 roadmap and Contoso API alignment","client":"Contoso","due_at":"End of month","due_at_utc":"2026-04-30T23:59:00Z"}

Input: "review the PR"
Output: {"title":"Review the PR","client":null,"due_at":null,"due_at_utc":null}`;

const RECURRENCE_SYSTEM_MESSAGE = `You evaluate whether a completed space should recur.
Based on the space's language, decide if this is a recurring task or a one-off.

Return ONLY a JSON object (no markdown, no explanation):
{
  "should_recur": true or false,
  "reasoning": "brief explanation",
  "next_due": "human-readable next date, or null",
  "next_due_utc": "ISO 8601 UTC next date, or null"
}

Examples of recurring spaces:
- "send weekly status update by Monday" → recur, next Monday
- "review PRs before standup every day" → recur, tomorrow
- "file quarterly taxes by April 15" → recur, July 15

Examples of one-off spaces:
- "finish the presentation by Friday" → don't recur
- "buy birthday gift for mom" → don't recur`;

const RECALL_SYSTEM_MESSAGE = `You find semantically similar spaces. Given a new space and a list of past spaces, identify the most relevant past space if any.

Return ONLY a JSON object (no markdown, no explanation):
{
  "match_index": the 0-based index of the most similar past space, or -1 if none are similar enough,
  "confidence": a number from 0.0 to 1.0 indicating similarity,
  "reasoning": "brief explanation"
}

Only match spaces that are genuinely about the same task or topic. Don't match on superficial word overlap.
A confidence below 0.5 means no meaningful match.`;

async function createSession(systemMessage: string): Promise<CopilotSession | null> {
  if (!client) return null;
  try {
    const model = getConfigValue('model') || undefined;
    return await client.createSession({
      systemMessage: { content: systemMessage },
      model,
      onPermissionRequest: async () => ({ kind: 'reject' as const }),
    });
  } catch (err) {
    console.error('[copilot-sdk] Failed to create session:', err);
    return null;
  }
}

async function getParseSession(): Promise<CopilotSession | null> {
  if (!parseSession) parseSession = await createSession(PARSE_SYSTEM_MESSAGE);
  return parseSession;
}

async function getRecurrenceSession(): Promise<CopilotSession | null> {
  if (!recurrenceSession) recurrenceSession = await createSession(RECURRENCE_SYSTEM_MESSAGE);
  return recurrenceSession;
}

async function getRecallSession(): Promise<CopilotSession | null> {
  if (!recallSession) recallSession = await createSession(RECALL_SYSTEM_MESSAGE);
  return recallSession;
}

export interface ResolvedRuntime {
  connection: RuntimeConnection;
  kind: CliSource;
  /** Resolved path or URL, for logging and the settings UI. */
  target: string | null;
}

/**
 * Resolve which Copilot runtime the SDK should connect to, honoring the
 * configured `cliSource`:
 *   - 'server'  → connect to an already-running runtime at `cliServerUrl`.
 *   - 'path'    → spawn the user's explicit local CLI.
 *   - 'auto'    → spawn the best auto-detected local CLI (prefers self-update).
 *   - 'bundled' → spawn the SDK's native runtime (default).
 *   - 'inprocess' → host the bundled SDK runtime in this process (experimental).
 * Unavailable custom sources fall back to bundled stdio, never to in-process.
 */
export function resolveRuntimeConnection(): ResolvedRuntime {
  const source = (getConfigValue('cliSource') || 'bundled') as CliSource;

  if (source === 'server') {
    const url = getConfigValue('cliServerUrl');
    if (url) {
      const token = getConfigValue('cliServerToken') || undefined;
      const connection = RuntimeConnection.forUri(url, token ? { connectionToken: token } : undefined);
      return { connection, kind: 'server', target: url };
    }
    console.warn('[copilot-sdk] cliSource=server but no server URL configured; falling back to bundled SDK runtime');
  } else if (source === 'path' || source === 'auto') {
    const localPath = source === 'auto'
      ? resolveAutoDetectedCliPath()
      : resolveConfiguredCliPath(getConfigValue('cliPath'));
    if (localPath) {
      // JavaScript CLI entrypoints need a shim that strips Electron runtime
      // markers — otherwise the CLI mis-parses argv and exits.
      const effectivePath = getCliShimPath(localPath) ?? localPath;
      if (effectivePath !== localPath) {
        console.log(`[copilot-sdk] Spawning via Electron shim: ${effectivePath}`);
      }
      return { connection: RuntimeConnection.forStdio({ path: effectivePath }), kind: source, target: localPath };
    }
    console.warn(`[copilot-sdk] cliSource=${source} but no local CLI resolved; falling back to bundled SDK runtime`);
  }

  const bundled = getBundledSdkRuntimePaths(app.getAppPath());
  const kind = source === 'inprocess' ? 'inprocess' : 'bundled';
  const present = fs.existsSync(bundled.executable) && fs.existsSync(bundled.library);
  return {
    connection: kind === 'inprocess'
      ? RuntimeConnection.forInProcess()
      : RuntimeConnection.forStdio({ path: bundled.executable }),
    kind,
    target: present ? bundled.executable : null,
  };
}

const nativeRuntimeVersions = new Map<string, string>();

function isBundledRuntime(runtime: ResolvedRuntime): boolean {
  return runtime.kind === 'bundled' || runtime.kind === 'inprocess';
}

function runtimeClientOptions(runtime: ResolvedRuntime): CopilotClientOptions {
  if (isBundledRuntime(runtime) && !runtime.target) {
    throw new Error('Bundled SDK runtime is missing. Reinstall Whim to restore its native runtime files.');
  }
  return {
    connection: runtime.connection,
    enableRemoteSessions: true,
    // Only legacy/custom CLI children need Electron's Node compatibility mode.
    ...(runtime.kind === 'path' || runtime.kind === 'auto'
      ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
      : {}),
  };
}

async function startClient(started: CopilotClient, runtime: ResolvedRuntime): Promise<void> {
  await startRuntimeClient(started, runtime.kind === 'inprocess' ? runtime.target ?? undefined : undefined);
  if (isBundledRuntime(runtime) && runtime.target) {
    // The native wrapper has no --version command; ask the running server.
    const status = await started.getStatus();
    nativeRuntimeVersions.set(runtime.target, status.version);
  }
}

export interface RuntimeStatus {
  source: CliSource;
  target: string | null;
  version: string | null;
  compatible: boolean;
  minVersion: string;
}

function isVersionCompatible(version: string | null): boolean {
  // '0.0.1' is the dev/source build and is always treated as compatible.
  return version != null && (version === '0.0.1' || compareVersions(version, MIN_CLI_VERSION) >= 0);
}

/**
 * Report the effective runtime: its source, target (path or URL), version, and
 * whether it meets the minimum. Native versions come from the SDK handshake;
 * custom CLI versions are probed from disk. A remote version is unknown (use
 * {@link testRuntimeConnection} for a live handshake), so `compatible` reflects
 * only that a URL is configured.
 */
export function getRuntimeStatus(): RuntimeStatus {
  return runtimeStatus(resolveRuntimeConnection());
}

function runtimeStatus(runtime: ResolvedRuntime): RuntimeStatus {
  let version: string | null = null;
  if (isBundledRuntime(runtime) && runtime.target) {
    version = nativeRuntimeVersions.get(runtime.target) ?? null;
  } else if (runtime.kind !== 'server' && runtime.target) {
    version = probeCliVersion(runtime.target);
  }
  const compatible = runtime.kind === 'server' || isBundledRuntime(runtime)
    ? runtime.target != null
    : isVersionCompatible(version);
  return { source: runtime.kind, target: runtime.target, version, compatible, minVersion: MIN_CLI_VERSION };
}

export interface RuntimeTestResult extends RuntimeStatus {
  ok: boolean;
  error?: string;
}

/**
 * Stable identity of a resolved runtime. Two resolutions with the same key
 * would spawn an identical runtime process, so a reinit between them is a
 * no-op that only costs an extra CLI spawn (and, on macOS, an extra keychain
 * prompt when the CLI reads its stored token).
 */
function runtimeKey(runtime: ResolvedRuntime): string {
  const token = runtime.connection.kind === 'uri' ? (runtime.connection.connectionToken || '') : '';
  return `${runtime.kind}\u0000${runtime.target ?? ''}\u0000${token}`;
}

/** Runtime key the live `client` was started against; null when not started. */
let activeRuntimeKey: string | null = null;

/**
 * Live-test the configured runtime by performing a real handshake
 * (`listModels`). When the configured runtime is the one the primary client is
 * already connected to, the test reuses that client rather than spawning a
 * throwaway one — every extra spawn is another CLI process reading credentials
 * (and on macOS, another keychain prompt). Bounded by a timeout so the UI never
 * hangs on a misconfigured runtime.
 */
export async function testRuntimeConnection(timeoutMs = 25_000): Promise<RuntimeTestResult> {
  const runtime = resolveRuntimeConnection();
  const status = runtimeStatus(runtime);
  const reusable = client && activeRuntimeKey === runtimeKey(runtime) ? client : null;

  let testClient: CopilotClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startup: Promise<void> | null = null;
  let startupSettled = false;
  try {
    let target: CopilotClient;
    if (reusable) {
      target = reusable;
    } else {
      testClient = new CopilotClient(runtimeClientOptions(runtime));
      target = testClient;
      startup = startClient(testClient, runtime).finally(() => { startupSettled = true; });
    }
    const handshake = (async () => {
      await startup;
      // Listing models proves the runtime responds over the connection.
      await target.listModels();
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Connection test timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([handshake, timeout]);
    return { ...runtimeStatus(runtime), ok: true, compatible: runtime.kind === 'server' ? true : status.compatible };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...status, ok: false, error };
  } finally {
    if (timer) clearTimeout(timer);
    if (testClient) {
      const stopping = testClient;
      if (startup && !startupSettled) {
        // Native startup may finish after the UI timeout. Stopping before it
        // finishes can leave a newly opened FFI host behind.
        void startup.then(() => stopClient(stopping), () => stopClient(stopping));
      } else {
        await stopClient(stopping);
      }
    }
  }
}

/** In-flight primary init, so concurrent callers share one CLI spawn. */
let initInFlight: Promise<void> | null = null;

/** Failure reason from the last init attempt; null once one succeeds. */
let lastInitError: string | null = null;

export function initCopilot(): Promise<void> {
  if (initInFlight) return initInFlight;
  if (client) return Promise.resolve();
  initInFlight = doInitCopilot().finally(() => { initInFlight = null; });
  return initInFlight;
}

async function doInitCopilot(): Promise<void> {
  try {
    const runtime = resolveRuntimeConnection();
    console.log(`[copilot-sdk] Runtime source: ${runtime.kind}${runtime.target ? ` → ${runtime.target}` : ' (runtime files missing)'}`);

    // enableRemoteSessions allows per-session remote access to be toggled
    // on demand via session.rpc.remote.enable(). It does NOT auto-enable
    // remote on every session — that's controlled separately.
    client = new CopilotClient(runtimeClientOptions(runtime));
    await startClient(client, runtime);
    activeRuntimeKey = runtimeKey(runtime);
    lastInitError = null;
    // Eagerly init the parse session (most commonly used)
    await getParseSession();
    console.log('[copilot-sdk] Client started, parse session created');
  } catch (err) {
    console.error('[copilot-sdk] Failed to initialize primary client:', err);
    lastInitError = err instanceof Error ? err.message : String(err);
    if (client) await stopClient(client);
    client = null;
    activeRuntimeKey = null;
    // If the primary client failed (e.g. CLI exited), don't attempt the
    // ephemeral client — it shares the same CLI and will fail identically.
    ephemeralClient = null;
  }
  // The ephemeral client is NOT started here. It's a second CLI process that
  // most sessions never need, and every process start re-reads credentials
  // (on macOS that means another keychain prompt). It's spun up lazily by
  // ensureEphemeralCopilotClient() on the first ephemeral agent launch.
}

export function getCopilotClient(): CopilotClient | null {
  return client;
}

/** In-flight ephemeral init, so concurrent ephemeral launches share one spawn. */
let ephemeralInFlight: Promise<CopilotClient | null> | null = null;

/**
 * Returns the dedicated CopilotClient for ephemeral (zero-persistence)
 * sessions, starting it on first use. Ephemeral sessions need their own client
 * because enabling `sessionFs` forces *every* createSession call on that client
 * to supply a `createSessionFsProvider`.
 */
export function ensureEphemeralCopilotClient(): Promise<CopilotClient | null> {
  if (ephemeralClient) return Promise.resolve(ephemeralClient);
  if (ephemeralInFlight) return ephemeralInFlight;
  if (!client) return Promise.resolve(null);
  ephemeralInFlight = startEphemeralClient().finally(() => { ephemeralInFlight = null; });
  return ephemeralInFlight;
}

async function startEphemeralClient(): Promise<CopilotClient | null> {
  let started: CopilotClient | null = null;
  try {
    const runtime = resolveRuntimeConnection();
    const ephemeralOpts: CopilotClientOptions = {
      ...runtimeClientOptions(runtime),
      sessionFs: {
        initialCwd: '/',
        sessionStatePath: '/.session-state',
        conventions: 'posix',
      },
    };
    started = new CopilotClient(ephemeralOpts);
    await startClient(started, runtime);
    ephemeralClient = started;
    console.log('[copilot-sdk] Ephemeral client started');
    return ephemeralClient;
  } catch (err) {
    console.error('[copilot-sdk] Failed to initialize ephemeral client:', err);
    if (started) await stopClient(started);
    ephemeralClient = null;
    return null;
  }
}

/** Returns the ephemeral client only if it has already been started. */
export function getEphemeralCopilotClient(): CopilotClient | null {
  return ephemeralClient;
}

/**
 * Shut down and re-initialize the Copilot SDK client (e.g. after a CLI path
 * change). Skipped when the newly-resolved runtime is identical to the running
 * one — a pointless respawn otherwise. Pass `force` to reinit regardless.
 */
export async function reinitCopilot(force = false): Promise<void> {
  // Wait for a start that's already underway. Otherwise shutdownCopilot() sees
  // a null `client` and tears down nothing, initCopilot() returns the same
  // in-flight promise, and the app ends up pinned to the *old* runtime the
  // in-flight init was resolved against.
  if (initInFlight) {
    try { await initInFlight; } catch { /* handled below by re-init */ }
  }
  const key = runtimeKey(resolveRuntimeConnection());
  if (!force && client && activeRuntimeKey === key) {
    console.log('[copilot-sdk] Runtime unchanged; skipping reinit');
    return;
  }
  await shutdownCopilot();
  await initCopilot();
}

/**
 * Debounce window for {@link scheduleCopilotReinit}. Settings writes arrive in
 * bursts (the CLI settings UI writes cliPath then cliSource back to back), and
 * each immediate reinit would tear down and respawn the CLI.
 */
const REINIT_DEBOUNCE_MS = 500;
let reinitTimer: ReturnType<typeof setTimeout> | null = null;
let reinitPending: Promise<void> | null = null;
let reinitResolve: (() => void) | null = null;

/**
 * Coalesce a burst of runtime-config changes into a single reinit. Returns a
 * promise that resolves once the reinit has run — but callers handling IPC
 * should NOT await it, or sequential settings writes won't coalesce.
 */
export function scheduleCopilotReinit(): Promise<void> {
  if (!reinitPending) {
    reinitPending = new Promise<void>(resolve => { reinitResolve = resolve; });
  }
  if (reinitTimer) clearTimeout(reinitTimer);
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    const done = reinitResolve;
    reinitPending = null;
    reinitResolve = null;
    void reinitCopilot().catch(err => {
      console.error('[copilot-sdk] Scheduled reinit failed:', err);
    }).finally(() => done?.());
  }, REINIT_DEBOUNCE_MS);
  return reinitPending;
}

export async function setAIModel(model: string): Promise<void> {
  // Update all active sessions
  const sessions = [parseSession, recurrenceSession, recallSession];
  for (const s of sessions) {
    if (s) {
      try { await s.setModel(model); } catch { /* ignore */ }
    }
  }
  console.log(`[copilot-sdk] Model changed to: ${model}`);
}

export async function listAvailableModels(): Promise<{ id: string; name?: string }[]> {
  const { models } = await listModelsDetailed();
  return models;
}

/**
 * List models, reporting *why* the list is empty when it is. The plain
 * {@link listAvailableModels} swallows every failure into `[]`, which left the
 * onboarding screen showing a bare "No models available" with no way to tell a
 * still-starting runtime from an unauthenticated CLI.
 *
 * Also self-heals the common startup race: a call that lands before (or during)
 * the first `initCopilot()` waits for it rather than seeing a null client.
 */
export async function listModelsDetailed(): Promise<{ models: { id: string; name?: string }[]; error: string | null }> {
  if (initInFlight) {
    try { await initInFlight; } catch { /* error surfaced via lastInitError */ }
  }
  // A CLI change only *schedules* a debounced reinit, so a client may still be
  // connected to the previous runtime. Listing its models here would report the
  // old CLI's capabilities under the new CLI's name — exactly the mismatch this
  // is meant to surface — so re-point at the configured runtime first.
  if (client && activeRuntimeKey !== runtimeKey(resolveRuntimeConnection())) {
    try { await reinitCopilot(); } catch { /* error surfaced via lastInitError */ }
  }
  if (!client) {
    try { await initCopilot(); } catch { /* error surfaced via lastInitError */ }
  }
  if (!client) {
    return { models: [], error: lastInitError || 'Copilot runtime is not running.' };
  }
  try {
    const models = await client.listModels();
    if (models.length === 0) {
      return { models: [], error: 'The Copilot CLI returned no models. Run `copilot` once in a terminal to sign in.' };
    }
    return { models: models.map(m => ({ id: m.id, name: m.name })), error: null };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function stopClient(stopping: CopilotClient): Promise<void> {
  try {
    const errors = await stopping.stop();
    for (const error of errors) console.error('[copilot-sdk] Runtime cleanup failed:', error);
  } catch (err) {
    console.error('[copilot-sdk] Runtime cleanup failed:', err);
  }
}

export async function shutdownCopilot(): Promise<void> {
  await initInFlight;
  await ephemeralInFlight;
  activeRuntimeKey = null;
  // stop() owns session cancellation/disconnection, including the FFI SQLite
  // cleanup workaround. Do not detach sessions before it can abort them.
  const stopping = [client, ephemeralClient];
  client = ephemeralClient = null;
  parseSession = recurrenceSession = recallSession = null;
  await Promise.all(stopping.map(current => current ? stopClient(current) : Promise.resolve()));
  console.log('[copilot-sdk] Shut down');
}

function extractJson(text: string): any | null {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function isValidIso8601(s: string | null | undefined): boolean {
  if (!s) return false;
  const d = new Date(s);
  return !isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(s);
}

function getLocalTimeContext(): string {
  const now = new Date();
  const local = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
  return `Current local time: ${now.toISOString().replace('Z', '')}${getTimezoneOffsetString()} (${local})\nCurrent UTC: ${now.toISOString()}`;
}

function getTimezoneOffsetString(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const hrs = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mins = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${sign}${hrs}:${mins}`;
}

export async function parseSpaceWithAI(rawText: string): Promise<ParsedSpace> {
  const session = await getParseSession();
  if (!session) {
    console.warn('[copilot-sdk] Parse session not ready, returning raw text');
    return { description: rawText, client: null, due_at: null, due_at_utc: null };
  }

  try {
    const response = await session.sendAndWait({
      prompt: `${getLocalTimeContext()}\n\nParse this space:\nInput: "${rawText}"`,
    }, 30000);

    const content = response?.data?.content ?? '';
    const parsed = extractJson(content);
    if (!parsed) {
      console.error('[copilot-sdk] Response was not JSON:', content);
      return { description: rawText, client: null, due_at: null, due_at_utc: null };
    }

    const due_at_utc = isValidIso8601(parsed.due_at_utc) ? parsed.due_at_utc : null;

    return {
      description: parsed.title || parsed.description || rawText,
      client: parsed.client || null,
      due_at: parsed.due_at || null,
      due_at_utc,
    };
  } catch (err) {
    console.error('[copilot-sdk] Parse failed:', err);
    return { description: rawText, client: null, due_at: null, due_at_utc: null };
  }
}

/** Resolve a natural language date to due_at + due_at_utc */
export async function resolveDateWithAI(dateText: string): Promise<{ due_at: string; due_at_utc: string | null }> {
  const session = await getParseSession();
  if (!session) {
    return { due_at: dateText, due_at_utc: null };
  }

  try {
    const response = await session.sendAndWait({
      prompt: `${getLocalTimeContext()}

Resolve this date/time to a specific date. Return ONLY JSON:
{"due_at": "human readable date", "due_at_utc": "ISO 8601 UTC"}

Input: "${dateText}"`,
    }, 15000);

    const content = response?.data?.content ?? '';
    const parsed = extractJson(content);
    if (!parsed) return { due_at: dateText, due_at_utc: null };

    return {
      due_at: parsed.due_at || dateText,
      due_at_utc: isValidIso8601(parsed.due_at_utc) ? parsed.due_at_utc : null,
    };
  } catch (err) {
    console.error('[copilot-sdk] Date resolve failed:', err);
    return { due_at: dateText, due_at_utc: null };
  }
}

export interface InputClassification {
  type: 'space' | 'query';
  query_answer?: string;
}

/** Classify whether user input is a new space or a question about their spaces/history */
export async function classifyInput(text: string, recentSpaces: { description: string; status: string; due_at: string | null; completed_at: string | null }[]): Promise<InputClassification> {
  const session = await getParseSession();
  if (!session) return { type: 'space' };

  const intentList = recentSpaces.slice(0, 15).map((i, idx) =>
    `${idx}. "${i.description}" [${i.status}]${i.due_at ? ` due: ${i.due_at}` : ''}${i.completed_at ? ` completed: ${i.completed_at}` : ''}`
  ).join('\n');

  try {
    const response = await session.sendAndWait({
      prompt: `${getLocalTimeContext()}

Classify this user input. Is it:
A) A new space/task to capture (action item, to-do, reminder)
B) A question or query about their existing spaces, history, or schedule

User's current spaces:
${intentList || '(none)'}

User input: "${text}"

Return ONLY JSON:
{"type": "space" or "query", "query_answer": "brief answer if type=query, otherwise null"}`,
    }, 15000);

    const content = response?.data?.content ?? '';
    const parsed = extractJson(content);
    if (!parsed) return { type: 'space' };

    return {
      type: parsed.type === 'query' ? 'query' : 'space',
      query_answer: parsed.query_answer || undefined,
    };
  } catch (err) {
    console.error('[copilot-sdk] Classify failed:', err);
    return { type: 'space' };
  }
}

export async function evaluateRecurrence(space: {
  raw_text: string | null;
  description: string;
  due_at: string | null;
  due_at_utc: string | null;
  completed_at: string;
}): Promise<RecurrenceResult> {
  const session = await getRecurrenceSession();
  const noRecur: RecurrenceResult = { should_recur: false, reasoning: 'Session not available', next_due: null, next_due_utc: null };
  if (!session) return noRecur;

  try {
    const response = await session.sendAndWait({
      prompt: `${getLocalTimeContext()}

The user completed this space:
  Original text: "${space.raw_text || space.description}"
  Refined description: "${space.description}"
  Due date: "${space.due_at || 'none'}" (${space.due_at_utc || 'no UTC date'})
  Completed at: "${space.completed_at}"

Should this space recur? If yes, when is the next due date?`,
    }, 30000);

    const content = response?.data?.content ?? '';
    const parsed = extractJson(content);
    if (!parsed) {
      console.error('[copilot-sdk] Recurrence response was not JSON:', content);
      return noRecur;
    }

    const result: RecurrenceResult = {
      should_recur: !!parsed.should_recur,
      reasoning: parsed.reasoning || '',
      next_due: parsed.next_due || null,
      next_due_utc: isValidIso8601(parsed.next_due_utc) ? parsed.next_due_utc : null,
    };

    // Sanity: next due must be after completion
    if (result.should_recur && result.next_due_utc) {
      if (new Date(result.next_due_utc) <= new Date(space.completed_at)) {
        console.warn('[copilot-sdk] Recurrence next_due_utc is not after completed_at, discarding');
        result.next_due_utc = null;
      }
    }

    // If should recur but no valid UTC date, keep the human-readable date but clear UTC
    return result;
  } catch (err) {
    console.error('[copilot-sdk] Recurrence eval failed:', err);
    return noRecur;
  }
}

export async function findSimilarSpace(newDescription: string, candidates: Space[]): Promise<RecallMatch | null> {
  if (candidates.length === 0) return null;
  const session = await getRecallSession();
  if (!session) return null;

  try {
    const candidateList = candidates.map((c, i) =>
      `${i}. "${c.description}" (status: ${c.status}${c.completed_at ? ', completed: ' + c.completed_at : ''})`
    ).join('\n');

    const response = await session.sendAndWait({
      prompt: `New space: "${newDescription}"

Past spaces:
${candidateList}

Find the most semantically similar past space, if any.`,
    }, 30000);

    const content = response?.data?.content ?? '';
    const parsed = extractJson(content);
    if (!parsed || parsed.match_index === -1 || parsed.confidence < 0.5) return null;

    const idx = parsed.match_index;
    if (idx < 0 || idx >= candidates.length) return null;

    const matched = candidates[idx];
    return {
      space_id: matched.id,
      description: matched.description,
      completed_at: matched.completed_at,
      confidence: parsed.confidence,
    };
  } catch (err) {
    console.error('[copilot-sdk] Recall search failed:', err);
    return null;
  }
}
