import { execSync, exec } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getSpace, assignSpaceFolder } from './database';
import { getSessionId, setSessionId as configSetSessionId, getConfigValue } from './config';
import { setSpaceSessionId } from './database';
import { createSpaceFolder } from './workspace';
import { launchInTerminal as platformLaunchInTerminal } from './platform/terminal';
import { focusTerminalWindow } from './platform/focus';
import {
  getBundledCopilotCandidates,
  getCopilotPlatformEntrypoints,
  isLinuxMuslRuntime,
} from './copilot-runtime-path';

// Per-space launch lock to prevent duplicate terminals
const launching = new Set<string>();

// Track running terminal processes: spaceId → session info
interface TrackedSession {
  pid: number | null;
  sessionId: string;
}
const runningProcesses = new Map<string, TrackedSession>();

let resolvedCliPath: string | null = null;
let cliResolved = false;

// ── CLI version compatibility ───────────────────────────

export const MIN_CLI_VERSION = '1.0.78';

let resolvedCliVersion: string | null = null;
let cliVersionResolved = false;

export interface CliVersionInfo {
  path: string | null;
  version: string | null;
  compatible: boolean;
  minVersion: string;
}

/** Parse a version string from `copilot --version` output (e.g. "GitHub Copilot CLI 1.0.36.") */
export function parseCliVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Compare two semver-like version strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Detect the CLI version by running `<cli> --version`. Result is cached. */
export function getCopilotCliVersion(): string | null {
  if (cliVersionResolved) return resolvedCliVersion;
  cliVersionResolved = true;

  const cliPath = resolveCopilotCliPath();
  if (!cliPath) {
    resolvedCliVersion = null;
    return null;
  }

  resolvedCliVersion = probeCliVersion(cliPath);
  if (resolvedCliVersion) {
    console.log(`[session] CLI version: ${resolvedCliVersion}`);
  } else {
    console.warn(`[session] Could not determine CLI version for: ${cliPath}`);
  }

  return resolvedCliVersion;
}

/** Full compatibility check — returns path, version, and whether the version meets the minimum. */
export function checkCliCompatibility(): CliVersionInfo {
  const cliPath = resolveCopilotCliPath();
  const version = getCopilotCliVersion();
  const compatible = version != null && (version === '0.0.1' || compareVersions(version, MIN_CLI_VERSION) >= 0);
  return { path: cliPath, version, compatible, minVersion: MIN_CLI_VERSION };
}

let resolvedMxcCapable: boolean | null = null;
let mxcCapableResolved = false;

/**
 * Reset cached mxc-capability probe. Called whenever cliPath changes.
 * @internal — exported for invalidateCliPath() to chain into.
 */
export function invalidateMxcCapability(): void {
  resolvedMxcCapable = null;
  mxcCapableResolved = false;
}

/**
 * Best-effort probe: returns true if the resolved CLI ships with
 * `@microsoft/mxc-sdk` in its node_modules. Used to surface a warning when a
 * sandboxed persona is launched against a CLI that can't enforce MXC.
 *
 * Walks up from `dirname(cliPath)` checking `<dir>/node_modules/@microsoft/mxc-sdk`
 * at every level (up to a bounded depth). This handles all real layouts:
 *   - bundled CLI (`<repo>/dist-cli/index.js`, deps in `<repo>/node_modules`),
 *   - hoisted npm install (`<prefix>/node_modules/@github/copilot/index.js`,
 *     deps in `<prefix>/node_modules`),
 *   - nested install (`@github/copilot/node_modules/@microsoft/mxc-sdk`).
 *
 * Result is cached; cleared on cliPath change via `invalidateMxcCapability`.
 */
