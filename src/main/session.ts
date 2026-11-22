import { execSync } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getSpace, assignSpaceFolder, setSpaceSessionId } from './storage';
import { getSessionId, setSessionId as configSetSessionId } from './config';
import { createSpaceFolder } from './workspace';
import { launchInTerminal as platformLaunchInTerminal } from './platform/terminal';
import { focusTerminalWindow } from './platform/focus';
import { getBundledCopilotCandidates, isLinuxMuslRuntime } from './copilot-runtime-path';

// Per-space launch lock to prevent duplicate terminals
const launching = new Set<string>();

// Track running terminal processes: spaceId → session info
interface TrackedSession {
  pid: number | null;
  sessionId: string;
}
const runningProcesses = new Map<string, TrackedSession>();

export interface LaunchResult {
  success: boolean;
  error?: string;
  sessionId?: string;
}

// ── Bundled Copilot CLI ─────────────────────────────────

let resolvedBundledCliPath: string | null = null;
let bundledCliResolved = false;

/**
 * The Copilot CLI executable that ships with Whim. Terminal sessions always use
 * it, so the app needs no separate CLI install or setup; SDK sessions run in
 * Whim's own in-process runtime instead.
 */
export function resolveBundledCliPath(): string | null {
  if (bundledCliResolved) return resolvedBundledCliPath;
  bundledCliResolved = true;

  const candidates = getBundledCopilotCandidates(
    app.getAppPath(),
    process.platform,
    process.arch,
    isLinuxMuslRuntime(),
  );
  resolvedBundledCliPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  if (resolvedBundledCliPath) {
    console.log(`[session] Bundled CLI: ${resolvedBundledCliPath}`);
  } else {
    console.error(`[session] Bundled CLI not found. Searched:\n  ${candidates.join('\n  ')}`);
  }
  return resolvedBundledCliPath;
}

const MISSING_CLI_ERROR = 'The Copilot CLI bundled with Whim is missing. Reinstall Whim to restore it.';

/**
 * Open the bundled Copilot CLI in a new terminal window. Rejects when the
 * terminal could not be opened, so callers never report a launch that did not
 * happen.
 */
export async function launchCliInTerminal(args: string[], cwd: string, signalPath?: string): Promise<{ pid: number | null }> {
  const cli = resolveBundledCliPath();
  if (!cli) throw new Error(MISSING_CLI_ERROR);
  const result = await platformLaunchInTerminal({ command: cli, args, cwd, signalPath });
  if (result.pid === undefined) throw new Error('Could not open a terminal window.');
  return { pid: result.pid };
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

/** Resume a CLI-owned session in a new terminal running the bundled CLI. */
export function launchSessionInTerminal(sessionId: string, cwd: string, signalPath?: string): Promise<{ pid: number | null }> {
  return launchCliInTerminal([`--resume=${sessionId}`], cwd, signalPath);
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

  const cli = resolveBundledCliPath();
  if (!cli) {
    return { success: false, error: MISSING_CLI_ERROR };
  }

  launching.add(spaceId);

  try {
    const space = (await getSpace(spaceId));
    if (!space) {
      return { success: false, error: 'Space not found' };
    }

    // Ensure the space has a workspace subfolder
    let folder = space.folder;
    if (!folder) {
      folder = createSpaceFolder(workspaceRoot, spaceId, space.description);
      (await assignSpaceFolder(spaceId, folder));
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
      (await setSpaceSessionId(spaceId, sessionId));
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
