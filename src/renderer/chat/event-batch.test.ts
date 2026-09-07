// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatMessage } from '../../shared/chat-types';
import { applyStreamEvent, createEventBatch } from './event-batch';

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('chat delta batching', () => {
  it('coalesces 10,000 chunks once per frame and never loses a chunk', () => {
    const delivered: ChatEvent[] = [];
    const batch = createEventBatch(event => delivered.push(event));
    for (let i = 0; i < 10_000; i++) batch.push({ type: 'assistant.message_delta', delta: String(i) + ',' });
    expect(delivered).toHaveLength(0);
    expect(frames.size).toBe(1);
    [...frames.values()][0](16);
    expect(delivered).toEqual([{ type: 'assistant.message_delta',
      delta: Array.from({ length: 10_000 }, (_, i) => String(i) + ',').join('') }]);
    vi.advanceTimersByTime(100);
    expect(delivered).toHaveLength(1);
    batch.dispose();
  });

  it('retains interleaved stream order and immediately flushes terminal events', () => {
    const delivered: ChatEvent[] = [];
    const batch = createEventBatch(event => delivered.push(event));
    const events: ChatEvent[] = [
      { type: 'assistant.message_delta', delta: 'a' },
      { type: 'assistant.reasoning_delta', reasoningId: 'r', delta: 'b' },
      { type: 'assistant.message_delta', delta: 'c' },
      { type: 'tool.progress', toolCallId: 't', message: 'd' },
      { type: 'session.error', message: 'synthetic error' },
    ];
    events.slice(0, -1).forEach(batch.push);
    expect(delivered).toHaveLength(0);
    batch.push(events[4]);
    expect(delivered).toEqual([
      { type: 'assistant.message_delta', delta: 'ac' },
      events[1], events[3], events[4],
    ]);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(200);
    expect(delivered).toHaveLength(4);
  });

  it('flushes in hidden windows and drops pending callbacks after agent disposal', () => {
    const delivered: ChatEvent[] = [];
    const batch = createEventBatch(event => delivered.push(event));
    batch.push({ type: 'assistant.message_delta', delta: 'visible' });
    vi.advanceTimersByTime(100);
    expect(delivered).toHaveLength(1);
    batch.push({ type: 'assistant.message_delta', delta: 'stale' });
    const stale = [...frames.values()][0];
    batch.dispose();
    stale(16);
    batch.push({ type: 'session.idle' });
    expect(delivered).toHaveLength(1);
  });
});

describe('pure stream reduction', () => {
  const apply = (messages: ChatMessage[], event: ChatEvent, id = 'new') =>
    applyStreamEvent(messages, event, id, '2026-01-01T00:00:00Z');

  it('finalizes the same row even when React defers/repeats state updaters', () => {
    const delta: ChatEvent = { type: 'assistant.message_delta', delta: 'par' };
    const first = apply([], delta, 'a');
    expect(apply([], delta, 'a')).toEqual(first);
    const next = apply(first, { type: 'assistant.message_delta', delta: 'tial' });
    const final = apply(next, { type: 'assistant.message', content: 'partial final' });
    expect(final).toEqual([{ ...first[0], content: 'partial final', isStreaming: false }]);
    expect(first[0]).toMatchObject({ content: 'par', isStreaming: true });
    const repeated = apply(final, { type: 'assistant.message', content: 'partial final' }, 'b');
    expect(repeated).toHaveLength(2); // Equal text in distinct turns is not a duplicate ID.
  });

  it('handles interleaved reasoning IDs and full reasoning without a delta', () => {
    let messages = apply([], { type: 'assistant.reasoning_delta', reasoningId: 'r1', delta: 'a' }, '1');
    messages = apply(messages, { type: 'assistant.reasoning_delta', reasoningId: 'r2', delta: 'b' }, '2');
    messages = apply(messages, { type: 'assistant.reasoning_delta', reasoningId: 'r1', delta: 'c' });
    messages = apply(messages, { type: 'assistant.reasoning', reasoningId: 'r1', content: 'complete' });
    messages = apply(messages, { type: 'assistant.reasoning', reasoningId: 'r3', content: 'full' }, '3');
    expect(messages.map(message => 'content' in message && message.content)).toEqual(['complete', 'b', 'full']);
    expect(messages).toHaveLength(3);
    messages = apply(messages, { type: 'session.error', message: 'error' });
    expect(messages.every(message => !('isStreaming' in message) || !message.isStreaming)).toBe(true);
  });

  it('preserves completed row identity and treats tool completion as authoritative', () => {
    const previous: ChatMessage[] = [
      { id: 'done', type: 'assistant', content: 'old', isStreaming: false, timestamp: '' },
      { id: 'tool', type: 'tool_call', toolCallId: 't', toolName: 'tool', args: {},
        completed: true, result: 'final', timestamp: '' },
    ];
    expect(apply(previous, { type: 'assistant.message_delta', delta: 'new' })[0]).toBe(previous[0]);
    expect(apply(previous, { type: 'tool.progress', toolCallId: 't', message: 'late' })[1]).toBe(previous[1]);
  });

  it('continues the same answer when a follow-up is queued during streaming', () => {
    let previous = apply([], { type: 'assistant.message_delta', delta: 'initial' }, 'answer');
    previous = [...previous,
      { id: 'queued', type: 'user', content: 'follow-up', timestamp: '' },
      { id: 'notice', type: 'session_event', eventType: 'info', message: 'Sandbox disabled', timestamp: '' },
    ];
    const next = apply(previous, { type: 'assistant.message_delta', delta: ' continuation' });
    expect(next).toHaveLength(3);
    expect(next[0]).toMatchObject({ id: 'answer', content: 'initial continuation' });
    expect(apply(next, { type: 'assistant.message', content: 'final' })[0]).toMatchObject({
      id: 'answer', content: 'final', isStreaming: false,
    });
  });
});
