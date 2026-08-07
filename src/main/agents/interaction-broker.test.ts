import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { InteractionBroker } from './interaction-broker';
import type { AgentNotifier } from './agent-notifier';
import type { AgentPersistence } from './agent-persistence';
import type { AgentRecord } from './agent-registry';
import { resolvePathPolicy } from './sandbox-policies';

function makeNotifier(): AgentNotifier {
  return {
    notifyRenderer: vi.fn(),
    showApprovalNotification: vi.fn(),
    showSandboxBlockNotification: vi.fn(),
    showUserInputNotification: vi.fn(),
    showElicitationNotification: vi.fn(),
  } as unknown as AgentNotifier;
}

function makePersistence(): AgentPersistence {
  return {
    updateStatus: vi.fn(),
  } as unknown as AgentPersistence;
}

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    sessionId: overrides.sessionId ?? 'session-1',
    session: {} as any,
    spaceId: 'space-1',
    selectedText: '',
    anchor: { quote: '', prefix: '', suffix: '' },
    status: 'running',
    pendingApprovalId: null,
    pendingPermissionKind: null,
    pendingApprovals: new Map(),
    summary: '',
    ...overrides,
  };
}

describe('InteractionBroker', () => {
  let broker: InteractionBroker;
  let notifier: ReturnType<typeof makeNotifier>;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    notifier = makeNotifier();
    persistence = makePersistence();
    broker = new InteractionBroker(notifier, persistence);
  });

  describe('approveAgent', () => {
    it('resolves pending approval callback with true', async () => {
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({ kind: 'file_edit', toolCallId: 'req-1' }, { sessionId: 'session-1' });

      // Approve the request
      broker.approveAgent('agent-1', 'req-1', true);

      const result = await promise;
      expect(result).toEqual({ kind: 'approve-once' });
    });

    it('auto-approves read requests without interactive prompt', async () => {
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const result = await handler({ kind: 'read', toolCallId: 'req-r1' }, { sessionId: 'session-1' });
      expect(result).toEqual({ kind: 'approve-once' });
      // Should not trigger any renderer notifications (no interactive prompt)
      expect(notifier.notifyRenderer).not.toHaveBeenCalled();
      expect(notifier.showApprovalNotification).not.toHaveBeenCalled();
    });

    it('logs permission request and resolution', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({ kind: 'file_edit', toolCallId: 'req-2' }, { sessionId: 'session-1' });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Permission requested: kind=file_edit requestId=req-2')
      );

      broker.approveAgent('agent-1', 'req-2', true);
      await promise;
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Permission resolved: requestId=req-2 result=approve-once')
      );
      logSpy.mockRestore();
    });

    it('resolves pending approval callback with denial', async () => {
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({ kind: 'file_edit', toolCallId: 'req-1' }, { sessionId: 'session-1' });

      broker.approveAgent('agent-1', 'req-1', false);

      const result = await promise;
      expect(result).toEqual({ kind: 'reject' });
    });

    it('logs warning for unknown requestId', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      broker.approveAgent('agent-1', 'unknown-req', true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No approval callback for requestId=unknown-req')
      );
      warnSpy.mockRestore();
    });

    it('notifies renderer on approval resolution', () => {
      broker.approveAgent('agent-1', 'req-1', true);

      expect(notifier.notifyRenderer).toHaveBeenCalledWith('chat:event:agent-1', {
        type: 'approval.resolved',
        requestId: 'req-1',
        approved: true,
      });
    });

    it('propagates comment thread context for approval request and resolution', async () => {
      const record = makeRecord({
        commentContext: {
          threadId: 'thread-1',
          personaHandle: 'agent',
          personaName: 'agent',
          commentBody: 'please edit',
          quotedText: 'quoted',
          anchor: {},
          canvasHashBefore: '',
          canvasPath: '/tmp/canvas.md',
        },
      });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({ kind: 'file_edit', toolCallId: 'req-thread' }, { sessionId: 'session-1' });

      expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:approval-needed', expect.objectContaining({
        agentId: 'agent-1',
        requestId: 'req-thread',
        spaceId: 'space-1',
        threadId: 'thread-1',
      }));

      broker.approveAgent('agent-1', 'req-thread', true);
      await promise;

      expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:approval-resolved', expect.objectContaining({
        agentId: 'agent-1',
        requestId: 'req-thread',
        approved: true,
        spaceId: 'space-1',
        threadId: 'thread-1',
      }));
    });
  });

  describe('yolo mode', () => {
    it('auto-approves write requests when yoloMode is enabled', async () => {
      const record = makeRecord({ yoloMode: true });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const result = await handler({ kind: 'write', toolCallId: 'req-y1' } as any, { sessionId: 'session-1' });
      expect(result).toEqual({ kind: 'approve-once' });
      // Should not trigger any renderer notifications (yolo auto-approved)
      expect(notifier.notifyRenderer).not.toHaveBeenCalled();
      expect(notifier.showApprovalNotification).not.toHaveBeenCalled();
    });

    it('auto-approves shell requests when yoloMode is enabled', async () => {
      const record = makeRecord({ yoloMode: true });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const result = await handler({ kind: 'shell', toolCallId: 'req-y2' } as any, { sessionId: 'session-1' });
      expect(result).toEqual({ kind: 'approve-once' });
      expect(notifier.notifyRenderer).not.toHaveBeenCalled();
    });

    it('does not auto-approve when yoloMode is disabled', async () => {
      const record = makeRecord({ yoloMode: false });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({ kind: 'write', toolCallId: 'req-y3' } as any, { sessionId: 'session-1' });
      // Should trigger renderer notification (interactive prompt)
      expect(notifier.notifyRenderer).toHaveBeenCalled();

      // Resolve the pending approval to avoid hanging
      broker.approveAgent('agent-1', 'req-y3', true);
      const result = await promise;
      expect(result).toEqual({ kind: 'approve-once' });
    });

    it('auto-approves in sandboxed permission handler when yoloMode is enabled', async () => {
      const record = makeRecord({ yoloMode: true });
      const handler = broker.createSandboxedPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const result = await handler({ kind: 'write', toolCallId: 'req-y4' } as any, { sessionId: 'session-1' });
      expect(result).toEqual({ kind: 'approve-once' });
    });

    it('logs yolo auto-approve', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const record = makeRecord({ yoloMode: true });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      await handler({ kind: 'write', toolCallId: 'req-y5' } as any, { sessionId: 'session-1' });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('yolo-mode auto-approve')
      );
      logSpy.mockRestore();
    });
  });

  describe('respondToUserInput', () => {
    it('resolves pending user input callback', async () => {
      const record = makeRecord({
        commentContext: {
          threadId: 'thread-input',
          personaHandle: 'agent',
          personaName: 'agent',
          commentBody: 'question',
          quotedText: 'quoted',
          anchor: {},
          canvasHashBefore: '',
          canvasPath: '/tmp/canvas.md',
        },
      });
      const handler = broker.createUserInputHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler(
        { question: 'Pick a color', choices: ['red', 'blue'] },
        { sessionId: 'session-1' },
      );

      // We need to find the requestId. The handler uses crypto.randomUUID() so we
      // spy on notifier to capture the requestId from the notification.
      const call = vi.mocked(notifier.notifyRenderer).mock.calls.find(
        c => typeof c[1] === 'object' && (c[1] as any).type === 'user_input.requested'
      );
      expect(call).toBeDefined();
      const requestId = (call![1] as any).requestId;
      expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:user-input-requested', expect.objectContaining({
        agentId: 'agent-1',
        requestId,
        spaceId: 'space-1',
        threadId: 'thread-input',
      }));

      broker.respondToUserInput('agent-1', requestId, 'blue', false);

      const result = await promise;
      expect(result).toEqual({ answer: 'blue', wasFreeform: false });
      expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:user-input-resolved', expect.objectContaining({
        agentId: 'agent-1',
        requestId,
        answer: 'blue',
        wasFreeform: false,
        spaceId: 'space-1',
        threadId: 'thread-input',
      }));
    });

    it('is a no-op for unknown requestId', () => {
      broker.respondToUserInput('agent-1', 'unknown', 'test', true);
      // Should not throw
    });

    it('notifies renderer on resolution', () => {
      broker.respondToUserInput('agent-1', 'req-1', 'answer', true);

      expect(notifier.notifyRenderer).toHaveBeenCalledWith('chat:event:agent-1', {
        type: 'user_input.resolved',
        requestId: 'req-1',
        answer: 'answer',
        wasFreeform: true,
      });
    });
  });

  describe('respondToElicitation', () => {
    it('resolves pending elicitation callback with action and content', async () => {
      const record = makeRecord({
        commentContext: {
          threadId: 'thread-elicit',
          personaHandle: 'agent',
          personaName: 'agent',
          commentBody: 'form',
          quotedText: 'quoted',
          anchor: {},
          canvasHashBefore: '',
          canvasPath: '/tmp/canvas.md',
        },
      });
      const handler = broker.createElicitationHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({
        sessionId: 'session-1',
        message: 'Enter details',
        requestedSchema: {},
        mode: 'inline',
        elicitationSource: 'tool',
      } as any);

      const call = vi.mocked(notifier.notifyRenderer).mock.calls.find(
        c => typeof c[1] === 'object' && (c[1] as any).type === 'elicitation.requested'
      );
      expect(call).toBeDefined();
      const requestId = (call![1] as any).requestId;
      expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:elicitation-requested', expect.objectContaining({
        agentId: 'agent-1',
        requestId,
        spaceId: 'space-1',
        threadId: 'thread-elicit',
      }));

      broker.respondToElicitation('agent-1', requestId, 'accept', { name: 'test' });

      const result = await promise;
      expect(result.action).toBe('accept');
      expect(result.content).toEqual({ name: 'test' });
      expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:elicitation-resolved', expect.objectContaining({
        agentId: 'agent-1',
        requestId,
        action: 'accept',
        spaceId: 'space-1',
        threadId: 'thread-elicit',
      }));
    });

    it('resolves with cancel when declined', async () => {
      const record = makeRecord();
      const handler = broker.createElicitationHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({
        sessionId: 'session-1',
        message: 'Enter details',
        requestedSchema: {},
        mode: 'inline',
        elicitationSource: 'tool',
      } as any);

      const call = vi.mocked(notifier.notifyRenderer).mock.calls.find(
        c => typeof c[1] === 'object' && (c[1] as any).type === 'elicitation.requested'
      );
      const requestId = (call![1] as any).requestId;

      broker.respondToElicitation('agent-1', requestId, 'cancel');

      const result = await promise;
      expect(result.action).toBe('cancel');
    });

    it('notifies renderer on resolution', () => {
      broker.respondToElicitation('agent-1', 'req-1', 'decline');

      expect(notifier.notifyRenderer).toHaveBeenCalledWith('chat:event:agent-1', {
        type: 'elicitation.resolved',
        requestId: 'req-1',
        action: 'decline',
        content: undefined,
      });
    });
  });

  describe('clearPendingInteractions', () => {
    it('cancels all pending approval callbacks', async () => {
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({ kind: 'file_edit', toolCallId: 'req-1' }, { sessionId: 'session-1' });

      broker.clearPendingInteractions(record);

      const result = await promise;
      expect(result).toEqual({ kind: 'reject' });
    });

    it('cancels all pending user input callbacks', async () => {
      const record = makeRecord();
      const handler = broker.createUserInputHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({ question: 'test?' }, { sessionId: 'session-1' });

      broker.clearPendingInteractions(record);

      const result = await promise;
      expect(result).toEqual({ answer: '', wasFreeform: true });
    });

    it('cancels all pending elicitation callbacks', async () => {
      const record = makeRecord();
      const handler = broker.createElicitationHandler((sid) => sid === 'session-1' ? record : undefined);

      const promise = handler({
        sessionId: 'session-1',
        message: 'test',
        requestedSchema: {},
        mode: 'inline',
        elicitationSource: 'tool',
      } as any);

      broker.clearPendingInteractions(record);

      const result = await promise;
      expect(result).toEqual({ action: 'cancel' });
    });

    it('clears record pending approval state', () => {
      const record = makeRecord();
      record.pendingApprovals.set('req-1', { permissionKind: 'file_edit' });
      record.pendingApprovalId = 'req-1';
      record.pendingPermissionKind = 'file_edit';

      broker.clearPendingInteractions(record);

      expect(record.pendingApprovals.size).toBe(0);
      expect(record.pendingApprovalId).toBeNull();
      expect(record.pendingPermissionKind).toBeNull();
    });
  });

  describe('createPermissionHandler', () => {
    it('returns denied when record is not found', async () => {
      const handler = broker.createPermissionHandler(() => undefined);
      const result = await handler({ kind: 'file_edit' }, { sessionId: 'unknown' });
      expect(result).toEqual({ kind: 'reject' });
    });

    it('updates record status to waiting-approval', async () => {
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      // Don't await — the promise won't resolve until approved
      handler({ kind: 'file_edit', toolCallId: 'req-1' }, { sessionId: 'session-1' });

      expect(record.status).toBe('waiting-approval');
      expect(record.pendingApprovalId).toBe('req-1');
      expect(record.pendingPermissionKind).toBe('file_edit');

      // Clean up
      broker.approveAgent('agent-1', 'req-1', false);
    });

    it('sends approval notification', async () => {
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      handler({ kind: 'file_edit', toolCallId: 'req-1' }, { sessionId: 'session-1' });

      expect(notifier.showApprovalNotification).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-1',
        requestId: 'req-1',
        permissionKind: 'file_edit',
      }));
      expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:approval-needed', expect.objectContaining({
        agentId: 'agent-1',
        requestId: 'req-1',
        permissionKind: 'file_edit',
      }));

      broker.approveAgent('agent-1', 'req-1', false);
    });
  });

  describe('scheduled canvas auto-approval', () => {
    const canvasCall = { kind: 'custom-tool', toolName: 'open_canvas', toolCallId: 'req-1' } as any;

    it('approves canvas tools for a scheduled run, which has nobody to answer a prompt', async () => {
      const record = makeRecord({ autoApproveCanvasTools: true });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      const result = await handler(canvasCall, { sessionId: 'session-1' });

      expect(result).toEqual({ kind: 'approve-once' });
      expect(record.status).toBe('running');
      expect(notifier.showApprovalNotification).not.toHaveBeenCalled();
    });

    it('still prompts for everything else, so the run gains no other access', async () => {
      const record = makeRecord({ autoApproveCanvasTools: true });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      handler({ kind: 'shell', toolCallId: 'req-2' } as any, { sessionId: 'session-1' });

      expect(record.status).toBe('waiting-approval');
      broker.approveAgent('agent-1', 'req-2', false);
    });

    it('does not approve a custom tool that merely mentions canvases', async () => {
      const record = makeRecord({ autoApproveCanvasTools: true });
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      handler(
        { kind: 'custom-tool', toolName: 'delete_canvas_files', toolCallId: 'req-3' } as any,
        { sessionId: 'session-1' },
      );

      expect(record.status).toBe('waiting-approval');
      broker.approveAgent('agent-1', 'req-3', false);
    });

    it('prompts for canvas tools on runs that were not launched to produce artifacts', async () => {
      const record = makeRecord();
      const handler = broker.createPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      handler(canvasCall, { sessionId: 'session-1' });

      expect(record.status).toBe('waiting-approval');
      broker.approveAgent('agent-1', 'req-1', false);
    });
  });

  describe('createUserInputHandler', () => {
    it('returns empty response when record is not found', async () => {
      const handler = broker.createUserInputHandler(() => undefined);
      const result = await handler({ question: 'test?' }, { sessionId: 'unknown' });
      expect(result).toEqual({ answer: '', wasFreeform: true });
    });
  });

  describe('createElicitationHandler', () => {
    it('returns cancel when record is not found', async () => {
      const handler = broker.createElicitationHandler(() => undefined);
      const result = await handler({
        sessionId: 'unknown',
        message: 'test',
        requestedSchema: {},
        mode: 'inline',
        elicitationSource: 'tool',
      } as any);
      expect(result).toEqual({ action: 'cancel' });
    });
  });

  describe('createSandboxedPermissionHandler', () => {
    it('auto-approves read requests', async () => {
      const record = makeRecord();
      const handler = broker.createSandboxedPermissionHandler(
        (sid) => sid === 'session-1' ? record : undefined,
      );

      const result = await handler(
        { kind: 'read', toolCallId: 'req-r1' },
        { sessionId: 'session-1' },
      );
      expect(result).toEqual({ kind: 'approve-once' });
    });

    it('auto-denies write requests', async () => {
      const record = makeRecord();
      const handler = broker.createSandboxedPermissionHandler(
        (sid) => sid === 'session-1' ? record : undefined,
      );

      const result = await handler(
        { kind: 'write', toolCallId: 'req-w1' },
        { sessionId: 'session-1' },
      );
      expect(result).toEqual({ kind: 'reject' });
    });

    it('falls through to normal handler for other kinds', async () => {
      const record = makeRecord();
      const handler = broker.createSandboxedPermissionHandler(
        (sid) => sid === 'session-1' ? record : undefined,
      );

      // shell/mcp/url etc. should trigger the normal interactive flow
      const promise = handler(
        { kind: 'shell', toolCallId: 'req-s1' },
        { sessionId: 'session-1' },
      );

      // Approve via the normal flow
      broker.approveAgent('agent-1', 'req-s1', true);
      const result = await promise;
      expect(result).toEqual({ kind: 'approve-once' });
    });
  });

  describe('emitSandboxBlock + resolveSandboxBlock', () => {
    it('resolves with the chosen decision', async () => {
      const record = makeRecord();
      const promise = broker.emitSandboxBlock(record, {
        source: 'permission',
        kind: 'write',
        target: 'C:\\foo\\bar.txt',
      });
      const callArgs = (notifier.notifyRenderer as any).mock.calls.find((c: any[]) => c[0] === 'agent:sandbox-blocked');
      expect(callArgs).toBeDefined();
      const requestId = callArgs[1].requestId;

      broker.resolveSandboxBlock('agent-1', requestId, 'allow-once');
      const resolution = await promise;
      expect(resolution).toEqual({ decision: 'allow-once' });
    });

    it('clears all pending sandbox-block callbacks on clearPendingInteractions', async () => {
      const record = makeRecord();
      const promise = broker.emitSandboxBlock(record, {
        source: 'permission',
        kind: 'read',
        target: 'C:\\secret.txt',
      });

      broker.clearPendingInteractions(record);

      const resolution = await promise;
      // Pending callbacks are resolved as 'allow-once' on tear-down to avoid hanging the SDK.
      expect(resolution).toEqual({ decision: 'allow-once' });
    });

    it('emits both agent:sandbox-blocked and a chat:event:* with type sandbox.blocked', async () => {
      const record = makeRecord();
      // Fire-and-forget: we don't need the resolution.
      broker.emitSandboxBlock(record, {
        source: 'pre-tool',
        kind: 'write',
        toolName: 'edit',
        target: 'C:\\foo\\bar.txt',
      });

      const channels = (notifier.notifyRenderer as any).mock.calls.map((c: any[]) => c[0]);
      expect(channels).toContain('agent:sandbox-blocked');
      expect(channels).toContain('chat:event:agent-1');
    });

    it('propagates personaHandle from the record into the agent:sandbox-blocked payload', async () => {
      // The renderer's "Edit sandbox config" button relies on this field to
      // know which persona to open. If it's missing, the button silently
      // becomes a no-op.
      const record = makeRecord({ personaHandle: 'sandbox' });
      broker.emitSandboxBlock(record, {
        source: 'post-tool-shell',
        kind: 'shell',
        toolName: 'bash',
        target: 'echo hi > ~/whim-sandbox-denied.txt',
      });
      const blockedCall = (notifier.notifyRenderer as any).mock.calls.find(
        (c: any[]) => c[0] === 'agent:sandbox-blocked',
      );
      expect(blockedCall).toBeDefined();
      expect(blockedCall[1].personaHandle).toBe('sandbox');

      // Same field must also be present on the chat-event mirror so any
      // future chat-side UI that surfaces the block can use it too.
      const chatCall = (notifier.notifyRenderer as any).mock.calls.find(
        (c: any[]) => c[0] === 'chat:event:agent-1',
      );
      expect(chatCall).toBeDefined();
      expect(chatCall[1].personaHandle).toBe('sandbox');
    });

    it('omits personaHandle from the payload when the record has none', async () => {
      // Quick-launch agents and records that pre-date the persona field both
      // arrive without a handle. The payload should not include the key (vs.
      // include `personaHandle: undefined`), so the renderer's
      // `if (data.personaHandle)` check works and the Edit button is hidden.
      const record = makeRecord();
      expect(record.personaHandle).toBeUndefined();

      broker.emitSandboxBlock(record, {
        source: 'permission',
        kind: 'write',
        target: 'C:\\foo\\bar.txt',
      });
      const blockedCall = (notifier.notifyRenderer as any).mock.calls.find(
        (c: any[]) => c[0] === 'agent:sandbox-blocked',
      );
      expect(blockedCall).toBeDefined();
      // The key should not be present at all (not `personaHandle: undefined`).
      expect('personaHandle' in blockedCall[1]).toBe(false);
    });

    it('broadcasts agent:sandbox-resolved on resolveSandboxBlock for cross-window dismissal', async () => {
      // The main app and a canvas window can both render the same pending
      // block. When the user resolves it in one window, the broker must
      // notify the other so its UI clears. We assert the dedicated channel
      // is broadcast with the agentId / requestId / decision.
      const record = makeRecord();
      const promise = broker.emitSandboxBlock(record, {
        source: 'pre-tool',
        kind: 'write',
        toolName: 'edit',
        target: 'C:\\foo\\bar.txt',
      });
      const blockedCall = (notifier.notifyRenderer as any).mock.calls.find(
        (c: any[]) => c[0] === 'agent:sandbox-blocked',
      );
      const requestId = blockedCall[1].requestId;

      // Reset mock call history so we only see post-resolve broadcasts.
      (notifier.notifyRenderer as any).mockClear();

      broker.resolveSandboxBlock('agent-1', requestId, 'disable');
      await promise;

      const resolvedCalls = (notifier.notifyRenderer as any).mock.calls.filter(
        (c: any[]) => c[0] === 'agent:sandbox-resolved',
      );
      expect(resolvedCalls.length).toBe(1);
      expect(resolvedCalls[0][1]).toMatchObject({
        agentId: 'agent-1',
        requestId,
        decision: 'disable',
      });
    });
  });

  describe('createPathAwareSandboxPermissionHandler', () => {
    // Build platform-appropriate paths so isPathInside works on any host OS
    // (the path-policy engine uses the host's path/realpath semantics).
    const workspaceRoot = path.join(os.tmpdir(), 'whim-broker-test-workspace');
    const spaceFolder = path.join(workspaceRoot, 'my-space');
    const siblingFolder = path.join(workspaceRoot, 'sibling');

    function makeSandboxedRecord(): AgentRecord {
      const record = makeRecord();
      record.sandbox = {
        policy: resolvePathPolicy(spaceFolder, {
          scopeToSpaceFolder: true,
          extraReadwritePaths: [],
          extraReadonlyPaths: [],
          extraDeniedPaths: [],
        }),
        configs: { onDir: path.join(os.tmpdir(), 'sb-on'), offDir: path.join(os.tmpdir(), 'sb-off') },
        state: 'on',
        allowMcpServers: false,
        allowWebFetch: false,
        allowOutbound: false,
        allowList: { paths: new Set(), resources: new Set(), webFetch: false },
      };
      return record;
    }

    it('falls through to the normal handler when sandbox state is "off"', async () => {
      const record = makeSandboxedRecord();
      record.sandbox!.state = 'off';
      const handler = broker.createPathAwareSandboxPermissionHandler((sid) => sid === 'session-1' ? record : undefined);
      const promise = handler({ kind: 'read', toolCallId: 'tc' } as any, { sessionId: 'session-1' });
      // Read should auto-approve in the fallback handler regardless.
      const result = await promise;
      expect(result).toEqual({ kind: 'approve-once' });
    });

    it('approves a read inside the space folder', async () => {
      const record = makeSandboxedRecord();
      const handler = broker.createPathAwareSandboxPermissionHandler((sid) => sid === 'session-1' ? record : undefined);
      const r = await handler({
        kind: 'read',
        toolCallId: 'tc',
        path: path.join(spaceFolder, 'canvas.md'),
      } as any, { sessionId: 'session-1' });
      expect(r).toEqual({ kind: 'approve-once' });
    });

    it('emits a sandbox block for a read outside the space folder', async () => {
      const record = makeSandboxedRecord();
      const handler = broker.createPathAwareSandboxPermissionHandler((sid) => sid === 'session-1' ? record : undefined);
      const promise = handler({
        kind: 'read',
        toolCallId: 'tc',
        path: path.join(siblingFolder, 'secret.txt'),
      } as any, { sessionId: 'session-1' });
      // Find the requestId from the emitted block, then resolve it.
      const call = (notifier.notifyRenderer as any).mock.calls.find((c: any[]) => c[0] === 'agent:sandbox-blocked');
      expect(call).toBeDefined();
      broker.resolveSandboxBlock('agent-1', call[1].requestId, 'allow-once');
      const r = await promise;
      expect(r).toEqual({ kind: 'approve-once' });
    });

    it('grows the host allow-list on allow-for-session', async () => {
      const record = makeSandboxedRecord();
      const handler = broker.createPathAwareSandboxPermissionHandler((sid) => sid === 'session-1' ? record : undefined);
      const promise = handler({
        kind: 'write',
        toolCallId: 'tc',
        fileName: path.join(siblingFolder, 'out.txt'),
        intention: 'write log',
      } as any, { sessionId: 'session-1' });
      const call = (notifier.notifyRenderer as any).mock.calls.find((c: any[]) => c[0] === 'agent:sandbox-blocked');
      broker.resolveSandboxBlock('agent-1', call[1].requestId, 'allow-for-session');
      await promise;
      expect(record.sandbox!.allowList.paths.size).toBeGreaterThan(0);
    });
  });

  describe('createMxcOnlyPermissionHandler', () => {
    function makeSandboxedRecord(): AgentRecord {
      const record = makeRecord();
      record.sandbox = {
        policy: resolvePathPolicy('C:\\workspace\\my-space', {
          scopeToSpaceFolder: true,
          extraReadwritePaths: [],
          extraReadonlyPaths: [],
          extraDeniedPaths: [],
        }),
        configs: { onDir: 'C:\\sb-on', offDir: 'C:\\sb-off' },
        state: 'on',
        allowMcpServers: false,
        allowWebFetch: false,
        allowOutbound: false,
        allowList: { paths: new Set(), resources: new Set(), webFetch: false },
      };
      return record;
    }

    it('rejects when no record is found for the session', async () => {
      const handler = broker.createMxcOnlyPermissionHandler(() => undefined);
      const r = await handler({ kind: 'write', toolCallId: 'tc' } as any, { sessionId: 'unknown' });
      expect(r).toEqual({ kind: 'reject' });
    });

    it('auto-approves a write request without bubbling up to the renderer', async () => {
      const record = makeSandboxedRecord();
      const handler = broker.createMxcOnlyPermissionHandler((sid) => sid === 'session-1' ? record : undefined);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = await handler({
        kind: 'write',
        toolCallId: 'tc',
        fileName: 'C:\\workspace\\my-space\\out.txt',
      } as any, { sessionId: 'session-1' });
      expect(r).toEqual({ kind: 'approve-once' });
      expect(notifier.notifyRenderer).not.toHaveBeenCalled();
      expect(notifier.showApprovalNotification).not.toHaveBeenCalled();
      // Logged with the auto-approve layer breadcrumb for traceability.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mxc-only:auto-approve'));
      warnSpy.mockRestore();
    });

    it('auto-approves read, shell, mcp, and url requests', async () => {
      const record = makeSandboxedRecord();
      const handler = broker.createMxcOnlyPermissionHandler((sid) => sid === 'session-1' ? record : undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cases = [
        { kind: 'read', path: 'C:\\workspace\\my-space\\notes.md' },
        { kind: 'shell', command: 'rm -rf C:\\workspace\\my-space' },
        { kind: 'mcp', serverName: 'github' },
        { kind: 'url', url: 'https://example.com' },
      ];
      for (const req of cases) {
        const r = await handler({ ...req, toolCallId: 'tc' } as any, { sessionId: 'session-1' });
        expect(r).toEqual({ kind: 'approve-once' });
      }
      expect(notifier.notifyRenderer).not.toHaveBeenCalled();
    });

    it('falls back to the regular interactive handler when sandbox state is "off"', async () => {
      const record = makeSandboxedRecord();
      record.sandbox!.state = 'off';
      const handler = broker.createMxcOnlyPermissionHandler((sid) => sid === 'session-1' ? record : undefined);

      // Read should still auto-approve via the fallback handler (and not log
      // the auto-approve breadcrumb, since the mxc-only path was abandoned).
      const r = await handler({ kind: 'read', toolCallId: 'tc' } as any, { sessionId: 'session-1' });
      expect(r).toEqual({ kind: 'approve-once' });

      // Write should bubble up via the fallback handler — verify by checking
      // the renderer was notified (we don't need to resolve the promise).
      void handler({
        kind: 'write',
        toolCallId: 'tc-w',
        fileName: 'C:\\workspace\\my-space\\out.txt',
      } as any, { sessionId: 'session-1' });
      // Allow microtasks to flush the synchronous notify in createPermissionHandler.
      await Promise.resolve();
      expect(notifier.notifyRenderer).toHaveBeenCalledWith(
        'agent:approval-needed',
        expect.objectContaining({ requestId: 'tc-w' }),
      );
    });

    it('falls back to the regular interactive handler when sandbox state is missing', async () => {
      const record = makeRecord();
      // record.sandbox is undefined.
      const handler = broker.createMxcOnlyPermissionHandler((sid) => sid === 'session-1' ? record : undefined);
      const r = await handler({ kind: 'read', toolCallId: 'tc' } as any, { sessionId: 'session-1' });
      expect(r).toEqual({ kind: 'approve-once' });
    });
  });
});