export function isCliMxcCapable(): boolean {
  if (mxcCapableResolved) return resolvedMxcCapable === true;
  mxcCapableResolved = true;
  resolvedMxcCapable = false;

  const cliPath = resolveCopilotCliPath();
  if (!cliPath) return false;

  // Compiled standalone binaries (e.g. Homebrew Cask) bundle all dependencies
  // inside a single Mach-O/PE executable. They ship with MXC but have no
  // external node_modules to probe. Detect by checking if the resolved path
  // is a binary (not a .js/.cjs entry point).
  if (!cliPath.endsWith('.js') && !cliPath.endsWith('.cjs')) {
    // Heuristic: a standalone binary >= 50MB almost certainly bundles deps.
    try {
      const stat = fs.statSync(cliPath);
      if (stat.size > 50 * 1024 * 1024) {
        resolvedMxcCapable = true;
        return true;
      }
    } catch { /* fall through to node_modules probe */ }
  }

  // Self-updated CLI bundles ship MXC in a `mxc-bin` directory alongside
  // index.js rather than in node_modules.
  const mxcBinDir = path.join(path.dirname(cliPath), 'mxc-bin');
  if (fs.existsSync(mxcBinDir)) {
    resolvedMxcCapable = true;
    return true;
  }

  const MAX_DEPTH = 8;
  const searched: string[] = [];
  let dir = path.dirname(cliPath);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const mxcSdkDir = path.join(dir, 'node_modules', '@microsoft', 'mxc-sdk');
    searched.push(mxcSdkDir);
    if (fs.existsSync(mxcSdkDir)) {
      resolvedMxcCapable = true;
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.warn(
    `[session] MXC probe: @microsoft/mxc-sdk not found near ${cliPath}. Searched:\n  ${searched.join('\n  ')}`,
  );
  return false;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
  sessionId?: string;
}

// ── CLI discovery ───────────────────────────────────────

/**
 * Directories the Copilot CLI extracts self-updates into, mirroring the CLI's
 * own resolution order (`index.js`/`app.js`). Each base contains
 * `universal/<ver>/` and `<platform>-<arch>/<ver>/` subdirectories, each a
 * complete standalone CLI bundle.
 */
export function getCopilotPkgBaseDirs(): string[] {
  const join = process.platform === 'win32' ? path.win32.join : path.posix.join;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const add = (d: string | null | undefined): void => { if (d) dirs.push(d); };

  if (process.env.COPILOT_CACHE_HOME) add(join(process.env.COPILOT_CACHE_HOME, 'pkg'));

  if (process.platform === 'darwin') {
    add(join(home, 'Library', 'Caches', 'copilot', 'pkg'));
  } else if (process.platform === 'win32') {
    add(path.win32.join(process.env.LOCALAPPDATA || path.win32.join(home, '.cache'), 'copilot', 'pkg'));
  } else {
    add(join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'copilot', 'pkg'));
  }

  if (process.env.COPILOT_HOME) add(join(process.env.COPILOT_HOME, 'pkg'));
  if (home) add(join(home, '.copilot', 'pkg'));

  return [...new Set(dirs)];
}

/**
 * Scan every self-update cache (all platforms) for the newest fully-extracted
 * Copilot CLI bundle and return its `index.js`. The self-updated CLI is a
 * complete standalone package (includes MXC, copilot-sdk, etc.) and works under
 * Electron with ELECTRON_RUN_AS_NODE.
 *
 * A bundle is considered usable only when both `index.js` (the spawn entry) and
 * `app.js` (the CLI itself) are present — this mirrors how the CLI's own loader
 * locates versions and skips partially-extracted directories.
 */
export function findLatestSelfUpdatedCli(): string | null {
  const all = findSelfUpdatedClis();
  return all.length > 0 ? all[0].path : null;
}

/**
 * Resolve a bare command name (e.g. "copilot", "copilot-dev") to its full
 * path using the system PATH via `where.exe` (Windows) or `which` (Unix).
 */
