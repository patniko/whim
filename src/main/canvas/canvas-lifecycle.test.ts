import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => os.tmpdir() },
  session: { fromPartition: () => ({ protocol: { handle: vi.fn() }, setPermissionRequestHandler: vi.fn() }) },
}));

let closeListener: ((w: any) => void) | null = null;
const artifactWindows = new Map<string, any>();
const closedWindows: Array<{ spaceId: string; artifactId: string; notify: boolean }> = [];

vi.mock('./artifact-window', () => ({
  onArtifactWindowClosed: (listener: any) => { closeListener = listener; },
  findArtifactWindowByInstance: (instanceId: string) => artifactWindows.get(instanceId) ?? null,
  closeArtifactWindow: (key: any, notify = true) => {
    closedWindows.push({ ...key, notify });
    return true;
  },
}));

import {
  bindCanvasInstance,
  getCanvasInstanceBinding,
  handleCanvasSessionEvent,
  initCanvasLifecycle,
  reconcileOpenCanvases,
  releaseCanvasInstances,
  resetCanvasLifecycleForTests,
} from './canvas-lifecycle';

function makeSession() {
  const close = vi.fn().mockResolvedValue(undefined);
  return { session: { rpc: { canvas: { close } } }, close };
}

beforeEach(() => {
  resetCanvasLifecycleForTests();
  artifactWindows.clear();
  closedWindows.length = 0;
  closeListener = null;
});

describe('window close', () => {
  it('tells the runtime, so the instance is not rehydrated on the next reconnect', async () => {
    const { session, close } = makeSession();
    initCanvasLifecycle({ getSession: () => session });
    bindCanvasInstance('inst-1', { agentId: 'agent-1', spaceId: 'space-1', artifactId: 'report' });

    closeListener!({ winId: 1, spaceId: 'space-1', artifactId: 'report', title: 'R', instanceId: 'inst-1' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({ instanceId: 'inst-1' }));

    expect(getCanvasInstanceBinding('inst-1')).toBeUndefined();
  });

  it('ignores a window that was never bound to an instance', async () => {
    const { session, close } = makeSession();
    initCanvasLifecycle({ getSession: () => session });

    closeListener!({ winId: 1, spaceId: 'space-1', artifactId: 'report', title: 'R' });

    expect(close).not.toHaveBeenCalled();
  });

  it('survives a session that has already ended', async () => {
    initCanvasLifecycle({ getSession: () => undefined });
    bindCanvasInstance('inst-1', { agentId: 'agent-1', spaceId: 'space-1', artifactId: 'report' });

    expect(() => closeListener!({
      winId: 1, spaceId: 'space-1', artifactId: 'report', title: 'R', instanceId: 'inst-1',
    })).not.toThrow();
    await vi.waitFor(() => expect(getCanvasInstanceBinding('inst-1')).toBeUndefined());
  });
});

describe('canvas session events', () => {
  it('adopts an instance opened for a window whim already has', () => {
    artifactWindows.set('inst-1', { winId: 1, spaceId: 'space-1', artifactId: 'report', title: 'R' });

    handleCanvasSessionEvent('agent-1', { type: 'session.canvas.opened', data: { instanceId: 'inst-1' } });

    expect(getCanvasInstanceBinding('inst-1')).toEqual({
      agentId: 'agent-1', spaceId: 'space-1', artifactId: 'report',
    });
  });

  it('closes the window without echoing a close back to the runtime', () => {
    bindCanvasInstance('inst-1', { agentId: 'agent-1', spaceId: 'space-1', artifactId: 'report' });

    handleCanvasSessionEvent('agent-1', { type: 'session.canvas.closed', data: { instanceId: 'inst-1' } });

    expect(closedWindows).toEqual([{ spaceId: 'space-1', artifactId: 'report', notify: false }]);
    expect(getCanvasInstanceBinding('inst-1')).toBeUndefined();
  });

  it('leaves the window alone when the provider is only temporarily unavailable', () => {
    bindCanvasInstance('inst-1', { agentId: 'agent-1', spaceId: 'space-1', artifactId: 'report' });

    handleCanvasSessionEvent('agent-1', { type: 'session.canvas.unavailable', data: { instanceId: 'inst-1' } });

    expect(closedWindows).toEqual([]);
    expect(getCanvasInstanceBinding('inst-1')).toBeDefined();
  });

  it('ignores unrelated session events', () => {
    handleCanvasSessionEvent('agent-1', { type: 'session.idle', data: {} });
    expect(closedWindows).toEqual([]);
  });
});

describe('resume', () => {
  it('re-adopts canvases the runtime restored', () => {
    artifactWindows.set('inst-1', { winId: 1, spaceId: 'space-1', artifactId: 'report', title: 'R' });

    reconcileOpenCanvases('agent-1', [{ instanceId: 'inst-1' }, { instanceId: 'inst-unknown' }]);

    expect(getCanvasInstanceBinding('inst-1')?.agentId).toBe('agent-1');
    expect(getCanvasInstanceBinding('inst-unknown')).toBeUndefined();
  });

  it('does not steal an instance already owned by another run', () => {
    artifactWindows.set('inst-1', { winId: 1, spaceId: 'space-1', artifactId: 'report', title: 'R' });
    bindCanvasInstance('inst-1', { agentId: 'agent-old', spaceId: 'space-1', artifactId: 'report' });

    reconcileOpenCanvases('agent-new', [{ instanceId: 'inst-1' }]);

    expect(getCanvasInstanceBinding('inst-1')?.agentId).toBe('agent-old');
  });
});

describe('releaseCanvasInstances', () => {
  it('forgets only the ended run', () => {
    bindCanvasInstance('inst-1', { agentId: 'agent-1', spaceId: 'space-1', artifactId: 'report' });
    bindCanvasInstance('inst-2', { agentId: 'agent-2', spaceId: 'space-2', artifactId: 'report' });

    releaseCanvasInstances('agent-1');

    expect(getCanvasInstanceBinding('inst-1')).toBeUndefined();
    expect(getCanvasInstanceBinding('inst-2')).toBeDefined();
  });
});
