import type { ChatMessage } from '../../shared/chat-types';
import { orderTranscript } from '../../shared/chat-identity';

export const MAX_WINDOW_ROWS = 80;
export const ROW_GAP = 4;

/** Measured heights survive prepends; prefix sums support logarithmic viewport lookups. */
export class TranscriptLayout {
  readonly ids: string[];
  readonly positions = new Map<string, number>();
  private readonly tree: number[];
  private readonly heights: number[];

  constructor(messages: Array<{ id: string; type?: string; toolName?: string }>, measured: ReadonlyMap<string, number>) {
    this.ids = messages.map(message => message.id);
    this.heights = messages.map(message => measured.get(message.id) ??
      (message.type === 'tool_call' && message.toolName === 'ask_user' ? ROW_GAP : 100));
    this.tree = Array.from({ length: messages.length + 1 }, () => 0);
    this.ids.forEach((id, index) => {
      this.positions.set(id, index);
      const slot = index + 1;
      this.tree[slot] += this.heights[index];
      const parent = slot + (slot & -slot);
      if (parent < this.tree.length) this.tree[parent] += this.tree[slot];
    });
  }

  private add(index: number, delta: number) {
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta;
  }

  offset(index: number): number {
    let sum = 0;
    for (let i = Math.min(index, this.ids.length); i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  get total(): number { return this.offset(this.ids.length); }

  measure(id: string, height: number): boolean {
    const index = this.positions.get(id);
    if (index === undefined || !Number.isFinite(height) || height < ROW_GAP ||
      Math.abs(this.heights[index] - height) < 0.5) return false;
    this.add(index, height - this.heights[index]);
    this.heights[index] = height;
    return true;
  }

  indexAt(offset: number): number {
    let index = 0;
    let sum = 0;
    let bit = 1;
    while (bit * 2 <= this.ids.length) bit *= 2;
    for (; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && sum + this.tree[next] <= offset) {
        sum += this.tree[next];
        index = next;
      }
    }
    return Math.min(index, Math.max(0, this.ids.length - 1));
  }

  window(top: number, height: number): { start: number; end: number } {
    const first = this.indexAt(Math.max(0, top));
    const start = Math.max(0, first - 8);
    // The overscan budget must never truncate the viewport on very tall windows
    // or runs of unusually short rows.
    const end = Math.min(this.ids.length, Math.max(this.indexAt(top + height) + 1,
      Math.min(start + MAX_WINDOW_ROWS, this.indexAt(top + height + 400) + 9)));
    return { start, end };
  }
}

export function hasPendingInteraction(message: ChatMessage): boolean {
  return (message.type === 'approval' || message.type === 'user_input' ||
    message.type === 'elicitation' || message.type === 'sandbox_block') && !message.responded;
}

/** Pages are already normalized by the history owner; no transport calls live here. */
export interface ChatHistoryPaging {
  hasOlder: boolean;
  loading: boolean;
  error?: string;
  loadOlder: () => void;
}

export interface ChatHistorySource {
  hasOlder: boolean;
  /** Return normalized messages with stable IDs, oldest first. The provider owns its cursor. */
  loadOlder: () => Promise<ChatMessage[]>;
}

export function prependHistoryPage(current: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  // Live resolutions/content win over overlapping, older snapshot rows.
  const ids = new Set(current.map(message => message.id));
  const identities = new Set(current.map(messageIdentity));
  const positions = new Map(current.map((message, index) => [messageIdentity(message), index]));
  const retained = [...current];
  return orderTranscript([...older.filter(message => {
    const identity = messageIdentity(message);
    if (ids.has(message.id) || identities.has(identity)) {
      const index = positions.get(identity);
      const previous = index === undefined ? undefined : retained[index];
      if (previous && index !== undefined && (
        (hasPendingInteraction(previous) && !hasPendingInteraction(message))
        || (previous.type === 'tool_call' && !previous.completed && message.type === 'tool_call' && message.completed)
      )) retained[index] = { ...message, id: previous.id };
      return false;
    }
    ids.add(message.id);
    identities.add(identity);
    return true;
  }), ...retained]);
}

function messageIdentity(message: ChatMessage): string {
  if (message.type === 'tool_call') return `tool:${message.toolCallId}`;
  if (message.type === 'reasoning' && message.reasoningId) return `reasoning:${message.reasoningId}`;
  if ('requestId' in message) return `${message.type}:${message.requestId}`;
  return `id:${message.id}`;
}
