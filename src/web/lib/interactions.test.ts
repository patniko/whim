import { describe, expect, it } from 'vitest';
import { applyInteractionEvent, pruneInteractions, type InteractionMap } from './interactions';

describe('applyInteractionEvent', () => {
  it('records a user-input question', () => {
    const map = applyInteractionEvent({}, 'agent:user-input-requested', {
      agentId: 'a1', requestId: 'r1', question: 'Which branch?', choices: ['main', 'dev'],
    });
    expect(map.a1).toEqual([
      { kind: 'user-input', agentId: 'a1', requestId: 'r1', question: 'Which branch?', choices: ['main', 'dev'], allowFreeform: true },
    ]);
  });

  it('honours allowFreeform: false', () => {
    const map = applyInteractionEvent({}, 'agent:user-input-requested', {
      agentId: 'a1', requestId: 'r1', question: 'Pick', allowFreeform: false,
    });
    expect(map.a1[0]).toMatchObject({ allowFreeform: false, choices: [] });
  });

  it('records a sandbox block with its allowed decisions', () => {
    const map = applyInteractionEvent({}, 'agent:sandbox-blocked', {
      agentId: 'a1', requestId: 'r1', source: 'permission', kind: 'shell',
      target: 'rm -rf /tmp/x', toolName: 'Bash', allowedDecisions: ['allow-once', 'disable'],
    });
    expect(map.a1[0]).toMatchObject({ kind: 'sandbox', target: 'rm -rf /tmp/x', toolName: 'Bash', decisions: ['allow-once', 'disable'] });
  });

  it('defaults sandbox decisions when the event omits them', () => {
    const map = applyInteractionEvent({}, 'agent:sandbox-blocked', {
      agentId: 'a1', requestId: 'r1', source: 'permission', kind: 'shell', target: 'ls',
    });
    expect((map.a1[0] as { decisions: string[] }).decisions).toEqual(['allow-once', 'allow-for-session']);
  });

  it('removes an interaction when it resolves', () => {
    let map = applyInteractionEvent({}, 'agent:user-input-requested', { agentId: 'a1', requestId: 'r1', question: 'q' });
    map = applyInteractionEvent(map, 'agent:user-input-resolved', { agentId: 'a1', requestId: 'r1' });
    expect(map.a1).toBeUndefined();
  });

  it('keeps sibling interactions when one resolves', () => {
    let map = applyInteractionEvent({}, 'agent:user-input-requested', { agentId: 'a1', requestId: 'r1', question: 'q' });
    map = applyInteractionEvent(map, 'agent:elicitation-requested', { agentId: 'a1', requestId: 'r2', message: 'm' });
    map = applyInteractionEvent(map, 'agent:user-input-resolved', { agentId: 'a1', requestId: 'r1' });
    expect(map.a1).toHaveLength(1);
    expect(map.a1[0].requestId).toBe('r2');
  });

  it('is idempotent — a redelivered request does not duplicate', () => {
    const payload = { agentId: 'a1', requestId: 'r1', question: 'q' };
    const first = applyInteractionEvent({}, 'agent:user-input-requested', payload);
    const second = applyInteractionEvent(first, 'agent:user-input-requested', payload);
    expect(second).toBe(first);
  });

  it('returns the same reference for unrelated channels', () => {
    const map: InteractionMap = {};
    expect(applyInteractionEvent(map, 'agent:status-changed', {})).toBe(map);
  });
});

describe('pruneInteractions', () => {
  it('drops interactions for agents that no longer exist', () => {
    const map = applyInteractionEvent({}, 'agent:user-input-requested', { agentId: 'gone', requestId: 'r1', question: 'q' });
    expect(pruneInteractions(map, new Set(['other']))).toEqual({});
  });

  it('returns the same reference when nothing is stale', () => {
    const map = applyInteractionEvent({}, 'agent:user-input-requested', { agentId: 'a1', requestId: 'r1', question: 'q' });
    expect(pruneInteractions(map, new Set(['a1']))).toBe(map);
  });
});
