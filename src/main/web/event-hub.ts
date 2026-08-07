import { EventEmitter } from 'events';

export interface WebRemoteEvent {
  channel: string;
  payload: unknown;
  timestamp: string;
  /**
   * The renderer channel and arguments exactly as the main process emitted
   * them.
   *
   * `channel`/`payload` above are a normalized, flattened view built for the
   * lightweight web client. The full renderer expects the original Electron
   * shape — `chat:event:<agentId>` rather than `chat:event`, and every
   * argument rather than the first — so it replays this instead.
   */
  source: { channel: string; args: unknown[] };
  /**
   * Monotonic, process-lifetime sequence number. A reconnecting client sends
   * the last one it saw and the server replays the gap, so events that occur
   * while a phone is backgrounded aren't silently lost.
   */
  seq: number;
}

/**
 * Replay window. Sized to cover a typical mobile background/lock cycle
 * without unbounded growth; a client that falls further behind is told to
 * resync from scratch rather than being given a partial history.
 */
const REPLAY_BUFFER_SIZE = 500;

const replayBuffer: WebRemoteEvent[] = [];
let sequence = 0;

/**
 * Renderer events the web remote is allowed to see.
 *
 * Everything here describes app state that is equally true in a browser. The
 * companion set below holds channels that drive desktop window plumbing and
 * would be meaningless — or actively wrong — to replay to a remote client.
 * `event-hub.test.ts` asserts every channel the API surface subscribes to
 * appears in exactly one of the two, so adding an event forces a decision
 * rather than silently defaulting to invisible.
 */
const ALLOWED_EVENT_CHANNELS = new Set([
  'chat:event',
  'subagent:changed',
  'agent:remote-changed',
  'agent:yolo-changed',
  'app:remote-changed',
  'hotkeys:changed',
  'profiles:changed',
  'skills:changed',
  'space:recall',
  'space:recurrence',
  'workspace:changed',
  'agent:status-changed',
  'agent:completed',
  'agent:approval-needed',
  'agent:approval-resolved',
  'agent:user-input-requested',
  'agent:user-input-resolved',
  'agent:elicitation-requested',
  'agent:elicitation-resolved',
  'agent:sandbox-blocked',
  'agent:sandbox-resolved',
  'agent:presence-started',
  'agent:presence-ended',
  'agent:reply-ready',
  'space:processed',
  'space:title-updated',
  'space:recurrence-applied',
  'canvas:content-updated',
  // Says a report exists, and carries only ids and a title. Opening one is
  // desktop-only, but a remote client still needs this to refresh its list.
  'canvas-artifact:published',
  'workspace:committed',
  'workspace:git-sync-changed',
]);

/**
 * Events that exist to move desktop windows around. A browser tab has no
 * always-on-top panel to pin, no canvas window to close, and no OS
 * notification of ours to have been clicked.
 */
export const DESKTOP_ONLY_EVENT_CHANNELS = new Set([
  'canvas-window:closed',
  'canvas-window:load-target',
  'canvas-window:request-hide',
  'canvas-window:theme-changed',
  'main-window:open-agent-chat',
  'main-window:open-persona-sandbox-editor',
  'notification:approval-clicked',
  'settings-window:refresh',
  'window:pinned-changed',
  'window:request-hide',
  'window:shown',
  'window:toggle',
  // Auto-update state describes the *desktop install*. A browser cannot act on
  // it, and showing "restart to update" to a remote client would be a lie.
  'update:state-changed',
]);

const hub = new EventEmitter();
// One listener is registered per connected socket, and the default cap of 10
// would otherwise emit a spurious MaxListenersExceededWarning.
hub.setMaxListeners(0);

function normalizeEvent(channel: string, args: unknown[]): WebRemoteEvent | null {
  if (channel.startsWith('chat:event:')) {
    const agentId = channel.slice('chat:event:'.length);
    const data = args[0];
    const payload = data && typeof data === 'object'
      ? { agentId, ...(data as Record<string, unknown>) }
      : { agentId, data };
    return { channel: 'chat:event', payload, timestamp: new Date().toISOString(), seq: 0, source: { channel, args } };
  }

  if (channel.startsWith('subagent:changed:')) {
    return {
      channel: 'subagent:changed',
      payload: { parentAgentId: channel.slice('subagent:changed:'.length) },
      timestamp: new Date().toISOString(),
      seq: 0,
      source: { channel, args },
    };
  }

  if (!ALLOWED_EVENT_CHANNELS.has(channel)) return null;

  if (channel === 'space:processed' || channel === 'space:recurrence-applied') {
    return {
      channel,
      payload: { spaceId: args[0] },
      timestamp: new Date().toISOString(),
      seq: 0,
      source: { channel, args },
    };
  }

  return {
    channel,
    payload: args.length <= 1 ? args[0] ?? null : args,
    timestamp: new Date().toISOString(),
    seq: 0,
    source: { channel, args },
  };
}

export function mirrorRendererEvent(channel: string, ...args: unknown[]): void {
  const normalized = normalizeEvent(channel, args);
  if (!normalized) return;

  const event: WebRemoteEvent = { ...normalized, seq: ++sequence };
  replayBuffer.push(event);
  if (replayBuffer.length > REPLAY_BUFFER_SIZE) replayBuffer.shift();

  hub.emit('event', event);
}

export function currentEventSequence(): number {
  return sequence;
}

export type ReplayResult =
  | { kind: 'events'; events: WebRemoteEvent[] }
  /** The gap is larger than the buffer; the client must do a full refresh. */
  | { kind: 'resync-required' };

export function replayEventsSince(lastSeq: number): ReplayResult {
  // lastSeq <= 0 means the client has no state to patch — it has to load
  // fresh regardless of what happens to still be in the buffer.
  if (!Number.isFinite(lastSeq) || lastSeq <= 0 || lastSeq > sequence) {
    return { kind: 'resync-required' };
  }
  if (lastSeq === sequence) return { kind: 'events', events: [] };

  const oldestBuffered = replayBuffer[0]?.seq;
  // `lastSeq + 1` is the first event the client still needs; if that already
  // fell out of the buffer we cannot honestly claim to have replayed the gap.
  if (oldestBuffered === undefined || oldestBuffered > lastSeq + 1) {
    return { kind: 'resync-required' };
  }

  return { kind: 'events', events: replayBuffer.filter((event) => event.seq > lastSeq) };
}

/** Test seam: drop replay state. */
export function resetWebRemoteEventState(): void {
  replayBuffer.length = 0;
  sequence = 0;
}

export function subscribeWebRemoteEvents(callback: (event: WebRemoteEvent) => void): () => void {
  hub.on('event', callback);
  return () => hub.off('event', callback);
}

export function isWebRemoteEventAllowed(channel: string): boolean {
  return (
    channel.startsWith('chat:event:') ||
    channel.startsWith('subagent:changed:') ||
    ALLOWED_EVENT_CHANNELS.has(channel)
  );
}

/** Exposed for the exhaustiveness test that guards against silent drift. */
export function mirroredEventChannels(): Set<string> {
  return new Set(ALLOWED_EVENT_CHANNELS);
}