export function resolveCommandOnPath(command: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? `where.exe ${command}` : `which ${command}`;
    const result = execSync(cmd, { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const lines = result.split(/\r?\n/).filter(Boolean);

    if (process.platform === 'win32') {
      // Prefer .cmd files on Windows (Node can't spawn bare Unix shell scripts)
      const cmdLine = lines.find(l => /\.cmd$/i.test(l));
      if (cmdLine && fs.existsSync(cmdLine)) return cmdLine;
    }

    // Return first valid result
    const first = lines[0];
    if (first && fs.existsSync(first)) return first;
  } catch {
    // Command not found on PATH
  }
  return null;
}

/**
 * On Windows, .cmd wrappers cannot be spawned directly by the Copilot SDK
 * (it uses spawn() without shell:true, causing EINVAL). Resolve to the
 * installed platform-package JavaScript entrypoint in the same npm prefix. Legacy
 * `@github/copilot/index.js` installs remain supported as a fallback.
 */
export function resolveCmdToJs(cmdPath: string): string {
  if (process.platform !== 'win32') return cmdPath;

  const ext = path.win32.extname(cmdPath).toLowerCase();

  // Handle .cmd wrappers and extensionless npm shim scripts (Unix shell
  // scripts that npm places alongside the .cmd). Both need to be mapped to an
  // executable package entrypoint because Node's spawn() cannot execute them.
  // For extensionless files, only resolve if a .cmd sibling exists — this
  // confirms it's an npm-generated shim rather than a standalone binary.
  if (ext !== '.cmd') {
    if (ext !== '' || !fs.existsSync(cmdPath + '.cmd')) return cmdPath;
  }

  // Use path.win32 explicitly: on non-Windows hosts (e.g. CI/tests), the
  // generic `path` module follows posix rules and won't recognize `\` as a
  // separator, so it can't extract the directory from a Windows .cmd path.
  const w = path.win32;
  try {
    const dir = w.dirname(cmdPath);
    const nodeModulesDirs = w.basename(dir) === '.bin'
      ? [w.dirname(dir)]
      : [w.join(dir, 'node_modules')];

    for (const nodeModulesDir of nodeModulesDirs) {
      for (const entrypoint of getCopilotPlatformEntrypoints('win32', process.arch, false)) {
        const platformEntrypoint = w.join(nodeModulesDir, entrypoint.packageRelativePath);
        if (fs.existsSync(platformEntrypoint)) return platformEntrypoint;
      }
    }

    const selfUpdated = findLatestSelfUpdatedCli();
    if (selfUpdated) return selfUpdated;

    for (const nodeModulesDir of nodeModulesDirs) {
      const legacyJs = w.join(nodeModulesDir, '@github', 'copilot', 'index.js');
      if (fs.existsSync(legacyJs)) return legacyJs;
    }
  } catch {
    // Fall through to return original
  }

  return cmdPath;
}

/**
 * Cache of `<cli> --version` probes, keyed by path. Each probe spawns the CLI,
 * and on macOS a spawned CLI may read its token from the login keychain — which
 * can trigger a keychain prompt. Caching keeps that to once per path per run.
 * Cleared by {@link invalidateCliPath}.
 */
const probedVersions = new Map<string, string | null>();

/**
 * Probe a candidate CLI's version by running `<cli> --version`. `.js` entries
 * are run via the current Node/Electron binary (as plain Node). Returns null on
 * any failure. Cached per path; call `invalidateCliPath()` to re-probe.
 */
export function probeCliVersion(cliPath: string): string | null {
  if (probedVersions.has(cliPath)) return probedVersions.get(cliPath) ?? null;
  const version = runVersionProbe(cliPath);
  probedVersions.set(cliPath, version);
  return version;
}

/**
 * Async twin of {@link probeCliVersion}, sharing the same cache. Used by
 * discovery, which probes several binaries and must not block the main process
 * while each one spawns.
 */
export async function probeCliVersionAsync(cliPath: string): Promise<string | null> {
  if (probedVersions.has(cliPath)) return probedVersions.get(cliPath) ?? null;
  const version = await runVersionProbeAsync(cliPath);
  probedVersions.set(cliPath, version);
  return version;
}

function versionProbeCommand(cliPath: string): string {
  return /\.js$/i.test(cliPath)
    ? `"${process.execPath}" "${cliPath}" --version`
    : `"${cliPath}" --version`;
}

async function runVersionProbeAsync(cliPath: string): Promise<string | null> {
  try {
    const output = await execAsync(versionProbeCommand(cliPath), {
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    return parseCliVersion(output);
  } catch {
    return null;
  }
}

/** Promise wrapper around `exec` that resolves with trimmed stdout. */
function execAsync(cmd: string, options: Parameters<typeof exec>[1]): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { ...options, encoding: 'utf8' } as never, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

function runVersionProbe(cliPath: string): string | null {
  try {
    const output = execSync(versionProbeCommand(cliPath), {
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).toString().trim();
    return parseCliVersion(output);
  } catch {
    return null;
  }
}

/**
 * Common bin directories prepended to PATH for discovery. GUI apps launched
 * from Finder/Dock inherit a minimal launchd PATH (`/usr/bin:/bin:…`) that
 * omits Homebrew, npm-global and version-manager dirs, so `which copilot`
 * fails even when the CLI is installed. Augmenting PATH restores discovery.
 */
function getAugmentedPathEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return process.env;
  const home = process.env.HOME || '';
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    home && path.posix.join(home, '.local', 'bin'),
    home && path.posix.join(home, '.npm-global', 'bin'),
    '/usr/bin',
    '/bin',
  ].filter(Boolean) as string[];
  const current = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [...new Set([...current, ...extra])].join(':');
  return { ...process.env, PATH: merged };
}

/**
 * Ask the user's login shell where `copilot` resolves. This catches installs
 * managed by nvm/fnm/volta/asdf and other version managers whose dirs only
 * exist on the interactive shell PATH — invisible to a GUI-launched app.
 */
function resolveViaLoginShell(): string | null {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/bash';
  try {
    const out = execSync(loginShellProbeCommand(shell), {
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return pickLoginShellResult(out);
  } catch {
    // Shell unavailable or copilot not found
  }
  return null;
}

function loginShellProbeCommand(shell: string): string {
  return `'${shell}' -lic 'command -v copilot' 2>/dev/null`;
}

function pickLoginShellResult(out: string): string | null {
  const line = out.split(/\r?\n/).filter(Boolean).pop();
  if (line && !line.includes('node_modules') && fs.existsSync(line)) return line;
  return null;
}

/** Async twin of {@link resolveViaLoginShell}, for off-main-thread discovery. */
async function resolveViaLoginShellAsync(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/bash';
  try {
    const out = await execAsync(loginShellProbeCommand(shell), { timeout: 8000, windowsHide: true });
    return pickLoginShellResult(out);
  } catch {
    return null;
  }
}

/** Candidate install locations for the CLI, by platform. */
function getCliCandidatePaths(): string[] {
  if (process.platform === 'win32') {
    return [
      path.win32.join(process.env.APPDATA || '', 'npm', 'copilot.cmd'),
      path.win32.join(process.env.LOCALAPPDATA || '', 'npm', 'copilot.cmd'),
      path.win32.join(process.env.ProgramData || 'C:\\ProgramData', 'npm', 'copilot.cmd'),
    ];
  }
  const home = process.env.HOME || '';
  return [
    '/opt/homebrew/bin/copilot',                          // Homebrew (Apple Silicon)
    '/usr/local/bin/copilot',                             // Homebrew (Intel) / install script as root
    home && path.posix.join(home, '.local', 'bin', 'copilot'),    // install script (non-root)
    home && path.posix.join(home, '.npm-global', 'bin', 'copilot'),
  ].filter(Boolean) as string[];
}

/**
 * From a list of candidate CLI paths, return the one with the highest probed
 * version. Falls back to the first existing candidate when versions can't be
 * determined. Empty/missing candidates are ignored.
 */
function selectNewestCli(candidates: string[]): string | null {
  const existing: string[] = [];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && !existing.includes(p)) existing.push(p);
    } catch {
      // ignore
    }
  }
  if (existing.length === 0) return null;
  if (existing.length === 1) return existing[0];

  let best: { path: string; version: string | null } | null = null;
  for (const p of existing) {
    const version = probeCliVersion(p);
    if (!best) { best = { path: p, version }; continue; }
    if (version && !best.version) { best = { path: p, version }; continue; }
    if (version && best.version && compareVersions(version, best.version) > 0) {
      best = { path: p, version };
    }
  }
  return best ? best.path : existing[0];
}

function autoDetectCopilotCli(): string | null {
  // 1. Prefer the self-updated CLI — it's the newest available across every
  //    self-update cache and bundles MXC support. Filesystem-only, no spawn.
  const selfUpdated = findLatestSelfUpdatedCli();
  if (selfUpdated) {
    console.log(`[session] Found self-updated CLI: ${selfUpdated}`);
    return selfUpdated;
  }

  // 2. Otherwise pick the newest among well-known install locations.
  const best = selectNewestCli(getCliCandidatePaths());
  if (best) {
    const resolved = resolveCmdToJs(best);
    console.log(`[session] Detected CLI install: ${resolved}`);
    return resolved;
  }

  // 3. Fall back to PATH lookup with an augmented PATH (fixes GUI-launch).
  try {
    const cmd = process.platform === 'win32' ? 'where.exe copilot' : 'which copilot';
    const result = execSync(cmd, {
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: getAugmentedPathEnv(),
    }).toString().trim();
    const lines = result.split(/\r?\n/).filter(Boolean);

    // Skip node_modules shims — we want the real globally-installed CLI,
    // not the local project shim that npm puts on PATH during `npm run`.
    const isGlobal = (l: string): boolean => !l.includes('node_modules');

    if (process.platform === 'win32') {
      // On Windows, prefer .cmd files — bare "copilot" entries are Unix shell
      // scripts that Node's spawn() cannot execute (ENOENT).
      const cmdLine = lines.find(l => /\.cmd$/i.test(l) && isGlobal(l));
      if (cmdLine && fs.existsSync(cmdLine)) return resolveCmdToJs(cmdLine);
    }

    const globalLine = lines.find(l => isGlobal(l));
    if (globalLine && fs.existsSync(globalLine)) return resolveCmdToJs(globalLine);
  } catch {
    // Not found on PATH
  }

  // 4. Last resort: ask the login shell (catches nvm/fnm/volta/asdf installs).
  const shellResolved = resolveViaLoginShell();
  if (shellResolved) {
    console.log(`[session] Resolved CLI via login shell: ${shellResolved}`);
    return resolveCmdToJs(shellResolved);
  }

  return null;
}

/**
 * Scan every self-update cache for *all* fully-extracted CLI bundles, newest
 * first. {@link findLatestSelfUpdatedCli} returns only the best one; discovery
 * needs the full set so the user can pick an older version when the newest is
 * broken.
 */
export function findSelfUpdatedClis(): { path: string; version: string }[] {
  const join = process.platform === 'win32' ? path.win32.join : path.posix.join;
  const platformArch = `${process.platform}-${process.arch}`;
  const found: { path: string; version: string; raw: string }[] = [];
  const seen = new Set<string>();

  for (const base of getCopilotPkgBaseDirs()) {
    for (const sub of ['universal', platformArch]) {
      const dir = join(base, sub);
      let names: string[];
      try {
        if (!fs.existsSync(dir)) continue;
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const versionDir = join(dir, name);
        const entry = join(versionDir, 'index.js');
        try {
          if (!fs.statSync(versionDir).isDirectory()) continue;
          if (!fs.existsSync(entry)) continue;
          if (!fs.existsSync(join(versionDir, 'app.js'))) continue;
        } catch {
          continue;
        }
        if (seen.has(entry)) continue;
        seen.add(entry);
        found.push({ path: entry, version: name.replace(/-.*$/, ''), raw: name });
      }
    }
  }

  // Newest first, with the same prerelease tie-break the CLI loader uses.
  found.sort((a, b) => compareVersions(b.version, a.version) || b.raw.localeCompare(a.raw));
  return found.map(({ path: p, version }) => ({ path: p, version }));
}

export interface DiscoveredCli {
  /** Absolute path to the spawnable entrypoint. */
  path: string;
  /** Version string, when it could be determined. */
  version: string | null;
  /** Which runtime source selecting this entry maps to. */
  source: 'bundled' | 'path';
  /** Where it was found, for display (e.g. "Self-updated", "Homebrew"). */
  origin: string;
  /** Whether the version meets {@link MIN_CLI_VERSION}. */
  compatible: boolean;
}

/** Human label for the directory a CLI was found in. */
function describeCliOrigin(cliPath: string): string {
  const p = cliPath.replace(/\\/g, '/');
  if (/\/(pkg)\/(universal|[a-z0-9]+-[a-z0-9]+)\//.test(p)) return 'Self-updated';
  if (p.startsWith('/opt/homebrew/')) return 'Homebrew';
  if (p.startsWith('/usr/local/')) return '/usr/local';
  if (p.includes('/.local/bin/')) return 'Install script';
  if (p.includes('/.npm-global/')) return 'npm global';
  if (p.includes('/node_modules/')) return 'npm install';
  return 'System';
}

/**
 * Enumerate every Copilot CLI on the machine so the user can choose which one
 * whim runs. Covers the bundled copy, all self-update cache versions, the
 * well-known install locations, whatever is on PATH, and the login shell's
 * resolution (nvm/fnm/volta/asdf).
 *
 * Async, and every spawn (PATH lookup, login shell, `--version` probes) runs
 * off the main thread and in parallel — a synchronous version froze the whole
 * app for seconds, since each probe is a CLI start that on macOS may also
 * prompt for keychain access. Self-update bundles skip the probe entirely by
 * reusing the version in their directory name, and only one entry per
 * origin+version is kept. Probe results are cached by
 * {@link probeCliVersionAsync} until {@link invalidateCliPath} is called.
 */
export async function discoverCopilotClis(): Promise<DiscoveredCli[]> {
  interface Candidate {
    path: string;
    source: 'bundled' | 'path';
    origin: string;
    knownVersion?: string;
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const add = (
    cliPath: string | null,
    source: 'bundled' | 'path',
    origin?: string,
    knownVersion?: string,
  ): void => {
    if (!cliPath) return;
    let resolved: string;
    try {
      resolved = fs.existsSync(cliPath) ? fs.realpathSync(cliPath) : cliPath;
    } catch {
      resolved = cliPath;
    }
    if (seen.has(resolved)) return;
    try {
      if (!fs.existsSync(resolved)) return;
    } catch {
      return;
    }
    seen.add(resolved);
    candidates.push({ path: resolved, source, origin: origin ?? describeCliOrigin(resolved), knownVersion });
  };

  try {
    add(resolveBundledCliPath(), 'bundled', 'Bundled with whim');
  } catch {
    // No bundled copy available (e.g. a source checkout)
  }

  for (const entry of findSelfUpdatedClis()) {
    add(entry.path, 'path', 'Self-updated', entry.version);
  }

  for (const candidate of getCliCandidatePaths()) {
    add(resolveCmdToJs(candidate), 'path');
  }

  const [pathResult, shellResolved] = await Promise.all([
    (async () => {
      try {
        const cmd = process.platform === 'win32' ? 'where.exe copilot' : 'which -a copilot';
        return await execAsync(cmd, { windowsHide: true, timeout: 5000, env: getAugmentedPathEnv() });
      } catch {
        return '';
      }
    })(),
    resolveViaLoginShellAsync(),
  ]);

  for (const line of pathResult.split(/\r?\n/).filter(Boolean)) {
    if (line.includes('node_modules')) continue;
    add(resolveCmdToJs(line), 'path', 'On PATH');
  }
  if (shellResolved) add(resolveCmdToJs(shellResolved), 'path', 'Login shell');

  const versions = await Promise.all(
    candidates.map(c => (c.knownVersion != null ? Promise.resolve(c.knownVersion) : probeCliVersionAsync(c.path)))
  );

  const out: DiscoveredCli[] = [];
  const seenVersions = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const version = versions[i];
    // Self-update caches keep several builds of the same version
    // (1.0.64, 1.0.64-1, 1.0.64-3); listing them all just bloats the picker.
    // Keyed by origin so two genuinely different installs at the same version
    // (say Homebrew and npm-global) both stay selectable.
    const versionKey = version ? `${c.origin}\u0000${version}` : null;
    if (versionKey) {
      if (seenVersions.has(versionKey)) continue;
      seenVersions.add(versionKey);
    }
    out.push({
      path: c.path,
      version,
      source: c.source,
      origin: c.origin,
      compatible: version != null && (version === '0.0.1' || compareVersions(version, MIN_CLI_VERSION) >= 0),
    });
  }
  return out;
}

let resolvedBundledCliPath: string | null = null;
let bundledCliResolved = false;

/**
 * Resolve the path to the Copilot CLI bundled with the app
 * (the JavaScript entrypoint in the pinned platform package). This runs a
 * CLI version for terminal sessions with no external install required.
 * SDK sessions use their separate native runtime bundle.
 *
 * In a packaged build the package is unpacked from the asar archive (see
 * `build.asarUnpack` in package.json). We prefer the `app.asar.unpacked`
 * platform entrypoint and use the in-place `node_modules` equivalent for
 * unpackaged/dev runs. A legacy `index.js` is retained as a safe fallback.
 */
export function resolveBundledCliPath(): string | null {
  if (bundledCliResolved) return resolvedBundledCliPath;
  bundledCliResolved = true;

  const appPath = app.getAppPath();
  const candidates = getBundledCopilotCandidates(
    appPath,
    process.platform,
    process.arch,
    isLinuxMuslRuntime(),
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      resolvedBundledCliPath = candidate;
      console.log(`[session] Bundled CLI: ${candidate}`);
      return candidate;
    }
  }
  console.error(`[session] Bundled CLI not found. Searched:\n  ${candidates.join('\n  ')}`);
  resolvedBundledCliPath = null;
  return null;
}

/**
 * Resolve a user-supplied CLI path or bare command name to a usable entry
 * point. Returns null when it can't be resolved. Used by the 'path' runtime
 * source and by `resolveCopilotCliPath`'s config override.
 */
export function resolveConfiguredCliPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Full path that exists → use directly (mapping .cmd → index.js on Windows).
  if (fs.existsSync(raw)) return resolveCmdToJs(raw);
  // Otherwise treat it as a bare command name and resolve via PATH.
  const resolved = resolveCommandOnPath(raw);
  if (resolved) return resolveCmdToJs(resolved);
  return null;
}

