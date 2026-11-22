import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AhpHost, CopilotClient } from '@microsoft/copilot-sdk';
import { getConfigValue, setConfigValue } from './config';

/**
 * Whim's Agent Host Protocol (AHP) host: lets the Copilot CLI attach to a
 * session that runs in Whim's in-process runtime, instead of opening the same
 * session a second time from its own process.
 *
 * The host is started lazily on the primary client, admits only the GitHub
 * account Whim is signed in with, serves the workspace (publication requires a
 * session's folder to be inside it), and never lets attached clients create
 * sessions. It belongs to its client: stopping the client also stops the host.
 */

interface HostEntry {
  client: CopilotClient;
  workspace: string;
  host: AhpHost;
}

let current: HostEntry | null = null;
let starting: Promise<HostEntry> | null = null;
/** Bumped by every dispose, so a host still starting at that moment is never kept. */
let generation = 0;

/**
 * Whim's own catalog identity. A catalog admits one host at a time, so sharing
 * the default identity would collide with a host the user starts from the CLI.
 */
function ahpComputeId(): string {
  let id = getConfigValue('ahpComputeId');
  if (!id) {
    id = `whim-${randomUUID()}`;
    setConfigValue('ahpComputeId', id);
  }
  return id;
}

function sameWorkspace(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

async function stopHost(): Promise<void> {
  const entry = current;
  current = null;
  if (!entry) return;
  try {
    await entry.host.dispose();
  } catch (err) {
    console.warn('[ahp] Failed to stop host:', err);
  }
}

async function startHost(client: CopilotClient, workspace: string): Promise<HostEntry> {
  const startedIn = generation;
  await stopHost();
  let entry: HostEntry | null = null;
  const host = await client.startAhpHost({
    localServer: {},
    authentication: { mode: 'github' },
    computeId: ahpComputeId(),
    workspace,
    allowCreatingNewSessions: false,
    // Also reported for a start that fails, before `entry` exists, so match
    // the exiting host rather than clearing whichever one is current.
    onExit: (exit) => {
      if (entry && current === entry) {
        current = null;
        console.warn(`[ahp] Host exited (${exit.reason})${exit.error ? `: ${exit.error}` : ''}`);
      }
    },
  });
  if (startedIn !== generation) {
    // Disposed while starting, for example because the account changed: this
    // host admits the previous account, so stop it rather than keep it.
    await host.dispose().catch(() => {});
    throw new Error('The session host was stopped while it was starting. Try again.');
  }
  entry = { client, workspace, host };
  current = entry;
  console.log(`[ahp] Host started at ${host.url}`);
  return entry;
}

/** The running host for this client and workspace, starting or replacing it as needed. */
export async function ensureAhpHost(client: CopilotClient, workspace: string): Promise<AhpHost> {
  while (starting) {
    try { await starting; } catch { /* the next attempt reports its own failure */ }
  }
  if (current && current.client === client && sameWorkspace(current.workspace, workspace)) {
    return current.host;
  }
  starting = startHost(client, workspace);
  try {
    return (await starting).host;
  } finally {
    starting = null;
  }
}

/**
 * Stop the host. Attached CLIs disconnect; the sessions themselves keep
 * running in Whim. Called on shutdown and whenever the signed-in account
 * changes, since the host admits only the account it started with. A host
 * still starting is stopped as soon as its start completes.
 */
export async function disposeAhpHost(): Promise<void> {
  generation++;
  await stopHost();
}

/** Copilot CLI arguments that attach to `sessionId` on `host`. */
export function ahpAttachArgs(host: Pick<AhpHost, 'url' | 'token'>, sessionId: string): string[] {
  if (!host.url) throw new Error('The session host has no local address.');
  const url = host.token ? `${host.url}?tkn=${encodeURIComponent(host.token)}` : host.url;
  return ['--ahp', url, '--ahp-authenticate', 'github', `--resume=${sessionId}`];
}

/**
 * Publish a live session owned by `client` and return the CLI arguments that
 * attach to it. Publishing is idempotent, so reopening a session is safe.
 */
export async function publishSessionForCli(client: CopilotClient, workspace: string, sessionId: string): Promise<string[]> {
  const host = await ensureAhpHost(client, workspace);
  await host.publishSession(sessionId);
  return ahpAttachArgs(host, sessionId);
}
