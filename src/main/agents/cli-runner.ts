import { v4 as uuid } from 'uuid';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { launchSessionInTerminal } from '../session';
import { getConfig } from '../config';
import { AgentRegistry } from './agent-registry';
import { AgentNotifier } from './agent-notifier';
import { AgentPersistence } from './agent-persistence';
import { observeProducer } from '../producer-tasks';
import { getStorageGeneration, withStorageGeneration } from '../storage';

/** Shared dependencies injected from agent-service at init time. */
let registry: AgentRegistry;
let notifier: AgentNotifier;
let persistence: AgentPersistence;

export function initCliRunner(deps: {
  registry: AgentRegistry;
  notifier: AgentNotifier;
  persistence: AgentPersistence;
}): void {
  registry = deps.registry;
  notifier = deps.notifier;
  persistence = deps.persistence;
}

// ── CLI Session Launch ─────────────────────────────────

const CLI_EXIT_DIR = path.join(app.getPath('userData'), 'cli-exits');
let cliExitMonitorInterval: ReturnType<typeof setInterval> | null = null;
let monitorRevision = 0;
let polling = false;

function ensureCliExitDir(): void {
  if (!fs.existsSync(CLI_EXIT_DIR)) {
    fs.mkdirSync(CLI_EXIT_DIR, { recursive: true });
  }
}

/** Launch a new Copilot CLI session in a terminal, tracked as an agent. */
export async function launchCliSession(
  workspaceRoot: string,
): Promise<{ agentId: string; sessionId: string } | { error: string }> {
  const agentId = uuid();
  const sessionId = uuid();
  const now = new Date().toISOString();

  // Ensure signal directory exists
  ensureCliExitDir();
  const signalPath = path.join(CLI_EXIT_DIR, agentId);

  // Register in DB
  (await persistence.createAgentSessionRecord({
    id: agentId,
    session_id: sessionId,
    space_id: null,
    prompt: 'CLI Session',
    status: 'running',
    summary: 'Running in terminal...',
    working_dir: workspaceRoot,
    source: 'cli',
    persona_handle: null,
    quoted_text: null,
    run_location: 'local',
    created_at: now,
    updated_at: now,
  }));

  // Launch CLI in terminal with exit signal
  try {
    await launchSessionInTerminal(sessionId, workspaceRoot, signalPath);
  } catch (err: any) {
    (await persistence.updateSessionStatus(agentId, 'failed', err.message || 'Failed to launch CLI'));
    return { error: err.message || 'Failed to launch CLI' };
  }

  // Notify renderer
  notifier.notifyRenderer('agent:status-changed', {
    agentId, status: 'running', summary: 'Running in terminal...',
  });

  console.log(`[agent-service] Launched CLI session: agentId=${agentId}, sessionId=${sessionId}`);
  return { agentId, sessionId };
}

/** Start polling for CLI exit signal files. Call on app startup. */
export function startCliExitMonitor(): void {
  if (cliExitMonitorInterval) return;
  ensureCliExitDir();
  const revision = monitorRevision;
  const generation = getStorageGeneration();

  const poll = async () => {
    if (polling || revision !== monitorRevision) return;
    polling = true;
    try {
      const files = fs.readdirSync(CLI_EXIT_DIR);
      for (const agentId of files) {
        if (agentId.startsWith('.')) continue;
        const signalPath = path.join(CLI_EXIT_DIR, agentId);

        // Update agent status
          const session = (await persistence.getSession(agentId));
          if (revision !== monitorRevision) return;
          // A signal from another workspace is not ours to consume.
          if (!session || session.source !== 'cli') continue;
          const workspace = getConfig().workspace;
          if (workspace && session.working_dir && path.resolve(workspace) !== path.resolve(session.working_dir)) continue;
          if (session && session.status !== 'running' && session.status !== 'waiting-approval') {
            console.log(`[agent-service] Ignoring late CLI exit for stopped session: ${agentId}`);
            fs.unlinkSync(signalPath);
            continue;
          }
          (await persistence.updateSessionStatus(agentId, 'completed', 'CLI session ended'));
        if (revision !== monitorRevision) return;
        fs.unlinkSync(signalPath);

        notifier.notifyRenderer('agent:status-changed', {
          agentId, status: 'completed', summary: 'CLI session ended',
        });
        notifier.notifyRenderer('agent:completed', {
          agentId, summary: 'CLI session ended',
        });

        console.log(`[agent-service] CLI session exited: ${agentId}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[cli-runner] Exit reconciliation failed; signal retained:', error);
      }
    } finally { polling = false; }
  };
  cliExitMonitorInterval = setInterval(() => {
    try { void observeProducer(withStorageGeneration(generation, poll)); }
    catch (error) { console.error('[cli-runner] Stale exit monitor:', error); }
  }, 10_000);
}

/** Stop the CLI exit monitor. Call on app quit. */
export function stopCliExitMonitor(): void {
  monitorRevision++;
  if (cliExitMonitorInterval) {
    clearInterval(cliExitMonitorInterval);
    cliExitMonitorInterval = null;
  }
}

/** Open an existing agent session in a new terminal (CLI). */
export async function openAgentCli(agentId: string): Promise<{ error?: string }> {
  const config = getConfig();
  const workspaceRoot = config.workspace;
  if (!workspaceRoot) return { error: 'No workspace' };

  // Try live agent first, then fall back to DB
  const record = registry.get(agentId);
  let sessionId: string;
  let cwd: string;

  if (record) {
    sessionId = record.sessionId;
    cwd = workspaceRoot;
  } else {
    // Historical agent — look up from DB
    const persisted = (await persistence.getSession(agentId));
    if (!persisted) return { error: 'Agent not found' };
    sessionId = persisted.session_id;
    cwd = persisted.working_dir || workspaceRoot;
  }

  try {
    // Release Whim's in-use lock on this session before handing it to the
    // terminal CLI. Without this, the CLI sees Whim's lock (still alive in
    // this process) and warns "This session may already be in use by another
    // CLI or application." The in-memory CopilotSession is unaffected — the
    // lock is re-acquired on the next session.* RPC.
    try {
      const { getCopilotClient } = await import('../ai');
      const client = getCopilotClient();
      await client?.rpc.sessions.releaseLock({ sessionId });
    } catch (err) {
      // Non-fatal: worst case the user sees the in-use warning in the CLI.
      console.warn(`[cli-runner] Failed to release session lock for ${sessionId}:`, err);
    }

    await launchSessionInTerminal(sessionId, cwd);
    return {};
  } catch (err: any) {
    return { error: err.message || 'Failed to open CLI' };
  }
}
