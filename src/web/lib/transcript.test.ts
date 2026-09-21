import { describe, expect, it } from 'vitest';
import { applyChatEvent, applyChatEvents, historyBubbles, parseHistory, type Bubble } from './transcript';
import { acknowledgeUserMessage, mergeHistoryWithLocal } from '../../shared/chat-identity';

it('retains mobile follow-ups across snapshots and acknowledgements in either order', () => {
  const local: Bubble = { id: 'local', kind: 'user', text: 'Follow up' };
  const history: Bubble[] = [{ ...local, id: 'user:sdk' }];
  const beforeAck = mergeHistoryWithLocal(history, [local], new Set(['local']));
  expect(acknowledgeUserMessage(beforeAck, 'local', 'sdk')).toEqual(history);
  const acknowledged = acknowledgeUserMessage([local], 'local', 'sdk');
  expect(mergeHistoryWithLocal(history, acknowledged, new Set(['user:sdk']))).toEqual(history);
  expect(mergeHistoryWithLocal([], [local], new Set(['local']))).toEqual([local]);
});

it('shows incomplete-history recovery notices without assigning them a durable sequence', () => {
  const message = 'Showing saved history, which may be incomplete. Reopen this conversation to retry recovering older runtime history.';
  const [bubble] = historyBubbles([{
    id: 'history-recovery:legacy', type: 'session_event', eventType: 'info',
    message, timestamp: '2026-09-10T12:00:00Z',
  }]);
  expect(bubble).toMatchObject({
    id: 'history-recovery:legacy', kind: 'event', level: 'info', text: message,
  });
  expect(bubble.sequence).toBeUndefined();
});

describe('parseHistory', () => {
  it('builds user, assistant and tool bubbles from SDK events', () => {
    const bubbles = parseHistory([
      { type: 'user.message', data: { content: 'do it' } },
      { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'ls' } } },
      { type: 'tool.execution_complete', data: { toolCallId: 't1', result: 'ok', success: true } },
      { type: 'assistant.message', data: { content: 'done' } },
    ]);

    expect(bubbles.map((b) => b.kind)).toEqual(['user', 'tool', 'assistant']);
    const tool = bubbles.find((b) => b.kind === 'tool') as Extract<Bubble, { kind: 'tool' }>;
    expect(tool.status).toBe('done');
    expect(tool.result).toBe('ok');
  });

  it('marks failed tools as error', () => {
    const bubbles = parseHistory([
      { type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash' } },
      { type: 'tool.execution_complete', data: { toolCallId: 't1', result: 'boom', success: false } },
    ]);
    const tool = bubbles[0] as Extract<Bubble, { kind: 'tool' }>;
    expect(tool.status).toBe('error');
  });
});

describe('applyChatEvent', () => {
  it('deduplicates identified legacy snapshots and live reasoning, text and tool starts', () => {
    const history = parseHistory([
      { type: 'assistant.message', data: { messageId: 'a', content: 'Answer' } },
      { type: 'assistant.reasoning', data: { reasoningId: 'r', content: 'Reasoning' } },
      { type: 'tool.execution_start', data: { toolCallId: 't', toolName: 'view' } },
    ]);
    const merged = applyChatEvents(history, [
      { type: 'assistant.message_delta', messageId: 'a', delta: 'Answer' },
      { type: 'assistant.reasoning_delta', reasoningId: 'r', delta: 'Reasoning' },
      { type: 'tool.start', toolCallId: 't', toolName: 'view', args: {} },
    ]);
    expect(merged).toEqual(history);
  });
  it('accumulates streaming assistant deltas then finalizes', () => {
    let bubbles: Bubble[] = [];
    bubbles = applyChatEvent(bubbles, { type: 'assistant.message_delta', delta: 'Hel' });
    bubbles = applyChatEvent(bubbles, { type: 'assistant.message_delta', delta: 'lo' });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });

    bubbles = applyChatEvent(bubbles, { type: 'assistant.message', content: 'Hello world' });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ kind: 'assistant', text: 'Hello world', streaming: false });
  });

  it('adds and completes a tool bubble', () => {
    let bubbles: Bubble[] = [];
    bubbles = applyChatEvent(bubbles, { type: 'tool.start', toolCallId: 'x', toolName: 'edit', args: { path: '/a.ts' } });
    bubbles = applyChatEvent(bubbles, { type: 'tool.complete', toolCallId: 'x', result: 'r', success: true });
    const tool = bubbles[0] as Extract<Bubble, { kind: 'tool' }>;
    expect(tool.status).toBe('done');
  });

  it('appends an error event for session errors', () => {
    const bubbles = applyChatEvent([], { type: 'session.error', message: 'nope' });
    expect(bubbles[0]).toMatchObject({ kind: 'event', level: 'error', text: 'nope' });
  });

  it('replays buffered events after parsed history', () => {
    const history = parseHistory([{ type: 'assistant.message', data: { content: 'history' } }]);
    const bubbles = applyChatEvents(history, [
      { type: 'assistant.message_delta', delta: ' liv' },
      { type: 'assistant.message_delta', delta: 'e' },
      { type: 'assistant.message', content: ' live' },
    ]);

    expect(bubbles.map((b) => b.kind)).toEqual(['assistant', 'assistant']);
    expect(bubbles[1]).toMatchObject({ kind: 'assistant', text: ' live', streaming: false });
  });
});
