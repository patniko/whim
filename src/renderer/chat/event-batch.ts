import type { ChatEvent, ChatMessage } from '../../shared/chat-types';

type Delta = Extract<ChatEvent, { type: 'assistant.message_delta' | 'assistant.reasoning_delta' | 'tool.progress' }>;

function streamKey(event: Delta): string {
  if (event.type === 'assistant.reasoning_delta') return `reasoning:${event.reasoningId}`;
  if (event.type === 'tool.progress') return `tool:${event.toolCallId}`;
  return `assistant:${event.messageId ?? ''}`;
}

function isDelta(event: ChatEvent): event is Delta {
  return event.type === 'assistant.message_delta' ||
    event.type === 'assistant.reasoning_delta' || event.type === 'tool.progress';
}

/** At most one delta delivery per frame; terminal/control events are never delayed. */
export function createEventBatch(deliver: (event: ChatEvent) => void) {
  let pending: Array<{ event: Delta; chunks: string[] }> = [];
  const streams = new Map<string, { event: Delta; chunks: string[] }>();
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = undefined;
    timer = undefined;
    const batch = pending;
    pending = [];
    streams.clear();
    if (!disposed) {
      for (const { event, chunks } of batch) {
        const text = chunks.join('');
        deliver(event.type === 'tool.progress' ? { ...event, message: text } : { ...event, delta: text });
      }
    }
  };
  return {
    push(event: ChatEvent) {
      if (disposed) return;
      if (!isDelta(event)) {
        flush();
        deliver(event);
        return;
      }
      const key = streamKey(event);
      let tail = streams.get(key);
      if (!tail) {
        tail = { event, chunks: [] };
        pending.push(tail);
        streams.set(key, tail);
      }
      tail.chunks.push(event.type === 'tool.progress' ? event.message : event.delta);
      if (frame === undefined) {
        frame = requestAnimationFrame(flush);
        // Hidden windows may suspend animation frames.
        timer = setTimeout(flush, 100);
      }
    },
    flush,
    dispose() {
      disposed = true;
      flush();
    },
  };
}

export function finalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message =>
    (message.type === 'assistant' || message.type === 'reasoning') && message.isStreaming
      ? { ...message, isStreaming: false }
      : message,
  );
}

/** Pure updater: no streaming IDs are mutated inside React state updaters. */
export function applyStreamEvent(
  messages: ChatMessage[], event: ChatEvent, id: string, timestamp: string,
): ChatMessage[] {
  if (event.type === 'session.idle' || event.type === 'session.error') return finalizeMessages(messages);
  if (event.type === 'tool.progress') {
    return messages.map(message => message.type === 'tool_call' &&
      message.toolCallId === event.toolCallId && !message.completed
      ? { ...message, result: (message.result || '') + event.message } : message);
  }
  if (event.type === 'assistant.message_delta' || event.type === 'assistant.message') {
    const stableId = event.messageId ? `assistant:${event.messageId}` : undefined;
    let index = stableId ? messages.findIndex(message => message.id === stableId) : messages.length - 1;
    if (!stableId) {
      while (index >= 0) {
        const message = messages[index];
        if (message.type === 'assistant' && message.isStreaming) break;
        index--;
      }
    }
    const streaming = event.type === 'assistant.message_delta';
    if (streaming && stableId && index >= 0 && messages[index].type === 'assistant'
      && !(messages[index] as import('../../shared/chat-types').AssistantMessage).isStreaming) return messages;
    if (index === -1) {
      return [...messages, {
        id: stableId ?? id, type: 'assistant', content: streaming ? event.delta : event.content,
        isStreaming: streaming, timestamp,
      }];
    }
    return messages.map((message, i) => i === index && message.type === 'assistant'
      ? { ...message, content: streaming ? message.content + event.delta : event.content || message.content,
          isStreaming: streaming }
      : message);
  }
  if (event.type === 'assistant.reasoning_delta' || event.type === 'assistant.reasoning') {
    const index = messages.findIndex(message =>
      message.type === 'reasoning' && message.reasoningId === event.reasoningId);
    const streaming = event.type === 'assistant.reasoning_delta';
    if (streaming && index >= 0 && messages[index].type === 'reasoning'
      && !(messages[index] as import('../../shared/chat-types').ReasoningMessage).isStreaming) return messages;
    if (index === -1) {
      return [...messages, {
        id, type: 'reasoning', reasoningId: event.reasoningId,
        content: streaming ? event.delta : event.content, isStreaming: streaming, timestamp,
      }];
    }
    return messages.map((message, i) => i === index && message.type === 'reasoning'
      ? { ...message, content: streaming ? message.content + event.delta : event.content || message.content,
          isStreaming: streaming }
      : message);
  }
  return messages;
}