let resolvedAutoPath: string | null = null;
let autoPathResolved = false;

/**
 * Auto-detect the best local Copilot CLI, ignoring any configured override.
 * Used by the 'auto' runtime source. Result is cached; reset via
 * invalidateCliPath().
 */
export function resolveAutoDetectedCliPath(): string | null {
  if (autoPathResolved) return resolvedAutoPath;
  autoPathResolved = true;
  resolvedAutoPath = autoDetectCopilotCli();
  return resolvedAutoPath;
}

/**
 * Resolve the effective Copilot CLI path.
 * Priority: user config override → auto-detect.
 * Result is cached; call invalidateCliPath() to reset after config changes.
 */
export function resolveCopilotCliPath(): string | null {
  if (cliResolved) return resolvedCliPath;
  cliResolved = true;

  const override = getConfigValue('cliPath');
  if (override) {
    const configured = resolveConfiguredCliPath(override);
    if (configured) {
      resolvedCliPath = configured;
      console.log(`[session] Using configured CLI path: ${resolvedCliPath}`);
      return resolvedCliPath;
    }
    console.warn(`[session] Configured CLI path not found: ${override}, falling back to auto-detect`);
  }

  resolvedCliPath = autoDetectCopilotCli();
  if (resolvedCliPath) {
    console.log(`[session] Auto-detected CLI at: ${resolvedCliPath}`);
  } else {
    console.warn('[session] Copilot CLI not found');
  }
  return resolvedCliPath;
}

