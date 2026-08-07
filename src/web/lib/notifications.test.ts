import { describe, expect, it } from 'vitest';
import { describeNotifiableEvent } from './notifications';

describe('describeNotifiableEvent', () => {
  it('describes an approval with its intention when present', () => {
    const alert = describeNotifiableEvent('agent:approval-needed', {
      agentId: 'a1', requestId: 'r1', permissionKind: 'shell', intention: 'Delete build output',
    });
    expect(alert).toEqual({ title: 'Approval needed', body: 'Delete build output', tag: 'approval:a1:r1' });
  });

  it('falls back to the permission kind when there is no intention', () => {
    const alert = describeNotifiableEvent('agent:approval-needed', {
      agentId: 'a1', requestId: 'r1', permissionKind: 'write a file',
    });
    expect(alert?.body).toBe('An agent wants to write a file.');
  });

  it('describes a user-input question', () => {
    const alert = describeNotifiableEvent('agent:user-input-requested', {
      agentId: 'a1', requestId: 'r1', question: 'Which branch?',
    });
    expect(alert).toMatchObject({ title: 'Agent has a question', body: 'Which branch?' });
  });

  it('describes a sandbox block', () => {
    const alert = describeNotifiableEvent('agent:sandbox-blocked', {
      agentId: 'a1', requestId: 'r1', target: '/etc/hosts',
    });
    expect(alert).toMatchObject({ title: 'Sandbox blocked an action', body: '/etc/hosts' });
  });

  it('uses a stable per-request tag so a redelivered event does not stack', () => {
    const payload = { agentId: 'a1', requestId: 'r1', question: 'q' };
    expect(describeNotifiableEvent('agent:user-input-requested', payload)?.tag)
      .toBe(describeNotifiableEvent('agent:user-input-requested', payload)?.tag);
  });

  it('does not interrupt for routine events', () => {
    expect(describeNotifiableEvent('agent:status-changed', { agentId: 'a1' })).toBeNull();
    expect(describeNotifiableEvent('agent:approval-resolved', { agentId: 'a1' })).toBeNull();
    expect(describeNotifiableEvent('space:updated', {})).toBeNull();
  });

  it('tolerates a malformed payload', () => {
    expect(describeNotifiableEvent('agent:approval-needed', null)).toMatchObject({
      body: 'An agent wants to run a tool.',
    });
  });
});
