// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CopilotSession, type PermissionHandler, type SessionEvent } from '@github/copilot-sdk';
import { InteractionBroker } from './interaction-broker';
import { AgentNotifier } from './agent-notifier';
import { AgentPersistence } from './agent-persistence';
import type { AgentRecord } from './agent-registry';
import type { ChatEvent } from '../../shared/chat-types';
import { createPersistenceSchema } from '../persistence-schema';
import { createChatProjection, queryChatHistoryPage } from '../chat-history-page';
import { parseHistoryEvents, replayBufferedEvents } from '../../renderer/chat/ChatView';
import { ApprovalTile } from '../../renderer/chat/tiles/ApprovalTile';

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/whim' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: vi.fn(),
}));
vi.mock('../storage', () => ({
  updateCanvasAgentStatus: vi.fn().mockResolvedValue(undefined),
  updateAgentSessionStatus: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/scheduled-result', () => ({ markScheduledInteractionBlocked: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('routes distinct SDK request/tool IDs through one projected tile and one permission response RPC', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const db = new Database(':memory:');
  createPersistenceSchema(db);
  createChatProjection(db);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const events: SessionEvent[] = [];
  const live: ChatEvent[] = [];
  const notifier = new AgentNotifier();
  vi.spyOn(notifier, 'notifyRenderer').mockImplementation((channel: string, event: ChatEvent) => {
    if (channel === 'chat:event:agent') live.push(event);
  });
  vi.spyOn(notifier, 'showApprovalNotification').mockImplementation(() => {});
  const broker = new InteractionBroker(notifier, new AgentPersistence());
  const rpc = vi.fn().mockResolvedValue({});
  const session = Reflect.construct(CopilotSession, ['session', { sendRequest: rpc }]) as CopilotSession & {
    _dispatchEvent(event: SessionEvent): void;
    registerPermissionHandler(handler: PermissionHandler): void;
  };
  const record: AgentRecord = {
    agentId: 'agent', sessionId: session.sessionId, session, spaceId: '__workspace__',
    selectedText: '', anchor: { quote: '', prefix: '', suffix: '' }, status: 'running',
    pendingApprovalId: null, pendingPermissionKind: null, pendingApprovals: new Map(), summary: '',
  };
  session.registerPermissionHandler(broker.createPermissionHandler(id => id === session.sessionId ? record : undefined));
  session.on(event => {
    events.push(event);
    db.prepare('INSERT INTO agent_chat_events(agent_id,seq,event_id,type,timestamp,payload) VALUES (?,?,?,?,?,?)')
      .run(record.agentId, events.length, event.id, event.type, event.timestamp, JSON.stringify(event.data));
  });
  try {
    session._dispatchEvent({
      id: 'requested-event', type: 'permission.requested', timestamp: '2026-09-10', parentId: null,
      data: {
        requestId: 'rpc-request', permissionRequest: {
          toolCallId: 'broker-tool-call', kind: 'write', fileName: '/fixture.txt',
          intention: 'Update fixture', diff: '', canOfferSessionApproval: false,
        },
      },
    });
    await vi.waitFor(() => expect(live).toHaveLength(1));
    const projected = queryChatHistoryPage(db, record.agentId).items;
    const merged = replayBufferedEvents(projected, live);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ type: 'approval', requestId: 'broker-tool-call', responded: false });
    expect(parseHistoryEvents(events)[0]).toMatchObject({ requestId: 'broker-tool-call' });
    const render = () => act(() => root.render(<>
      {replayBufferedEvents(queryChatHistoryPage(db, record.agentId).items, live).map(message =>
        message.type === 'approval' && <ApprovalTile key={message.id} {...message}
          onRespond={(id, approved) => broker.approveAgent(record.agentId, id, approved)} />)}
    </>));
    render();
    expect(host.querySelectorAll('.chat-approval-tile')).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>('.approve')!.click());
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledWith('session.permissions.handlePendingPermissionRequest', {
      sessionId: session.sessionId, requestId: 'rpc-request', result: { kind: 'approve-once' },
    });
    session._dispatchEvent({
      id: 'completed-event', type: 'permission.completed', timestamp: '2026-09-10', parentId: 'requested-event',
      data: { requestId: 'rpc-request', result: { kind: 'approved' } },
    });
    render();
    expect(host.querySelectorAll('.chat-approval-tile.responded')).toHaveLength(1);
    expect(host.querySelectorAll('.chat-approval-tile.pending')).toHaveLength(0);
    expect(host.textContent).toContain('Approved');
    expect(parseHistoryEvents(events)).toMatchObject([{ requestId: 'broker-tool-call', responded: true, approved: true }]);
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    db.close();
  }
});