/** Clear cached CLI path and version so the next call re-resolves. */
export function invalidateCliPath(): void {
  cliResolved = false;
  resolvedCliPath = null;
  autoPathResolved = false;
  resolvedAutoPath = null;
  bundledCliResolved = false;
  resolvedBundledCliPath = null;
  cliVersionResolved = false;
  resolvedCliVersion = null;
  probedVersions.clear();
  invalidateMxcCapability();
}

/** @deprecated Use resolveCopilotCliPath() instead */
export async function checkCopilotCli(): Promise<string | null> {
  return resolveCopilotCliPath();
}

// ── Process tracking ────────────────────────────────────

/** Check if a process is still running by PID */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if a copilot session is running by searching for its resume arg */
function isSessionProcessRunning(sessionId: string): boolean {
  try {
    if (process.platform === 'win32') {
      const result = execSync(
        `wmic process where "CommandLine like '%--resume=${sessionId}%'" get ProcessId /format:list`,
        { windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString();
      return result.includes('ProcessId=');
    } else {
      execSync(`pgrep -f "resume=${sessionId}"`, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    }
  } catch {
    return false;
  }
}

/** Check if a tracked session is still running */
function isTrackedSessionAlive(tracked: TrackedSession): boolean {
  if (tracked.pid && isProcessAlive(tracked.pid)) return true;
  return isSessionProcessRunning(tracked.sessionId);
}

/** Get space IDs that have active running terminal processes */
export function getActiveSessionIntentIds(): string[] {
  const active: string[] = [];
  for (const [spaceId, tracked] of runningProcesses) {
    if (isTrackedSessionAlive(tracked)) {
      active.push(spaceId);
    } else {
      runningProcesses.delete(spaceId);
    }
  }
  return active;
}

// ── Window focus (delegated to platform adapter) ────────

// ── Launch / reactivate ─────────────────────────────────

export async function launchSessionInTerminal(sessionId: string, cwd: string, signalPath?: string): Promise<{ pid: number | null }> {
  const cli = await checkCopilotCli();
  if (!cli) throw new Error('Copilot CLI not found');

  const compat = checkCliCompatibility();
  if (!compat.compatible) {
    throw new Error(
      `Copilot CLI ${compat.version || 'unknown'} is not compatible. Please update to ${compat.minVersion} or later (run: copilot update).`
    );
  }

  const result = await platformLaunchInTerminal({
    command: cli,
    args: [`--resume=${sessionId}`],
    cwd,
    signalPath,
  });
  return { pid: result.pid ?? null };
}

export async function launchSession(spaceId: string, workspaceRoot: string): Promise<LaunchResult> {
  // Check if there's already a running process — bring it to foreground
  const existing = runningProcesses.get(spaceId);
  if (existing && isTrackedSessionAlive(existing)) {
    const focused = await focusTerminalWindow({
      title: existing.sessionId,
      pid: existing.pid ?? undefined,
    });
    if (focused) {
      console.log(`[session] Reactivated existing terminal for ${spaceId}`);
      return { success: true, sessionId: existing.sessionId };
    }
    // Process alive but couldn't focus — clear and relaunch
    runningProcesses.delete(spaceId);
  }

  // Launch lock
  if (launching.has(spaceId)) {
    return { success: false, error: 'Session is already launching' };
  }

  // Validate workspace
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    return { success: false, error: 'Workspace directory does not exist' };
  }

  const cli = await checkCopilotCli();
  if (!cli) {
    return { success: false, error: 'Copilot CLI not found. Ensure it is installed and in your PATH.' };
  }

  const compat = checkCliCompatibility();
  if (!compat.compatible) {
    return {
      success: false,
      error: `Copilot CLI ${compat.version || 'unknown'} is not compatible. Please update to ${compat.minVersion} or later (run: copilot update).`,
    };
  }

  launching.add(spaceId);

  try {
    const space = getSpace(spaceId);
    if (!space) {
      return { success: false, error: 'Space not found' };
    }

    // Ensure the space has a workspace subfolder
    let folder = space.folder;
    if (!folder) {
      folder = createSpaceFolder(workspaceRoot, spaceId, space.description);
      assignSpaceFolder(spaceId, folder);
    }
    const cwd = path.join(workspaceRoot, folder);

    // Ensure folder exists (may have been deleted manually)
    if (!fs.existsSync(cwd)) {
      fs.mkdirSync(cwd, { recursive: true });
    }

    // Resolve session ID from local config (per-machine)
    let sessionId = getSessionId(spaceId);
    if (!sessionId) {
      const { v4: uuidv4 } = require('uuid');
      sessionId = uuidv4() as string;
      configSetSessionId(spaceId, sessionId);
      setSpaceSessionId(spaceId, sessionId);
    }

    const result = await platformLaunchInTerminal({
      command: cli,
      args: [`--resume=${sessionId}`],
      cwd,
    });
    if (result.pid === undefined) {
      return { success: false, error: 'Failed to open terminal' };
    }

    // On macOS, resolve the real PID asynchronously (Terminal.app spawns async)
    if (process.platform === 'darwin' && result.pid === 0) {
      setTimeout(() => {
        try {
          const realPid = parseInt(
            execSync(`pgrep -nf "resume=${sessionId}"`, { timeout: 3000 }).toString().trim()
          );
          if (realPid) {
            const tracked = runningProcesses.get(spaceId);
            if (tracked && tracked.sessionId === sessionId) {
              tracked.pid = realPid;
            }
          }
        } catch { /* process may not have started yet */ }
      }, 2000);
    }

    runningProcesses.set(spaceId, { pid: result.pid, sessionId: sessionId! });
    console.log(`[session] Launched terminal for ${spaceId} in ${folder} (PID ${result.pid || 'unknown'})`);
    return { success: true, sessionId: sessionId! };
  } finally {
    setTimeout(() => launching.delete(spaceId), 2000);
  }
}
