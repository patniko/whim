// @vitest-environment happy-dom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatMessage } from '../../shared/chat-types';
import { ChatView, parseHistoryEvents, replayBufferedEvents } from './ChatView';

const captured = vi.hoisted(() => ({ messages: [] as ChatMessage[], busy: false }));
vi.mock('./MessageList', () => ({
  MessageList: ({ messages }: { messages: ChatMessage[] }) => { captured.messages = messages; return null; },
}));
vi.mock('./PromptBar', () => ({
  PromptBar: ({ isBusy, onAbort, onSend }: { isBusy: boolean; onAbort: () => void; onSend: (message: string) => void }) => {
    captured.busy = isBusy;
    return <><button onClick={onAbort}>Stop synthetic agent</button>
      <button onClick={() => onSend('queued synthetic follow-up')}>Queue synthetic follow-up</button></>;
  },
}));
vi.mock('./tiles/WorkingIndicator', () => ({ WorkingIndicator: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
type History = { events?: unknown[]; error?: string };
let root: Root;
let host: HTMLDivElement;
let history: Map<string, ReturnType<typeof deferred<History>>>;
let listeners: Map<string, (event: ChatEvent) => void>;
let frames: Map<number, FrameRequestCallback>;
let agents: ReturnType<typeof deferred<Array<{ agentId: string; status: string }>>>;

beforeEach(() => {
  captured.messages = [];
  captured.busy = false;
  history = new Map([['a', deferred<History>()], ['b', deferred<History>()]]);
  listeners = new Map();
  frames = new Map();
  agents = deferred();
  let next = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('whimAPI', {
    getAgentHistory: (agentId: string) => history.get(agentId)!.promise,
    onChatEvent: (agentId: string, callback: (event: ChatEvent) => void) => {
      listeners.set(agentId, callback);
      return () => listeners.delete(agentId);
    },
    listModels: async () => [],
    getSetting: async () => null,
    onWorkspaceChanged: () => () => {},
    onAgentYoloChanged: () => () => {},
    onAgentRemoteChanged: () => () => {},
    listAllAgents: () => agents.promise,
    abortAgent: async () => {},
    sendChatMessage: async () => ({}),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = async (agentId: string) => {
  await act(async () => root.render(<StrictMode>
    <ChatView agentId={agentId} agentPrompt={`prompt ${agentId}`} agentStatus="running"
      onClose={() => {}} onOpenCli={() => {}} />
  </StrictMode>));
};
const emit = (agentId: string, event: ChatEvent) => act(() => listeners.get(agentId)!(event));

describe('chat event/history races', () => {
  it('uses normalized backend pages and drops overlapping identified snapshot/live text', async () => {
    const page = deferred<import('../../shared/paging').ChatHistoryPage>();
    const api = (globalThis as unknown as { whimAPI: Record<string, unknown> }).whimAPI;
    api.getAgentHistoryPage = vi.fn(() => page.promise);
    const legacy = vi.fn();
    api.getAgentHistory = legacy;
    api.getAgent = vi.fn(async () => ({ status: 'running' }));
    await render('a');
    emit('a', { type: 'assistant.message_delta', messageId: 'message', eventId: 'delta-1', delta: 'snapshot text' });
    emit('a', { type: 'assistant.message', messageId: 'message', sequence: 5, content: 'snapshot text' });
    await act(async () => page.resolve({
      items: [{ id: 'assistant:message', type: 'assistant', content: 'snapshot text', isStreaming: false, timestamp: 't' }],
      total: 1000, watermark: 5, nextCursor: 'older',
    }));
    emit('a', { type: 'assistant.message', messageId: 'message', sequence: 5, content: 'snapshot text' });
    expect(legacy).not.toHaveBeenCalled();
    expect(captured.messages.filter(message => message.type === 'assistant')).toEqual([
      { id: 'assistant:message', type: 'assistant', content: 'snapshot text', isStreaming: false, timestamp: 't' },
    ]);
  });

  it('retains history-load deltas, then replaces the same streaming row with final content', async () => {
    await render('a');
    emit('a', { type: 'assistant.message_delta', delta: 'par' });
    emit('a', { type: 'assistant.message_delta', delta: 'tial' });
    await act(async () => history.get('a')!.resolve({ events: [] }));
    const streaming = captured.messages.find(message => message.type === 'assistant')!;
    expect(streaming).toMatchObject({ content: 'partial', isStreaming: true });
    emit('a', { type: 'assistant.message', content: 'partial final' });
    expect(captured.messages.filter(message => message.type === 'assistant')).toEqual([
      { ...streaming, content: 'partial final', isStreaming: false },
    ]);
  });

  it('flushes delta/final/error in one React turn without duplicated or lost chunks', async () => {
    await render('a');
    await act(async () => history.get('a')!.resolve({ events: [] }));
    act(() => {
      const event = listeners.get('a')!;
      event({ type: 'assistant.message_delta', delta: 'first ' });
      event({ type: 'assistant.message_delta', delta: 'answer' });
      event({ type: 'assistant.message', content: 'first answer' });
      event({ type: 'assistant.message_delta', delta: 'second answer' });
      event({ type: 'session.error', message: 'Synthetic failure' });
    });
    expect(captured.messages.filter(message => message.type === 'assistant').map(message => message.content))
      .toEqual(['first answer', 'second answer']);
    expect(captured.messages.filter(message => message.type === 'assistant').every(message => !message.isStreaming)).toBe(true);
    expect(captured.busy).toBe(false);
    await act(async () => agents.resolve([{ agentId: 'a', status: 'running' }]));
    expect(captured.busy).toBe(false);
  });

  it('replays controls and partial output on failed history and finalizes a buffered idle event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await render('a');
    emit('a', { type: 'assistant.message_delta', delta: 'preserved' });
    emit('a', { type: 'approval.needed', agentId: 'a', requestId: 'r', permissionKind: 'read' });
    emit('a', { type: 'approval.resolved', requestId: 'r', approved: false });
    emit('a', { type: 'session.idle' });
    await act(async () => history.get('a')!.reject(new Error('Synthetic history failure')));
    expect(captured.messages.find(message => message.type === 'assistant')).toMatchObject({
      content: 'preserved', isStreaming: false,
    });
    expect(captured.messages.find(message => message.type === 'approval')).toMatchObject({
      responded: true, approved: false,
    });
    expect(captured.busy).toBe(false);
    expect(captured.messages[captured.messages.length - 1]).toMatchObject({ type: 'session_event', eventType: 'completed' });
  });

  it('cancels stale frames, history replies, status replies and callbacks on agent switches', async () => {
    await render('a');
    const stale = listeners.get('a')!;
    emit('a', { type: 'assistant.message_delta', delta: 'stale pending output' });
    const staleFrame = [...frames.values()][0];
    await render('b');
    act(() => {
      staleFrame(16);
      stale({ type: 'assistant.message', content: 'stale final' });
    });
    await act(async () => history.get('a')!.resolve({
      events: [{ type: 'assistant.message', data: { content: 'stale history' } }],
    }));
    await act(async () => history.get('b')!.resolve({ events: [] }));
    emit('b', { type: 'assistant.message', content: 'current' });
    expect(captured.messages.filter(message => message.type === 'assistant').map(message => message.content)).toEqual(['current']);
    expect(listeners.has('a')).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('flushes pending output before aborting', async () => {
    await render('a');
    await act(async () => history.get('a')!.resolve({ events: [] }));
    emit('a', { type: 'assistant.message_delta', delta: 'before abort' });
    act(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Stop synthetic agent')!.click());
    expect(captured.messages.find(message => message.type === 'assistant')).toMatchObject({
      content: 'before abort', isStreaming: false,
    });
    expect(captured.messages[captured.messages.length - 1]).toMatchObject({ message: 'Stopped by user' });
    expect(captured.busy).toBe(false);
  });

  it('preserves and finalizes buffered output when stopped before history returns', async () => {
    await render('a');
    emit('a', { type: 'assistant.message_delta', delta: 'before abort' });
    act(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Stop synthetic agent')!.click());
    emit('a', { type: 'session.idle' });
    await act(async () => history.get('a')!.resolve({ events: [] }));
    expect(captured.messages.find(message => message.type === 'assistant')).toMatchObject({
      content: 'before abort', isStreaming: false,
    });
    expect(captured.messages.filter(message => message.type === 'session_event')).toHaveLength(1);
    expect(captured.messages[captured.messages.length - 1]).toMatchObject({ message: 'Stopped by user' });
    expect(captured.busy).toBe(false);
  });

  it('does not erase a queued follow-up when a history snapshot replaces the seed', async () => {
    await render('a');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Queue synthetic follow-up')!.click());
    await act(async () => history.get('a')!.resolve({ events: [
      { type: 'user.message', data: { content: 'prompt a' } },
      { type: 'assistant.message', data: { content: 'older answer' } },
    ] }));
    expect(captured.messages.filter(message => message.type === 'user').map(message => message.content))
      .toEqual(['prompt a', 'queued synthetic follow-up']);
  });
});

describe('history normalization seam', () => {
  it('uses persistent SDK event IDs for overlapping pages', () => {
    const events = [{ id: 'persistent', type: 'assistant.message', data: { content: 'synthetic' }, timestamp: 'now' }];
    expect(parseHistoryEvents(events)).toEqual(parseHistoryEvents(events));
    expect(parseHistoryEvents(events)[0].id).toBe('history:persistent');
  });

  it('deduplicates request/tool IDs while retaining completion and subagent events', () => {
    const events: ChatEvent[] = [
      { type: 'tool.start', toolCallId: 't', toolName: 'read', args: {} },
      { type: 'tool.start', toolCallId: 't', toolName: 'read', args: {} },
      { type: 'tool.complete', toolCallId: 't', result: 'done', success: true },
      { type: 'tool.start', toolCallId: 'sub', toolName: 'task', args: {} },
      { type: 'subagent.started', toolCallId: 'sub', name: 'task', displayName: 'Task', description: 'synthetic' },
      { type: 'subagent.completed', toolCallId: 'sub', name: 'task', agentId: 'child' },
      { type: 'user_input.requested', requestId: 'input', agentId: 'a', question: 'synthetic' },
      { type: 'user_input.resolved', requestId: 'input', answer: 'answer', wasFreeform: true },
    ];
    const messages = replayBufferedEvents([], events);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ completed: true, result: 'done' });
    expect(messages[1]).toMatchObject({ completed: true, toolName: '__subagent__', args: { agentId: 'child' } });
    expect(messages[2]).toMatchObject({ responded: true, answer: 'answer' });
  });
});
