import { EventEmitter } from 'events';

export interface WebRemoteEvent {
  channel: string;
  payload: unknown;
  timestamp: string;
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

const ALLOWED_EVENT_CHANNELS = new Set([
  'chat:event',
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
  'workspace:committed',
  'workspace:git-sync-changed',
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
    return { channel: 'chat:event', payload, timestamp: new Date().toISOString(), seq: 0 };
  }

  if (!ALLOWED_EVENT_CHANNELS.has(channel)) return null;

  if (channel === 'space:processed' || channel === 'space:recurrence-applied') {
    return {
      channel,
      payload: { spaceId: args[0] },
      timestamp: new Date().toISOString(),
      seq: 0,
    };
  }

  return {
    channel,
    payload: args.length <= 1 ? args[0] ?? null : args,
    timestamp: new Date().toISOString(),
    seq: 0,
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
  return channel.startsWith('chat:event:') || ALLOWED_EVENT_CHANNELS.has(channel);
}
